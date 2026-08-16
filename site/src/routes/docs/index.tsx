import { createFileRoute } from "@tanstack/react-router";

import docsIndex from "@/.source/docs-index.json";
import { clientLoader } from "@/lib/mdx-loader";
import { siteConfig } from "@/lib/site";

/**
 * `/docs` needs its own route. Without it the splat route answers the URL, and
 * every link the sidebar generates for `/docs` warns that it resolved to a
 * different route template than the one it was built from.
 */
const page = docsIndex.pages.index;

export const Route = createFileRoute("/docs/")({
  // Load the MDX before render so the layout is never torn down mid-navigation.
  // Return nothing: the loaded module is not serializable, and anything a loader
  // returns is serialized into the page payload.
  loader: async () => {
    await clientLoader.preload(page.path);
  },
  head: () => {
    const canonical = `${siteConfig.url}${page.url}`;

    return {
      meta: [
        { title: `${page.title} — ${siteConfig.name}` },
        { name: "description", content: page.description },
        { property: "og:type", content: "article" },
        { property: "og:url", content: canonical },
        { property: "og:title", content: page.title },
        { property: "og:description", content: page.description },
      ],
      links: [{ rel: "canonical", href: canonical }],
    };
  },
  component: DocsIndex,
});

function DocsIndex() {
  const Content = clientLoader.getComponent(page.path);

  return <Content />;
}
