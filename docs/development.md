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
| `npm run eval` | Search-quality fixtures from `tests/queries.json` |
| `npm run smoke` | End-to-end MCP test over stdio against the built server |
| `npm start` | Run the built server on stdio |

Typical loop after touching `src/db.ts` or `src/markdown.ts`:

```bash
rm data/hacktricks.db   # force a rebuild even if upstream SHA is unchanged
npm run sync && npm run eval && npm run build && npm run smoke
```

## Adding an eval fixture

Append to `tests/queries.json`:

```json
{ "query": "smb relay attack", "expectPath": "ntlm", "category": "Windows Hardening" }
```

`expectPath` is a substring matched against result paths; a query passes when any top-5 hit matches. Keep fixtures realistic: phrases a pentester or agent would actually type.

## Releasing to npm

The package name is `@zebbern/hacktricks-mcp` (the unscoped name is taken by an unrelated project).

### One-time manual publish

The first publish must come from a logged-in machine:

```bash
npm login
npm publish --access public
```

`prepublishOnly` runs the build automatically. The published tarball includes `dist/` and the current `data/` index.

### Automated releases (trusted publishing, recommended)

After the first manual publish:

1. On npmjs.com, open the package settings and add a **trusted publisher**: GitHub Actions, repo `zebbern/hacktricks-mcp`, workflow `release.yml`.
2. Then releasing is just:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

The `release.yml` workflow publishes with `--provenance` using OIDC. No npm token is stored anywhere.

### What ships in the package

Defined by `files` in `package.json`: `dist/`, `data/hacktricks.db`, `data/toc.json`, `data/meta.json`. The index inside the package is whatever the last sync committed, so cutting a release right after a sync gives users the freshest content.

## CI

- `ci.yml` on push/PR: typecheck, build, full index rebuild, eval, stdio smoke test.
- `sync.yml` every 3 days: see [architecture.md](architecture.md#sync-automation).
