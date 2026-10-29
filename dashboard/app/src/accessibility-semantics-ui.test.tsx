import { DEFAULT_THEME, MantineProvider, mergeMantineTheme } from "@mantine/core";
import { readdirSync, readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardTaskRow } from "@stablemates/workhorse-dashboard-server/wire";
import { dashboardMantineTheme, dashboardPageColor } from "./mantine-theme.js";

const sourceRoot = new URL("./", import.meta.url);

function render<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(component, props)),
  );
}

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory));
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [new URL(entry.name, directory)]
      : [];
  });
}

const waitingTask = {
  state: "scheduled",
  signalWait: { name: "account-approval", deadlineAt: "2026-08-17T03:00:00.000Z" },
  humanWait: null,
  wait: null,
  blockedReason: "prerequisite_pending",
  prerequisiteTaskIds: ["parent-task"],
} as unknown as DashboardTaskRow;

const hex = (value: string) =>
  [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
const luminance = (rgb: readonly number[]) => {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (foreground: readonly number[], background: readonly number[]) => {
  const [high, low] = [luminance(foreground), luminance(background)].toSorted((a, b) => b - a) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
};
const media = (matches: boolean) => {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  return { query, listeners };
};

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
});

afterEach(() => vi.unstubAllGlobals());

describe("status labels are static text", () => {
  it("gives each label its meaning as text, without a live region", async () => {
    const { StatusBadge, StatusLabel } = await import("./status-badge.js");
    const { CancelRequestedBadge, TaskBlockedBy, TaskWaitBadge } =
      await import("./components/task-list.js");
    const rendered = [
      [render(StatusBadge, { state: "failed" }), "Status: failed"],
      [
        render(StatusLabel, {
          state: "failed",
          label: "Status: failed. Payment declined",
          children: "Payment declined",
        }),
        "Status: failed. Payment declined",
      ],
      [render(TaskWaitBadge, { task: waitingTask }), "Waiting for signal account-approval"],
      [render(TaskBlockedBy, { task: waitingTask }), "Task blocked: prerequisite pending"],
      [
        render(CancelRequestedBadge, {
          cancellation: {
            reason: "operator",
            requestedAt: "2026-08-16T03:00:00.000Z",
            requestedBy: "ops@example.com",
          } as never,
        }),
        "Cancellation requested.",
      ],
    ] as const;

    for (const [html, label] of rendered) {
      expect(html).toContain(`>${label}`);
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain("aria-live");
      // A badge is a generic element, which cannot have an accessible name.
      expect(html).not.toContain("aria-label=");
    }
  });

  it("keeps the label with details focusable, so keyboard and touch still open them", async () => {
    const { StatusLabel } = await import("./status-badge.js");
    const html = render(StatusLabel, { state: "failed", children: "Payment declined" });
    expect(html).toContain('tabindex="0"');
  });

  it("keeps live regions only where one element reports one change", () => {
    // Each entry is a deliberate notification: a failed refresh in the shell, the connection
    // state in the header, the result of a copy, a filter editor that loads its values, the
    // schedule drawer that loads recent tasks, the chart tooltip that reads the bucket the arrow
    // keys select, and the one region of a table page that says its new row count after a control
    // changed the request. A label that repeats for each row must never be a live region.
    const liveRegions = sourceFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const count = source.match(/role="status"|aria-live=/g)?.length ?? 0;
      return count === 0 ? [] : [[file.pathname.slice(sourceRoot.pathname.length), count]];
    });
    expect(Object.fromEntries(liveRegions)).toEqual({
      "charts/chart-tooltip.tsx": 2,
      "components/task-detail-overview.tsx": 2,
      "components/task-filter-bar.tsx": 1,
      "pages/schedules.tsx": 1,
      "pending-results.tsx": 2,
      "shell/AppShell.tsx": 1,
      "shell/HeaderControls.tsx": 1,
    });
  });
});

describe("table values with an explanation", () => {
  it("states the explanation as text and opens it by keyboard and touch", async () => {
    const { ExplainedValue } = await import("./components/explained-value.js");
    const html = render(ExplainedValue, {
      explanation: "At most 8 tasks may run at once.",
      children: "8 / 8",
    });
    expect(html).toMatch(/<p[^>]*tabindex="0"/);
    expect(html).toContain(">8 / 8<");
    expect(html).toContain(">. At most 8 tasks may run at once.<");
    expect(html).not.toContain("aria-label=");
  });

  it("puts no aria-label on a paragraph in the queue, budget, and system tables", () => {
    const named = ["pages/queues.tsx", "budgets-table.tsx", "charts/system.tsx"].filter((file) =>
      /<Text\b[^>]*aria-label=/.test(readFileSync(new URL(file, sourceRoot), "utf8")),
    );
    expect(named).toEqual([]);
  });
});

