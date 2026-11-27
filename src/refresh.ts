/**
 * Keep the served index current without waiting for a new package install.
 *
 * The package ships with the index that was current when it was published.
 * After startup the server asks the project's latest GitHub release for its
 * data/meta.json (a few hundred bytes) and, if that release carries a newer
 * index, downloads it in the background and swaps it in. Tool calls never
 * wait on the network: the index opened at startup answers until a newer one
 * is ready. Any failure (no network, a proxy, a rate limit, a release
 * without index files, a corrupt download) leaves the current index in place.
 *
 * Environment:
 *   HACKTRICKS_OFFLINE=1    never touch the network
 *   HACKTRICKS_INDEX_URL    base URL to fetch index files from, instead of
 *                          this project's releases
 *   HACKTRICKS_CACHE_DIR    where downloaded indexes are kept
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { INDEX_SCHEMA, openDbReadonly } from "./db.js";
import type { TocNode } from "./toc.js";

/** How often a long-running server looks for a newer index. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const META_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const FILES = ["meta.json", "toc.json", "hacktricks.db"];
/** A download slower than this (see DOWNLOAD_TIMEOUT_MS) cannot still be in progress. */
const STALE_AFTER_MS = 60 * 60_000;

export interface IndexMeta {
  /** INDEX_SCHEMA of the server that built the index. */
  schema: number;
  /** Upstream commit per book id. */
  books: Record<string, string>;
  /** When the index was built; orders indexes, newest last. */
  syncedAt: string;
  pageCount: number;
  dbBytes: number;
}

/** The files of data/ as the server uses them: an open database plus what was loaded from JSON. */
export interface Index {
  dir: string;
  db: DatabaseSync;
  meta: IndexMeta;
  /** Table of contents tree per book id. */
  toc: Record<string, TocNode[]>;
}

/** Open the index stored in a directory: the package's data/, or a downloaded copy. */
export function openIndex(dir: string, dbPath = path.join(dir, "hacktricks.db")): Index {
  const read = (name: string) => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  const meta = read("meta.json");
  const toc = read("toc.json");
  return {
    dir,
    db: openDbReadonly(dbPath),
    meta: meta ? JSON.parse(meta) : { syncedAt: "unknown", pageCount: 0 },
    toc: toc ? JSON.parse(toc) : {},
  };
}

function cacheDir(): string {
  if (process.env.HACKTRICKS_CACHE_DIR) return process.env.HACKTRICKS_CACHE_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "hacktricks-mcp", "cache");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "hacktricks-mcp");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "hacktricks-mcp");
}

/** Index files are attached to this project's releases; package.json is the one place the repository is named. */
function releaseUrl(name: string): string {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repository: string = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).repository.url;
  const base = process.env.HACKTRICKS_INDEX_URL ?? `${repository.replace(/^git\+|\.git$/g, "")}/releases/latest/download`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

/** Best effort: on Windows a folder another server process still reads from cannot be deleted. */
function remove(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // still in use elsewhere
  }
}

async function fetchFile(name: string, timeoutMs: number): Promise<Response> {
  const res = await fetch(releaseUrl(name), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res;
}

/** A downloaded index counts only if it is whole and readable: the advertised size, the expected columns, the advertised page count. */
function usable(index: Index): boolean {
  try {
    const pages = (index.db.prepare("SELECT count(book) AS n FROM pages").get() as { n: number }).n;
    return (
      fs.statSync(path.join(index.dir, "hacktricks.db")).size === index.meta.dbBytes &&
      pages === index.meta.pageCount &&
      Object.keys(index.toc).length > 0
    );
  } catch {
    return false;
  }
}

/** The index of the latest release, if it is newer than `syncedAt` and this server can read it. */
async function newerIndex(syncedAt: string): Promise<Index | null> {
  const meta = (await (await fetchFile("meta.json", META_TIMEOUT_MS)).json()) as IndexMeta;
  if (meta.schema !== INDEX_SCHEMA || typeof meta.syncedAt !== "string" || meta.syncedAt <= syncedAt) {
    return null;
  }

  const cache = cacheDir();
  fs.mkdirSync(cache, { recursive: true });
  const dir = path.join(cache, `index-${INDEX_SCHEMA}-${meta.syncedAt.replace(/\D/g, "")}`);
  if (!fs.existsSync(path.join(dir, "hacktricks.db"))) {
    // Remove what a process that died mid-download left behind.
    for (const name of fs.readdirSync(cache)) {
      const stale = path.join(cache, name);
      if (name.startsWith("tmp-") && Date.now() - fs.statSync(stale).mtimeMs > STALE_AFTER_MS) remove(stale);
    }
    const staging = fs.mkdtempSync(path.join(cache, "tmp-"));
    try {
      for (const name of FILES) {
        const res = await fetchFile(name, DOWNLOAD_TIMEOUT_MS);
        fs.writeFileSync(path.join(staging, name), Buffer.from(await res.arrayBuffer()));
      }
      const index = openIndex(staging);
      const complete = usable(index);
      // Windows refuses to move or delete a file that is still open.
      index.db.close();
      if (!complete) throw new Error("downloaded index is incomplete");
      // The folder appears under its final name only once it is complete.
      // Another server process may have installed the same index meanwhile.
      try {
        fs.renameSync(staging, dir);
      } catch {
        // already installed by that process
      }
    } finally {
      remove(staging);
    }
  }
  return openIndex(dir);
}

/**
 * The newest index an earlier run of this server downloaded, when it is newer
 * than `current` and still whole; otherwise null. Starting on it means a
 * session uses the latest index it already has from its first tool call, with
 * or without a network.
 */
export function newestCachedIndex(current: Index): Index | null {
  try {
    const cache = cacheDir();
    if (!fs.existsSync(cache)) return null;
    // Folder names end in the sync time as digits, so they sort oldest first.
    const folders = fs.readdirSync(cache).filter((name) => name.startsWith(`index-${INDEX_SCHEMA}-`)).sort();
    const newest = folders[folders.length - 1];
    if (!newest) return null;
    const index = openIndex(path.join(cache, newest));
    if (usable(index) && index.meta.syncedAt > current.meta.syncedAt) return index;
    index.db.close();
  } catch {
    // an unreadable cache is no reason not to start on the bundled index
  }
  return null;
}

/**
 * Check for a newer index now and every few hours. `active` is the index
 * being served; `swap` is called with a verified newer one, between tool calls.
 */
export function refreshInBackground(active: () => Index, swap: (next: Index) => void): void {
  const check = async () => {
    try {
      const next = await newerIndex(active().meta.syncedAt);
      if (!next) return;
      swap(next);
      console.error(
        `hacktricks-mcp: using index synced ${next.meta.syncedAt} (${next.meta.pageCount} pages)`,
      );
      // Indexes older than the one now in use are not needed anymore.
      const cache = cacheDir();
      for (const name of fs.readdirSync(cache)) {
        if (name.startsWith("index-") && name !== path.basename(next.dir)) remove(path.join(cache, name));
      }
    } catch (err) {
      // "fetch failed" alone does not say why; Node keeps the reason on `cause`.
      const cause = (err as { cause?: { message?: string } }).cause?.message;
      console.error(
        `hacktricks-mcp: keeping the current index, refresh failed: ${(err as Error).message}${cause ? ` (${cause})` : ""}`,
      );
    }
  };
  void check();
  setInterval(() => void check(), CHECK_INTERVAL_MS).unref();
}
