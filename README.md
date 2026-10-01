# hacktricks-mcp

MCP server that gives AI agents fast, offline full-text search and section-level retrieval over the [HackTricks](https://github.com/HackTricks-wiki/hacktricks) offensive-security wiki.

Unlike grep-based alternatives, this server ships with a **pre-built SQLite FTS5 search index** (1,000+ pages) inside the package — no install-time clone, no ripgrep dependency, no network access at query time. A GitHub Action re-syncs the index with upstream **every 3 days** and commits it back to this repo.

## Quick start

Requirements: Node.js ≥ 22.13 (uses the built-in `node:sqlite` — zero native dependencies).

Add to your MCP client config (Claude Desktop, Cursor, Kimi, etc.):

```json
{
  "mcpServers": {
    "hacktricks": {
      "command": "npx",
      "args": ["-y", "@zebbern/hacktricks-mcp"]
    }
  }
}
```

Then ask things like:

- *"Search HackTricks for kerberoast and give me the attack commands"*
- *"How do I escalate privileges from the lxd group?"*
- *"Show me the SSRF section of the pentesting-web pages"*

## Tools

| Tool | What it does |
|---|---|
| `hacktricks_search` | Ranked full-text search (BM25 + title/path boost). Optional category filter. Returns paths + snippets. Understands abbreviations like `privesc`, `sqli`, `rce`. |
| `hacktricks_get_page` | Reads a page by path. `section="..."` extracts one section by heading; `codeOnly=true` returns just commands/payloads. Long pages truncate with an outline so the agent can drill down. |
| `hacktricks_get_toc` | The wiki's category tree — lets the agent see where topics live before searching. |

All tools are strictly read-only (`readOnlyHint`, `openWorldHint: false`).

## How staying up to date works

```
every 3 days (04:17 UTC)          .github/workflows/sync.yml
  → git ls-remote upstream master (no clone; skips if SHA unchanged)
  → download tarball, clean GitBook boilerplate from markdown
  → rebuild SQLite FTS5 index + TOC
  → run search-quality eval (tests/queries.json, must pass ≥ 80%)
  → commit data/ and tag index-YYYY.MM.DD-<sha>
```

`data/meta.json` records the exact upstream commit the index was built from.

## Development

```bash
npm install
npm run sync    # build/refresh the index from upstream
npm run build   # compile TypeScript
npm run eval    # search-quality fixtures
npm run smoke   # end-to-end MCP test over stdio
```

Layout:

```
src/       server + library code (db, markdown cleaning, TOC parser)
scripts/   sync.ts (indexer), eval.ts (quality), smoke.ts (e2e test)
tests/     queries.json — search-quality fixtures
data/      generated index (hacktricks.db, toc.json, meta.json)
```

## Security & legal

- The server executes nothing from the wiki; it is a read-only search interface. All queries are parameterized (no FTS/SQL injection), and user input is escaped before query construction.
- HackTricks content is offensive-security reference material — use it only on systems you are authorized to test.
- Content belongs to HackTricks / Carlos Polop and contributors; this repo contains derived index data plus original server code (MIT).

## Credits

- [HackTricks](https://github.com/HackTricks-wiki/hacktricks) by Carlos Polop & contributors
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
