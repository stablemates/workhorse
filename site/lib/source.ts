import { compare, docs } from "@/.source/server";
import { loader, update } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

/**
 * The comparison pages as a source. Their files are relative to
 * `content/docs/compare/`, so each one gets the `compare/` folder back here,
 * and its URL comes from that folder (ADR 0116).
 */
const compareSource = update(toFumadocsSource(compare, []))
  .files((files) => files.map((file) => ({ ...file, path: `compare/${file.path}` })))
  .build();

/**
 * The documentation pages and the comparison pages as Fumadocs reads them, for
 * one use: the static search index at `/api/search` that the search dialog of
 * the landing page, the blog, and the site pages queries. Blume renders the
 * documentation pages, and the TanStack Start routes render the comparison
 * pages. The documentation pages search with Blume's own index.
 */
export const source = loader(
  { docs: docs.toFumadocsSource(), compare: compareSource },
  {
    baseUrl: "/docs",
    url: (slugs) => {
      if (slugs[0] === "compare") return `/${slugs.join("/")}`;
      return slugs.length === 0 ? "/docs" : `/docs/${slugs.join("/")}`;
    },
  },
);
