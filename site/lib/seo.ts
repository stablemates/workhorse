import { publisherReference, siteConfig } from "./site";

interface PageMetadata {
  readonly url: string;
  readonly title: string;
  readonly description: string;
}

interface ArticleOptions {
  /** The schema.org type of the JSON-LD record. */
  readonly schemaType: "TechArticle" | "BlogPosting";
  /** ISO calendar date, for a post's `article:published_time` and `datePublished`. */
  readonly published?: string;
}

/**
 * The head of one article page: canonical link, description, Open Graph tags
 * with `og:type` `article`, the `text/markdown` alternate that names the
 * page's twin, and a JSON-LD record. Documentation pages and blog posts share
 * it and differ only in the schema.org type and whether they carry a date.
 */
function articleHead(page: PageMetadata, options: ArticleOptions) {
  const canonical = `${siteConfig.url}${page.url}`;
  const title = `${page.title} — ${siteConfig.name}`;
  const published = options.published ? `${options.published}T00:00:00Z` : undefined;

  return {
    meta: [
      { title },
      { name: "description", content: page.description },
      { property: "og:type", content: "article" },
      { property: "og:url", content: canonical },
      { property: "og:title", content: page.title },
      { property: "og:description", content: page.description },
      ...(published ? [{ property: "article:published_time", content: published }] : []),
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: page.description },
    ],
    links: [
      { rel: "canonical", href: canonical },
      { rel: "alternate", type: "text/markdown", href: `${canonical}.md` },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": options.schemaType,
          headline: page.title,
          description: page.description,
          url: canonical,
          image: siteConfig.socialImage,
          ...(published ? { datePublished: published } : {}),
          publisher: publisherReference,
          isPartOf: {
            "@type": "WebSite",
            name: siteConfig.name,
            url: siteConfig.url,
          },
        }),
      },
    ],
  };
}

export function documentationHead(page: PageMetadata) {
  return articleHead(page, { schemaType: "TechArticle" });
}

export function postHead(post: PageMetadata & { readonly date: string }) {
  return articleHead(post, { schemaType: "BlogPosting", published: post.date });
}

/** The head of `/blog`: its canonical link, description, and the feed. */
export function blogIndexHead() {
  const canonical = `${siteConfig.url}/blog`;
  const title = `Blog — ${siteConfig.name}`;
  const description = `Long-form writing about ${siteConfig.name}, ${siteConfig.description.replace(/^A /, "a ").replace(/\.$/, "")}.`;

  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:url", content: canonical },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ],
    links: [
      { rel: "canonical", href: canonical },
      { rel: "alternate", type: "application/rss+xml", href: `${canonical}/feed.xml` },
    ],
  };
}

/**
 * The head of one site page (ADR 0062): canonical link, description, Open
 * Graph tags, the `text/markdown` alternate that names the page's twin, and a
 * `WebPage` JSON-LD record that names the publisher. The trust pages are what
 * an agent reads to decide whether a publisher is real, so the record points at
 * the one `Organization` node the root emits rather than restating it.
 */
export function pageHead(page: PageMetadata) {
  const canonical = `${siteConfig.url}${page.url}`;
  const title = `${page.title} — ${siteConfig.name}`;

  return {
    meta: [
      { title },
      { name: "description", content: page.description },
      { property: "og:url", content: canonical },
      { property: "og:title", content: page.title },
      { property: "og:description", content: page.description },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: page.description },
    ],
    links: [
      { rel: "canonical", href: canonical },
      { rel: "alternate", type: "text/markdown", href: `${canonical}.md` },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: page.title,
          description: page.description,
          url: canonical,
          publisher: publisherReference,
          isPartOf: {
            "@type": "WebSite",
            name: siteConfig.name,
            url: siteConfig.url,
          },
        }),
      },
    ],
  };
}
