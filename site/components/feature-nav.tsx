import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";

/*
 * The group nav of the features page. It sits under the hero, then sticks
 * under the site header while a reader scrolls the groups. The link of the
 * current group has a neutral fill that slides to the next group
 * (`.wh-fnav` in `marketing.css`).
 *
 * Every link is a plain fragment link, so the nav works before hydration
 * and without JavaScript. After hydration, a scroll handler finds the
 * current group, and a click scrolls to its group smoothly unless the reader
 * asks for reduced motion.
 */

interface NavGroup {
  id: string;
  title: string;
}

/** A group is current when its top passes this share of the viewport height. */
const currentLine = 0.4;

/**
 * The position of the fill, whether it shows, and whether it moves without a
 * slide. A hidden fill keeps its last position, so it fades out in place.
 */
interface Indicator {
  left: number;
  width: number;
  visible: boolean;
  instant: boolean;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Scroll to a group, smoothly unless the reader asks for reduced motion.
 *
 * The click replaces the native fragment move, so it also moves focus to the
 * group, as the native move does. The next Tab then goes into that group, not
 * back to the place the reader left.
 */
function jump(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (target === null || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
  history.replaceState(null, "", `#${id}`);
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

export function FeatureNav({ groups }: { groups: readonly NavGroup[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const shown = useRef(false);

  useEffect(() => {
    const sections = groups.flatMap((group) => {
      const element = document.getElementById(group.id);
      return element === null ? [] : [element];
    });
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * currentLine;
      let found: string | null = null;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= line) found = section.id;
      }
      setCurrent(found);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [groups]);

  useLayoutEffect(() => {
    const place = (instant: boolean) => {
      const link = current === null ? undefined : links.current.get(current);
      const row = scroller.current;
      if (link === undefined) {
        // Above the first group, the row of a narrow screen goes back to its start.
        row?.scrollTo({ left: 0, behavior: instant || prefersReducedMotion() ? "auto" : "smooth" });
        setIndicator((last) => (last === null ? null : { ...last, visible: false }));
        return;
      }
      setIndicator({ left: link.offsetLeft, width: link.offsetWidth, visible: true, instant });
      // On a narrow screen the row scrolls sideways. Keep the current link in view.
      if (row !== null && row.scrollWidth > row.clientWidth) {
        row.scrollTo({
          left: link.offsetLeft - (row.clientWidth - link.offsetWidth) / 2,
          behavior: instant || prefersReducedMotion() ? "auto" : "smooth",
        });
      }
    };
    // The fill appears in place the first time, and slides after that.
    place(!shown.current);
    shown.current = current !== null;
    const onResize = () => place(true);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [current]);

  return (
    <nav aria-label="Feature groups" className="wh-fnav">
      <div className="wh-fnav-track">
        <div ref={scroller} className="wh-fnav-scroll wh-scroll-x">
          <div className="wh-fnav-list">
            {groups.map((group) => (
              <a
                key={group.id}
                ref={(element) => {
                  if (element === null) links.current.delete(group.id);
                  else links.current.set(group.id, element);
                }}
                href={`#${group.id}`}
                aria-current={current === group.id ? "true" : undefined}
                className="wh-fnav-link"
                onClick={(event) => jump(event, group.id)}
              >
                {group.title}
              </a>
            ))}
            <span
              aria-hidden
              className="wh-fnav-indicator"
              data-visible={indicator?.visible || undefined}
              data-instant={indicator?.instant || undefined}
              style={
                indicator === null
                  ? undefined
                  : { translate: `${indicator.left}px 0`, inlineSize: `${indicator.width}px` }
              }
            />
          </div>
        </div>
      </div>
    </nav>
  );
}
