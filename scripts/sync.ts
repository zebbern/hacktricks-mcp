/**
 * Sync the HackTricks books (src/books.ts) with upstream and rebuild the search index.
 *
 * 1. Resolve each book's master SHA via `git ls-remote` (no clone needed)
 * 2. Skip the rebuild entirely if data/meta.json already matches those SHAs
 * 3. Download each book's tarball and index every .md under src/ into one
 *    database, tagged with its book, plus the permission data of a book that
 *    has it (src/permissions.ts). Writes:
 *    - data/hacktricks.db  (SQLite FTS5)
 *    - data/toc.json       (each book's SUMMARY.md tree, keyed by book id)
 *    - data/meta.json      (upstream SHAs, sync time, page count, index schema)
 */
import { execFileSync } from "node:child_process";
import { extract } from "tar";
import { parse as parseYaml } from "yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BOOKS, sourceUrl, wikiUrl, type Book } from "../src/books.js";
import { INDEX_SCHEMA, createDb, insertPage, insertPermissionData } from "../src/db.js";
import { cleanMarkdown, extractOutline } from "../src/markdown.js";
import {
  combinationRows,
  escalationRows,
  PROVIDERS,
  riskRows,
  ruleRows,
  type CombinationRow,
  type EscalationRow,
  type RiskRow,
  type RuleRow,
} from "../src/permissions.js";
import { parseSummary, pruneToc, type TocNode } from "../src/toc.js";

type PermissionData = { risk: RiskRow[]; combinations: CombinationRow[]; escalations: EscalationRow[]; rules: RuleRow[] };

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(PKG_ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "hacktricks.db");
const META_PATH = path.join(DATA_DIR, "meta.json");
const TOC_PATH = path.join(DATA_DIR, "toc.json");

function upstreamSha(book: Book): string {
  const out = execFileSync("git", ["ls-remote", `https://github.com/${book.repository}.git`, "refs/heads/master"], {
    encoding: "utf8",
  }).trim();
  const sha = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected ls-remote output: ${out}`);
  return sha;
}

async function downloadTarball(book: Book, sha: string, dest: string): Promise<void> {
  const url = `https://codeload.github.com/${book.repository}/tar.gz/${sha}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Tarball download failed: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function pageTitle(content: string, fallback: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(content);
  return m ? m[1].replace(/[📌🔥⭐️🛠️🔍🎯]/gu, "").trim() : fallback;
}

/**
 * Upstream keeps "(former URL)" pages that only say where a section moved to.
 * They carry the title of the page they point to and are shorter, so they
 * outranked it; the page they point to is indexed in its own right. Longer
 * pages with that label still hold content and are kept.
 */
const REDIRECT_MAX_CHARS = 2000;

/** Index every page of one book into the shared database. Returns its SUMMARY.md tree and page count. */
function indexBook(book: Book, srcDir: string, db: DatabaseSync): { tree: TocNode[]; indexed: number } {
  // Parse the table of contents
  const summary = fs.readFileSync(path.join(srcDir, "SUMMARY.md"), "utf8");
  const { tree, pages } = parseSummary(summary);
  console.log(`${book.title}: SUMMARY.md lists ${pages.size} pages`);

  const files = walkMarkdown(srcDir).filter((f) => path.basename(f) !== "SUMMARY.md");
  const indexed = new Set<string>();
  for (const file of files) {
    const rel = path.relative(srcDir, file).split(path.sep).join("/");
    const raw = fs.readFileSync(file, "utf8");
    const content = cleanMarkdown(raw);
    if (content.length < 40) continue; // skip stubs
    const metaEntry = pages.get(rel);
    const title = metaEntry?.title ?? pageTitle(content, path.basename(rel, ".md"));
    if (/\(former URL\)\s*$/i.test(title) && content.length < REDIRECT_MAX_CHARS) continue;
    insertPage(db, {
      book: book.id,
      path: rel,
      title,
      category: metaEntry?.category ?? rel.split("/")[0],
      url: sourceUrl(book, rel),
      // Only the pages the table of contents lists are published on the wiki.
      wiki: metaEntry ? wikiUrl(book, rel) : "",
      outline: JSON.stringify(extractOutline(content)),
      content,
    });
    indexed.add(rel);
  }
  // The table of contents lists what the index holds, not what was skipped.
  return { tree: pruneToc(tree, (node) => !node.path || indexed.has(node.path)), indexed: indexed.size };
}

