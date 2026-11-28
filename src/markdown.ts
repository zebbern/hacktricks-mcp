/**
 * Markdown cleaning and section utilities for HackTricks content.
 *
 * HackTricks pages are GitBook-flavored markdown with templating and markup on
 * top: the `{{#include}}` of the training banner, `{{#ref}}` link scaffolding,
 * `{{#tab}}` groups, `{% hint %}` callouts, HTML comments. That is removed at
 * index time, and only outside code blocks: the pages on injection hold
 * `{{ ... }}`, `{% ... %}` and `<!-- -->` that look exactly like it and are
 * payloads. What a template carried stays, such as a tab's label and a
 * warning's text.
 */

/** What a GitBook hint style is called, in the words the book's own callouts use. */
const HINT_LABELS: Record<string, string> = {
  info: "Note",
  note: "Note",
  success: "Tip",
  tip: "Tip",
  warning: "Warning",
  danger: "Caution",
  caution: "Caution",
};

/** HackTricks templating that stands on a line of its own and carries nothing to keep. */
const SCAFFOLDING_LINE = /^\s*(\{\{#(tabs|endtabs|endtab|file|endfile)\b[^}]*\}\}|\{%\s*(embed|endembed)\b[^%]*%\})\s*$/;
const TAB_LINE = /^\s*\{\{#tab\s+name\s*=\s*["']([^"']*)["']\s*\}\}\s*$/;
/** A badge of GitBook's own assets, alone on its line. */
const BADGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\.gitbook\/assets[^)]*\)\s*$/;

/** Clean one stretch of a page that lies outside code blocks. */
function cleanProse(lines: string[]): string[] {
  // HTML comments, which start a line: the wiki does not show them either.
  // One written inside a line, or inside code, is content (the XML pages hold `<!--`).
  const text = lines.join("\n").replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*$/gm, "");
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (SCAFFOLDING_LINE.test(line) || BADGE_LINE.test(line)) continue;
    const tab = TAB_LINE.exec(line);
    if (tab) {
      kept.push(`**${tab[1].trim()}**`);
      continue;
    }
    const plain = line.replace(/\{\{#include[^}]*\}\}/g, "").replaceAll("{{#ref}}", "").replaceAll("{{#endref}}", "");
    // A heading that only held the training banner is no heading.
    if (/^\s*#+\s*$/.test(plain)) continue;
    kept.push(plain);
  }
  return kept;
}

export function cleanMarkdown(raw: string): string {
  // A hint block is a callout. Keep what it says, led by the word the book's
  // other callouts use, except for the training advertisement, which was
  // written as a hint once.
  let text = raw.replace(/\{%\s*hint([^%]*)%\}([\s\S]*?)\{%\s*endhint\s*%\}/g, (_block, attributes: string, body: string) => {
    if (/hacktricks\s+training/i.test(body)) return "";
    const style = (attributes.match(/style\s*=\s*["']?([a-z]+)/) ?? [])[1];
    const lines = body
      .split("\n")
      .filter((line) => !/\{\{#include/.test(line))
      .map((line) => line.trimEnd());
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length === 0) return "";
    return [`**${HINT_LABELS[style] ?? "Note"}.** ${lines[0].trim()}`, ...lines.slice(1)].join("\n");
  });

  // Code blocks are passed on untouched, one line as they are; the stretches
  // between them are cleaned.
  const kept: string[] = [];
  let prose: string[] = [];
  let inCode = false;
  const cleanTheRest = () => {
    kept.push(...cleanProse(prose));
    prose = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      cleanTheRest();
      kept.push(line);
      inCode = !inCode;
    } else if (inCode) kept.push(line);
    else prose.push(line);
  }
  cleanTheRest();
  text = kept.join("\n");

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
