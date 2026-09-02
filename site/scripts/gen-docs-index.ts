import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { type Integration, type IntegrationCategory, isPublished } from "../lib/integrations.js";
import { siteConfig } from "../lib/site.js";
import { mdxToMarkdown } from "./mdx-to-markdown.js";

/**
 * Builds everything the docs routes need without loading Fumadocs at runtime.
 *
 * The Fumadocs loader in `lib/source.ts` reads the filesystem, so importing it
 * from a route drags `node:fs` into the browser bundle and the page dies on the
 * first client-side navigation. This script runs at build time instead and
 * emits plain JSON: the sidebar tree, one metadata record per page, the
 * sitemap, the robots file, and the prerender list.
 *
 * `content/docs/meta.json` owns the sidebar order, except under
 * `---Integrations---`, which `integrations.json` owns. This script turns the
 * separators into collapsible folders with no URL of their own, so the page
 * files stay flat and every `/docs/<slug>` URL keeps working.
 */

interface Group {
  readonly title: string;
  /** Key in the icon map in `src/routes/docs.tsx`. */
  readonly icon: string;
  readonly defaultOpen?: boolean;
  readonly pages?: string[];
  readonly groups?: readonly Group[];
}

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
  "for-ai-agents": "For AI agents",
  api: "API",
};

interface PageRecord {
  readonly slug: string;
  readonly url: string;
  readonly path: string;
  readonly title: string;
  readonly description: string;
}

const contentDir = new URL("../content/docs/", import.meta.url);
const siteDir = new URL("../", import.meta.url);
const repositoryDir = new URL("../../", import.meta.url);

interface DocsMeta {
  readonly title: string;
  readonly pages: readonly string[];
}

const docsMeta = JSON.parse(await readFile(new URL("meta.json", contentDir), "utf8")) as DocsMeta;

/**
 * The integration catalog. `integrations.json` names the integrations and their
 * order; this script resolves the versions from `package.json` so no version
 * string is ever written by hand into the catalog or into a page.
 */
interface Catalog {
  readonly categories: readonly IntegrationCategory[];
  readonly integrations: readonly Integration[];
}

const catalog = JSON.parse(
  await readFile(new URL("integrations.json", siteDir), "utf8"),
) as Catalog;

const categoryIds = new Set(catalog.categories.map((category) => category.id));
for (const entry of catalog.integrations) {
  if (!categoryIds.has(entry.category)) {
    throw new Error(
      `The integration "${entry.slug}" names an unknown category "${entry.category}"`,
    );
  }
  if (!isPublished(entry) && !entry.issue) {
    throw new Error(`The planned integration "${entry.slug}" names no Issue that will write it`);
  }
  if (isPublished(entry) && entry.issue) {
    throw new Error(
      `The published integration "${entry.slug}" still names an Issue. ` +
        "An entry names one only while it is planned.",
    );
  }
}

/**
 * A planned entry reserves a slug for a page that does not exist yet, so the
 * page must not exist. Writing it without flipping the status would leave it
 * out of the sidebar and out of the index, which is a page that ships invisible.
 */
const publishedIntegrations = catalog.integrations.filter(isPublished);
await Promise.all(
  catalog.integrations
    .filter((entry) => !isPublished(entry))
    .map(async (entry) => {
      const exists = await readFile(new URL(`${entry.slug}.mdx`, contentDir), "utf8")
        .then(() => true)
        .catch(() => false);
      if (exists) {
        throw new Error(
          `The planned integration "${entry.slug}" already has a page. ` +
            'Set its status to "published" so the sidebar and the index list it.',
        );
      }
    }),
);

/**
 * Every workspace package, keyed by its published name. A catalog entry names
 * the package rather than its directory, so renaming a directory cannot
 * silently detach an integration from the versions it is tested against.
 */
interface PackageManifest {
  readonly name?: string;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const workspaceDir = new URL("typescript/", repositoryDir);
const workspaceEntries = await readdir(workspaceDir, { withFileTypes: true });
const manifests = new Map<string, PackageManifest>();
const manifestsByPath = new Map<string, PackageManifest>();
await Promise.all(
  workspaceEntries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const manifestUrl = new URL(`${entry.name}/package.json`, workspaceDir);
      const source = await readFile(manifestUrl, "utf8").catch(() => undefined);
      if (!source) return;
      const manifest = JSON.parse(source) as PackageManifest;
      manifestsByPath.set(`typescript/${entry.name}`, manifest);
      if (manifest.name) manifests.set(manifest.name, manifest);
    }),
);

