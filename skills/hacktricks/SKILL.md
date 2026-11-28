---
name: hacktricks
description: Look up offensive-security and cloud techniques in the HackTricks wiki with the hacktricks_search, hacktricks_get_page and hacktricks_get_toc MCP tools, and check cloud permissions with hacktricks_cloud_permissions. Use it whenever a task involves pentesting, privilege escalation (privesc), web exploitation (SQLi, XSS, SSRF, SSTI, XXE, JWT, deserialization, file upload), Active Directory and Kerberos attacks, Linux, Windows or macOS hardening, network services, Wi-Fi attacks, mobile app testing, reverse engineering, binary exploitation, forensics, CTF challenges, or cloud and CI/CD security (AWS, GCP, Azure, Kubernetes, GitHub Actions, Jenkins, Terraform). Use it to review IAM roles and policies, Azure role definitions, GCP IAM or Kubernetes RBAC, and whenever the user names a technique or tool such as kerberoast, mimikatz, impacket, BloodHound, GTFOBins, sqlmap or frida and wants commands or an explanation. Use it even when the user only describes a situation and does not name the technique.
---

# HackTricks lookup

The index of two books, HackTricks and HackTricks Cloud, is local and fast, so the only cost to manage is context: pages run to 20,000 characters and more, and everything read stays in the conversation. The steps below find the page that answers a question with the least reading. Measured on 89 questions, each asked as a named technique and as a bare situation, they found it every time.

## Answer directly, or delegate

Everything read stays in this conversation until it ends, so match the route to how much reading the question needs.

- **Answer directly** when the user names one technique or tool and one page will do. One search, one outline and one section is roughly 6,000 characters.
- **Delegate** when the answer needs several pages: comparing options, listing every route, a multi-step task, or a review of a policy with many permissions. Hand it to the `hacktricks-researcher` subagent, which reads in its own context and returns a short report. It comes with the plugin on Claude Code, ZCode and Kimi; on Codex its definition has to be copied once (the project README has the command). Without it, spawn a general-purpose subagent that has the `hacktricks_*` tools and tell it to load and follow this skill. Delegating takes minutes, so say that you are doing it.

The report is all you will see of that work, so ask for it in three parts:

```text
ANSWER:   <at most 200 words>
COMMANDS: <the commands that apply, copied verbatim, in one code block; or "none">
PAGES:    <each path read, with the link from the page's first lines>
```

## Find the page

1. **Name the need.** Decide whether the question names cloud permissions, a technique or tool, or only a situation.
2. **Permissions.** For a question about cloud permissions (an IAM action, an Azure role, a Kubernetes verb and resource), call `hacktricks_cloud_permissions` instead of searching: the book keeps that knowledge in structured lists that search cannot reach. Pass the cloud (`aws`, `gcp`, `azure`, `k8s`) and the permissions as written; for Kubernetes write one grant per entry as `verb resource[.group][/subresource]`. It lists every technique whose named permissions are all held, so a permission such as `iam:PassRole` brings dozens, most of which need further permissions that appear only in their `conditions`. Read the sections of the techniques whose `needs` and `conditions` name no permission the user lacks, and of the sections it lists under the held permissions. Raise `limit` only when the user asks for every technique.
3. **Search.** Otherwise call `hacktricks_search` with `limit` 5. Search with the technique's name when the question has one or you recognise it behind the description: that finds the page for 95% of questions, where the question as typed finds it for 57%. Otherwise search with the question as typed.
4. **Choose.** Read the titles of all five results before choosing, because the first is right only about eight times in ten. In the Cloud book a title is `<provider> - <service> <phase>`, so take the phase the question asks for. When the hits are off-topic, name the technique behind the situation and search again with that name: "request a ticket for a service account and crack it" finds nothing useful as typed, `kerberoast service account ticket crack` puts the Kerberoast page first.
5. **List.** When you cannot name it, call `hacktricks_get_toc` with the provider or service word (`K8s`, `AWS - IAM`) and pick the page from the listing.

## Read the smallest part that answers

- Let the size in each hit choose the read. Under about 8,000 characters, read the page whole. Above that, call `hacktricks_get_page` with `outlineOnly: true` first and then with `section` for the part that answers: reading a long page whole just to find its headings can cost 20,000 characters, and its outline costs about 800.
- Add `codeOnly: true` to a `section` call when only the commands matter.
- A response that comes back cut (`truncated: true`) ends with `offset=<n>` and, for a whole page, its outline. Pick a heading and call again with `section`. When the section itself is cut, call again with the same `section` and that `offset`, and repeat until nothing is cut.
- `section` matches the first heading that contains the text, so two or three words from the outline make it unique. A wrong guess costs little, because the error lists every heading.
- A hit ending in `README.md` is often a landing page that only lists sub-pages. When a named sibling is in the results (`lxd-privilege-escalation.md`), read that instead.

## Answer

- Say only what the pages say. If HackTricks has no page that answers the question, after one more search with other words, say so and name the closest page instead of guessing. The question itself can be off, for example a CVE number that belongs to another product; say that too.
- Cite the page with the link in the first lines of what you read: `https://hacktricks.wiki/en/...` for the main book, `https://cloud.hacktricks.wiki/en/...` for the Cloud book. Do not build the link from the path: a `README.md` page lives at its folder address, and `README.html` is the wiki's not-found page.
- Mention when the index was synced only when the answer depends on how recent a page is, for example a technique or a product version that changes fast. The date is on the first line of the whole table of contents, which is about 17,000 characters, so do not fetch it for the date alone.
- Remind the user that the content is a community wiki of offensive techniques, to be used only on systems they are authorized to test.

## If the tools are missing

When `hacktricks_search` is not in the tool list, the `hacktricks` MCP server is not connected. Say so and give the install line, `npx -y @zebbern/hacktricks-mcp@latest`. Do not answer security questions from memory as if they came from HackTricks.
