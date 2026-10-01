/**
 * End-to-end smoke test: spawn the built MCP server over stdio and exercise
 * all three tools through a real MCP client.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PKG_ROOT, "dist", "server.js")],
    stderr: "pipe",
    // Pass the full environment: the SDK's default filtered env drops vars
    // like ELECTRON_RUN_AS_NODE that some Node runtimes need.
    env: { ...process.env } as Record<string, string>,
  });
  transport.stderr?.on("data", (d: Buffer) => {
    const s = d.toString();
    if (!s.includes("running on stdio")) console.error("[server stderr]", s.slice(0, 500));
  });
  const client = new Client({ name: "smoke-test", version: "0.0.1" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log("Tools:", names.join(", "));
  for (const expected of ["hacktricks_get_page", "hacktricks_get_toc", "hacktricks_search"]) {
    if (!names.includes(expected)) throw new Error(`Missing tool: ${expected}`);
  }

  const search = await client.callTool({ name: "hacktricks_search", arguments: { query: "kerberoast" } });
  const searchText = (search.content as any[])[0]?.text ?? "";
  if (!searchText.toLowerCase().includes("kerberoast")) {
    throw new Error(`Unexpected search result: ${searchText.slice(0, 200)}`);
  }
  console.log("search OK");

  const page = await client.callTool({
    name: "hacktricks_get_page",
    arguments: { path: "windows-hardening/active-directory-methodology/kerberoast.md", codeOnly: true },
  });
  if ((page as any).isError) throw new Error("get_page returned error");
  console.log("get_page OK");

  const toc = await client.callTool({ name: "hacktricks_get_toc", arguments: {} });
  const tocText = (toc.content as any[])[0]?.text ?? "";
  if (!tocText.includes("pages)")) throw new Error("TOC looks empty");
  console.log("get_toc OK");

  await client.close();
  console.log("Smoke test passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
