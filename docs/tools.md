# Tool reference

Parameters, limits and rules of the four tools. All are read-only and answer from a local index; the only network use is a background check for a newer index ([architecture.md](architecture.md#runtime-index-refresh)), which never delays a call.

Every page names its book in `book`: `hacktricks` (the [HackTricks](https://hacktricks.wiki) book, about 1,150 pages) or `hacktricks-cloud` ([HackTricks Cloud](https://cloud.hacktricks.wiki), about 1,800 pages), which also supplies the permission data behind the fourth tool.

## hacktricks_search

Ranked full-text search over the pages of both books.

| Name | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Technical terms or a plain question, e.g. `"kerberoast"`, `"aws s3 enumeration"` or `"how do I abuse unconstrained delegation"`. The first 32 terms are searched, and the answer says so when it had to leave some out. |
| `category` | string | none | Restrict to one category of the table of contents, substring match, e.g. `"Linux"` or `"Pentesting CI/CD"`; `hacktricks_get_toc` lists them. Only useful when the top hits are for the wrong platform. At most 200 characters. |
| `limit` | integer | 10 | Max results, 1 to 25 |

**Ranking**

1. The query is cut into terms at whitespace and at the separators of a permission or a path (`iam:PassRole`, `a/b.md`), and each term counts once. Filler words are dropped from queries of more than three words, and abbreviations are expanded.
2. Two candidate pools are taken by FTS5 BM25 (column weights: title 10, path 8, category 5, content 1, porter stemming): pages containing every *specific* term (one found in at most 20% of pages), and pages containing any term, because a question often carries an incidental word that the best page does not use.
3. The pool is ranked by *name credit*, a likelihood ratio on how few pages name each query term in its title or path, plus a bonus for containing every specific term. That puts the page named after the technique above hub pages that merely contain the words. Two rules keep the credit honest:
   - A term is matched in titles and paths by its stem, so `escalate` matches `escalation`.
   - A term found in at least half of the pages takes no part, unless the pages that contain it name it in its title or path at least 5% of the time. `id` is everywhere and rarely named; `post` is everywhere because Cloud pages repeat their phase names, and there it is what the page is about.

**Abbreviations**

`privesc`, `privescalation`, `sqli`, `rce`, `lfi`, `rfi`, `xss`, `csrf`, `ssrf`, `ssti`, `xxe`, `idor`, `lpe`, `deserial` and `revshell` expand at query time. The list is `ALIASES` in `src/db.ts`.

**Measured** on `tests/scenarios.json` (89 questions, each asked two ways; [development.md](development.md#evaluating-quality)). A question counts as found when an expected page is among the five results.

| Question | Found after one search | Found first | Found after the route the skill gives |
|---|---|---|---|
| names the technique | 85 of 89 | 79% | 89 of 89 |
| only describes the situation, searched as typed | 51 of 89 | 26% | 89 of 89 |

**Returns** (structured): `results[]` with `pageId`, `book`, `path`, `title`, `category`, `url`, `wikiUrl`, `chars`, `snippet`.

- `url` is the markdown source on GitHub. `wikiUrl` is the page on the public wiki, the link to cite; it is empty for the few pages the wiki does not publish.
- `chars` is the page's length: under about 8,000 is cheap to read whole, above that read the outline first.
- Pass `path` to `hacktricks_get_page`.

## hacktricks_get_page

Reads one page from the index.

| Name | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Page path from search, e.g. `windows-hardening/active-directory-methodology/kerberoast.md`. The ending of a path (`ntlm/README.md`) and a file name without `.md` (`kerberoast`) also work. At most 1,000 characters. |
| `book` | string | main book wins | `hacktricks` or `hacktricks-cloud`. Only `README.md` and `banners/hacktricks-training.md` exist in both books; use it to pick one of those. |
| `outlineOnly` | boolean | false | Return the headings with the size of each section and no content. Takes precedence over `section` and `codeOnly`. |
| `section` | string | none | Extract one section. A heading with exactly that text is preferred, else the first whose text contains it. Marks, footnote links and double spaces do not count. The answer says when several sections share the name, or when none has the text exactly. |
| `codeOnly` | boolean | false | Return only the fenced code blocks (commands and payloads), each with the language after its fence and the label above it when the page gives one |
| `offset` | integer | 0 | Skip this many characters of the page or section. A cut response ends with the offset where the rest continues. |

**Rules**

- The first lines give the title and the link to cite: the page on the public wiki, where a `README.md` is the index of its folder (`.../aws-iam-privesc/`), or the GitHub source for a page the wiki does not publish. Footnote links are not shown.
- `outlineOnly` is the cheap first read for a long page: a median of 688 characters, and nine pages in ten under 1,382, against a median page of about 10,800 characters in the main book and 7,100 in the Cloud book ([what a read costs](development.md#what-a-read-costs)). Each heading carries the length of its section, and a heading whose section is mostly subsections says so (`24,716 chars in 19 subsections`).
- Without `section`, returns the whole page in slices of 20,000 characters. A slice that is cut appends the heading outline and ends with `offset=<n>` for the rest. A section without subsections that is longer than 20,000 characters is read the same way.
- A path is matched as it is, then as the whole ending of a path (with or without `.md`), then as a piece that exactly one page has. A piece that several pages have is not read as one of them: `"kerberos"`, which lies in six paths, returns an error that lists them, and a piece that lies in at least half of the paths (`"e"`) returns only how common it is.
- Content is cleaned at index time outside code blocks, and nothing inside a code block is touched ([architecture.md](architecture.md#markdown-cleaning)).

**Returns** (structured): `title`, `book`, `path`, `url`, `wikiUrl`, `outline`, `content`, `truncated`, `nextOffset` (where a cut text continues; absent when everything was returned).

## hacktricks_get_toc

Returns the tables of contents of both books, parsed from each book's upstream `src/SUMMARY.md`.

| Name | Type | Default | Description |
|---|---|---|---|
| `category` | string | none | Text filter on entry titles, case-insensitive, e.g. `"Kerberos"`, `"Key Vault"` or `"AWS - IAM"`. Omit for the overview. |

**Returns** (structured): `categories[]` (`book`, `category`, `pages`) and `tree` (text).

- Without `category`, `tree` is a map of about 17,000 characters: for each book its categories and, under them, the chapters with the number of pages they hold (`AWS Pentesting (816 pages)`). It carries no page paths, so it replaces a full listing of about 90,000 characters. Its first line states the page count and sync time of the index in use.
- With `category`, `tree` holds every entry whose title contains the text, with everything under it and its path, from both books. `Kerberos` or `Key Vault` return a few kilobytes, `K8s` every Kubernetes page (about 8,000 characters); a broad word is cut at 300 lines.
- Entries that only link to another site are left out.

## hacktricks_cloud_permissions

Checks cloud permissions against HackTricks Cloud: how dangerous each permission is, and which privilege escalation techniques the held set enables.

| Name | Type | Default | Description |
|---|---|---|---|
| `provider` | string | required | `aws`, `gcp`, `azure` or `k8s` |
| `permissions` | string[] | required | The permissions held, as the cloud writes them: `iam:PassRole`, `iam.serviceAccounts.actAs`, `Microsoft.Authorization/roleAssignments/write`, `Application.ReadWrite.All`. Wildcards as in a policy: `*` for any run of characters (`iam:*`, `s3:Get*`) and `?` for one. 1 to 200 entries, each at most 500 characters. Several permissions pasted into one entry (`iam:PassRole, lambda:CreateFunction`) are rated each. |
| `limit` | integer | 20 | How many escalation techniques to list at most, 1 to 100. The total is always reported. |

For Kubernetes, write one grant per entry as `verb resource[.group][/subresource]`, `verb *` or `verb /url`: `create pods`, `get secrets`, `create deployments.apps`, `create pods/exec`, `get *`, `impersonate users`. A resource written without its group matches any group. Anything else is refused with the expected form.

**What it answers from** ([architecture.md](architecture.md#permission-data)):

- The book's rated list for the cloud, 51,928 permissions rated `critical`, `high`, `medium` or `low`; a permission not on the list is `not rated`. A wildcard is matched against the whole list and summarised.
- The book's combination rules: one is held when every permission in it is held.
- The book's escalation catalog, 685 techniques: every technique whose required permissions are all held, each with the page section that explains it. Techniques of a service the held permissions belong to come first, then those that use more of them.
- Sections of the Cloud book whose heading names a held permission (`Microsoft.Authorization/roleAssignments/write`, `iam:PassRole (+ a compute service)`), because the catalog does not cover everything the book describes.
- For Kubernetes, the book's 68 rules: the first rule a grant matches gives its rating.

**What it does not evaluate**: resources, scopes, request conditions and the properties of the target. A technique is listed when every permission it names is held and may still be blocked in practice; its `conditions` and `blockers` say what to check. The 28 techniques that depend on such facts are never listed, and four constrained-impersonation techniques of Kubernetes use a matching rule that is not evaluated. The result says so.

**Returns** (structured):

- `risk[]`: `permission`, `severity`, and `note` (what a wildcard matches, or the rule a Kubernetes grant trips). A permission given twice is rated once.
- `combinations[]`: `severity`, `permissions`. The 25 most severe at most; `combinationsTotal` says how many are held.
- `escalation[]`: `id`, `service`, `title`, `summary`, `severity`, `confidence`, `needs`, `gains`, `conditions`, `blockers`, `mitigation`, `page`, `section`. `page` and `section` are the arguments for `hacktricks_get_page`.
- `escalationTotal`, `combinationsTotal`, `notEvaluated`, `sections[]` (`permission`, `page`, `heading`).

A call returns about 1,000 to 3,000 characters when a few techniques apply and about 19,000 for a permission such as `iam:PassRole` that enables dozens. The size follows `limit`: `*` returns 26,653 characters with the default 20 techniques and about 100,000 with 100.

## Input limits

| Field | Limit | Longer input |
|---|---|---|
| `hacktricks_get_page` `path` | 1,000 characters | Refused by the schema |
| `hacktricks_search` `category` | 200 characters | Refused by the schema |
| `hacktricks_cloud_permissions` `permissions`, each | 500 characters | Refused by the schema |
| `hacktricks_search` `query` | 32 terms searched | Answered; the answer says how many terms were left out |
| `hacktricks_get_page` `section`, `hacktricks_get_toc` `category` | none | Answered |

A path, a category and a permission are short by nature, so a longer one is pasted text. A query may be a pasted page and is searched, not echoed: an answer quotes an input in at most 120 characters and gives its length.

## Using the tools

`skills/hacktricks/SKILL.md` is the full guidance for agents. In short: a question that names cloud permissions goes to `hacktricks_cloud_permissions`; anything else starts with `hacktricks_search`, naming the technique where it can, and reads the best hit by outline and section rather than whole. For a cloud service, `hacktricks_get_toc` with the service name often is the better first call: it lists the pages of that service across enumeration, privilege escalation, post exploitation and persistence in a few kilobytes.
