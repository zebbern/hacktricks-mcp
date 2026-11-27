/**
 * End-to-end test of the background index refresh (src/refresh.ts).
 *
 * A stand-in for the project's GitHub releases serves the index files over
 * local HTTP. Part one drives refreshInBackground in this process, including
 * the periodic re-check. Part two starts the built server over stdio and
 * checks which index answers tool calls: one downloaded by an earlier run, a
 * newly downloaded one, or the bundled one when the network is unusable.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_SCHEMA } from "../src/db.js";
import { openIndex, refreshInBackground, type Index, type IndexMeta } from "../src/refresh.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(PKG_ROOT, "data");
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Remove a folder, retrying for a few seconds: the SDK's close() can return
 * just before a server process has exited, and Windows keeps the files of a
 * running process locked until then.
 */
async function remove(folder: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 100) throw err;
      await sleep(100);
    }
  }
}
const text = (result: any) => (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
/** The bundled index as a release, synced `offset` milliseconds away from its real time. */
const releaseAt = (offset: number): IndexMeta => ({
  ...bundled,
  syncedAt: new Date(Date.parse(bundled.syncedAt) + offset).toISOString(),
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Wait until `predicate` holds, for at most `ms`. Returns whether it did. */
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

/** The same for a predicate that has to ask the server first. */
async function untilAsync(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

const bundled: IndexMeta = JSON.parse(fs.readFileSync(path.join(DATA, "meta.json"), "utf8"));

type Release = { meta: IndexMeta; db?: Buffer } | "hang";

/**
 * Serves the three index files the way GitHub's releases do: the download
 * URL answers with a redirect to another host, carrying a signed query
 * string, and the asset itself is served from there. `current()` is read
 * per request.
 */
function standIn(current: () => Release) {
  const requests: string[] = [];
  const assets = http.createServer((req, res) => {
    const url = String(req.url).split("?")[0].slice(1);
    requests.push(url);
    const release = current();
    if (release === "hang") return; // accept the connection and never answer
    if (url === "asset/meta.json") res.end(JSON.stringify(release.meta));
    else if (url === "asset/toc.json") fs.createReadStream(path.join(DATA, "toc.json")).pipe(res);
    else if (url === "asset/hacktricks.db" && release.db) res.end(release.db);
    else if (url === "asset/hacktricks.db") fs.createReadStream(path.join(DATA, "hacktricks.db")).pipe(res);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  let assetPort = 0;
  const downloads = http.createServer((req, res) => {
    const name = String(req.url).slice(1).slice("latest/download/".length);
    requests.push(`latest/download/${name}`);
    res.writeHead(302, { location: `http://localhost:${assetPort}/asset/${name}?X-Amz-Signature=abc&X-Amz-Expires=300` });
    res.end();
  });
  return new Promise<{ url: string; requests: string[]; close: () => Promise<void> }>((resolve) => {
    // "localhost" is another origin than the "127.0.0.1" the download URL is on.
    assets.listen(0, "localhost", () => {
      assetPort = (assets.address() as { port: number }).port;
      downloads.listen(0, "127.0.0.1", () => {
        const { port } = downloads.address() as { port: number };
        const close = () =>
          Promise.all([downloads, assets].map((server) => new Promise<void>((done) => server.close(() => done())))).then(
            () => undefined,
          );
        resolve({ url: `http://127.0.0.1:${port}/latest/download/`, requests, close });
      });
    });
  });
}

/** Part one: the refresh logic, driven in this process. Leaves `cache` holding one downloaded index. */
async function testRefreshLogic(cache: string): Promise<void> {
  let release: Release = { meta: releaseAt(DAY) };
  const remote = await standIn(() => release);
  process.env.HACKTRICKS_INDEX_URL = remote.url;
  process.env.HACKTRICKS_CACHE_DIR = cache;

  // Capture the periodic re-check so the test can trigger it when it wants to.
  const realSetInterval = globalThis.setInterval;
  let recheck = () => {};
  globalThis.setInterval = ((fn: () => void) => {
    recheck = fn;
    return { unref() {} } as unknown as NodeJS.Timeout;
  }) as typeof globalThis.setInterval;

  let active: Index = openIndex(DATA);
  const logs: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  refreshInBackground(
    () => active,
    (next) => {
      active.db.close();
      active = next;
    },
  );
  globalThis.setInterval = realSetInterval;

  const syncedAt = () => active.meta.syncedAt;
  const folders = (prefix: string) => fs.readdirSync(cache).filter((name) => name.startsWith(prefix));
  /** Trigger the periodic re-check and wait until it has read the release's meta.json. */
  const recheckAndReadMeta = async (): Promise<number> => {
    const before = remote.requests.length;
    recheck();
    assert(await until(() => remote.requests.slice(before).includes("asset/meta.json"), 5_000), "re-check did not read meta.json");
    await sleep(300);
    return before;
  };
  const downloadsSince = (from: number) => remote.requests.slice(from).includes("asset/hacktricks.db");

  // 1. A newer release is downloaded, validated and switched to.
  const first = releaseAt(DAY).syncedAt;
  assert(
    await until(() => syncedAt() === first, 20_000),
    `did not switch to the newer index (at ${syncedAt()}); refresh log: ${logs.join(" | ") || "none"}; requests: ${remote.requests.join(", ") || "none"}`,
  );
  assert(folders("index-").length === 1 && folders("tmp-").length === 0, `cache after download: ${fs.readdirSync(cache)}`);
  console.log("newer release: downloaded and switched OK");

  // 2. A release that is not newer changes nothing and downloads nothing.
  release = { meta: active.meta };
  let from = await recheckAndReadMeta();
  assert(syncedAt() === first && !downloadsSince(from), "a release that is not newer was downloaded");
  console.log("same release: ignored OK");

  // 3. An older release is ignored.
  release = { meta: releaseAt(-DAY) };
  from = await recheckAndReadMeta();
  assert(syncedAt() === first && !downloadsSince(from), "an older release was downloaded");
  console.log("older release: ignored OK");

  // 4. A release built for another index layout is ignored without downloading it.
  release = { meta: { ...releaseAt(2 * DAY), schema: INDEX_SCHEMA + 1 } };
  from = await recheckAndReadMeta();
  assert(syncedAt() === first && !downloadsSince(from), "an index of another layout was downloaded");
  console.log("other layout: ignored OK");

  /** Run a release that must be rejected after its download, and return the failure logged for it. */
  const rejected = async (name: string, db?: Buffer): Promise<void> => {
    release = { meta: releaseAt(2 * DAY), db };
    const logged = logs.length;
    recheck();
    assert(await until(() => logs.length > logged, 20_000), `${name}: no failure was logged`);
    assert(syncedAt() === first, `${name}: switched to a bad index`);
    assert(folders("tmp-").length === 0 && folders("index-").length === 1, `${name}: left ${fs.readdirSync(cache)} in the cache`);
    console.log(`${name}: rejected OK (${logs[logged].replace(/^hacktricks-mcp: /, "")})`);
  };

  const whole = fs.readFileSync(path.join(DATA, "hacktricks.db"));
  // 5. A download that was cut short fails the size check.
  await rejected("truncated database", whole.subarray(0, 1024 * 1024));
  // 6. A file of the right size that is not the advertised database fails the page count.
  const padded = Buffer.alloc(whole.length);
  whole.copy(padded, 0, 0, 1024 * 1024);
  await rejected("unreadable database", padded);

  // 7. A network that never answers times out; the current index keeps serving meanwhile.
  release = "hang";
  const logged = logs.length;
  recheck();
  const pages = (active.db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number }).n;
  assert(pages === active.meta.pageCount, "the current index stopped answering during a check");
  assert(await until(() => logs.length > logged, 10_000), "a hanging check was not given up");
  assert(syncedAt() === first && /timeout/i.test(logs[logged]), `hanging network: ${logs[logged]}`);
  console.log("no answer: timed out, kept serving OK");

  // 8. A second newer release replaces the first download.
  release = { meta: releaseAt(2 * DAY) };
  recheck();
  assert(await until(() => syncedAt() === releaseAt(2 * DAY).syncedAt, 20_000), "did not switch to the second newer index");
  assert(folders("index-").length === 1, `older download not removed: ${fs.readdirSync(cache)}`);
  console.log("second newer release: replaced the first OK");

  active.db.close();
  console.error = realError;
  await remote.close();
}

/** Part two: the built server over stdio. */
async function startServer(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PKG_ROOT, "dist", "server.js")],
    stderr: "pipe",
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  const client = new Client({ name: "smoke-refresh", version: "0.0.1" });
  await client.connect(transport);
  return { client, stderr: () => stderr.join("") };
}

/** The sync time of the index that answered, as the table of contents reports it. */
async function syncedOf(client: Client): Promise<string | undefined> {
  const toc = await client.callTool({ name: "hacktricks_get_toc", arguments: {} });
  return /synced (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(text(toc))?.[1];
}

async function testServer(cache: string): Promise<void> {
  const downloaded = releaseAt(2 * DAY).syncedAt;
  // Closed again at the end, also after a failed assertion: a running server
  // keeps its index open, and Windows cannot delete a file that is open.
  const started: Client[] = [];
  const remotes: Awaited<ReturnType<typeof standIn>>[] = [];
  const folders: string[] = [];
  try {
    const start = async (env: Record<string, string>) => {
      const server = await startServer(env);
      started.push(server.client);
      return server;
    };

    // 1. A session that cannot reach the network starts on the index an earlier run downloaded.
    let server = await start({ HACKTRICKS_INDEX_URL: "http://127.0.0.1:1/", HACKTRICKS_CACHE_DIR: cache });
    assert((await syncedOf(server.client)) === downloaded, "did not start on the downloaded index");
    assert(await until(() => /refresh failed/.test(server.stderr()), 5_000), `offline: no failure logged for the unreachable release:\n${server.stderr()}`);
    assert((await syncedOf(server.client)) === downloaded, "offline: lost the downloaded index");
    console.log("offline with a downloaded index: started on it OK");

    // 2. A session with the network downloads a newer index and switches to it while running.
    const newer = await standIn(() => ({ meta: releaseAt(3 * DAY) }));
    remotes.push(newer);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ht-refresh-empty-"));
    folders.push(empty);
    server = await start({ HACKTRICKS_INDEX_URL: newer.url.replace(/\/$/, ""), HACKTRICKS_CACHE_DIR: empty }); // without the trailing slash on purpose
    const target = releaseAt(3 * DAY).syncedAt;
    const first = await syncedOf(server.client);
    assert(first === bundled.syncedAt || first === target, `unexpected starting index: ${first}`);
    assert(
      await untilAsync(async () => (await syncedOf(server.client)) === target, 20_000),
      "server did not switch to the downloaded index",
    );
    assert(/using index synced/.test(server.stderr()), `switch was not logged:\n${server.stderr()}`);
    console.log("newer release over stdio: switched while running OK");

    // 3. HACKTRICKS_OFFLINE=1 makes no request at all.
    const counted = await standIn(() => ({ meta: releaseAt(4 * DAY) }));
    remotes.push(counted);
    server = await start({ HACKTRICKS_OFFLINE: "1", HACKTRICKS_INDEX_URL: counted.url, HACKTRICKS_CACHE_DIR: cache });
    await sleep(700);
    assert(counted.requests.length === 0, `HACKTRICKS_OFFLINE=1 still made ${counted.requests.length} request(s)`);
    assert((await syncedOf(server.client)) === downloaded, "offline mode does not answer");
    console.log("HACKTRICKS_OFFLINE=1: no network, tools work OK");
  } finally {
    for (const client of started) await client.close().catch(() => {});
    for (const remote of remotes) await remote.close();
    for (const folder of folders) await remove(folder);
  }
}

async function main() {
  assert(typeof bundled.syncedAt === "string" && Number.isFinite(Date.parse(bundled.syncedAt)), "data/meta.json has no sync time");
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "ht-refresh-cache-"));
  try {
    await testRefreshLogic(cache);
    await testServer(cache);
  } finally {
    // A leftover folder is no reason to fail a test that passed; report it instead.
    await remove(cache).catch(() => console.error(`could not remove ${cache}`));
  }
  console.log("Refresh smoke test passed");
}

// Written to the stream itself: part one replaces console.error while it runs.
main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
