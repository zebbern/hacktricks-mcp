#!/usr/bin/env node
/**
 * hacktricks-mcp — MCP server for searching and retrieving HackTricks content.
 *
 * Reads a pre-built SQLite FTS5 index bundled with the package (data/).
 * All tools are read-only and fully local: no network access at query time.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDbReadonly, searchPages, getPage, listCategories } from "./db.js";
import { extractOutline, extractSection, extractCodeBlocks } from "./markdown.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.HACKTRICKS_DB ?? path.join(PKG_ROOT, "data", "hacktricks.db");
const TOC_PATH = path.join(PKG_ROOT, "data", "toc.json");
const META_PATH = path.join(PKG_ROOT, "data", "meta.json");

const db = openDbReadonly(DB_PATH);

const meta = fs.existsSync(META_PATH)
  ? JSON.parse(fs.readFileSync(META_PATH, "utf8"))
  : { upstreamSha: "unknown", syncedAt: "unknown", pageCount: 0 };

const server = new McpServer(
  { name: "hacktricks-mcp", version: meta.version ?? "0.1.0" },
  {
    instructions: [
      "HackTricks wiki knowledge base (offensive security: pentesting, privilege escalation,",
      "web exploitation, Active Directory, cloud, Wi-Fi, forensics, macOS/Windows/Linux).",
      "Use hacktricks_search to find relevant pages, then hacktricks_get_page to read them.",
      "Prefer section= or codeOnly= on get_page to keep responses small.",
      `Index covers ${meta.pageCount} pages, synced from upstream at ${meta.syncedAt}.`,
    ].join(" "),
  },
);

const READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const searchHitSchema = {
  pageId: z.number(),
  path: z.string().describe("Page identifier; pass this to hacktricks_get_page"),
  title: z.string(),
  category: z.string(),
  url: z.string(),
  snippet: z.string(),
};

server.registerTool(
  "hacktricks_search",
  {
    title: "Search HackTricks",
    description:
      "Full-text search over the HackTricks offensive-security wiki (pentesting techniques, " +
      "privilege escalation, web vulns, AD attacks, cloud, forensics). Returns ranked pages " +
      "with snippets. Use specific technical terms (e.g. 'kerberoast', 'SUID', 'JWT algorithm confusion') " +
      "for best results. Follow up with hacktricks_get_page on a result's path to read the content.",
    inputSchema: {
      query: z.string().min(1).describe("Search terms, e.g. 'docker escape' or 'asreproast'"),
      category: z
        .string()
        .optional()
        .describe("Optional category filter (substring match), e.g. 'Windows Hardening' or 'Pentesting Web'"),
      limit: z.number().int().min(1).max(25).default(10).describe("Max results (default 10)"),
    },
    outputSchema: { results: z.array(z.object(searchHitSchema)) },
    annotations: READONLY,
  },
  async ({ query, category, limit }) => {
    const hits = searchPages(db, query, category, limit);
    const results = hits.map((h) => ({
      pageId: h.page_id,
      path: h.path,
      title: h.title,
      category: h.category,
      url: h.url,
      snippet: h.snippet.replace(/\n+/g, " ").trim(),
    }));
    const text =
      results.length === 0
        ? `No HackTricks pages matched "${query}"${category ? ` in category "${category}"` : ""}. Try broader or different terms.`
        : results
            .map(
              (r, i) =>
                `${i + 1}. ${r.title}\n   path: ${r.path}\n   category: ${r.category}\n   ${r.snippet}`,
            )
            .join("\n\n");
    return { content: [{ type: "text", text }], structuredContent: { results } };
  },
);

server.registerTool(
  "hacktricks_get_page",
  {
    title: "Read HackTricks Page",
    description:
      "Retrieve content of a HackTricks page found via hacktricks_search. By default returns the " +
      "page outline plus content (truncated if very long). Use section= to read one section by " +
      "heading name, or codeOnly=true to get just the commands/payloads. This is the token-efficient " +
      "way to consume long pages.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Page path from hacktricks_search (e.g. 'windows-hardening/active-directory-methodology/kerberoast.md'). Unique suffixes like 'kerberoast' also work."),
      section: z
        .string()
        .optional()
        .describe("Optional heading name to extract just that section (case-insensitive substring match)"),
      codeOnly: z
        .boolean()
        .default(false)
        .describe("If true, return only fenced code blocks (commands/payloads) from the page or section"),
    },
    outputSchema: {
      title: z.string(),
      path: z.string(),
      url: z.string(),
      outline: z.array(z.string()),
      content: z.string(),
      truncated: z.boolean(),
    },
    annotations: READONLY,
  },
  async ({ path: pagePath, section, codeOnly }) => {
    const page = getPage(db, pagePath);
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

    const outline = (JSON.parse(page.outline) as { level: number; text: string }[]).map(
      (h) => `${"  ".repeat(h.level - 1)}${h.text}`,
    );

    let content: string;
    if (section) {
      const sec = extractSection(page.content, section);
      if (sec === null) {
        return {
          content: [
            {
              type: "text",
              text: `Section "${section}" not found in "${page.title}". Available sections:\n${outline.join("\n")}`,
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

    const MAX = 20000;
    let truncated = false;
    if (content.length > MAX) {
      truncated = true;
      content =
        content.slice(0, MAX) +
        `\n\n--- [TRUNCATED] Page is ${content.length} chars. Use section= to read a specific part. Sections:\n` +
        outline.join("\n");
    }

    const header = `# ${page.title}\n${page.url}\n\n`;
    return {
      content: [{ type: "text", text: header + content }],
      structuredContent: {
        title: page.title,
        path: page.path,
        url: page.url,
        outline,
        content,
        truncated,
      },
    };
  },
);

server.registerTool(
  "hacktricks_get_toc",
  {
    title: "HackTricks Table of Contents",
    description:
      "Get the HackTricks wiki structure: categories and page tree. Call without arguments for the " +
      "top-level overview, or pass a category to see its pages. Useful to understand where a topic " +
      "lives before searching.",
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe("Optional category name to expand (e.g. 'Linux Hardening'). Omit for top-level overview."),
    },
    outputSchema: {
      categories: z.array(z.object({ category: z.string(), pages: z.number() })),
      tree: z.string().describe("Indented text tree of matching pages"),
    },
    annotations: READONLY,
  },
  async ({ category }) => {
    const categories = listCategories(db);
    const toc = fs.existsSync(TOC_PATH)
      ? JSON.parse(fs.readFileSync(TOC_PATH, "utf8"))
      : null;

    let tree = "";
    if (toc) {
      const matchSection = (nodes: any[], depth: number): string[] => {
        const lines: string[] = [];
        for (const n of nodes) {
          const line = "  ".repeat(depth) + "- " + n.title + (n.path ? `  [${n.path}]` : "");
          if (category) {
            const sub = matchSection(n.children ?? [], depth + 1);
            if (sub.length > 0 || n.title.toLowerCase().includes(category.toLowerCase())) {
              lines.push(line, ...sub);
            }
          } else if (depth < 2) {
            lines.push(line, ...matchSection(n.children ?? [], depth + 1));
          }
        }
        return lines;
      };
      tree = matchSection(toc, 0).join("\n");
    }

    const catText = categories.map((c) => `- ${c.category} (${c.pages} pages)`).join("\n");
    const text = category
      ? `Pages matching "${category}":\n${tree || "(none)"}\n\nAll categories:\n${catText}`
      : `HackTricks categories:\n${catText}\n\nStructure (top 2 levels):\n${tree}`;
    return {
      content: [{ type: "text", text }],
      structuredContent: { categories, tree },
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("hacktricks-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
