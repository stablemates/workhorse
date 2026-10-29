import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LoadState, PageData } from "./core.js";
import {
  ConnectionIndicator,
  EnvironmentIndicator,
  RefreshControl,
  RefreshSettings,
  dashboardConnectionStatus,
  isProductionEnvironment,
  namesDeploymentEnvironment,
  nextAppearance,
  type RefreshControlProps,
  type RefreshSettingsProps,
} from "./shell/HeaderControls.js";
import { GraphicalProvider, theme } from "./ui.js";

function render<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(
    createElement(
      GraphicalProvider,
      { document: theme, colorMode: "light" },
      createElement(component, props),
    ),
  );
}

const shellSource = readFileSync(new URL("./shell/AppShell.tsx", import.meta.url), "utf8");

describe("environment indicator", () => {
  it("gives production emphasis to values that start with prod, in any case", () => {
    for (const value of ["production", "PROD", "Prod-eu"]) {
      expect(isProductionEnvironment(value)).toBe(true);
    }
    for (const value of ["staging", "preprod", "standalone", "unknown"]) {
      expect(isProductionEnvironment(value)).toBe(false);
    }
  });

  it("shows a sentence-case label with an icon, not a filled badge", () => {
    const html = render(EnvironmentIndicator, { environment: "production" });
    expect(html).toContain('data-production="true"');
    expect(html).toContain(">Production<");
    expect(html).toContain(">Environment: <");
    expect(html).toContain("<svg");
    expect(html).not.toContain("mantine-Badge");
  });

  it("hides host labels that name no deployment environment", () => {
    for (const value of ["standalone", "Standalone", "unknown", " "]) {
      expect(namesDeploymentEnvironment(value)).toBe(false);
    }
    for (const value of ["production", "staging", "dev"]) {
      expect(namesDeploymentEnvironment(value)).toBe(true);
    }
    expect(shellSource).toContain("{environment && namesDeploymentEnvironment(environment) ? (");
  });

  it("keeps other environments neutral", () => {
    const html = render(EnvironmentIndicator, { environment: "staging" });
    expect(html).not.toContain("data-production");
    expect(html).toContain(">Staging<");
  });
});

