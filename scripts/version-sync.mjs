/**
 * Sync the package version into every manifest that carries its own copy:
 * server.json (MCP registry), the Claude Code, Codex and ZCode plugin
 * manifests, and this plugin's entry in .claude-plugin/marketplace.json.
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
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const version = read("package.json").version;
// The marketplace may list other plugins, so only this plugin's entry is touched.
const pluginName = fs.existsSync(path.join(ROOT, ".claude-plugin/plugin.json"))
  ? read(".claude-plugin/plugin.json").name
  : null;

const targets = [
  "server.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  ".zcode-plugin/plugin.json",
];

/** Objects in a manifest whose `version` must track the package. */
function versioned(json) {
  return [
    ...(json.version === undefined ? [] : [json]),
    ...(json.packages ?? []),
    ...(json.plugins ?? []).filter((p) => p.name === pluginName && p.version !== undefined),
  ];
}

let changed = 0;
for (const rel of targets) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.warn(`skip (missing): ${rel}`);
    continue;
  }
  const json = read(rel);
  const slots = versioned(json);
  if (slots.every((s) => s.version === version)) continue;
  for (const slot of slots) slot.version = version;
  fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(json, null, 2) + "\n");
  console.log(`stamped ${rel} -> ${version}`);
  changed++;
}
console.log(changed === 0 ? `all manifests already at ${version}` : `${changed} manifest(s) updated`);
