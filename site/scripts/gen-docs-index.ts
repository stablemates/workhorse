import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { siteConfig } from "../lib/site.js";

/**
 * Builds everything the docs routes need without loading Fumadocs at runtime.
 *
 * The Fumadocs loader in `lib/source.ts` reads the filesystem, so importing it
 * from a route drags `node:fs` into the browser bundle and the page dies on the
 * first client-side navigation. This script runs at build time instead and
 * emits plain JSON: the sidebar tree, one metadata record per page, the
 * sitemap, the robots file, and the prerender list.
 *
 * The sidebar shape lives in `structure` below. Folders are collapsible and can
 * nest, and they carry no URL of their own, so the page files stay flat and
 * every `/docs/<slug>` URL keeps working.
 */

interface Group {
  readonly title: string;
  /** Key in the icon map in `src/routes/docs.tsx`. */
  readonly icon: string;
  readonly defaultOpen?: boolean;
  readonly pages?: readonly string[];
  readonly groups?: readonly Group[];
}

/**
 * Sidebar logos, keyed by page slug. The value names a file in
 * `public/brand/integrations`. Every integration carries its own mark, so a
 * reader scanning the group recognizes the tool before reading the label.
 */
/**
 * Sidebar labels, where the page title is too long or too internal to scan.
 *
 * A page title explains; a sidebar label points. "Idempotent enqueue" is the
 * right title and the wrong label, because a reader scanning a column has not
 * read the page yet and is looking for the thing that stops duplicates. The
 * page keeps its title, and only the nav entry changes.
 */
const sidebarLabels: Readonly<Record<string, string>> = {
  integrations: "Overview",
  enqueue: "Enqueue a job",
  contracts: "Validate payloads",
  idempotency: "Avoid duplicates",
  priority: "Run order",
  "job-dependencies": "Wait for other jobs",
  "concurrency-policies": "Limit how many run",
  debounce: "Debounce",
  throttle: "Throttle",
  "batch-handlers": "Batch handlers",
  deadlines: "Deadlines",
  "durable-execution": "Checkpoints",
  "human-waits": "Human approval",
  queries: "Query jobs",
  "dead-letters": "Dead letters",
  maintenance: "Retention",
  "agentic-flow": "Agent workflows",
  api: "API",
};

const logos: Readonly<Record<string, string>> = {
  drizzle: "drizzle",
  prisma: "prisma",
  typeorm: "typeorm",
  kysely: "kysely",
};

const structure: readonly Group[] = [
  {
    title: "Getting started",
    icon: "rocket",
    defaultOpen: true,
    pages: ["index", "comparison", "installation", "quickstart", "concepts"],
  },
  {
    title: "Producing work",
    icon: "inbox",
    pages: ["enqueue", "contracts", "idempotency", "schedules"],
  },
  {
    title: "Controlling flow",
    icon: "filter",
    pages: [
      "priority",
      "job-dependencies",
      "concurrency-policies",
      "rate-limits",
      "debounce",
      "throttle",
    ],
  },
  {
    title: "Executing work",
    icon: "play",
    pages: ["workers", "batch-handlers", "retries", "cancellation", "deadlines"],
  },
  {
    title: "Durable execution",
    icon: "workflow",
    pages: ["durable-execution", "signals", "human-waits", "child-jobs", "progress"],
  },
  {
    title: "Operating",
    icon: "activity",
    pages: [
      "dashboard",
      "queries",
      "dead-letters",
      "operations",
      "worker-processes",
      "maintenance",
      "queue-health",
    ],
  },
  {
    title: "Integrations",
    icon: "plug",
    pages: ["integrations"],
    groups: [{ title: "ORMs", icon: "database", pages: ["drizzle", "prisma", "typeorm", "kysely"] }],
  },
  {
    title: "Guides",
    icon: "book",
    pages: ["examples", "agentic-flow"],
  },
  {
    title: "Reference",
    icon: "code",
    pages: ["api", "language-clients", "compatibility", "limitations"],
  },
];

interface PageRecord {
  readonly slug: string;
  readonly url: string;
  readonly path: string;
  readonly title: string;
  readonly description: string;
}

const contentDir = new URL("../content/docs/", import.meta.url);

