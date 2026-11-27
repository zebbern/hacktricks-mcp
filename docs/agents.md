# Agents: skill, registry and plugin packaging

How hacktricks-mcp shows up inside agent ecosystems. The artifacts referenced here live in `skills/`, the plugin manifests and `server.json`; this page explains the intent so there is one place to update the reasoning.

## Why a skill on top of an MCP server

The MCP tools tell an agent *what* it can call. A skill tells the agent *how to be good at it*: which query phrasing works, when to use `section` versus `codeOnly`, how to recover from a miss. Skills are cheap (a markdown file) and measurably improve tool use quality.

This repo ships `skills/hacktricks/SKILL.md` in the [Agent Skills](https://agentskills.io) format (YAML frontmatter plus instructions). The same file is read by Claude Code, ZCode, Codex and Kimi Work, and by Cursor and other hosts that support skills. It is documentation for agents, not executable code.

When editing tool behavior in `src/server.ts`, keep the skill in sync: the skill describes the workflow, [tools.md](tools.md) describes the API.

## MCP registry

`server.json` at the repo root is the manifest for the [official MCP registry](https://registry.modelcontextprotocol.io). Publishing is a local, one-command step after each npm release (kept out of CI by design):

```bash
mcp-publisher login github   # device flow, once per machine
mcp-publisher publish        # from the repo root, after npm has the new version
```

The registry verifies npm ownership via the `mcpName` field in `package.json`, and requires `server.json` `version` + `packages[].version` to match the published npm version exactly. `description` must stay under 100 characters.

Index syncs publish a patch release on their own (see [architecture.md](architecture.md#sync-automation)), so the registry listing drifts until this command is re-run after each one. The Release workflow prints a reminder when it publishes.

## Plugin packaging: one plugin, four hosts

The repo root is the plugin. Each host gets a small manifest in its own dot-directory, and all of them point at the same `skills/` directory and the same `.mcp.json`, so there is one skill and one server definition to maintain:

| Host | Manifest | Skill | MCP server |
|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | auto-discovers `skills/` at the plugin root | auto-discovers `.mcp.json` at the plugin root |
| ZCode | `.zcode-plugin/plugin.json` | `skills: "./skills"` | `mcpServers: "./.mcp.json"` |
| Codex | `.codex-plugin/plugin.json` | `skills: "./skills/"` | `.mcp.json` (Codex compatibility layout); `mcp.json` is the portable [Agent Plugins](https://agent-plugins.org) form of the same server |
| Kimi Work | `kimi-plugin/kimi.plugin.json` | mirrored to `kimi-plugin/skills/` | `mcpServers` inline |

Kimi is the exception: a Kimi plugin installs as a self-contained directory and cannot reach the repo root, so it gets a generated mirror. `scripts/sync-skills.mjs` copies the whole `skills/hacktricks/` directory into every root listed in its `MIRRORS` array, and `--check` (run by CI and the `npm version` hook) fails when a mirror differs from the canonical file or holds a stale one. A new host that needs its own copy is one entry in that array. Symlinks would avoid the mirror, but they do not survive Windows checkouts or archive installs.

This is the layout the hosts share: skills live in `skills/<name>/SKILL.md` at the plugin root ([Agent Skills](https://agentskills.io)), and the plugin root may hold several hosts' manifests side by side.

**Always launch with an explicit tag.** Every MCP config here runs `npx -y @zebbern/hacktricks-mcp@latest`, and the README quick start does the same. Given a bare package name, npx prefers a package of the same name in the project it is started from, so a session opened inside this repository tries to run the local copy and fails with `'hacktricks-mcp' is not recognized`. The tag makes npx resolve the published package instead, and it still picks up each new release on launch.

**The repo is its own marketplace.** `.claude-plugin/marketplace.json` lists the plugin with `"source": "./"`. Claude Code, ZCode and Codex all read that file, so one catalog serves every host:

- Claude Code: `/plugin install hacktricks --marketplace zebbern/hacktricks-mcp`
- Codex CLI: `codex plugin marketplace add zebbern/hacktricks-mcp`, then `codex plugin add hacktricks --marketplace hacktricks-mcp`
- ZCode: add `zebbern/hacktricks-mcp` as a plugin marketplace, then install `hacktricks`

When bumping versions, the hook stamps `server.json`, the three plugin manifests and the marketplace entry. There is no extra code to maintain.

## Claude Desktop / Cursor / generic MCP

No plugin wrapper needed: the server is plain stdio MCP. The README quick-start config covers these clients.
