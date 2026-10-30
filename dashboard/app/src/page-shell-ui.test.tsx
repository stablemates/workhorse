import { readFileSync } from "node:fs";

import { MantineProvider } from "@mantine/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LoadState, PageData, PageRoute } from "./core.js";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

// Imported after the stub above because these modules read stored preferences on evaluation.
const { PageRefreshWarning, SkipToContentLink } = await import("./shell/AppShell.js");
const { documentTitle, pageContentRoute, routeHeading } = await import("./shell/controller.js");

const controllerSource = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("./shell/AppShell.tsx", import.meta.url), "utf8");
const drawerSource = readFileSync(new URL("./pages/task-detail.tsx", import.meta.url), "utf8");

function render(element: ReactElement): string {
  return renderToStaticMarkup(createElement(MantineProvider, null, element));
}

describe("document title", () => {
  it.each([
    ["/tasks", "Tasks · Workhorse"],
    ["/events", "Events · Workhorse"],
    ["/groups", "Task groups · Workhorse"],
    ["/cron", "Schedules · Workhorse"],
    ["/queues", "Queues · Workhorse"],
    ["/system", "System health · Workhorse"],
    ["/workers", "Workers · Workhorse"],
    ["/settings", "Settings · Workhorse"],
  ] as const)("names the page for %s", (route: PageRoute, title) => {
    expect(documentTitle(route)).toBe(title);
    expect(title.startsWith(routeHeading(route))).toBe(true);
  });

  it("follows the route and gives the host its title back on unmount", () => {
    expect(controllerSource).toMatch(
      /useEffect\(\(\) => \{\s*document\.title = documentTitle\(route\);\s*\}, \[route\]\);/,
    );
    expect(controllerSource).toMatch(/const hostTitle = document\.title;/);
  });
});

describe("skip link and page focus", () => {
  it("renders a skip link to the page area", () => {
    const html = render(createElement(SkipToContentLink, { targetId: "dashboard-main" }));
    expect(html).toContain('href="#dashboard-main"');
    expect(html).toContain('class="dashboard-skip-link"');
    expect(html).toContain(">Skip to main content<");
  });

  it("puts the skip link first and makes the page area a focus target", () => {
    expect(shellSource).toMatch(
      /<AppShell[\s\S]*?>\s*<SkipToContentLink targetId=\{mainContentId\} \/>\s*<AppShell\.Header>/,
    );
    expect(shellSource).toMatch(/id=\{mainContentId\}[\s\S]*?tabIndex=\{-1\}/);
    expect(shellSource).toContain("usePageHeadingFocus(location.route, shownRoute, mainContent);");
    // Closing the drawer falls back to the page heading when the opening row is gone.
    expect(shellSource).toMatch(
      /if \(opener\) opener\.focus\(\);\s*else focusPageHeading\(mainContent\.current\);/,
    );
  });

  it("leaves the page heading to each page and draws none of its own", () => {
    // Every page draws one visible `h1` through `PageHeader`, so the shell adds no hidden one.
    expect(controllerSource).not.toContain('<VisuallyHidden component="h1">');
    expect(controllerSource).toMatch(/<Text component="h1"[^>]*>\s*Workhorse could not load/);
  });
});

describe("route that the page area shows", () => {
  const queues = { route: "/queues", value: {} } as unknown as PageData;

  it("names the previous page for the render right after navigation", () => {
    const ready: LoadState = { status: "ready", data: queues, error: null };
    expect(pageContentRoute(ready, false, "/workers")).toBe("/queues");
  });

  it("names no page while the loading screen shows", () => {
    const loading: LoadState = { status: "loading", data: queues, error: null };
    expect(pageContentRoute(loading, true, "/workers")).toBeNull();
  });

  it("names the page for a stale page that a manual refresh retries", () => {
    const stale: LoadState = {
      status: "stale",
      data: queues,
      error: "502",
      refreshedAt: "2026-10-22T12:00:00.000Z",
    };
    expect(pageContentRoute(stale, true, "/queues")).toBe("/queues");
  });

  it("names the route whose load failed for the error screen", () => {
    const error: LoadState = { status: "error", data: queues, error: "502", route: "/workers" };
    expect(pageContentRoute(error, false, "/workers")).toBe("/workers");
  });
});

describe("failed background refresh", () => {
  it("states the failure and the time of the last successful refresh", () => {
    const html = render(
      createElement(PageRefreshWarning, {
        error: "502 Bad Gateway",
        refreshedAt: "2026-10-22T12:00:00.000Z",
      }),
    );
    expect(html).toContain("Refresh failed");
    expect(html).toMatch(/datetime="2026-10-22T12:00:00.000Z"/i);
    expect(html).toContain("It can be out of date.");
    expect(html).toContain("502 Bad Gateway");
    // The mounted live region around it announces the change; an alert role would interrupt.
    expect(html).not.toContain('role="alert"');
  });

  it("keeps the page for a stale state and the error screen only for an error", () => {
    expect(controllerSource).toContain(
      "setLoadState((current) => failedLoadState(current, { route, error }, retained));",
    );
    expect(controllerSource).toContain('} else if (loadState.status === "error") {');
    expect(shellSource).toMatch(
      /<div role="status" aria-atomic="true">\s*\{loadState\.status === "stale" \?/,
    );
  });
});

describe("task detail reload", () => {
  it("empties the drawer only for another task", () => {
    expect(controllerSource).toContain(
      "if (!taskDetailKeepsShownDetail(selectedTaskIdRef.current, id)) setSelectedTask(null);",
    );
    expect(controllerSource).not.toMatch(
      /selectedTaskIdRef\.current = id;\s*setSelectedTask\(null\);/,
    );
  });

  it("makes the task heading a focus target outside the tab order", () => {
    expect(drawerSource).toMatch(/id=\{taskOverviewHeadingId\}[\s\S]*?tabIndex=\{-1\}/);
    expect(drawerSource).toContain("<Box onFocusCapture={trackFocus}>");
  });
});
