import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadPosts, renderFeed } from "./blog-posts.js";

const directories: string[] = [];

async function collection(files: Readonly<Record<string, string>>): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), "workhorse-blog-"));
  directories.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, source]) => writeFile(join(dir, name), source)),
  );
  return pathToFileURL(`${dir}/`);
}

const post = (title: string, date: string, body = "Body.\n"): string =>
  `---\ntitle: ${title}\ndescription: About ${title}.\ndate: ${date}\n---\n\n${body}`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the blog collection", () => {
  it("reads every post newest first, with the frontmatter and the body", async () => {
    const dir = await collection({
      "older.mdx": post("Older", "2026-09-01"),
      "newer.mdx": post("Newer", "2026-09-07", "## Heading\n\nText.\n"),
      ".gitkeep": "",
      "notes.txt": "not a post",
    });

    const posts = await loadPosts(dir);

    expect(posts.map((entry) => entry.slug)).toEqual(["newer", "older"]);
    expect(posts[0]).toMatchObject({
      url: "/blog/newer",
      path: "newer.mdx",
      title: "Newer",
      description: "About Newer.",
      date: "2026-09-07",
      body: "## Heading\n\nText.\n",
    });
  });

  it("orders two posts on the same day by slug", async () => {
    const dir = await collection({
      "b-post.mdx": post("B", "2026-09-07"),
      "a-post.mdx": post("A", "2026-09-07"),
    });

    expect((await loadPosts(dir)).map((entry) => entry.slug)).toEqual(["a-post", "b-post"]);
  });

  it("is empty when the directory is empty or missing", async () => {
    const dir = await collection({ ".gitkeep": "" });
    expect(await loadPosts(dir)).toEqual([]);
    expect(await loadPosts(new URL("missing/", dir))).toEqual([]);
  });

  it("fails the build on a missing or malformed field", async () => {
    await expect(
      loadPosts(await collection({ "hello.mdx": post("Hello", "2026-9-7") })),
    ).rejects.toThrow('The post "hello" needs a frontmatter date as an ISO calendar date');
    await expect(
      loadPosts(await collection({ "hello.mdx": post("Hello", "2026-02-30") })),
    ).rejects.toThrow("ISO calendar date");
    await expect(
      loadPosts(await collection({ "hello.mdx": "---\ntitle: Hello\ndate: 2026-09-07\n---\n" })),
    ).rejects.toThrow('The post "hello" is missing a frontmatter description');
    await expect(
      loadPosts(await collection({ "Hello World.mdx": post("Hello", "2026-09-07") })),
    ).rejects.toThrow("is not a URL slug");
  });
});

describe("the feed", () => {
  it("is RSS 2.0 with one item per post, newest first, at its canonical URL", async () => {
    const dir = await collection({
      "older.mdx": post("Older & wiser", "2026-09-01"),
      "newer.mdx": post("Newer <post>", "2026-09-07"),
    });
    const feed = renderFeed(
      { title: "Workhorse blog", description: "Posts.", base: "https://workhorse.run" },
      await loadPosts(dir),
    );

    expect(feed.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"')).toBe(
      true,
    );
    expect(feed).toContain("<link>https://workhorse.run/blog</link>");
    expect(feed).toContain(
      '<atom:link href="https://workhorse.run/blog/feed.xml" rel="self" type="application/rss+xml" />',
    );
    const links = [...feed.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map((m) => m[1]);
    expect(links).toEqual(["https://workhorse.run/blog/newer", "https://workhorse.run/blog/older"]);
    expect(feed).toContain("<title>Newer &lt;post&gt;</title>");
    expect(feed).toContain("<title>Older &amp; wiser</title>");
    expect(feed).toContain("<pubDate>Mon, 07 Sep 2026 00:00:00 GMT</pubDate>");
    expect(feed).toContain('<guid isPermaLink="true">https://workhorse.run/blog/newer</guid>');
  });
});
