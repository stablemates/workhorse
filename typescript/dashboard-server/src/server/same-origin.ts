/**
 * Refuse a state-changing request that does not come from the dashboard's own origin.
 *
 * The request must carry an `Origin` header whose parsed origin exactly matches the request URL
 * origin. An absent or malformed `Origin` fails closed. The host applies this check to every
 * dashboard mutation, and the single-admin authentication applies it to logout.
 */
export function rejectCrossOriginMutation(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin === new URL(request.url).origin) return null;
    } catch {
      // A malformed Origin is never evidence that the request came from this dashboard.
    }
  }
  return Response.json({ error: "A same-origin mutation request is required" }, { status: 403 });
}
