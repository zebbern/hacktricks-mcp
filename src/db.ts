/**
 * SQLite FTS5 index layer. Shared by the sync indexer (write) and the MCP
 * server (read). Uses node:sqlite — zero native dependencies.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { CombinationRow, EscalationRow, RiskRow, RuleRow } from "./permissions.js";

export interface PageRow {
  page_id: number;
  book: string;
  path: string;
  title: string;
  category: string;
  url: string;
  wiki: string; // rendered page on the public wiki; empty when the book's table of contents does not list it
  outline: string; // JSON-serialized Heading[]
  content: string;
}

export interface SearchHit {
  page_id: number;
  book: string;
  path: string;
  title: string;
  category: string;
  url: string;
  wiki: string;
  chars: number; // page length, so a caller can choose between a whole read and the outline
  snippet: string;
}

/**
 * Layout of the index files in data/. Bump it when a rebuild must reach every
 * index although upstream has not moved: a layout change, or a change in how
 * the indexer turns pages into rows (this file, src/toc.ts, src/markdown.ts,
 * src/permissions.ts).
 * The sync script then rebuilds, and a server ignores indexes built for another
 * number (src/refresh.ts).
 */
export const INDEX_SCHEMA = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  page_id INTEGER PRIMARY KEY,
  book TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  wiki TEXT NOT NULL DEFAULT '',
  outline TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  UNIQUE (book, path)
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

