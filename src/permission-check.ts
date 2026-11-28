/**
 * The permissions check behind hacktricks_cloud_permissions: rate the
 * permissions a principal holds and list the escalation techniques they enable.
 *
 * It reads the tables the indexer fills from HackTricks Cloud's data (see
 * src/permissions.ts and src/kubernetes-rbac.ts) and caches each provider's
 * data per open database.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  holdsKubernetes,
  parseKubernetesGrant,
  rateKubernetesGrant,
  KUBERNETES_GRANT_SYNTAX,
  type KubernetesGrant,
} from "./kubernetes-rbac.js";
import {
  covers,
  evalRequires,
  PERMISSION_KEYS,
  SEVERITIES,
  type EscalationRow,
  type Mapping,
  type Provider,
  type Severity,
} from "./permissions.js";

export type Rating = Severity | "not rated";

/** How many techniques are listed at most; `escalationTotal` says how many there are. */
const ESCALATION_LIMIT = 30;
/** How many combination rules are listed at most, the most severe first; `combinationsTotal` says how many there are. A wildcard that covers everything holds all of them. */
export const COMBINATION_LIMIT = 25;
/** How many rated permissions a wildcard grant names at most, per rating. */
const WILDCARD_EXAMPLES = 12;

export interface RiskAnswer {
  permission: string;
  severity: Rating;
  /** For a wildcard grant, what it matches; for Kubernetes, what the rule says. */
  note?: string;
}

export interface EscalationMatch {
  id: string;
  service: string;
  title: string;
  summary: string;
  severity: Severity;
  confidence: string;
  needs: string[];
  /** What the technique gains: the kind of principal or resource, and where. */
  gains: string;
  conditions: string[];
  blockers: string[];
  mitigation: string;
  page: string;
  /** The heading of the section that explains the technique, when it is found. */
  section?: string;
}

/** A section of the Cloud book whose heading is the permission itself. */
export interface SectionMatch {
  permission: string;
  page: string;
  heading: string;
}

export interface PermissionCheck {
  provider: Provider;
  risk: RiskAnswer[];
  combinations: { severity: Severity; permissions: string[] }[];
  /** How many combination rules the held permissions complete in all. */
  combinationsTotal: number;
  escalation: EscalationMatch[];
  escalationTotal: number;
  /** Techniques of the provider that depend on more than permissions, so they are neither listed nor ruled out. */
  notEvaluated: number;
  /** Sections named after a held permission. The catalog does not cover every permission the book describes. */
  sections: SectionMatch[];
}

interface ProviderData {
  /** Rated permissions by folded name; GCP names keep their case. */
  risk: Map<string, { name: string; severity: Severity }>;
  fold: (name: string) => string;
  combinations: { severity: Severity; permissions: string[] }[];
  escalations: EscalationRow[];
  rules: Mapping[];
}

const loaded = new WeakMap<DatabaseSync, Map<Provider, ProviderData>>();

function dataOf(db: DatabaseSync, provider: Provider): ProviderData {
  let providers = loaded.get(db);
  if (!providers) loaded.set(db, (providers = new Map()));
  const cached = providers.get(provider);
  if (cached) return cached;

  const fold = (name: string) => (provider === "gcp" || provider === "k8s" ? name : name.toLowerCase());
  const risk = new Map<string, { name: string; severity: Severity }>();
  for (const row of db.prepare("SELECT permission, severity FROM permission_risk WHERE provider = ?").all(provider) as {
    permission: string;
    severity: Severity;
  }[]) {
    risk.set(fold(row.permission), { name: row.permission, severity: row.severity });
  }
  const combinations = (
    db.prepare("SELECT severity, permissions FROM permission_combination WHERE provider = ?").all(provider) as {
      severity: Severity;
      permissions: string;
    }[]
  ).map((row) => ({ severity: row.severity, permissions: JSON.parse(row.permissions) as string[] }));
  const escalations = db.prepare("SELECT * FROM escalation WHERE provider = ?").all(provider) as unknown as EscalationRow[];
  const rules =
    provider === "k8s"
      ? (
          db
            .prepare("SELECT rule FROM permission_rule WHERE provider = ? ORDER BY position")
            .all(provider) as { rule: string }[]
        ).map((row) => JSON.parse(row.rule) as Mapping)
      : [];
  const data: ProviderData = { risk, fold, combinations, escalations, rules };
  providers.set(provider, data);
  return data;
}

