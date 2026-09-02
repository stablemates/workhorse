import blogIndex from "@/.source/blog-index.json";

/**
 * The blog collection as the routes and the navigation see it (ADR 0052).
 *
 * `scripts/gen-docs-index.ts` writes `.source/blog-index.json` at build time
 * with every post newest first. Reading that JSON here, rather than the
 * Fumadocs loader, keeps `node:fs` out of the browser bundle, for the same
 * reason the docs sidebar is generated rather than loaded.
 */
export interface PostRecord {
  readonly slug: string;
  readonly url: string;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  readonly date: string;
}

/** Every post, newest first. */
export const posts: readonly PostRecord[] = blogIndex.posts as PostRecord[];

/**
 * Whether the section is linked at all. With zero posts the "Blog" link is
 * absent from the header and the footer, so an empty index never reaches a
 * reader.
 */
export const hasPosts = posts.length > 0;

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * `2026-09-07` as `September 7, 2026`. Formatted by hand so the server and the
 * browser agree on the text without depending on either one's locale data.
 */
export function formatPostDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${months[(month ?? 1) - 1]} ${day}, ${year}`;
}
