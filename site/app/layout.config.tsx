import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { WorkhorseWordmark } from "@/components/logo";
import { demoUrl, siteConfig } from "@/lib/site";

/**
 * Shared navigation for every layout (home, docs, and standalone pages) so the
 * header never diverges between marketing and documentation routes.
 */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: <WorkhorseWordmark />,
    transparentMode: "top",
  },
  githubUrl: siteConfig.github,
  links: [
    { text: "Docs", url: "/docs", active: "nested-url" },
    { text: "Reference", url: "/reference", active: "nested-url" },
    { text: "Integrations", url: "/integrations", active: "nested-url" },
    { text: "Examples", url: "/examples", active: "nested-url" },
    { text: "Demo", url: "/demo", active: "nested-url" },
    {
      type: "icon",
      text: "Live demo",
      label: "Open the hosted demo",
      url: demoUrl,
      external: true,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden>
          <path
            d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
  ],
};
