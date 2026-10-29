import { createFileRoute } from "@tanstack/react-router";

import { hubCategories, isPublished, productUrl } from "@/lib/comparisons";
import { compareHub } from "@/lib/compare-pages";
import { compareLoader } from "@/lib/mdx-loader";
import { pageHead } from "@/lib/seo";

/**
 * The comparison hub at `/compare`: the text of `content/docs/compare/index.mdx`
 * with its approach matrix, then each compared product by approach, as a
 * link to its own page.
 */
export const Route = createFileRoute("/compare/")({
  loader: async () => {
    // Load the MDX module before the component renders, for the reason the blog post route does.
    await compareLoader.preload(compareHub.path);
    return compareHub;
  },
  head: ({ loaderData }) => (loaderData ? pageHead(loaderData) : {}),
  component: CompareHub,
});

/** The compared products, one column for each approach, names only. */
function ProductIndex() {
  return (
    <section aria-labelledby="products" className="mt-16">
      <h2 id="products" className="text-ui-m font-semibold text-wh-fg">
        Products by approach
      </h2>
      <div className="wh-product-index mt-6">
        {hubCategories().map(({ category, products }) => (
          <div key={category.id}>
            <h3 className="text-ui-s font-medium text-wh-muted">{category.label}</h3>
            <ul>
              {products.map((product) => (
                <li key={product.slug}>
                  {isPublished(product) ? (
                    <a href={productUrl(product)} className="wh-product-link">
                      <span>{product.name}</span>
                      <span aria-hidden="true" className="wh-product-arrow">
                        →
                      </span>
                    </a>
                  ) : (
                    <span className="wh-product-link">{product.name}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function CompareHub() {
  const page = Route.useLoaderData();
  const Content = compareLoader.getComponent(page.path);

  return (
    <article className="wh-container pb-24 pt-12 sm:pt-16">
      <header className="max-w-3xl">
        <h1 className="text-ui-xl font-semibold text-wh-fg text-balance sm:text-ui-xxl">
          {page.title}
        </h1>
        <p className="mt-4 text-ui-m text-wh-muted text-pretty">{page.description}</p>
      </header>
      <div className="mt-10 wh-compare-hub">
        <Content />
      </div>
      <ProductIndex />
    </article>
  );
}
