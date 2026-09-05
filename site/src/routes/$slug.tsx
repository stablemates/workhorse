import { createFileRoute, notFound } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";

import { baseOptions } from "@/app/layout.config";
import { SiteFooter } from "@/components/site-footer";
import { pageLoader } from "@/lib/mdx-loader";
import { sitePages } from "@/lib/pages";
import { pageHead } from "@/lib/seo";

/**
 * A site page at `/<slug>` (ADR 0062): the trust pages `/about`, `/contact`,
 * and `/privacy`. The static routes (`/docs`, `/blog`, `/not-found`) outrank
 * this dynamic one, so it sees only the slugs nothing else owns, and a slug
 * with no page in the collection is not found.
 *
 * A page shares the landing page's header and footer rather than the docs
 * sidebar, for the reason a post does: it is read top to bottom, and the docs
 * tree is not its table of contents.
 */
export const Route = createFileRoute("/$slug")({
  loader: async ({ params }) => {
    const page = sitePages.find((candidate) => candidate.slug === params.slug);
    if (!page) throw notFound();

    // Load the MDX module before the component renders, so the shell is not
    // torn down while the page suspends. Same reason as the docs splat route.
    await pageLoader.preload(page.path);

    return page;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    return pageHead(loaderData);
  },
  component: SitePage,
});

function SitePage() {
  const { path } = Route.useLoaderData();
  const Content = pageLoader.getComponent(path);

  return (
    <div className="wh-page-scale flex flex-1 flex-col">
      <HomeLayout {...baseOptions} className="flex-1">
        <Content />
        <SiteFooter />
      </HomeLayout>
    </div>
  );
}
