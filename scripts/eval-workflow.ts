/**
 * Agent workflow eval: how often does an agent that follows the skill end up
 * with the page that answers a question, and what does the route cost?
 *
 * tests/scenarios.json holds realistic questions with the pages that answer
 * them, each written twice: `named` (the question names the technique) and
 * `goal` (it only describes the situation). The harness plays the skill's
 * steps against the built server over stdio, so its sizes are what an agent
 * reads:
 *
 *   permissions hacktricks_cloud_permissions, for a question that names cloud permissions
 *   search      hacktricks_search with the question, limit 5
 *   name it     search again with the technique's name (the `named` form)
 *   list topic  hacktricks_get_toc with the rarest topic words of the question
 *
 * The route the skill gives starts with the permissions check for a question
 * that names permissions, and with the search otherwise.
 *
 * A question is found when an expected page is among the five results, or in
 * the listing. The last route of each table is what the skill tells agents to
 * do, and it is the gate: it must keep finding the page for nearly every
 * question. The step where the agent names the technique assumes it names it
 * as the scenario's `named` question does; whether a live agent does is not
 * something this harness can see.
 *
 * Usage:
 *   npm run build && npm run eval:workflow       # tables, and how often the first result is already the page
 *   npm run eval:workflow -- --misses           # what the skill's route still does not find
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDbReadonly, STOPWORDS } from "../src/db.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS_PATH = path.join(PKG_ROOT, "tests", "scenarios.json");
const K = 5;
/** The skill's route must find the page for at least this share of questions, asked either way. */
const FLOOR = 0.9;
/** How many topic words the "list topic" step tries, rarest first, stopping at a listing that is not empty. */
const TOPIC_WORDS = 2;

interface Scenario {
  id: string;
  area: string;
  /** Path suffixes that answer the question. The first is the best page, the rest are acceptable. */
  expect: string[];
  /** The question names the technique or tool. */
  named: string;
  /** The same need described without the name. */
  goal: string;
}
type Ask = "named" | "goal";

/** What a step cost and whether it found the page. */
interface Outcome {
  found: boolean;
  calls: number;
  chars: number;
  /** Search steps only: the first result is an expected page. */
  first?: boolean;
}
type Step = () => Promise<Outcome> | null;
type Steps = { search: (ask: Ask) => Step; list: (ask: Ask) => Step; permissions: (ask: Ask) => Step };
type Route = { label: string; play: (steps: Steps) => Step[]; /** One search and nothing else. */ searchOnly?: boolean };

