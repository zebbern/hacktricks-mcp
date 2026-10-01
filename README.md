# hacktricks-mcp

MCP server that gives AI agents fast, offline full-text search and section-level retrieval over the [HackTricks](https://github.com/HackTricks-wiki/hacktricks) offensive-security wiki.

Unlike grep-based alternatives, this server ships with a **pre-built SQLite FTS5 search index** (1,000+ pages) inside the package. No install-time clone, no ripgrep dependency, no network access at query time. A GitHub Action re-syncs the index with upstream **every 3 days** and commits it back to this repo.

## Quick start

Requirements: Node.js 22.13 or newer (uses the built-in `node:sqlite`, zero native dependencies).

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

## Tools at a glance

| Tool | What it does |
|---|---|
| `hacktricks_search` | Ranked full-text search with snippets, category filter and abbreviation handling (`privesc`, `sqli`, `rce`, ...) |
| `hacktricks_get_page` | Read a page, a single section, or just its code blocks |
| `hacktricks_get_toc` | The wiki category tree, so agents can see where topics live |

All tools are strictly read-only. Full reference: [docs/tools.md](docs/tools.md).

## Documentation

- [docs/tools.md](docs/tools.md): complete tool reference with parameters and examples
- [docs/architecture.md](docs/architecture.md): how the index and the 3-day sync work
- [docs/development.md](docs/development.md): local setup, tests, releasing
- [docs/agents.md](docs/agents.md): agent skill, MCP registry and plugin packaging

## Security and legal

- The server executes nothing from the wiki; it is a read-only search interface. All queries are parameterized, and user input is escaped before query construction.
- HackTricks content is offensive-security reference material. Use it only on systems you are authorized to test.
- Content belongs to HackTricks / Carlos Polop and contributors; this repo contains derived index data plus original server code (MIT).

## Credits

- [HackTricks](https://github.com/HackTricks-wiki/hacktricks) by Carlos Polop and contributors
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
