import { readFile, readdir } from "node:fs/promises";

import { frontmatterValue, stripFrontmatter } from "./frontmatter.js";

/**
 * The site pages collection: the prose pages that are neither documentation
 * nor posts, served at `/<slug>`. Today they are the trust pages an agent reads
 * before it recommends a product: `/about`, `/contact`, and `/privacy`.
 *
 * A page is one MDX file under `content/pages/` with frontmatter `title` and
 * `description`. This module reads the directory into records the generator
 * writes out, so `gen-docs-index.ts` stays the one script that decides what the
 * site ships and this file stays the one place that knows what a page is. It
 * mirrors `blog-posts.ts` without the date: a page is current, not dated.
 */

export interface SitePageRecord {
  readonly slug: string;
  /** Site-relative URL, `/<slug>`. */
  readonly url: string;
  /** Path of the MDX file inside the collection, for the client loader. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** The page body with its frontmatter removed, for the Markdown twin. */
  readonly body: string;
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slugs a page may not take, because a route or a generated file already owns
 * the URL. A page named `docs` would be unreachable and its twin would
 * overwrite the docs index twin.
 */
const reservedSlugs = new Set(["docs", "blog", "api", "assets", "not-found", "index", "404", "up"]);

/**
 * Reads every page in `contentDir`, sorted by slug so the order is the same on
 * every build. A page with a missing field fails the build, because the twin,
 * the sitemap, and the page head all print the field and a blank in any of
 * them reaches a reader.
 */
export async function loadSitePages(contentDir: URL): Promise<SitePageRecord[]> {
  const entries = await readdir(contentDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const slugs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => entry.name.replace(/\.mdx$/, ""))
    .toSorted();

  return Promise.all(
    slugs.map(async (slug): Promise<SitePageRecord> => {
      if (!slugPattern.test(slug)) {
        throw new Error(
          `The page file "${slug}.mdx" is not a URL slug. ` +
            "Use lowercase letters, digits, and single hyphens.",
        );
      }
      if (reservedSlugs.has(slug)) {
        throw new Error(`The page "${slug}" takes a URL another route or file already owns`);
      }
      const source = await readFile(new URL(`${slug}.mdx`, contentDir), "utf8");
      const title = frontmatterValue(source, "title");
      const description = frontmatterValue(source, "description");
      if (!title) throw new Error(`The page "${slug}" is missing a frontmatter title`);
      if (!description) throw new Error(`The page "${slug}" is missing a frontmatter description`);
      const body = stripFrontmatter(source);
      return { slug, url: `/${slug}`, path: `${slug}.mdx`, title, description, body };
    }),
  );
}
