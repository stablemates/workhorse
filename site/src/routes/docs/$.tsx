import { createFileRoute, notFound } from "@tanstack/react-router";

import docsIndex from "@/.source/docs-index.json";
import { clientLoader } from "@/lib/mdx-loader";
import { siteConfig } from "@/lib/site";

interface PageRecord {
  readonly slug: string;
  readonly url: string;
  readonly path: string;
  readonly title: string;
  readonly description: string;
}

const pages = docsIndex.pages as Record<string, PageRecord>;

export const Route = createFileRoute("/docs/$")({
  loader: ({ params }) => {
    // oxlint-disable-next-line no-underscore-dangle -- TanStack Router names the splat parameter.
    const slug = params._splat?.replace(/^\/+|\/+$/g, "") || "index";
    const page = pages[slug];
    if (!page) throw notFound();

    return page;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};

    const canonical = `${siteConfig.url}${loaderData.url}`;

    return {
      meta: [
        { title: `${loaderData.title} — ${siteConfig.name}` },
        { name: "description", content: loaderData.description },
        { property: "og:type", content: "article" },
        { property: "og:url", content: canonical },
        { property: "og:title", content: loaderData.title },
        { property: "og:description", content: loaderData.description },
      ],
      links: [{ rel: "canonical", href: canonical }],
    };
  },
  component: Page,
});

function Page() {
  const { path } = Route.useLoaderData();
  const Content = clientLoader.getComponent(path);

  return <Content />;
}
