const siteUrl = (import.meta.env?.VITE_SITE_URL ?? "https://workhorse.run").replace(/\/$/, "");

export const siteConfig = {
  name: "Workhorse",
  tagline: "A PostgreSQL-native durable execution protocol",
  description:
    "Workhorse is a PostgreSQL-native durable job queue for TypeScript with transactional enqueue, crash-safe execution, durable waits, and no separate broker.",
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
