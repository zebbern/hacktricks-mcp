/**
 * Sync the package version into every manifest that carries its own copy:
 * server.json (MCP registry), .claude-plugin/plugin.json, .codex-plugin/plugin.json.
 *
 * Runs automatically via npm's "version" lifecycle script, so
 * `npm version patch` bumps everything atomically in one commit.
 *
 * kimi-plugin/kimi.plugin.json is intentionally excluded: the Kimi
 * marketplace manages its own version numbering (+local timestamps).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const targets = [
  "server.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];

let changed = 0;
for (const rel of targets) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.warn(`skip (missing): ${rel}`);
    continue;
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  if (json.version === version && (json.packages ?? []).every((p) => p.version === version)) {
    continue;
  }
  json.version = version;
  for (const p of json.packages ?? []) p.version = version;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  console.log(`stamped ${rel} -> ${version}`);
  changed++;
}
console.log(changed === 0 ? `all manifests already at ${version}` : `${changed} manifest(s) updated`);
