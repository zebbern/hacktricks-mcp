/**
 * Mirror the canonical researcher subagent into the plugin packages that read
 * a different format. The canonical file, agents/hacktricks-researcher.md, is
 * the Claude Code and ZCode format: Markdown with YAML frontmatter.
 *
 *   kimi-plugin/agents/hacktricks-researcher.md   Kimi reads agents/ under the plugin root
 *   .codex/agents/hacktricks-researcher.toml     Codex reads TOML from .codex/agents/
 *
 * The prompt body is shared verbatim; only the envelope differs. Codex plugins
 * cannot bundle agents, so that file is there for users to copy into
 * ~/.codex/agents/ (see docs/agents.md).
 *
 * Usage:
 *   node scripts/sync-agents.mjs          # write mirrors
 *   node scripts/sync-agents.mjs --check  # exit 1 if any mirror has drifted (CI guard)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "hacktricks-researcher";
const CANONICAL = path.join(ROOT, "agents", `${NAME}.md`);
const MARKER = (format) =>
  `GENERATED COPY of agents/${NAME}.md (${format} format) - do not edit directly; run: npm run sync:agents`;

// Compare line endings as LF so the guard passes on Windows checkouts too.
const normalize = (text) => text.replace(/\r\n/g, "\n");

/** Split a Markdown file with flat `key: value` frontmatter into its fields and body. */
function readCanonical() {
  const lines = normalize(fs.readFileSync(CANONICAL, "utf8")).split("\n");
  if (lines[0] !== "---") throw new Error(`${CANONICAL} must open with frontmatter`);
  const end = lines.indexOf("---", 1);
  const meta = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2];
  }
  const body = lines.slice(end + 1).join("\n").trim();
  const tools = (meta.tools ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return { name: meta.name, description: meta.description, tools, body };
}

const json = (s) => JSON.stringify(s);

const kimi = ({ name, description, body }) => `---
name: ${name}
description: ${description}
whenToUse: HackTricks lookups that need several pages.
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
name = ${json(name)}
description = ${json(description)}
developer_instructions = '''
You inherit the caller's tools. Use only the HackTricks MCP tools (hacktricks_search, hacktricks_get_page, hacktricks_get_toc, hacktricks_cloud_permissions) and what you need to load the skill. Do not edit files.

${body}
'''
`;
};

// Kimi agents carry their tools in the frontmatter, so the body is enough there.
// Codex agent files cannot restrict tools or preload skills, which is why that
// envelope says so in words.
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