/**
 * Rate the permissions a principal holds and list the escalation techniques
 * they enable, at most `limit` of them (`escalationTotal` says how many there
 * are). Throws when a Kubernetes grant is not written as expected.
 */
export function checkPermissions(db: DatabaseSync, provider: Provider, held: string[], limit = ESCALATION_LIMIT): PermissionCheck {
  const data = dataOf(db, provider);
  const grants = uniqueGrants(provider, held);
  const kubernetes: KubernetesGrant[] = [];
  if (provider === "k8s") {
    for (const grant of grants) {
      const parsed = parseKubernetesGrant(grant);
      if (!parsed) throw new Error(`"${grant}" is not a Kubernetes grant. Write each one as ${KUBERNETES_GRANT_SYNTAX}.`);
      kubernetes.push(parsed);
    }
  }

  // Most severe first, and among equals the rule that needs fewer permissions.
  const heldCombinations = data.combinations.filter((combination) =>
    combination.permissions.every((need) => grants.some((grant) => covers(grant, need, provider))),
  );
  heldCombinations.sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.permissions.length - b.permissions.length,
  );
  const combinations = heldCombinations.slice(0, COMBINATION_LIMIT);

  const matches: EscalationMatch[] = [];
  const byId = new Map<string, EscalationRow>();
  let notEvaluated = 0;
  for (const row of data.escalations) {
    byId.set(row.id, row);
    const held_ = evalRequires(JSON.parse(row.requires), PERMISSION_KEYS[provider], (leaf, key) =>
      provider === "k8s"
        ? holdsKubernetes(leaf, kubernetes)
        : grants.some((grant) => covers(grant, String(leaf[key]), provider)),
    );
    if (held_ !== true) {
      if (held_ === null) notEvaluated++;
      continue;
    }
    const { page, section } = locate(db, row.source);
    const target = JSON.parse(row.target) as { kind: string; scope: string };
    matches.push({      id: row.id,
      service: row.service,
      title: row.title,
      summary: row.summary,
      severity: row.severity,
      confidence: row.confidence,
      needs: JSON.parse(row.needs) as string[],
      gains: [target.kind, target.scope].filter(Boolean).join(", ").replace(/^([^,]+), (.+)$/, "$1 ($2)"),
      conditions: JSON.parse(row.conditions) as string[],
      blockers: JSON.parse(row.blockers) as string[],
      mitigation: row.mitigation,
      page,
      section,
    });
  }
  // Order for "what can I do with these permissions": techniques of a service
  // the held permissions belong to, then those that use more of them.
  const heldServices = new Set(grants.map(serviceOf));
  const serviceRank = (row: EscalationRow) => (heldServices.has(row.service.replace(/_/g, "").toLowerCase()) ? 0 : 1);
  matches.sort(
    (a, b) =>
      serviceRank(byId.get(a.id)!) - serviceRank(byId.get(b.id)!) ||
      b.needs.length - a.needs.length ||
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.id.localeCompare(b.id),
  );

  // The same permission twice, or in another case, is rated once.
  const risk: RiskAnswer[] = [];
  const rated = new Set<string>();
  for (const answer of provider === "k8s" ? kubernetes.map((grant, i) => rateRule(data, grant, grants[i])) : grants.map((grant) => rateGrant(data, grant, provider))) {
    if (rated.has(answer.permission)) continue;
    rated.add(answer.permission);
    risk.push(answer);
  }

  return {
    provider,
    risk,
    combinations,
    combinationsTotal: heldCombinations.length,
    escalation: matches.slice(0, limit),
    escalationTotal: matches.length,
    notEvaluated,
    // Sections named after the permissions themselves: the catalog does not
    // cover everything the book describes.
    sections: provider === "k8s" ? [] : sectionsFor(db, provider, grants),
  };
}

