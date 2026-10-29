import { createFileRoute, notFound } from "@tanstack/react-router";

import { ComparisonSources } from "@/components/comparison";
import { checkedLine, comparisonProduct, productSources } from "@/lib/comparisons";
import { comparePage } from "@/lib/compare-pages";
import { compareLoader } from "@/lib/mdx-loader";
import { pageHead } from "@/lib/seo";
import { siteConfig } from "@/lib/site";

/**
 * One product page at `/compare/<product>` (ADR 0116). The route draws the
 * title, a line about each product, and the check date from
 * `comparisons.json`, then the text of `content/docs/compare/<product>.mdx`
 * with its matrix, then the numbered sources of the matrix.
 */
export const Route = createFileRoute("/compare/$slug")({
  loader: async ({ params }) => {
    const page = comparePage(params.slug);
    if (!page?.product) throw notFound();
    await compareLoader.preload(page.path);
    return { ...page, product: page.product };
  },
  head: ({ loaderData }) => (loaderData ? pageHead(loaderData) : {}),
  component: ProductComparison,
});

function ProductComparison() {
  const page = Route.useLoaderData();
  const product = comparisonProduct(page.product);
  const Content = compareLoader.getComponent(page.path);

  return (
    <article className="wh-container pb-20 pt-12 sm:pt-16">
      <div className="mx-auto max-w-3xl">
        <nav aria-label="Breadcrumb" className="wh-mono-label">
          <a href="/compare" className="hover:text-wh-fg">
            Compare
          </a>
          <span aria-hidden="true"> / </span>
          <span>{product.name}</span>
        </nav>
        <h1 className="mt-3 text-ui-xl font-semibold text-wh-fg text-balance sm:text-ui-xxl">
          {page.title}
        </h1>
        <p className="mt-4 text-ui-m text-wh-muted text-pretty">{page.description}</p>
        <dl className="wh-product-pair mt-8">
          <div>
            <dt>Workhorse</dt>
            <dd>{siteConfig.tagline}.</dd>
          </div>
          <div>
            <dt>
              {product.name} <span className="font-mono text-wh-muted">{product.version}</span>
            </dt>
            <dd>{product.summary}</dd>
          </div>
        </dl>
        <p className="mt-3 text-ui-xs text-wh-muted">
          {checkedLine(product)}{" "}
          <a href={product.repository} className="wh-link-underline" rel="noreferrer noopener">
            Repository
          </a>
        </p>
        <div className="mt-10">
          <Content />
        </div>
        <ComparisonSources sources={productSources(product)} />
      </div>
    </article>
  );
}
