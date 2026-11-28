#!/usr/bin/env node
/**
 * hacktricks-mcp — MCP server for searching and retrieving HackTricks content.
 *
 * Serves the pre-built SQLite FTS5 index bundled with the package (data/),
 * which covers both HackTricks books (src/books.ts). Every tool is read-only
 * and answers from that local index. The only network use is a background
 * check for a newer index (src/refresh.ts), which never delays a tool call.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BOOKS } from "./books.js";
import { getPage, searchPages, searchTerms, listCategories, MAX_TERMS, type PageRow } from "./db.js";
import { extractSection, extractCodeBlocks, sectionLengths, type Heading } from "./markdown.js";
import { checkPermissions, type EscalationMatch } from "./permission-check.js";
import { PROVIDERS, SEVERITIES, type Severity } from "./permissions.js";
import { newestCachedIndex, openIndex, refreshInBackground, type Index } from "./refresh.js";
import type { TocNode } from "./toc.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(PKG_ROOT, "data");
/** The value of an environment variable, or undefined when it is empty or blank: an empty setting means "not set". */
const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};
const OFFLINE = ["1", "true"].includes((env("HACKTRICKS_OFFLINE") ?? "").toLowerCase());
const DB_PATH = env("HACKTRICKS_DB");

// The bundled index answers from the first call on. One that an earlier run
// downloaded is used right away if it is newer, and a newer one still is
// swapped in by the background check in main(); every tool reads this variable
// at call time.
let index: Index;
try {
  const bundled = openIndex(DATA_DIR, DB_PATH);
  const downloaded = DB_PATH ? null : newestCachedIndex(bundled);
  if (downloaded) bundled.db.close();
  index = downloaded ?? bundled;
} catch (err) {
  const file = DB_PATH ?? path.join(DATA_DIR, "hacktricks.db");
  // Written straight to stderr: this process exits at once, and a pipe write may still be pending when it does.
  fs.writeSync(
    2,
    `hacktricks-mcp: cannot start, the index at ${file} is not readable: ${(err as Error).message}` +
      (DB_PATH
        ? " HACKTRICKS_DB must point at a HackTricks index (the hacktricks.db of a package or release) or be left unset."
        : " Reinstall the package.") +
      "\n",
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
const count = (n: number) => n.toLocaleString("en-US");
const pages = (n: number) => `${count(n)} ${n === 1 ? "page" : "pages"}`;
/** An input as a message quotes it: long enough to recognise, short enough to read, with its length when cut. */
const shown = (s: string, max = 120): string => (s.length > max ? `${s.slice(0, max)}… (${s.length.toLocaleString("en-US")} characters)` : s);

// Longer than this is pasted text, not a path, a category or a permission: it
// is refused at the schema instead of being echoed back or matched against.
const MAX_PATH = 1_000;
const MAX_CATEGORY = 200;
const MAX_PERMISSION = 500;

const server = new McpServer(
  { name: "hacktricks-mcp", version: pkg.version },
  {
    instructions: [
      "HackTricks wiki knowledge base in two books: HackTricks (offensive security: pentesting,",
      "privilege escalation, web exploitation, Active Directory, Wi-Fi, forensics, macOS/Windows/Linux)",
      "and HackTricks Cloud (AWS, Azure, GCP and other providers, Kubernetes, CI/CD).",
      "Use hacktricks_search to find relevant pages, then hacktricks_get_page to read them.",
      "For cloud permissions, hacktricks_cloud_permissions rates them and lists the escalation techniques they enable.",
      "Prefer section= or codeOnly= on get_page to keep responses small.",
      `Index covers ${count(index.meta.pageCount)} pages, synced from upstream at ${index.meta.syncedAt}.`,
    ].join(" "),
  },
);

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** The first line of a page: its title and where a human can read it online (the source link for pages the wiki does not publish). */
const pageHeader = (page: PageRow) => `# ${page.title}\n${page.wiki || page.url}\n\n`;

/**
 * A page's headings with the size of each section and none of the content.
 * Agents read whole pages just to find the headings, then read sections of the
 * same pages again; this makes the first step cheap.
 */
function pageOutline(page: PageRow, headings: Heading[]) {
  const size = (n: number) => n.toLocaleString("en-US");
  const sizes = sectionLengths(page.content, headings);
  const outline = headings.map((h, i) => {
    // A heading whose section is mostly its subsections is a container. Asking
    // for it returns all of them, so say that instead of a bare size.
    let subsections = 0;
    for (const next of headings.slice(i + 1)) {
      if (next.level <= h.level) break;
      if (next.level === h.level + 1) subsections++;
    }
    const extent = subsections > 0 ? `${size(sizes[i])} chars in ${subsections} subsections` : `${size(sizes[i])} chars`;
    return `${"  ".repeat(h.level - 1)}${h.text} (${extent})`;
  });
  const summary =
    headings.length === 0
      ? `Page is ${size(page.content.length)} chars and has no headings, so read it without section.`
      : `Page is ${size(page.content.length)} chars in ${headings.length} sections. Read one with section=<heading>, adding codeOnly=true for its commands only.`;
  return {
    content: [{ type: "text" as const, text: pageHeader(page) + `${summary}\n\n${outline.join("\n")}` }],
    structuredContent: {
      title: page.title,
      book: page.book,
      path: page.path,
      url: page.url,
      wikiUrl: page.wiki,
      outline,
      content: "",
      truncated: false,
    },
  };
}

const bookSchema = z
  .enum(BOOKS.map((b) => b.id) as [string, ...string[]])
  .describe(`Book to read from. Only matters for the few paths that exist in both books, such as README.md; the default is "${BOOKS[0].id}".`);

const urlFields = {
  url: z.string().describe("Markdown source of the page on GitHub"),
  wikiUrl: z.string().describe("The page on the public wiki, to cite. Empty for the few pages the wiki does not publish."),
};

const searchHitSchema = {
  pageId: z.number(),
  book: z.enum(BOOKS.map((b) => b.id) as [string, ...string[]]).describe("Book the page belongs to"),
  path: z.string().describe("Page identifier; pass this to hacktricks_get_page"),
  title: z.string(),
  category: z.string(),
  ...urlFields,
  chars: z.number().describe("Length of the page in characters. Under about 8,000 is cheap to read whole; above that, read the outline first."),
  snippet: z.string(),
};

server.registerTool(
  "hacktricks_search",
  {
    title: "Search HackTricks",
    description:
      "Full-text search over the HackTricks wiki: both the HackTricks book (pentesting techniques, " +
      "privilege escalation, web vulns, AD attacks, forensics) and the HackTricks Cloud book (AWS, " +
      "Azure, GCP and other providers, Kubernetes, CI/CD). Returns ranked pages " +
      "with snippets and each page's size. Use technical terms or the question in plain words (e.g. 'kerberoast' or " +
      "'how do I abuse unconstrained delegation'); the page named after the technique is ranked first. " +
      "Follow up with hacktricks_get_page on a result's path to read the content.",
    inputSchema: {
      query: z.string().min(1).describe("Search terms or a plain question, e.g. 'docker escape', 'aws s3 enumeration' or 'how do I escalate from the lxd group'"),
      category: z
        .string()
        .max(MAX_CATEGORY)
        .optional()
        .describe("Optional: restrict to one category when the top hits are for the wrong one (substring match), e.g. 'Linux' or 'Windows'. hacktricks_get_toc lists them"),
      limit: z.number().int().min(1).max(25).default(10).describe("Max results (default 10)"),
    },
    outputSchema: { results: z.array(z.object(searchHitSchema)) },
    annotations: READONLY,
  },
  async ({ query, category, limit }) => {
    const hits = searchPages(index.db, query, category, limit);
    const results = hits.map((h) => ({
      pageId: h.page_id,
      book: h.book,
      path: h.path,
      title: h.title,
      category: h.category,
      url: h.url,
      wikiUrl: h.wiki,
      chars: h.chars,
      snippet: h.snippet.replace(/\n+/g, " ").trim(),
    }));
    // A pasted page has more terms than are searched; say so rather than fail silently.
    const terms = searchTerms(query).length;
    const note = terms > MAX_TERMS ? `\n(Only the first ${MAX_TERMS} of ${terms} terms were searched.)` : "";
    const text =
      results.length === 0
        ? `No HackTricks pages matched "${shown(query)}"${category ? ` in category "${shown(category)}"` : ""}. Try broader or different terms.${note}`
        : results
            .map(
              (r, i) =>
                `${i + 1}. ${r.title}\n   book: ${r.book}\n   path: ${r.path}\n   category: ${r.category}\n   size: ${r.chars.toLocaleString("en-US")} chars\n   ${r.snippet}`,
            )
            .join("\n\n") + note;
    return { content: [{ type: "text", text }], structuredContent: { results } };
  },
);

server.registerTool(
  "hacktricks_get_page",
  {
    title: "Read HackTricks Page",
    description:
      "Retrieve content of a HackTricks page found via hacktricks_search. For a long page, start with " +
      "outlineOnly=true to list its sections with their sizes, then use section= to read one section by " +
      "heading name, or codeOnly=true to get just the commands/payloads. A short page (the search " +
      "result shows its size) can be read whole. Text comes in slices of 20,000 characters; a cut " +
      "slice ends with the offset where the rest continues.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Page path from hacktricks_search (e.g. 'windows-hardening/active-directory-methodology/kerberoast.md'). Unique suffixes like 'kerberoast' also work."),
      book: bookSchema.optional(),
      outlineOnly: z
        .boolean()
        .default(false)
        .describe("If true, return the headings with the size of each section instead of the content. Use it to choose a section before reading."),
      section: z
        .string()
        .optional()
        .describe("Optional heading name to extract just that section (case-insensitive substring match)"),
      codeOnly: z
        .boolean()
        .default(false)
        .describe("If true, return only fenced code blocks (commands/payloads) from the page or section"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Skip this many characters of the page or section. A truncated response ends with the offset where the rest continues."),
    },
    outputSchema: {
      title: z.string(),
      book: z.string(),
      path: z.string(),
      ...urlFields,
      outline: z.array(z.string()),
      content: z.string(),
      truncated: z.boolean(),
      nextOffset: z
        .number()
        .optional()
        .describe("Where the rest of a truncated text continues (pass it as offset); absent when everything was returned"),
    },
    annotations: READONLY,
  },
  async ({ path: pagePath, book, outlineOnly, section, codeOnly, offset }) => {
    const page = getPage(index.db, pagePath, book);
    if (!page) {
      return {
        content: [
          {
            type: "text",
            text: `No page found for "${pagePath}". Use hacktricks_search to find valid page paths.`,
          },
        ],
        isError: true,
      };
    }

    const headings = JSON.parse(page.outline) as Heading[];
    if (outlineOnly) return pageOutline(page, headings);
    const outline = headings.map((h) => `${"  ".repeat(h.level - 1)}${h.text}`);

    let content: string;
    if (section) {
      const sec = extractSection(page.content, section);
      if (sec === null) {
        return {
          content: [
            {
              type: "text",
              text: `Section "${shown(section)}" not found in "${page.title}". Available sections:\n${outline.join("\n")}`,
            },
          ],
          isError: true,
        };
      }
      content = sec;
    } else {
      content = page.content;
    }

    if (codeOnly) {
      const blocks = extractCodeBlocks(content);
      content = blocks.length > 0 ? blocks.map((b) => "```\n" + b + "\n```").join("\n\n") : "(no code blocks found)";
    }

    // A long text comes in slices of MAX characters, and a slice that is cut
    // says where the next one starts: a section without subsections has no
    // smaller piece to ask for.
    const MAX = 20000;
    const whole = content.length;
    const slice = content.slice(offset, offset + MAX);
    const truncated = offset + slice.length < whole;
    const nextOffset = truncated ? offset + slice.length : undefined;
    if (slice.length === 0) {
      content = `Nothing left to read: the ${section ? "section" : "page"} is ${whole.toLocaleString("en-US")} characters and the offset is ${offset}.`;
    } else {
      content = slice;
      if (truncated) {
        content +=
          `\n\n--- [TRUNCATED at ${nextOffset} of ${whole.toLocaleString("en-US")} characters. Read the rest with offset=${nextOffset}, ` +
          `or use section= for a smaller part. Sections:\n${outline.join("\n")}`;
      }
    }

    return {
      content: [{ type: "text", text: pageHeader(page) + content }],
      structuredContent: {
        title: page.title,
        book: page.book,
        path: page.path,
        url: page.url,
        wikiUrl: page.wiki,
        outline,
        content,
        truncated,
        nextOffset,
      },
    };
  },
);

/** Entries whose title contains `needle`, each with everything under it. */
function tocMatching(needle: string): string[] {
  const visit = (nodes: TocNode[], depth: number, out: string[]): void => {
    for (const node of nodes) {
      const sub: string[] = [];
      visit(node.children, depth + 1, sub);
      if (sub.length > 0 || node.title.toLowerCase().includes(needle)) {
        out.push("  ".repeat(depth) + "- " + node.title + (node.path ? `  [${node.path}]` : ""), ...sub);
      }
    }
  };
  const lines: string[] = [];
  for (const book of BOOKS) {
    const found: string[] = [];
    visit(index.toc[book.id] ?? [], 0, found);
    if (found.length > 0) lines.push(`${book.title}:`, ...found);
  }
  return lines;
}

/** Pages (entries linking to one) in a subtree, the root included. */
const pagesIn = (nodes: TocNode[]): number =>
  nodes.reduce((n, node) => n + (node.path ? 1 : 0) + pagesIn(node.children), 0);

/** The map to read before searching: each book's categories and the chapters under them, no page paths. */
function tocOverview(
  categories: { book: string; category: string; pages: number }[],
): string {
  const lines = [
    `Index: ${count(index.meta.pageCount)} pages, synced ${index.meta.syncedAt}.`,
  ];
  for (const book of BOOKS) {
    const roots = index.toc[book.id] ?? [];
    if (roots.length === 0) continue;
    const inBook = categories.filter((c) => c.book === book.id);
    lines.push("", `${book.title}: ${pages(inBook.reduce((n, c) => n + c.pages, 0))}, upstream ${String(index.meta.books?.[book.id] ?? "?").slice(0, 7)}`);
    let category: string | undefined;
    for (const root of roots) {
      if (root.category !== category) {
        category = root.category;
        lines.push(`${category || "(other)"} (${pages(inBook.find((c) => c.category === (category ?? ""))?.pages ?? 0)})`);
      }
      lines.push(`  - ${root.title} (${pages(pagesIn([root]))})`);
    }
  }
  lines.push("", `Pass a filter (e.g. "Kerberos", "AWS" or "CI/CD") to list the pages under matching entries.`);
  return lines.join("\n");
}

const TOC_MAX_LINES = 300;

server.registerTool(
  "hacktricks_get_toc",
  {
    title: "HackTricks Table of Contents",
    description:
      "Get the structure of both HackTricks books from their tables of contents. Call without arguments for " +
      "the overview (each book's categories and chapters with page counts), or pass a filter to list the " +
      "pages under the entries whose title contains it. Useful to see where a topic lives before searching.",
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe("Optional text filter on entry titles, case-insensitive: a category to expand (e.g. 'Linux Hardening', 'Pentesting Cloud') or a topic to list (e.g. 'Kerberos', 'AWS', 'GitHub Actions'). Omit for the overview."),
    },
    outputSchema: {
      categories: z.array(z.object({ book: z.string(), category: z.string(), pages: z.number() })),
      tree: z.string().describe("Overview, or the indented entries matching the filter"),
    },
    annotations: READONLY,
  },
  async ({ category }) => {
    const categories = listCategories(index.db);
    const bookTitle = (id: string) => BOOKS.find((b) => b.id === id)?.title ?? id;
    const catText = categories.map((c) => `- ${bookTitle(c.book)} > ${c.category} (${pages(c.pages)})`).join("\n");

    let tree: string;
    let text: string;
    if (!category) {
      tree = tocOverview(categories);
      text = tree;
    } else {
      const lines = tocMatching(category.toLowerCase());
      if (lines.length > TOC_MAX_LINES) {
        tree = lines.slice(0, TOC_MAX_LINES).join("\n");
        text = `Entries matching "${shown(category)}" (first ${TOC_MAX_LINES} of ${lines.length} lines; use a more specific filter):\n${tree}`;
      } else {
        tree = lines.length > 0 ? lines.join("\n") : "(none)";
        text = `Entries matching "${shown(category)}":\n${tree}`;
      }
      text += `\n\nCategories:\n${catText}`;
    }
    return {
      content: [{ type: "text", text }],
      structuredContent: { categories, tree },
    };
  },
);

