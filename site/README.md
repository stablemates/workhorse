# @stablemates/workhorse-site

The documentation site: a TanStack Start app serving the landing page at `/`
and the Fumadocs-rendered product documentation under `/docs`. Content rules
for the documentation itself live in the repository root `CLAUDE.md`; this
file records conventions of the site's own UI.

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
