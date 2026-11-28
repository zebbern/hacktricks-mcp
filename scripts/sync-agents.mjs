/**
 * Mirror the canonical researcher subagent into the plugin packages that read
 * a different format. The canonical file, agents/hacktricks-researcher.md, is
 * the Claude Code and ZCode format: Markdown with YAML frontmatter.
 *
 *   kimi-plugin/agents/hacktricks-researcher.md   Kimi reads agents/ under the plugin root
 *   .codex/agents/hacktricks-researcher.toml     Codex reads TOML from .codex/agents/
 *
 * The prompt body is shared verbatim; only the envelope differs. Kimi has no
 * model or color field and ignores unknown ones, and it cannot preload a
 * skill, which the researcher no longer needs. Codex plugins cannot bundle
 * agents and an agent file there cannot restrict tools, so that file states
 * the limits in words and is there for users to copy into ~/.codex/agents/
 * (see docs/agents.md).
 *
 * Usage:
 *   node scripts/sync-agents.mjs          # write mirrors
 *   node scripts/sync-agents.mjs --check  # exit 1 if any mirror has drifted (CI guard)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "hacktricks-researcher";
const CANONICAL = path.join(ROOT, "agents", `${NAME}.md`);
const MARKER = (format) =>
  `GENERATED COPY of agents/${NAME}.md (${format} format) - do not edit directly; run: npm run sync:agents`;

// Compare line endings as LF so the guard passes on Windows checkouts too.
const normalize = (text) => text.replace(/\r\n/g, "\n");

/** The canonical file's frontmatter, parsed as the YAML it is, and its body. */
function readCanonical() {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalize(fs.readFileSync(CANONICAL, "utf8")));
  if (!match) throw new Error(`${CANONICAL} must open with YAML frontmatter`);
  // The description is a long quoted string with example blocks, so it is parsed, not read off the line.
  const meta = parseYaml(match[1]);
  return { name: meta.name, description: meta.description, tools: meta.tools, body: match[2].trim() };
}

// A JSON string is also a valid YAML double-quoted scalar and a valid TOML basic string.
const quoted = (s) => JSON.stringify(s);

const kimi = ({ name, description, body }) => `---
name: ${name}
description: ${quoted(description)}
whenToUse: HackTricks questions that need several pages.
disallowedTools:
- Write
- Edit
- Bash
---

<!-- ${MARKER("Kimi")} -->

\${skills_section}

${body}
`;

const codex = ({ name, description, body }) => {
  if (body.includes("'''")) throw new Error("The researcher body now contains ''' and no longer fits a TOML literal string");
  return `# ${MARKER("Codex")}
name = ${quoted(name)}
description = ${quoted(description)}
developer_instructions = '''
You inherit the caller's tools. Use only the HackTricks MCP tools (hacktricks_search, hacktricks_get_page, hacktricks_get_toc, hacktricks_cloud_permissions). Do not edit files.

${body}
'''
`;
};
const MIRRORS = [
  { file: path.join(ROOT, "kimi-plugin", "agents", `${NAME}.md`), render: kimi },
  { file: path.join(ROOT, ".codex", "agents", `${NAME}.toml`), render: codex },
];

const canonical = readCanonical();
if (!canonical.name || !canonical.description || !canonical.body) {
  throw new Error(`${CANONICAL} needs a name, a description and a body`);
}

const check = process.argv.includes("--check");
let drifted = 0;
for (const { file, render } of MIRRORS) {
  const expected = render(canonical);
  const current = fs.existsSync(file) ? normalize(fs.readFileSync(file, "utf8")) : null;
  if (current === expected) continue;
  drifted++;
  if (check) {
    console.error(`drifted: ${path.relative(ROOT, file)}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, expected);
    console.log(`synced: ${path.relative(ROOT, file)}`);
  }
}

if (check) {
  if (drifted > 0) {
    console.error("Researcher mirrors out of sync. Run: npm run sync:agents");
    process.exit(1);
  }
  console.log("researcher mirrors in sync");
} else if (drifted === 0) {
  console.log("researcher mirrors already in sync");
}
