/** A serialized origin: a scheme and an authority, with no path, query, fragment, or user. */
const BARE_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/\\?#@\s,]+$/i;

/**
 * Whether the request's `Origin` header names the request URL origin.
 *
 * The parsed origin must match exactly. An absent or malformed `Origin` is never evidence that the
 * request came from this dashboard. Two `Origin` headers arrive joined by a comma, so they fail the
 * bare-origin pattern.
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || !BARE_ORIGIN.test(origin)) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * Refuse a state-changing request that does not come from the dashboard's own origin.
 *
 * The request must carry an `Origin` header whose parsed origin exactly matches the request URL
 * origin. An absent or malformed `Origin` fails closed. The host applies this check to every
 * dashboard mutation, and the single-admin authentication applies it to logout.
 */
export function rejectCrossOriginMutation(request: Request): Response | null {
  if (isSameOrigin(request)) return null;
  return Response.json({ error: "A same-origin mutation request is required" }, { status: 403 });
}

/**
 * Refuse a page, an asset, or a read procedure that a page on another origin requests.
 *
 * A browser sends `Origin` on every cross-origin fetch, so a host CORS policy that allows
 * credentials cannot expose a read to a foreign page. A top-level navigation sends no `Origin`, so
 * a request without the header passes (ADR 0029, SM-1675).
 */
export function rejectCrossOriginRead(request: Request): Response | null {
  if (!request.headers.has("origin") || isSameOrigin(request)) return null;
  return Response.json({ error: "A same-origin request is required" }, { status: 403 });
}
