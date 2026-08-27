import { MantineProvider } from "@mantine/core";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

// Imported after the stub above because the dashboard module reads localStorage on evaluation.
const { DashboardWorkspaceSwitcher } = await import("./dashboard.js");

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(DashboardWorkspaceSwitcher as ComponentType, {
        // Render the dropdown inline so static markup includes the menu items.
        opened: true,
        withinPortal: false,
        transitionProps: { duration: 0 },
        ...props,
      }),
    ),
  );
}

const workspaces = [
  {
    name: "production",
    url: "/workhorse/production",
    databaseHost: "db.internal:5432",
    databaseName: "workhorse_demo",
  },
  { name: "staging", url: "/workhorse/staging" },
];

describe("DashboardWorkspaceSwitcher", () => {
  it("labels the control with the active workspace and lists the others as links", () => {
    const html = render({ workspaces, workspace: "staging" });
    expect(html).toContain('aria-label="Workspace staging"');
    expect(html).toContain('href="/workhorse/production/tasks"');
    expect(html).toContain("staging");
  });

  it("shows the database host and name behind a workspace when the host supplies them", () => {
    const html = render({ workspaces, workspace: "staging" });
    expect(html).toContain("db.internal:5432 · workhorse_demo");
  });

  it("renders nothing in single-workspace mode", () => {
    const empty = render({ workspaces: [], workspace: null });
    expect(empty).not.toContain("aria-label");
    const alone = render({ workspaces: [workspaces[0]], workspace: "production" });
    expect(alone).not.toContain("aria-label");
  });
});
