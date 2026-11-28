# hacktricks-mcp

MCP server that gives AI agents fast, offline full-text search and section-level retrieval over two HackTricks books: the [HackTricks](https://github.com/HackTricks-wiki/hacktricks) offensive-security wiki (network services, web, Linux, Windows and macOS hardening, Active Directory, mobile, reverse engineering, forensics, Wi-Fi) and [HackTricks Cloud](https://github.com/HackTricks-wiki/hacktricks-cloud) (AWS, GCP, Azure, Kubernetes, CI/CD). It also checks cloud permissions against HackTricks Cloud's rated lists and escalation catalog: how dangerous a permission is, what it lets a principal escalate to, and where to read about it.

Unlike grep-based alternatives, this server ships with a **pre-built SQLite FTS5 search index** (about 2,950 pages) inside the package. No install-time clone, no ripgrep dependency, and no network access at any query. A GitHub Action re-syncs the index with upstream **every 3 days**, commits it back to this repo and publishes a patch release to npm, so an unpinned install picks up each new index on its next launch. A running server also checks for a newer index in the background and switches to it when there is one, falling back to the bundled index whenever that fails (offline included).

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
- ZCode: **Settings > Plugins > Add > Add plugin marketplace**, enter `zebbern/hacktricks-mcp`, then install `hacktricks` from the **Personal** tab
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
- *"What can I do with access to a Jenkins script console?"*
- *"List every HackTricks page about AWS IAM"*
- *"Is `iam:CreatePolicyVersion` dangerous? What can I do with `iam:PassRole` and `lambda:CreateFunction`?"*

## Tools at a glance

| Tool | What it does |
|---|---|
| `hacktricks_search` | Ranked full-text search over both books that takes a plain question or technical terms, with snippets, abbreviation handling (`privesc`, `sqli`, `rce`, ...) and an optional category filter |
| `hacktricks_get_page` | Read a page's section list with sizes, a single section, the whole page, or just its code blocks; the first lines carry the link to cite |
| `hacktricks_get_toc` | A compact map of both books (categories and chapters with page counts), or the pages under the entries matching a filter |
| `hacktricks_cloud_permissions` | Rate cloud permissions (AWS, GCP, Azure, Kubernetes) against HackTricks Cloud and list the escalation techniques they enable, with the page section that explains each |

All tools are strictly read-only. Full reference: [docs/tools.md](docs/tools.md).

## Environment variables

| Variable | Effect |
|---|---|
| `HACKTRICKS_OFFLINE=1` | Never use the network: no background check for a newer index |
| `HACKTRICKS_INDEX_URL` | Download newer indexes from this base URL instead of this project's releases |
| `HACKTRICKS_CACHE_DIR` | Where downloaded indexes are kept |
| `HACKTRICKS_DB` | Serve the database at this path; the background check stays off |

How the refresh works and how it fails safely: [docs/architecture.md](docs/architecture.md#runtime-index-refresh).

## Documentation

- [docs/tools.md](docs/tools.md): complete tool reference with parameters and examples
- [docs/architecture.md](docs/architecture.md): how the index, the 3-day sync and the background refresh work
- [docs/development.md](docs/development.md): local setup, tests, releasing
- [docs/agents.md](docs/agents.md): agent skill, MCP registry and plugin packaging

## Security and legal

- The server executes nothing from the wiki; it is a read-only search interface. All queries are parameterized, and user input is escaped before query construction.
- HackTricks content is offensive-security reference material. Use it only on systems you are authorized to test.
- Content belongs to HackTricks / Carlos Polop and contributors; this repo contains derived index data plus original server code (MIT).

## Credits

- [HackTricks](https://github.com/HackTricks-wiki/hacktricks) and [HackTricks Cloud](https://github.com/HackTricks-wiki/hacktricks-cloud) by Carlos Polop and contributors
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
