import { defineComponents } from "blume";

/**
 * The MDX components the documentation pages use beyond Blume's built-ins.
 *
 * `Tab` adapts the authored `<Tab value="…">` to Blume's `<Tab title="…">`.
 * The pages keep `items` and `value`, because `site/scripts/mdx-to-markdown.ts`
 * and `site/scripts/check-language-examples.ts` read the language list there.
 * Blume's own `<Tabs>` ignores `items`. The other three read the generated
 * data in `site/.source/` and the data files in `site/`, so a page cannot
 * disagree with them.
 *
 * `Header` replaces Blume's header with the site header, so the docs and the
 * other pages share one header. `MobileNav` adds the header items above
 * Blume's page tree in the drawer.
 * `PageHeader` adds the publisher to the JSON-LD of each page.
 */
export default defineComponents({
  mdx: {
    Tab: "./components/Tab.astro",
    Diagram: "./components/Diagram.astro",
    IntegrationCatalog: "./components/IntegrationCatalog.tsx",
    ReleaseTable: "./components/ReleaseTable.tsx",
  },
  layout: {
    Header: "./components/Header.astro",
    MobileNav: "./components/MobileNav.astro",
    PageHeader: "./components/PageHeader.astro",
  },
});
