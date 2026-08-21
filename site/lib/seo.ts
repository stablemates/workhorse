import { siteConfig } from "./site";

interface DocumentationPageMetadata {
  readonly url: string;
  readonly title: string;
  readonly description: string;
}

export function documentationHead(page: DocumentationPageMetadata) {
  const canonical = `${siteConfig.url}${page.url}`;
  const title = `${page.title} — ${siteConfig.name}`;

  return {
    meta: [
      { title },
      { name: "description", content: page.description },
      { property: "og:type", content: "article" },
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
          "@type": "TechArticle",
          headline: page.title,
          description: page.description,
          url: canonical,
          image: siteConfig.socialImage,
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
