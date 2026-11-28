# Architecture

How the index is built, served and kept current.

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
  5. clean the markdown outside code blocks (src/markdown.ts); an index is not
     written when that took a heading, a code fence or a payload line
  6. build one SQLite FTS5 index, each page tagged with its book (src/db.ts)
  7. read the Cloud book's permission lists and escalation catalog into tables (src/permissions.ts)
  8. write data/{hacktricks.db, toc.json, meta.json, upstream.json}
        |
        v
dist/main.js (the executable, package.json "bin")
  names the Node.js it needs when the one running it is too old (src/main.ts)
dist/server.js (MCP stdio server)
  reads data/hacktricks.db read-only at startup
  swaps in a newer index from the releases in the background (src/refresh.ts)
```

The books are listed in `src/books.ts`: id, title, GitHub repository and public site. The indexer, the server and the refresh all read that table, so adding a book is one entry.

`dist/main.js` imports nothing that needs `node:sqlite`, so that on a Node.js older than 22.13 it can say what to do instead of failing on the missing module. `scripts/smoke.ts` starts the executable; the other tests start `dist/server.js` directly.

## Data files

| File | Content | Source of truth |
|---|---|---|
| `data/hacktricks.db` | SQLite DB: one `pages` table and its `pages_fts` FTS5 table for all books, and the permission tables | rebuilt by `npm run sync` |
| `data/toc.json` | Each book's table of contents tree, keyed by book id | parsed from each upstream `SUMMARY.md` |
| `data/meta.json` | `schema`, `books` (upstream SHA per book), `syncedAt`, `pageCount`, `dbBytes` | written by sync |
| `data/upstream.json` | `schema` and `books` alone, so that a local sync leaves it unchanged | written by sync; the one file of `data/` that is tracked |

`meta.json` has three readers. The sync script compares `books` with upstream to know whether to rebuild, and rebuilds regardless when `schema` differs from `INDEX_SCHEMA` in `src/db.ts`. The server puts `pageCount` and `syncedAt` into its instructions and into the first line of `hacktricks_get_toc`. The runtime refresh reads `schema` and `syncedAt` from a release's copy to decide whether it can use that index and whether it is newer. `upstream.json` is what the sync workflow compares before and after a rebuild to tell whether the index changed.

Bump `INDEX_SCHEMA` whenever a rebuild must reach every index although upstream has not moved: a layout change, or a change in how pages become rows (`src/db.ts`, `src/toc.ts`, `src/markdown.ts`, `src/permissions.ts`).

The `wiki` column follows the public site: a page is its path with `.md` replaced by `.html`, except a `README.md`, which is the index of its folder (`.../aws-iam-privesc/`), because `README.html` is the site's not-found page. Pages the table of contents does not list (`LICENSE.md`, the training banner) have none.

## Table of contents parsing

`src/toc.ts` reads the mdBook-style `SUMMARY.md` of each book into a tree of `{ title, path, category, children }`:

- Comments are stripped first, because many entries end in an HTML comment about where their title came from (`<!-- Original navigation label: ... -->`).
- A heading's words become the category name with their punctuation (`Pentesting CI/CD`, `Hardware/Physical Access`); only emoji are dropped.
- Entries that link nowhere point at another site and are pruned.

The tree then lists only pages the index holds (`pruneToc`, called by the indexer with the paths it inserted). `category` of a page is the nearest `#` heading above its entry; pages the table of contents does not list fall back to the first folder of their path.

## Pages that are left out

At index time `scripts/sync.ts` skips:

- pages shorter than 40 characters after cleaning (stubs);
- pages titled `(former URL)` that are under 2,000 characters. Upstream keeps them so that old links still work; they only say where a section moved to, carry the title of the page they point to and outranked that page in search.

