# Contributing

Read this before a first pull request. CI enforces most of it; the reasons are here.

## Project invariants

### 1. One canonical skill, one canonical researcher

`skills/hacktricks/SKILL.md` is the only hand-edited skill file. It follows the [Agent Skills](https://agentskills.io) standard (spec-clean frontmatter: `name` + `description` only; vendor-specific fields break other hosts).

- Claude Code, Codex and ZCode plugins read this file directly from the plugin root. Do not create copies for them.
- `kimi-plugin/skills/hacktricks/SKILL.md` is a generated copy (Kimi plugins install as self-contained directories). Never edit it by hand. Run `npm run sync:skills` after touching the canonical file. CI fails on drift. The mirror list is `MIRRORS` in `scripts/sync-skills.mjs`; add a host there only if its plugin cannot reach the repo root.
- The `description` frontmatter is the trigger that decides whether agents load the skill. Treat it as a public API: specific, keyword-rich, under 1024 chars.

The same discipline holds for the researcher subagent, which is written to stand on its own:

- `agents/hacktricks-researcher.md` is the canonical researcher, in the format Claude Code and ZCode share: frontmatter of `name`, `description` with triggering examples, `model`, `color` and `tools`, then the prompt. It carries the lookup route in its own prompt and does not load the skill, so a change to the route in one of the two has to be made in the other as well. Keep its report format in step with the skill's delegation section.
- `kimi-plugin/agents/hacktricks-researcher.md` and `.codex/agents/hacktricks-researcher.toml` are generated from it in the Kimi and Codex formats. Never edit them by hand. Run `npm run sync:agents` after touching the canonical file. CI fails on drift.
- `claude plugin validate` does not read skill or subagent files, so its pass says nothing about them. Check their frontmatter against the host's own documentation when you change it.

### 2. Versions change in one command

`npm version patch|minor|major` is the only way to bump versions. Its lifecycle hook stamps `server.json`, the three plugin manifests (`.claude-plugin/`, `.codex-plugin/`, `.zcode-plugin/`) and the plugin's entry in `.claude-plugin/marketplace.json`, and stages them into the version commit. Never hand-edit version fields in those files.

Index-only releases use the same command: `sync.yml` runs it whenever the index changes, so an index change never needs a manual bump.

### 3. The index is generated

`data/` is produced by `npm run sync` from the upstream HackTricks and HackTricks Cloud repositories. Only `data/upstream.json` is tracked, as the record of which upstream commits and index layout the last release holds; it carries no time, so a local sync leaves it unchanged. Run `npm run sync` once after cloning to build the index (it needs the network), and again when upstream has moved. Do not hand-edit anything in `data/`.

When a change alters what the indexer writes, bump `INDEX_SCHEMA` in `src/db.ts` ([docs/architecture.md](docs/architecture.md#data-files)).

### 4. Quality is gated

Any change to `src/db.ts` (ranking, aliases), `src/markdown.ts` (cleaning), `src/permissions.ts`, `src/kubernetes-rbac.ts` or `src/permission-check.ts` (the permissions check) must keep all three gates green: `npm run eval`, `npm run eval:workflow` and `npm run eval:permissions` ([what each proves](docs/development.md#evaluating-quality)). If a legitimate change breaks a fixture or a scenario, discuss in the PR whether the test or the code is wrong, then update `tests/` deliberately, never to just make CI green. Look a fixture's expected answer up in the book's data rather than copying it from the tool.

Run `npm run eval:workflow` before and after a ranking change and compare. What the skill tells agents about querying rests on that run, so update the skill and the reference numbers in `docs/development.md` when the results move; do not change search guidance on assumption. `docs/development.md` also lists the ideas that were measured and rejected, so check it before trying one of them again.

### 5. Docs have one home

Each topic has exactly one home: tool API in `docs/tools.md`, pipeline in `docs/architecture.md`, dev/release flow in `docs/development.md`, ecosystem packaging in `docs/agents.md`. The README links out instead of repeating details.

A document describes the present state, not how it got there: a rule stays with the one number or reason that backs it, and the history stays in git. Documents stay under 350 lines, the skill and the researcher under 250. No em-dashes in any markdown (project style).

## Development loop

[docs/development.md](docs/development.md) has the setup and every command. In short: `npm run sync` once after cloning, and after a change to `src/` run

```bash
npm run build && npm run eval && npm run eval:workflow && npm run eval:permissions && npm run smoke && npm run smoke:refresh
```

Add an eval fixture in `tests/queries.json` when you add or change search behavior, and a case in `tests/permissions.json` when you change the permissions check. When you fix an input the server answered wrongly, add a check for it to `scripts/smoke-edge.ts` ([docs/development.md](docs/development.md#edge-cases)). When a change alters what a tool returns, run `npm run cost` and move the numbers in the README with it ([what a read costs](docs/development.md#what-a-read-costs)).

## Releasing (maintainers)

```bash
npm version patch -m "chore: release v%s" && git push --follow-tags
```

The message is the one `sync.yml` uses; without `-m`, npm titles the commit with the bare version number.

What the release workflow does, and what to check before a release, is in [docs/development.md](docs/development.md#releasing-to-npm). If the MCP registry refuses the listing, the package is already out; publish the listing by hand from the released tag ([docs/agents.md](docs/agents.md#mcp-registry)):

```bash
mcp-publisher validate && mcp-publisher publish
```

## Legal note

HackTricks content belongs to HackTricks / Carlos Polop and contributors. This repo contains derived index data plus original MIT-licensed code. Keep the attribution in `LICENSE` intact.
