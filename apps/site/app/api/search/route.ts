import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

/**
 * Server-side search over the docs page tree.
 *
 * The dynamic route keeps the client bundle small: the browser only sends a
 * query string, so no search index is shipped to the visitor. The index itself
 * is built once at module scope from the same `source` loader the routes use.
 */
export const { GET } = createFromSource(source);
