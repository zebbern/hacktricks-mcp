/**
 * Mirror the canonical skill (skills/hacktricks/) into every plugin package
 * that must ship a self-contained copy of it.
 *
 * Claude Code, Codex and ZCode treat the repo root as their plugin root and
 * discover skills/ there directly, so they read the canonical file with no
 * copy. A host belongs in MIRRORS only when its plugin installs as a
 * self-contained directory that cannot reach the repo root (today: Kimi).
 *
 * Usage:
 *   node scripts/sync-skills.mjs          # write mirrors
 *   node scripts/sync-skills.mjs --check  # exit 1 if any mirror has drifted (CI guard)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = "hacktricks";
const SOURCE = path.join(ROOT, "skills", SKILL);
/** Plugin roots that need a generated copy of skills/<name>/. */
const MIRRORS = ["kimi-plugin"];
/** Dropped under the frontmatter of each mirrored SKILL.md. */
const MARKER =
  "<!-- GENERATED COPY of skills/hacktricks/SKILL.md - do not edit directly; run: npm run sync:skills -->";

const check = process.argv.includes("--check");

/** Relative paths of every file under dir, sorted. */
function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel + "/"));
    else out.push(rel);
  }
  return out.sort();
}

// Compare line endings as LF so the guard passes on Windows checkouts too.
const normalize = (text) => text.replace(/\r\n/g, "\n");

/** SKILL.md has to open with YAML frontmatter, so the marker goes right below it. */
function render(rel, text) {
  const lines = normalize(text).split("\n");
  if (rel !== "SKILL.md") return lines.join("\n");
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) {
      lines.splice(end + 1, 0, "", MARKER);
      return lines.join("\n");
    }
  }
  return `${MARKER}\n\n${lines.join("\n")}`;
}

const sourceFiles = listFiles(SOURCE);
let drifted = 0;
for (const mirror of MIRRORS) {
  const target = path.join(ROOT, mirror, "skills", SKILL);

  // A file in the mirror that no longer exists upstream is stale generated output.
  for (const rel of fs.existsSync(target) ? listFiles(target) : []) {
    if (sourceFiles.includes(rel)) continue;
    const stale = path.relative(ROOT, path.join(target, rel));
    drifted++;
    if (check) {
      console.error(`stale: ${stale}`);
    } else {
      fs.rmSync(path.join(target, rel));
      console.log(`removed: ${stale}`);
    }
  }

  for (const rel of sourceFiles) {
    const file = path.join(target, rel);
    const expected = render(rel, fs.readFileSync(path.join(SOURCE, rel), "utf8"));
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
}

if (check) {
  if (drifted > 0) {
    console.error("Skill mirrors out of sync. Run: npm run sync:skills");
    process.exit(1);
  }
  console.log("skill mirrors in sync");
} else if (drifted === 0) {
  console.log("skill mirrors already in sync");
}
