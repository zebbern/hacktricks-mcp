/**
 * Permissions gate: is hacktricks_cloud_permissions faithful to HackTricks Cloud?
 *
 * 1. Against the whole escalation catalog, by construction: every technique
 *    that names permissions is listed when exactly those are held, and when
 *    its requirement is a plain conjunction it is not listed without any one
 *    of them.
 * 2. Against tests/permissions.json: hand-checked ratings, techniques and page
 *    sections, so that a change in the data or in the matcher that moves a
 *    known answer is caught.
 *
 * Reads the index directly (src/permission-check.ts); no build needed.
 *
 * Usage: npm run eval:permissions
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDbReadonly } from "../src/db.js";
import { checkPermissions } from "../src/permission-check.js";
import { holdsKubernetes, parseKubernetesGrant } from "../src/kubernetes-rbac.js";
import { covers, PERMISSION_KEYS, visitLeaves, type Mapping, type Provider } from "../src/permissions.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = openDbReadonly(path.join(PKG_ROOT, "data", "hacktricks.db"));
const failures: string[] = [];
const fail = (message: string) => failures.push(message);

// --- 1. the whole catalog ---------------------------------------------------------

interface Fixture {
  provider: Provider;
  permissions: string[];
  risk: Record<string, string>;
  noteContains?: string;
  listed?: string[];
  notListed?: string[];
  first?: string;
  noTechniques?: boolean;
  sections?: Record<string, string>;
}

/**
 * Techniques that name permissions but are never listed: their requirement
 * has a matching rule of its own (a scoped impersonation verb) that the check
 * does not evaluate. A technique outside this list that is not listed from
 * its own permissions is a defect.
 */
const NOT_EVALUATED = new Set([
  "k8s-rbac-constrained-impersonation-user",
  "k8s-rbac-constrained-impersonation-serviceaccount",
  "k8s-rbac-constrained-impersonation-node",
  "k8s-rbac-constrained-impersonation-associated-node",
]);

/** Does the requirement offer alternatives anywhere? */
const hasAlternatives = (node: unknown): boolean =>
  Array.isArray(node)
    ? node.some(hasAlternatives)
    : node !== null &&
      typeof node === "object" &&
      Object.entries(node as Record<string, unknown>).some(([key, value]) => key === "any_of" || hasAlternatives(value));

/** The held grants that satisfy one requirement leaf. */
function satisfying(provider: Provider, leaf: Mapping, grants: string[]): string[] {
  const key = PERMISSION_KEYS[provider].find((k) => typeof leaf[k] === "string");
  if (!key) return [];
  if (provider !== "k8s") return grants.filter((grant) => covers(grant, String(leaf[key]), provider));
  return grants.filter((grant) => {
    const parsed = parseKubernetesGrant(grant);
    return parsed !== null && holdsKubernetes(leaf, [parsed]) === true;
  });
}

const catalog = db.prepare("SELECT provider, id, needs, requires FROM escalation").all() as {
  provider: Provider;
  id: string;
  needs: string;
  requires: string;
}[];
const EVERYTHING = 100000;
let withPermissions = 0;
let conjunctions = 0;
let unevaluated = 0;
for (const row of catalog) {
  const needs = JSON.parse(row.needs) as string[];
  if (needs.length === 0) continue; // depends on inventory or ownership, never listed
  const listed = (held: string[]) => checkPermissions(db, row.provider, held, EVERYTHING).escalation.some((m) => m.id === row.id);
  if (!listed(needs)) {
    unevaluated++;
    if (!NOT_EVALUATED.has(row.id)) fail(`${row.id} is not listed from its own permissions ${row.needs}`);
    continue;
  }
  withPermissions++;
  const requires = JSON.parse(row.requires);
  if (hasAlternatives(requires)) continue;
  conjunctions++;
  // Without every grant that satisfies one leaf of a plain conjunction, the technique must go.
  visitLeaves(requires, (leaf) => {
    if ("all_of" in leaf || "any_of" in leaf) return;
    const drop = new Set(satisfying(row.provider, leaf, needs));
    if (drop.size > 0 && listed(needs.filter((need) => !drop.has(need)))) {
      fail(`${row.id} is still listed without ${[...drop].join(", ")} (${row.provider})`);
    }
  });
}
if (unevaluated !== NOT_EVALUATED.size) fail(`${unevaluated} techniques are not evaluated; the list names ${NOT_EVALUATED.size}`);
console.log(
  `Catalog: ${withPermissions} techniques name permissions the check evaluates; all are listed from their own, ` +
    `and ${conjunctions} plain conjunctions are not listed without a leaf's grants. ${unevaluated} are not evaluated (named in the test).`,
);

// --- 2. fixtures ----------------------------------------------------------------------

const fixtures = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "tests", "permissions.json"), "utf8")) as Fixture[];
for (const f of fixtures) {
  const label = `${f.provider} [${f.permissions.join(", ")}]`;
  const check = checkPermissions(db, f.provider, f.permissions, EVERYTHING);
  const ids = check.escalation.map((m) => m.id);

  for (const [permission, severity] of Object.entries(f.risk)) {
    const answer = check.risk.find((r) => r.permission === permission);
    if (!answer || answer.severity !== severity) {
      fail(`${label}: ${permission} is rated ${answer?.severity ?? "missing"}, expected ${severity}`);
    }
  }
  const note = f.noteContains;
  if (note && !check.risk.some((r) => r.note?.includes(note))) {
    fail(`${label}: no note contains "${note}"`);
  }
  for (const id of f.listed ?? []) if (!ids.includes(id)) fail(`${label}: ${id} is not listed`);
  for (const id of f.notListed ?? []) if (ids.includes(id)) fail(`${label}: ${id} is listed`);
  if (f.first && ids[0] !== f.first) fail(`${label}: first technique is ${ids[0]}, expected ${f.first}`);
  if (f.noTechniques && check.escalationTotal > 0) fail(`${label}: ${check.escalationTotal} techniques listed, expected none`);
  for (const [permission, page] of Object.entries(f.sections ?? {})) {
    if (!check.sections.some((s) => s.permission === permission && s.page.includes(page))) {
      fail(`${label}: no section named ${permission} in a page matching ${page}`);
    }
  }
}
console.log(`Fixtures: ${fixtures.length} checked.`);

for (const message of failures) console.log(`✗ ${message}`);
console.log(failures.length === 0 ? "Permissions eval passed" : `Permissions eval: ${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