describe("task and event drawers", () => {
  it("has one title heading, and the resize separator is outside it", async () => {
    vi.stubGlobal("window", {
      innerWidth: 1600,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const { ResizableTaskDrawer } = await import("./components/resizable-task-drawer.js");
    const { taskDrawerModelessProps } = await import("./task-drawer.js");
    const html = render(ResizableTaskDrawer, {
      ...taskDrawerModelessProps,
      opened: true,
      onClose: () => undefined,
      title: "Task details",
      withinPortal: false,
      position: "right",
      children: "Detail",
    });

    expect(html.match(/<h2\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h2[^>]*>Task details<\/h2><span[^>]*role="separator"/);
    expect(html).toContain('aria-valuemin="');
    expect(html).toContain('aria-valuemax="');
    expect(html).toContain('aria-valuenow="');
  });

  it("passes plain title text, so Mantine renders the only heading", () => {
    const nested = ["pages/task-detail.tsx", "shell/AppShell.tsx"].filter((file) =>
      readFileSync(new URL(file, sourceRoot), "utf8").includes('component="h2"'),
    );
    expect(nested).toEqual([]);
  });
});

describe("status text contrast", () => {
  // The palettes that the dashboard gives Mantine, not Mantine's defaults.
  const { colors } = mergeMantineTheme(DEFAULT_THEME, dashboardMantineTheme);
  // The body, a striped row, and a hovered row of a Mantine table, in each color scheme.
  const backgrounds = {
    light: [dashboardPageColor.light, colors.gray[0], colors.gray[1]],
    dark: [dashboardPageColor.dark, colors.dark[6], colors.dark[5]],
  };

  it("gives warning and danger notes 4.5:1 in the light and dark themes", async () => {
    const { statusTextColors } = await import("./status-colors.js");
    const low = Object.entries(statusTextColors).flatMap(([tone, schemes]) =>
      (["light", "dark"] as const).flatMap((scheme) =>
        backgrounds[scheme]
          .filter((background) => contrast(hex(schemes[scheme]), hex(background)) < 4.5)
          .map((background) => `${tone} ${scheme} on ${background}`),
      ),
    );
    expect(low).toEqual([]);
  });

  it("gives each status label 4.5:1 in the light and dark themes", async () => {
    const { theme } = await import("./components/graphical/theme.js");
    const { resolveColor } = await import("./components/graphical/lib/theme-model.js");
    const styles = readFileSync(new URL("styles.css", sourceRoot), "utf8");
    // The stylesheet rule that the computation below models: the state hue is only on the dot,
    // and the label is `neutral-10` text on a `neutral-3` chip.
    expect(styles).toContain(`.mantine-Badge-root[data-variant="dot"] {
  background: var(--workhorse-neutral-3);
  border-color: transparent;
  color: var(--workhorse-neutral-10);`);

    const low = (["light", "dark"] as const).flatMap((mode) => {
      const text = hex(resolveColor(theme.theme, mode, "neutral-10"));
      const chip = hex(resolveColor(theme.theme, mode, "neutral-3"));
      const ratio = contrast(text, chip);
      return ratio < 4.5 ? [`${mode} ${ratio.toFixed(2)}`] : [];
    });
    expect(low).toEqual([]);
  });

  it("keeps the tooltip text color for a failure detail in the status tooltip", async () => {
    const { TaskStatusDetail } = await import("./components/task-list.js");
    const html = render(TaskStatusDetail, {
      task: { state: "failed", errorMessage: "Payment declined" } as DashboardTaskRow,
    });
    expect(html).toContain(">Payment declined<");
    // A page text color has low contrast on the inverted tooltip background.
    expect(html).not.toContain("--text-color");
    expect(html).not.toContain("--workhorse-color");
  });

  it("uses no low-contrast palette shade for status text", () => {
    const lowContrast = sourceFiles(sourceRoot)
      .filter((file) => /c=\{?[^}\n]*"yellow\.\d"/.test(readFileSync(file, "utf8")))
      .map((file) => file.pathname);
    expect(lowContrast).toEqual([]);
  });
});

describe("theme preference", () => {
  it("uses System when nothing is stored, and keeps a stored choice", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    const { readStoredThemePreference } = await import("./theme.js");
    expect(readStoredThemePreference()).toBe("system");
    for (const choice of ["light", "dark", "system"]) {
      stored.set("workhorse-theme-scheme", choice);
      expect(readStoredThemePreference()).toBe(choice);
    }
    stored.set("workhorse-theme-scheme", "sepia");
    expect(readStoredThemePreference()).toBe("system");
  });

  it("offers System next to Light and Dark, and uses it before a choice", async () => {
    const setItem = vi.fn<(key: string, value: string) => void>();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    // The browser prefers dark, and the button still names the preference, not the result.
    vi.stubGlobal("window", { matchMedia: () => media(true).query });
    const { WorkhorseThemeProvider } = await import("./theme.js");
    const { AppearanceToggle, appearanceOptions } = await import("./shell/HeaderControls.js");
    const html = renderToStaticMarkup(
      createElement(WorkhorseThemeProvider, null, createElement(AppearanceToggle)),
    );
    expect(appearanceOptions.map((option) => option.label)).toEqual(["Light", "Dark", "System"]);
    expect(html).toContain('aria-label="Appearance: System. Change to Light"');
    expect(html).not.toContain("aria-haspopup");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("names a stored choice on the appearance button", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "workhorse-theme-scheme" ? "dark" : null),
      setItem: () => undefined,
    });
    vi.stubGlobal("window", { matchMedia: () => media(false).query });
    const { WorkhorseThemeProvider } = await import("./theme.js");
    const { AppearanceToggle } = await import("./shell/HeaderControls.js");
    const html = renderToStaticMarkup(
      createElement(WorkhorseThemeProvider, null, createElement(AppearanceToggle)),
    );
    expect(html).toContain('aria-label="Appearance: Dark. Change to System"');
  });

  it("follows each browser color scheme change until it stops", async () => {
    const { query, listeners } = media(false);
    vi.stubGlobal("window", { matchMedia: () => query });
    const { followSystemScheme } = await import("./theme.js");
    const seen: string[] = [];
    const stop = followSystemScheme((scheme) => seen.push(scheme));

    query.matches = true;
    for (const listener of listeners) listener();
    query.matches = false;
    for (const listener of listeners) listener();
    stop();

    expect(seen).toEqual(["dark", "light"]);
    expect(listeners.size).toBe(0);
  });
});
