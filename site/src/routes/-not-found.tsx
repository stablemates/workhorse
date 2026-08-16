import { Link } from "@tanstack/react-router";

/**
 * Shown for any URL the router cannot match. TanStack Router falls back to a
 * bare "Not Found" string without this, which tells a reader nothing and offers
 * no way back.
 */
export function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col justify-center gap-4 px-6">
      <p className="font-mono text-sm text-fd-muted-foreground">404</p>
      <h1 className="text-3xl font-semibold tracking-tight">This page does not exist</h1>
      <p className="text-fd-muted-foreground">
        The page moved, or the link was wrong. The documentation index lists every page.
      </p>
      <div className="flex gap-3">
        <Link
          to="/docs"
          className="rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
        >
          Go to the docs
        </Link>
      </div>
    </main>
  );
}
