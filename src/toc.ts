/**
 * Parser for HackTricks' src/SUMMARY.md (mdBook/GitBook table of contents).
 *
 * Produces a nested tree of { title, path?, category?, children } plus a flat map from
 * markdown path -> { title, category, breadcrumb } used to enrich the index.
 */

export interface TocNode {
  title: string;
  /** Repo-relative path under src/ (e.g. "windows-hardening/ntlm/README.md"), if the entry links to a page */
  path?: string;
  /** SUMMARY.md section ("# Heading") the entry sits under; set on top-level entries. */
  category?: string;
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

  for (const raw of summary.split("\n")) {
    // Upstream annotates some entries with an HTML comment about where their
    // title came from (17 carried one on 2026-11-27). It is not part of the entry.
    const line = raw.replace(/<!--.*?-->/g, "");
    const header = HEADER_RE.exec(line);
    if (header) {
      // Keep the words and the punctuation inside names ("CI/CD", "Hardware/Physical
      // Access"); drop the emoji every heading starts with.
      currentSection = header[1]
        .replace(/[^\p{L}\p{N}\s&/+.#-]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
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
    if (stack.length === 0) {
      node.category = currentSection;
      tree.push(node);
    } else stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });

    if (path) {
      while (breadcrumbStack.length > 0 && breadcrumbStack[breadcrumbStack.length - 1].indent >= indent)
        breadcrumbStack.pop();
      const breadcrumb = [currentSection, ...breadcrumbStack.map((b) => b.title)].filter(Boolean);
      pages.set(path, { title, category: currentSection, breadcrumb });
    }
    breadcrumbStack.push({ indent, title });
  }

  // Entries that link nowhere point at another site ("Pentesting Printers", or a
  // page of the other book). With no page of their own they are dropped.
  return { tree: pruneToc(tree), pages };
}

/**
 * Remove the entries `keep` rejects, then any left that neither link to a
 * page nor hold other entries.
 */
export function pruneToc(nodes: TocNode[], keep: (node: TocNode) => boolean = () => true): TocNode[] {
  const kept = nodes.filter(keep).map((node) => ({ ...node, children: pruneToc(node.children, keep) }));
  return kept.filter((node) => node.path || node.children.length > 0);
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
