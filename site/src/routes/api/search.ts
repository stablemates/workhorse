import { createFileRoute } from "@tanstack/react-router";
import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/source";

const server = createFromSource(source);

/**
 * Static search. The build prerenders this route into a JSON index that the
 * browser downloads once, because a static site has no request-time handler.
 */
export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: async () => server.staticGET(),
    },
  },
});
