/**
 * Search-quality eval: run tests/queries.json against the built index and
 * report how often an expected page lands in the top-5 results.
 * Exits 1 below the pass threshold (default 80%).
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDbReadonly, searchPages } from "../src/db.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.join(PKG_ROOT, "data", "hacktricks.db");
const QUERIES_PATH = path.join(PKG_ROOT, "tests", "queries.json");
const THRESHOLD = 0.8;

interface Fixture {
  query: string;
  expectPath: string;
  category?: string;
}

const fixtures: Fixture[] = JSON.parse(fs.readFileSync(QUERIES_PATH, "utf8"));
const db = openDbReadonly(DB_PATH);

let passed = 0;
const failures: string[] = [];

for (const f of fixtures) {
  const hits = searchPages(db, f.query, f.category, 5);
  const ok = hits.some((h) => h.path.includes(f.expectPath));
  if (ok) passed++;
  else {
    failures.push(
      `✗ "${f.query}" -> expected ${f.expectPath}, got: [${hits.map((h) => h.path).join(", ") || "no hits"}]`,
    );
  }
}

const rate = passed / fixtures.length;
console.log(`\nEval: ${passed}/${fixtures.length} passed (${(rate * 100).toFixed(0)}%), threshold ${THRESHOLD * 100}%`);
if (failures.length > 0) console.log(failures.join("\n"));
db.close();
process.exit(rate >= THRESHOLD ? 0 : 1);
