/**
 * End-to-end tests of inputs from outside the happy path: vague page paths,
 * pasted text, oversized fields, malformed permissions and blank environment
 * settings. Each once made the built server answer with something wrong or
 * unreadable, so the answer is asserted on here. The rules are in docs/tools.md.
 * The last check is on the page cleaner, which once deleted payloads.
 *
 * Every check runs even after one fails, and the test fails if any did.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanMarkdown, extractCodeBlocks, extractOutline, extractSection, findHeading, withoutFootnotes } from "../src/markdown.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(PKG_ROOT, "dist", "server.js");
const S = "hacktricks_search";
const P = "hacktricks_get_page";
const C = "hacktricks_cloud_permissions";
const KERBEROAST = "windows-hardening/active-directory-methodology/kerberoast.md";
const LAMBDA_PRIVESC = "pentesting-cloud/aws-security/aws-privilege-escalation/aws-lambda-privesc/README.md";
const text = (result: any): string => (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
const paths = (result: any): string[] => (result.structuredContent?.results ?? []).map((r: any) => r.path as string);
/** The permissions the check rates, by name: their severity. */
const risk = (result: any): Record<string, string> =>
  Object.fromEntries((result.structuredContent?.risk ?? []).map((r: any) => [r.permission as string, r.severity as string]));

/** Fail the check with what came back. */
function expect(ok: boolean, what: string, got: string): void {
  if (!ok) throw new Error(`${what}:\n${got.slice(0, 600)}`);
}

const failed: string[] = [];
async function check(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const note = await run();
    console.log(`${label} OK${note ? ` (${note})` : ""}`);
  } catch (err) {
    failed.push(label);
    console.error(`${label} FAILED:\n${String((err as Error).message).slice(0, 900)}\n`);
  }
}

/** A server started with `env` added to this process's environment. What it prints on stderr is kept, and shown unless it is the usual start-up line. */
async function start(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    stderr: "pipe",
    env: { ...process.env, HACKTRICKS_OFFLINE: "1", ...env } as Record<string, string>,
  });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    const s = d.toString();
    stderr += s;
    if (!s.includes("running on stdio")) console.error("[server stderr]", s.slice(0, 500));
  });
  return { transport, stderr: () => stderr, client: new Client({ name: "smoke-edge", version: "0.0.1" }) };
}

