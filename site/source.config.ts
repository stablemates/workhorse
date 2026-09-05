import { pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineConfig, defineDocs } from "fumadocs-mdx/config";
import { createTokenClassTransformer, docsCodeThemes } from "./lib/code-highlighting.js";

export const docs = defineDocs({
  dir: "content/docs",
});

/**
 * Long-form posts, one MDX file per post at `content/blog/<slug>.mdx`, served
 * at `/blog/<slug>` (ADR 0052). The frontmatter is `title`, `description`, and
 * `date`. The page schema types the first two for the compiled module and drops
 * the rest; `scripts/gen-docs-index.ts` reads and validates all three at build
 * time and hands the date to the route. There is no author field: the posting
 * identity is decided elsewhere and can add one.
 */
export const blog = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: pageSchema,
});

export default defineConfig({
  mdxOptions: {
    // `fumadocs` preset supplies GFM, heading anchors, structured search data,
    // and Shiki highlighting with dual light/dark themes.
    preset: "fumadocs",
    rehypeCodeOptions: {
      themes: docsCodeThemes,
      // Token colours reach the page as classes rather than as a style on
      // every token, and `scripts/gen-code-theme.ts` writes the rules. A page
      // once carried more repeated hex colours than text.
      transformers: [createTokenClassTransformer()],
    },
  },
});
