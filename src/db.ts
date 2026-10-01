/**
 * SQLite FTS5 index layer. Shared by the sync indexer (write) and the MCP
 * server (read). Uses node:sqlite — zero native dependencies.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface PageRow {
  page_id: number;
  path: string;
  title: string;
  category: string;
  url: string;
  outline: string; // JSON-serialized Heading[]
  content: string;
}

export interface SearchHit {
  page_id: number;
  path: string;
  title: string;
  category: string;
  url: string;
  snippet: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  page_id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  outline TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, path, category, content,
  content='pages', content_rowid='page_id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, path, category, content)
  VALUES (new.page_id, new.title, new.path, new.category, new.content);
END;
`;

export function createDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

export function openDbReadonly(dbPath: string): DatabaseSync {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `HackTricks index not found at ${dbPath}. Run "npm run sync" to build it, or reinstall the package.`,
    );
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function insertPage(
  db: DatabaseSync,
  page: Omit<PageRow, "page_id">,
): void {
  db.prepare(
    `INSERT INTO pages (path, title, category, url, outline, content)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(page.path, page.title, page.category, page.url, page.outline, page.content);
}

/**
 * Common security abbreviations agents and users actually type.
 * Expanded before FTS query construction so "privesc" matches
 * "privilege escalation" in page content.
 */
const ALIASES: Record<string, string> = {
  privesc: "privilege escalation",
  sqli: "sql injection",
  rce: "remote code execution",
  lfi: "local file inclusion",
  rfi: "remote file inclusion",
  xss: "cross site scripting",
  csrf: "cross site request forgery",
  ssrf: "server side request forgery",
  ssti: "server side template injection",
  xxe: "xml external entity",
  idor: "insecure direct object reference",
  lpe: "local privilege escalation",
  privescalation: "privilege escalation",
  deserial: "deserialization",
  revshell: "reverse shell",
};

/**
 * Turn a free-text query into a safe FTS5 MATCH expression.
 * Every term is double-quoted (escaping inner quotes) so user input can never
 * break the query syntax. Multi-term queries try AND first (precision), then
 * fall back to OR (recall) if AND yields nothing.
 */
function buildFtsQuery(query: string, op: "AND" | "OR"): string | null {
  const rawTerms = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\w.-]/g, ""))
    .filter((t) => t.length > 0);
  // Each term becomes a quoted match; known abbreviations become an OR-group
  // of the abbreviation plus its expansion.
  const groups = rawTerms.map((t) => {
    const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const alias = ALIASES[t.toLowerCase()];
    if (!alias) return quote(t);
    return `(${quote(t)} OR ${alias.split(" ").map(quote).join(" OR ")})`;
  });
  if (groups.length === 0) return null;
  return groups.join(` ${op} `);
}

export function searchPages(
  db: DatabaseSync,
  query: string,
  category: string | undefined,
  limit: number,
): SearchHit[] {
  const rawTerms = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\w.-]/g, ""))
    .filter((t) => t.length > 0);
  // Deterministic boost: count query terms (or their alias expansions) that
  // literally appear in the page title/path. Ranks the canonical page for a
  // topic above pages that merely mention the terms often.
  const boostSql = rawTerms
    .map((t) => {
      const variants = [t, ...(ALIASES[t.toLowerCase()]?.split(" ") ?? [])];
      const cond = variants
        .map((v) => `lower(p.title || ' ' || p.path) LIKE '%' || ? || '%'`)
        .join(" OR ");
      return `(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
    })
    .join(" + ");
  const boostParams = rawTerms.flatMap((t) => [
    ...[t, ...(ALIASES[t.toLowerCase()]?.split(" ") ?? [])],
  ]);

  const run = (op: "AND" | "OR"): SearchHit[] => {
    const ftsQuery = buildFtsQuery(query, op);
    if (!ftsQuery) return [];
    const sql = `
      SELECT p.page_id, p.path, p.title, p.category, p.url,
             snippet(pages_fts, 3, '**', '**', ' … ', 24) AS snippet
      FROM pages_fts JOIN pages p ON p.page_id = pages_fts.rowid
      WHERE pages_fts MATCH ?
      ${category ? "AND lower(p.category) LIKE lower(?)" : ""}
      ORDER BY ${rawTerms.length > 0 ? `(${boostSql}) DESC,` : ""} bm25(pages_fts, 10.0, 8.0, 5.0, 1.0)
      LIMIT ?`;
    const params: (string | number)[] = [ftsQuery];
    if (category) params.push(`%${category}%`);
    params.push(...boostParams, limit);
    return db.prepare(sql).all(...params) as unknown as SearchHit[];
  };

  const andResults = run("AND");
  if (andResults.length > 0 || rawTerms.length <= 1) return andResults;
  return run("OR");
}

export function getPage(db: DatabaseSync, pagePath: string): PageRow | null {
  const row = db
    .prepare(`SELECT * FROM pages WHERE path = ?`)
    .get(pagePath) as unknown as PageRow | undefined;
  if (row) return row;
  // Convenience: allow suffix matches like "kerberoast" or "ntlm/README.md"
  const like = db
    .prepare(`SELECT * FROM pages WHERE path LIKE ? ORDER BY length(path) LIMIT 1`)
    .get(`%${pagePath.replace(/%/g, "")}%`) as unknown as PageRow | undefined;
  return like ?? null;
}

export function listCategories(db: DatabaseSync): { category: string; pages: number }[] {
  return db
    .prepare(
      `SELECT category, count(*) AS pages FROM pages GROUP BY category ORDER BY pages DESC`,
    )
    .all() as unknown as { category: string; pages: number }[];
}
