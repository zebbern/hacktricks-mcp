# Agents: skill, registry and plugin packaging

How hacktricks-mcp shows up inside agent ecosystems. The artifacts referenced here live in `skills/`, the plugin manifests and `server.json`; this page explains the intent so there is one place to update the reasoning.

## Why a skill on top of an MCP server

The MCP tools tell an agent *what* it can call. A skill tells the agent *how to be good at it*: which query phrasing works, when to use `section` versus `codeOnly`, how to recover from a miss. Skills are cheap (a markdown file) and measurably improve tool use quality.

This repo ships `skills/hacktricks/SKILL.md` in the [Agent Skills](https://agentskills.io) format (YAML frontmatter plus instructions). The same file is read by Claude Code, ZCode, Codex and Kimi Work, and by Cursor and other hosts that support skills. It is documentation for agents, not executable code.

When editing tool behavior in `src/server.ts`, keep the skill in sync: the skill describes the workflow, [tools.md](tools.md) describes the API.

**Why the skill delegates broad research.** Tool results stay in the main conversation until it ends. In a live test on 2026-11-27 (ZCode subagents answering against the server, each question once with and once without the skill), a researcher read 11,000 to 35,000 characters for a question that names the technique, 44,000 to 55,000 for a situational one and 74,000 to 144,000 for a broad one, and handed back reports of 2,000 to 8,000. So the skill answers single-page questions directly and gives anything that needs several pages to a subagent, with a fixed three-part report. The same test showed the skill's other effect: with it, researchers made fewer calls in every pair and read 10% to 31% less in five of six. Delegation is slow (2 to 21 minutes per question in the test, which also made each researcher save its report to a file) and costs 100,000 to 850,000 tokens in the subagent's own context, which is why it is not the default.

**How the hand-off is made.** `agents/hacktricks-researcher.md` is the canonical researcher subagent, in the format Claude Code and ZCode share: a frontmatter of `name`, a `description` with triggering examples, `model`, `color` and `tools`, then the prompt. It stands on its own. The lookup route is in its own prompt, so it never has to load the skill, which Kimi and Codex cannot preload anyway. Claude Code picks it up from the plugin root on its own; ZCode reads the same file once its manifest declares `"agents": "agents"`. Its tools are the four HackTricks MCP tools and nothing else. `scripts/sync-agents.mjs` generates the other two formats from it with the same description and prompt, and `--check` (run by CI and the `npm version` hook) fails on drift:

- `kimi-plugin/agents/hacktricks-researcher.md`: Kimi reads `agents/` under its plugin root by default. Its frontmatter has no `model` or `color` and takes `whenToUse` instead; the copy keeps the description and the prompt and denies file edits and shell commands.
- `.codex/agents/hacktricks-researcher.toml`: Codex reads agents as TOML from `.codex/agents/` or `~/.codex/agents/`. Its plugins cannot bundle agents, and an agent file cannot restrict tools, so that copy states its limits in words and users install it with one copy (the README has the command).

Hosts without a bundled researcher fall back to the hand-off the skill describes: the main agent spawns a general-purpose subagent and points it at the skill.

**Why `outlineOnly` exists.** The same test showed agents reading whole pages of 9,000 to 23,000 characters just to find the headings, and in 5 of 13 runs re-reading sections of a page they had already read whole. `hacktricks_get_page` with `outlineOnly` returns the headings with the size of each section in about 700 characters for the median page. Two more rounds (six runs) refined it: researchers asked for the outline of short pages they then read whole, so search hits now carry each page's size and the skill says to read a page whole under about 8,000 characters (a third of the pages); after that, two short-page questions were read whole with no outline step. The gain is real but narrow. On a targeted question about a 33,000-character page the researcher read 48% less. On a question where the agent wanted broad coverage the amount read varied by about 30% between runs with no clear saving, and on a broad research question whole pages were needed anyway. Each round was a single run per question, so treat all of it as directional.

**Why the skill tells agents to name the technique first.** A question that only describes a situation finds its page with one search for 51 of 89 questions; the same need with the technique named finds it for 85. Searching as typed first and adding the name on a miss reaches 87 of 89, as naming first does, but costs 1.43 calls instead of 1.04. The evaluation is `npm run eval:workflow` (see [development.md](development.md#evaluating-quality)). It cannot show whether a live agent names the technique the way a scenario does, so that step is the agent's own.

**Why the skill sends permission questions to `hacktricks_cloud_permissions`.** HackTricks Cloud keeps its permission knowledge in structured files that the wiki pages only embed, so a search cannot answer from them: 52,000 rated permissions, 685 escalation techniques. Six of the 89 scenario questions name permissions. The check finds the page for all six and hands over the section to read. Since a query is split at the separators of a permission (0.3.2), the plain search has an expected page among its five results for all six as well, first for five; before that it was one of six. The search also reads less, 2,164 characters a question against 5,038, so the check is the first call for what it adds and a search cannot find in the pages: the rating of each permission and the techniques they enable, with the section that explains each. Measured live on 2026-11-28 with a variant of the skill whose step told agents to search with the permissions instead (three questions, six runs, 974,000 tokens): agents called the check in every run, under the variant too, because its description names the question; the answers met the same rubric either way, and the check-first runs read 33,000 characters a question against 50,000, which three runs each cannot tell apart. The step stays as written. The check was proven against the catalog before it was wired in (`npm run eval:permissions`): holding a technique's own permissions lists it for all 657 techniques that name permissions, and that test caught two real defects on the way, a technique with an empty requirement that was listed for everyone and a Kubernetes subresource grant that counted as its resource. The catalog does not cover everything the book describes (`Microsoft.Authorization/roleAssignments/write` has a section and no technique), so the check also returns the sections whose heading names the permission. It evaluates permissions only, and the skill tells agents to read the conditions before relying on a technique.

**Why the skill explains how the Cloud book names its pages.** The Cloud book titles every page by provider, service and phase (`AWS - IAM Privesc`, `Az - Key Vault Post Exploitation`), so a search about a service returns its pages from several phases. Adding the phase word to the query did not help (`aws iam privesc` ranks lower than the sentence), so the skill does not suggest it. It tells agents to read the hit titles for the phase, and to list a provider or a service with `hacktricks_get_toc`, which returns its pages in 2,000 to 8,000 characters.

**Why the skill does not build links.** The skill used to tell agents to turn a path into a wiki link by replacing `.md` with `.html`. That is wrong for a quarter of the pages: on the wiki a `README.md` is the index of its folder, and asking for `README.html` returns the site's not-found page with status 200. The server now works the link out and returns it (`wikiUrl`, and in the first lines of every page read), and 79 sampled links were checked against the live sites.

**Live run of 2026-11-27, after the Cloud book and the permissions check (eleven questions, one run each).** The real MCP server is not connected in this workspace, so each agent got a stand-in that starts the built server and prints the tool's text, the tools' real descriptions, and the skill to read. Treat the results as directional: one run per question, with the restrictions restated in the prompt.

| Question | First move | Result | Calls | Characters read | Tokens |
|---|---|---|---|---|---|
| containerd `ctr`, names the technique | search with the technique named | right page, read whole (short) | 2 | 4,779 | 86,000 |
| Jenkins script console, names the technique | search with the technique named | right page, read whole (short) | 2 | 6,125 | 90,000 |
| Kerberoast, names the technique | search with the technique named | right page, outline then 4 sections | 6 | 9,096 | 113,000 |
| SSRF to the metadata endpoint, names the technique | search with the question as typed | right page, outline then 4 sections | 8 | 31,662 | 164,000 |
| CORS, situation only | named the technique itself | right page, outline then 4 sections | 6 | 7,375 | 134,000 |
| Kerberoast, situation only | named the technique itself | right page, outline then 5 sections | 7 | 10,441 | 127,000 |
| Cron, situation only | named the technique itself | right page, outline then 3 sections | 6 | 24,465 | 147,000 |
| Kubernetes, situation only | permissions check with `create pods` | four pages, the sections the check pointed to | 15 | 33,188 | 227,000 |
| AWS permission | permissions check | the section it pointed to | 2 | 4,463 | 85,000 |
| Azure permission | permissions check | two pages, outline then section | 5 | 9,690 | 90,000 |
| A CVE HackTricks has no page for | search, then search with other words | said so, and that the CVE belongs to another product | 7 | 15,115 | 143,000 |

All eleven found the pages that answer the question, every report used the three-part format with the wiki link, every command that was checked (over 120) is in a page the agent had read, and no agent ran anything. Together: 66 tool calls, 156,399 characters of tool output, about 1.4 million tokens, 24 minutes of agent time. Two things came out of it. A section longer than 20,000 characters with no subsections could not be read to the end, so `hacktricks_get_page` now takes `offset` and a cut response says where the rest continues. And the Kubernetes scenario expected the overview page where the specific sub-page answers the question, so the expectation was corrected. The Kubernetes agent also did what the scripted evaluation cannot show: it recognised "I can create pods" as a grant and opened with the permissions check.

The cron question was run a second time with the `offset` change and the updated skill: the agent read the long section to its end with `offset=20000` and went on to the Linux Privilege Escalation page, where the actual overwrite commands are, so its answer was fuller than the first run's. That came at 19 calls, 51,863 characters and 263,000 tokens, against 6 calls and 147,000 tokens the first time: completeness and cost pull in different directions on a broad question, which is why the skill sends such questions to a researcher subagent rather than answering them in the main conversation.

**The rewrite of 2026-11-28, measured.** The skill went from 99 lines to 50 and the researcher from a pointer to the skill to a self-contained agent of 44 lines. Each ran against its previous version on the same prompts in one batch, one run per prompt: four for the skill (a named technique, a situation, cloud permissions, a CVE HackTricks has no page for) and three for the researcher (the situation, the permissions, a comparison of two pages). All fourteen runs passed every assertion: the expected pages read, the outline before the sections of a long page, the permissions check first, every quoted command found in a page the agent had read, the wiki link cited, and for the researcher the three-part report within 200 words. The cost did not move one way: the skill read 177,630 characters against 121,948, the researcher made 61 calls against 36, and tokens stayed within 15% either way. Two things drive the cost of a permissions question in both versions: the check lists 28 techniques for `iam:PassRole` and both researchers read nearly all of them, and one run fetched the whole table of contents only for its sync date. The same runs exposed a defect in the page tool: the check prints a heading without its backticks and `section` did not match it, so `section` now ignores marks for code style and emphasis.

**Round two.** The permissions step of both files now says to read only the techniques whose `needs` and `conditions` name no permission the caller lacks, to raise `limit` only when asked, and the skill says not to fetch the table of contents for its date alone. On the permissions question the researcher then read 93,933 characters in 23 calls and 290,000 tokens, against 154,935 and 184,261 characters in its two earlier runs; the skill read 87,118, inside its own earlier range of 69,253 to 102,452, so no change is claimed for it. All assertions passed again in the six runs.

## MCP registry

`server.json` at the repo root is the manifest for the [official MCP registry](https://registry.modelcontextprotocol.io). A second job of `release.yml` publishes it after the npm publish of every release, index releases included, so the listing follows npm on its own. It uses the registry's trusted publishing, which works like npm's: the workflow logs in with GitHub OIDC (`mcp-publisher login github-oidc`) and no token is stored anywhere.

The job first waits for npm to serve the version, because the registry checks the package there and npm keeps a new version for validation after a publish. If npm needs more than an hour, the job gives up on its own; re-run the failed job once npm has the version. Dispatching the workflow on `main` does the same for the version `main` holds, and repeats nothing an earlier run did. If the registry itself refuses, the npm package and the GitHub release are already out and only the listing is behind. Do the same by hand from the repo root, on the tag that was released. `mcp-publisher` is the official CLI. It is a binary and is not on npm (the npm package of that name is something else): install it with `brew install mcp-publisher` on macOS or Linux, or take `mcp-publisher_windows_amd64.tar.gz` from the [registry's releases](https://github.com/modelcontextprotocol/registry/releases) on Windows, and check it with `mcp-publisher --help`.

```bash
mcp-publisher login github   # device flow, once per machine
mcp-publisher validate       # checks server.json against the registry, publishes nothing
mcp-publisher publish        # from the repo root, after npm has the new version
```

`validate` asks the registry's own validator, the same one `publish` goes through, and reports every issue at once. Without the binary the same check is one request: `curl -X POST https://registry.modelcontextprotocol.io/v0/validate -H "Content-Type: application/json" -d @server.json` answers `{"valid":true,"issues":[]}` for a manifest the registry accepts.

The registry verifies npm ownership via the `mcpName` field in `package.json`, and requires `server.json` `version` + `packages[].version` to match the published npm version exactly. `description` must stay under 100 characters.

Index syncs publish a patch release on their own, through the same workflow (see [architecture.md](architecture.md#sync-automation)), so they update the listing too.

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
- ZCode: **Settings > Plugins > Add > Add plugin marketplace**, `zebbern/hacktricks-mcp`, then install `hacktricks` from the **Personal** tab

How ZCode gets there, checked against its own installer on 2026-11-28: it takes `owner/repo` as a public GitHub repository, downloads it as one archive, reads `.claude-plugin/marketplace.json` at the root, resolves the entry's `"./"` to that root, and reads `.zcode-plugin/plugin.json` there. The archive must declare no Git submodules or LFS filters. It was about 23 MB while the index was tracked, which a plugin install copied without using it; since the index left git it is 0.15 MB.

When bumping versions, the hook stamps `server.json`, the three plugin manifests and the marketplace entry. There is no extra code to maintain.

## Claude Desktop / Cursor / generic MCP

No plugin wrapper needed: the server is plain stdio MCP. The README quick-start config covers these clients.
