import { ScrollArea } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * The page column: sections 24px apart. `narrow` caps a form page such as Settings at a reading
 * width; data pages use the full width.
 */
export function Page({ narrow = false, children }: { narrow?: boolean; children: ReactNode }) {
  return <div className={narrow ? "page page--narrow" : "page"}>{children}</div>;
}

/**
 * The visible heading of a page: one `h1` at 24/32, an optional 14/20 description, and actions.
 *
 * The title block and the actions wrap independently, so a long action row moves below the title
 * instead of squeezing it. `titleAside` sits on the title line, for a help button or a state
 * label that belongs to the title.
 *
 * `inlineActions` keeps the actions on the title line at every width. A page whose actions come
 * and go with a view, such as Tasks, uses it, so the content below the header does not move.
 */
export function PageHeader({
  title,
  description,
  titleAside,
  actions,
  inlineActions = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  titleAside?: ReactNode;
  actions?: ReactNode;
  inlineActions?: boolean;
}) {
  return (
    <header className={inlineActions ? "page-header page-header--inline" : "page-header"}>
      <div className="page-header__text">
        <div className="page-header__title-row">
          <h1 className="page-header__title">{title}</h1>
          {titleAside}
        </div>
        {description === undefined ? null : (
          <p className="page-header__description">{description}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

/**
 * One section of a page with an `h2` heading at 16/24. The heading id labels the section, so a
 * screen reader lists it as a region.
 */
export function PageSection({
  id,
  title,
  titleAside,
  description,
  actions,
  children,
}: {
  id: string;
  title: ReactNode;
  titleAside?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page-section" aria-labelledby={id}>
      <div className="page-section__header">
        <div>
          <div className="page-header__title-row">
            <h2 className="page-section__title" id={id}>
              {title}
            </h2>
            {titleAside}
          </div>
          {description === undefined ? null : (
            <p className="page-section__description">{description}</p>
          )}
        </div>
        {actions === undefined ? null : <div className="page-header__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * The panel around a data table. The table scrolls sideways inside it, so a wide table never
 * widens the page. The scroll viewport is a named region that takes focus, so a keyboard user
 * can scroll it.
 */
export function TablePanel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="panel data-table__panel">
      <ScrollArea
        type="auto"
        offsetScrollbars="x"
        viewportProps={{ tabIndex: 0, role: "region", "aria-label": label }}
      >
        {children}
      </ScrollArea>
    </div>
  );
}
