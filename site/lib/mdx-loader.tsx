import browserCollections from "@/.source/browser";
import { ComparisonTable } from "@/components/comparison";
import { formatPostDate } from "@/lib/blog";
import { getMDXComponents } from "@/mdx-components";

/**
 * Each loader below renders one entry of a browser collection, which imports
 * each MDX module lazily. `lib/source.ts` stays build-only: it imports every
 * MDX file eagerly, which belongs in the prerender graph and not in the client
 * bundle. The documentation pages are not here: Blume builds them from
 * `site/blume`.
 *
 * The loader id is required. TanStack Start can split this module into several
 * chunks, and the id shares one cache between them.
 */

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
          <h1 className="wh-docs-title mt-3 text-ui-xl font-semibold sm:text-ui-xxl">{title}</h1>
          <p className="wh-docs-description mt-4 text-ui-m text-wh-muted">{description}</p>
        </header>
        <div className="prose wh-docs-body">
          <MDX components={getMDXComponents()} />
        </div>
      </article>
    );
  },
});

/**
 * Renders one site page (ADR 0062) from the browser collection, in the post's
 * article shell without the date line. The title and description come from the
 * compiled frontmatter, which is all a page carries.
 */
export const pageLoader = browserCollections.pages.createClientLoader<Record<string, never>>({
  id: "pages",
  component: (loaded) => {
    const MDX = loaded.default;
    const { title, description } = loaded.frontmatter;

    return (
      <article className="mx-auto w-full max-w-3xl px-5 py-12 lg:px-8">
        <header>
          <h1 className="wh-docs-title text-ui-xl font-semibold sm:text-ui-xxl">{title}</h1>
          <p className="wh-docs-description mt-4 text-ui-m text-wh-muted">{description}</p>
        </header>
        <div className="prose wh-docs-body">
          <MDX components={getMDXComponents()} />
        </div>
      </article>
    );
  },
});

/**
 * Renders the body of one comparison page (ADR 0116). The route draws the
 * title, the two products, and the sources around it, because they come from
 * `comparisons.json` and not from the MDX file. `<ComparisonTable />` is the
 * one component a comparison page uses.
 */
export const compareLoader = browserCollections.compare.createClientLoader<Record<string, never>>({
  id: "compare",
  component: (loaded) => {
    const MDX = loaded.default;
    return (
      <div className="prose wh-docs-body wh-compare-body">
        <MDX components={getMDXComponents({ ComparisonTable })} />
      </div>
    );
  },
});
