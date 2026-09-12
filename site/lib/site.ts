const siteUrl = (import.meta.env?.VITE_SITE_URL ?? "https://workhorse.run").replace(/\/$/, "");

export const siteConfig = {
  name: "Workhorse",
  tagline: "A durable task queue for PostgreSQL",
  description:
    "A durable task queue for PostgreSQL, with TypeScript, Python, and Go workers on one SQL protocol.",
  url: siteUrl,
  socialImage: `${siteUrl}/brand/workhorse-mark.png`,
  github: "https://github.com/stablemates/workhorse",
  npm: "https://www.npmjs.com/package/@stablemates/workhorse",
  pypi: "https://pypi.org/project/stablemates-workhorse/",
  goModule: "https://pkg.go.dev/github.com/stablemates/workhorse/go",
} as const;

/**
 * The publisher, as schema.org states it. Every page's JSON-LD names this node
 * by its `@id`, so an agent verifying who stands behind the site reads one
 * record rather than a copy per page.
 *
 * The contact point carries the published support address. There is no postal
 * address because the operator has chosen not to publish one, and the site
 * never invents a fact.
 */
export const organization = {
  "@type": "Organization",
  "@id": `${siteUrl}/#organization`,
  name: "Stablemates",
  url: siteUrl,
  logo: siteConfig.socialImage,
  sameAs: [siteConfig.github, siteConfig.npm, siteConfig.pypi, siteConfig.goModule],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "technical support",
    email: "support@workhorse.run",
    url: `${siteUrl}/contact`,
    availableLanguage: "en",
  },
} as const;

/** The reference a page's JSON-LD uses to name the publisher without repeating it. */
export const publisherReference = { "@id": organization["@id"] } as const;

/**
 * The hosted demo target. Deployments override this per environment; the
 * fallback keeps local builds and previews pointing at the public demo.
 */
export const demoUrl = import.meta.env?.VITE_WORKHORSE_DEMO_URL ?? "https://demo.workhorse.run";
