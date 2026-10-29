/**
 * The header navigation of the whole site. The TanStack Start pages render it
 * in `components/site-header.tsx`, and the Blume documentation pages render it
 * in `blume/components/Header.astro`. Both read this list and share
 * `components/site-header.css`, so the two headers cannot show different items.
 */

import { demoUrl } from "./site";

/** Which header item a path belongs to. An external item never matches. */
type NavMatch =
  | { readonly kind: "exact"; readonly path: string }
  | { readonly kind: "prefix"; readonly path: string }
  | { readonly kind: "external" };

export interface SiteNavItem {
  readonly label: string;
  readonly href: string;
  readonly match: NavMatch;
}

/**
 * The header items, in order. Examples and the other docs sections are in the
 * docs sidebar and the footer, so the header keeps one item for each area of
 * the site. "Demo" opens the live demo dashboard in a new tab. The blog is linked only once it has a post (ADR 0052), so the caller
 * says whether it has one: the TanStack app reads `lib/blog.ts`, and Blume
 * reads the same generated index.
 */
export function siteNavItems({ hasPosts }: { readonly hasPosts: boolean }): readonly SiteNavItem[] {
  const blog: SiteNavItem = {
    label: "Blog",
    href: "/blog",
    match: { kind: "prefix", path: "/blog" },
  };
  return [
    { label: "Features", href: "/features", match: { kind: "exact", path: "/features" } },
    { label: "Docs", href: "/docs", match: { kind: "prefix", path: "/docs" } },
    { label: "API", href: "/docs/api", match: { kind: "exact", path: "/docs/api" } },
    { label: "Compare", href: "/compare", match: { kind: "prefix", path: "/compare" } },
    ...(hasPosts ? [blog] : []),
    { label: "Demo", href: demoUrl, match: { kind: "external" } },
  ];
}

function matches(match: NavMatch, path: string): boolean {
  switch (match.kind) {
    case "exact":
      return path === match.path;
    case "prefix":
      return path === match.path || path.startsWith(`${match.path}/`);
    case "external":
      return false;
    default: {
      const unhandled: never = match;
      return unhandled;
    }
  }
}

/**
 * The item the header marks as the current page. An exact item wins over a
 * prefix item, so `/docs/api` marks "API" and not "Docs".
 */
export function currentNavItem(
  items: readonly SiteNavItem[],
  path: string,
): SiteNavItem | undefined {
  const normalized = path.length > 1 ? path.replace(/\/$/, "") : path;
  return (
    items.find((item) => item.match.kind === "exact" && matches(item.match, normalized)) ??
    items.find((item) => matches(item.match, normalized))
  );
}

/**
 * The header icons as SVG markup, 24-unit Lucide outlines drawn with
 * `currentColor`. Blume draws its search icon from the same Lucide set, so
 * every icon in the two headers has the same stroke.
 */
const outline = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const headerIcons = {
  search: outline('<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>'),
  sun: outline(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  ),
  moon: outline(
    '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
  ),
  menu: outline('<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>'),
  external: outline('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'),
  github:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>',
} as const;
