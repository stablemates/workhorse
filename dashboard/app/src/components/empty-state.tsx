import type { ReactNode } from "react";

/**
 * What a page shows when a list has no rows.
 *
 * The title names what is missing, such as "No schedules". The body says why and what to do. An
 * empty result is not a success, so the state shows no checkmark. For a filtered list, pass a
 * "Clear filters" button as `action`. Loading, failure, and stale data have their own states.
 */
export function EmptyState({
  title,
  children,
  action,
  framed = true,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  /** Draw the panel edge. Turn it off when the state sits inside a panel already. */
  framed?: boolean;
}) {
  return (
    <div className={framed ? "panel empty-state" : "empty-state"}>
      <p className="empty-state__title">{title}</p>
      {children === undefined ? null : <p className="empty-state__body">{children}</p>}
      {action === undefined ? null : <div className="empty-state__action">{action}</div>}
    </div>
  );
}
