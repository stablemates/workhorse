import { createFileRoute } from "@tanstack/react-router";

import { NotFound } from "./-not-found";

/**
 * The 404 page as a real route (ADR 0062).
 *
 * The site is prerendered, and the prerenderer refuses a page that answers
 * anything but 2xx, so the page a missing URL shows has to be built under a
 * URL of its own. `site/nginx.conf` serves this page's HTML, with status 404,
 * for any path that matches nothing; the client router then renders the same
 * `NotFound` component, so a reader sees one design whether the page arrived
 * from the origin or from a client-side navigation.
 *
 * The route itself answers 200 at `/not-found`, so it asks not to be indexed
 * and the generator keeps it out of the sitemap.
 */
export const Route = createFileRoute("/not-found")({
  head: () => ({
    meta: [{ title: "Page not found — Workhorse" }, { name: "robots", content: "noindex" }],
  }),
  component: NotFound,
});
