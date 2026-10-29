# @stablemates/workhorse-site

The documentation site: a TanStack Start app serving the landing page at `/`
and long-form posts under `/blog`, and the product documentation under `/docs`,
which Blume builds from `blume/`. Content rules for the documentation itself
live in the repository root `CLAUDE.md`; this file records conventions of the
site's own UI and of the blog.

## The documentation pages: Blume

The pages stay in `content/docs/`. `blume/` is a Blume project that reads them
from there, and its folder name gives every page its `/docs/<slug>` URL. The
site build runs both builds and `scripts/merge-docs.ts` copies the Blume pages
into the one output that nginx serves.

- `blume/` is not a pnpm workspace package. Blume's dependencies changed how
  the workspace lockfile resolved the peers of other packages, so the project
  has its own `pnpm-lock.yaml`. The site build installs it with
  `pnpm --dir blume install --ignore-workspace --frozen-lockfile`.
- `scripts/gen-docs-index.ts` writes the sidebar (`.source/blume-sidebar.json`)
  from `content/docs/meta.json` and `integrations.json`.
  It also keeps every agent file: the Markdown twins, `llms.txt`, the sitemap,
  and `robots.txt`. Blume emits none of these.
- `blume/components.ts` maps the page components to Blume: `<Tab value>` to
  Blume's `<Tab title>`, and `Diagram`, `IntegrationCatalog`, and
  `ReleaseTable` to the files in `blume/components/`.
- The docs and the other pages share one header. `components/site-header.tsx`
  renders it for the TanStack Start pages and `blume/components/Header.astro`
  for the docs. Both read the items from `lib/site-nav.ts` and the styles from
  `components/site-header.css`, so change the two files together.
- `blume/theme.css` holds the Untitled theme, and `blume/code-themes.ts` the
  code colours. `blume/public` links to `public/`.
- Run `pnpm docs:dev` to work on the documentation pages. It starts the
  Blume development server, which serves them at `/docs`.
- Run `pnpm site:dev` to work on the landing page, the blog, and the other
  pages. Its `vite dev` server does not serve `/docs`, so a link to the
  documentation there opens an empty page.
- Run `pnpm docs:build` to build the whole site, and `pnpm docs:start` to
  serve the build with the documentation pages.

## Wide-viewport density: viewport-gated zoom

The site was reviewed on a wide monitor and judged best at the density of
roughly 150% browser zoom. Rather than inflate every font size — which would
cramp laptop layouts that already fill their width — the landing page
reproduces that verdict with CSS `zoom` rules, gated by
viewport width, on the `.wh-page-scale` wrapper in `src/styles/global.css`:

| Viewport width | zoom |
| -------------- | ---- |
| below 1680px   | 1    |
| 1680px and up  | 1.25 |
| 2048px and up  | 1.5  |

Points that keep this safe, and that any change must preserve:

- `zoom` scales layout, type, and spacing together, unlike
  `transform: scale`, which scales pixels after layout.
- Media queries evaluate against the real viewport, not the zoomed one. Each
  threshold is chosen so the scaled container still fits: the landing
  container is 80rem (1280px), so 1.25 needs ≥ 1600px plus margin and 1.5
  needs ≥ 1920px plus margin. If the container width or the thresholds
  change, re-derive the other, or breakpoint styles will disagree with the
  zoomed layout.
- Each route wraps its whole layout — header and sidebar included — so
  proportions match browser zoom exactly. Portalled UI (the search dialog)
  renders outside the wrappers and stays 1:1 on purpose.
- The landing wrapper is in `src/routes/index.tsx`. The Blume documentation
  pages have no zoom wrapper.
- Firefox supports `zoom` from version 126; older browsers simply render the
  unscaled layout.

## Laptop checks

Review the landing at CSS viewport sizes of 1280×800, 1440×900, and 1512×982, then
check 390×844 for mobile. These represent browser layout space, not Retina panel pixels.
Check each size in light and dark.

## The integration catalog

`integrations.json` is the one place an integration is declared. Three surfaces
read it — the docs sidebar, the `/docs/integrations` index, and the landing
page's package list and ORM tabs — so adding an integration is one MDX file
under `content/docs` and one entry in the catalog, and nothing can list a
different set than the others.

- `content/docs/meta.json` keeps the `---Integrations---` separator but may not
  list a page under it. `scripts/gen-docs-index.ts` fills that group from the
  catalog and throws if the separator has pages of its own.
- No version string belongs in the catalog. A verified entry names the package
  it adapts (`peer`) and the workspace package that pins the tested version
  (`pinnedBy`), and the generator reads both ranges out of the `package.json`
  files that already declare them.
- The tier decides what a page proves. `verified` means continuous integration
  exercises the package on every change, so the entry carries no date.
  `documented` means a person checked it, so the entry must carry `verifiedOn`.
- Each category in the catalog becomes a nested sidebar folder under
  Integrations, in category order. Put an entry in the category that answers
  the reader's question: an ORM page under `orms`, a complete example such as a
  webhook handler under `recipes`. The overview names each category by its
  title, so update that list when you rename or add a category.
