/**
 * Sync the HackTricks upstream repo and rebuild the FTS5 index.
 *
 * 1. Resolve upstream master SHA via `git ls-remote` (no clone needed)
 * 2. Skip the rebuild entirely if data/meta.json already matches that SHA
 * 3. Download the tarball, index every .md under src/, write:
 *    - data/hacktricks.db  (SQLite FTS5)
 *    - data/toc.json       (parsed SUMMARY.md tree)
 *    - data/meta.json      (upstream SHA, sync time, page count)
 */
import { execFileSync } from "node:child_process";
import { extract } from "tar";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, insertPage } from "../src/db.js";
import { cleanMarkdown, extractOutline } from "../src/markdown.js";
import { parseSummary } from "../src/toc.js";

const UPSTREAM = "https://github.com/HackTricks-wiki/hacktricks.git";
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(PKG_ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "hacktricks.db");
const META_PATH = path.join(DATA_DIR, "meta.json");
const TOC_PATH = path.join(DATA_DIR, "toc.json");

function upstreamSha(): string {
  const out = execFileSync("git", ["ls-remote", UPSTREAM, "refs/heads/master"], {
    encoding: "utf8",
  }).trim();
  const sha = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected ls-remote output: ${out}`);
  return sha;
}

async function downloadTarball(sha: string, dest: string): Promise<void> {
  const url = `https://codeload.github.com/HackTricks-wiki/hacktricks/tar.gz/${sha}`;
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

async function main() {
  const sha = upstreamSha();
  console.log(`Upstream master: ${sha}`);

  const prev = fs.existsSync(META_PATH) ? JSON.parse(fs.readFileSync(META_PATH, "utf8")) : null;
  if (prev?.upstreamSha === sha && fs.existsSync(DB_PATH)) {
    console.log("Index already up to date — nothing to do.");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hacktricks-"));
  const tarball = path.join(tmp, "hacktricks.tar.gz");
  try {
    await downloadTarball(sha, tarball);
    console.log(`Extracting tarball (${(fs.statSync(tarball).size / 1e6).toFixed(1)} MB)`);
    await extract({ file: tarball, cwd: tmp });

    const srcDir = path.join(tmp, `hacktricks-${sha}`, "src");
    if (!fs.existsSync(srcDir)) throw new Error(`Expected ${srcDir} in tarball`);

    // Parse the table of contents
    const summary = fs.readFileSync(path.join(srcDir, "SUMMARY.md"), "utf8");
    const { tree, pages } = parseSummary(summary);
    console.log(`SUMMARY.md lists ${pages.size} pages`);

    // Build a fresh index, then atomically swap it in
    const tmpDb = path.join(tmp, "hacktricks.db");
    const db = createDb(tmpDb);

    const files = walkMarkdown(srcDir).filter(
      (f) => path.basename(f) !== "SUMMARY.md",
    );
    let indexed = 0;
    for (const file of files) {
      const rel = path.relative(srcDir, file).split(path.sep).join("/");
      const raw = fs.readFileSync(file, "utf8");
      const content = cleanMarkdown(raw);
      if (content.length < 40) continue; // skip stubs/redirect-only pages
      const metaEntry = pages.get(rel);
      const title = metaEntry?.title ?? pageTitle(content, path.basename(rel, ".md"));
      insertPage(db, {
        path: rel,
        title,
        category: metaEntry?.category ?? rel.split("/")[0],
        url: `https://github.com/HackTricks-wiki/hacktricks/blob/master/src/${rel}`,
        outline: JSON.stringify(extractOutline(content)),
        content,
      });
      indexed++;
    }
    db.close();

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(tmpDb, DB_PATH);
    fs.writeFileSync(TOC_PATH, JSON.stringify(tree, null, 1));
    fs.writeFileSync(
      META_PATH,
      JSON.stringify(
        {
          upstreamSha: sha,
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