/**
 * The permissions to check, each once. A Kubernetes grant has spaces of its own.
 * Elsewhere several permissions pasted into one entry ("iam:PassRole,
 * lambda:CreateFunction", a list in quotes, or one of the headings this tool
 * prints, "iam:PassRole (+ a compute service)") are split, and the pieces that
 * are permissions are kept, so that none is rated "not rated" for being glued
 * to another. An entry whose pieces are not permissions (a policy document in
 * braces, a sentence) stays whole, so that the caller sees it rated as such.
 */
function uniqueGrants(provider: Provider, held: string[]): string[] {
  const isPermission = (piece: string) => /[:./]/.test(piece);
  const ofEntry = (entry: string): string[] => {
    if (provider === "k8s" || /[{}]/.test(entry)) return [entry];
    // A sentence ends in its last permission: "the role holds iam:PassRole."
    const pieces = entry
      .split(/[\s,;"'()[\]]+/)
      .map((piece) => piece.replace(/[.,;:!?]+$/, "").trim())
      .filter(Boolean);
    if (pieces.length <= 1) return pieces;
    const permissions = pieces.filter(isPermission);
    return permissions.length > 0 ? permissions : [entry];
  };
  return [...new Set(held.flatMap(ofEntry).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

/** The service a permission belongs to, as the catalog spells a technique's `service`: the first segment of its name. */
function serviceOf(permission: string): string {
  return permission.toLowerCase().replace(/^microsoft\./, "").split(/[.:/]/)[0].replace(/_/g, "");
}

/** One held permission against the rated list. */
function rateGrant(data: ProviderData, grant: string, provider: Provider): RiskAnswer {
  const exact = data.risk.get(data.fold(grant));
  if (exact) return { permission: exact.name, severity: exact.severity };
  if (!grant.includes("*") && !grant.includes("?")) return { permission: grant, severity: "not rated" };

  // A wildcard covers every rated permission it matches.
  const counts = new Map<Severity, number>(SEVERITIES.map((s) => [s, 0]));
  const examples = new Map<Severity, string[]>(SEVERITIES.map((s) => [s, []]));
  for (const [key, { name, severity }] of data.risk) {
    if (!covers(grant, key, provider)) continue;
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
    const list = examples.get(severity) ?? [];
    if (list.length < WILDCARD_EXAMPLES) list.push(name);
  }
  const matched = SEVERITIES.filter((s) => (counts.get(s) ?? 0) > 0);
  if (matched.length === 0) return { permission: grant, severity: "not rated" };
  const matchedCount = matched.reduce((n, s) => n + (counts.get(s) ?? 0), 0);
  const note = [`matches ${matchedCount.toLocaleString("en-US")} rated permission${matchedCount === 1 ? "" : "s"}`];
  for (const severity of ["critical", "high"] as const) {
    const list = examples.get(severity) ?? [];
    if (list.length === 0) continue;
    const shown = list.slice(0, 6).join(", ");
    note.push(`${counts.get(severity)} ${severity}: ${shown}${list.length > 6 ? ", ..." : ""}`);
  }
  return { permission: grant, severity: matched[0], note: note.join(": ") };
}

function rateRule(data: ProviderData, grant: KubernetesGrant, text: string): RiskAnswer {
  const rating = rateKubernetesGrant(data.rules, grant);
  return { permission: text, severity: rating.severity, note: rating.description || undefined };
}

/** The page a technique's `source` points to, and the heading its anchor stands for. */
function locate(db: DatabaseSync, source: string): { page: string; section?: string } {
  const hash = source.indexOf("#");
  const page = hash < 0 ? source : source.slice(0, hash);
  if (hash < 0 || page.length === 0) return { page };
  const row = db.prepare("SELECT outline FROM pages WHERE book = 'hacktricks-cloud' AND path = ?").get(page) as
    | { outline: string }
    | undefined;
  if (!row) return { page };

  // Anchors on the wiki are heading slugs: lowercase, punctuation dropped, spaces as hyphens, repeats numbered.
  const anchor = decodeURIComponent(source.slice(hash + 1));
  const seen = new Map<string, number>();
  for (const heading of JSON.parse(row.outline) as { text: string }[]) {
    const text = headingText(heading.text);
    const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const repeats = seen.get(slug) ?? 0;
    seen.set(slug, repeats + 1);
    if ((repeats ? `${slug}-${repeats}` : slug) === anchor) return { page, section: text };
  }
  return { page };
}

/** A heading as a reader sees it: without anchors and emphasis. */
function headingText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most this many sections are listed per permission. */
const SECTIONS_PER_PERMISSION = 8;

type Sections = Map<string, SectionMatch[]>;
const sectionsLoaded = new WeakMap<DatabaseSync, Sections>();

/**
 * Permission names at the start of a heading or after a separator, in the
 * spellings of the three clouds: "iam:PassRole", "Microsoft.Authorization/...",
 * "iam.serviceAccounts.getAccessToken", "Application.ReadWrite.All".
 */
const PERMISSION_IN_HEADING =
  /(?:^|[\s,(|+])((?:[a-z0-9-]+:[A-Za-z0-9*:-]+)|(?:Microsoft\.[A-Za-z0-9.]+\/[A-Za-z0-9./_-]+)|(?:[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)|(?:[A-Z][a-zA-Z]+\.[a-zA-Z]+\.All)|(?:microsoft\.[a-z]+\/[^\s|)]+))/g;

/**
 * The sections of the Cloud book, by the permission their heading names. Many
 * headings are the permission itself ("iam:CreatePolicyVersion",
 * "Microsoft.Authorization/roleAssignments/write") or start with it
 * ("iam:PassRole (+ a compute service)"). They cover permissions the
 * escalation catalog has no technique for.
 */
function sectionsByHeading(db: DatabaseSync): Sections {
  const cached = sectionsLoaded.get(db);
  if (cached) return cached;
  const sections: Sections = new Map();
  for (const row of db.prepare("SELECT path, outline FROM pages WHERE book = 'hacktricks-cloud'").all() as {
    path: string;
    outline: string;
  }[]) {
    for (const heading of JSON.parse(row.outline) as { text: string }[]) {
      const text = headingText(heading.text);
      for (const match of text.matchAll(PERMISSION_IN_HEADING)) {
        const key = match[1].toLowerCase();
        sections.set(key, [...(sections.get(key) ?? []), { permission: match[1], page: row.path, heading: text }]);
      }
    }
  }
  // Privilege escalation pages first: a permission that names many sections is most often asked about as "what does this let me do?".
  for (const [key, list] of sections) {
    list.sort((a, b) => Number(!a.page.includes("privilege-escalation")) - Number(!b.page.includes("privilege-escalation")));
    sections.set(key, list);
  }
  sectionsLoaded.set(db, sections);
  return sections;
}

function sectionsFor(db: DatabaseSync, provider: Provider, grants: string[]): SectionMatch[] {
  const sections = sectionsByHeading(db);
  const found: SectionMatch[] = [];
  for (const grant of grants) {
    const wildcard = grant.includes("*") || grant.includes("?");
    const keys = wildcard ? [...sections.keys()].filter((key) => covers(grant, key, provider)) : [grant.toLowerCase()];
    let shown = 0;
    for (const key of keys) {
      for (const section of sections.get(key) ?? []) {
        if (shown === SECTIONS_PER_PERMISSION) break;
        found.push({ ...section, permission: grant });
        shown++;
      }
      if (shown === SECTIONS_PER_PERMISSION) break;
    }
  }
  return found;
}
