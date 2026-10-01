# Agents: skill, registry and plugin packaging

How hacktricks-mcp shows up inside agent ecosystems. The artifacts referenced here live in `skills/` and `server.json`; this page explains the intent so there is one place to update the reasoning.

## Why a skill on top of an MCP server

The MCP tools tell an agent *what* it can call. A skill tells the agent *how to be good at it*: which query phrasing works, when to use `section` versus `codeOnly`, how to recover from a miss. Skills are cheap (a markdown file) and measurably improve tool use quality.

This repo ships `skills/hacktricks/SKILL.md` in the [Agent Skills](https://agentskills.io) format (YAML frontmatter plus instructions). The same file works in Claude Code, Kimi Work, Cursor and other hosts that support skills. It is documentation for agents, not executable code.

When editing tool behavior in `src/server.ts`, keep the skill in sync: the skill describes the workflow, [tools.md](tools.md) describes the API.

## MCP registry

`server.json` at the repo root is the manifest for the [official MCP registry](https://registry.modelcontextprotocol.io). Publishing there makes the server discoverable by registry-aware clients:

```bash
npm install -g mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

Re-run `mcp-publisher publish` after each npm release so the registry version tracks the package. Keep `server.json` version in lockstep with `package.json`.

## Kimi Work plugin

For Kimi Work users, the repo can also be packaged as a Kimi plugin (plugin manifest plus the skill) so it installs from the plugin marketplace with one click. The plugin wraps the same npx command; there is no extra code to maintain. Ask for the plugin packaging step when you want this done.

## Claude Desktop / Cursor / generic MCP

No plugin wrapper needed: the server is plain stdio MCP. The README quick-start config covers these clients.
