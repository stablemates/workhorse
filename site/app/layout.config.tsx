import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { WorkhorseWordmark } from "@/components/logo";
import { hasPosts } from "@/lib/blog";
import { demoUrl, siteConfig } from "@/lib/site";

/**
 * The header carries the wordmark, the main documentation destinations, the
 * blog once it has a post, the GitHub link, and one external link to the
 * hosted demo. Sidebar groups own every deeper destination.
 */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: <WorkhorseWordmark />,
    transparentMode: "top",
  },
  githubUrl: siteConfig.github,
  links: [
    { text: "Docs", url: "/docs" },
    { text: "Quickstart", url: "/docs/quickstart" },
    { text: "Examples", url: "/docs/examples" },
    { text: "API", url: "/docs/api" },
    ...(hasPosts ? [{ text: "Blog", url: "/blog" }] : []),
    { text: "Demo", url: demoUrl, external: true },
  ],
};