-- HackTricks Cloud's permission data (src/permissions.ts), for hacktricks_cloud_permissions.
CREATE TABLE IF NOT EXISTS permission_risk (
  provider TEXT NOT NULL,
  permission TEXT NOT NULL,
  severity TEXT NOT NULL,
  PRIMARY KEY (provider, permission)
);
CREATE TABLE IF NOT EXISTS permission_combination (
  provider TEXT NOT NULL,
  severity TEXT NOT NULL,
  permissions TEXT NOT NULL             -- JSON list; every permission must be held
);
CREATE TABLE IF NOT EXISTS escalation (
  provider TEXT NOT NULL,
  id TEXT NOT NULL,
  service TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence TEXT NOT NULL,
  target TEXT NOT NULL,                  -- JSON { kind, scope, outcome }
  source TEXT NOT NULL,                  -- <page path>#<anchor>
  requires TEXT NOT NULL,                -- JSON, as the book writes it
  needs TEXT NOT NULL,                   -- JSON list of the permissions named
  conditions TEXT NOT NULL,              -- JSON list of sentences
  blockers TEXT NOT NULL,                -- JSON list of identifiers
  mitigation TEXT NOT NULL,
  PRIMARY KEY (provider, id)
);
CREATE TABLE IF NOT EXISTS permission_rule (
  provider TEXT NOT NULL,
  position INTEGER NOT NULL,             -- the first rule that matches wins
  rule TEXT NOT NULL,                    -- JSON, as the book writes it
  PRIMARY KEY (provider, position)
);
`;

export function createDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

/** Fill the permission tables with what src/permissions.ts made of HackTricks Cloud's data. */
export function insertPermissionData(db: DatabaseSync, data: {
  risk: RiskRow[];
  combinations: CombinationRow[];
  escalations: EscalationRow[];
  rules: RuleRow[];
}): void {
  const inTransaction = <T>(run: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  inTransaction(() => {
    const risk = db.prepare("INSERT INTO permission_risk (provider, permission, severity) VALUES (?, ?, ?)");
    for (const row of data.risk) risk.run(row.provider, row.permission, row.severity);
    const combination = db.prepare(
      "INSERT INTO permission_combination (provider, severity, permissions) VALUES (?, ?, ?)",
    );
    for (const row of data.combinations) combination.run(row.provider, row.severity, JSON.stringify(row.permissions));
    const escalation = db.prepare(
      `INSERT INTO escalation (provider, id, service, title, summary, severity, confidence, target, source,
                               requires, needs, conditions, blockers, mitigation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of data.escalations) {
      escalation.run(
        row.provider, row.id, row.service, row.title, row.summary, row.severity, row.confidence, row.target,
        row.source, row.requires, row.needs, row.conditions, row.blockers, row.mitigation,
      );
    }
    const rule = db.prepare("INSERT INTO permission_rule (provider, position, rule) VALUES (?, ?, ?)");
    for (const row of data.rules) rule.run(row.provider, row.position, row.rule);
  });
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
    `INSERT INTO pages (book, path, title, category, url, wiki, outline, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(page.book, page.path, page.title, page.category, page.url, page.wiki, page.outline, page.content);
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

/** Terms beyond this number are not searched: each costs a lookup, a question has a dozen and a pasted page has thousands. */
export const MAX_TERMS = 32;

/**
 * The words of a free-text query, each once. Whitespace separates them, and so
 * do the separators of a permission or of a path ("iam:PassRole", "a/b.md"),
 * because that is how the index tokenizes pages: "iamPassRole" is in none.
 */
export function searchTerms(query: string): string[] {
  const all = query
    .split(/[\s:/\\]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}._-]/gu, ""))
    .filter((t) => t.length > 0);
  // Short queries are already keywords, and every word may matter in them
  // ("use after free"). Filler only creeps into longer ones.
  const meaningful = all.length > 3 ? all.filter((t) => !STOPWORDS.has(t.toLowerCase())) : all;
  const kept = meaningful.length > 0 ? meaningful : all;
  const seen = new Set<string>();
  return kept.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Endings dropped from a query word before it is looked for in titles and
 * paths, applied in turn and only while at least `minStem` letters remain.
 * A title uses one word form and a question another ("Privilege Escalation"
 * against "escalate privileges"); the full-text match is stemmed, and without
 * this the title match was not: "escalate" never matched "escalation".
 */
const NAME_ENDINGS: [ending: string, replacement: string, minStem: number][] = [
  ["sses", "ss", 4],
  ["ies", "", 4],
  ["es", "", 4],
  ["s", "", 3],
  ["ation", "", 4],
  ["ment", "", 4],
  ["ing", "", 4],
  ["ate", "", 4],
  ["ed", "", 4],
];

/** The stem prefix a word is matched by in titles and paths: "escalating" gives "escalat". */
function nameKey(word: string): string {
  let w = word.toLowerCase();
  for (let rule = NAME_ENDINGS.find(([ending, , minStem]) => w.endsWith(ending) && w.length - ending.length >= minStem); rule; ) {
    w = w.slice(0, w.length - rule[0].length) + rule[1];
    rule = NAME_ENDINGS.find(([ending, , minStem]) => w.endsWith(ending) && w.length - ending.length >= minStem);
  }
  return w;
}

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
// word in there starts with its stem (NAME_ENDINGS), so "escalate" matches
// "escalation" and "string" matches "strings", while "nc" does not match
// "function".
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
 * A term found in at least this fraction of the pages takes no part in name
 * credit (it gains a page nothing and costs it nothing), with one exception
 * below. Name rarity alone overrates such words: two thirds of the pages
 * contain "id" but only 42 titles name it, so it was worth as much as a
 * technique name, and "Az - Entra ID Logs" outranked "Az - EntraID Privesc"
 * for a question about privilege escalation in Entra ID.
 */
const NAME_SHARE = 0.5;

/**
 * The exception: a very common term still counts when the pages that contain
 * it name it in their title or path at least this often, because then it is
 * what pages are about. Pages that contain "id" name it 2% of the time. Pages
 * that contain "post" name it 27% of the time, although "post" is in 61% of
 * the pages because Cloud pages repeat their phase names; left out, "S3 post
 * exploitation" returned S3 privesc and enum pages first.
 */
const TITLE_RATE = 0.05;

/**
 * How much holding every specific query term is worth, on the same scale as
 * name credit: as much as naming a term that about one page in 250 names.
 * Lower lets a page whose title carries a rare word win while missing an
 * incidental one; higher favours pages that contain all the specific words.
 * Measured on tests/scenarios.json with scripts/eval-workflow.ts: every value
 * from 4 to 10 ends with the same questions found by the route the skill
 * gives, and the rest moves by a question or two either way.
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
 *    pages name each query term in their title or path (by stem, and only
 *    for terms that are not in half of the pages, see NAME_SHARE), plus a
 *    bonus for holding every specific term. That puts the page named after
 *    the technique above hub pages that merely contain the words.
 *
 * Measured by scripts/eval.ts and scripts/eval-workflow.ts; the numbers and
 * the ideas that were rejected are in docs/development.md.
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
  const terms = searchTerms(query)
    .slice(0, MAX_TERMS)
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
  // Terms that are everywhere are left out unless pages that contain them
  // name them often enough to be what the page is about.
  const named = terms.filter(
    (t) => t.pages < total * NAME_SHARE || pagesNaming(db, [nameKey(t.term)]) >= t.pages * TITLE_RATE,
  );
  const creditSql: string[] = [];
  const creditParams: (string | number)[] = [];
  named.forEach(({ term }, i) => {
    const alias = ALIASES[term.toLowerCase()];
    const spellings = alias
      ? [term, ...alias.split(" ")].map((word) => [nameKey(word)])
      : [term.split(/[^\p{L}\p{N}_]+/u).filter(Boolean).map(nameKey)];
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
    let credit = Math.log(1 - NAMING_RATE) * named.length;
    for (let i = 0; i < named.length; i++) credit += Number(row[`c${i}`]);
    return credit;
  };

  // Snippets are the expensive part of a row, so candidates are fetched without
  // them and computed only for the rows returned. Those that hold every
  // specific term are also taken by name credit, not just by relevance: a long
  // canonical page can rank low on relevance (bm25) while clearly naming the
  // topic.
  const candidates = (expr: string, alsoByCredit = false): Candidate[] => {
    const select = (order: string) => `
      SELECT p.page_id, p.book, p.path, p.title, p.category, p.url, p.wiki, length(p.content) AS chars,
             bm25(pages_fts, 10.0, 8.0, 5.0, 1.0) AS relevance${creditSql.length ? `, ${creditSql.join(", ")}` : ""}
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
      book: String(row.book),
      path: String(row.path),
      title: String(row.title),
      category: String(row.category),
      url: String(row.url),
      wiki: String(row.wiki),
      chars: Number(row.chars),
      relevance: Number(row.relevance),
      boost: creditOf(row),
    });
    const byRelevance = db.prepare(select("relevance")).all(...params).map(toHit);
    if (!alsoByCredit) return byRelevance;
    const seen = new Set(byRelevance.map((h) => h.page_id));
    // A query whose every term is too common for name credit has no credit to order by.
    const byCreditOrder = creditSql.length ? `(${creditSql.map((_, i) => `(c${i})`).join(" + ")}) DESC` : "relevance";
    const byCredit = db.prepare(select(byCreditOrder)).all(...params).map(toHit);
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

