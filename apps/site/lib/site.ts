export const siteConfig = {
  name: "Workhorse",
  tagline: "A PostgreSQL-native durable execution protocol",
  description:
    "Workhorse is a PostgreSQL-native durable job queue and execution protocol: transactional enqueue, fenced ownership, cooperative cancellation, database-owned deadlines, immutable attempt history, and audited dead-letter redrive.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://workhorse.run",
  github: "https://github.com/stablemates/workhorse",
  npm: "https://www.npmjs.com/package/@workhorse/core",
} as const;

/**
 * The hosted demo target. Deployments override this per environment; the
 * fallback keeps local builds and previews pointing at the public demo.
 */
export const demoUrl = process.env.NEXT_PUBLIC_WORKHORSE_DEMO_URL ?? "https://demo.workhorse.run";

export const navLinks = [
  { href: "/docs", label: "Docs" },
  { href: "/reference", label: "Reference" },
  { href: "/integrations", label: "Integrations" },
  { href: "/examples", label: "Examples" },
  { href: "/demo", label: "Demo" },
] as const;
