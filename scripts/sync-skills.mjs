/**
 * Sync the canonical skill (skills/hacktricks/SKILL.md) into every plugin
 * package that must ship a self-contained copy. Currently that is only
 * kimi-plugin/ (a Kimi plugin directory is copied wholesale on install and
 * cannot reference files outside itself).
 *
 * Claude Code and Codex need no copy: their plugin formats auto-discover
 * skills/ at the plugin root.
 *
 * Usage:
 *   node scripts/sync-skills.mjs          # write copies
 *   node scripts/sync-skills.mjs --check  # exit 1 if any copy has drifted (CI guard)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL = path.join(ROOT, "skills", "hacktricks", "SKILL.md");
const COPIES = [path.join(ROOT, "kimi-plugin", "skills", "hacktricks", "SKILL.md")];

const MARKER =
  "<!-- GENERATED COPY of skills/hacktricks/SKILL.md - do not edit directly; run: npm run sync:skills -->\n\n";

const canonical = fs.readFileSync(CANONICAL, "utf8");
const expected = MARKER + canonical;
const check = process.argv.includes("--check");

let drifted = 0;
for (const target of COPIES) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (current === expected) continue;
  drifted++;
  if (check) {
    console.error(`drifted: ${path.relative(ROOT, target)}`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, expected);
    console.log(`synced: ${path.relative(ROOT, target)}`);
  }
}

if (check) {
  if (drifted > 0) {
    console.error("Skill copies out of sync. Run: npm run sync:skills");
    process.exit(1);
  }
  console.log("skill copies in sync");
} else if (drifted === 0) {
  console.log("skill copies already in sync");
}
