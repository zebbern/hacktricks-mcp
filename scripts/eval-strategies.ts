/**
 * Search-strategy eval: which way of turning a question into a query finds the
 * right page, at what context cost?
 *
 * Every scenario in tests/scenarios.json is a realistic ask plus the page(s)
 * that answer it, written twice: `named` (the ask names the technique) and
 * `goal` (it only describes the situation). Each ask is run through several
 * deterministic strategies, from the question as typed down to its most
 * specific words, against the built server over stdio, so the numbers reflect
 * what an agent actually receives.
 *
 * This is a report, not a gate: it exists to settle search guidance and
 * ranking changes with evidence. The 30 fixtures in tests/queries.json remain
 * the pass/fail gate (npm run eval).
 *
 * Usage:
 *   npm run build && npm run eval:strategies             # summary tables
 *   npm run eval:strategies -- --csv                     # the same numbers, one row per style and strategy
 *   npm run eval:strategies -- --misses <strategy>       # list what a strategy misses
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

interface Scenario {
  id: string;
  area: string;
  /** Path suffixes that answer the ask. The first is the best page, the rest are acceptable. */
  expect: string[];
  /** The ask names the technique or tool. */
  named: string;
  /** The same need described without the name. */
  goal: string;
}
type Style = "named" | "goal";

interface Query {
  query: string;
  category?: string;
}
interface Strategy {
  id: string;
  label: string;
  build: (ask: string, words: string[], byRarity: string[]) => Query;
}

/** Same tokenizer the server applies to a query (src/db.ts). */
const tokenize = (ask: string) =>
  ask
    .split(/\s+/)
    .map((t) => t.replace(/[^\w.-]/g, ""))
    .filter((t) => t.length > 0);

/** Platform words an ask may carry, mapped to the category substring that narrows to it. */
const PLATFORMS: [RegExp, string][] = [
  [/\b(linux|ubuntu|debian|centos|bash)\b/i, "Linux"],
  [/\b(windows|powershell|active directory|domain controller)\b/i, "Windows"],
  [/\b(macos|mac os|osx)\b/i, "MacOS"],
  [/\b(android|ios|iphone|apk)\b/i, "Mobile"],
];
const platformOf = (ask: string) => PLATFORMS.find(([re]) => re.test(ask))?.[1];

const asTyped: Strategy["build"] = (ask) => ({ query: ask });
const mostSpecific =
  (n: number): Strategy["build"] =>
  (_ask, _words, byRarity) => ({ query: byRarity.slice(0, n).join(" ") });
const withPlatform =
  (base: Strategy["build"]): Strategy["build"] =>
  (ask, words, byRarity) => {
    const category = platformOf(ask);
    return category ? { ...base(ask, words, byRarity), category } : base(ask, words, byRarity);
  };

const STRATEGIES: Strategy[] = [
  { id: "verbatim", label: "question as typed", build: asTyped },
  { id: "top3", label: "3 most specific words", build: mostSpecific(3) },
  { id: "top2", label: "2 most specific words", build: mostSpecific(2) },
  { id: "top1", label: "1 most specific word", build: mostSpecific(1) },
  { id: "verbatim+cat", label: "as typed + platform filter", build: withPlatform(asTyped) },
];

