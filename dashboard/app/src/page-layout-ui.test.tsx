import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./components/empty-state.js";
import { Page, PageHeader, PageSection, TablePanel } from "./components/page-header.js";
import { ConfirmDialog } from "./components/confirm-dialog.js";
import { GraphicalProvider, theme } from "./ui.js";

const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(
      GraphicalProvider,
      { document: theme, colorMode: "light" },
      createElement(MantineProvider, null, element),
    ),
  );

describe("page header", () => {
  it("draws one h1 with a description and a separate actions group", () => {
    const html = render(
      createElement(PageHeader, {
        title: "Queues",
        description: "Pause new claims.",
        actions: createElement("button", { type: "button" }, "Refresh"),
      }),
    );
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 class="page-header__title">Queues<\/h1>/);
    expect(html).toContain('<p class="page-header__description">Pause new claims.</p>');
    // The actions wrap on their own, outside the title block.
    expect(html).toMatch(
      /<\/div><div class="page-header__actions"><button type="button">Refresh<\/button><\/div><\/header>/,
    );
  });

  it("keeps actions on the title line when a page asks for one header height", () => {
    const html = render(
      createElement(PageHeader, {
        title: "Tasks",
        inlineActions: true,
        actions: createElement("button", { type: "button" }, "Redrive"),
      }),
    );
    expect(html).toContain('<header class="page-header page-header--inline">');
    const css = readFileSync(new URL("./components/page-layout.css", import.meta.url), "utf8");
    // On a phone the actions of other pages take a full row. These stay beside the title.
    expect(css).toMatch(/\.page-header--inline \.page-header__actions \{\s*width: auto;/);
  });

  it("starts the page content 16px under the header, with sections 24px apart", () => {
    const css = readFileSync(new URL("./components/page-layout.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.page \{[^}]*gap: var\(--mantine-spacing-md\);/);
    expect(css).toMatch(
      /\.page > :not\(\.page-header\) \+ \.page-section \{\s*margin-top: var\(--mantine-spacing-xs\);/,
    );
    const shell = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(shell).toMatch(
      /\.dashboard-main \{\s*padding-top: calc\(var\(--app-shell-header-offset, 0rem\) \+ var\(--mantine-spacing-md\)\);/,
    );
  });

  it("leaves out the description and actions when a page has none", () => {
    const html = render(createElement(PageHeader, { title: "Workers" }));
    expect(html).not.toContain("page-header__description");
    expect(html).not.toContain("page-header__actions");
  });

  it("labels a page section with its h2", () => {
    const html = render(
      createElement(
        Page,
        { narrow: true },
        createElement(PageSection, { id: "storage-title", title: "Storage" }, "Body"),
      ),
    );
    expect(html).toContain('class="page page--narrow"');
    expect(html).toMatch(/<section class="page-section" aria-labelledby="storage-title">/);
    expect(html).toMatch(/<h2 class="page-section__title" id="storage-title">Storage<\/h2>/);
  });

  it("puts a table in a named scroll region inside its panel", () => {
    const html = render(
      createElement(TablePanel, { label: "Queues table" }, createElement("table", null)),
    );
    expect(html).toContain('class="panel data-table__panel"');
    expect(html).toMatch(
      /role="region"[^>]*aria-label="Queues table"|aria-label="Queues table"[^>]*role="region"/,
    );
    expect(html).toContain('tabindex="0"');
  });
});

describe("empty state", () => {
  it("names what is missing and explains it, with no success mark", () => {
    const html = render(
      createElement(
        EmptyState,
        { title: "No schedules" },
        "A schedule appears after it registers.",
      ),
    );
    expect(html).toContain('<p class="empty-state__title">No schedules</p>');
    expect(html).toContain("A schedule appears after it registers.");
    expect(html).not.toContain("No results");
    expect(html).not.toContain("<svg");
  });

  it("offers an action such as Clear filters", () => {
    const html = render(
      createElement(EmptyState, {
        title: "No events match these filters",
        action: createElement("button", { type: "button" }, "Clear filters"),
      }),
    );
    expect(html).toContain('<div class="empty-state__action"><button type="button">Clear filters');
  });

  it("drops the panel edge inside a panel", () => {
    const html = render(createElement(EmptyState, { title: "No failed attempts", framed: false }));
    expect(html).toContain('<div class="empty-state">');
  });
});

describe("confirmation dialog", () => {
  it("renders nothing while it is closed", () => {
    const html = render(
      createElement(
        ConfirmDialog,
        {
          open: false,
          title: "Clear this queue?",
          confirmLabel: "Clear queue",
          onConfirm: () => undefined,
          onCancel: () => undefined,
        },
        "Body",
      ),
    );
    expect(html).not.toContain("Clear this queue?");
  });
});

describe("page headings", () => {
  const routePages = [
    "pages/tasks.tsx",
    "pages/events.tsx",
    "pages/task-groups.tsx",
    "pages/schedules.tsx",
    "pages/queues.tsx",
    "pages/workers.tsx",
    "pages/overview.tsx",
    "pages/settings/index.tsx",
  ];

  it.each(routePages)("%s draws its h1 through the shared page header", (page) => {
    const source = readFileSync(new URL(`./${page}`, import.meta.url), "utf8");
    expect(source).toContain("<PageHeader");
    expect(source).not.toMatch(/<h1\b|order=\{1\}|component="h1"/);
  });
});