describe("connection indicator", () => {
  const page = { route: "/queues", value: {} } as unknown as PageData;

  it("keeps all four outcomes of the page load state", () => {
    const states: Array<[LoadState, string]> = [
      [{ status: "loading", data: null, error: null }, "connecting"],
      [{ status: "loading", data: page, error: null }, "connected"],
      [{ status: "ready", data: page, error: null }, "connected"],
      [{ status: "error", data: page, error: "502", route: "/queues" }, "disconnected"],
      [
        { status: "stale", data: page, error: "502", refreshedAt: "2026-10-26T12:00:00.000Z" },
        "refreshFailed",
      ],
    ];
    for (const [state, status] of states) expect(dashboardConnectionStatus(state)).toBe(status);
  });

  it("names a healthy connection for assistive technology only, with no mark to click", () => {
    for (const [status, label] of [
      ["connected", "Connected"],
      ["connecting", "Connecting"],
    ] as const) {
      const html = render(ConnectionIndicator, { status });
      expect(html).toContain('role="status"');
      expect(html).toContain(`<span class="dashboard-visually-hidden">${label}</span>`);
      expect(html).not.toContain("<svg");
      expect(html).not.toContain("tabindex");
    }
  });

  it("shows a failure as visible text", () => {
    for (const [status, label] of [
      ["disconnected", "Disconnected"],
      ["refreshFailed", "Refresh failed"],
    ] as const) {
      const html = render(ConnectionIndicator, { status });
      expect(html).toContain('role="status"');
      expect(html).toContain(`<span class="dashboard-connection__label">${label}</span>`);
      expect(html).not.toContain("dashboard-visually-hidden");
    }
  });

  it("keeps the stale-page warning in the shell beside the quiet indicator", () => {
    expect(shellSource).toMatch(
      /<div role="status" aria-atomic="true">\s*\{loadState\.status === "stale" \?\s*\(\s*<PageRefreshWarning/,
    );
    expect(shellSource).toContain(
      "<ConnectionIndicator status={dashboardConnectionStatus(loadState)} />",
    );
  });
});

const settings: RefreshSettingsProps = {
  interval: "15s",
  paused: false,
  pauseDescription: "Auto refresh interval",
  firstPageHref: null,
  onIntervalChange: () => undefined,
  onFirstPage: () => undefined,
};

describe("refresh settings", () => {
  it("offers manual refresh and every interval as compact rows, and checks the current one", () => {
    const html = render(RefreshSettings, settings);
    const labels = [
      ...html.matchAll(/<span class="dashboard-refresh-option__label">([^<]+)<\/span>/g),
    ].map((match) => match[1]);
    expect(labels).toEqual([
      "Off",
      "5 seconds",
      "15 seconds",
      "30 seconds",
      "1 minute",
      "5 minutes",
    ]);
    expect(html).toContain('aria-labelledby="dashboard-refresh-settings-title"');
    expect(html.match(/role="radio"/g)).toHaveLength(6);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    // Each row is its radio, so the checked row names the interval and holds the only check mark.
    const checked = html.slice(html.indexOf('aria-checked="true"'));
    expect(checked.match(/dashboard-refresh-option__label">([^<]+)</)?.[1]).toBe("15 seconds");
    expect(html.match(/dashboard-refresh-option__check/g)).toHaveLength(1);
    // No radio circles: the rows draw no Graphical radio control.
    expect(html).not.toContain("ui-radio-dot");
  });

  it("states what holds auto refresh while it is paused", () => {
    const html = render(RefreshSettings, {
      ...settings,
      paused: true,
      pauseDescription: "Auto refresh paused while task details are open",
    });
    expect(html).toContain(">Auto refresh paused while task details are open<");
    expect(render(RefreshSettings, settings)).not.toContain("dashboard-refresh-settings__status");
  });

  it("states no pause for manual refresh", () => {
    const html = render(RefreshSettings, {
      ...settings,
      interval: "off",
      paused: true,
      pauseDescription: "Auto refresh paused while task details are open",
    });
    expect(html).not.toContain("dashboard-refresh-settings__status");
  });

  it("offers the first page only while the listing is pinned", () => {
    expect(render(RefreshSettings, settings)).not.toContain("Back to first page");
    const html = render(RefreshSettings, { ...settings, firstPageHref: "/tasks?per=25" });
    expect(html).toContain('<a href="/tasks?per=25">Back to first page</a>');
  });
});

describe("appearance button", () => {
  it("changes the preference in the order Light, Dark, System", () => {
    expect(nextAppearance("light").value).toBe("dark");
    expect(nextAppearance("dark").value).toBe("system");
    expect(nextAppearance("system").value).toBe("light");
  });

  it("is one button in the header, not a menu", () => {
    expect(shellSource).toContain("<AppearanceToggle />");
    expect(shellSource).not.toContain("AppearanceMenu");
  });
});

describe("refresh control", () => {
  const control: RefreshControlProps = {
    ...settings,
    loading: false,
    onRefresh: () => undefined,
  };

  it("names the refresh button and the settings button with the interval", () => {
    const html = render(RefreshControl, control);
    expect(html).toContain('aria-label="Refresh now"');
    expect(html).toContain('aria-label="Auto refresh settings. Every 15 seconds"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("data-paused");
    expect(html).not.toMatch(/>\s*(paused|manual)\s*</);
  });

  it("marks a pause and names its reason on the settings button", () => {
    const html = render(RefreshControl, {
      ...control,
      paused: true,
      pauseDescription: "Auto refresh resumes in 3 seconds",
    });
    expect(html).toContain('data-paused="true"');
    expect(html).toContain('class="dashboard-refresh__paused"');
    expect(html).toContain('aria-label="Auto refresh settings. Auto refresh resumes in 3 seconds"');
  });

  it("draws no countdown line under the buttons", () => {
    const html = render(RefreshControl, control);
    expect(html).not.toContain("dashboard-refresh__progress");
    expect(shellSource).not.toContain("progressDuration");
  });

  it("restarts the schedule when the operator refreshes", () => {
    expect(shellSource).toMatch(
      /onRefresh=\{\(\) => \{\s*resetRefreshSchedule\(\);\s*void loadPage\(\);\s*\}\}/,
    );
  });
});
