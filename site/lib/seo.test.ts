import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { docsPageMetadata } from "../scripts/docs-page.js";
import { documentationHead } from "./seo.js";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../content/docs");

/** The `content` of the meta tag with `key` set to `value`, or the `title` entry. */
function metaValue(head: ReturnType<typeof documentationHead>, key: string, value?: string) {
  const tags = head.meta as readonly Readonly<Record<string, string | undefined>>[];
  const entry = tags.find((tag) => (value ? tag[key] === value : key in tag));
  return value ? entry?.content : entry?.[key];
}

async function mdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return mdxFiles(path);
      return Promise.resolve(entry.name.endsWith(".mdx") ? [path] : []);
    }),
  );
  return nested.flat();
}

/** One page's frontmatter and a body line, as `scripts/gen-docs-index.ts` reads it. */
const mdx = (lines: readonly string[]) => ["---", ...lines, "---", "", "Body."].join("\n");

/** A Kysely page with this search title. */
const page = (searchTitle: string) =>
  mdx(["title: Kysely", `searchTitle: "${searchTitle}"`, "description: Enqueue in Kysely."]);

/** The head the docs route renders for a page with this source, through the generator's reader. */
const headFor = (slug: string, source: string) => {
  const metadata = docsPageMetadata(slug, source);
  return documentationHead({ url: `/docs/${slug}`, ...metadata });
};

describe("docs page head", () => {
  it("titles a page by its heading and the site name when it sets no search title", () => {
    const head = headFor("kysely", mdx(["title: Kysely", "description: Enqueue in Kysely."]));
    expect(metaValue(head, "title")).toBe("Kysely — Workhorse");
    expect(metaValue(head, "property", "og:title")).toBe("Kysely");
  });

  it("carries a frontmatter search title to the title tags and keeps the heading as the headline", () => {
    const searchTitle = "Kysely transactions: enqueue tasks with your writes";
    const head = headFor(
      "kysely",
      mdx(["title: Kysely", `searchTitle: "${searchTitle}"`, "description: Enqueue in Kysely."]),
    );
    expect(metaValue(head, "title")).toBe(searchTitle);
    expect(metaValue(head, "property", "og:title")).toBe(searchTitle);
    expect(metaValue(head, "name", "twitter:title")).toBe(searchTitle);
    const record = JSON.parse(head.scripts[0]?.children ?? "{}") as { headline?: string };
    expect(record.headline).toBe("Kysely");
  });

  it("rejects a blank search title and one longer than the limit", () => {
    expect(() => docsPageMetadata("kysely", page(""))).toThrow(/blank searchTitle/);
    expect(() => docsPageMetadata("kysely", page("   "))).toThrow(/blank searchTitle/);
    expect(() => docsPageMetadata("kysely", page("x".repeat(61)))).toThrow(/61 characters/);
    expect(docsPageMetadata("kysely", page("x".repeat(60))).searchTitle).toHaveLength(60);
  });
});

describe("docs search metadata", () => {
  it("accepts every page and keeps every comparison description short enough to show whole", async () => {
    const errors: string[] = [];
    for (const path of await mdxFiles(docsDir)) {
      const slug = path.slice(docsDir.length + 1, -".mdx".length);
      try {
        const { description } = docsPageMetadata(slug, await readFile(path, "utf8"));
        if (slug.startsWith("compare/") && description.length > 160) {
          errors.push(`${slug}: description is ${description.length} characters`);
        }
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    expect(errors).toEqual([]);
  });
});
