export const siteConfig = {
  name: "Workhorse",
  tagline: "A PostgreSQL-native durable execution protocol",
  description:
    "Workhorse is a PostgreSQL-native durable job queue and execution protocol: transactional enqueue, fenced ownership, cooperative cancellation, database-owned deadlines, immutable attempt history, and audited dead-letter redrive.",
  url: import.meta.env?.VITE_SITE_URL ?? "https://workhorse.run",
  github: "https://github.com/stablemates/workhorse",
  npm: "https://www.npmjs.com/package/@workhorse/core",
} as const;

/**
 * The hosted demo target. Deployments override this per environment; the
 * fallback keeps local builds and previews pointing at the public demo.
 */
export const demoUrl = import.meta.env?.VITE_WORKHORSE_DEMO_URL ?? "https://demo.workhorse.run";
