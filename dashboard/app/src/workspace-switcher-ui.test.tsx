import { MantineProvider } from "@mantine/core";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

// Imported after the stub above because the dashboard module reads localStorage on evaluation.
const { DashboardWorkspaceSwitcher } = await import("./dashboard.js");

function render(component: unknown, props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(component as ComponentType, props)),
  );
}

const workspaces = [
  { name: "production", url: "/workhorse/production" },
  { name: "staging", url: "/workhorse/staging" },
];

describe("DashboardWorkspaceSwitcher", () => {
  it("labels the control with the active workspace", () => {
    const html = render(DashboardWorkspaceSwitcher, { workspaces, workspace: "staging" });
    expect(html).toContain('aria-label="Workspace staging"');
    expect(html).toContain("staging");
  });

  it("renders nothing in single-workspace mode", () => {
    const empty = render(DashboardWorkspaceSwitcher, { workspaces: [], workspace: null });
    expect(empty).not.toContain("aria-label");
    const alone = render(DashboardWorkspaceSwitcher, {
      workspaces: [workspaces[0]],
      workspace: "production",
    });
    expect(alone).not.toContain("aria-label");
  });
});
