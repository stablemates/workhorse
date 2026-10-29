import { createFileRoute } from "@tanstack/react-router";

/**
 * Every `/docs/<slug>` URL. The parent route in `../docs.tsx` hands the
 * navigation to the server, which answers with the Blume page.
 */
export const Route = createFileRoute("/docs/$")({
  component: () => null,
});