/**
 * What a verified integration is proven against: the peer range its own package
 * declares, and the exact version the workspace package that tests it pins.
 */
interface ResolvedIntegration extends Integration {
  readonly supportedRange?: string;
  readonly testedVersion?: string;
}

const resolveIntegration = (entry: Integration): ResolvedIntegration => {
  // A planned page has been checked by nobody and tested against nothing, so
  // demanding either proof of it would only invite an invented one.
  if (!isPublished(entry)) return entry;
  if (entry.tier !== "verified") {
    if (!entry.verifiedOn) {
      throw new Error(`The documented integration "${entry.slug}" has no verifiedOn date`);
    }
    return entry;
  }

  if (entry.verifiedOn) {
    throw new Error(
      `The verified integration "${entry.slug}" carries a verifiedOn date. ` +
        "Continuous integration checks it on every change, so a fixed date understates it.",
    );
  }
  if (!entry.package || !entry.peer || !entry.pinnedBy) {
    throw new Error(
      `The verified integration "${entry.slug}" needs a package, a peer, and a pinnedBy`,
    );
  }

  const own = manifests.get(entry.package);
  if (!own) throw new Error(`The package "${entry.package}" is not in the TypeScript workspace`);
  const supportedRange = own.peerDependencies?.[entry.peer];
  if (!supportedRange) {
    throw new Error(`The package "${entry.package}" declares no peer range for "${entry.peer}"`);
  }

  const pinning = manifestsByPath.get(entry.pinnedBy);
  if (!pinning) throw new Error(`The integration "${entry.slug}" names an unknown pinnedBy path`);
  const testedVersion = pinning.devDependencies?.[entry.peer];
  if (!testedVersion) {
    throw new Error(`"${entry.pinnedBy}" pins no version of "${entry.peer}" to test against`);
  }

  return { ...entry, supportedRange, testedVersion };
};

const resolvedIntegrations = publishedIntegrations.map(resolveIntegration);

/**
 * Which catalog pages carry a brand mark. The tree records the slug and
 * `src/routes/docs.tsx` reads the mark's two theme variants back out of the
 * catalog, so an integration's logo is declared in one place with everything
 * else about it.
 */
const logos = new Set(
  publishedIntegrations.filter((entry) => entry.logo).map((entry) => entry.slug),
);

/**
 * Sidebar labels for catalog pages. A catalog entry's name is already the short
 * form of its page title — "Serverless and edge" against "Can I use Workhorse
 * from a serverless app?" — so it is the label, and an integration still needs
 * only its one entry.
 */
const catalogLabels: Readonly<Record<string, string>> = Object.fromEntries(
  publishedIntegrations.map((entry) => [entry.slug, entry.name]),
);
const groupIcons: Readonly<Record<string, string>> = {
  "Getting started": "rocket",
  "Producing work": "inbox",
  "Executing work": "play",
  Operating: "activity",
  Integrations: "plug",
  Reference: "code",
};

/**
 * The one sidebar group the catalog owns. `meta.json` may not list a page under
 * it, because adding an integration must stay one MDX file and one catalog
 * entry. The group stays flat and takes its order from the catalog: category
 * order decides which pages sit together, and the index page presents the
 * categories under their headings, where a reader browsing a catalog reads them.
 */
const catalogGroup = "Integrations";
const catalogPages = [
  "integrations",
  ...catalog.categories.flatMap((category) =>
    publishedIntegrations
      .filter((entry) => entry.category === category.id)
      .map((entry) => entry.slug),
  ),
];

