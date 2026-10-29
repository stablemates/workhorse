import type { HomeLayoutProps } from "fumadocs-ui/layouts/home";
import { SiteHeader } from "@/components/site-header";

/**
 * Every TanStack Start page uses the site header in `components/site-header.tsx`
 * in place of the Fumadocs header. The documentation pages render the same
 * header from `blume/components/Header.astro`, so a reader who moves between
 * the two sees one header. `lib/site-nav.ts` lists its items.
 */
export const baseOptions: HomeLayoutProps = {
  slots: { header: SiteHeader },
};
