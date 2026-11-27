/**
 * End-to-end smoke test: spawn the built MCP server over stdio and exercise
 * all four tools through a real MCP client, on the bundled two-book index.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = (result: any) => (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PKG_ROOT, "dist", "server.js")],
    stderr: "pipe",
    // Pass the full environment: the SDK's default filtered env drops vars
    // like ELECTRON_RUN_AS_NODE that some Node runtimes need. The background
    // index refresh stays off so the test sees the bundled index.
    env: { ...process.env, HACKTRICKS_OFFLINE: "1" } as Record<string, string>,
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
  for (const expected of ["hacktricks_cloud_permissions", "hacktricks_get_page", "hacktricks_get_toc", "hacktricks_search"]) {
    if (!names.includes(expected)) throw new Error(`Missing tool: ${expected}`);
  }

  const search = await client.callTool({ name: "hacktricks_search", arguments: { query: "kerberoast" } });
  const searchText = text(search);
  if (!searchText.toLowerCase().includes("kerberoast")) {
    throw new Error(`Unexpected search result: ${searchText.slice(0, 200)}`);
  }
  const firstHit = (search as any).structuredContent.results[0];
  if (!(firstHit.chars > 0) || !/size: [\d,]+ chars/.test(searchText)) {
    throw new Error("search hits do not show the page size");
  }
  console.log("search OK");

  // Both books share one index: a cloud question lands in the Cloud book, and
  // every hit says which book it is from.
  const cloud = await client.callTool({ name: "hacktricks_search", arguments: { query: "aws s3 bucket enumeration", limit: 5 } });
  if ((cloud as any).structuredContent.results[0]?.book !== "hacktricks-cloud" || !/book: hacktricks-cloud/.test(text(cloud))) {
    throw new Error(`cloud search did not return the Cloud book:\n${text(cloud).slice(0, 400)}`);
  }
  if (firstHit.book !== "hacktricks" || !/book: hacktricks\n/.test(searchText)) {
    throw new Error("search hits from the main book do not say so");
  }
  console.log("search names the book OK");

  const page = await client.callTool({
    name: "hacktricks_get_page",
    arguments: { path: "windows-hardening/active-directory-methodology/kerberoast.md", codeOnly: true },
  });
  if ((page as any).isError) throw new Error("get_page returned error");
  console.log("get_page OK");

  const whole = await client.callTool({
    name: "hacktricks_get_page",
    arguments: { path: "windows-hardening/active-directory-methodology/kerberoast.md" },
  });
  const outline = await client.callTool({
    name: "hacktricks_get_page",
    arguments: { path: "kerberoast", outlineOnly: true },
  });
  const outlineText = (outline.content as any[])[0]?.text ?? "";
  const wholeText = (whole.content as any[])[0]?.text ?? "";
  if (
    (outline as any).isError ||
    (outline as any).structuredContent.content !== "" ||
    !/\(\d[\d,]* chars\)/.test(outlineText) ||
    outlineText.length * 5 > wholeText.length
  ) {
    throw new Error("outlineOnly did not return a sized outline that is far smaller than the page");
  }
  console.log("get_page outlineOnly OK");

  // A long text comes in slices: a cut slice says where the rest continues, and the rest can be read.
  const longPage = "linux-hardening/processes-crontab-systemd-dbus/cron-and-systemd-timers.md";
  const cut = await client.callTool({ name: "hacktricks_get_page", arguments: { path: longPage, section: "Trace privileged" } });
  const cutText = text(cut);
  const next = (cut as any).structuredContent?.nextOffset;
  if (!(cut as any).structuredContent?.truncated || !(next > 0) || !cutText.includes(`offset=${next}`)) {
    throw new Error(`a cut section does not say where it continues:\n${cutText.slice(-300)}`);
  }
  const rest = await client.callTool({ name: "hacktricks_get_page", arguments: { path: longPage, section: "Trace privileged", offset: next } });
  const restText = text(rest);
  if ((rest as any).isError || restText.length < 500 || (rest as any).structuredContent?.truncated || restText.includes("[TRUNCATED")) {
    throw new Error("the rest of a cut section cannot be read with offset");
  }
  const nothing = await client.callTool({ name: "hacktricks_get_page", arguments: { path: "kerberoast", offset: 999999 } });
  if (!(nothing as any).isError && !text(nothing).includes("Nothing left to read")) throw new Error("an offset past the end is not reported");
  console.log("get_page offset OK");

  // The page header carries the link to cite. A README is the index of its folder
  // on the wiki: the same path with README.html is the wiki's not-found page.
  for (const [path, link] of [
    ["kerberoast", "https://hacktricks.wiki/en/windows-hardening/active-directory-methodology/kerberoast.html"],
    ["aws-iam-privesc/README.md", "https://cloud.hacktricks.wiki/en/pentesting-cloud/aws-security/aws-privilege-escalation/aws-iam-privesc/"],
  ]) {
    const readme = await client.callTool({ name: "hacktricks_get_page", arguments: { path, outlineOnly: true } });
    if (!text(readme).includes(`\n${link}\n`) || (readme as any).structuredContent?.wikiUrl !== link) {
      throw new Error(`get_page did not give the wiki link for ${path}:\n${text(readme).slice(0, 200)}`);
    }
  }
  const s3 = (cloud as any).structuredContent.results[0];
  const s3Link = s3.path.endsWith("/README.md")
    ? `https://cloud.hacktricks.wiki/en/${s3.path.slice(0, -"/README.md".length)}/`
    : `https://cloud.hacktricks.wiki/en/${s3.path.replace(/\.md$/, ".html")}`;
  if (s3.wikiUrl !== s3Link) throw new Error(`search hit carries the wrong wiki link: ${s3.wikiUrl} for ${s3.path}`);
  console.log("wiki link OK");

  // A path that exists in both books: the book parameter picks one.
  for (const book of ["hacktricks", "hacktricks-cloud"] as const) {
    const readme = await client.callTool({ name: "hacktricks_get_page", arguments: { path: "README.md", book, outlineOnly: true } });
    if ((readme as any).structuredContent?.book !== book) throw new Error(`get_page ignored book=${book}`);
  }
  console.log("get_page book OK");

  const toc = await client.callTool({ name: "hacktricks_get_toc", arguments: {} });
  const tocText = text(toc);
  // The overview is a map, not the full table: both books, categories and chapters, no page paths.
  if (!tocText.includes("HackTricks Cloud") || !tocText.includes("Pentesting CI/CD") || tocText.length > 25_000 || tocText.includes("  [")) {
    throw new Error(`TOC overview is not a compact map of both books (${tocText.length} chars)`);
  }
  console.log(`get_toc OK (${tocText.length} chars)`);

  const filtered = await client.callTool({ name: "hacktricks_get_toc", arguments: { category: "Jenkins" } });
  const filteredText = text(filtered);
  if (!filteredText.includes("jenkins-security") || !filteredText.includes("HackTricks Cloud")) {
    throw new Error(`filtered TOC did not list the Cloud book's Jenkins pages:\n${filteredText.slice(0, 400)}`);
  }
  console.log("get_toc filter OK");

  // The permissions check reads the tables the indexer fills from HackTricks Cloud's data.
  const permissions = await client.callTool({
    name: "hacktricks_cloud_permissions",
    arguments: { provider: "aws", permissions: ["iam:CreatePolicyVersion"] },
  });
  const permissionText = text(permissions);
  const techniques = (permissions as any).structuredContent?.escalation ?? [];
  if (
    (permissions as any).isError ||
    !permissionText.includes("critical   iam:CreatePolicyVersion") ||
    !techniques.some((t: any) => t.id === "aws-iam-createpolicyversion-self") ||
    !/read: hacktricks_get_page path="\S+" section="/.test(permissionText)
  ) {
    throw new Error(`the permissions check did not answer as expected:\n${permissionText.slice(0, 500)}`);
  }
  // A technique that needs iam:PassRole must not be listed for iam:CreatePolicyVersion.
  if (techniques.some((t: any) => t.needs.includes("iam:PassRole"))) throw new Error("a technique is listed without its permissions");
  // The page section it points to must exist in the page.
  const pointed = techniques[0];
  const section = await client.callTool({ name: "hacktricks_get_page", arguments: { path: pointed.page, section: pointed.section } });
  if ((section as any).isError || (section as any).structuredContent?.content.length < 40) throw new Error("the section the check points to is not readable");
  const badGrant = await client.callTool({ name: "hacktricks_cloud_permissions", arguments: { provider: "k8s", permissions: ["create"] } });
  if (!(badGrant as any).isError || !text(badGrant).includes("verb resource")) throw new Error("a grant that is not written as expected was accepted");
  console.log("cloud permissions OK");

  await client.close();
  console.log("Smoke test passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