const severitySchema = z.enum([...SEVERITIES, "not rated"] as [Severity, ...string[]]);

server.registerTool(
  "hacktricks_cloud_permissions",
  {
    title: "Check Cloud Permissions",
    description:
      "Check cloud permissions against HackTricks Cloud. Give the permissions a principal holds and get each one's " +
      "rating (critical, high, medium, low) from the book's rated list, the combination rules they complete, and " +
      "every escalation technique in the book's catalog whose required permissions are all held, with the page " +
      "section that explains each. Use it for questions like 'is this permission dangerous?', 'what can I do with " +
      "these permissions?' or 'which of these permissions should I remove?'. Resources, scopes and request " +
      "conditions are not evaluated, so read a technique's conditions and its page before relying on it.",
    inputSchema: {
      provider: z.enum(PROVIDERS).describe('The cloud: "aws", "gcp", "azure" or "k8s"'),
      permissions: z
        .array(z.string().min(1).max(MAX_PERMISSION))
        .min(1)
        .max(200)
        .describe(
          'The permissions held, as the cloud writes them: "iam:PassRole", "iam.serviceAccounts.actAs", ' +
          '"Microsoft.Authorization/roleAssignments/write", "Application.ReadWrite.All". Wildcards as in a policy ' +
          '("iam:*", "s3:Get*", and ? for any single character). For k8s, one grant per entry as "verb resource[.group][/subresource]", "verb *" or ' +
          '"verb /url": "create pods", "get secrets", "create pods/exec", "get *", "impersonate users".',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("How many escalation techniques to list at most (default 20); the total is always reported"),
    },
    outputSchema: {
      provider: z.enum(PROVIDERS),
      risk: z.array(
        z.object({
          permission: z.string(),
          severity: severitySchema,
          note: z.string().optional().describe("What a wildcard matches, or why a Kubernetes rule rates the grant"),
        }),
      ),
      combinations: z.array(
        z.object({ severity: z.enum(SEVERITIES), permissions: z.array(z.string()) }),
      ),
      combinationsTotal: z.number().describe("Combination rules held in all; at most 25 are listed, the most severe first"),
      escalation: z.array(
        z.object({
          id: z.string(),
          service: z.string(),
          title: z.string(),
          summary: z.string(),
          severity: z.enum(SEVERITIES),
          confidence: z.string(),
          needs: z.array(z.string()),
          gains: z.string().describe("What the technique gains: the kind of principal or resource, and where"),
          conditions: z.array(z.string()),
          blockers: z.array(z.string()),
          mitigation: z.string(),
          page: z.string().describe("Page path; pass it to hacktricks_get_page"),
          section: z.string().optional().describe("Heading of the part that explains the technique, for hacktricks_get_page"),
        }),
      ),
      escalationTotal: z.number(),
      notEvaluated: z.number().describe("Techniques of this cloud that depend on more than permissions and are never listed"),
      sections: z.array(
        z.object({
          permission: z.string(),
          page: z.string(),
          heading: z.string().describe("Heading of a section named after the permission, for hacktricks_get_page"),
        }),
      ),
    },
    annotations: READONLY,
  },
  async ({ provider, permissions, limit }) => {
    let check;
    try {
      check = checkPermissions(index.db, provider, permissions, limit);
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }

    const label = (s: string) => s.padEnd(10);
    const read = (page: string, heading?: string) =>
      `hacktricks_get_page path="${page}"${heading ? ` section="${heading.replace(/"/g, "'")}"` : ""}`;
    const lines = [`hacktricks_cloud_permissions: ${provider}, ${check.risk.length} permissions.`, "", "Risk per permission"];
    for (const r of check.risk) lines.push(`  ${label(r.severity)} ${r.permission}${r.note ? `  (${r.note})` : ""}`);

    const combinationsTitle =
      (check.combinations.length > 0 ? "Combinations held (every permission of the combination is held)" : "Combinations held: none") +
      (check.combinationsTotal > check.combinations.length
        ? ` (first ${check.combinations.length} of ${count(check.combinationsTotal)}, the most severe first)`
        : "");
    lines.push("", combinationsTitle);
    for (const c of check.combinations) lines.push(`  ${label(c.severity)} ${c.permissions.join(" + ")}`);

    lines.push(
      "",
      `Escalation techniques whose permissions are all held: ${check.escalationTotal}` +
        (check.escalationTotal > check.escalation.length ? ` (first ${check.escalation.length} listed)` : ""),
    );
    check.escalation.forEach((m, i) => lines.push(...describeTechnique(m, i + 1, read)));

    // A section already named by a listed technique is not repeated.
    const covered = new Set(check.escalation.map((m) => `${m.page}#${m.section ?? ""}`));
    const sections = check.sections.filter((s) => !covered.has(`${s.page}#${s.heading}`));
    if (sections.length > 0) {
      lines.push("", "Sections of HackTricks Cloud named after these permissions");
      for (const s of sections) lines.push(`   ${s.permission}: ${read(s.page, s.heading)}`);
    }

    lines.push(
      "",
      "Not evaluated: resources, scopes, request conditions and the properties of the target. A technique is listed " +
        "when every permission it names is held; read its conditions and its page before relying on it. " +
        `${check.notEvaluated} ${provider} techniques depend on such facts and are never listed.`,
    );
    const { provider: _, ...rest } = check;
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { provider, ...rest } };
  },
);

/** The lines of one technique in the tool's text. */
function describeTechnique(m: EscalationMatch, n: number, read: (page: string, heading?: string) => string): string[] {
  const lines = [
    `${n}. [${m.severity}] ${m.title}`,
    `   needs: ${m.needs.join(", ")}   gains: ${m.gains || "see page"}   confidence: ${m.confidence}`,
  ];
  if (m.summary) lines.push(`   ${m.summary}`);
  if (m.conditions.length > 0) lines.push(`   conditions: ${m.conditions.join(" ")}`);
  if (m.blockers.length > 0) lines.push(`   blocked by: ${m.blockers.join(", ")}`);
  lines.push(`   read: ${read(m.page, m.section)}`);
  if (m.mitigation) lines.push(`   mitigate: ${m.mitigation}`);
  return lines;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("hacktricks-mcp running on stdio");

  // A custom database path is an explicit choice of index, so leave it alone.
  if (!OFFLINE && !DB_PATH) {
    refreshInBackground(
      () => index,
      (next) => {
        index.db.close();
        index = next;
      },
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
