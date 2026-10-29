import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tooltip } from "@mantine/core";
import type { DashboardTaskCounts } from "@stablemates/workhorse-dashboard-server/wire";
import { useId, useLayoutEffect, useRef, type MouseEvent, type ReactElement } from "react";

import { blockedTaskDescription, taskFilters } from "../core.js";
import { formatCount } from "../count-format.js";
import { taskFilterHref, type TaskLocationState } from "../task-location.js";

export interface TaskStatusTabsProps {
  /** The task listing that the page shows now. */
  location: TaskLocationState;
  /** Counts for each status view. A view without a count shows no number. */
  taskCounts: Partial<DashboardTaskCounts> | null;
  /** The mounted href of a dashboard path, for the `href` of a link. */
  href: (path: string) => string;
  /** Follows a link inside the dashboard. A modified click stays with the browser. */
  followLink: (event: MouseEvent<HTMLElement>, path: string) => void;
}

/** One status view of the row, with the dashboard path that selects it. */
export interface TaskStatusTab {
  value: TaskLocationState["filter"];
  label: string;
  path: string;
  count: number | undefined;
  current: boolean;
  description: string | undefined;
}

/**
 * The ten status views in their fixed order. Each path keeps the other listing parameters and
 * starts a fresh list, as `taskFilterHref` states.
 */
export function taskStatusTabs(
  location: TaskLocationState,
  taskCounts: Partial<DashboardTaskCounts> | null,
): TaskStatusTab[] {
  return taskFilters.map(({ value, label }) => ({
    value,
    label,
    path: taskFilterHref(location, value),
    count: taskCounts?.[value],
    current: location.filter === value,
    description: value === "blocked" ? blockedTaskDescription : undefined,
  }));
}

/** A tab with a description shows it in a tooltip on hover and focus. */
function DescribedTab({
  description,
  children,
}: {
  description: string | undefined;
  children: ReactElement;
}) {
  if (description === undefined) return children;
  return (
    <Tooltip
      label={description}
      multiline
      w={300}
      openDelay={250}
      position="bottom-start"
      events={{ hover: true, focus: true, touch: true }}
    >
      {children}
    </Tooltip>
  );
}

/**
 * Places the underline under the current tab.
 *
 * One underline moves from tab to tab, so a click shows the new view at once. The underline is
 * placed before the browser paints, and it moves again when a count changes the width of a tab.
 * It moves with a transform, so a move does not lay out the page.
 */
function useTabIndicator(
  list: { current: HTMLUListElement | null },
  indicator: { current: HTMLLIElement | null },
  placementKey: string,
) {
  useLayoutEffect(() => {
    const row = list.current;
    const bar = indicator.current;
    if (!row || !bar) return;
    const place = () => {
      const current = row.querySelector<HTMLElement>('[aria-current="page"]');
      if (!current) {
        bar.style.opacity = "0";
        return;
      }
      // Each tab has a 4px inset for its focus ring. The underline spans the text only.
      const width = Math.max(current.offsetWidth - 8, 0);
      bar.style.transform = `translateX(${current.offsetLeft + 4}px) scaleX(${width})`;
      bar.style.opacity = "1";
    };
    place();
    // The first placement does not slide in from the start of the row.
    const ready = requestAnimationFrame(() => bar.setAttribute("data-ready", ""));
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(row);
    for (const tab of row.querySelectorAll("a")) observer?.observe(tab);
    return () => {
      cancelAnimationFrame(ready);
      observer?.disconnect();
    };
  }, [list, indicator, placementKey]);
}

/**
 * The status views of the task list as a row of links above the list. One underline marks the
 * current view and moves to a new view on the click. Each count is muted, and a zero count is
 * fainter. The current view has a heavier label, and each label reserves that width, so no tab
 * moves when the current view changes. On a narrow window the row scrolls sideways and keeps the
 * current view in sight.
 */
export function TaskStatusTabs({ location, taskCounts, href, followLink }: TaskStatusTabsProps) {
  const descriptionId = useId();
  const scroller = useRef<HTMLUListElement | null>(null);
  const indicator = useRef<HTMLLIElement | null>(null);
  const tabs = taskStatusTabs(location, taskCounts);
  useTabIndicator(
    scroller,
    indicator,
    `${location.filter}:${tabs.map((tab) => tab.count ?? "").join(",")}`,
  );

  // Scroll only the row, never the page, so a deep link to Canceled shows its tab on a phone.
  useLayoutEffect(() => {
    const row = scroller.current;
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !current) return;
    // The list is the offset parent of each tab, so `offsetLeft` is a position in the row.
    const start = current.offsetLeft;
    const end = start + current.offsetWidth;
    if (start < row.scrollLeft) row.scrollLeft = start;
    else if (end > row.scrollLeft + row.clientWidth) row.scrollLeft = end - row.clientWidth;
  }, [location.filter]);

  return (
    <nav className="task-status-tabs" aria-label="Task status">
      <ul ref={scroller} className="task-status-tabs__list">
        {tabs.map((tab) => (
          <li key={tab.value}>
            <DescribedTab description={tab.description}>
              <a
                className="task-status-tabs__tab"
                href={href(tab.path)}
                aria-current={tab.current ? "page" : undefined}
                aria-label={
                  tab.count === undefined
                    ? undefined
                    : `${tab.label}, ${formatCount(tab.count)} tasks`
                }
                aria-describedby={tab.description ? descriptionId : undefined}
                onClick={(event) => followLink(event, tab.path)}
              >
                <span className="task-status-tabs__label" data-text={tab.label}>
                  {tab.label}
                </span>
                {tab.description === undefined ? null : (
                  <HugeiconsIcon
                    className="task-status-tabs__info"
                    icon={InformationCircleIcon}
                    size={12}
                    aria-hidden="true"
                  />
                )}
                {tab.count === undefined ? null : (
                  <span
                    className="task-status-tabs__count"
                    data-zero={tab.count === 0 || undefined}
                    aria-hidden="true"
                  >
                    {formatCount(tab.count)}
                  </span>
                )}
              </a>
            </DescribedTab>
          </li>
        ))}
        <li ref={indicator} className="task-status-tabs__indicator" aria-hidden="true" />
      </ul>
      <span id={descriptionId} hidden>
        {blockedTaskDescription}
      </span>
    </nav>
  );
}
