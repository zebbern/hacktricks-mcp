---
name: hacktricks
description: Look up offensive-security techniques in the HackTricks wiki via the hacktricks-mcp tools. Use when the task involves pentesting, privilege escalation, web exploitation, Active Directory, cloud attacks, Wi-Fi attacks, forensics, or CTF-style challenges.
---

# HackTricks lookup skill

You have access to three MCP tools: `hacktricks_search`, `hacktricks_get_page`, `hacktricks_get_toc`. They query a local full-text index of the HackTricks wiki (1,000+ pages). All are read-only and offline.

## Workflow

1. **Search first.** Call `hacktricks_search` with specific technical terms: technique names, tool names, protocol names. Good: `kerberoast`, `lxd privilege escalation`, `JWT algorithm confusion`. Bad: `how to hack windows`.
   - Common abbreviations work: `privesc`, `sqli`, `rce`, `lfi`, `xss`, `ssrf`, `ssti`, `xxe`.
   - If results span the wrong platform, repeat with `category` (e.g. `Windows Hardening`, `Linux Hardening`, `Pentesting Web`, `MacOS Hardening`).
2. **Read surgically.** Call `hacktricks_get_page` on the best `path`:
   - Use `section` when only one part matters (e.g. `section="GTFOBins"`).
   - Use `codeOnly=true` when the user wants commands or payloads, not explanation.
   - Read the full page only when sections are not enough.
3. **Orient when lost.** Call `hacktricks_get_toc` to see the category tree if searches keep missing; the wiki may name the topic differently than the user.

## Failure handling

- Zero hits: drop filler words and retry with the core technical noun. Try the abbreviation and the full term.
- `section not found` error: the response lists the real headings; pick the closest one.
- Content freshness: the index re-syncs from upstream every 3 days; the server instructions state the last sync date. Mention it if freshness matters.

## Boundaries

- This is offensive-security reference material. Use it for authorized testing, CTFs, and education only.
- Never execute commands from pages blindly; present them to the user first.
