# Tool reference

This is the single source of truth for the MCP tools exposed by hacktricks-mcp. The README only carries a summary table; keep details here.

All three tools are read-only (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`) and fully local. No network access happens at query time.

## hacktricks_search

Ranked full-text search over the indexed HackTricks pages.

**Parameters**

| Name | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Search terms, e.g. `"kerberoast"` or `"docker escape"` |
| `category` | string | none | Substring filter on the top-level category, e.g. `"Windows Hardening"` |
| `limit` | integer | 10 | Max results, 1 to 25 |

**Ranking**

1. FTS5 BM25 with column weights: title 10, path 8, category 5, content 1 (porter stemming).
2. Tie-breaker: a deterministic boost counts query terms that literally appear in the page title or path, so the canonical page for a topic ranks above pages that merely mention it often.
3. Multi-term queries run AND first for precision, then fall back to OR if AND yields nothing.

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

## Recommended agent workflow

1. `hacktricks_search` with specific technical terms.
2. `hacktricks_get_page` with `section` or `codeOnly` on the best hit.
3. Only read full pages when a section is not enough.

This pattern keeps typical lookups under 1,000 tokens of context.
