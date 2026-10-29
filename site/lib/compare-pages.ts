import compareIndex from "@/.source/compare-index.json";

/**
 * The comparison pages as the routes see them (ADR 0116): the hub at
 * `/compare` and one page for each published product at `/compare/<product>`.
 *
 * `scripts/gen-docs-index.ts` writes `.source/compare-index.json` at build
 * time from `content/docs/compare/` and `comparisons.json`, for the reason
 * `lib/pages.ts` reads JSON: it keeps `node:fs` out of the browser bundle.
 */
export interface ComparePageRecord {
  /** The slug in `comparisons.json`. The hub has none. */
  readonly product?: string;
  readonly url: string;
  /** The MDX file, relative to `content/docs/compare/`. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
}

const records: readonly ComparePageRecord[] = compareIndex.pages;

function hubRecord(): ComparePageRecord {
  const hub = records.find((page) => page.product === undefined);
  if (!hub) throw new Error("site/.source/compare-index.json has no hub page");
  return hub;
}

/** The hub page. */
export const compareHub: ComparePageRecord = hubRecord();

/** The page of the product with the slug `product`, if it is published. */
export function comparePage(product: string): ComparePageRecord | undefined {
  return records.find((page) => page.product === product);
}
