import { readFileSync } from "node:fs";

import { defineConfig } from "blume";
import { googleAnalytics } from "blume/analytics";

import { darkCodeTheme, lightCodeTheme } from "./code-themes.ts";

/**
 * The documentation pages at `/docs`, built by Blume.
 *
 * The pages stay in `site/content/docs`, the one owner of their text, and their
 * folder name gives every page its `/docs/<slug>` route. The comparison pages
 * under `docs/compare/` are excluded: the TanStack Start app renders them at
 * `/compare` (ADR 0116). The TanStack Start app
 * in `site/` builds the landing page, the blog, and the site pages, and
 * `site/scripts/gen-docs-index.ts` writes the agent files: the Markdown twins,
 * `llms.txt`, `llms-full.txt`, the sitemap, and `robots.txt`. Blume therefore
 * emits none of these, and `site/scripts/merge-docs.ts` copies only the pages
 * and their assets into the site output.
 *
 * `public` is a link to `site/public`, so a page reads the diagrams and the
 * brand files at the same URLs as the rest of the site.
 */

/** One item of `site/.source/blume-sidebar.json`: a page with its label, or a group. */
interface SidebarItem {
  label: string;
  root?: string;
  icon?: string;
  collapsed?: boolean;
  items?: SidebarItem[];
}

function isSidebarItem(value: unknown): value is SidebarItem {
  if (typeof value !== "object" || value === null || !("label" in value)) return false;
  if (typeof value.label !== "string") return false;
  if ("root" in value && typeof value.root !== "string") return false;
  if ("icon" in value && typeof value.icon !== "string") return false;
  if ("collapsed" in value && typeof value.collapsed !== "boolean") return false;
  if ("items" in value && !(Array.isArray(value.items) && value.items.every(isSidebarItem))) {
    return false;
  }
  return true;
}

/**
 * The sidebar comes from `content/docs/meta.json` and `site/integrations.json`.
 * `gen-docs-index.ts` resolves the two into Blume's sidebar items, so the
 * sidebar and `llms.txt` cannot list different groups.
 */
function readSidebar(): SidebarItem[] {
  const file = new URL("../.source/blume-sidebar.json", import.meta.url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      "site/.source/blume-sidebar.json is missing. Run `pnpm --filter @stablemates/workhorse-site docs:index` first.",
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isSidebarItem)) {
    throw new Error("site/.source/blume-sidebar.json is not a list of sidebar items");
  }
  return parsed;
}

const siteUrl = (process.env.VITE_SITE_URL ?? "https://workhorse.run").replace(/\/$/, "");

export default defineConfig({
  title: "Workhorse",
  description:
    "A durable task queue for PostgreSQL, with TypeScript, Python, Go, Rust, Ruby, Java, Kotlin, and C# workers on one SQL protocol.",
  content: {
    root: "../content",
    include: ["docs/**/*.mdx"],
    exclude: ["docs/compare/**"],
  },
  github: {
    owner: "stablemates",
    repo: "workhorse",
    dir: "site",
  },
  footer: {
    links: [
      { label: "Home", href: "/" },
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
  theme: {
    // Untitled: the primary action color is the strongest neutral, black in
    // light mode and white in dark mode. Amber marks only focus.
    accent: { light: "#000000", dark: "#ffffff" },
    background: { light: "#ffffff", dark: "#000000" },
    radius: "md",
    mode: "system",
    fonts: {
      // Timeless Grotesk is first in the stacks in `theme.css`. Its files are
      // licensed separately: put them in `site/blume/fonts/` and add them here
      // as `variants` to load them.
      display: {
        name: "Geist Variable",
        variants: [
          { src: "./node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2" },
        ],
      },
      body: {
        name: "Geist Variable",
        variants: [
          { src: "./node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2" },
        ],
      },
      mono: {
        name: "Geist Mono Variable",
        fallback: "mono",
        variants: [
          {
            src: "./node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
          },
        ],
      },
    },
  },
  navigation: {
    sidebar: {
      display: "group",
      items: readSidebar(),
    },
  },
  markdown: {
    code: {
      icons: false,
      theme: { light: lightCodeTheme, dark: darkCodeTheme },
    },
  },
  // `gen-docs-index.ts` owns every agent and crawler file, so Blume makes none.
  agents: {
    agentReadability: false,
    api: false,
    catalog: false,
    llmsTxt: false,
    skillMd: false,
  },
  seo: {
    og: { enabled: false },
    rss: { enabled: false },
    sitemap: false,
    robots: false,
  },
  // The same Google Analytics 4 tag that `RootDocument` in
  // `src/routes/__root.tsx` loads on every other page. The privacy notice
  // states that every HTML page loads it.
  analytics: [googleAnalytics({ id: "G-9NC8FKZPVB" })],
  feedback: false,
  deployment: {
    site: siteUrl,
  },
});
