# hacktricks-mcp

MCP server that gives AI agents fast, offline full-text search and section-level retrieval over the [HackTricks](https://github.com/HackTricks-wiki/hacktricks) offensive-security wiki.

Unlike grep-based alternatives, this server ships with a **pre-built SQLite FTS5 search index** (1,000+ pages) inside the package. No install-time clone, no ripgrep dependency, no network access at query time. A GitHub Action re-syncs the index with upstream **every 3 days**, commits it back to this repo and publishes a patch release to npm, so an unpinned install picks up each new index on its next launch.

## Quick start

Requirements: Node.js 22.13 or newer (uses the built-in `node:sqlite`, zero native dependencies).

**Claude Code:**

```bash
claude mcp add hacktricks -- npx -y @zebbern/hacktricks-mcp@latest
```

**Codex CLI:**

```bash
codex mcp add hacktricks -- npx -y @zebbern/hacktricks-mcp@latest
```

**Any MCP client** (Claude Desktop, Cursor, Kimi, etc.), config JSON:

```json
{
  "mcpServers": {
    "hacktricks": {
      "command": "npx",
      "args": ["-y", "@zebbern/hacktricks-mcp@latest"]
    }
  }
}
```

**As a plugin** (bundles the agent skill that teaches efficient use and a researcher subagent that keeps multi-page research out of the main agent's context). The repository is its own marketplace:

- Claude Code: `/plugin install hacktricks --marketplace zebbern/hacktricks-mcp`
- Codex CLI: `codex plugin marketplace add zebbern/hacktricks-mcp`, then `codex plugin add hacktricks --marketplace hacktricks-mcp`
- ZCode: add `zebbern/hacktricks-mcp` as a plugin marketplace, then install `hacktricks`
- Kimi Work: use [this plugin link](kimi-work://plugin?id=hacktricks)

The researcher subagent comes with the plugin on Claude Code, ZCode and Kimi. Codex plugins cannot bundle subagents, so on Codex copy its definition once:

```bash
mkdir -p ~/.codex/agents && curl -fsSLo ~/.codex/agents/hacktricks-researcher.toml https://raw.githubusercontent.com/zebbern/hacktricks-mcp/main/.codex/agents/hacktricks-researcher.toml
```

Packaging details live in [docs/agents.md](docs/agents.md).

Then ask things like:

- *"Search HackTricks for kerberoast and give me the attack commands"*
- *"How do I escalate privileges from the lxd group?"*
- *"Show me the SSRF section of the pentesting-web pages"*

## Tools at a glance

| Tool | What it does |
|---|---|
| `hacktricks_search` | Ranked full-text search that takes a plain question or technical terms, with snippets, abbreviation handling (`privesc`, `sqli`, `rce`, ...) and an optional platform filter |
| `hacktricks_get_page` | Read a page's section list with sizes, a single section, the whole page, or just its code blocks |
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