const structure: Group[] = [];
for (const entry of docsMeta.pages) {
  const separator = /^---(.+)---$/.exec(entry);
  if (separator?.[1]) {
    const icon = groupIcons[separator[1]];
    if (!icon) throw new Error(`The sidebar group "${separator[1]}" has no icon`);
    structure.push({
      title: separator[1],
      icon,
      defaultOpen: structure.length === 0,
      pages: separator[1] === catalogGroup ? [...catalogPages] : [],
    });
    continue;
  }

  const group = structure.at(-1);
  if (!group?.pages) throw new Error(`The sidebar page "${entry}" appears before its group`);
  if (group.title === catalogGroup) {
    throw new Error(
      `meta.json lists "${entry}" under ${catalogGroup}, which site/integrations.json owns. ` +
        "Add the page to the catalog instead.",
    );
  }
  group.pages.push(entry);
}

if (!structure.some((group) => group.title === catalogGroup)) {
  throw new Error(`meta.json has no ---${catalogGroup}--- separator for the catalog to fill`);
}

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

/**
 * The catalog as Markdown, for the twin and for `llms-full.txt`.
 *
 * `<IntegrationCatalog />` renders the catalog in HTML. An agent reads the
 * twin, so leaving the tag in it would hand the one page whose whole content is
 * the catalog to an agent with the catalog removed.
 */
const catalogMarkdown = catalog.categories
  .map((category) => {
    const members = resolvedIntegrations.filter((entry) => entry.category === category.id);
    const rows = members.map((entry) => {
      const proof =
        entry.tier === "verified"
          ? `Tested against ${entry.peer} ${entry.testedVersion} on every change, supports ${entry.supportedRange}.`
          : `Checked by hand on ${entry.verifiedOn}.`;
      const shipped = entry.package ? ` Ships as \`${entry.package}\`.` : "";
      return `- [${entry.name}](${siteConfig.url}/docs/${entry.slug}.md) — ${entry.tier}. ${entry.summary} ${entry.boundary}${shipped} ${proof}`;
    });
    return [`### ${category.title}`, "", category.question, "", ...rows].join("\n");
  })
  .join("\n\n");

const pages = new Map<string, PageRecord>();
/**
 * One Markdown document per page: the `# title` and `> description` lead
 * followed by the expanded body. The standalone twin adds frontmatter to this
 * string and `llms-full.txt` embeds it as it stands, so the two stop being
 * identical while the body they share is built once.
 */
const markdownDocuments = new Map<string, string>();
await Promise.all(
  slugs.map(async (slug) => {
    const source = await readFile(new URL(`${slug}.mdx`, contentDir), "utf8");
    const title = frontmatterValue(source, "title") ?? slug;
    const description = frontmatterValue(source, "description");
    if (!description) {
      throw new Error(`The docs page "${slug}" is missing a frontmatter description`);
    }

    // The catalog tag becomes Markdown before the tab transform runs, so the
    // transform never meets a component the sidebar generator owns.
    const body = source
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
      .trimStart()
      .replace(/^<IntegrationCatalog \/>$/m, () => catalogMarkdown);
    if (body.includes("<IntegrationCatalog")) {
      throw new Error(`The Markdown twin for "${slug}" still contains the catalog tag`);
    }
    markdownDocuments.set(slug, `# ${title}\n\n> ${description}\n\n${mdxToMarkdown(body, slug)}`);
    pages.set(slug, {
      slug,
      url: slug === "index" ? "/docs" : `/docs/${slug}`,
      path: `${slug}.mdx`,
      title,
      description,
    });
  }),
);

const placed = new Set<string>();

const pageNode = (slug: string) => {
  const page = pages.get(slug);
  if (!page) throw new Error(`The sidebar lists "${slug}", which has no file in content/docs`);
  if (placed.has(slug)) throw new Error(`The sidebar lists "${slug}" more than once`);
  placed.add(slug);
  return {
    type: "page" as const,
    name: catalogLabels[slug] ?? sidebarLabels[slug] ?? page.title,
    url: page.url,
    ...(logos.has(slug) ? { icon: slug } : {}),
  };
};

const folderNode = (group: Group): unknown => ({
  type: "folder" as const,
  name: group.title,
  icon: group.icon,
  defaultOpen: group.defaultOpen ?? false,
  children: [...(group.pages ?? []).map(pageNode), ...(group.groups ?? []).map(folderNode)],
});

