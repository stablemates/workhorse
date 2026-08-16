import { createFileRoute, notFound } from "@tanstack/react-router";

import { clientLoader } from "@/lib/mdx-loader";
import { siteConfig } from "@/lib/site";
import { source } from "@/lib/source";

export const Route = createFileRoute("/docs/$")({
  // Everything returned here is serialized into the prerendered payload, so it
  // must stay plain data. The page body and its table of contents come from the
  // browser collection instead.
  loader: ({ params }) => {
    // oxlint-disable-next-line no-underscore-dangle -- TanStack Router names the splat parameter.
    const slugs = params._splat?.split("/").filter(Boolean) ?? [];
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    return {
      // `page.path` is the file path relative to the content directory, which
      // is the key the browser collection indexes by.
      path: page.path,
      url: page.url,
      title: page.data.title,
      description: page.data.description ?? siteConfig.description,
    };
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
