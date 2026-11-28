# Agents: skill, registry and plugin packaging

How hacktricks-mcp shows up inside agent hosts: the skill, the researcher subagent, the MCP registry listing and the plugin manifests.

## The skill

The tools tell an agent what it can call; `skills/hacktricks/SKILL.md` tells it how to use them well. It is written in the [Agent Skills](https://agentskills.io) format, which also lets the [skills CLI](https://github.com/vercel-labs/skills) install it on its own: the CLI reads `skills/*/SKILL.md` at the repository root and copies what it finds, so that folder stays where it is. It adds the skill alone, not the server or the researcher; the README has the command. When tool behaviour changes in `src/server.ts`, the skill changes with it; [tools.md](tools.md) describes the API.

Every rule in it rests on a measurement. The scripted one is `npm run eval:workflow` ([development.md](development.md#evaluating-quality)). Live runs put subagents on the real server, one run per question, and are directional only.

- **Name the technique first.** A question that only describes a situation finds its page with one search for 51 of 89 questions; the same need with the technique named finds it for 85. Naming first and falling back to the question as typed reaches 87 of 89 in 1.04 calls; typing first costs 1.43.
- **Send permission questions to `hacktricks_cloud_permissions`.** A search finds the page for all six permission questions too, and reads less (2,164 characters a question against the check's 5,038), but only the check gives the rating of each permission, the techniques they enable and the section that explains each. Live, agents call the check however the step is worded.
- **Read the smallest part that answers.** Agents read whole pages of 9,000 to 23,000 characters just to find the headings. The outline costs about 800, so the skill says to read a page whole under about 8,000 characters and the outline first above that.
- **Delegate broad research.** Tool results stay in the main conversation until it ends. A researcher subagent reads in its own context and returns 2,000 to 8,000 characters of report after reading 11,000 to 144,000; with the skill it made fewer calls in every comparison. Delegation takes minutes and 100,000 to 850,000 tokens in the subagent, so it is for questions that need several pages.
- **Read Cloud titles for the phase.** The Cloud book titles its pages `<provider> - <service> <phase>`, so a search about a service returns several phases, and adding the phase word to the query does not help. `hacktricks_get_toc` with the provider's word lists its pages in 2,000 to 8,000 characters.
- **Never build a link from a path.** A `README.md` page, a quarter of all pages, lives at its folder address on the wiki, and `README.html` is the site's not-found page. The server returns the link to cite (`wikiUrl`, and the first lines of every page read).

## The researcher subagent

`agents/hacktricks-researcher.md` is the only hand-edited researcher. Claude Code and ZCode read it from the plugin root. It carries the lookup route in its own prompt and never loads the skill, which Kimi and Codex cannot preload, and its tools are the four HackTricks MCP tools and nothing else.

`scripts/sync-agents.mjs` generates the other two formats from it with the same description and prompt; `--check` (run by CI and the `npm version` hook) fails on drift:

- `kimi-plugin/agents/hacktricks-researcher.md`: Kimi's frontmatter has no `model` or `color` and takes `whenToUse`; the copy denies file edits and shell commands.
- `.codex/agents/hacktricks-researcher.toml`: Codex plugins cannot bundle agents and an agent file cannot restrict tools, so users install this copy with one command (the README has it) and it states its limits in words.

Hosts without a bundled researcher use the hand-off the skill describes: the main agent spawns a general-purpose subagent and points it at the skill.

## MCP registry

`server.json` at the repo root is the manifest for the [official MCP registry](https://registry.modelcontextprotocol.io). A second job of `release.yml` publishes it after the npm publish of every release, index releases included, through the registry's trusted publishing: the workflow logs in with GitHub OIDC (`mcp-publisher login github-oidc`) and no token is stored anywhere.

The job first waits for npm to serve the version, because the registry checks the package there and npm holds a new version for validation after a publish. If npm needs more than an hour, the job fails on its own; re-run it once npm has the version. If the registry refuses, the package and the GitHub release are already out and only the listing is behind. Publish it by hand from the tag that was released:

```bash
mcp-publisher login github   # device flow, once per machine
mcp-publisher validate       # checks server.json against the registry, publishes nothing
mcp-publisher publish
```

`mcp-publisher` is the registry's own CLI, a binary that is not on npm (the npm package of that name is something else): `brew install mcp-publisher` on macOS or Linux, or `mcp-publisher_windows_amd64.tar.gz` from [its releases](https://github.com/modelcontextprotocol/registry/releases) on Windows. Without it, the same check is one request: `curl -X POST https://registry.modelcontextprotocol.io/v0/validate -H "Content-Type: application/json" -d @server.json` answers `{"valid":true,"issues":[]}` for a manifest the registry accepts.

The registry verifies npm ownership through `mcpName` in `package.json`, requires the versions in `server.json` to equal the published npm version, and limits `description` to 100 characters.

## Plugin packaging: one plugin, four hosts

The repo root is the plugin. Each host gets a small manifest in its own dot-directory, and all point at the same `skills/` directory and the same `.mcp.json`:

| Host | Manifest | Skill | MCP server | Researcher subagent |
|---|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | auto-discovers `skills/` at the plugin root | auto-discovers `.mcp.json` at the plugin root | auto-discovers `agents/` at the plugin root |
| ZCode | `.zcode-plugin/plugin.json` | `skills: "./skills"` | `mcpServers: "./.mcp.json"` | `agents: "agents"`, the same file |
| Codex | `.codex-plugin/plugin.json` | `skills: "./skills/"` | `.mcp.json` (Codex compatibility layout); `mcp.json` is the portable [Agent Plugins](https://agent-plugins.org) form of the same server | not bundleable; `.codex/agents/hacktricks-researcher.toml` is copied to `~/.codex/agents/` |
| Kimi Work | `kimi-plugin/kimi.plugin.json` | mirrored to `kimi-plugin/skills/` | `mcpServers` inline | mirrored to `kimi-plugin/agents/`, read from there by default |

A Kimi plugin installs as a self-contained directory and cannot reach the repo root, so it gets a generated mirror: `scripts/sync-skills.mjs` copies `skills/hacktricks/` into every root in its `MIRRORS` array, and `--check` (run by CI and the `npm version` hook) fails on a mirror that differs from the canonical file or holds a stale one. Symlinks would avoid the mirror but do not survive Windows checkouts or archive installs.

**Always launch with an explicit tag.** Every server definition here runs `npx -y @zebbern/hacktricks-mcp@latest`, and a server added by hand to a host's own configuration should too. Named without a tag, or with the version the clone itself has, npx runs the copy in the folder it is started from: inside a clone of this repository that fails with `'hacktricks-mcp' is not recognized`, and everywhere else it works, which hides the cause. With `@latest`, npx resolves the published package and picks up each new release on launch.

**The repository is its own marketplace.** `.claude-plugin/marketplace.json` lists the plugin with `"source": "./"`. Claude Code, ZCode and Codex read that file, so one catalog serves every host; the README's quick start has the install steps of each.

ZCode takes `owner/repo` as a public GitHub repository and downloads it as one archive, so the repository must declare no Git submodules or LFS filters. The archive is 0.15 MB.

**The icon.** `.claude-plugin/icon.png` is drawn by `scripts/make-icon.mjs`: change the shapes or the colours there and run it. It is none of HackTricks' own artwork. Claude Code reads the file from that place. ZCode and Kimi take an HTTPS address instead, so the marketplace entry's `icon` and the Kimi manifest's `iconUrl` point at the published file on `main`. Claude Code's validator reports `icon` on a marketplace entry as a field it ignores; that note is expected.

## Claude Desktop, Cursor and other clients

No plugin is needed: the server is plain stdio MCP. The README quick start has the config.
