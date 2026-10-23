import { DEFAULT_THEME, MantineProvider } from "@mantine/core";
import { readdirSync, readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardTaskRow } from "@stablemates/workhorse-dashboard-server/wire";

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
const toHsl = ([red, green, blue]: readonly number[]) => {
  const [r, g, b] = [red!, green!, blue!].map((channel) => channel / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness] as const;
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue =
    max === r
      ? (g - b) / delta + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return [hue * 60, saturation, lightness] as const;
};
const fromHsl = ([hue, saturation, lightness]: readonly [number, number, number]) => {
  const k = (n: number) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n: number) => lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((channel) => Math.round(channel * 255));
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
    // Each entry is a deliberate notification: the connection state, a failed refresh, and the
    // result of a copy. A label that repeats for each row must never be a live region.
    const liveRegions = sourceFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const count = source.match(/role="status"|aria-live=/g)?.length ?? 0;
      return count === 0 ? [] : [[file.pathname.slice(sourceRoot.pathname.length), count]];
    });
    expect(Object.fromEntries(liveRegions)).toEqual({
      "components/task-detail-overview.tsx": 2,
      "shell/AppShell.tsx": 2,
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
  const { colors } = DEFAULT_THEME;
  // The body, a striped row, and a hovered row of a Mantine table, in each color scheme.
  const backgrounds = {
    light: ["#ffffff", colors.gray[0], colors.gray[1]],
    dark: [colors.dark[7], colors.dark[6], colors.dark[5]],
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

  it("gives each status badge 4.5:1 in the light and dark themes", async () => {
    const { statusColor, taskStatusColors } = await import("./status-colors.js");
    const styles = readFileSync(new URL("styles.css", sourceRoot), "utf8");
    // The stylesheet rules that the computation below models.
    expect(styles).toContain("color: hsl(from var(--badge-color) h s 25%);");
    expect(styles).toContain("background: hsl(from var(--badge-color) h s 27%);");
    expect(styles).toContain("color: color-mix(in srgb, var(--badge-color) 20%, white);");

    const badgeColors = new Set<string>([
      ...Object.values(taskStatusColors),
      ...["failed", "succeeded", "blocked", "canceled", "unknown"].map(statusColor),
    ]);
    const low: string[] = [];
    for (const name of badgeColors) {
      const palette = colors[name]!;
      // Mantine's light badge has shade 9 text on shade 1; the stylesheet sets 25% lightness.
      const [hue, saturation] = toHsl(hex(palette[9]));
      const light = contrast(fromHsl([hue, saturation, 0.25]), hex(palette[1]));
      // Mantine's dark badge text is shade 0; the stylesheet derives both colors from it.
      const base = hex(palette[0]);
      const [darkHue, darkSaturation] = toHsl(base);
      const darkBackground = fromHsl([darkHue, darkSaturation, 0.27]);
      const darkText = base.map((channel) => Math.round(channel * 0.2 + 255 * 0.8));
      const dark = contrast(darkText, darkBackground);
      if (light < 4.5) low.push(`${name} light ${light.toFixed(2)}`);
      if (dark < 4.5) low.push(`${name} dark ${dark.toFixed(2)}`);
    }
    expect(badgeColors.size).toBeGreaterThan(5);
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

  it("offers System next to Light and Dark, and selects it before a choice", async () => {
    const setItem = vi.fn<(key: string, value: string) => void>();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    vi.stubGlobal("window", { matchMedia: () => media(true).query });
    const { ThemeSchemeSwitch, WorkhorseThemeProvider } = await import("./theme.js");
    const html = renderToStaticMarkup(
      createElement(WorkhorseThemeProvider, null, createElement(ThemeSchemeSwitch)),
    );
    for (const label of ["Light", "Dark", "System"]) expect(html).toContain(`>${label}<`);
    expect(html).toMatch(/value="system"[^>]*checked|checked[^>]*value="system"/);
    expect(setItem).not.toHaveBeenCalled();
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