/**
 * Index a book's permission data for hacktricks_cloud_permissions, when the
 * book has it: src/permission-categorizations (a rated list per provider plus
 * combination rules) and src/privilege-escalation-paths (one file per
 * service). Files starting with "_" are the book's own notes and exclusions.
 * Returns the number of escalation techniques, or 0 for a book without the data.
 */
function indexPermissions(srcDir: string, db: DatabaseSync): number {
  const escalationDir = path.join(srcDir, "privilege-escalation-paths");
  if (!fs.existsSync(escalationDir)) return 0;
  const readYaml = (file: string) => parseYaml(fs.readFileSync(file, "utf8"));

  const data: PermissionData = { risk: [], combinations: [], escalations: [], rules: [] };
  for (const provider of PROVIDERS) {
    const categories = readYaml(path.join(srcDir, "permission-categorizations", `${provider}.yaml`));
    data.risk.push(...riskRows(provider, categories));
    data.combinations.push(...combinationRows(provider, categories.combinations));
    data.rules.push(...ruleRows(provider, categories.rules));

    const dir = path.join(escalationDir, provider);
    const techniques = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".yaml") && !file.startsWith("_"))
      .flatMap((file) => readYaml(path.join(dir, file)) ?? []);
    data.escalations.push(...escalationRows(provider, techniques));
  }
  insertPermissionData(db, data);
  return data.escalations.length;
}

async function main() {
  const shas = new Map(BOOKS.map((book) => [book.id, upstreamSha(book)] as const));
  for (const book of BOOKS) console.log(`${book.title} master: ${shas.get(book.id)}`);

  const prev = fs.existsSync(META_PATH) ? JSON.parse(fs.readFileSync(META_PATH, "utf8")) : null;
  if (
    prev?.schema === INDEX_SCHEMA &&
    BOOKS.every((book) => prev.books?.[book.id] === shas.get(book.id)) &&
    fs.existsSync(DB_PATH)
  ) {
    console.log("Index already up to date — nothing to do.");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hacktricks-"));
  try {
    // Build a fresh index, then atomically swap it in
    const tmpDb = path.join(tmp, "hacktricks.db");
    const db = createDb(tmpDb);
    const toc: Record<string, TocNode[]> = {};
    let indexed = 0;
    for (const book of BOOKS) {
      const sha = shas.get(book.id)!;
      const tarball = path.join(tmp, `${book.id}.tar.gz`);
      await downloadTarball(book, sha, tarball);
      console.log(`Extracting tarball (${(fs.statSync(tarball).size / 1e6).toFixed(1)} MB)`);
      await extract({ file: tarball, cwd: tmp });

      const srcDir = path.join(tmp, `${book.repository.split("/")[1]}-${sha}`, "src");
      if (!fs.existsSync(srcDir)) throw new Error(`Expected ${srcDir} in tarball`);
      const result = indexBook(book, srcDir, db);
      toc[book.id] = result.tree;
      indexed += result.indexed;
      console.log(`${book.title}: indexed ${result.indexed} pages`);
      const techniques = indexPermissions(srcDir, db);
      if (techniques > 0) console.log(`${book.title}: indexed ${techniques} escalation techniques`);
    }
    db.close();

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(tmpDb, DB_PATH);
    fs.writeFileSync(TOC_PATH, JSON.stringify(toc, null, 1));
    fs.writeFileSync(
      META_PATH,
      JSON.stringify(
        {
          schema: INDEX_SCHEMA,
          books: Object.fromEntries(shas),
          syncedAt: new Date().toISOString(),
          pageCount: indexed,
          dbBytes: fs.statSync(DB_PATH).size,
        },
        null,
        2,
      ),
    );
    console.log(
      `Indexed ${indexed} pages -> data/hacktricks.db (${(fs.statSync(DB_PATH).size / 1e6).toFixed(1)} MB)`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
