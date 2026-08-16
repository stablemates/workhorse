import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The site is documentation only. The root sends the reader straight to the
 * docs index instead of a landing page.
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/docs", replace: true });
  },
});
