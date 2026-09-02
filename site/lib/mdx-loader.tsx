import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";

import browserCollections from "@/.source/browser";
import { formatPostDate } from "@/lib/blog";
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
        <DocsTitle className="wh-docs-title">{title}</DocsTitle>
        <DocsDescription className="wh-docs-description">{description}</DocsDescription>
        <DocsBody className="wh-docs-body">
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

/**
 * Renders one blog post from the browser collection. The post's date is not in
 * the compiled frontmatter, because the default page schema keeps only the
 * title and description, so the route passes it in from the generated index.
 */
export const postLoader = browserCollections.blog.createClientLoader<{ readonly date: string }>({
  id: "blog",
  component: (loaded, { date }) => {
    const MDX = loaded.default;
    const { title, description } = loaded.frontmatter;

    return (
      <article className="mx-auto w-full max-w-3xl px-5 py-12 lg:px-8">
        <header>
          <time dateTime={date} className="wh-mono-label">
            {formatPostDate(date)}
          </time>
          <h1 className="wh-docs-title mt-3 text-3xl font-semibold sm:text-4xl">{title}</h1>
          <p className="wh-docs-description mt-4 text-lg text-fd-muted-foreground">{description}</p>
        </header>
        <div className="prose wh-docs-body">
          <MDX components={getMDXComponents()} />
        </div>
      </article>
    );
  },
});
