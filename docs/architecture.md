# Architecture

How the index is built and kept current. This document owns the pipeline details; the README only states the 3-day cadence.

## Components

```
HackTricks-wiki/hacktricks (master)
        |
        |  tarball per commit SHA (no clone)
        v
scripts/sync.ts
  1. git ls-remote -> upstream SHA
  2. skip if data/meta.json already matches
  3. download + extract tarball
  4. parse src/SUMMARY.md -> toc.json + page metadata
  5. clean markdown (src/markdown.ts)
  6. build SQLite FTS5 index (src/db.ts)
  7. write data/{hacktricks.db, toc.json, meta.json}
        |
        v
dist/server.js (MCP stdio server)
  reads data/hacktricks.db read-only at startup
```

## Data files

| File | Content | Source of truth |
|---|---|---|
| `data/hacktricks.db` | SQLite DB: `pages` table + `pages_fts` FTS5 virtual table | rebuilt by `npm run sync` |
| `data/toc.json` | Nested category/page tree | parsed from upstream SUMMARY.md |
| `data/meta.json` | `upstreamSha`, `syncedAt`, `pageCount`, `dbBytes` | written by sync |

`meta.json` is how the server answers "how fresh is this index": the value is injected into the MCP server instructions at startup.

## Markdown cleaning (index time)

`src/markdown.ts` removes, in order:

1. `{% hint ... %} ... {% endhint %}` blocks (training banners)
2. single-line `{% ... %}` and `{{ ... }}` directives (includes, templating)
3. image-only lines referencing `.gitbook/assets` (badge art)
4. HTML comments
5. trailing whitespace and 3+ consecutive blank lines

Pages shorter than 40 chars after cleaning are skipped (stubs and redirect pages).

## Database schema

```sql
CREATE TABLE pages (
  page_id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,      -- repo-relative, e.g. windows-hardening/ntlm/README.md
  title TEXT NOT NULL,            -- from SUMMARY.md, falling back to first H1
  category TEXT NOT NULL,         -- top-level SUMMARY.md section
  url TEXT NOT NULL,              -- GitHub blob URL for the source page
  outline TEXT NOT NULL,          -- JSON array of {level, text, line}
  content TEXT NOT NULL           -- cleaned markdown
);
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title, path, category, content,
  content='pages', content_rowid='page_id',
  tokenize='porter unicode61'
);
```

An `AFTER INSERT` trigger keeps the FTS table in sync. Ranking details live in [tools.md](tools.md#ranking).

## Sync automation

`.github/workflows/sync.yml` runs at `17 4 */3 * *` (every 3rd day, off-peak minute) plus manual dispatch:

1. `npm run sync` (skips cleanly if the upstream SHA is unchanged)
2. `npm run eval` (quality gate, see below)
3. commits `data/` and tags `index-YYYY.MM.DD-<sha>` when the index changed

Because the SHA check happens first, quiet weeks produce zero commits and zero noise.

## Quality gate

`scripts/eval.ts` runs `tests/queries.json` (30 real lookup queries with expected page paths) against the built index. A query passes when an expected page appears in the top 5. The job fails below 80%, so a broken parser or ranking regression blocks a bad index from being committed.

## Design choices and why

- **Pre-built index over live fetching**: sub-100ms answers, works offline, never hits GitHub rate limits at query time.
- **node:sqlite over better-sqlite3**: zero native compilation, so `npx` works on any machine with Node 22.13+.
- **FTS5 over ripgrep**: ranked relevance (BM25 + stemming) instead of raw match lines, and no external binary dependency.
- **Tarball over git clone in sync**: one HTTP request, no history, no auth.
- **Committing `data/`**: makes the repo self-contained; cloning gives you a working server immediately, and the npm package ships the same bytes.
