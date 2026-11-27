/**
 * SQLite FTS5 index layer. Shared by the sync indexer (write) and the MCP
 * server (read). Uses node:sqlite — zero native dependencies.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
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
 * Function words and chat filler. They carry no topic, and requiring every word
 * of a question lets long hub pages crowd out the page named after the
 * technique, so they are dropped from queries long enough to contain them.
 *
 * Deliberately absent: words that can be a topic of their own, such as
 * "use" (use-after-free), "find" (the command), "make" or "at".
 */
export const STOPWORDS = new Set(
  (
    "a an the and or not of in on to from with by as for if then than so up out about into " +
    "is are was were be been being am do does did done have has had will would could should can " +
    "may might must shall i me my mine we us our you your he she it its they them their " +
    "this that these those there here what which who whom whose when where why how " +
    "best way ways easily quickly please need want help via step steps"
  ).split(" "),
);

/** Split a free-text query into the terms that carry meaning. */
function queryTerms(query: string): string[] {
  const all = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\w.-]/g, ""))
    .filter((t) => t.length > 0);
  // Short queries are already keywords, and every word may matter in them
  // ("use after free"). Filler only creeps into longer ones.
  const meaningful = all.length > 3 ? all.filter((t) => !STOPWORDS.has(t.toLowerCase())) : all;
  return meaningful.length > 0 ? meaningful : all;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** FTS5 match for one term: the term itself, or an abbreviation plus its expansion. */
function termExpr(term: string): string {
  const alias = ALIASES[term.toLowerCase()];
  return alias ? `(${quote(term)} OR ${alias.split(" ").map(quote).join(" OR ")})` : quote(term);
}

const pageCounts = new WeakMap<DatabaseSync, number>();
function pageCount(db: DatabaseSync): number {
  let n = pageCounts.get(db);
  if (n === undefined) {
    n = (db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number }).n;
    pageCounts.set(db, n);
  }
  return n;
}

// Title and path with separators folded to spaces. A term is credited when a
// word in there starts with it, so "string" matches "strings" while "nc" no
// longer matches "function".
const NAME_SQL =
  "lower(replace(replace(replace(replace(replace(replace(p.title || ' ' || p.path, '/', ' '), '-', ' '), '_', ' '), '.', ' '), '(', ' '), ')', ' '))";
const TERM_IN_NAME_SQL = `' ' || ${NAME_SQL} || ' ' LIKE '% ' || ? || '%'`;

const namingCounts = new WeakMap<DatabaseSync, Map<string, number>>();
/** How many pages have each of these words starting a word in its title or path. */
function pagesNaming(db: DatabaseSync, words: string[]): number {
  let counts = namingCounts.get(db);
  if (!counts) namingCounts.set(db, (counts = new Map()));
  const key = words.join(" ");
  let n = counts.get(key);
  if (n === undefined) {
    n = (
      db
        .prepare(`SELECT count(*) AS n FROM pages p WHERE ${words.map(() => TERM_IN_NAME_SQL).join(" AND ")}`)
        .get(...words) as { n: number }
    ).n;
    counts.set(key, n);
  }
  return n;
}

/** A candidate row: a hit before its snippet is computed. */
type Candidate = Omit<SearchHit, "snippet"> & { boost: number; relevance: number };

/**
 * A term found in at most this fraction of the pages is treated as specific.
 * Containing the specific terms of a query is what earns the match bonus:
 * hub pages contain every common word anyway, so matching those says nothing.
 */
const SPECIFIC_FRACTION = 0.2;

/**
 * How likely a page about a term is to name it in its title or path. Name
 * credit is a likelihood ratio on it (see searchPages): each query term a page
 * names is worth ln(NAMING_RATE / share of pages naming it), each term it does
 * not name costs ln(1 / (1 - NAMING_RATE)).
 */
const NAMING_RATE = 0.6;

/**
 * How much holding every specific query term is worth, on the same scale as
 * name credit: as much as naming a term that about one page in 250 names.
 * Lower lets a page whose title carries a rare word win while missing an
 * incidental one; higher favours pages that contain all the specific words.
 * Measured against tests/scenarios.json (scripts/eval-strategies.ts), where
 * 4 to 6 land within two scenarios of each other.
 */
const MATCH_BONUS = 5;
/** How many candidates to consider per pool; only `limit` are returned. */
const POOL = 50;

/**
 * Rank pages for a free-text query.
 *
 * 1. Drop filler words, so a typed question behaves like the keywords in it.
 * 2. Collect two pools by text relevance: pages that contain every specific
 *    term, and pages that contain any term. A question often carries an
 *    incidental word ("bug") that the page named after the technique does not
 *    use, so matching everything is not required of the best answer.
 * 3. Rank the combined pool by name credit, a likelihood ratio on how few
 *    pages name each query term in their title or path, plus a bonus for
 *    holding every specific term. That puts the page named after the technique
 *    above hub pages that merely contain the words.
 *
 * Measured by scripts/eval-strategies.ts; the numbers that justified each step
 * are in docs/development.md.
 */