const frontmatterValue = (source: string, key: string): string | undefined => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!block?.[1]) return undefined;
  const line = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block[1]);
  if (!line?.[1]) return undefined;
  return line[1].trim().replace(/^["']|["']$/g, "");
};

const entries = await readdir(contentDir, { withFileTypes: true });
const slugs = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
  .map((entry) => entry.name.replace(/\.mdx$/, ""));

const pages = new Map<string, PageRecord>();
await Promise.all(
  slugs.map(async (slug) => {
    const source = await readFile(new URL(`${slug}.mdx`, contentDir), "utf8");
    pages.set(slug, {
      slug,
      url: slug === "index" ? "/docs" : `/docs/${slug}`,
      path: `${slug}.mdx`,
      title: frontmatterValue(source, "title") ?? slug,
      description: frontmatterValue(source, "description") ?? siteConfig.description,
    });
  }),
);

const placed = new Set<string>();

const pageNode = (slug: string) => {
  const page = pages.get(slug);
  if (!page) throw new Error(`The sidebar lists "${slug}", which has no file in content/docs`);
  placed.add(slug);
  const logo = logos[slug];
  return {
    type: "page" as const,
    name: sidebarLabels[slug] ?? page.title,
    url: page.url,
    ...(logo ? { icon: logo } : {}),
  };
};

const folderNode = (group: Group): unknown => ({
  type: "folder" as const,
  name: group.title,
  icon: group.icon,
  defaultOpen: group.defaultOpen ?? false,
  children: [
    ...(group.pages ?? []).map(pageNode),
    ...(group.groups ?? []).map(folderNode),
  ],
});

const tree = {
  name: "Documentation",
  children: structure.map(folderNode),
};

const missing = slugs.filter((slug) => !placed.has(slug)).toSorted();
if (missing.length > 0) {
  throw new Error(
    `These pages exist but no sidebar group lists them: ${missing.join(", ")}. ` +
      "Add each one to `structure` in site/scripts/gen-docs-index.ts.",
  );
}

const outDir = new URL("../.source/", import.meta.url);
await mkdir(outDir, { recursive: true });
await mkdir(new URL("../public/", import.meta.url), { recursive: true });

await writeFile(
  new URL("docs-index.json", outDir),
  `${JSON.stringify({ tree, pages: Object.fromEntries(pages) }, null, 2)}\n`,
);

const routes = ["/docs", ...[...pages.values()].map((page) => page.url).filter((url) => url !== "/docs").toSorted()];

await writeFile(
  new URL("prerender.json", outDir),
  `${JSON.stringify(["/", ...routes, "/api/search"], null, 2)}\n`,
);

const base = siteConfig.url.replace(/\/$/, "");
const lastmod = new Date().toISOString();


await writeFile(
  new URL("../public/sitemap.xml", import.meta.url),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (route) =>
      `  <url><loc>${base}${route}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>${
        route === "/docs" ? 1 : 0.7
      }</priority></url>`,
  )
  .join("\n")}
</urlset>
`,
);

/**
 * Markdown twins, one per page, at `/docs/<slug>.md`.
 *
 * An agent that fetches a docs URL gets an HTML shell it has to strip. These
 * files hand it the source instead. The frontmatter goes, the title becomes an
 * H1, and the body is left alone so identifiers and code survive exactly.
 */
await mkdir(new URL("../public/docs/", import.meta.url), { recursive: true });
await Promise.all(
  [...pages.values()].map(async (page) => {
    const source = await readFile(new URL(page.path, contentDir), "utf8");
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart();
    // `index` is served at `/docs`, so its twin is `/docs.md`, not
    // `/docs/index.md`. Every other page keeps its slug.
    const target =
      page.slug === "index" ? "../public/docs.md" : `../public/docs/${page.slug}.md`;
    await writeFile(
      new URL(target, import.meta.url),
      `# ${page.title}\n\n> ${page.description}\n\n${body}`,
    );
  }),
);

/**
 * `/llms.txt`, the index an agent reads before fetching anything. It mirrors
 * the sidebar, so the grouping a human sees and the grouping an agent sees
 * cannot drift apart.
 */
const llmsSection = (group: Group, depth = 2): string => {
  const heading = "#".repeat(depth);
  const lines = (group.pages ?? []).map((slug) => {
    const page = pages.get(slug);
    return `- [${page?.title ?? slug}](${base}${page?.url ?? ""}.md): ${page?.description ?? ""}`;
  });
  const nested = (group.groups ?? []).map((child) => llmsSection(child, depth + 1));
  return [`${heading} ${group.title}`, "", ...lines, "", ...nested].join("\n");
};

await writeFile(
  new URL("../public/llms.txt", import.meta.url),
  `# ${siteConfig.name}

> ${siteConfig.description}

Every page below is available as Markdown by appending \`.md\` to its URL.

${structure.map((group) => llmsSection(group)).join("\n")}`,
);

// The search index is derived data. Crawling it wastes budget. Markdown twins
// are not derived: they are the same content in a form an agent can read, so
// they stay crawlable.
await writeFile(
  new URL("../public/robots.txt", import.meta.url),
  `User-agent: *
Allow: /
Disallow: /api/
Host: ${base}
Sitemap: ${base}/sitemap.xml
`,
);

console.log(`Wrote the sidebar tree and metadata for ${pages.size} pages`);
