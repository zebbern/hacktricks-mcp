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

/** A heading or title as it is shown: without the footnote links that hang off many of them. */
export const withoutFootnotes = (text: string) => text.replace(/<sup>[\s\S]*?<\/sup>/gi, "").replace(/\s+/g, " ").trim();

/**
 * A heading as a reader sees it and as a request for a section names it:
 * without footnote links, without marks for code style and emphasis, with
 * single spaces, in one case. HackTricks writes permission headings as
 * "`iam:PassRole`, `lambda:CreateFunction`", a caller names them without the
 * backticks, and the permissions check prints them with single spaces.
 */
export const plainText = (text: string) => withoutFootnotes(text).replace(/[`*_~]/g, "").toLowerCase();

/** Which heading a request for a section names. */
export interface SectionMatch {
  heading: Heading | null;
  /** How many other headings of the page have exactly the text asked for. */
  sameName: number;
  /** Whether a heading has exactly the text asked for. If not, the first whose text contains it was taken. */
  exact: boolean;
}

/**
 * The heading a request names: one with exactly that text if there is one,
 * else the first whose text contains it.
 *
 * The exact match comes first because the first heading that contains the
 * text was often the wrong one: a page titled "Deep Learning
 * <sup>[[1]](#references)</sup>" answered a request for its "References"
 * section with the whole page, and a request for "usage" returned an earlier
 * "usage of the tool". On the index of 2026-11-28 that hid 1,802 headings.
 */
export function findHeading(headings: Heading[], section: string): SectionMatch {
  const needle = plainText(section);
  const matches = (exact: boolean) =>
    needle ? headings.filter((h) => (exact ? plainText(h.text) === needle : plainText(h.text).includes(needle))) : [];
  const exact = matches(true);
  if (exact.length > 0) return { heading: exact[0], sameName: exact.length - 1, exact: true };
  const partial = matches(false);
  // Headings that only contain the text do not share a name.
  return partial.length > 0 ? { heading: partial[0], sameName: 0, exact: false } : { heading: null, sameName: 0, exact: false };
}

/** The text of a section: from its heading until the next heading of the same or higher level. */
export function sectionText(content: string, heading: Heading, headings: Heading[] = extractOutline(content)): string {
  const lines = content.split("\n");
  let end = lines.length;
  for (const h of headings) {
    if (h.line > heading.line && h.level <= heading.level) {
      end = h.line;
      break;
    }
  }
  return lines.slice(heading.line, end).join("\n").trim();
}

/** Extract one section by heading text; findHeading says which heading a name picks. Null if none matches. */
export function extractSection(content: string, section: string): string | null {
  const headings = extractOutline(content);
  const { heading } = findHeading(headings, section);
  return heading ? sectionText(content, heading, headings) : null;
}

/**
 * Length in characters of each heading's section, cut the way sectionText
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

export interface CodeBlock {
  /** The word after the opening fence, when there is one: the language. */
  language: string;
  code: string;
  /** A line that is only a bold label right above the fence. The cleaner turns the name of a tab into one. */
  label?: string;
}

/**
 * The fenced code blocks (commands and payloads) of a document, each with the
 * word after its fence and with the label above it when there is one, so that
 * the blocks of two tabs can be told apart.
 */
export function extractCodeBlocks(content: string): CodeBlock[] {
  const lines = content.split("\n");
  const blocks: CodeBlock[] = [];
  const isFence = (line: string) => /^\s*```/.test(line);
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*```\s*(\S*)/.exec(lines[i]);
    if (!open) continue;
    let end = i + 1;
    while (end < lines.length && !isFence(lines[end])) end++;
    if (end < lines.length) {
      const code = lines.slice(i + 1, end).join("\n").trim();
      if (code) {
        let above = i - 1;
        while (above >= 0 && !lines[above].trim()) above--;
        const label = above >= 0 ? /^\s*\*\*([^*\n]+)\*\*\s*$/.exec(lines[above]) : null;
        blocks.push({ language: open[1].replace(/[^\w+-].*$/, "").toLowerCase(), code, ...(label ? { label: label[1].trim() } : {}) });
      }
    }
    i = end;
  }
  return blocks;
}
