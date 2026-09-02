const siteUrl = (import.meta.env?.VITE_SITE_URL ?? "https://workhorse.run").replace(/\/$/, "");

export const siteConfig = {
  name: "Workhorse",
  tagline: "A durable job queue for PostgreSQL",
  description:
    "A durable job queue for PostgreSQL, with TypeScript, Python, and Go workers on one SQL protocol.",
  url: siteUrl,
  socialImage: `${siteUrl}/brand/workhorse-mark.png`,
  github: "https://github.com/stablemates/workhorse",
  npm: "https://www.npmjs.com/package/@stablemates/workhorse",
} as const;

/**
 * The hosted demo target. Deployments override this per environment; the
 * fallback keeps local builds and previews pointing at the public demo.
 */
export const demoUrl = import.meta.env?.VITE_WORKHORSE_DEMO_URL ?? "https://demo.workhorse.run";
