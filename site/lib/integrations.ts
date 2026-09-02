import catalog from "../integrations.json" with { type: "json" };

/**
 * The integration catalog: the single source for which integrations exist,
 * what tier each one sits in, and the order they appear in.
 *
 * Three surfaces read it — the docs sidebar, the `/docs/integrations` index,
 * and the landing page — so adding an integration is one MDX file and one entry
 * here. The generator in `scripts/gen-docs-index.ts` resolves the version each
 * verified entry is tested against from `package.json`, which is why no version
 * string appears in this file.
 */

/** A verified integration ships a package this repository tests on every change. */
type IntegrationTier = "verified" | "documented";

/**
 * Whether the page behind an entry exists yet.
 *
 * A planned entry reserves a slug and appears nowhere a reader can see it: not
 * the sidebar, not the index, not the landing page. It exists so an Issue that
 * will write the page can be staged in the catalog first, and so the generator
 * can catch the trap that staging creates — a page written without its status
 * flipped, which would otherwise ship invisible.
 */
type IntegrationStatus = "published" | "planned";

export interface IntegrationCategory {
  readonly id: string;
  readonly title: string;
  /** The question a reader is asking when they open this category. */
  readonly question: string;
}

/**
 * A brand mark per theme, naming files in `public/brand/integrations` without
 * their extension. Most marks are drawn for one background: Drizzle's is
 * near-black ink and vanishes on a dark page. A tool that publishes a single
 * full-colour mark names it in both slots.
 */
export interface IntegrationLogo {
  readonly light: string;
  readonly dark: string;
}

export interface Integration {
  /** The page under `content/docs`, and therefore the `/docs/<slug>` URL. */
  readonly slug: string;
  /** Absent means published, so an entry states its status only while staged. */
  readonly status?: IntegrationStatus;
  /** The Issue that will write a planned entry's page. Planned entries only. */
  readonly issue?: string;
  readonly name: string;
  readonly category: string;
  readonly tier: IntegrationTier;
  /** What it is, in one line. The landing page prints this verbatim. */
  readonly summary: string;
  /** Where the integration stops, so a reader can tell what it does not do. */
  readonly boundary: string;
  /** The published package. Verified entries have one; documented entries do not. */
  readonly package?: string;
  /** The third-party package the integration adapts. Verified entries only. */
  readonly peer?: string;
  /** The workspace package whose dev dependency pins the tested version. */
  readonly pinnedBy?: string;
  readonly logo?: IntegrationLogo;
  /** The landing-page code tab, keyed into `landing-snippets.ts`. */
  readonly landingSnippet?: string;
  /**
   * When a person last checked the page against the platform it documents.
   *
   * Documented entries carry it because nothing re-checks them. Verified
   * entries must not: continuous integration checks them on every change, and a
   * fixed date beside a continuously proven claim reads as the weaker one.
   */
  readonly verifiedOn?: string;
}

export const integrations = catalog.integrations as readonly Integration[];

/** A planned entry has no page, so every reader-facing surface skips it. */
export const isPublished = (entry: Integration): boolean => entry.status !== "planned";
