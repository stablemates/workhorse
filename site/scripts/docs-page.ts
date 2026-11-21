import { frontmatterValue } from "./frontmatter.js";

/**
 * The longest `searchTitle` a page may set. A result list cuts a title near
 * this length, and the words past the cut are the ones a reader never sees.
 */
const searchTitleLimit = 60;

/** The search metadata a docs page's frontmatter declares. */
export interface DocsPageMetadata {
  readonly title: string;
  readonly description: string;
  /** The optional `searchTitle`: the page's `<title>`, in place of `title — Workhorse`. */
  readonly searchTitle?: string;
}

/**
 * Reads and checks the metadata of one docs page. A missing description, and a
 * `searchTitle` that is blank or longer than the limit, throw with the slug in
 * the message, so the build stops instead of publishing an empty or cut title.
 */
export function docsPageMetadata(slug: string, source: string): DocsPageMetadata {
  const title = frontmatterValue(source, "title") ?? slug;
  const description = frontmatterValue(source, "description");
  if (!description) {
    throw new Error(`The docs page "${slug}" is missing a frontmatter description`);
  }
  const searchTitle = frontmatterValue(source, "searchTitle");
  if (searchTitle === undefined) return { title, description };
  if (searchTitle.trim() === "") {
    throw new Error(`The docs page "${slug}" has a blank searchTitle`);
  }
  if (searchTitle.length > searchTitleLimit) {
    throw new Error(
      `The docs page "${slug}" has a searchTitle of ${searchTitle.length} characters; the limit is ${searchTitleLimit}`,
    );
  }
  return { title, description, searchTitle };
}
