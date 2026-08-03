import { docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";

/**
 * Single loader for the docs tree. Route handlers, search indexing, and the
 * sitemap all read from this so the page tree can never drift between them.
 */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
