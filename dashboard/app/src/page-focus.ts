import { useLayoutEffect, useRef, type RefObject } from "react";
import type { PageRoute } from "./core.js";

/**
 * Focus placement after page navigation.
 *
 * The dashboard changes pages without a document load, so the browser leaves focus on the link
 * that was used, or on the document body after Back or Forward. A screen reader user then gets no
 * sign that the page changed. After a route change the shell moves focus to the page heading.
 * Polling, filters, the pager, and the task drawer change the URL but not the route, so they do
 * not move focus.
 */
export function navigationMovesFocus(previousRoute: PageRoute, route: PageRoute): boolean {
  return previousRoute !== route;
}

/**
 * Whether the page heading may take focus now.
 *
 * The page area can show the previous page, or the loading screen, for a short time after
 * navigation. The heading takes focus only when the page area shows the route in the URL.
 * If the user put focus in the new page or in a detail drawer before that, for example Back to a
 * link that opens a task, focus stays there.
 */
export function pageHeadingMayTakeFocus(state: {
  route: PageRoute;
  shownRoute: PageRoute | null;
  focusInPage: boolean;
  focusInDrawer: boolean;
}): boolean {
  return state.shownRoute === state.route && !state.focusInPage && !state.focusInDrawer;
}

/** The first candidate that is still in the document. */
export function firstConnected<T extends { isConnected: boolean }>(
  candidates: readonly (T | null | undefined)[],
): T | null {
  return candidates.find((candidate): candidate is T => candidate?.isConnected === true) ?? null;
}

/** Focus the first `h1` in `container`. It takes focus from a script only, not from Tab. */
export function focusPageHeading(container: HTMLElement | null): boolean {
  const heading = container?.querySelector("h1");
  if (!(heading instanceof HTMLElement)) return false;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus();
  return true;
}

const detailDrawerIds = ["task-detail-drawer", "event-detail-drawer"];

/**
 * Move focus to the page heading after each route change.
 *
 * `shownRoute` is the route that the page area shows. The hook waits until it equals `route`,
 * then waits for the heading, because a lazy page can draw its heading one commit later.
 */
export function usePageHeadingFocus(
  route: PageRoute,
  shownRoute: PageRoute | null,
  main: RefObject<HTMLElement | null>,
) {
  const previousRoute = useRef(route);
  const pending = useRef(false);
  useLayoutEffect(() => {
    if (navigationMovesFocus(previousRoute.current, route)) {
      previousRoute.current = route;
      pending.current = true;
    }
    const container = main.current;
    if (!pending.current || shownRoute !== route || !container) return;
    /** Returns true when no later attempt is necessary. */
    const place = (): boolean => {
      const active = document.activeElement;
      const allowed = pageHeadingMayTakeFocus({
        route,
        shownRoute,
        focusInPage: active !== null && active !== container && container.contains(active),
        focusInDrawer:
          active !== null &&
          detailDrawerIds.some((id) => document.getElementById(id)?.contains(active) ?? false),
      });
      if (allowed && !focusPageHeading(container)) return false;
      pending.current = false;
      return true;
    };
    if (place()) return;
    const observer = new MutationObserver(() => {
      if (place()) observer.disconnect();
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [route, shownRoute, main]);
}
