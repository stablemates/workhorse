import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/** The collapse and expand motion of the sidebar and the page: a fast start and a soft stop. */
export const sidebarMotion = { durationMs: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)" } as const;

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

/** A slide of one element: where it starts, how long it takes, and its full distance. */
export interface SidebarSlide {
  /** The start offset from the new place, in pixels. */
  offset: number;
  durationMs: number;
  /** The full distance of the slide, in pixels. A turn in the middle keeps it. */
  distance: number;
}

/**
 * The slide of an element that shows at `before` and has its new place at `after`.
 *
 * `interruptedDistance` is the full distance of a slide that still runs, or null. A turn in the
 * middle of a slide takes the share of the time that the distance needs, the same as the reversed
 * CSS transitions of the sidebar. A distance under half a pixel gives no slide.
 */
export function sidebarSlide(
  before: number,
  after: number,
  interruptedDistance: number | null,
): SidebarSlide | null {
  const offset = before - after;
  const distance = Math.abs(offset);
  if (distance < 0.5) return null;
  const full = interruptedDistance === null ? distance : Math.max(interruptedDistance, distance);
  return { offset, durationMs: sidebarMotion.durationMs * (distance / full), distance: full };
}

/** The elements that slide: the sidebar panel and the page elements that follow its edge. */
export interface SidebarSlideTargets {
  /**
   * The sidebar panel. It holds the sidebar contents as its first child. The contents take the
   * opposite slide, so the icons stay in place while the edge moves.
   */
  panel: RefObject<HTMLElement | null>;
  /** Page elements that start one page padding past the sidebar edge, such as the page itself. */
  followers: readonly RefObject<HTMLElement | null>[];
}

/** Starts a transform slide from `offset` pixels to the element's own resting transform. */
function slide(element: HTMLElement, offset: number, durationMs: number): Animation {
  // The animation replaces the transform from CSS while it runs, so it starts from that transform.
  const rest = getComputedStyle(element).transform;
  const base = rest === "none" ? "" : `${rest} `;
  return element.animate(
    [{ transform: `${base}translateX(${offset}px)` }, { transform: `${base}translateX(0px)` }],
    { duration: durationMs, easing: sidebarMotion.easing },
  );
}

/**
 * Slides the sidebar and the page on one clock, without a layout on each frame.
 *
 * The page takes its new width in one layout when the sidebar state changes, so charts and tables
 * measure and render once. Each element then starts at the place where it was and slides to its
 * new place with a transform, which the compositor runs. All slides start in one task with one
 * duration, so the page edge follows the sidebar edge, also when the main thread is busy.
 *
 * Call `capture` immediately before the change. It records where each element shows now, also
 * while an earlier slide runs, so a second toggle turns the elements around where they are.
 */
export function useSidebarSlide(collapsed: boolean, targets: SidebarSlideTargets): () => void {
  const captured = useRef<{ panel: number | null; followers: Map<HTMLElement, number> } | null>(
    null,
  );
  const running = useRef<{ animations: Animation[]; distance: number } | null>(null);
  const latestTargets = useRef(targets);
  latestTargets.current = targets;

  const capture = useCallback(() => {
    const { panel, followers } = latestTargets.current;
    const positions = new Map<HTMLElement, number>();
    for (const target of followers) {
      const element = target.current;
      if (element) positions.set(element, element.getBoundingClientRect().left);
    }
    captured.current = {
      panel: panel.current?.getBoundingClientRect().left ?? null,
      followers: positions,
    };
  }, []);

  useLayoutEffect(() => {
    const before = captured.current;
    captured.current = null;
    const panel = latestTargets.current.panel.current;
    if (before === null || before.panel === null || panel === null) return;
    if (window.matchMedia(reducedMotionQuery).matches || typeof panel.animate !== "function") {
      return;
    }
    const previous = running.current;
    const interruptedDistance =
      previous?.animations.some((animation) => animation.playState === "running") === true
        ? previous.distance
        : null;
    for (const animation of previous?.animations ?? []) animation.cancel();
    running.current = null;

    const edge = sidebarSlide(
      before.panel,
      panel.getBoundingClientRect().left,
      interruptedDistance,
    );
    if (edge === null) return;
    const animations = [slide(panel, edge.offset, edge.durationMs)];
    const contents = panel.firstElementChild;
    if (contents instanceof HTMLElement) {
      animations.push(slide(contents, -edge.offset, edge.durationMs));
    }
    for (const [element, left] of before.followers) {
      if (!element.isConnected) continue;
      const offset = left - element.getBoundingClientRect().left;
      if (Math.abs(offset) >= 0.5) animations.push(slide(element, offset, edge.durationMs));
    }
    const current = { animations, distance: edge.distance };
    running.current = current;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (running.current === current) running.current = null;
      },
      () => undefined,
    );
  }, [collapsed]);

  return capture;
}
