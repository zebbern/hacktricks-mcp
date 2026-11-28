# Tool reference

This is the single source of truth for the MCP tools exposed by hacktricks-mcp. The README only carries a summary table; keep details here.

All four tools are read-only (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`) and answer from a local index. No network access happens at query time. The only network use is a background check for a newer index ([architecture.md](architecture.md#runtime-index-refresh)), which never delays a call.

The index holds two books, and every page says which one it is from in `book`: `hacktricks` (the [HackTricks](https://hacktricks.wiki) book, about 1,150 pages) and `hacktricks-cloud` ([HackTricks Cloud](https://cloud.hacktricks.wiki), about 1,800 pages: AWS, GCP, Azure, Kubernetes, CI/CD). It also holds HackTricks Cloud's permission data for the fourth tool.

## hacktricks_search

Ranked full-text search over the indexed pages of both books.

**Parameters**

| Name | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Technical terms or a plain question, e.g. `"kerberoast"`, `"aws s3 enumeration"` or `"how do I abuse unconstrained delegation"` |
| `category` | string | none | Restrict to one category of the table of contents, substring match, e.g. `"Linux"` or `"Pentesting CI/CD"`. `hacktricks_get_toc` lists them. Only useful when the top hits are for the wrong platform. |
| `limit` | integer | 10 | Max results, 1 to 25 |

**Ranking**

A query can be a question in plain words; the engine finds the terms in it.

1. Filler words are dropped from queries of more than three words, and abbreviations are expanded (see below).
2. Two candidate pools are taken by FTS5 BM25 (column weights: title 10, path 8, category 5, content 1, porter stemming): pages containing every *specific* term (one found in at most 20% of pages), and pages containing any term. A question often carries an incidental word that the best page does not use, so matching every word is not required.
3. The pool is ranked by *name credit*, a likelihood ratio on how few pages name each query term in their title or path, plus a bonus for containing every specific term. That ranks the page named after the technique above hub pages that merely contain the words. Two rules keep the credit honest:
   - A term is matched in titles and paths by its stem, so `escalate` matches `escalation` and `privileges` matches `privilege`.
   - A term found in at least half of the pages takes no part, neither gaining nor costing, unless the pages that contain it name it in their title or path at least 5% of the time. Few titles name `id`, so by name rarity alone it was worth as much as a technique name, and "Az - Entra ID Logs" outranked "Az - EntraID Privesc" for a question about privilege escalation. `post`, on the other hand, is in 61% of the pages because Cloud pages repeat their phase names, and a quarter of the pages that contain it name it; left out, "S3 post exploitation" returned S3 privesc and enum pages first.

Measured on `tests/scenarios.json` (89 questions, each asked two ways; see [development.md](development.md#evaluating-quality)). An agent is counted as finding the page when an expected page is among the five results:

| Question | Right page after one search | Right page first | Right page after the route the skill gives |
|---|---|---|---|
| names the technique | 80 of 89 | 64 of 89 | 89 of 89 |
| only describes the situation, searched as typed | 48 of 89 | 22 of 89 | 89 of 89 |

The route the skill gives is: the permissions check for a question that names cloud permissions, otherwise a search with the technique's name, then with the question as typed, then listing the topic with `hacktricks_get_toc`. It reaches the same pages whichever way the question is asked, which is why the skill tells agents to name the technique first.

**Abbreviations**

The following expand automatically at query time: `privesc`, `privescalation`, `sqli`, `rce`, `lfi`, `rfi`, `xss`, `csrf`, `ssrf`, `ssti`, `xxe`, `idor`, `lpe`, `deserial`, `revshell`. The list lives in `src/db.ts` (`ALIASES`).

**Returns** (structured): `results[]` with `pageId`, `book`, `path`, `title`, `category`, `url`, `wikiUrl`, `chars`, `snippet`.

- `url` is the markdown source on GitHub. `wikiUrl` is the page on the public wiki, the link to cite; it is empty for the three pages the wiki does not publish (the licence file and the training banner).
- `chars` is the page's length: under about 8,000 is cheap to read whole, above that read the outline first.
- Pass `path` to `hacktricks_get_page`.

## hacktricks_get_page

Reads one page from the index.

**Parameters**

| Name | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Page path from search, e.g. `windows-hardening/active-directory-methodology/kerberoast.md`. Unique suffixes like `kerberoast` also work. |
| `book` | string | main book wins | `hacktricks` or `hacktricks-cloud`. Only `README.md` and `banners/hacktricks-training.md` exist in both books; use it to pick one of those. |
| `outlineOnly` | boolean | false | Return the headings with the size of each section and no content. Use it to choose a section before reading. Takes precedence over `section` and `codeOnly`. |
| `section` | string | none | Extract one section by heading text (case-insensitive substring match; marks for code style and emphasis are ignored, so a heading printed without its backticks still matches) |
| `codeOnly` | boolean | false | Return only fenced code blocks (commands and payloads) |
| `offset` | integer | 0 | Skip this many characters of the page or section. A cut response ends with the offset where the rest continues. |

**Behavior**

- The first lines give the title and the link to cite: the page on the public wiki, where a `README.md` is the index of its folder (`.../aws-iam-privesc/`), or the GitHub source for a page the wiki does not publish.
- `outlineOnly` is the cheap first read for a long page: about 800 characters for the median page and under 1,800 for nine pages in ten, against a median page of about 10,800 characters in the main book and 7,100 in the Cloud book. Each heading carries the length of its section, cut the way `section` cuts it, and a heading whose section is mostly subsections says so (`24,716 chars in 19 subsections`).
- Without `section`, returns the full cleaned page. Text comes in slices of 20,000 characters: a slice that is cut appends the heading outline, so the caller can pick a section, and ends with `offset=<n>` for the rest. A section without subsections that is longer than 20,000 characters is read the same way, slice by slice.
- Unknown `section` returns an error listing the available headings, so the agent can self-correct.
- Content is pre-cleaned at index time: GitBook hint banners, include directives and badge images are removed.

**Returns** (structured): `title`, `book`, `path`, `url`, `wikiUrl`, `outline`, `content`, `truncated`, `nextOffset` (where a cut text continues; absent when everything was returned).

## hacktricks_get_toc

Returns the tables of contents of both books, parsed from each book's upstream `src/SUMMARY.md`.

**Parameters**

| Name | Type | Default | Description |
|---|---|---|---|
| `category` | string | none | Text filter on entry titles, case-insensitive, e.g. `"Kerberos"`, `"Key Vault"` or `"AWS - IAM"`. Omit for the overview. |

**Returns** (structured): `categories[]` (`book`, `category`, `pages`) and `tree` (text).

- Without `category`, `tree` is a map of about 17,000 characters. For each book it lists the categories and, under them, the chapters with the number of pages they hold (`AWS Pentesting (816 pages)`). It carries no page paths, so it replaces a full listing of about 90,000 characters. Its first line states the page count and sync time of the index in use.
- With `category`, `tree` holds every entry whose title contains the text, with everything under it and its path, from both books. `Kerberos` or `Key Vault` return a few kilobytes, `K8s` every Kubernetes page (about 8,000 characters); a broad word is cut at 300 lines.
- Entries that only link to another site are left out.

## hacktricks_cloud_permissions

Checks cloud permissions against HackTricks Cloud: how dangerous each permission is, and which privilege escalation techniques the held set enables.

**Parameters**

| Name | Type | Default | Description |
|---|---|---|---|
| `provider` | string | required | `aws`, `gcp`, `azure` or `k8s` |
| `permissions` | string[] | required | The permissions held, as the cloud writes them: `iam:PassRole`, `iam.serviceAccounts.actAs`, `Microsoft.Authorization/roleAssignments/write`, `Application.ReadWrite.All`. Wildcards as in a policy (`iam:*`, `s3:Get*`). 1 to 200 entries. |
| `limit` | integer | 20 | How many escalation techniques to list at most, 1 to 100. The total is always reported. |

For Kubernetes, write one grant per entry as `verb resource[.group][/subresource]`, `verb *` or `verb /url`: `create pods`, `get secrets`, `create deployments.apps`, `create pods/exec`, `get *`, `impersonate users`. A resource written without its group matches any group. Anything else is refused with the expected form.

**What it answers from** (see [architecture.md](architecture.md#permission-data)):

- The book's rated list for the cloud: 51,928 permissions with a rating of `critical`, `high`, `medium` or `low`; a permission not on the list is `not rated`. A wildcard is matched against the whole list and summarised.
- The book's combination rules: a combination is held when every permission in it is held.
- The book's escalation catalog, 685 techniques: every technique whose required permissions are all held, each with the page section that explains it. Techniques of a service the held permissions belong to come first, then those that use more of them.
- Sections of the Cloud book whose heading names a held permission (`Microsoft.Authorization/roleAssignments/write`, `iam:PassRole (+ a compute service)`). The catalog does not cover everything the book describes.
- For Kubernetes, the book's 68 permission rules: the first rule a grant matches gives its rating.

**What it does not evaluate**: resources, scopes, request conditions and the properties of the target. A technique is listed when every permission it names is held, and may still be blocked in practice; its `conditions` and `blockers` say what to check. Techniques that depend on such facts (28 of the 685) are never listed, and four constrained-impersonation techniques of Kubernetes use a matching rule that is not evaluated. The result says so.

**Returns** (structured):

- `risk[]`: `permission`, `severity`, and `note` (what a wildcard matches, or the rule a Kubernetes grant trips).
- `combinations[]`: `severity`, `permissions`.
- `escalation[]`: `id`, `service`, `title`, `summary`, `severity`, `confidence`, `needs`, `gains`, `conditions`, `blockers`, `mitigation`, `page`, `section`. `page` and `section` are the arguments for `hacktricks_get_page`.
- `escalationTotal`, `notEvaluated`, `sections[]` (`permission`, `page`, `heading`).

A call costs about 1,000 to 3,000 characters when a few techniques apply and about 19,000 for a permission such as `iam:PassRole` that enables dozens.

## Recommended agent workflow

1. A question that names cloud permissions goes to `hacktricks_cloud_permissions`; read the page sections it points to.
2. Otherwise `hacktricks_search` with the technique's name, or with the question as typed.
3. `hacktricks_get_page` with `outlineOnly` on the best hit, then with `section` or `codeOnly` on the part that answers.
4. Only read full pages when the outline is not enough.

For a cloud service, `hacktricks_get_toc` with the service name is often the better first call: it lists the pages of that service across enumeration, privilege escalation, post exploitation and persistence in a few kilobytes.

This pattern keeps typical lookups under 1,000 tokens of context.