async function main() {
  // On a Node.js without node:sqlite the executable used to die with a stack
  // trace about a missing built-in module, naming neither the package nor the
  // Node.js it needs. A preload makes the running Node.js report an older
  // version, since the oldest supported one is not at hand.
  await check("a Node.js that is too old is told what the executable needs", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "hacktricks-smoke-edge-"));
    const preload = path.join(folder, "old-node.mjs");
    fs.writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "20.11.1" });\n');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", pathToFileURL(preload).href, path.join(PKG_ROOT, "dist", "main.js")],
      stderr: "pipe",
      env: { ...process.env, HACKTRICKS_OFFLINE: "1" } as Record<string, string>,
    });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const client = new Client({ name: "smoke-edge", version: "0.0.1" });
    const connected = await Promise.race([
      client.connect(transport).then(
        () => true,
        () => false,
      ),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), 10_000)),
    ]);
    if (connected) await client.close().catch(() => {});
    fs.rmSync(folder, { recursive: true, force: true });
    expect(
      !connected && /hacktricks-mcp needs Node.js 22\.13 or newer, and this is Node\.js 20\.11\.1\. Update Node\.js and start again\./.test(stderr),
      "an old Node.js is not told what the executable needs",
      stderr.slice(0, 400),
    );
  });

  // Blank settings mean "not set": the server starts on the bundled index.
  await check("blank environment settings are taken as unset", async () => {
    const blank = await start({ HACKTRICKS_DB: "", HACKTRICKS_INDEX_URL: "   ", HACKTRICKS_CACHE_DIR: "" });
    await blank.client.connect(blank.transport);
    const { tools } = await blank.client.listTools();
    expect(tools.length === 4, "a blank HACKTRICKS_DB or HACKTRICKS_INDEX_URL kept the tools from being listed", JSON.stringify(tools.map((t) => t.name)));
    await blank.client.close();
  });

  // A file that is not an index is refused before the first call, and the
  // message reaches stderr although the process exits at once.
  await check("an index that cannot be read is refused at startup", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "hacktricks-smoke-edge-"));
    const notAnIndex = path.join(folder, "not-an-index.db");
    fs.writeFileSync(notAnIndex, "this is not a database");
    const bad = await start({ HACKTRICKS_DB: notAnIndex });
    const connected = await Promise.race([
      bad.client.connect(bad.transport).then(
        () => true,
        () => false,
      ),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), 10_000)),
    ]);
    if (connected) await bad.client.close().catch(() => {});
    const said = bad.stderr();
    fs.rmSync(folder, { recursive: true, force: true });
    expect(
      !connected && /cannot start, the index at .* is not readable/.test(said) && /HACKTRICKS_DB must point at a HackTricks index/.test(said),
      "a HACKTRICKS_DB that is not an index was not refused with a message that says what to do",
      `connected: ${connected}\nstderr: ${said}`,
    );
  });

  const { transport, client } = await start({});
  await client.connect(transport);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;

  // A page is read only for a path that names one; anything else says why.
  await check("get_page names candidates instead of reading a page it was not asked for", async () => {
    const page = async (p: string) => call(P, { path: p, outlineOnly: true });
    const read = await page("kerberoast ");
    expect(read.structuredContent?.path === KERBEROAST, "a path with a trailing space is not found", text(read));
    const readme = await page("README");
    expect(readme.structuredContent?.book === "hacktricks" && readme.structuredContent?.path === "README.md", `"README" does not read the book's own README`, text(readme));
    const none = await page("zzz-page.md");
    expect(none.isError && text(none).startsWith('No page found for "zzz-page.md"'), "a path that names no page does not say so", text(none));
    const dots = await page("..");
    expect(dots.isError && text(dots).startsWith("No page found"), `".." is not refused as a path`, text(dots));
    const everywhere = await page("e");
    expect(
      everywhere.isError && /lies in [\d,]+ of the [\d,]+ page paths, so no page was read/.test(text(everywhere)) && !text(everywhere).includes("\n"),
      "a piece that lies in most paths does not say only that",
      text(everywhere),
    );
    // "EADME" lists README.md, a path that is in both books: it must be named once.
    for (const piece of ["kerberos", "EADME"]) {
      const several = await page(piece);
      const listed = text(several).split("\n").slice(1).map((l) => l.trim()).filter((l) => !l.startsWith("..."));
      expect(
        several.isError &&
          /lies in [\d,]+ page paths, so no page was read/.test(text(several)) &&
          listed.length > 1 &&
          listed.every((l) => l.toLowerCase().includes(piece.toLowerCase())) &&
          new Set(listed).size === listed.length,
        `"${piece}" does not list the paths that share it, each once`,
        text(several),
      );
    }
  });

  // A permission and a path are split at their separators, as the pages are.
  await check("search splits permissions and paths at their separators", async () => {
    const split = await call(S, { query: "iam:PassRole lambda:CreateFunction", limit: 5 });
    expect(paths(split).includes(LAMBDA_PRIVESC), "a query of two permissions does not find the Lambda privesc page", text(split));
    const asPath = await call(S, { query: KERBEROAST, limit: 5 });
    expect(paths(asPath)[0] === KERBEROAST, "a page path as the query does not find that page first", text(asPath));
  });

  // Pasted text is searched, within limits it states, and not echoed back.
  await check("search takes pasted text without echoing it", async () => {
    const words = ["kerberoast", ...Array.from({ length: 400 }, (_, i) => `word${i}`)];
    const began = performance.now();
    const long = await call(S, { query: words.join(" "), limit: 3 });
    const ms = Math.round(performance.now() - began);
    expect(
      paths(long)[0] === KERBEROAST && text(long).includes("(Only the first 32 of 401 terms were searched.)"),
      "a query with more terms than are searched does not find the page or say so",
      text(long).slice(-300),
    );
    const megabyte = await call(S, { query: "zzqx".repeat(250_000) });
    expect(text(megabyte).length < 2_000 && text(megabyte).includes("(1,000,000 characters)"), "a query of a megabyte is echoed back", `${text(megabyte).length} chars`);
    return `${ms} ms for ${words.length} terms`;
  });

  // Permissions pasted into one entry are rated each and once, and the lists stay short.
  await check("cloud permissions takes pasted and malformed permissions", async () => {
    const glued = await call(C, { provider: "aws", permissions: ["iam:PassRole, lambda:CreateFunction"] });
    expect(risk(glued)["iam:PassRole"] === "critical" && risk(glued)["lambda:CreateFunction"] === "high", "two permissions glued into one entry are not rated each", text(glued).slice(0, 300));
    const twice = await call(C, { provider: "aws", permissions: ["iam:PassRole", "iam:PassRole"] });
    expect(Object.keys(risk(twice)).length === 1, "a permission given twice is rated twice", text(twice).slice(0, 300));
    const everything = await call(C, { provider: "aws", permissions: ["*"] });
    expect(
      everything.structuredContent?.combinations?.length === 25 &&
        everything.structuredContent?.combinationsTotal > 25 &&
        text(everything).includes("(first 25 of ") &&
        text(everything).length < 60_000,
      "a wildcard that holds every combination rule does not list 25 of them and say so",
      text(everything).split("\n").filter((l) => /Combinations held/.test(l)).join("\n"),
    );
    // "?" matches any single character, and no more than one.
    const one = await call(C, { provider: "aws", permissions: ["iam:Pass?ole"] });
    const two = await call(C, { provider: "aws", permissions: ["iam:Pass??ole"] });
    expect(
      risk(one)["iam:Pass?ole"] === "critical" && risk(two)["iam:Pass??ole"] === "not rated",
      '"?" does not match exactly one character',
      `${text(one).slice(0, 200)}\n---\n${text(two).slice(0, 200)}`,
    );
  });

  // A field far longer than any real one is refused, not echoed back or matched.
  await check("oversized fields are refused", async () => {
    for (const [name, args, limit] of [
      [P, { path: "a".repeat(60_000) }, 1_000],
      [S, { query: "kerberos", category: "x".repeat(60_000) }, 200],
      [C, { provider: "aws", permissions: ["a".repeat(10_000)] }, 500],
    ] as const) {
      const refused = await call(name, args);
      expect(refused.isError && text(refused).includes(`at most ${limit}`) && text(refused).length < 2_000, `${name} took a field of tens of thousands of characters`, text(refused).slice(0, 300));
    }
  });

  // The cleaner once took the pages on injection for templating: it removed
  // `{% ... %}` and `{{ ... }}` lines, and everything from a `<!--` to the next
  // `-->`, inside code blocks too. The polyglot cheatsheet was left with 927 of
  // its 10,277 characters. First on a page with every construct, then on the
  // built index.
  await check("the cleaner keeps payloads, warnings and tab labels, and removes only scaffolding", async () => {
    const cleaned = cleanMarkdown(
      [
        "{{#include ../banners/hacktricks-training.md}}",
        '{% hint style="warning" %}',
        "Do not use this on a network you do not own.",
        "{{#include ../banners/hacktricks-training.md}}",
        "{% endhint %}",
        "{{#tabs}}",
        '{{#tab name="vol3"}}',
        "```bash",
        "{% debug %}",
        "{{7*7}}",
        "```",
        "{{#endtab}}",
        '{{#tab name="vol2"}}',
        "```bash",
        "vol.py --profile=Win7SP1x86",
        "```",
        "{{#endtabs}}",
        "See [fast bin attack]({{#ref}}fast-bin-attack.md{{#endref}}) and {{7*7}}[7*7].",
        "```xml",
        "<!DOCTYPE a [ <!NOTATION b SYSTEM 'c'> ]><!-- d -->",
        "```",
        "<!-- a comment -->",
        "- Insert `<!--x-->` before the value.",
        "",
      ].join("\n"),
    );
    const kept = [
      "**Warning.** Do not use this on a network you do not own.",
      "**vol3**",
      "**vol2**",
      "{% debug %}",
      "{{7*7}}",
      "[fast bin attack](fast-bin-attack.md)",
      "{{7*7}}[7*7]",
      "<!DOCTYPE a [ <!NOTATION b SYSTEM 'c'> ]><!-- d -->",
      "Insert `<!--x-->` before the value.",
    ];
    const gone = ["{{#include", "{{#tab", "{{#tabs}}", "{{#ref}}", "{% hint", "a comment -->"];
    for (const s of kept) expect(cleaned.includes(s), `the cleaner dropped ${JSON.stringify(s)}`, cleaned);
    for (const s of gone) expect(!cleaned.includes(s), `the cleaner left the scaffolding ${JSON.stringify(s)} in the page`, cleaned);
    // Upstream has 32 sections on this page; 4 were left when the cleaner took its payloads for templating.
    const cheatsheet = await call(P, { path: "pentesting-web/pocs-and-polygloths-cheatsheet/README.md", outlineOnly: true });
    expect((cheatsheet.structuredContent?.outline ?? []).length >= 28, "the polyglot cheatsheet has lost sections", text(cheatsheet).slice(0, 600));
  });

  // A section used to be the first heading whose text contained the name asked
  // for: "References" on a page titled "Deep Learning <sup>[[1]](#references)</sup>"
  // returned the whole page, and headings the permissions check prints with
  // single spaces were not found when the page had two. Code blocks came back
  // without the label of their tab and without their language.
  await check("a section is found by its exact name first, and a name that fits several says so", async () => {
    const page = ["# Deep Learning <sup>[[1]](#references)</sup>", "", "## Theory", "", "text of the theory", "", "## References", "", "- a source", "", "## Usage", "", "first", "", "## Usage", "", "second"].join("\n");
    expect(extractSection(page, "references") === "## References\n\n- a source", "the References section is not found under a title that contains the word", String(extractSection(page, "references")));
    expect(extractSection(page, "theory") === "## Theory\n\ntext of the theory", "a section is not found by its name in another case", String(extractSection(page, "theory")));
    const spaced = "# Page\n\n## (`a` | `b`),  `c`\n\nbody\n";
    expect(extractSection(spaced, "(a | b), c") === "## (`a` | `b`),  `c`\n\nbody", "marks and double spaces in a heading count against a name given without them", String(extractSection(spaced, "(a | b), c")));
    const twice = findHeading(extractOutline(page), "usage");
    expect(twice.heading?.text === "Usage" && twice.exact && twice.sameName === 1, "a name that two headings share does not say so", JSON.stringify(twice));
    const partial = findHeading(extractOutline(page), "theor");
    expect(partial.heading?.text === "Theory" && !partial.exact && partial.sameName === 0, "a name no heading has exactly is not told apart", JSON.stringify(partial));
    expect(withoutFootnotes("Deep Learning <sup>[[1]](#references)</sup><sup>[[2]](#references)</sup>") === "Deep Learning", "footnote links are not dropped from a title", withoutFootnotes(page.split("\n")[0]));
    const blocks = extractCodeBlocks(["**vol3**", "", "```Bash", "vol.py --version", "```", "", "text in between", "", "```", "plain", "```", "unclosed"].join("\n"));
    expect(blocks.length === 2 && blocks[0].language === "bash" && blocks[0].label === "vol3" && blocks[1].code === "plain" && !blocks[1].label, "a code block loses its language or the label above it", JSON.stringify(blocks));

    // Through the server: a name that fits no heading exactly is answered with a note, an exact one without.
    const outline = await call(P, { path: KERBEROAST, outlineOnly: true });
    const headings: string[] = outline.structuredContent?.outline ?? [];
    const name = (headings[2] ?? headings[0]).replace(/\(\d[\d,]+ chars.*\)$/, "").trim();
    const part = name.slice(0, 3).toLowerCase();
    const noted = await call(P, { path: KERBEROAST, section: part });
    expect(!noted.isError && text(noted).includes(`(no section is named exactly "${part}"`) && !text(noted).includes("sections of this page are named"), "a section read by a part of its name does not say so, or claims a shared name", text(noted).slice(0, 300));
    const exact = await call(P, { path: KERBEROAST, section: name });
    expect(!exact.isError && !text(exact).includes("(no section is named exactly"), "a section read by its exact name is treated as a partial one", text(exact).slice(0, 300));
    const commands = await call(P, { path: "pentesting-web/pocs-and-polygloths-cheatsheet/README.md", codeOnly: true });
    expect(!commands.isError && text(commands).includes("```bash\n"), "code blocks come back without their language", text(commands).slice(0, 300));
  });

  await client.close();
  if (failed.length > 0) throw new Error(`Failed: ${failed.join("; ")}`);
  console.log("Edge-case smoke test passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
