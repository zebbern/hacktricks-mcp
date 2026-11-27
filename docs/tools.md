# Tool reference

This is the single source of truth for the MCP tools exposed by hacktricks-mcp. The README only carries a summary table; keep details here.

All three tools are read-only (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`) and fully local. No network access happens at query time.

## hacktricks_search

Ranked full-text search over the indexed HackTricks pages.

**Parameters**

| Name | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Technical terms or a plain question, e.g. `"kerberoast"` or `"how do I abuse unconstrained delegation"` |
| `category` | string | none | Restrict to one platform, substring match on the category, e.g. `"Linux"` or `"Windows Hardening"`. Only useful when the top hits are for the wrong platform. |
| `limit` | integer | 10 | Max results, 1 to 25 |

**Ranking**

A query can be a question in plain words; the engine finds the terms in it.

1. Filler words are dropped from queries of more than three words, and abbreviations are expanded (see below).
2. Two candidate pools are taken by FTS5 BM25 (column weights: title 10, path 8, category 5, content 1, porter stemming): pages containing every *specific* term (one found in at most 20% of pages), and pages containing any term. A question often carries an incidental word that the best page does not use, so matching every word is not required.
3. The pool is ranked by *name credit*, how few pages name each query term in their title or path (a likelihood ratio), plus a bonus for containing every specific term. That ranks the page named after the technique above hub pages that merely contain the words.

Measured on `tests/scenarios.json` (see [development.md](development.md#evaluating-search-quality)): a typed question that names the technique returns the right page first 86% of the time and in the top 5 for 99%.

**Abbreviations**

The following expand automatically at query time: `privesc`, `sqli`, `rce`, `lfi`, `rfi`, `xss`, `csrf`, `ssrf`, `ssti`, `xxe`, `idor`, `lpe`, `revshell`. The list lives in `src/db.ts` (`ALIASES`).

**Returns** (structured): `results[]` with `pageId`, `path`, `title`, `category`, `url`, `snippet`. Pass `path` to `hacktricks_get_page`.

## hacktricks_get_page

Reads one page from the index.

**Parameters**

| Name | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | Page path from search, e.g. `windows-hardening/active-directory-methodology/kerberoast.md`. Unique suffixes like `kerberoast` also work. |
| `section` | string | none | Extract one section by heading text (case-insensitive substring match) |
| `codeOnly` | boolean | false | Return only fenced code blocks (commands and payloads) |

**Behavior**

- Without `section`, returns the full cleaned page. Pages over 20,000 chars are truncated and the heading outline is appended so the caller can pick a section.
- Unknown `section` returns an error listing the available headings, so the agent can self-correct.
- Content is pre-cleaned at index time: GitBook hint banners, include directives and badge images are removed.

**Returns** (structured): `title`, `path`, `url`, `outline`, `content`, `truncated`.

## hacktricks_get_toc

Returns the wiki structure parsed from upstream `src/SUMMARY.md`.

**Parameters**

| Name | Type | Default | Description |
|---|---|---|---|
| `category` | string | none | Expand only branches whose title matches this substring. Omit for the top-level overview plus category page counts. |

**Returns** (structured): `categories[]` (name plus page count) and `tree` (indented text outline).

Without `category` the outline is large, about 90,000 characters. With it, only branches whose titles contain the text are returned, usually a few kilobytes.

## Recommended agent workflow

1. `hacktricks_search` with the question as typed, or with the technical terms.
2. `hacktricks_get_page` with `section` or `codeOnly` on the best hit.
3. Only read full pages when a section is not enough.

This pattern keeps typical lookups under 1,000 tokens of context.