The Cloud book also keeps structured data that is not markdown: its permission lists and escalation catalog, read into tables of their own ([Permission data](#permission-data)).

## Markdown cleaning

`src/markdown.ts` cleans each page outside code blocks only. A code block is stored as it is, because the pages on injection hold `{{ ... }}`, `{% ... %}` and `<!-- -->` that look like templating and are payloads. What a template carries stays, such as the name of a tab and the text of a warning.

1. A `{% hint %}` block stays as its text, led by `**Note.**`, `**Tip.**`, `**Warning.**` or `**Caution.**` as its style says. The one that advertises training is dropped, and so is a line of a hint that holds an include.
2. An HTML comment that starts a line is removed; the wiki does not show it either. One inside a line is content (the XML pages hold `<!--`).
3. A line that holds only a marker of a tab group (`{{#tabs}}`, `{{#endtabs}}`, `{{#endtab}}`), of a file or an embed (`{{#file}}`, `{{#endfile}}`, `{% embed %}`, `{% endembed %}`) or a badge image of `.gitbook/assets` is removed. A `{{#tab name="..."}}` line becomes a bold line with the tab's name.
4. An include of the training banner and the `{{#ref}}` and `{{#endref}}` markers are removed wherever they stand, which leaves the reference they wrap. A heading left without text is dropped.
5. Trailing spaces and runs of three or more blank lines.

The sync script compares each raw page with its cleaned copy and refuses to write an index when cleaning took a heading outside code, a code fence or a line of prose holding a template expression.

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

An `AFTER INSERT` trigger keeps the FTS table in sync. Ranking is described in [tools.md](tools.md#hacktricks_search).

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

HackTricks Cloud keeps two sets of structured data about cloud permissions. The wiki pages that present them embed the YAML and are stubs in the index, so `scripts/sync.ts` parses the files themselves into the tables above (`src/permissions.ts` turns them into rows):

- `src/permission-categorizations/{aws,gcp,azure,k8s}.yaml`: the rated list (51,928 permissions of AWS, GCP and Azure) and the combination rules of each cloud. Kubernetes is rated by 68 ordered rules instead of a list.
- `src/privilege-escalation-paths/<provider>/<service>.yaml`: 685 techniques, each stating the permissions it needs (`requires`, a tree of `all_of` and `any_of`), what it gains, its conditions and blockers, and the page section that explains it. Files whose name starts with `_` are the book's own register of what it left out and are not read.

`hacktricks_cloud_permissions` answers from these tables (`src/permission-check.ts`, `src/kubernetes-rbac.ts`). It evaluates permissions only. A technique is listed when every permission it names is held: `requires` is evaluated as a three-valued tree, where a requirement the check cannot evaluate (a condition on a resource, a scope or the request that stands on its own) makes the technique unknown rather than held. Wildcards are matched as IAM and Azure match them, `*` and `?`. A technique's `source` anchor is resolved to the heading of its page section, so the tool hands the caller the `section` for `hacktricks_get_page`.

The catalog does not describe everything the book does (`Microsoft.Authorization/roleAssignments/write` has a page section and no technique), so the check also returns the sections of the Cloud book whose heading names a held permission.

## Sync automation

`.github/workflows/sync.yml` runs at `17 4 */3 * *` (every 3rd day) and on manual dispatch:

1. `npm run sync` rebuilds the index. Locally the script skips when the index is already built for the same upstream commits; the workflow starts without one.
2. The three quality gates run (see below).
3. When the layout number or an upstream commit in `data/upstream.json` differs from the one on record, it commits `data/upstream.json` with both upstream SHAs in the message and tags `index-YYYY.MM.DD-<sha>-<sha>`.
4. On a change, it bumps the patch version (`npm version patch`, which also stamps the manifests and tags `vX.Y.Z`), pushes it and dispatches `release.yml` on that tag.

The index itself is not kept in git: every install path resolves to the npm package or to a release asset. Only `upstream.json` is, as the record of what was released, and it carries no time, so a local sync leaves it as it is. The dispatch in step 4 is explicit because a tag pushed with `GITHUB_TOKEN` does not fire the `push` trigger in `release.yml`; `workflow_dispatch` always does. When nothing changed, the run commits and releases nothing.

## Runtime index refresh

A release only reaches a user who installs it. Pinned versions, plugin installs and sessions that stay open for days would keep an older index until then. `src/refresh.ts` lets a running server pick up a newer one:

1. **Startup.** The server opens the bundled index, or a newer one that an earlier run left in the cache. On Windows the bundled index is first copied into the cache and opened there: Windows does not let an open file be replaced, so a server holding the package's own `hacktricks.db` kept npx from updating the package (`npm error code EBUSY`) for as long as it ran. The copy has the name a download of the same index would have, so one stands for both. Tool calls answer from the first moment, online or not.
2. **Check.** In the background it fetches `meta.json` from the project's latest GitHub release (`releases/latest/download/`, which redirects to the asset). If that index has the same `schema` and a later `syncedAt`, it downloads `meta.json`, `toc.json` and `hacktricks.db` into a staging folder in the cache.
3. **Validate.** The download must have the advertised size and page count, the expected columns and a table of contents.
4. **Swap.** Only then does the folder get its final name (`index-<schema>-<sync time as digits>`) and the index replace the one in use, between two tool calls. Indexes older than the one in use are removed, here and whenever a server starts.
5. **Repeat.** The same check runs every 6 hours.

Tool calls never wait on the network, and every failure leaves the current index in place:

| Situation | Result |
|---|---|
| No network, DNS failure, proxy, rate limit | One line on stderr; the bundled or cached index keeps serving |
| Latest release has no index files (HTTP 404) | Same |
| Release built for another index layout (`schema`) | Ignored without downloading |
| Network accepts the connection and never answers | Given up after 5 s (check) or 10 min (download) |
| Download cut short or not the advertised database | Rejected by validation; staging folder removed |
| Process dies during a download or a copy | Its staging folder is removed by the next one that finds it over an hour old |

The cache is `%LOCALAPPDATA%\hacktricks-mcp\cache` on Windows, `~/Library/Caches/hacktricks-mcp` on macOS and `$XDG_CACHE_HOME/hacktricks-mcp` (else `~/.cache/hacktricks-mcp`) elsewhere. A download is about 64 MB and happens at most once per release, because later sessions find it in the cache. On Windows the cache also holds the copy of the bundled index, one more folder of about 64 MB.

| Variable | Effect |
|---|---|
| `HACKTRICKS_OFFLINE=1` | No network use at all; a cached index is still used |
| `HACKTRICKS_INDEX_URL` | Base URL to fetch the three files from, instead of this project's releases |
| `HACKTRICKS_CACHE_DIR` | Where downloaded indexes are kept and, on Windows, the copy of the bundled index |
| `HACKTRICKS_DB` | Path of a database to serve; an explicit choice of index, so the refresh stays off |

An empty or blank variable counts as unset, as a host's configuration form may leave it. The index is opened before the server answers its first message: one that is missing or not a database stops the start with one line on stderr that says which file and what to do. A damaged download in the cache is logged and skipped, and the bundled index is served.

Node's built-in `fetch` does not read `HTTP_PROXY` on its own. Behind such a proxy the check fails, the server logs that on stderr and the bundled index stays in use.

`release.yml` attaches all three files of `data/` to every release for this, and after the npm publish removes them from every older release in a step that is allowed to fail: running servers only ever download the latest one. `scripts/smoke-refresh.ts` plays each row of the table above against a local stand-in for the releases.

## Quality gates

Three evals run in CI, in the sync workflow and in the release workflow, and all block. What each proves, and where its threshold lies, is in [development.md](development.md#evaluating-quality):

- `scripts/eval.ts`: keyword queries find their expected page.
- `scripts/eval-workflow.ts`: the route the skill gives finds the page of a scenario question, asked two ways.
- `scripts/eval-permissions.ts`: the permissions check is faithful to the catalog and to hand-checked cases.

`npm run smoke` adds two end-to-end tests over stdio against the built server: `scripts/smoke.ts` calls the four tools, and `scripts/smoke-edge.ts` sends the inputs from outside the happy path ([development.md](development.md#edge-cases)).

## Design choices and why

- **Pre-built index over live fetching**: answers in milliseconds, works offline, and no rate limit at query time.
- **node:sqlite over better-sqlite3**: no native compilation, so `npx` works on any machine with Node 22.13 or newer.
- **FTS5 over ripgrep**: ranked relevance (BM25 plus name credit) instead of raw match lines, and no external binary to install.
- **One index for both books**: most questions do not say which book answers them (`privilege escalation`, `docker`), so one search must cover both. The `book` column lets a caller narrow.
- **A dedicated check for cloud permissions over search**: the rating of each permission and the techniques they enable are in structured files that the wiki pages only embed.
- **Tarball over git clone in sync**: two HTTP requests, no history, no auth.
- **A section by its exact name first**: taking the first heading that contained the name read another heading for 1,854 of 34,585 headings asked for by their own text. 470 share a name with an earlier heading; the answer says so.
- **The index not in git**: it served local development only and cost 23 MB of history per sync and a 23 MB download for a plugin install. `npm run sync` builds it after a clone.
