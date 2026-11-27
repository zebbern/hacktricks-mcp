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
| `npm run sync` | Fetch both upstream books (if changed) and rebuild `data/` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run eval` | Keyword gate: fixtures from `tests/queries.json` |
| `npm run eval:workflow` | Agent gate: whether the skill's route finds the page for every scenario question (build first) |
| `npm run eval:permissions` | Permissions gate: the permissions check against the whole catalog and against hand-checked cases |
| `npm run smoke` | End-to-end MCP test over stdio against the built server |
| `npm run smoke:refresh` | End-to-end test of the background index refresh (build first) |
| `npm start` | Run the built server on stdio |

Typical loop after touching `src/db.ts`, `src/toc.ts`, `src/markdown.ts`, `src/permissions.ts` or `src/permission-check.ts`:

```bash
rm data/hacktricks.db   # force a rebuild even if the upstream SHAs are unchanged
npm run sync && npm run build && npm run eval && npm run eval:workflow && npm run eval:permissions && npm run smoke && npm run smoke:refresh
```

The sync skips the rebuild when `data/meta.json` carries the same upstream SHAs and the same `schema` as `INDEX_SCHEMA` in `src/db.ts`. Bump that constant when your change alters what the indexer writes, so CI, the release workflow and every clone rebuild too.

## Evaluating quality

Three evals, and all are gates. An agent has to find the page for nearly every question, whichever way the question is asked, and the permissions check has to be faithful to the book; a change that lowers any of the numbers does not ship.

**`npm run eval` is the keyword gate.** The 42 fixtures in `tests/queries.json` are short keyword queries with one expected page each, 12 of them for the Cloud book. A query passes when an expected page is among the top 5. CI, the sync workflow and the release workflow fail below 80%, so keep it at 42/42. Add a fixture when you fix or change ranking behavior:

```json
{ "query": "smb relay attack", "expectPath": "ntlm", "category": "Windows Hardening" }
```

`expectPath` is a substring matched against result paths.

**`npm run eval:workflow` is the agent gate.** `tests/scenarios.json` holds 89 realistic questions with the pages that answer them, each written twice: `named` (the question names the technique) and `goal` (it only describes the situation). The harness plays the steps of the skill against the built server over stdio and reports where each route ends and what it reads:

```bash
npm run build && npm run eval:workflow       # tables
npm run eval:workflow -- --misses           # what the skill's route does not find
```

The steps are `hacktricks_cloud_permissions` for a question that names cloud permissions, a search with the question (`limit` 5), a search with the technique's name (the `named` form of the question), and `hacktricks_get_toc` with the cloud's word (`K8s`, `AWS - `) or with the rarest topic words of the question. A question is found when an expected page is among the results of a step. The last route of each table is what the skill tells agents to do; the run fails when that route finds the page for less than 90% of the questions, asked either way.

Reference numbers, index of 2,952 pages at upstream `d2a6bf0` and `49dae14` (2026-11-27; the same on the previous main-book commit):

| Route | Found | Calls | Characters read |
|---|---|---|---|
| The question names the technique: permissions check alone (6 of the 89 questions name permissions) | 6 of 89 | 0.08 | 345 |
| The question names the technique: search only | 80 of 89 | 1.00 | 1,953 |
| The question names the technique: the skill's route | 89 of 89 | 1.06 | 2,461 |
| The question only describes the situation: permissions check alone | 6 of 89 | 0.07 | 340 |
| The question only describes the situation: search as typed only | 48 of 89 | 1.00 | 1,930 |
| The same: as typed, then with the technique's name | 82 of 89 | 1.46 | 2,829 |
| The same: name first, then as typed | 82 of 89 | 1.10 | 2,152 |
| The same: the skill's route | 89 of 89 | 1.09 | 2,461 |

What follows, and all of it is in the skill:

- A single search for a question that only describes a situation is never the real outcome: it finds the page for 48 of 89. Naming the technique first reaches 82 with 1.10 calls, where typing the question first and adding the name on a miss needs 1.46.
- The first hit is the right page for 64 of the 89 questions that name the technique (72%, a share the gate prints under its tables), and for a quarter of them when the question only describes the situation, so the titles below it still have to be read.
- A question that names permissions is a lookup, not a search. The plain search finds the page for 1 of the 6 permission questions; the permissions check finds all 6, with the page section to read.
- One Kubernetes question ("How do I escalate privileges inside a Kubernetes cluster?") is not answered by a search and is found by listing the provider's pages (`K8s`, 56 entries). The harness counts a page that is in a listing as found, so there the agent still has to pick the right title.

What the harness cannot see: whether a live agent names the technique as the scenario's `named` question does, and whether it picks the right title from a listing. Those steps are the agent's own, and only a live run shows them; the run of 2026-11-27 is recorded in [agents.md](agents.md).

Scenarios whose pages upstream has removed are skipped. `area` groups the report.

**`npm run eval:permissions` is the permissions gate.** It checks `hacktricks_cloud_permissions` two ways. Against the catalog by construction: every technique that names permissions the check evaluates (657 of 685) is listed when exactly those are held, and each of the 519 plain conjunctions is not listed without the grants that satisfy one of its requirements. Against `tests/permissions.json`: 17 cases with the expected rating (including pasted permissions in another case or with stray spaces, and a GCP role name, which is not a permission), the techniques that must and must not be listed, the first technique and a page section. Four techniques are known not to be evaluated and are named in the script; a fifth that is not listed from its own permissions fails the run. Add a case when you change the matcher or the indexer's permission step, and look the answer up in the book's data rather than copying it from the tool.

**Changes are measured here, and the misses are recorded too.** The ideas below were measured on this question set and rejected; check the list before trying one again:

- Match titles by the exact start of a word (the state before stems): `escalate privileges` earned nothing on a page called `IAM Privesc` under `gcp-privilege-escalation/`.
- Leave out every term found in at least half of the pages, with no exception: `post` and `exploitation` were left out because Cloud pages repeat their phase names, and "S3 post exploitation" returned S3 privesc and enum pages first.
- No name credit for any term above the 20% line that defines *specific*: the gate fell to 38 of 42.
- On equal credit, prefer the shorter title (the more general page): the gate fell to 41 of 42.
- Order the credit-ranked half of the candidate pool by credit with relevance as the tie-break: no question moved.
- Cap the credit of very common words at a small value instead of leaving them out: "S3 post exploitation" gained, "Entra ID privilege escalation" and two situational questions lost.
- Scale every common word's credit down with how common it is: the gate fell to 38 of 42, because ordinary topic words such as "password" are everywhere too.
- Adding a phase word to a Cloud question (`aws iam privesc` instead of the sentence): no gain.
- Weighting a page's headings or its first prose higher than its body: one or two questions moved, in either direction.
- Questions bound to pages as recognisers, the page of the closest bound question first. Tried with the scenario pairs: the closest bound question is right for 31 of 83 situational questions, where the plain search finds 46. As a second opinion it helps (the right bound question is among the closest three for 64), but it needs a source of questions for every page, so it is not built.

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

`expect` holds path suffixes, the best page first. Write `named` as a user who knows the term would, and `goal` without it. For Cloud pages use a suffix that ends the path (`aws-iam-privesc/README.md`), and check that the page really answers the question: `npm run eval:workflow -- --misses` lists what is not found. A permission question names the permissions as the cloud writes them, and its expected page is one the permissions check points to.

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
npm version patch -m "chore: release v%s"   # or minor / major
git push --follow-tags
```

