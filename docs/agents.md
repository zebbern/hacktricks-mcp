# Agents: skill, registry and plugin packaging

How hacktricks-mcp shows up inside agent ecosystems. The artifacts referenced here live in `skills/`, the plugin manifests and `server.json`; this page explains the intent so there is one place to update the reasoning.

## Why a skill on top of an MCP server

The MCP tools tell an agent *what* it can call. A skill tells the agent *how to be good at it*: which query phrasing works, when to use `section` versus `codeOnly`, how to recover from a miss. Skills are cheap (a markdown file) and measurably improve tool use quality.

This repo ships `skills/hacktricks/SKILL.md` in the [Agent Skills](https://agentskills.io) format (YAML frontmatter plus instructions). The same file is read by Claude Code, ZCode, Codex and Kimi Work, and by Cursor and other hosts that support skills. It is documentation for agents, not executable code.

When editing tool behavior in `src/server.ts`, keep the skill in sync: the skill describes the workflow, [tools.md](tools.md) describes the API.

**Why the skill delegates broad research.** Tool results stay in the main conversation until it ends. In a live test on 2026-11-27 (ZCode subagents answering against the server, each question once with and once without the skill), a researcher read 11,000 to 35,000 characters for a question that names the technique, 44,000 to 55,000 for a situational one and 74,000 to 144,000 for a broad one, and handed back reports of 2,000 to 8,000. So the skill answers single-page questions directly and gives anything that needs several pages to a subagent, with a fixed three-part report. The same test showed the skill's other effect: with it, researchers made fewer calls in every pair and read 10% to 31% less in five of six. Delegation is slow (2 to 21 minutes per question in the test, which also made each researcher save its report to a file) and costs 100,000 to 850,000 tokens in the subagent's own context, which is why it is not the default.

**How the hand-off is made.** `agents/hacktricks-researcher.md` is the canonical researcher subagent, in the format Claude Code and ZCode share. Claude Code picks it up from the plugin root on its own; ZCode reads the same file once its manifest declares `"agents": "agents"`. Its tools are limited to the `hacktricks` skill and the HackTricks MCP server, and it loads the skill by name rather than carrying a copy. `scripts/sync-agents.mjs` generates the other two formats from it, and `--check` (run by CI and the `npm version` hook) fails on drift:

- `kimi-plugin/agents/hacktricks-researcher.md`: Kimi reads `agents/` under its plugin root by default. Its frontmatter has no field for preloading a skill, so the copy asks for the skill by name and denies file edits and shell commands instead of allowing a tool list.
- `.codex/agents/hacktricks-researcher.toml`: Codex reads agents as TOML from `.codex/agents/` or `~/.codex/agents/`. Its plugins cannot bundle agents, and an agent file can neither restrict tools nor preload a skill, so that copy states its limits in words and users install it with one copy (the README has the command).

Hosts without a bundled researcher fall back to the hand-off the skill describes: the main agent spawns a general-purpose subagent and points it at the skill.

**Why `outlineOnly` exists.** The same test showed agents reading whole pages of 9,000 to 23,000 characters just to find the headings, and in 5 of 13 runs re-reading sections of a page they had already read whole. `hacktricks_get_page` with `outlineOnly` returns the headings with the size of each section in about 700 characters for the median page. Two more rounds (six runs) refined it: researchers asked for the outline of short pages they then read whole, so search hits now carry each page's size and the skill says to read a page whole under about 8,000 characters (a third of the pages); after that, two short-page questions were read whole with no outline step. The gain is real but narrow. On a targeted question about a 33,000-character page the researcher read 48% less. On a question where the agent wanted broad coverage the amount read varied by about 30% between runs with no clear saving, and on a broad research question whole pages were needed anyway. Each round was a single run per question, so treat all of it as directional.

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

| Host | Manifest | Skill | MCP server | Researcher subagent |
|---|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | auto-discovers `skills/` at the plugin root | auto-discovers `.mcp.json` at the plugin root | auto-discovers `agents/` at the plugin root |
| ZCode | `.zcode-plugin/plugin.json` | `skills: "./skills"` | `mcpServers: "./.mcp.json"` | `agents: "agents"`, the same file |
| Codex | `.codex-plugin/plugin.json` | `skills: "./skills/"` | `.mcp.json` (Codex compatibility layout); `mcp.json` is the portable [Agent Plugins](https://agent-plugins.org) form of the same server | not bundleable; `.codex/agents/hacktricks-researcher.toml` is copied to `~/.codex/agents/` |
| Kimi Work | `kimi-plugin/kimi.plugin.json` | mirrored to `kimi-plugin/skills/` | `mcpServers` inline | mirrored to `kimi-plugin/agents/`, read from there by default |

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
