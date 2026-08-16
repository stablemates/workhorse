import { mkdir, readdir, writeFile } from "node:fs/promises";

import { siteConfig } from "../lib/site.js";

/**
 * Emits what Next.js used to generate from `app/sitemap.ts` and `app/robots.ts`,
 * plus the prerender list `vite.config.ts` reads.
 *
 * This walks `content/docs` rather than importing `lib/source.ts`. The loader
 * pulls in `.source/server.ts`, which only resolves inside Vite after the
 * fumadocs-mdx plugin has transformed it, and this script runs before Vite. The
 * URL rule is the same one `loader({ baseUrl: "/docs" })` applies, so the two
 * stay in step: `index.mdx` is `/docs`, everything else is `/docs/<name>`.
 */

const contentDir = new URL("../content/docs/", import.meta.url);
const base = siteConfig.url.replace(/\/$/, "");
const lastmod = new Date().toISOString();

const entries = await readdir(contentDir, { recursive: true, withFileTypes: true });
const slugs = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
  .map((entry) => entry.name.replace(/\.mdx$/, ""))
  .toSorted();

const routes = [
  "/docs",
  ...slugs.filter((slug) => slug !== "index").map((slug) => `/docs/${slug}`),
];

await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await mkdir(new URL("../.source/", import.meta.url), { recursive: true });

await writeFile(
  new URL("../.source/prerender.json", import.meta.url),
  `${JSON.stringify(["/", ...routes, "/api/search"], null, 2)}\n`,
);

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

// The search index is derived data. Crawling it wastes budget, and it is now a
// real file on disk rather than a dynamic route.
await writeFile(
  new URL("../public/robots.txt", import.meta.url),
  `User-agent: *
Allow: /
Disallow: /api/
Host: ${base}
Sitemap: ${base}/sitemap.xml
`,
);

console.log(`Wrote sitemap and prerender list for ${routes.length} pages`);
