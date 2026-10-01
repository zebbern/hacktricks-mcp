# Agents: skill, registry and plugin packaging

How hacktricks-mcp shows up inside agent ecosystems. The artifacts referenced here live in `skills/` and `server.json`; this page explains the intent so there is one place to update the reasoning.

## Why a skill on top of an MCP server

The MCP tools tell an agent *what* it can call. A skill tells the agent *how to be good at it*: which query phrasing works, when to use `section` versus `codeOnly`, how to recover from a miss. Skills are cheap (a markdown file) and measurably improve tool use quality.

This repo ships `skills/hacktricks/SKILL.md` in the [Agent Skills](https://agentskills.io) format (YAML frontmatter plus instructions). The same file works in Claude Code, Kimi Work, Cursor and other hosts that support skills. It is documentation for agents, not executable code.

When editing tool behavior in `src/server.ts`, keep the skill in sync: the skill describes the workflow, [tools.md](tools.md) describes the API.

## MCP registry

`server.json` at the repo root is the manifest for the [official MCP registry](https://registry.modelcontextprotocol.io). Publishing is a local, one-command step after each npm release (kept out of CI by design):

```bash
mcp-publisher login github   # device flow, once per machine
mcp-publisher publish        # from the repo root, after npm has the new version
```

The registry verifies npm ownership via the `mcpName` field in `package.json`, and requires `server.json` `version` + `packages[].version` to match the published npm version exactly. `description` must stay under 100 characters.

## Claude Code, Codex and Kimi plugin packaging

This repo doubles as an installable plugin for three ecosystems:

- `.claude-plugin/plugin.json` + `.mcp.json`: Claude Code plugin format
- `.codex-plugin/plugin.json` + `mcp.json`: Codex plugin format
- `kimi-plugin/`: Kimi Work plugin, registered into the personal marketplace from that directory

All three wrap the same `npx -y @zebbern/hacktricks-mcp` stdio server and share the canonical skill in `skills/hacktricks/SKILL.md` (the kimi-plugin copy is synced from it). When bumping versions, update the three plugin manifests as well; there is no extra code to maintain.

## Claude Desktop / Cursor / generic MCP

No plugin wrapper needed: the server is plain stdio MCP. The README quick-start config covers these clients.
