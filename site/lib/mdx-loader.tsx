import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";

import browserCollections from "@/.source/browser";
import { getMDXComponents } from "@/mdx-components";

/**
 * Renders one doc from the browser collection, which imports each MDX module
 * lazily. `lib/source.ts` stays build-only: it imports every MDX file eagerly,
 * which belongs in the prerender graph and not in the client bundle.
 *
 * The whole page renders here, not just the body, because the table of contents
 * carries React nodes. Route loader data crosses a serialization boundary and
 * React nodes do not survive it, so the table of contents has to come from the
 * loaded module instead.
 *
 * The loader id is required. TanStack Start can split this module into several
 * chunks, and the id shares one cache between them.
 */
export const clientLoader = browserCollections.docs.createClientLoader<Record<string, never>>({
  id: "docs",
  component: (loaded) => {
    const MDX = loaded.default;
    const { title, description, full } = loaded.frontmatter;

    return (
      <DocsPage
        toc={loaded.toc}
        full={full ?? false}
        tableOfContent={{ style: "clerk", single: false }}
      >
        <DocsTitle>{title}</DocsTitle>
        <DocsDescription>{description}</DocsDescription>
        <DocsBody>
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});
