# @stablemates/workhorse-site

The documentation site: a TanStack Start app serving the landing page at `/`,
the Fumadocs-rendered product documentation under `/docs`, and long-form posts
under `/blog`. Content rules for the documentation itself live in the
repository root `CLAUDE.md`; this file records conventions of the site's own
UI and of the blog.

## Wide-viewport density: viewport-gated zoom

The site was reviewed on a wide monitor and judged best at the density of
roughly 150% browser zoom. Rather than inflate every font size — which would
cramp laptop layouts that already fill their width — both the landing page
and the docs layout reproduce that verdict with CSS `zoom` rules, gated by
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
- The landing wrapper is in `src/routes/index.tsx`; the docs wrapper is in
  `src/routes/docs.tsx`. Unlike browser zoom, element `zoom` does not shrink
  viewport units, so after touching the docs layout verify the sticky
  sidebar and table of contents on a wide screen.
- Firefox supports `zoom` from version 126; older browsers simply render the
  unscaled layout.

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
- `typescript/core/test/site-integrations-catalog.test.ts` enforces all of it.

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
  reaching a reader.
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
- Concept diagrams live in `components/landing-diagrams.tsx`, are pure
  HTML/CSS, and may name only identifiers present in the verified snippets.
- The docs sidebar footer shows the Workhorse version and carries
  `aria-label="Workhorse version <x.y.z>"`, which
  `typescript/core/test/site-smoke.ts` asserts on `/docs/api`. Keep the label
  if the footer moves.
