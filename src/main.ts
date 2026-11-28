#!/usr/bin/env node
/**
 * hacktricks-mcp, the executable (package.json "bin"). It says plainly when
 * Node.js is too old, then starts the server (src/server.ts).
 *
 * It must stay free of imports of anything that needs node:sqlite, or it could
 * not say so on a Node.js that lacks the module: without this file such a
 * Node.js prints a stack trace about a missing built-in module and nothing
 * that names the package or what to do.
 */
import fs from "node:fs";

/** The oldest Node.js with node:sqlite built in and without a flag. */
const MINIMUM_MAJOR = 22;
const MINIMUM_MINOR = 13;

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < MINIMUM_MAJOR || (major === MINIMUM_MAJOR && minor < MINIMUM_MINOR)) {
  // Straight to stderr, then exit at once: a write through a pipe could still be pending.
  fs.writeSync(
    2,
    `hacktricks-mcp needs Node.js ${MINIMUM_MAJOR}.${MINIMUM_MINOR} or newer, and this is Node.js ${process.versions.node}. ` +
      "Update Node.js and start again.\n",
  );
  process.exit(1);
}

await import("./server.js");
