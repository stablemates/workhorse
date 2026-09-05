import pagesIndex from "@/.source/pages-index.json";

/**
 * The site pages collection as the routes and the navigation see it
 * (ADR 0062): the trust pages `/about`, `/contact`, and `/privacy`.
 *
 * `scripts/gen-docs-index.ts` writes `.source/pages-index.json` at build time.
 * Reading that JSON here, rather than the Fumadocs loader, keeps `node:fs` out
 * of the browser bundle, for the same reason the docs sidebar is generated
 * rather than loaded.
 */
export interface SitePageRecord {
  readonly slug: string;
  readonly url: string;
  readonly path: string;
  readonly title: string;
  readonly description: string;
}

/** Every page, sorted by slug. */
export const sitePages: readonly SitePageRecord[] = pagesIndex.pages as SitePageRecord[];
