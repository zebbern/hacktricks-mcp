/**
 * What a read costs, in characters, on the built index: a search of five
 * hits, a page's outline, a section and a whole page, each as an agent reads
 * it. The README and docs/development.md quote these numbers. Run it again
 * when the index or what a tool returns has changed.
 *
 * Usage: npm run build && npm run cost
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDbReadonly } from "../src/db.js";
import { plainText, sectionLengths, type Heading } from "../src/markdown.js";
import { scratchCache } from "./scratch-cache.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Page = { book: string; path: string; content: string; outline: string };
const db = openDbReadonly(path.join(PKG_ROOT, "data", "hacktricks.db"));
const pages = db.prepare("SELECT book, path, content, outline FROM pages").all() as Page[];
const questions = (JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "tests", "scenarios.json"), "utf8")) as { named: string }[]).map(
  (scenario) => scenario.named,
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PKG_ROOT, "dist", "server.js")],
  stderr: "ignore",
  // The refresh stays off and the cache is a scratch folder, so the bundled index answers.
  env: { ...process.env, HACKTRICKS_OFFLINE: "1", HACKTRICKS_CACHE_DIR: scratchCache("cost") } as Record<string, string>,
});
const client = new Client({ name: "cost", version: "0.0.1" });
await client.connect(transport);

/** The characters a call returns. */
async function chars(name: string, args: Record<string, unknown>): Promise<number> {
  const result = await client.callTool({ name, arguments: args });
  const texts = (result.content as { text?: string }[]).map((c) => c.text ?? "");
  if (result.isError) throw new Error(`${name} was not answered for ${JSON.stringify(args)}: ${texts.join("\n").slice(0, 200)}`);
  return texts.reduce((n, text) => n + text.length, 0);
}
const count = (n: number) => Math.round(n).toLocaleString("en-US");
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
/** The value that half the entries do not exceed. */
const median = (xs: number[]): number => sorted(xs)[Math.floor(xs.length / 2)];
/** The value that nine entries in ten do not exceed. */
const ninth = (xs: number[]): number => sorted(xs)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))];
const all = (byBook: Record<string, number[]>): number[] => Object.values(byBook).flat();
const line = (what: string, xs: number[], note: string): void =>
  console.log(
    `${what.padEnd(20)} median ${count(median(xs))}; nine in ten under ${count(ninth(xs))}; ${xs.length.toLocaleString("en-US")} reads (${note})`,
  );
const perBook = (byBook: Record<string, number[]>): string =>
  `main book ${count(median(byBook.hacktricks ?? [0]))}, Cloud book ${count(median(byBook["hacktricks-cloud"] ?? [0]))}`;

// A search of five hits, for each question of the scenarios that names the technique.
const searches: number[] = [];
for (const query of questions) searches.push(await chars("hacktricks_search", { query, limit: 5 }));
console.log(
  `a search of five hits: average ${count(searches.reduce((a, b) => a + b, 0) / searches.length)} characters over ${searches.length} questions that name the technique (median ${count(median(searches))})`,
);

const outline: Record<string, number[]> = {};
const section: Record<string, number[]> = {};
const page: Record<string, number[]> = {};
const pageOverSection: number[] = [];
for (const p of pages) {
  const args = { path: p.path, book: p.book };
  (outline[p.book] ??= []).push(await chars("hacktricks_get_page", { ...args, outlineOnly: true }));
  (page[p.book] ??= []).push(p.content.length);
  // The section in the middle of a page by length, among those of level 2 or
  // deeper whose name the page uses once, so that `section` reads that one.
  const headings = (JSON.parse(p.outline) as Heading[]).filter((h) => h.level >= 2);
  const names = headings.map((h) => plainText(h.text));
  const namedOnce = headings.filter((_h, i) => names.indexOf(names[i]) === i && names.lastIndexOf(names[i]) === i);
  if (namedOnce.length < 2) continue;
  const byLength = sectionLengths(p.content, namedOnce)
    .map((n, i) => [n, i] as const)
    .sort((a, b) => a[0] - b[0]);
  const middle = namedOnce[byLength[Math.floor(byLength.length / 2)][1]];
  const read = await chars("hacktricks_get_page", { ...args, section: middle.text });
  (section[p.book] ??= []).push(read);
  pageOverSection.push(p.content.length / read);
}

line("a whole page", all(page), perBook(page));
line("a page's outline", all(outline), perBook(outline));
line("a section", all(section), perBook(section));
console.log(
  `a page over that section: median ${median(pageOverSection).toFixed(1)} times; a tenth of the pages under ${sorted(pageOverSection)[Math.floor(pageOverSection.length * 0.1)].toFixed(1)} times`,
);

await client.close();
db.close();
