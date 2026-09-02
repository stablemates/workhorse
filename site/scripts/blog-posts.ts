import { readFile, readdir } from "node:fs/promises";

import { frontmatterValue, stripFrontmatter } from "./frontmatter.js";

/**
 * The blog collection as the build sees it (ADR 0052).
 *
 * A post is one MDX file under `content/blog/` with frontmatter `title`,
 * `description`, and `date`. This module reads that directory into records the
 * generator writes out, and renders the RSS feed, so `gen-docs-index.ts` stays
 * the one script that decides what the site ships and this file stays the one
 * place that knows what a post is.
 */

export interface PostRecord {
  readonly slug: string;
  /** Site-relative URL, `/blog/<slug>`. */
  readonly url: string;
  /** Path of the MDX file inside the collection, for the client loader. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  /** The post body with its frontmatter removed, for the Markdown twin. */
  readonly body: string;
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date is valid when it has the ISO shape and names a day that
 * exists. `new Date("2026-02-30")` rolls over to March, so the check is that
 * the parsed date prints back as the string it was parsed from.
 */
function isCalendarDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/**
 * Reads every post in `contentDir`, newest first. Two posts on the same day
 * sort by slug so the order is the same on every build. A post with a missing
 * or malformed field fails the build, because the index, the feed, and the
 * twin all print the field and a blank in any of them reaches a reader.
 */
export async function loadPosts(contentDir: URL): Promise<PostRecord[]> {
  const entries = await readdir(contentDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const slugs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => entry.name.replace(/\.mdx$/, ""));

  const posts = await Promise.all(
    slugs.map(async (slug): Promise<PostRecord> => {
      if (!slugPattern.test(slug)) {
        throw new Error(
          `The post file "${slug}.mdx" is not a URL slug. ` +
            "Use lowercase letters, digits, and single hyphens.",
        );
      }
      const source = await readFile(new URL(`${slug}.mdx`, contentDir), "utf8");
      const title = frontmatterValue(source, "title");
      const description = frontmatterValue(source, "description");
      const date = frontmatterValue(source, "date");
      if (!title) throw new Error(`The post "${slug}" is missing a frontmatter title`);
      if (!description) throw new Error(`The post "${slug}" is missing a frontmatter description`);
      if (!date || !isCalendarDate(date)) {
        throw new Error(
          `The post "${slug}" needs a frontmatter date as an ISO calendar date (YYYY-MM-DD)`,
        );
      }
      const body = stripFrontmatter(source);
      return { slug, url: `/blog/${slug}`, path: `${slug}.mdx`, title, description, date, body };
    }),
  );

  return posts.toSorted((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** RFC 822 form of a calendar date at midnight UTC, as `<pubDate>` requires. */
const rfc822 = (date: string): string => new Date(`${date}T00:00:00Z`).toUTCString();

interface FeedChannel {
  readonly title: string;
  readonly description: string;
  /** Site origin without a trailing slash, `https://workhorse.run`. */
  readonly base: string;
}

/**
 * The RSS 2.0 feed at `/blog/feed.xml`. Every `<link>` and `<guid>` is the
 * post's canonical URL, so a reader that follows an item lands on the site and
 * never on a syndicated copy. `posts` arrive newest first from `loadPosts`, and
 * the feed keeps that order.
 */
export function renderFeed(channel: FeedChannel, posts: readonly PostRecord[]): string {
  const items = posts.map((post) => {
    const link = `${channel.base}${post.url}`;
    return [
      "    <item>",
      `      <title>${escapeXml(post.title)}</title>`,
      `      <link>${link}</link>`,
      `      <guid isPermaLink="true">${link}</guid>`,
      `      <pubDate>${rfc822(post.date)}</pubDate>`,
      `      <description>${escapeXml(post.description)}</description>`,
      "    </item>",
    ].join("\n");
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channel.title)}</title>
    <link>${channel.base}/blog</link>
    <description>${escapeXml(channel.description)}</description>
    <language>en</language>
    <atom:link href="${channel.base}/blog/feed.xml" rel="self" type="application/rss+xml" />
${items.join("\n")}
  </channel>
</rss>
`;
}