const tree = {
  name: docsMeta.title,
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

/**
 * The catalog the index page renders, with every version resolved from a
 * `package.json`. Emitting it here keeps `node:fs` out of the browser bundle
 * for the same reason the sidebar tree is emitted rather than loaded.
 */
await writeFile(
  new URL("integrations.json", outDir),
  `${JSON.stringify(
    { categories: catalog.categories, integrations: resolvedIntegrations },
    null,
    2,
  )}\n`,
);

const routes = [
  "/",
  "/docs",
  ...[...pages.values()]
    .map((page) => page.url)
    .filter((url) => url !== "/docs")
    .toSorted(),
];

await writeFile(
  new URL("prerender.json", outDir),
  `${JSON.stringify([...routes, "/api/search"], null, 2)}\n`,
);

const base = siteConfig.url;

await writeFile(
  new URL("../public/sitemap.xml", import.meta.url),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (route) =>
      `  <url><loc>${base}${route}</loc><changefreq>weekly</changefreq><priority>${
        route === "/" ? 1 : route === "/docs" ? 0.9 : 0.7
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
 * files hand it the source instead. The title becomes an H1, every language tab
 * is expanded inline, and the code survives exactly.
 *
 * The twin restates its title and description as frontmatter and names the HTML
 * page it stands for, so an agent that keeps the file can still say where it
 * came from. A client that does not parse YAML loses nothing, because the
 * `# title` and `> description` lead repeats both. There is no version key: the
 * runtime compatibility check answers that question.
 */
await mkdir(new URL("../public/docs/", import.meta.url), { recursive: true });
await Promise.all(
  [...pages.values()].map(async (page) => {
    const document = markdownDocuments.get(page.slug);
    if (!document) throw new Error(`The docs page "${page.slug}" has no Markdown twin`);
    const frontmatter = [
      "---",
      `title: ${JSON.stringify(page.title)}`,
      `description: ${JSON.stringify(page.description)}`,
      `canonical: ${JSON.stringify(`${base}${page.url}`)}`,
      "---",
      "",
    ].join("\n");
    // `index` is served at `/docs`, so its twin is `/docs.md`, not
    // `/docs/index.md`. Every other page keeps its slug.
    const target = page.slug === "index" ? "../public/docs.md" : `../public/docs/${page.slug}.md`;
    await writeFile(new URL(target, import.meta.url), `${frontmatter}\n${document}`);
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
For the complete documentation in one file, read [llms-full.txt](${base}/llms-full.txt).

${structure.map((group) => llmsSection(group)).join("\n")}
## Optional

- [Repository](${siteConfig.github})
- [npm](${siteConfig.npm})
`,
);

/**
 * `/llms-full.txt`, every page in sidebar order. The separator and canonical
 * URL identify each page, and the document that follows is the same body the
 * standalone twin carries, without the twin's frontmatter.
 */
const llmsFullSection = (group: Group, depth = 2): string => {
  const heading = "#".repeat(depth);
  const documents = (group.pages ?? []).map((slug) => {
    const page = pages.get(slug);
    const document = markdownDocuments.get(slug);
    if (!page || !document) throw new Error(`The sidebar page "${slug}" has no Markdown twin`);
    return `---\n\nCanonical source: ${base}${page.url}\n\n${document}`;
  });
  const nested = (group.groups ?? []).map((child) => llmsFullSection(child, depth + 1));
  return [`${heading} ${group.title}`, "", ...documents, "", ...nested].join("\n");
};

await writeFile(
  new URL("../public/llms-full.txt", import.meta.url),
  `# ${siteConfig.name}

> ${siteConfig.description}

For the concise documentation index, read [llms.txt](${base}/llms.txt).

${structure.map((group) => llmsFullSection(group)).join("\n")}`,
);

// The search index is derived data. Crawling it wastes budget. Markdown twins
// are not derived: they are the same content in a form an agent can read, so
// they stay crawlable.
//
// A crawler that reads this file may be an agent rather than a search engine,
// and `robots.txt` is the one file it is guaranteed to fetch. The comment names
// the documentation router so that agent can stop crawling and read instead.
await writeFile(
  new URL("../public/robots.txt", import.meta.url),
  `# Documentation for AI agents: ${base}/llms.txt
# Every page in one file: ${base}/llms-full.txt

User-agent: *
Allow: /
Disallow: /api/
Host: ${base}
Sitemap: ${base}/sitemap.xml
`,
);

console.log(`Wrote the sidebar tree and metadata for ${pages.size} pages`);
