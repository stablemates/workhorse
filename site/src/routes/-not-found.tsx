import { Link } from "@tanstack/react-router";

/**
 * Shown for any URL the router cannot match. TanStack Router falls back to a
 * bare "Not Found" string without this, which tells a reader nothing and offers
 * no way back.
 */
export function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col justify-center gap-4 px-6">
      <p className="font-mono text-ui-s text-wh-muted">404</p>
      <h1 className="text-ui-xl font-semibold tracking-[-0.02em] text-wh-fg">
        This page does not exist
      </h1>
      <p className="text-ui-m text-wh-muted">
        The page moved, or the link was wrong. The documentation index lists every page.
      </p>
      <div className="flex gap-3">
        <Link to="/docs" className="wh-button wh-button-primary">
          Go to the docs
        </Link>
      </div>
    </main>
  );
}
