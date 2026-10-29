import { createFileRoute } from "@tanstack/react-router";

/**
 * Blume builds the documentation pages at `/docs` from `site/blume`, so this
 * app renders none of them. The header links of the landing page and the 404
 * page still reach `/docs` through the client router. This route turns such a
 * navigation into a full page load, which the server answers with the Blume
 * page. A preload on hover does nothing.
 *
 * The build does not prerender this route, so it never runs on the server.
 */
export const Route = createFileRoute("/docs")({
  beforeLoad: async ({ location, preload }) => {
    if (preload || typeof window === "undefined") return;
    window.location.assign(location.href);
    // Hold the navigation until the browser leaves the page.
    await new Promise<never>(() => {});
  },
  component: () => null,
});
