# Contributing

Thanks for improving hacktricks-mcp. This project has a few structural invariants that exist for good reasons. Please read this file before your first PR; CI enforces most of it, but understanding the why saves everyone time.

## Project invariants

### 1. One canonical skill

`skills/hacktricks/SKILL.md` is the only hand-edited skill file. It follows the [Agent Skills](https://agentskills.io) standard (spec-clean frontmatter: `name` + `description` only; vendor-specific fields break other hosts).

- Claude Code and Codex plugins read this file directly from the plugin root. Do not create copies for them.
- `kimi-plugin/skills/hacktricks/SKILL.md` is a generated copy (Kimi plugins install as self-contained directories). Never edit it by hand. Run `npm run sync:skills` after touching the canonical file. CI fails on drift.
- The `description` frontmatter is the trigger that decides whether agents load the skill. Treat it as a public API: specific, keyword-rich, under 1024 chars.

### 2. Version consistency

`npm version patch|minor|major` is the only way to bump versions. The lifecycle hook stamps `server.json` (including `packages[].version`), `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json` and stages them into the version commit. Never hand-edit version fields in those files.

Exception: `kimi-plugin/kimi.plugin.json` is versioned by the Kimi marketplace tooling (`+local` timestamps), not by npm.

### 3. The index is generated, but committed

`data/` is produced by `npm run sync` from upstream HackTricks and is committed to the repo (so clones and the npm package work out of the box). Do not hand-edit `data/hacktricks.db`, `data/toc.json`, or `data/meta.json`. The sync workflow re-runs every 3rd day; manual syncs happen via `npm run sync`.

### 4. Search quality is gated

Any change to `src/db.ts` (ranking, aliases) or `src/markdown.ts` (cleaning) must keep `npm run eval` at 30/30. If a legitimate ranking change breaks a fixture, discuss in the PR whether the fixture or the ranking is wrong, then update `tests/queries.json` deliberately, never to just make CI green.

### 5. Docs are DRY

Each topic has exactly one home: tool API in `docs/tools.md`, pipeline in `docs/architecture.md`, dev/release flow in `docs/development.md`, ecosystem packaging in `docs/agents.md`. The README links out instead of repeating details. No em-dashes in any markdown (project style).

## Development loop

```bash
npm install
npm run sync                 # build the index
# ... edit src/ ...
npm run build && npm run eval && npm run smoke
```

Add an eval fixture in `tests/queries.json` when you add or change search behavior. See [docs/development.md](docs/development.md) for details.

## Releasing (maintainers)

```bash
npm version patch && git push --follow-tags
```

This triggers `release.yml`: full quality gates, GitHub Release with index assets, npm publish via OIDC trusted publishing. Afterwards, bump the MCP registry listing locally:

```bash
mcp-publisher publish
```

See [docs/agents.md](docs/agents.md) for registry rules (`mcpName`, version match, 100-char description cap).

## Legal note

HackTricks content belongs to HackTricks / Carlos Polop and contributors. This repo contains derived index data plus original MIT-licensed code. Keep the attribution in `LICENSE` intact.
