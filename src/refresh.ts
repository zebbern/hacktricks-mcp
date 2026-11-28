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
 *   HACKTRICKS_CACHE_DIR    where downloaded indexes are kept and, on Windows,
 *                          the copy of the bundled index a server is started on
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
/** The cache folder of an index: its layout and its sync time as digits, so that folders sort oldest first. */
const folderOf = (syncedAt: string): string => `index-${INDEX_SCHEMA}-${syncedAt.replace(/\D/g, "")}`;

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

/** Open the index stored in a directory: the package's data/, or a downloaded copy. The database must also answer a query, so a file that is not one fails here. */
export function openIndex(dir: string, dbPath = path.join(dir, "hacktricks.db")): Index {
  const read = (name: string) => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  const meta = read("meta.json");
  const toc = read("toc.json");
  const db = openDbReadonly(dbPath);
  try {
    db.prepare("SELECT count(*) AS n FROM pages").get();
  } catch (err) {
    db.close();
    throw err;
  }
  return {
    dir,
    db,
    meta: meta ? JSON.parse(meta) : { syncedAt: "unknown", pageCount: 0 },
    toc: toc ? JSON.parse(toc) : {},
  };
}

function cacheDir(): string {
  const set = process.env.HACKTRICKS_CACHE_DIR?.trim();
  if (set) return set;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "hacktricks-mcp", "cache");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "hacktricks-mcp");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "hacktricks-mcp");
}

/** The metadata of the index in a folder, when it names a sync time. */
function readMeta(dir: string): IndexMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as IndexMeta;
    return typeof meta.syncedAt === "string" ? meta : null;
  } catch {
    return null;
  }
}

/** Index files are attached to this project's releases; package.json is the one place the repository is named. */
function releaseUrl(name: string): string {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repository: string = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).repository.url;
  // An empty variable is a blank setting in a host's config, not an address.
  const custom = process.env.HACKTRICKS_INDEX_URL?.trim();
  const base = custom ? custom : `${repository.replace(/^git\+|\.git$/g, "")}/releases/latest/download`;
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

/** Remove what a process that died during a download or a copy left behind. */
function removeStaleStaging(cache: string): void {
  for (const name of fs.readdirSync(cache)) {
    const stale = path.join(cache, name);
    if (name.startsWith("tmp-") && Date.now() - fs.statSync(stale).mtimeMs > STALE_AFTER_MS) remove(stale);
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
  const dir = path.join(cache, folderOf(meta.syncedAt));
  if (!fs.existsSync(path.join(dir, "hacktricks.db"))) {
    removeStaleStaging(cache);
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
 * A copy of the bundled index in the cache, under the name a download of the
 * same index has, so that one stands for both. Windows does not let a file
 * that is open be replaced: a server that served the package's own index kept
 * npx from updating the package for as long as it ran (npm stopped with EBUSY
 * on data/hacktricks.db). From the copy, no file of the package stays open.
 *
 * The folder, or null when the cache cannot be written to: the package's own
 * index is served then.
 */
function cachedCopy(bundledDir: string, syncedAt: string): string | null {
  let staging: string | undefined;
  try {
    const cache = cacheDir();
    const dir = path.join(cache, folderOf(syncedAt));
    const whole = (): boolean => {
      try {
        return FILES.every((name) => fs.statSync(path.join(dir, name)).size === fs.statSync(path.join(bundledDir, name)).size);
      } catch {
        return false;
      }
    };
    if (whole()) return dir;
    fs.mkdirSync(cache, { recursive: true });
    removeStaleStaging(cache);
    // A folder of that name that is not the whole index. One that appeared
    // since the check above is another server's finished copy, and stays.
    if (fs.existsSync(dir)) remove(dir);
    staging = fs.mkdtempSync(path.join(cache, "tmp-"));
    for (const name of FILES) fs.copyFileSync(path.join(bundledDir, name), path.join(staging, name));
    // Another server process may have made the same copy meanwhile.
    try {
      fs.renameSync(staging, dir);
    } catch {
      // then that copy is used below
    }
    return whole() ? dir : null;
  } catch {
    // no room or no permission: the package's own index is served
    return null;
  } finally {
    if (staging) remove(staging);
  }
}

/**
 * The index a server starts on: the database `explicitPath` names, when one is
 * named; else the bundled one, from a copy in the cache on Windows; replaced by
 * the newest index an earlier run downloaded when that is newer and still
 * whole. Starting on a downloaded one means a session uses the latest index it
 * already has from its first tool call, with or without a network.
 */
export function startupIndex(bundledDir: string, explicitPath?: string): Index {
  if (explicitPath) return openIndex(bundledDir, explicitPath);
  const meta = readMeta(bundledDir);
  const copy = meta && process.platform === "win32" ? cachedCopy(bundledDir, meta.syncedAt) : null;
  let bundled: Index;
  try {
    bundled = openIndex(copy ?? bundledDir);
  } catch (err) {
    // A copy that does not open is of no use to the next server either.
    if (!copy) throw err;
    remove(copy);
    console.error(`hacktricks-mcp: ignoring the copy of the bundled index in ${copy}: ${(err as Error).message}`);
    bundled = openIndex(bundledDir);
  }
  const newer = newestCachedIndex(bundled);
  if (newer) bundled.db.close();
  // Cached indexes older than the one this server starts on are of no use
  // from now on. After the close: on Windows a folder in use cannot be removed.
  removeOlderThan((newer ?? bundled).meta.syncedAt);
  return newer ?? bundled;
}

/** Remove from the cache every index older than the one with this sync time. */
function removeOlderThan(syncedAt: string): void {
  try {
    const cache = cacheDir();
    const keep = folderOf(syncedAt);
    for (const name of fs.readdirSync(cache)) {
      if (name.startsWith(`index-${INDEX_SCHEMA}-`) && name < keep) remove(path.join(cache, name));
    }
  } catch {
    // no cache folder yet
  }
}

/**
 * The newest index an earlier run of this server downloaded, when it is newer
 * than `current` and still whole; otherwise null.
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
    // An older one is normal after a package upgrade; a damaged one is worth a line.
    if (usable(index)) {
      if (index.meta.syncedAt > current.meta.syncedAt) return index;
    } else {
      console.error(`hacktricks-mcp: ignoring the downloaded index in ${path.join(cache, newest)}: it is no longer whole`);
    }
    index.db.close();
  } catch (err) {
    // an unreadable cache is no reason not to start on the bundled index
    console.error(`hacktricks-mcp: ignoring the downloaded index in the cache: ${(err as Error).message}`);
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
