# ADR 0116: Serve the comparison pages as site pages

- **Status:** Accepted
- **Date:** 2026-10-27
- **Amends:** [ADR 0104](0104-publish-sourced-product-comparisons-in-the-docs.md) (decision 3:
  the URLs of the comparison pages)

## Context

ADR 0104 put the comparison pages in the docs, at `/docs/compare` and `/docs/compare/<product>`.
Blume rendered them with the docs sidebar and the docs header. A reader who searches for one
product against another lands on a docs page, between the guides of a product that they do not
use yet. Each page showed one long table with a source link in every cell.

The maintainer asked for the comparison pages on the main site, for search engines, and for
simpler tables.

## Decision

1. **Site URLs.** The hub is at `/compare`, and each product page is at `/compare/<product>`. The
   TanStack Start app renders and prerenders them. Each page has its own title, description,
   canonical URL, and Open Graph tags. The sidebar of the docs has no "Compare" group, and the
   site header links the hub.
2. **The same sources.** The text stays in `site/content/docs/compare/`, and the facts stay in
   `site/comparisons.json`. The permitted places of ADR 0104 do not change. Blume excludes the
   folder, and a `compare` collection in `site/source.config.ts` reads it.
3. **Old URLs.** nginx answers each old URL with one permanent redirect to its new URL: the page,
   its Markdown twin, and its form with a trailing slash.
4. **Tables.** A status shows an icon and a word. A competitor cell shows a number that links its
   source in a numbered list at the end of the page. A row opens to show its notes. The hub
   compares approaches, not products: one matrix has a column for Workhorse and for each approach
   group of `site/comparisons.json`, and a row for each capability of the hub. Each group cell
   takes its status from the cells of the products in that group: Supported if every product
   supports the capability, Not supported if none supports it even in part, and Partial otherwise.
   The cell also shows the count of products for each status. A list of the products, grouped by
   approach, links each product page. The per-product rows are on each product page and in
   `/compare.md`.
5. **Agent files.** The Markdown twins move to `/compare.md` and `/compare/<product>.md`, with the
   same tables. `llms.txt` lists the pages in a "Compare" section, and `llms-full.txt` still leaves
   them out.

The other decisions of ADR 0104 do not change.

## Consequences

A comparison page has the header and footer of the landing page, and the docs sidebar is shorter.
A new comparison page is still one MDX file and one entry in `site/comparisons.json`. A link to an
old URL takes one redirect.