- `typescript/core/test/site-integrations-catalog.test.ts` enforces all of it.

### Integration page template

Integration pages follow the writing rules in the root `CLAUDE.md` and the
ASD-STE100 writing rules, with technical terms allowed: short sentences, active
voice, one instruction per step, and the condition first.

- Title: the tool name first, then what the reader gets, for example
  `"Prisma: enqueue background tasks in the same transaction"`. Quote a title
  that contains a colon.
- Description: one sentence that names the tool and Workhorse and says what the
  page lets the reader do.
- Sections, in this order: an introduction that says what the reader gets and
  why, `## Requirements`, the setup steps, the main example, `## Run the worker`
  when the page owns one, `## Limits`, `## How this integration is tested` (or
  `recipe`), and `## Next`.
- State limits as a short list after the reader can use the integration. Do not
  open a page with what it does not do.
- Put test evidence last. Name the tier, the test command, and what the tests
  cover. Leave exact tested versions to the catalog when it resolves them.

## The comparison pages

`comparisons.json` holds every fact of the comparison pages (ADR 0104). They
are site pages, not docs pages (ADR 0116): the TanStack Start app renders the
hub at `/compare` and each product page at `/compare/<slug>` from the MDX files
in `content/docs/compare/`. Blume excludes that folder, and nginx redirects each
old `/docs/compare` URL to its new URL. To add a product page, do these steps:

1. In the product entry, set `page` to `"published"`.
2. Remove `issue` from the entry.
3. Add a cell for every core row. A page can add up to three rows of its own in
   `rows`.
4. Write `content/docs/compare/<slug>.mdx` with
   `<ComparisonTable product="<slug>" />`.

The hub, the prerender list, the sitemap, and `llms.txt` read the data file, so
a new page needs no other change.

- `components/comparison.tsx` renders the matrices and the numbered sources at
  the end of each page. The route draws the title and the line about each
  product from the data file.
- Each competitor cell has a value, a source URL at a release tag, the product
  version, and evidence from the source. Each Workhorse status names the row of
  `docs/features.md` or `docs/parity.md` that it restates.
- `scripts/comparisons.test.ts` checks the data and the page sections.
  `../scripts/comparison-names.test.ts` fails on a product name outside the
  permitted paths.

## The blog

`content/blog/` is the home for long-form content (ADR 0052). A post is one
MDX file, `content/blog/<slug>.mdx`, served at `/blog/<slug>` with that URL
as its canonical. The slug is lowercase letters, digits, and single hyphens.
The frontmatter is exactly these three keys:

```yaml
---
title: The post title
description: One sentence a reader sees on the index, in the feed, and in search results.
date: 2026-09-07
---
```

- `date` is an ISO calendar date, `YYYY-MM-DD`. It orders the index and the
  feed, newest first, and prints on the page. There is no author field.
- `scripts/gen-docs-index.ts` reads the collection at build time through
  `scripts/blog-posts.ts` and fails the build on a missing or malformed field.
  It adds `/blog` and every post to the prerender list and `sitemap.xml`,
  writes a Markdown twin per post at `/blog/<slug>.md`, and writes the RSS
  feed at `/blog/feed.xml`. `llms.txt` and `llms-full.txt` never list a post.
- With zero posts the "Blog" link is absent from the header and the footer,
  and `/blog` is absent from the sitemap and the prerender list, so the
  section can live on `main` before the first post without an empty page
  reaching a reader. TanStack Start still prerenders the route, and a crawler
  found the page that way, so `lib/seo.ts` gives it `robots: noindex` and drops
  its feed link until a post exists. Both return with the first post.
- A post's code is not compiled by `scripts/check-language-examples.ts`. A
  post either reuses a snippet from `lib/landing-snippets.ts` or verifies its
  example against the source by hand, as the writing rules in the repository
  root `CLAUDE.md` already require.
- The Markdown twin transform knows `Tabs` and `Tab` and no other component.
  A post that uses another MDX component fails the build until
  `scripts/mdx-to-markdown.ts` learns to expand it.

## Other landing conventions

- Snippet sources live in `lib/landing-snippets.ts`, are highlighted at build
  time by `scripts/gen-landing-code.ts`, and ship as static markup — the
  landing serves no client JavaScript for code. Verify every snippet against
  the current API surface before changing it.
- The line diagrams of the landing page live in `components/queue-diagrams.tsx`.
  The concept diagrams of `/features` live in `components/landing-diagrams.tsx`,
  are pure HTML/CSS, and may name only identifiers present in the verified
  snippets. Both use one drawing style: dashed boxes, mono labels, thin
  connectors, and one amber path.
- The site chrome does not show the Workhorse version: the shared header,
  the docs drawer, and the landing page have no version number.
  `/docs/releases` and the compatibility pages state it.
  `scripts/public-beta-release.test.ts` fails on a version number in the
  chrome, and requires the current release in `docs/compatibility.md` and
  `content/docs/compatibility.mdx`. `typescript/core/test/site-smoke.ts`
  requires the newest release of each changelog on `/docs/releases`.