const matches = (pagePath: string, expect: string[]) => expect.some((e) => pagePath.includes(e));
const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(0).padStart(3)}%`;

interface Sample {
  rank: number; // 0-based position of the first acceptable page, -1 if absent
  bestRank: number; // same for the best page
  chars: number;
  ms: number;
  hubFirst: boolean;
  hits: number;
}

async function main() {
  const argv = process.argv.slice(2);
  const missesOf = argv.includes("--misses") ? argv[argv.indexOf("--misses") + 1] : null;

  const db = openDbReadonly(path.join(PKG_ROOT, "data", "hacktricks.db"));
  const pagesWith = (expr: string) =>
    (db.prepare("SELECT count(*) AS n FROM pages_fts WHERE pages_fts MATCH ?").get(expr) as { n: number }).n;
  const pageBySuffix = (suffix: string) =>
    db
      .prepare("SELECT content FROM pages WHERE path LIKE ? ORDER BY length(path)")
      .get(`%${suffix}`) as { content: string } | undefined;

  // Upstream renames and moves pages between syncs. A scenario whose pages are
  // gone says nothing about search quality, so it is skipped rather than failed.
  const all = JSON.parse(fs.readFileSync(SCENARIOS_PATH, "utf8")) as Scenario[];
  const scenarios = all.filter((s) => s.expect.every((e) => pageBySuffix(e) !== undefined));
  const skipped = all.length - scenarios.length;

  // An ask can only be found lexically if the best page shares a content word with it.
  const unreachable = { named: [] as string[], goal: [] as string[] };
  for (const s of scenarios) {
    const body = (pageBySuffix(s.expect[0])?.content ?? "").toLowerCase();
    for (const style of ["named", "goal"] as Style[]) {
      const words = tokenize(s[style].toLowerCase()).filter((w) => !STOPWORDS.has(w));
      if (!words.some((w) => body.includes(w))) unreachable[style].push(s.id);
    }
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PKG_ROOT, "dist", "server.js")],
    stderr: "ignore",
    env: { ...process.env } as Record<string, string>,
  });
  const client = new Client({ name: "eval-strategies", version: "0.0.1" });
  await client.connect(transport);

  // Rows follow scenario order, which is what the per-area breakdown relies on.
  const samples = new Map<string, Sample[]>(); // key: `${style}|${strategy}`
  const misses: { key: string; id: string; area: string; ask: string; query: string }[] = [];

  for (const s of scenarios) {
    for (const style of ["named", "goal"] as Style[]) {
      const ask = s[style];
      const words = tokenize(ask)
        .map((w) => w.toLowerCase())
        .filter((w) => !STOPWORDS.has(w));
      const byRarity = [...new Set(words)].sort((a, b) => {
        const ra = pagesWith(`"${a}"`);
        const rb = pagesWith(`"${b}"`);
        // A term absent from the index is useless, not specific.
        return (ra === 0 ? Infinity : ra) - (rb === 0 ? Infinity : rb) || words.indexOf(a) - words.indexOf(b);
      });
      for (const strategy of STRATEGIES) {
        const { query, category } = strategy.build(ask, words, byRarity);
        const started = performance.now();
        const res = (await client.callTool({
          name: "hacktricks_search",
          arguments: category ? { query, category, limit: K } : { query, limit: K },
        })) as { content: { text?: string }[]; structuredContent?: { results: { path: string }[] } };
        const ms = performance.now() - started;
        const paths = (res.structuredContent?.results ?? []).map((r) => r.path);
        const key = `${style}|${strategy.id}`;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key)!.push({
          rank: paths.findIndex((p) => matches(p, s.expect)),
          bestRank: paths.findIndex((p) => p.includes(s.expect[0])),
          chars: (res.content?.[0]?.text ?? "").length,
          ms,
          hubFirst: /\/README\.md$/.test(paths[0] ?? ""),
          hits: paths.length,
        });
        if (!paths.some((p) => matches(p, s.expect))) misses.push({ key, id: s.id, area: s.area, ask, query });
      }
    }
  }
  await client.close();
  db.close();

  const stats = (rows: Sample[]) => {
    const at = (k: number, pick: (r: Sample) => number) => rows.filter((r) => pick(r) >= 0 && pick(r) < k).length;
    const share = (k: number, pick: (r: Sample) => number) => at(k, pick) / rows.length;
    const mean = (pick: (r: Sample) => number) => Math.round(rows.reduce((sum, r) => sum + pick(r), 0) / rows.length);
    return {
      n: rows.length,
      hit1: share(1, (r) => r.rank),
      best1: share(1, (r) => r.bestRank),
      hit3: share(3, (r) => r.rank),
      hit5: share(K, (r) => r.rank),
      mrr: rows.reduce((sum, r) => sum + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0) / rows.length,
      zero: rows.filter((r) => r.hits === 0).length / rows.length,
      hub: rows.filter((r) => r.hubFirst).length / rows.length,
      chars: mean((r) => r.chars),
      ms: mean((r) => r.ms),
    };
  };

  // --csv: the same numbers as the tables below, one row per ask style and strategy.
  if (argv.includes("--csv")) {
    console.log("style,strategy,n,hit@1,best@1,hit@3,hit@5,mrr@5,zero,hub@1,chars,ms");
    for (const style of ["named", "goal"] as Style[]) {
      for (const strategy of STRATEGIES) {
        const s = stats(samples.get(`${style}|${strategy.id}`) ?? []);
        console.log(
          [style, strategy.id, s.n, s.hit1.toFixed(3), s.best1.toFixed(3), s.hit3.toFixed(3), s.hit5.toFixed(3), s.mrr.toFixed(3), s.zero.toFixed(3), s.hub.toFixed(3), s.chars, s.ms].join(","),
        );
      }
    }
    return;
  }

  console.log(`\nSearch strategy eval: ${scenarios.length} scenarios x 2 ask styles, top ${K} results, index of ${pageCountText()}`);
  if (skipped > 0) console.log(`skipped ${skipped} scenario(s) whose expected pages are no longer in the index`);

  const header =
    `${"strategy".padEnd(28)}${"n".padStart(4)}${"hit@1".padStart(7)}${"best@1".padStart(8)}${"hit@3".padStart(7)}${"hit@5".padStart(7)}` +
    `${"MRR@5".padStart(7)}${"zero".padStart(7)}${"hub@1".padStart(7)}${"chars".padStart(7)}${"ms".padStart(6)}`;

  for (const style of ["named", "goal"] as Style[]) {
    console.log(`\n=== ${style === "named" ? "ask names the technique" : "ask only describes the goal"} ===`);
    if (unreachable[style].length) {
      console.log(
        `not findable by any wording of the ask (best page shares no content word with it): ${unreachable[style].length}: ${unreachable[style].join(", ")}`,
      );
    }
    console.log(header);
    for (const strategy of STRATEGIES) {
      const s = stats(samples.get(`${style}|${strategy.id}`) ?? []);
      console.log(
        `${strategy.label.padEnd(28)}${String(s.n).padStart(4)}` +
          `${pct(s.hit1 * s.n, s.n).padStart(7)}${pct(s.best1 * s.n, s.n).padStart(8)}` +
          `${pct(s.hit3 * s.n, s.n).padStart(7)}${pct(s.hit5 * s.n, s.n).padStart(7)}` +
          `${s.mrr.toFixed(2).padStart(7)}${pct(s.zero * s.n, s.n).padStart(7)}` +
          `${pct(s.hub * s.n, s.n).padStart(7)}` +
          `${String(s.chars).padStart(7)}${String(s.ms).padStart(6)}`,
      );
    }
  }

  const focus = ["verbatim", "top3"];
  for (const style of ["named", "goal"] as Style[]) {
    console.log(`\n=== hit@5 by area, ${style} asks ===`);
    console.log(`${"area".padEnd(14)}${"n".padStart(4)}${focus.map((f) => f.padStart(12)).join("")}`);
    for (const area of [...new Set(scenarios.map((s) => s.area))]) {
      const inArea = scenarios.map((s) => s.area === area);
      const row = focus.map((f) => {
        const rows = (samples.get(`${style}|${f}`) ?? []).filter((_, i) => inArea[i]);
        return pct(rows.filter((r) => r.rank >= 0).length, rows.length).padStart(12);
      });
      console.log(`${area.padEnd(14)}${String(inArea.filter(Boolean).length).padStart(4)}${row.join("")}`);
    }
  }

  if (missesOf) {
    const rows = misses.filter((m) => m.key.endsWith(`|${missesOf}`));
    console.log(`\n=== misses at top ${K}: "${missesOf}" (${rows.length}) ===`);
    for (const m of rows) {
      console.log(`${m.key.split("|")[0].padEnd(6)}${m.area.padEnd(13)}${m.id.padEnd(26)}query: ${m.query}`);
      console.log(`      ask: ${m.ask}`);
    }
  }
}

/** Upstream commit short hash of the index under evaluation, from data/meta.json. */
function pageCountText(): string {
  const meta = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "data", "meta.json"), "utf8"));
  return `${meta.pageCount} pages, upstream ${String(meta.upstreamSha).slice(0, 7)}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
