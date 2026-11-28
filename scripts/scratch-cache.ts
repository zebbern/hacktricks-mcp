import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A fresh cache folder for a server a test starts, removed when the test ends.
 * A server prefers the newest index in its cache over the one in the build,
 * and on Windows copies the bundled index into it at startup, so a test that
 * leaves the cache unset would answer from whatever another run left in the
 * user's own cache and write into it.
 */
export function scratchCache(test: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), `hacktricks-${test}-`));
  process.on("exit", () => {
    // The SDK's close() can return just before a server has exited, and Windows
    // keeps the files of a running process locked until then.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
        return;
      } catch {
        if (attempt >= 30) return;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  });
  return folder;
}
