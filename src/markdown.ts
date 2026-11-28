/**
 * Markdown cleaning and section utilities for HackTricks content.
 *
 * HackTricks pages are GitBook-flavored markdown full of templating noise:
 * `{% hint %}...{% endhint %}` training banners, `{{#include}}` directives,
 * `.gitbook/assets` image lines. All of that wastes agent tokens, so we strip
 * it at index time.
 */

/** Remove GitBook/mdBook templating noise and collapse whitespace. */
export function cleanMarkdown(raw: string): string {
  let text = raw;

  // Drop {% hint ... %} ... {% endhint %} blocks (HackTricks training ads)
  text = text.replace(/\{%\s*hint[^%]*%\}[\s\S]*?\{%\s*endhint\s*%\}/g, "");

  // Drop remaining single-line GitBook directives: {% ... %}, {{#include ...}}
  text = text.replace(/^\s*\{%[\s\S]*?%\}\s*$/gm, "");
  text = text.replace(/^\s*\{\{[\s\S]*?\}\}\s*$/gm, "");

  // Drop image-only lines pointing at .gitbook/assets (banner badges)
  text = text.replace(/^\s*!\[[^\]]*\]\([^)]*\.gitbook\/assets[^)]*\)\s*$/gm, "");

  // Drop HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Collapse 3+ blank lines, trim trailing spaces
  text = text.replace(/[ \t]+$/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

export interface Heading {
  level: number;
  text: string;
  /** 0-based line index in the cleaned markdown */
  line: number;
}

/** Extract the heading outline of a markdown document. */
export function extractOutline(content: string): Heading[] {
  const headings: Heading[] = [];
  const lines = content.split("\n");
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) inCode = !inCode;
    if (inCode) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) headings.push({ level: m[1].length, text: m[2], line: i });
  }
  return headings;
}

/** A heading as a reader sees it: without the marks that only give code style or emphasis. */
const withoutMarks = (text: string) => text.replace(/[`*_~]/g, "");

/**
 * Extract one section by heading text (case-insensitive substring match).
 * Returns the section from its heading until the next heading of the same or
 * higher level, or null if no heading matches.
 *
 * Marks for code style and emphasis do not count on either side. HackTricks
 * writes permission headings as "`iam:PassRole`, `lambda:CreateFunction`", and
 * a caller naming that section without the backticks, as the permissions check
 * does, must still find it.
 */
export function extractSection(content: string, section: string): string | null {
  const lines = content.split("\n");
  const headings = extractOutline(content);
  const needle = withoutMarks(section).toLowerCase();
  const match = headings.find((h) => withoutMarks(h.text).toLowerCase().includes(needle));
  if (!match) return null;

  let end = lines.length;
  for (const h of headings) {
    if (h.line > match.line && h.level <= match.level) {
      end = h.line;
      break;
    }
  }
  return lines.slice(match.line, end).join("\n").trim();
}

/**
 * Length in characters of each heading's section, cut the way extractSection
 * cuts it: from the heading to the next one of the same or higher level. Lets
 * a caller pick a section before reading any of the page.
 */
export function sectionLengths(content: string, outline: Heading[]): number[] {
  const lines = content.split("\n");
  return outline.map((h, i) => {
    const next = outline.slice(i + 1).find((n) => n.level <= h.level);
    return lines.slice(h.line, next?.line ?? lines.length).join("\n").length;
  });
}

/** Extract only fenced code blocks (commands/payloads) from a document. */
export function extractCodeBlocks(content: string): string[] {
  const blocks: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const block = m[1].trim();
    if (block) blocks.push(block);
  }
  return blocks;
}
