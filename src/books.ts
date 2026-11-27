/**
 * The HackTricks books that make up the index. Shared by the indexer and the
 * server, so a page's links and its book are derived in one place.
 */
export interface Book {
  /** Stored in the `book` column and returned with every hit. */
  id: string;
  title: string;
  /** GitHub repository, `owner/name`; the book's markdown lives under `src/`. */
  repository: string;
  /** Where the rendered book is published, with a trailing slash. */
  site: string;
}

export const BOOKS: Book[] = [
  {
    id: "hacktricks",
    title: "HackTricks",
    repository: "HackTricks-wiki/hacktricks",
    site: "https://hacktricks.wiki/en/",
  },
  {
    id: "hacktricks-cloud",
    title: "HackTricks Cloud",
    repository: "HackTricks-wiki/hacktricks-cloud",
    site: "https://cloud.hacktricks.wiki/en/",
  },
];

/** The markdown source of a page on GitHub. */
export function sourceUrl(book: Book, pagePath: string): string {
  return `https://github.com/${book.repository}/blob/master/src/${pagePath}`;
}

/**
 * The rendered page on the public wiki. A `README.md` is the index of its
 * folder and has no page of its own: asking the site for `.../README.html`
 * returns its not-found page.
 */
export function wikiUrl(book: Book, pagePath: string): string {
  const folder = /^(.*)\/README\.md$/.exec(pagePath);
  return book.site + (folder ? `${folder[1]}/` : pagePath === "README.md" ? "" : pagePath.replace(/\.md$/, ".html"));
}
