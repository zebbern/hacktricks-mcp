# Architecture

How the index is built and kept current. This document owns the pipeline details; the README only states the 3-day cadence.

## Components

```
HackTricks-wiki/hacktricks (master)        HackTricks-wiki/hacktricks-cloud (master)
        |                                          |
        |  tarball per commit SHA (no clone)       |
        v                                          v
scripts/sync.ts
  1. git ls-remote -> one SHA per book
  2. skip if data/meta.json already matches those SHAs and the index layout
  3. download + extract each tarball
  4. parse each src/SUMMARY.md -> toc.json + page metadata
  5. clean markdown (src/markdown.ts)
  6. build one SQLite FTS5 index, each page tagged with its book (src/db.ts)
  7. read the Cloud book's permission lists and escalation catalog into tables (src/permissions.ts)
  8. write data/{hacktricks.db, toc.json, meta.json}
        |
        v
dist/server.js (MCP stdio server)
  reads data/hacktricks.db read-only at startup
  swaps in a newer index from the releases in the background (src/refresh.ts)
```

The books are listed in `src/books.ts`: id, title, GitHub repository and public site. The indexer, the server and the refresh all read that table, so adding a book is one entry.

## Data files

| File | Content | Source of truth |
|---|---|---|
| `data/hacktricks.db` | SQLite DB: one `pages` table + `pages_fts` FTS5 virtual table for all books, and the permission tables | rebuilt by `npm run sync` |
| `data/toc.json` | Each book's table of contents tree, keyed by book id | parsed from each upstream SUMMARY.md |
| `data/meta.json` | `schema`, `books` (upstream SHA per book), `syncedAt`, `pageCount`, `dbBytes` | written by sync |

`meta.json` serves three readers. The sync script compares `books` with upstream to know whether to rebuild, and rebuilds regardless when `schema` differs from `INDEX_SCHEMA` in `src/db.ts`. The server puts `pageCount` and `syncedAt` into its instructions and into the first line of `hacktricks_get_toc`. The runtime refresh reads `schema` and `syncedAt` from a release's copy to decide whether it can use that index and whether it is newer.

Bump `INDEX_SCHEMA` whenever a rebuild must reach every index although upstream has not moved: a layout change, or a change in how pages become rows (`src/db.ts`, `src/toc.ts`, `src/markdown.ts`, `src/permissions.ts`).

## Table of contents parsing

`src/toc.ts` reads the mdBook-style `SUMMARY.md` of each book into a tree of `{ title, path, category, children }`. Three things in upstream's file need care:

- Many entries end in an HTML comment about where their title came from (`<!-- Original navigation label: ... -->`). The parser strips comments first; without that, the 17 annotated entries of the main book were skipped, which left 77 Linux pages under other categories' chapters.
- A heading's words are kept as the category name with their punctuation (`Pentesting CI/CD`, `Hardware/Physical Access`); only the emoji are dropped.
- Entries that link nowhere point at another site. They are pruned from the tree.

The tree then lists only pages the index holds (`pruneToc` in `src/toc.ts`, called by the indexer with the paths it inserted).

## Pages that are left out

At index time `scripts/sync.ts` skips:

- pages shorter than 40 characters after cleaning (stubs);
- pages titled `(former URL)` that are under 2,000 characters. Upstream keeps them so that old links still work; they only say where a section moved to. They carry the title of the page they point to and are shorter, so they outranked that page for every query that matched it (seven pages on 2026-11-27, all in the Cloud book).

`category` is the nearest `#` heading above the entry. Pages the table of contents does not list (`LICENSE.md`, the training banner) fall back to the first folder of their path.

