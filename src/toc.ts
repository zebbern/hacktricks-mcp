/**
 * Parser for HackTricks' src/SUMMARY.md (mdBook/GitBook table of contents).
 *
 * Produces a nested tree of { title, path?, children } plus a flat map from
 * markdown path -> { title, category, breadcrumb } used to enrich the index.
 */

export interface TocNode {
  title: string;
  /** Repo-relative path under src/ (e.g. "windows-hardening/ntlm/README.md"), if the entry links to a page */
  path?: string;
  children: TocNode[];
}

export interface PageMeta {
  title: string;
  /** Top-level SUMMARY.md section, e.g. "Windows Hardening" */
  category: string;
  /** Breadcrumb of ancestor titles, e.g. ["Windows Hardening", "Active Directory Methodology"] */
  breadcrumb: string[];
}

const ENTRY_RE = /^(\s*)[-*]\s+\[([^\]]+)\]\(([^)]*)\)\s*$/;
const HEADER_RE = /^#\s+(.+?)\s*$/;

export function parseSummary(summary: string): { tree: TocNode[]; pages: Map<string, PageMeta> } {
  const tree: TocNode[] = [];
  const pages = new Map<string, PageMeta>();

  // Stack of (indent, node) to track nesting; -1 indent for root level
  const stack: { indent: number; node: TocNode }[] = [];
  let currentSection = "";
  const breadcrumbStack: { indent: number; title: string }[] = [];

  for (const line of summary.split("\n")) {
    const header = HEADER_RE.exec(line);
    if (header) {
      currentSection = header[1].replace(/[^\w\s&-]/g, "").trim();
      continue;
    }

    const m = ENTRY_RE.exec(line);
    if (!m) continue;

    const indent = m[1].length;
    const title = m[2].trim();
    const rawPath = m[3].trim();
    const path = rawPath.length > 0 ? rawPath : undefined;

    const node: TocNode = { title, path, children: [] };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length === 0) tree.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });

    if (path) {
      while (breadcrumbStack.length > 0 && breadcrumbStack[breadcrumbStack.length - 1].indent >= indent)
        breadcrumbStack.pop();
      const breadcrumb = [currentSection, ...breadcrumbStack.map((b) => b.title)].filter(Boolean);
      pages.set(path, { title, category: currentSection, breadcrumb });
    }
    breadcrumbStack.push({ indent, title });
  }

  return { tree, pages };
}

/** Render the TOC tree as an indented plain-text outline for agent consumption. */
export function renderTocText(nodes: TocNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push("  ".repeat(depth) + "- " + node.title + (node.path ? `  [${node.path}]` : ""));
    lines.push(renderTocText(node.children, depth + 1));
  }
  return lines.filter(Boolean).join("\n");
}