export function searchPages(
  db: DatabaseSync,
  query: string,
  category: string | undefined,
  limit: number,
): SearchHit[] {
  // A term absent from the index can neither match nor say anything about a page.
  // Its rarity is judged as typed: "ssrf" stays specific even though its
  // expansion includes words as common as "server".
  const terms = queryTerms(query)
    .map((term) => {
      const own = pagesMatching(db, quote(term));
      return { term, pages: own > 0 ? own : pagesMatching(db, termExpr(term)) };
    })
    .filter((t) => t.pages > 0);
  if (terms.length === 0) return [];
  const total = pageCount(db);

  // Name credit, reported per term. A page about a term usually names it, so a
  // term is worth more in a title the fewer pages name it ("capabilities" is
  // in hundreds of page bodies but a handful of titles). An abbreviation counts
  // by its own spelling first ("privesc" outranks the common words it expands
  // to), and a term with separators needs all of its parts ("ld.so.conf").
  const creditSql: string[] = [];
  const creditParams: (string | number)[] = [];
  terms.forEach(({ term }, i) => {
    const alias = ALIASES[term.toLowerCase()];
    const spellings = alias ? [term, ...alias.split(" ")].map((word) => [word]) : [term.split(/[^\w]+/).filter(Boolean)];
    const weighted = spellings
      .map((words) => ({ words, naming: pagesNaming(db, words) }))
      .map((s) => ({ ...s, weight: s.naming > 0 ? Math.log((NAMING_RATE * total) / s.naming) : 0 }))
      .filter((s) => s.weight > 0)
      .sort((a, b) => b.weight - a.weight);
    creditParams.push(...weighted.flatMap((s) => [...s.words, s.weight]));
    // A term no page names can earn no credit anywhere.
    creditSql.push(
      weighted.length === 0
        ? `0 AS c${i}`
        : `(CASE ${weighted.map((s) => `WHEN ${s.words.map(() => TERM_IN_NAME_SQL).join(" AND ")} THEN ?`).join(" ")} ELSE 0 END) AS c${i}`,
    );
  });

  // Each query term a page does not name counts against it, so a title that
  // covers the query beats one naming a single rare word of it.
  const creditOf = (row: Record<string, SQLOutputValue>): number => {
    let credit = Math.log(1 - NAMING_RATE) * terms.length;
    for (let i = 0; i < terms.length; i++) credit += Number(row[`c${i}`]);
    return credit;
  };

  // Snippets are the expensive part of a row, so candidates are fetched without
  // them and computed only for the rows returned. Those that hold every
  // specific term are also taken by name credit, not just by relevance: a long
  // canonical page can rank low on relevance (bm25) while clearly naming the
  // topic.
  const candidates = (expr: string, alsoByCredit = false): Candidate[] => {
    const select = (order: string) => `
      SELECT p.page_id, p.path, p.title, p.category, p.url,
             bm25(pages_fts, 10.0, 8.0, 5.0, 1.0) AS relevance, ${creditSql.join(", ")}
      FROM pages_fts JOIN pages p ON p.page_id = pages_fts.rowid
      WHERE pages_fts MATCH ?
      ${category ? "AND lower(p.category) LIKE lower(?)" : ""}
      ORDER BY ${order}
      LIMIT ?`;
    // Bound in the order the placeholders appear in the SQL text.
    const params: (string | number)[] = [...creditParams, expr];
    if (category) params.push(`%${category}%`);
    params.push(POOL);
    const toHit = (row: Record<string, SQLOutputValue>): Candidate => ({
      page_id: Number(row.page_id),
      path: String(row.path),
      title: String(row.title),
      category: String(row.category),
      url: String(row.url),
      relevance: Number(row.relevance),
      boost: creditOf(row),
    });
    const byRelevance = db.prepare(select("relevance")).all(...params).map(toHit);
    if (!alsoByCredit) return byRelevance;
    const seen = new Set(byRelevance.map((h) => h.page_id));
    const byCredit = db
      .prepare(select(`(${creditSql.map((_, i) => `(c${i})`).join(" + ")}) DESC`))
      .all(...params)
      .map(toHit);
    return [...byRelevance, ...byCredit.filter((h) => !seen.has(h.page_id))];
  };

  const anyExpr = terms.map((t) => termExpr(t.term)).join(" OR ");
  const specific = terms.filter((t) => t.pages <= total * SPECIFIC_FRACTION);
  const complete =
    specific.length > 0 ? candidates(specific.map((t) => termExpr(t.term)).join(" AND "), true) : [];
  const held = new Set(complete.map((h) => h.page_id));
  const pool = [
    ...complete.map((hit, rank) => ({ hit, rank, score: MATCH_BONUS + hit.boost })),
    ...candidates(anyExpr)
      .filter((hit) => !held.has(hit.page_id))
      .map((hit, rank) => ({ hit, rank, score: hit.boost })),
  ];
  // Ties go to the better text relevance (bm25 is lower for better matches).
  const ranked = pool
    .sort((a, b) => b.score - a.score || a.hit.relevance - b.hit.relevance || a.rank - b.rank)
    .slice(0, limit);
  if (ranked.length === 0) return [];

  const snippetSql = `
    SELECT p.page_id, snippet(pages_fts, 3, '**', '**', ' … ', 24) AS snippet
    FROM pages_fts JOIN pages p ON p.page_id = pages_fts.rowid
    WHERE pages_fts MATCH ? AND p.page_id IN (${ranked.map(() => "?").join(", ")})`;
  const snippets = new Map(
    (db.prepare(snippetSql).all(anyExpr, ...ranked.map((r) => r.hit.page_id)) as { page_id: number; snippet: string }[]).map(
      (row) => [row.page_id, row.snippet],
    ),
  );
  return ranked.map(({ hit: { boost, relevance, ...hit } }) => ({
    ...hit,
    snippet: snippets.get(hit.page_id) ?? "",
  }));
}

function pagesMatching(db: DatabaseSync, expr: string): number {
  return (db.prepare("SELECT count(*) AS n FROM pages_fts WHERE pages_fts MATCH ?").get(expr) as { n: number })
    .n;
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
