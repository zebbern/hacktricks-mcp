/**
 * Kubernetes role rules for the permissions check: how a grant is written,
 * whether a held grant covers a required one, and which of HackTricks Cloud's
 * permission rules a grant trips.
 *
 * A grant is written as "verb resource[.group][/subresource]", "verb *" or
 * "verb /url": "create pods", "get secrets", "create deployments.apps",
 * "create pods/exec". A resource written without its group matches any group.
 */
import type { Held, Mapping, Severity } from "./permissions.js";

export interface KubernetesGrant {
  verb: string;
  resource: string; // "*" for every resource
  group: string; // "" when the grant does not say, "*" for every group
  subresource: string;
  url: string; // a non-resource URL, else ""
}

export const KUBERNETES_GRANT_SYNTAX =
  '"verb resource[.group][/subresource]", "verb *" or "verb /url", for example "create pods", "get secrets", "create deployments.apps", "create pods/exec"';

export function parseKubernetesGrant(text: string): KubernetesGrant | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [verb, target] = parts;
  // A verb can carry a scope, as in "impersonate:user-info".
  if (!/^[a-z*:-]+$/i.test(verb)) return null;
  const lower = verb.toLowerCase();
  if (target.startsWith("/")) return { verb: lower, resource: "*", group: "*", subresource: "", url: target };
  const match = /^([a-z0-9*-]+)(?:\.([a-z0-9.*-]+))?(?:\/([a-z0-9*-]+))?$/i.exec(target);
  if (!match) return null;
  return {
    verb: lower,
    resource: match[1].toLowerCase(),
    group: match[2]?.toLowerCase() ?? "",
    subresource: match[3]?.toLowerCase() ?? "",
    url: "",
  };
}

/** The grant a requirement leaf names, in the notation above. */
export function grantText(leaf: Mapping): string {
  if (typeof leaf.verb !== "string" && typeof leaf.verb_prefix !== "string") return "";
  // "verb_prefix" and "resource_match" have matching rules of their own; they are shown by what they stand for.
  const any = leaf.resource_match === "any";
  const resource = any ? "*" : typeof leaf.resource === "string" ? leaf.resource : "*";
  const group = !any && typeof leaf.api_group === "string" && leaf.api_group !== "" ? `.${leaf.api_group}` : "";
  const subresource = !any && typeof leaf.subresource === "string" && leaf.subresource !== "" ? `/${leaf.subresource}` : "";
  const verb =
    typeof leaf.verb === "string" ? leaf.verb : `${String(leaf.verb_prefix).endsWith(":") ? leaf.verb_prefix : `${leaf.verb_prefix}:`}*`;
  return `${verb} ${resource}${group}${subresource}`;
}

/**
 * Does any held grant cover the grant a requirement leaf names? A leaf with a
 * key that has matching rules of its own is left to those rules: unknown.
 */
export function holdsKubernetes(leaf: Mapping, grants: KubernetesGrant[]): Held {
  if (typeof leaf.verb !== "string") return null;
  if ("verb_prefix" in leaf || "resource_match" in leaf || "non_resource_url" in leaf) return null;
  if (leaf.resource !== undefined && typeof leaf.resource !== "string") return null;
  const need: KubernetesGrant = {
    verb: leaf.verb.toLowerCase(),
    resource: typeof leaf.resource === "string" ? leaf.resource.toLowerCase() : "*",
    group: typeof leaf.api_group === "string" ? leaf.api_group.toLowerCase() : "",
    subresource: typeof leaf.subresource === "string" ? leaf.subresource.toLowerCase() : "",
    url: "",
  };
  return grants.some((held) => grantCovers(held, need));
}

function grantCovers(held: KubernetesGrant, need: KubernetesGrant): boolean {
  // "impersonate" covers the scoped "impersonate:user-info"; "create" does not cover "create:token".
  const verbs = need.verb.includes(":") ? [need.verb, need.verb.split(":")[0]] : [need.verb];
  if (held.verb !== "*" && !verbs.includes(held.verb)) return false;
  if (held.resource !== "*" && held.resource !== need.resource) return false;
  // "pods" does not grant "pods/exec", and "pods/exec" does not grant "pods".
  if (held.subresource !== "*" && held.subresource !== need.subresource) return false;
  if (need.group === "") return held.group === "" || held.group === "*";
  return held.group === "" || held.group === "*" || held.group === need.group;
}

// --- the book's permission rules ---------------------------------------------------

export interface KubernetesRating {
  severity: Severity | "not rated";
  description: string;
}

/** The first rule that matches a grant decides its severity. */
export function rateKubernetesGrant(rules: Mapping[], grant: KubernetesGrant): KubernetesRating {
  for (const rule of rules) {
    if (typeof rule.match !== "object" || rule.match === null || !ruleMatch(rule.match as Mapping, grant)) continue;
    let severity = typeof rule.severity === "string" ? rule.severity : "not rated";
    const when = rule.severity_when;
    if (typeof when === "object" && when !== null && ruleMatch((when as Mapping).match as Mapping, grant)) {
      severity = typeof (when as Mapping).severity === "string" ? ((when as Mapping).severity as string) : severity;
    }
    return { severity: severity as Severity | "not rated", description: fillIn(String(rule.description ?? ""), grant) };
  }
  return { severity: "not rated", description: "" };
}

/** A rule's description names the grant it matched in placeholders such as `{verb}` and `{non_resource_url}`. */
function fillIn(description: string, grant: KubernetesGrant): string {
  const context = contextOf(grant);
  return description.replace(/\{(\w+)\}/g, (placeholder, field: string) => context[field] ?? placeholder);
}

/** The values of a grant the rules compare: fields `verb`, `resource`, `group`, `subresource`, `full`, `non_resource_url`, `path`. */
function contextOf(grant: KubernetesGrant): Record<string, string> {
  return {
    verb: grant.verb,
    resource: grant.resource,
    group: grant.group,
    subresource: grant.subresource,
    full: grant.subresource ? `${grant.resource}/${grant.subresource}` : grant.resource,
    non_resource_url: grant.url,
    path: grant.url,
  };
}

function ruleMatch(match: Mapping, grant: KubernetesGrant): boolean {
  const context = contextOf(grant);
  if ("all" in match) return (Array.isArray(match.all) ? match.all : []).every((part: unknown) => ruleMatch(asMapping(part), grant));
  if ("any" in match) return (Array.isArray(match.any) ? match.any : []).some((part: unknown) => ruleMatch(asMapping(part), grant));
  if ("not" in match) return !ruleMatch(asMapping(match.not), grant);
  const value = context[String(match.field)];
  if (value === undefined) return false;
  return compare(value, String(match.op ?? ""), match.value);
}

function asMapping(node: unknown): Mapping {
  return node !== null && typeof node === "object" && !Array.isArray(node) ? (node as Mapping) : {};
}

/** `eq`, `ne`, `in`, `contains`, `prefix`, `suffix`, `truthy`; a list value stands for any of its items. */
function compare(value: string, op: string, expected: unknown): boolean {
  const items = (Array.isArray(expected) ? expected : [expected]).map(String);
  switch (op) {
    case "eq":
      return items.includes(value);
    case "ne":
      return !items.includes(value);
    case "in":
      return Array.isArray(expected) && items.includes(value);
    case "contains":
      return items.some((item) => value.includes(item));
    case "prefix":
      return items.some((item) => value.startsWith(item));
    case "suffix":
      return items.some((item) => value.endsWith(item));
    case "truthy":
      return value.length > 0;
    default:
      return false;
  }
}
