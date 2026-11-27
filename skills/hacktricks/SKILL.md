---
name: hacktricks
description: Look up offensive-security techniques in the HackTricks wiki with the hacktricks_search, hacktricks_get_page and hacktricks_get_toc MCP tools. Use whenever a task involves pentesting, privilege escalation (privesc), web exploitation (SQLi, XSS, SSRF, SSTI, XXE, JWT, deserialization, file upload), Active Directory and Kerberos attacks, Linux, Windows or macOS hardening, network services, Wi-Fi attacks, mobile app testing, reverse engineering, binary exploitation, forensics, CTF challenges, or when the user names a technique or tool such as kerberoast, mimikatz, impacket, BloodHound, GTFOBins, sqlmap or frida and wants commands or an explanation. Covers the main HackTricks book only. AWS, GCP, Azure, Kubernetes and CI/CD topics live in the separate HackTricks Cloud book, so point the user there.
---

# HackTricks lookup

Three read-only MCP tools query an offline index of the [HackTricks](https://book.hacktricks.wiki) book (about 1,150 pages). Calls are local and fast, so the only cost to manage is context: the wiki has pages longer than most budgets can spare. Everything below is about getting the right slice.

## If the tools are missing

When `hacktricks_search` is not in the tool list, the `hacktricks` MCP server is not connected. Say so and give the install line (`npx -y @zebbern/hacktricks-mcp@latest`, see the project README). Do not answer security questions from memory as if they came from HackTricks.

## Check the topic is covered

The index holds the main book: network services, web, Linux, Windows and macOS hardening, Active Directory, mobile, binary exploitation, reverse engineering, forensics, Wi-Fi.

It does **not** hold the separate HackTricks Cloud book: AWS, GCP, Azure and other providers, Kubernetes security, and CI/CD (GitHub Actions, Jenkins, Terraform and similar). Search still returns hits for those queries because many pages mention the words, but the hits are false positives. `aws iam privilege escalation` returns a macOS Node.js page first.

So for a cloud provider, Kubernetes or a pipeline system, skip the tools and send the user to the source, or read it yourself if you have web access:

- Cloud: https://cloud.hacktricks.wiki/en/pentesting-cloud/
- CI/CD: https://cloud.hacktricks.wiki/en/pentesting-ci-cd/

The same goes for a page that links out to `cloud.hacktricks.wiki`: the target is not indexed.

## Search with the question as typed

`hacktricks_search` takes a plain question or a few terms. You do not need to strip words or pick keywords: in the project's evaluation (69 questions, each asked two ways) a typed question that named the technique returned the right page first 86% of the time and within the top 5 for 99%.

- Trust the first hit when the technique is named, and read the titles below it for the page that answers your exact question.
- Vocabulary is what limits a search, not phrasing. When the ask only describes a situation, the right page was in the top 5 about half the time. If the top results are not about the user's situation, name the technique behind it and search again with that name. "Request a ticket for a service account and crack it" finds nothing useful as typed; `kerberoast service account ticket crack` puts the Kerberoast page first. When you cannot name it, list the topic with `hacktricks_get_toc` (see below).
- Abbreviations are expanded for you: `privesc`, `sqli`, `rce`, `lfi`, `rfi`, `xss`, `csrf`, `ssrf`, `ssti`, `xxe`, `idor`, `lpe`, `revshell`, `deserial`.
- `category` narrows to one platform. It made no measurable difference in evaluation, so use it only when the top hits are for the wrong OS: `kerberos` alone returns the Kerberos service pages, with `category: "Linux"` it returns Linux Active Directory and FreeIPA.
- Keep `limit` at 5 unless surveying. Five results cost about 1,750 characters, ten about 3,450, 25 about 8,700.
- A hit ending in `README.md` is often a section landing page that only lists sub-pages (`.../interesting-groups-linux-pe/README.md`). When a named sibling is in the results too (`lxd-privilege-escalation.md`), read that instead.

## Read the smallest slice that answers

`hacktricks_get_page` takes a `path` from search. A unique suffix such as `kerberoast` or `lxd-privilege-escalation` is enough.

| Call | Typical size |
|---|---|
| whole page | median about 11,000 characters; one page in five exceeds 20,000 and is cut off |
| `section` | usually 300 to 10,000 characters |
| `section` with `codeOnly` | only the commands in that section |

- A cut-off page comes back with `truncated: true` and its heading outline appended. Pick a heading and call again with `section` instead of guessing at the missing part.
- The hub pages are always cut off: Linux Privilege Escalation, Windows Local Privilege Escalation, AV Bypass, XSS, Deserialization, macOS auto start locations. For these go straight to `section`.
- `section` matches the first heading that contains the text, case-insensitively, and returns that heading down to the next one of the same level. Two or three words from the outline make it unique; a lone common word such as `enumeration` lands on whichever heading comes first. A wrong guess is cheap, because the error lists every heading.
- `codeOnly: true` returns only fenced code blocks. Across a whole hub page that is still too large, so pair it with `section`.

## Browse the table of contents with a filter

`hacktricks_get_toc` lists pages from the wiki's own table of contents.

- Without arguments it returns the whole top structure, about 90,000 characters. Avoid it unless the user truly wants the full map.
- With `category` set to a topic word (`Kerberos`, `Deserialization`) it returns a few kilobytes listing the pages whose titles contain it. Use it to see what exists on a topic before searching blind, or to learn the wiki's name for something.

## Answering

- Cite the page. Every result carries `url`, a GitHub source link. The readable version is `https://hacktricks.wiki/en/` plus the path with `.md` replaced by `.html`.
- Mention freshness when it matters. The server instructions state when the index was synced (it refreshes every 3 days) and HackTricks changes daily.
- The content is a community wiki of offensive techniques. Explain and adapt commands to the target, and run them only on systems the user is authorized to test.

## Worked example

User: "How do I escalate from the lxd group on this box?"

1. `hacktricks_search` with the question as typed and `limit: 5`. The first hit is `linux-hardening/user-information/interesting-groups-linux-pe/lxd-privilege-escalation.md`.
2. `hacktricks_get_page` with `path: "lxd-privilege-escalation"` and `codeOnly: true` for the commands, or with a `section` from the outline when the reasoning matters.
3. Answer with the commands, the caveat that applies to the target, and the `hacktricks.wiki` link.
