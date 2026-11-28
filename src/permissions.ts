/**
 * HackTricks Cloud's privilege escalation catalog: the shapes the indexer
 * stores, and how a technique's `requires` tree is evaluated.
 *
 * The catalog is src/privilege-escalation-paths in that book: one file per
 * service, each technique stating the permissions it needs, what it gains and
 * the page section that explains it. The rated permission lists and Kubernetes
 * rules of src/permission-categorizations are stored by the same indexer and
 * read by src/permission-check.ts, which answers the tool call.
 */
import { grantText } from "./kubernetes-rbac.js";

export const PROVIDERS = ["aws", "gcp", "azure", "k8s"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** AWS and Azure permission names are case-insensitive; GCP's are not. */
const IGNORE_CASE: Record<Provider, boolean> = { aws: true, gcp: false, azure: true, k8s: false };

/** Keys of a requirement leaf that name a permission. Every other key is a condition that is not evaluated. */
export const PERMISSION_KEYS: Record<Provider, readonly string[]> = {
  aws: ["action"],
  gcp: ["action"],
  azure: ["action", "entra_permission", "graph_app_permission", "entra_role", "entra_catalog_role", "entra_pim_eligible_role"],
  k8s: ["verb"],
};

/** A requirement leaf or group, as the book's YAML is parsed. */
export type Mapping = Record<string, unknown>;

// --- rows the indexer stores ------------------------------------------------------

export interface RiskRow {
  provider: Provider;
  permission: string;
  severity: Severity;
}

export interface CombinationRow {
  provider: Provider;
  severity: Severity;
  /** Every permission of the combination must be held. */
  permissions: string[];
}

export interface EscalationRow {
  provider: Provider;
  id: string;
  service: string;
  title: string;
  summary: string;
  severity: Severity;
  confidence: string;
  /** JSON `{ kind, scope, outcome }`: what the technique gains. */
  target: string;
  /** `<page path>#<anchor>`: the page section that explains the technique. */
  source: string;
  requires: string; // JSON, as the book writes it
  needs: string; // JSON list of the permissions the technique names
  conditions: string; // JSON list of sentences
  blockers: string; // JSON list of identifiers
  mitigation: string;
}

export interface RuleRow {
  provider: Provider;
  position: number; // the first rule that matches wins, so the order matters
  rule: string; // JSON, as the book writes it
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/** The rated lists of a categorization file: its `permission_categories`, one list per severity. */
export function riskRows(provider: Provider, file: Mapping): RiskRow[] {
  const categories = (file.permission_categories ?? {}) as Mapping;
  const rows: RiskRow[] = [];
  for (const severity of SEVERITIES) {
    const permissions = categories[severity];
    if (!Array.isArray(permissions)) continue;
    for (const permission of permissions) {
      if (typeof permission === "string") rows.push({ provider, permission, severity });
    }
  }
  return rows;
}

export function combinationRows(provider: Provider, combinations: Mapping | undefined): CombinationRow[] {
  const rows: CombinationRow[] = [];
  for (const severity of SEVERITIES) {
    const lists = combinations?.[severity];
    if (!Array.isArray(lists)) continue;
    for (const list of lists) {
      if (Array.isArray(list) && list.every((p) => typeof p === "string")) {
        rows.push({ provider, severity, permissions: list as string[] });
      }
    }
  }
  return rows;
}

/** One technique as the book writes it. */
export interface Technique {
  id: unknown;
  service: unknown;
  title: unknown;
  summary: unknown;
  severity: unknown;
  confidence: unknown;
  target?: Mapping;
  source: unknown;
  requires: unknown;
  conditions: unknown;
  blockers: unknown;
  mitigation: unknown;
}

/** Rows for the escalation table. A technique without an id, a requirement or a severity is skipped. */
export function escalationRows(provider: Provider, techniques: Technique[]): EscalationRow[] {
  const rows: EscalationRow[] = [];
  for (const t of techniques) {
    if (typeof t?.id !== "string" || t.requires === undefined || !isSeverity(t.severity)) continue;
    rows.push({
      provider,
      id: t.id,
      service: String(t.service ?? ""),
      title: String(t.title ?? t.id),
      summary: String(t.summary ?? ""),
      severity: t.severity,
      confidence: String(t.confidence ?? ""),
      target: JSON.stringify({ kind: t.target?.kind ?? "", scope: t.target?.scope ?? "", outcome: t.target?.outcome ?? "" }),
      source: typeof t.source === "string" ? t.source.replace(/^src\//, "") : "",
      requires: JSON.stringify(t.requires),
      needs: JSON.stringify(needsOf(provider, t.requires)),
      conditions: JSON.stringify(sentencesOf(t.conditions)),
      blockers: JSON.stringify(Array.isArray(t.blockers) ? t.blockers.map(String) : []),
      mitigation: String(t.mitigation ?? ""),
    });
  }
  return rows;
}

export function ruleRows(provider: Provider, rules: unknown): RuleRow[] {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((rule): rule is Mapping => rule !== null && typeof rule === "object" && !Array.isArray(rule))
    .map((rule, position) => ({ provider, position, rule: JSON.stringify(rule) }));
}

// --- the permissions a requirement names -------------------------------------------

/** The permission a leaf names, in the notation of `needs`. */
function permissionOf(provider: Provider, leaf: Mapping): string | null {
  for (const key of PERMISSION_KEYS[provider]) {
    const value = leaf[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Every permission a `requires` tree names, without duplicates. */
export function needsOf(provider: Provider, requires: unknown): string[] {
  const needs = new Set<string>();
  visitLeaves(requires, (item) => {
    if ("all_of" in item || "any_of" in item) return; // a group names no permission of its own
    const permission = provider === "k8s" ? grantText(item) : permissionOf(provider, item);
    if (permission) needs.add(permission);
  });
  return [...needs];
}

/**
 * Call `leaf` for every requirement item: a list is a conjunction, `all_of` a
 * conjunction, and each element of `any_of` an alternative.
 */
export function visitLeaves(node: unknown, leaf: (item: Mapping) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) visitLeaves(item, leaf);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const item = node as Mapping;
  leaf(item);
  visitLeaves(item.all_of, leaf);
  visitLeaves(item.any_of, leaf);
}

/** Sentences of a `conditions` list, whose items are `{ id, description }` or plain strings. */
function sentencesOf(conditions: unknown): string[] {
  if (!Array.isArray(conditions)) return [];
  return conditions
    .map((c) => (c !== null && typeof c === "object" ? String((c as Mapping).description ?? "") : String(c ?? "")))
    .filter((sentence) => sentence.trim().length > 0);
}

// --- evaluating a requirement ------------------------------------------------------

/** `null` where the requirement depends on something permissions cannot show. */
export type Held = boolean | null;

export const allOf = (results: Held[]): Held => (results.includes(false) ? false : results.includes(null) ? null : true);
export const anyOf = (results: Held[]): Held => (results.includes(true) ? true : results.includes(null) ? null : false);

/**
 * Does the principal hold everything a `requires` tree asks for? A list is a
 * conjunction, `all_of` is a conjunction, and each element of `any_of` is an
 * alternative. `holds(item, key)` answers for a leaf and its permission key;
 * a leaf without a permission key (a condition on a resource, a scope or the
 * request) is not a requirement of its own.
 */
export function evalRequires(
  requires: unknown,
  permissionKeys: readonly string[],
  holds: (leaf: Mapping, key: string) => Held,
): Held {
  let asked = false;
  const result = evaluate(requires, permissionKeys, (leaf, key) => {
    asked = true;
    return holds(leaf, key);
  });
  // A requirement that names no permission at all (an empty one, or only
  // conditions) depends on how things are configured, so it is never held.
  return asked ? result : null;
}

function evaluate(
  requires: unknown,
  permissionKeys: readonly string[],
  holds: (leaf: Mapping, key: string) => Held,
): Held {
  if (Array.isArray(requires)) return allOf(requires.map((item) => evaluate(item, permissionKeys, holds)));
  if (requires === null || typeof requires !== "object") return null;
  const item = requires as Mapping;
  const results: Held[] = [];
  for (const [key, value] of Object.entries(item)) {
    if (key === "all_of") results.push(evaluate(value ?? [], permissionKeys, holds));
    else if (key === "any_of") {
      // An empty alternative would hold for everyone; the book does not write one, so it is not assumed.
      const alternatives = Array.isArray(value) ? value : [];
      results.push(
        anyOf(alternatives.map((alt) => (Array.isArray(alt) && alt.length === 0 ? null : evaluate(alt, permissionKeys, holds)))),
      );
    } else if (permissionKeys.includes(key)) results.push(holds(item, key));
  }
  // An item that states only a condition ("the buildspec must be inline", "the
  // verb starts with ...") is a requirement this module cannot evaluate. Next
  // to a permission, as `request_context` is, it is simply not evaluated.
  const group = item.all_of !== undefined || item.any_of !== undefined;
  return results.length === 0 && !group ? null : allOf(results);
}

// --- matching names ------------------------------------------------------------------

/**
 * Does a held permission cover a required one? `*` stands for any run of
 * characters and `?` for any single one, as IAM and Azure use them.
 *
 * The two strings are walked with the last `*` remembered to fall back on,
 * which takes time in proportion to their lengths multiplied. The same pattern
 * as a regular expression is not an option: with "?" as "." and "*" as ".*" the
 * engine backtracks through every way of sharing the characters between them,
 * and compiling one fails for a long grant.
 */
export function covers(grant: string, need: string, provider: Provider): boolean {
  const ignoreCase = IGNORE_CASE[provider];
  const pattern = ignoreCase ? grant.toLowerCase() : grant;
  const name = ignoreCase ? need.toLowerCase() : need;
  let p = 0; // the next character of the pattern
  let n = 0; // the next character of the name
  let star = -1; // the last `*` the match may go back to
  let taken = 0; // how much of the name that `*` has taken so far
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p++;
      n++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      taken = n;
    } else if (star >= 0) {
      // Let that `*` take one character more, then continue after it.
      p = star + 1;
      n = ++taken;
    } else {
      return false;
    }
  }
  // What is left of the pattern must be stars only.
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}
