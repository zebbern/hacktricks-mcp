---
name: hacktricks
description: Look up offensive-security techniques in the HackTricks wiki with the hacktricks_search, hacktricks_get_page and hacktricks_get_toc MCP tools, and check cloud permissions with hacktricks_cloud_permissions. Use whenever a task involves pentesting, privilege escalation (privesc), web exploitation (SQLi, XSS, SSRF, SSTI, XXE, JWT, deserialization, file upload), Active Directory and Kerberos attacks, Linux, Windows or macOS hardening, network services, Wi-Fi attacks, mobile app testing, reverse engineering, binary exploitation, forensics, CTF challenges, cloud and CI/CD security (AWS, GCP, Azure, Kubernetes, GitHub Actions, Jenkins, Terraform), cloud permission review (IAM roles and policies, Azure role definitions, GCP IAM, Kubernetes RBAC), or when the user names a technique or tool such as kerberoast, mimikatz, impacket, BloodHound, GTFOBins, sqlmap or frida and wants commands or an explanation.
---

<!-- GENERATED COPY of skills/hacktricks/SKILL.md - do not edit directly; run: npm run sync:skills -->

# HackTricks lookup

Three read-only MCP tools and a permissions check query a local index of two HackTricks books: the [HackTricks](https://hacktricks.wiki) book, about 1,150 pages on network services, web, Linux, Windows and macOS hardening, Active Directory, mobile, binary exploitation, reverse engineering, forensics and Wi-Fi, and [HackTricks Cloud](https://cloud.hacktricks.wiki), about 1,800 pages on AWS, GCP, Azure, Kubernetes and CI/CD systems such as GitHub Actions, Jenkins and Terraform. Calls are local and fast, so the only cost to manage is context: the wiki has pages longer than most budgets can spare. Everything below is about getting the right slice.

## If the tools are missing

When `hacktricks_search` is not in the tool list, the `hacktricks` MCP server is not connected. Say so and give the install line (`npx -y @zebbern/hacktricks-mcp@latest`, see the project README). Do not answer security questions from memory as if they came from HackTricks.

## How the Cloud book is organized

Every hit names its `book`. The Cloud book names each page `<provider> - <service> <phase>`, where the phase is one of `Enum`, `Unauthenticated Enum`, `Privesc`, `Post Exploitation` and `Persistence` (`AWS - IAM Privesc`, `Az - Key Vault Post Exploitation`). A search about a service returns pages from several phases, so read the titles of the hits for the phase you need. To see every page about a provider or a service, list it with `hacktricks_get_toc`: `category: "K8s"` returns all Kubernetes pages (about 8,000 characters) and `category: "AWS - Lambda"` or `category: "Az - Key Vault"` one service's pages (2,000 to 4,000 characters).

## Cloud permissions

For a question about cloud permissions ("is `iam:CreatePolicyVersion` dangerous?", "what can I do with `iam:PassRole` and `lambda:CreateFunction`?", "which of these role permissions should I remove?"), call `hacktricks_cloud_permissions` instead of searching. Pass the cloud (`aws`, `gcp`, `azure`, `k8s`) and the permissions exactly as the cloud writes them. It returns:

- each permission's rating (`critical`, `high`, `medium`, `low`) from HackTricks Cloud's rated list, with what a wildcard such as `iam:*` covers;
- the combination rules the permissions complete;
- every escalation technique in the book's catalog whose permissions are all held, each with the page section that explains it: its `read:` line is a `hacktricks_get_page` call;
- sections of the book named after a permission, which cover what the catalog does not.

A call costs about 1,000 to 3,000 characters when a few techniques apply and about 19,000 for a permission such as `iam:PassRole` that enables dozens; lower `limit` when you only need the first few. For Kubernetes write one grant per entry as `verb resource[.group][/subresource]`: `create pods`, `get secrets`, `create pods/exec`, `get *`.

The check evaluates permissions only. Resources, scopes, request conditions and the kind of target are not checked, so read a technique's `conditions` and its page section before you rely on it or rule it out.

## Answer directly, or delegate broad research

Everything you read from the tools stays in this conversation until it ends, so match the route to how much reading the question needs.

- **Answer directly** when the user names one technique or tool and a single page will do. One search, one `outlineOnly` read and one `section` read is roughly 6,000 characters.
- **Delegate** when the answer needs several pages: comparing options, listing every route, or a multi-step task. The `hacktricks-researcher` subagent exists for exactly this on Claude Code, ZCode and Kimi, and on Codex once its definition has been copied into `~/.codex/agents/`: hand it the question. Without it, spawn a general-purpose subagent that has the `hacktricks_*` tools and tell it to load and follow this skill (pass the path of this file if it cannot load the skill by name). Questions like that cost a researcher 74,000 to 144,000 characters of tool output and come back as reports of 5,000 to 8,000, which is what keeps a long session alive. Delegating takes minutes, so say that you are doing it.

The report is all you will see of the subagent's work, so ask for it in three parts:

```text
ANSWER:   <at most 200 words>
COMMANDS: <the commands that apply, copied verbatim, in one code block; or "none">
PAGES:    <each path you read, with the link from the page's first lines>
```

## Search

`hacktricks_search` takes a plain question or a few terms; you do not need to strip words or pick keywords. In the project's evaluation (89 questions, each asked two ways) the page that answers every question is among the results of the steps below. The order of the steps is what gets it there:

1. **Search with the technique's name when the question has one or you recognise it behind the user's description.** That finds the page in the top 5 for 90% of questions. Searching the same need typed as a bare situation finds it for only 54%, and trying that first costs about a third more calls and reading for no gain.
2. **Otherwise search with the user's words as typed,** then read the titles of all five results for the page that answers the exact question. When the hits are off-topic, name the technique behind the situation and search again with that name: "Request a ticket for a service account and crack it" finds nothing useful as typed, `kerberoast service account ticket crack` puts the Kerberoast page first.
3. **When you cannot name it, list the topic** with `hacktricks_get_toc` (see below).

- The first hit is the right page 72% of the time when the technique is named, so still read the titles below it before choosing.
- Abbreviations are expanded for you: `privesc`, `sqli`, `rce`, `lfi`, `rfi`, `xss`, `csrf`, `ssrf`, `ssti`, `xxe`, `idor`, `lpe`, `revshell`, `deserial`.
- `category` narrows to one category of the table of contents. It made no measurable difference in evaluation, so use it only when the top hits are for the wrong platform: `kerberos` alone returns the Kerberos service pages, with `category: "Linux"` it returns Linux Active Directory and FreeIPA.
- Keep `limit` at 5 unless surveying. Five results cost about 2,000 characters, ten about 4,000, 25 about 9,600. Each hit shows its page's size, which decides how to read it (see below).
- A hit ending in `README.md` is often a section landing page that only lists sub-pages (`.../interesting-groups-linux-pe/README.md`). When a named sibling is in the results too (`lxd-privilege-escalation.md`), read that instead.

## Read the smallest slice that answers

`hacktricks_get_page` takes a `path` from search. A unique suffix such as `kerberoast` or `lxd-privilege-escalation` is enough.

| Call | Typical size |
|---|---|
| `outlineOnly` | the headings with the size of each section: about 800 characters for the median page, under 1,800 for nine pages in ten |
| `section` | usually 300 to 10,000 characters |
| `section` with `codeOnly` | only the commands in that section |
| whole page | median about 10,800 characters in the main book and 7,100 in the Cloud book; one main-book page in five exceeds 20,000 and comes in slices of 20,000 characters |

- Let the size in the search result choose the read. Under about 8,000 characters (a third of the main book, over half of the Cloud book), or when you need most of the page: read it whole. Above that: start with `outlineOnly: true` and read only the sections that answer. Reading a long page whole just to find the headings costs up to 20,000 characters, and in a live test agents then re-read sections of it anyway.
- In the outline, a heading marked `in N subsections` holds mostly subsections, so asking for it returns all of them. Ask for one of those when you need a part.
- A response that comes back cut (`truncated: true`) ends with `offset=<n>` and, for a whole page, its outline. Pick a heading and call again with `section` instead of guessing at the missing part. When the section itself is cut (it has no subsections), call again with the same `section` and that `offset`, and repeat until nothing is cut.
- The hub pages are always cut off: Linux Privilege Escalation, Windows Local Privilege Escalation, AV Bypass, XSS, Deserialization, macOS auto start locations. For these go straight to `outlineOnly` and `section`.
- `section` matches the first heading that contains the text, case-insensitively, and returns that heading down to the next one of the same level. Two or three words from the outline make it unique; a lone common word such as `enumeration` lands on whichever heading comes first. A wrong guess is cheap, because the error lists every heading.
- `codeOnly: true` returns only fenced code blocks. Across a whole hub page that is still too large, so pair it with `section`.

## Browse the table of contents with a filter

`hacktricks_get_toc` returns the tables of contents of both books.

- Without arguments it returns a map of about 17,000 characters: each book's categories, and under them the chapters with the number of pages each holds. Read it to learn what exists and how the wiki names it.
- With `category` set to a word or two (`Kerberos`, `Key Vault`, `AWS - Lambda`) it lists the entries whose titles contain it, with their paths. That is usually 2,000 to 4,000 characters; a broad word is cut at 300 lines.

## Answering

- If, after one more search with other words, HackTricks has no page that answers the question, say so instead of guessing: report what the closest page does say about it, and name that page. The question itself can be off (a CVE number that belongs to another product); say that too.
- Cite the page with the link in the first lines of what you read: `https://hacktricks.wiki/en/...` for the main book, `https://cloud.hacktricks.wiki/en/...` for the Cloud book. Every result also carries it as `wikiUrl`. Do not build the link from the path: a `README.md` page lives at its folder address, and `README.html` is the wiki's not-found page.
- Mention freshness when it matters. The first line of `hacktricks_get_toc` says when the index was synced, and HackTricks changes daily.
- The content is a community wiki of offensive techniques. Explain and adapt commands to the target, and run them only on systems the user is authorized to test.

## Worked example

User: "How do I escalate from the lxd group on this box?"

1. `hacktricks_search` with the technique in the question and `limit: 5`. The first hit is `linux-hardening/user-information/interesting-groups-linux-pe/lxd-privilege-escalation.md`.
2. `hacktricks_get_page` with `path: "lxd-privilege-escalation"` and `outlineOnly: true` to see its sections and sizes.
3. `hacktricks_get_page` again with `section` set to the part you need, adding `codeOnly: true` when only the commands matter.
4. Answer with the commands, the caveat that applies to the target, and the `hacktricks.wiki` link from the page's first lines.