const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(0).padStart(3)}%`;
const matches = (pagePath: string, expect: string[]) => expect.some((e) => pagePath.includes(e));
const asks: Ask[] = ["named", "goal"];

/** Permissions as the three clouds write them, for the questions that name them. */
const PERMISSION_PATTERNS: [RegExp, string][] = [
  [/\b[a-z0-9-]+:[A-Za-z][A-Za-z0-9*:.-]*/g, "aws"],
  [/\bMicrosoft\.[A-Za-z]+\/[A-Za-z0-9./_-]+/g, "azure"],
  [/\b[A-Z][a-zA-Z]+\.[A-Za-z]+\.All\b/g, "azure"],
  [/\b[a-z][a-z0-9]*(?:\.[a-z][A-Za-z0-9]*){2,}\b/g, "gcp"],
];
/** The permissions a question names (without the sentence's punctuation), and their cloud, or null. */
function permissionQuestion(question: string): { provider: string; permissions: string[] } | null {
  for (const [pattern, provider] of PERMISSION_PATTERNS) {
    const permissions = (question.match(pattern) ?? []).map((p) => p.replace(/[.,;:]+$/, ""));
    if (permissions.length > 0) return { provider, permissions: [...new Set(permissions)] };
  }
  return null;
}

const argv = process.argv.slice(2);
const db = openDbReadonly(path.join(PKG_ROOT, "data", "hacktricks.db"));
const pagesWith = (word: string) =>
  (db.prepare("SELECT count(*) AS n FROM pages_fts WHERE pages_fts MATCH ?").get(`"${word}"`) as { n: number }).n;

// Upstream renames and moves pages between syncs. A question whose pages are
// gone says nothing about search quality, so it is skipped rather than failed.
const all = JSON.parse(fs.readFileSync(SCENARIOS_PATH, "utf8")) as Scenario[];
const scenarios = all.filter((s) => s.expect.every((e) => db.prepare("SELECT 1 FROM pages WHERE path LIKE ? LIMIT 1").get(`%${e}`)));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PKG_ROOT, "dist", "server.js")],
  stderr: "ignore",
  // The background index refresh stays off: the report describes the bundled index.
  env: { ...process.env, HACKTRICKS_OFFLINE: "1" } as Record<string, string>,
});
const client = new Client({ name: "eval-workflow", version: "0.0.1" });
await client.connect(transport);

const search = async (query: string) => {
  const res = (await client.callTool({ name: "hacktricks_search", arguments: { query, limit: K } })) as {
    content: { text?: string }[];
    structuredContent?: { results: { path: string }[] };
  };
  return { paths: (res.structuredContent?.results ?? []).map((r) => r.path), chars: (res.content?.[0]?.text ?? "").length };
};
const listTopic = async (word: string) => {
  const res = (await client.callTool({ name: "hacktricks_get_toc", arguments: { category: word } })) as {
    content: { text?: string }[];
    structuredContent?: { tree: string };
  };
  return { tree: res.structuredContent?.tree ?? "", chars: (res.content?.[0]?.text ?? "").length };
};
const checkPermissions = async (provider: string, permissions: string[]) => {
  const res = (await client.callTool({ name: "hacktricks_cloud_permissions", arguments: { provider, permissions } })) as {
    content: { text?: string }[];
    structuredContent?: { escalation: { page: string }[]; sections: { page: string }[] };
  };
  return {
    pages: [...(res.structuredContent?.escalation ?? []), ...(res.structuredContent?.sections ?? [])].map((x) => x.page),
    chars: (res.content?.[0]?.text ?? "").length,
  };
};

/** The wiki's own word for a cloud, as the skill gives it: every Cloud page title starts with it. */
const PROVIDER_WORDS: [RegExp, string][] = [
  [/\bkubernetes|\bk8s\b/i, "K8s"],
  [/\baws\b|amazon/i, "AWS - "],
  [/\bgcp\b|google cloud/i, "GCP - "],
  [/\bazure\b/i, "Az - "],
];

/** Topic words of a question: the cloud it names first, as the skill says, then its own rarest words. */
const topicWords = (ask: string) => [
  ...PROVIDER_WORDS.filter(([pattern]) => pattern.test(ask)).map(([, word]) => word),
  ...[...new Set(ask.split(/\s+/).map((t) => t.replace(/[^\w.-]/g, "").toLowerCase()))]
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .map((w) => ({ w, pages: pagesWith(w) }))
    .filter((x) => x.pages > 0)
    .sort((a, b) => a.pages - b.pages)
    .map((x) => x.w),
].slice(0, TOPIC_WORDS);

/** The calls the routes may make for one question. Each runs once, and only if a route reaches it. */
function stepsFor(s: Scenario): Steps {
  const cache = new Map<string, Promise<Outcome>>();
  const once = (key: string, run: () => Promise<Outcome>) => {
    if (!cache.has(key)) cache.set(key, run());
    return cache.get(key)!;
  };
  const searchStep =
    (ask: Ask): Step =>
    () =>
      once(`search:${ask}`, async () => {
        const r = await search(s[ask]);
        return { found: r.paths.some((p) => matches(p, s.expect)), first: r.paths.length > 0 && matches(r.paths[0], s.expect), calls: 1, chars: r.chars };
      });
  // A question that names cloud permissions goes to hacktricks_cloud_permissions,
  // as the skill says; the pages it points to are then the candidates.
  const permissionsStep =
    (ask: Ask): Step =>
    () => {
      const check = permissionQuestion(s[ask]);
      if (!check) return null;
      return once(`permissions:${ask}`, async () => {
        const r = await checkPermissions(check.provider, check.permissions);
        return { found: r.pages.some((p) => matches(p, s.expect)), calls: 1, chars: r.chars };
      });
    };
  const listStep =
    (ask: Ask): Step =>
    () => {
      const words = topicWords(s[ask]);
      if (words.length === 0) return null;
      return once(`list:${ask}`, async () => {
        let calls = 0;
        let chars = 0;
        for (const word of words) {
          const r = await listTopic(word);
          calls++;
          chars += r.chars;
          // An empty listing sends the agent on to the next word; a real listing is read once.
          if (s.expect.some((e) => r.tree.includes(e))) return { found: true, calls, chars };
          if (r.tree !== "(none)") break;
        }
        return { found: false, calls, chars };
      });
    };
  return { search: searchStep, list: listStep, permissions: permissionsStep };
}

const ROUTES: Record<Ask, Route[]> = {
  named: [
    { label: "permissions check (questions that name them)", play: (c) => [c.permissions("named")] },
    { label: "search only", play: (c) => [c.search("named")], searchOnly: true },
    { label: "skill: check permissions, search, list the topic", play: (c) => [c.permissions("named"), c.search("named"), c.list("named")] },
  ],
  goal: [
    { label: "permissions check (questions that name them)", play: (c) => [c.permissions("goal")] },
    { label: "search only, as typed", play: (c) => [c.search("goal")], searchOnly: true },
    { label: "as typed, then with the technique's name", play: (c) => [c.search("goal"), c.search("named")] },
    { label: "name first, then as typed", play: (c) => [c.search("named"), c.search("goal")] },
    {
      label: "skill: permissions, name first, as typed, list the topic",
      play: (c) => [c.permissions("goal"), c.search("named"), c.search("goal"), c.list("goal"), c.list("named")],
    },
  ],
};

/** Run a route for one question: stop at the step that finds the page and add up what was read. */
async function play(route: Route, c: Steps): Promise<Outcome> {
  let calls = 0;
  let chars = 0;
  let found = false;
  // Of the first search the route makes.
  let first: boolean | undefined;
  for (const run of route.play(c)) {
    const pending = run();
    if (!pending) continue;
    const outcome = await pending;
    calls += outcome.calls;
    chars += outcome.chars;
    first ??= outcome.first;
    if (outcome.found) {
      found = true;
      break;
    }
  }
  return { found, calls, chars, first };
}

// Rows follow scenario order, which is what the per-area table relies on.
const results = new Map<string, Outcome[]>();
for (const s of scenarios) {
  const steps = stepsFor(s);
  for (const ask of asks) {
    for (const route of ROUTES[ask]) {
      const key = `${ask}|${route.label}`;
      if (!results.has(key)) results.set(key, []);
      results.get(key)!.push(await play(route, steps));
    }
  }
}
await client.close();
db.close();

const rowsOf = (ask: Ask, label: string) => results.get(`${ask}|${label}`) ?? [];
const stats = (rows: Outcome[]) => ({
  found: rows.filter((r) => r.found).length,
  calls: (rows.reduce((n, r) => n + r.calls, 0) / rows.length).toFixed(2),
  chars: Math.round(rows.reduce((n, r) => n + r.chars, 0) / rows.length),
});
const printRoutes = (ask: Ask) => {
  console.log(`\n=== the question ${ask === "named" ? "names the technique" : "only describes the situation"} (${scenarios.length}) ===`);
  console.log(`${"route".padEnd(54)}${"found".padStart(7)}${"calls".padStart(7)}${"chars".padStart(8)}`);
  for (const route of ROUTES[ask]) {
    const s = stats(rowsOf(ask, route.label));
    console.log(
      `${route.label.padEnd(54)}${`${s.found}/${scenarios.length}`.padStart(7)}${s.calls.padStart(7)}${s.chars.toLocaleString("en-US").padStart(8)}`,
    );
  }
};
const skillRoute = (ask: Ask) => ROUTES[ask][ROUTES[ask].length - 1].label;

const meta = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "data", "meta.json"), "utf8"));
const upstream = Object.values(meta.books).map((sha) => String(sha).slice(0, 7)).join(" and ");
console.log(
  `\nAgent workflow eval: ${scenarios.length} questions, each asked two ways, top ${K} results, index of ${meta.pageCount} pages at upstream ${upstream}`,
);
if (scenarios.length < all.length) console.log(`skipped ${all.length - scenarios.length} question(s) whose expected pages are no longer in the index`);
printRoutes("named");
printRoutes("goal");

// The skill asks agents to read the titles below the first result before
// choosing, so how often that result is already the page is worth knowing.
for (const ask of asks) {
  const label = ROUTES[ask].find((r) => r.searchOnly)!.label;
  const first = rowsOf(ask, label).filter((r) => r.first).length;
  const how = ask === "named" ? "the technique is named" : "the situation is described as typed";
  console.log(`\nThe first of the ${K} results is an expected page for ${pct(first, scenarios.length).trim()} of the questions when ${how}.`);
}

console.log("\n=== found by the skill's route, by area ===");
console.log(`${"area".padEnd(13)}${"questions".padStart(9)}${"names it".padStart(10)}${"describes it".padStart(14)}`);
for (const area of [...new Set(scenarios.map((s) => s.area))]) {
  const inArea = scenarios.map((s) => s.area === area);
  const found = (ask: Ask) => rowsOf(ask, skillRoute(ask)).filter((r, i) => inArea[i] && r.found).length;
  const n = inArea.filter(Boolean).length;
  console.log(`${area.padEnd(13)}${String(n).padStart(9)}${`${found("named")}/${n}`.padStart(10)}${`${found("goal")}/${n}`.padStart(14)}`);
}

if (argv.includes("--misses")) {
  console.log("\n=== not found by the skill's route ===");
  for (const ask of asks) {
    rowsOf(ask, skillRoute(ask)).forEach((r, i) => {
      if (!r.found) console.log(`${ask.padEnd(6)} ${scenarios[i].area.padEnd(12)} ${scenarios[i].id.padEnd(30)} ${scenarios[i][ask]}`);
    });
  }
}

const worst = Math.min(...asks.map((ask) => stats(rowsOf(ask, skillRoute(ask))).found / scenarios.length));
console.log(
  `\nGate: the skill's route finds the page for ${pct(Math.round(worst * scenarios.length), scenarios.length).trim()} of the questions at worst, asked either way; it must stay at or above ${FLOOR * 100}%.`,
);
process.exit(worst >= FLOOR ? 0 : 1);
