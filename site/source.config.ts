import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig({
  mdxOptions: {
    // `fumadocs` preset supplies GFM, heading anchors, structured search data,
    // and Shiki highlighting with dual light/dark themes.
    preset: "fumadocs",
    rehypeCodeOptions: {
      themes: {
        light: "github-light",
        dark: "github-dark-dimmed",
      },
    },
  },
});
