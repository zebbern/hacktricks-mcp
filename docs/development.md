# Development

Local setup, testing and releasing. Pipeline internals are in [architecture.md](architecture.md); tool behavior is in [tools.md](tools.md).

## Setup

```bash
git clone https://github.com/zebbern/hacktricks-mcp.git
cd hacktricks-mcp
npm install
```

Requires Node.js 22.13 or newer.

## Scripts

| Command | What it does |
|---|---|
| `npm run sync` | Fetch upstream (if changed) and rebuild `data/` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run eval` | Search-quality gate: fixtures from `tests/queries.json` |
| `npm run eval:strategies` | Search-quality report: which query styles find the right page (build first) |
| `npm run smoke` | End-to-end MCP test over stdio against the built server |
| `npm start` | Run the built server on stdio |

Typical loop after touching `src/db.ts` or `src/markdown.ts`:

```bash
rm data/hacktricks.db   # force a rebuild even if upstream SHA is unchanged
npm run sync && npm run build && npm run eval && npm run eval:strategies && npm run smoke
```

## Evaluating search quality

Two evals with different jobs: one decides whether a change may ship, the other says what the change is worth.

**`npm run eval` is the gate.** The 30 fixtures in `tests/queries.json` are keyword queries with one expected page each. CI and the release workflow fail below 80%, so keep it at 30/30. Add a fixture when you fix or change ranking behavior:

```json
{ "query": "smb relay attack", "expectPath": "ntlm", "category": "Windows Hardening" }
```

`expectPath` is a substring matched against result paths; a query passes when any top-5 hit matches.

**`npm run eval:strategies` is the measurement.** `tests/scenarios.json` holds realistic asks with the pages that answer them, each written twice: `named` (the ask names the technique) and `goal` (it only describes the situation). The harness runs every ask through several query styles against the built server and reports where the expected page lands:

```bash
npm run build && npm run eval:strategies          # tables
npm run eval:strategies -- --csv                  # the same numbers, one row per style
npm run eval:strategies -- --misses verbatim      # what one style fails to find
```

It is a report, not a gate. Use it to compare a ranking change before and after, and to decide what the skill should tell agents, rather than assuming one query style is better. Scenarios whose pages upstream has removed are skipped, so the report survives index syncs.

Reference numbers, index of 1,149 pages at upstream `a94845e` (2026-11-27). Share of asks with the expected page in the top 5:

| Query style | Ask names the technique | Ask only describes the goal |
|---|---|---|
| question as typed | 99% | 54% |
| 3 most specific words | 96% | 49% |
| 2 most specific words | 93% | 48% |
| 1 most specific word | 86% | 30% |

The same harness put the question as typed at 45% and 13% before the ranking rework, when every word of a query was mandatory and long hub pages crowded out the page named after the technique. Two lessons went into the skill from that: agents can type the question as it comes, and when a search misses it is vocabulary that needs changing, not phrasing.

To add a scenario, append to `tests/scenarios.json`:

```json
{
  "id": "shadow-credentials",
  "area": "windows",
  "expect": ["shadow-credentials.md"],
  "named": "How do Shadow Credentials work and how do I abuse them with certipy?",
  "goal": "How can I add my own key pair to a computer or user object, authenticate as it, and get its NT hash?"
}
```

`expect` holds path suffixes, the best page first. Write `named` as a user who knows the term would, and `goal` without it. `area` only groups the report.

## Releasing to npm

The package name is `@zebbern/hacktricks-mcp` (the unscoped name is taken by an unrelated project).

### One-time manual publish

The first publish must come from a logged-in machine:

```bash
npm login
npm publish --access public
```

`prepublishOnly` runs the build automatically. The published tarball includes `dist/` and the current `data/` index.

### Automated releases (trusted publishing)

Everything runs off version tags:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

`npm version` automatically runs `scripts/version-sync.mjs` (npm lifecycle hook), which stamps the new version into `server.json`, the three plugin manifests and the marketplace entry, and stages them, so the version commit is always consistent. `kimi-plugin/kimi.plugin.json` is excluded on purpose: the Kimi marketplace manages its own numbering.

Index-only releases need no manual step: `sync.yml` runs the same two commands itself whenever the index changes (see [architecture.md](architecture.md#sync-automation)). Bump by hand only for code changes.

The `release.yml` workflow then: rebuilds and quality-gates the index, creates the GitHub Release with the index assets, and publishes to npm via OIDC trusted publishing (no `NPM_TOKEN` anywhere). MCP registry publishing is intentionally local, see [agents.md](agents.md#mcp-registry).

One-time prerequisites (already done for this repo): the first publish was manual (`npm publish --access public`), and the trusted publisher is configured on npmjs.com for `zebbern/hacktricks-mcp` + `release.yml`.

### What ships in the package

Defined by `files` in `package.json`: `dist/`, `data/hacktricks.db`, `data/toc.json`, `data/meta.json`. The index inside the package is whatever the last sync committed, and every sync publishes a release, so users always get the freshest index that passed the eval gate.

## CI

- `ci.yml` on push/PR: typecheck, build, full index rebuild, eval, stdio smoke test, strategy report.
- `sync.yml` every 3 days: index rebuild plus an automatic patch release, see [architecture.md](architecture.md#sync-automation).