The Cloud book also keeps structured data that is not markdown: its permission lists and escalation catalog. The indexer reads it into tables of their own (see [Permission data](#permission-data)).

## Markdown cleaning (index time)

`src/markdown.ts` removes, in order:

1. `{% hint ... %} ... {% endhint %}` blocks (training banners)
2. single-line `{% ... %}` and `{{ ... }}` directives (includes, templating)
3. image-only lines referencing `.gitbook/assets` (badge art)
4. HTML comments
5. trailing whitespace and 3+ consecutive blank lines

Pages shorter than 40 chars after cleaning are skipped (see above).

## Database schema

```sql
CREATE TABLE pages (
  page_id INTEGER PRIMARY KEY,
  book TEXT NOT NULL,             -- "hacktricks" or "hacktricks-cloud" (src/books.ts)
  path TEXT NOT NULL,             -- repo-relative, e.g. windows-hardening/ntlm/README.md
  title TEXT NOT NULL,            -- from SUMMARY.md, falling back to first H1
  category TEXT NOT NULL,         -- top-level SUMMARY.md section
  url TEXT NOT NULL,              -- GitHub blob URL for the source page
  wiki TEXT NOT NULL DEFAULT '',  -- the page on the public wiki; empty if SUMMARY.md does not list it
  outline TEXT NOT NULL,          -- JSON array of {level, text, line}
  content TEXT NOT NULL,          -- cleaned markdown
  UNIQUE (book, path)
);
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title, path, category, content,
  content='pages', content_rowid='page_id',
  tokenize='porter unicode61'
);
```

An `AFTER INSERT` trigger keeps the FTS table in sync. Ranking details live in [tools.md](tools.md#hacktricks_search).

The permission data fills four tables next to the pages:

```sql
CREATE TABLE permission_risk (       -- a rated permission
  provider TEXT NOT NULL,            -- aws, gcp, azure, k8s
  permission TEXT NOT NULL,
  severity TEXT NOT NULL,            -- critical, high, medium, low
  PRIMARY KEY (provider, permission)
);
CREATE TABLE permission_combination ( -- every permission must be held
  provider TEXT NOT NULL,
  severity TEXT NOT NULL,
  permissions TEXT NOT NULL          -- JSON list
);
CREATE TABLE escalation (            -- one technique of the catalog
  provider TEXT NOT NULL,
  id TEXT NOT NULL,
  service TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence TEXT NOT NULL,
  target TEXT NOT NULL,              -- JSON { kind, scope, outcome }
  source TEXT NOT NULL,              -- <page path>#<anchor>
  requires TEXT NOT NULL,            -- JSON, as the book writes it
  needs TEXT NOT NULL,               -- JSON list of the permissions named
  conditions TEXT NOT NULL,          -- JSON list of sentences
  blockers TEXT NOT NULL,            -- JSON list of identifiers
  mitigation TEXT NOT NULL,
  PRIMARY KEY (provider, id)
);
CREATE TABLE permission_rule (       -- Kubernetes: the first rule that matches wins
  provider TEXT NOT NULL,
  position INTEGER NOT NULL,
  rule TEXT NOT NULL,                -- JSON, as the book writes it
  PRIMARY KEY (provider, position)
);
```

## Permission data

HackTricks Cloud keeps two sets of structured data for the tools that audit cloud permissions. `scripts/sync.ts` parses them at index time into the tables above (`src/permissions.ts` turns the book's files into rows); the pages that present them in the wiki embed the YAML and are stubs in the index, so the data could not be searched.

- `src/permission-categorizations/{aws,gcp,azure,k8s}.yaml`: the rated list (`permission_categories`, 51,928 permissions of AWS, GCP and Azure) and the combination rules of each cloud. Kubernetes is rated by 68 ordered rules instead of a list.
- `src/privilege-escalation-paths/<provider>/<service>.yaml`: 685 techniques, each stating the permissions it needs (`requires`, a tree of `all_of` and `any_of`), what it gains, its conditions and blockers, and the page section that explains it. Files starting with `_` are the book's own notes and exclusions and are not read.

`hacktricks_cloud_permissions` answers from these tables (`src/permission-check.ts` and `src/kubernetes-rbac.ts`). It evaluates permissions only. A technique is listed when every permission it names is held: `requires` is evaluated as a three-valued tree, where a requirement the check cannot evaluate (a condition on a resource, a scope or the request that stands on its own) makes the technique unknown rather than held. Wildcards are matched as IAM and Azure match them, `*` and `?`. A technique's `source` anchor is resolved to the heading of its page section, so the tool can hand the caller the `section` for `hacktricks_get_page`.

The catalog does not describe everything the book does (`Microsoft.Authorization/roleAssignments/write` has a page section and no technique), so the check also returns the sections of the Cloud book whose heading names a held permission.

`wiki` follows the rule the public site uses: any page is its path with `.md` replaced by `.html`, except a `README.md`, which is the index of its folder (`.../aws-iam-privesc/`). Asking the site for `README.html` returns its not-found page with status 200, and a quarter of the pages are `README.md`.

## Sync automation

`.github/workflows/sync.yml` runs at `17 4 */3 * *` (every 3rd day, off-peak minute) plus manual dispatch:

1. `npm run sync` (skips cleanly if neither upstream SHA has changed)
2. `npm run eval`, `npm run eval:workflow` and `npm run eval:permissions` (the three quality gates, see below)
3. commits `data/` with both upstream SHAs in the message and tags `index-YYYY.MM.DD-<sha>-<sha>` when the index changed
4. on a change, bumps the patch version (`npm version patch`, which also stamps the manifests and tags `vX.Y.Z`), pushes it and dispatches `release.yml` on that tag

Every install path resolves to the npm package, so a committed index only reaches users once it is released. Step 4 closes that gap: one sync, one patch release. The dispatch is explicit because a tag pushed with `GITHUB_TOKEN` does not fire the `push` trigger in `release.yml`; `workflow_dispatch` always does.

Because the SHA check happens first, quiet weeks produce zero commits, zero releases and zero noise.

## Runtime index refresh

A release only reaches a user who installs it. Pinned versions, plugin installs and sessions that stay open for days would keep an older index until then. `src/refresh.ts` lets a running server pick up a newer one:

1. **Startup.** The server opens the bundled index, or a newer one that an earlier run of any installed version left in the cache. Tool calls answer from the first moment, online or not.
2. **Check.** In the background it fetches `meta.json` from the project's latest GitHub release (`releases/latest/download/`, which redirects to the asset). If that index has the same `schema` and a later `syncedAt`, it downloads `meta.json`, `toc.json` and `hacktricks.db` into a staging folder in the cache.
3. **Validate.** The download must have the advertised size and page count, the expected columns and a table of contents.
4. **Swap.** Only then does the folder get its final name (`index-<schema>-<sync time as digits>`) and the index replace the one in use, between two tool calls. Older downloads are removed.
5. **Repeat.** The same check runs every 6 hours, so a server that stays open for days does not fall behind.

Tool calls never wait on the network, and every failure leaves the current index in place:

| Situation | Result |
|---|---|
| No network, DNS failure, proxy, rate limit | One line on stderr; the bundled or cached index keeps serving |
| Latest release has no index files (HTTP 404) | Same |
| Release built for another index layout (`schema`) | Ignored without downloading |
| Network accepts the connection and never answers | Given up after 5 s (check) or 10 min (download) |
| Download cut short or not the advertised database | Rejected by validation; staging folder removed |
| Process dies during a download | Its staging folder is removed by the next download that finds it over an hour old |

The cache is `%LOCALAPPDATA%\hacktricks-mcp\cache` on Windows, `~/Library/Caches/hacktricks-mcp` on macOS and `$XDG_CACHE_HOME/hacktricks-mcp` (else `~/.cache/hacktricks-mcp`) elsewhere. A download is about 64 MB and happens at most once per release, because later sessions find it in the cache.

| Variable | Effect |
|---|---|
| `HACKTRICKS_OFFLINE=1` | No network use at all; a cached index is still used |
| `HACKTRICKS_INDEX_URL` | Base URL to fetch the three files from, instead of this project's releases |
| `HACKTRICKS_CACHE_DIR` | Where downloaded indexes are kept |
| `HACKTRICKS_DB` | Path of a database to serve; an explicit choice of index, so the refresh stays off |

Node's built-in `fetch` does not read `HTTP_PROXY` on its own. Behind such a proxy the check fails, the server logs that on stderr and the bundled index stays in use.

`release.yml` attaches all three files of `data/` to every release for this. After the npm publish it removes them from every older release, in a step that is allowed to fail: running servers only ever download the latest one, so GitHub holds a single copy of the index and not one per release. `scripts/smoke-refresh.ts` plays each row of the table above against a local stand-in for the releases.

## Quality gates

Three evals run in CI, in the sync workflow and in the release workflow, and all block:

- `scripts/eval.ts` runs `tests/queries.json` (42 keyword queries with expected page paths, 12 of them for the Cloud book) against the built index. A query passes when an expected page appears in the top 5. It fails below 80%, so a broken parser or ranking regression blocks a bad index from being committed.
- `scripts/eval-workflow.ts` plays the route the skill gives an agent (the permissions check for a question that names permissions, a search with the technique's name, with the question as typed, then listing the topic) for the 89 questions in `tests/scenarios.json`, each asked two ways. It fails when the route finds the page for less than 90% of the questions, asked either way. See [development.md](development.md#evaluating-quality).
- `scripts/eval-permissions.ts` proves the permissions check against the catalog itself (every technique that names permissions is listed from exactly those, and a plain conjunction is not listed without one of them) and against the hand-checked cases in `tests/permissions.json`.

## Design choices and why

- **Pre-built index over live fetching**: answers in about 100 to 160 ms, works offline, never hits GitHub rate limits at query time.
- **node:sqlite over better-sqlite3**: zero native compilation, so `npx` works on any machine with Node 22.13+.
- **FTS5 over ripgrep**: ranked relevance (BM25 plus title credit) instead of raw match lines, and no external binary to install. Ripgrep was weighed again when the Cloud book was added and adds nothing here: the index already holds the text, and ranking is what decides whether an agent finds the page.
- **One index for both books over one index per book**: most questions do not say which book answers them (`privilege escalation`, `docker`, `github actions`), and one search must cover both. The `book` column costs nothing and lets a caller narrow by book.
- **A dedicated check for cloud permissions over search**: a question such as "what can I do with `iam:PassRole` and `lambda:CreateFunction`" is a lookup in data the book keeps in structured form, not a text search. The plain search finds the page for 1 of the 6 permission questions in the evaluation; the check finds all 6, with the page section to read.
- **Tarball over git clone in sync**: two HTTP requests, no history, no auth.
- **Committing `data/`**: makes the repo self-contained; cloning gives you a working server immediately, and the npm package ships the same bytes.