/** How a path asked for ended: one page, none, or a piece that lies in several paths, which the caller has to tell apart. */
export type PageLookup =
  | { kind: "page"; page: PageRow }
  | { kind: "none" }
  /** `matches` is empty when the piece lies in most pages (`pages` says how many there are): too common to choose from. */
  | { kind: "several"; matches: string[]; total: number; pages: number };

/** A text for a LIKE pattern: `%` is dropped and `_` and `\` lose their meaning. */
const likeText = (s: string) => s.replace(/%/g, "").replace(/[\\_]/g, "\\$&");
const CANDIDATES_SHOWN = 8;
/** A piece of at least this share of all pages lists no paths: there is nothing to choose from. */
const EVERYWHERE = 0.5;

/**
 * Find a page by path. `book` settles the few paths that exist in both books
 * (README.md); without it the main book wins.
 *
 * 1. The path as it is.
 * 2. A whole ending of a path ("ntlm/README.md"), also without its ".md".
 * 3. A piece of a path ("kerberoast"), when exactly one page has it.
 *
 * Something vaguer is not read as one of them, so that the caller never gets a
 * page it did not ask for. It gets the paths that share the piece when there
 * are few enough to choose from ("kerberos" lies in six), and only the count
 * when the piece lies in most paths ("e").
 */
export function lookupPage(db: DatabaseSync, pagePath: string, book?: string): PageLookup {
  const input = pagePath.trim();
  // Every path has a letter or a digit, so ".." or "___" names none.
  if (!input || !/[\p{L}\p{N}]/u.test(input)) return { kind: "none" };
  const only = book ? "AND book = ?" : "";
  const scope = book ? [book] : [];
  const page = (row: unknown) => ({ kind: "page", page: row as PageRow }) as PageLookup;

  const exact = db.prepare(`SELECT * FROM pages WHERE path = ? ${only} ORDER BY book LIMIT 1`).get(input, ...scope);
  if (exact) return page(exact);

  const stem = input.replace(/\.md$/i, "");
  if (stem) {
    const ends = db
      .prepare(
        `SELECT * FROM pages
         WHERE (path = ? OR path = ? OR path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\') ${only}
         ORDER BY length(path), book LIMIT 2`,
      )
      .all(stem, `${stem}.md`, `%/${likeText(stem)}`, `%/${likeText(stem)}.md`, ...scope) as unknown as { path: string }[];
    if (ends.length === 1) return page(ends[0]);
    // "README" without its book means the book's own one, not a chapter's.
    const topLevel = ends.filter((row) => !row.path.includes("/"));
    if (topLevel.length > 0) return page(topLevel[0]);
  }

  // Paths, each once (README.md is in both books). count(*) over () is how many paths contain the piece, not only those listed.
  const pieces = db
    .prepare(
      `SELECT path, count(*) OVER () AS total FROM (SELECT DISTINCT path FROM pages WHERE path LIKE ? ESCAPE '\\' ${only})
       ORDER BY length(path), path LIMIT ?`,
    )
    .all(`%${likeText(input)}%`, ...scope, CANDIDATES_SHOWN + 1) as unknown as { path: string; total: number }[];
  if (pieces.length === 0) return { kind: "none" };
  if (pieces.length === 1) {
    const row = db.prepare(`SELECT * FROM pages WHERE path = ? ${only} ORDER BY book LIMIT 1`).get(pieces[0].path, ...scope);
    if (row) return page(row);
  }
  const pages = pageCount(db);
  return {
    kind: "several",
    matches: pieces[0].total >= pages * EVERYWHERE ? [] : pieces.slice(0, CANDIDATES_SHOWN).map((row) => row.path),
    total: pieces[0].total,
    pages,
  };
}

/** Page counts per book and category, in the order the table of contents lists them. */
export function listCategories(
  db: DatabaseSync,
): { book: string; category: string; pages: number }[] {
  return db
    .prepare(
      `SELECT book, category, count(*) AS pages FROM pages GROUP BY book, category ORDER BY min(page_id)`,
    )
    .all() as unknown as { book: string; category: string; pages: number }[];
}