Run `npm run sync` first. The release job rebuilds the index in its own runner and publishes that, so a committed index that is behind upstream would ship a newer index than the commit holds, and the next sync would publish a second patch for the same content.

`npm version` automatically runs `scripts/version-sync.mjs` (npm lifecycle hook), which stamps the new version into `server.json`, the three plugin manifests and the marketplace entry, and stages them, so the version commit is always consistent. `kimi-plugin/kimi.plugin.json` is excluded on purpose: the Kimi marketplace manages its own numbering.

Index-only releases need no manual step: `sync.yml` runs the same two commands itself whenever the index changes (see [architecture.md](architecture.md#sync-automation)). Bump by hand only for code changes.

The `release.yml` workflow then: rebuilds the index and runs all three quality gates, creates the GitHub Release with the three index files attached (`hacktricks.db`, `toc.json`, `meta.json`), publishes to npm via OIDC trusted publishing (no `NPM_TOKEN` anywhere), and then removes those files from every older release; a failed removal does not fail the release. The attached files are what a running server downloads when it finds a newer index ([architecture.md](architecture.md#runtime-index-refresh)). Last it publishes `server.json` to the MCP registry, again through OIDC ([agents.md](agents.md#mcp-registry)); a failure there fails the run, because the package is already out and only the listing would be behind.

One-time prerequisites (already done for this repo): the first publish was manual (`npm publish --access public`), and the trusted publisher is configured on npmjs.com for `zebbern/hacktricks-mcp` + `release.yml`.

### Before a release

The gates run inside the repository on CI's Node version, so they miss two things:

- **The packed package.** Install the tarball somewhere else and start it from another folder. A package that looked for its index next to the working directory would fail here and pass everywhere else.
- **The oldest Node that `engines` allows.** Run the gates and both smoke tests once on Node 22.13 or a later 22.x.

```bash
npm pack --pack-destination /tmp/ht-pack
npm install --prefix /tmp/ht-pack /tmp/ht-pack/zebbern-hacktricks-mcp-*.tgz
(cd /tmp && HACKTRICKS_OFFLINE=1 /tmp/ht-pack/node_modules/.bin/hacktricks-mcp </dev/null)
```

The last command must print `hacktricks-mcp running on stdio` and exit 0. It packs into `/tmp` so that no tarball is left in the repository. Finish with `mcp-publisher validate`, which checks `server.json` against the registry without publishing ([agents.md](agents.md#mcp-registry)).

### What ships in the package

Defined by `files` in `package.json`: `dist/`, `data/hacktricks.db`, `data/toc.json`, `data/meta.json`. The index inside the package is whatever the last sync committed, and every sync publishes a release, so users always get the freshest index that passed the gates.

The index is 64 MB unpacked, 57 MB of it the two books' pages and 7 MB the permission data, and makes the npm tarball 24 MB (12 MB for the main book alone). Each release also attaches the same index for the runtime refresh, and the workflow removes it from every older release after publishing, so the attachment does not pile up.

## CI

- `ci.yml` on push/PR: typecheck, build, full index rebuild, keyword gate, agent gate, permissions gate, stdio smoke test, refresh smoke test.
- `sync.yml` every 3 days: index rebuild plus an automatic patch release, see [architecture.md](architecture.md#sync-automation).
