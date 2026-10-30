import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivityChartModel } from "./presentation-policy.js";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const activitySource = readFileSync(new URL("./charts/activity.tsx", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("./core.tsx", import.meta.url), "utf8");

const model: ActivityChartModel = {
  series: [{ id: "series-0", label: "billing", overflow: false }],
  buckets: [{ bucketStart: "2026-10-07T12:00:00.000Z", values: { "series-0": 3 } }],
};
const query = {
  filter: "all",
  period: "1h",
  groupBy: "queue",
  tags: [],
  queue: null,
  worker: null,
} as const;

function answer(key: string, overrides: Partial<{ period: "1h" | "24h"; groupBy: "queue" }> = {}) {
  return {
    key,
    period: "1h",
    groupBy: "queue",
    model,
    receivedAt: "2026-10-07T12:00:00.000Z",
    ...overrides,
  } as const;
}

describe("activity chart state", () => {
  it("keeps the previous bars on screen as pending while another query loads", async () => {
    const { activityQueryKey, activityView } = await import("./charts/activity.js");
    const before = activityQueryKey(query);
    const after = activityQueryKey({ ...query, period: "24h" });
    expect(after).not.toBe(before);
    const shown = answer(before);
    // A click on another period does not replace the chart with a loader.
    expect(activityView(after, shown, null)).toEqual({ kind: "ready", shown, pending: true });
    expect(activityView(before, shown, null)).toEqual({ kind: "ready", shown, pending: false });
  });

  it("shows loading only before the first answer", async () => {
    const { activityQueryKey, activityView } = await import("./charts/activity.js");
    expect(activityView(activityQueryKey(query), null, null)).toEqual({ kind: "loading" });
  });

  it("reports a failed load as an error, not an empty chart or old bars", async () => {
    const { activityQueryKey, activityView } = await import("./charts/activity.js");
    const key = activityQueryKey(query);
    expect(activityView(key, null, { key })).toEqual({ kind: "error" });
    // The bars of the previous query do not answer the query that failed.
    const other = answer(activityQueryKey({ ...query, groupBy: "status" }));
    expect(activityView(key, other, { key })).toEqual({ kind: "error" });
  });

  it("keeps the same query's bars as stale when a refresh fails", async () => {
    const { activityQueryKey, activityView } = await import("./charts/activity.js");
    const key = activityQueryKey(query);
    const shown = answer(key);
    expect(activityView(key, shown, { key })).toEqual({ kind: "stale", shown });
    // A failure for a query the controls no longer name says nothing about the current one.
    expect(activityView(key, shown, { key: "other" })).toEqual({
      kind: "ready",
      shown,
      pending: false,
    });
  });

  it("dims the previous chart in place instead of a loader while the new query loads", async () => {
    const { ActivityBody, activityQueryKey } = await import("./charts/activity.js");
    const render = (view: Parameters<typeof ActivityBody>[0]["view"]) =>
      renderToStaticMarkup(
        createElement(MantineProvider, null, createElement(ActivityBody, { view })),
      );
    const shown = answer(activityQueryKey(query));
    const pending = render({ kind: "ready", shown, pending: true });
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain('data-pending="true"');
    expect(pending).toContain('aria-label="Task activity by queue over the last 1h"');
    expect(pending).not.toContain("Loading activity");
    const settled = render({ kind: "ready", shown, pending: false });
    expect(settled).not.toContain("aria-busy");
    expect(settled).not.toContain("data-pending");
    expect(render({ kind: "loading" })).toContain("Loading activity");
  });

  it("announces errors and stale bars with a retry button", async () => {
    const { ActivityNotice, activityQueryKey } = await import("./charts/activity.js");
    const render = (view: Parameters<typeof ActivityNotice>[0]["view"]) =>
      renderToStaticMarkup(
        createElement(
          MantineProvider,
          null,
          createElement(ActivityNotice, { view, retry: () => undefined }),
        ),
      );
    const shown = answer(activityQueryKey(query));
    const error = render({ kind: "error" });
    expect(error).toContain('role="alert"');
    expect(error).toContain("could not load activity");
    expect(error).toContain(">Retry<");
    const stale = render({ kind: "stale", shown });
    expect(stale).toContain("could not refresh activity");
    expect(stale).toContain(">Retry<");
    expect(render({ kind: "ready", shown, pending: false })).not.toContain('role="alert"');
    expect(render({ kind: "ready", shown, pending: true })).not.toContain('role="alert"');
    expect(render({ kind: "loading" })).not.toContain('role="alert"');
  });
});

describe("activity chart transitions", () => {
  it("keys each series by grouping and label, so a series keeps its bars across answers", async () => {
    const { activitySeriesKey } = await import("./charts/activity.js");
    expect(activitySeriesKey("task", { label: "send-email", overflow: false })).toBe(
      "task:send-email",
    );
    // Recharts reads a dot as a path, so the key encodes it.
    expect(activitySeriesKey("task", { label: "billing.charge", overflow: false })).toBe(
      "task:billing%2Echarge",
    );
    // The overflow series never collides with a group that a user called "Other".
    expect(activitySeriesKey("queue", { label: "Other", overflow: true })).not.toBe(
      activitySeriesKey("queue", { label: "Other", overflow: false }),
    );
    expect(activitySeriesKey("queue", { label: "x", overflow: false })).not.toBe(
      activitySeriesKey("worker", { label: "x", overflow: false }),
    );
  });

  it("keeps the color of a series when other series join or leave", async () => {
    const { rememberSeriesSlots } = await import("./charts/activity.js");
    const first = rememberSeriesSlots(new Map(), ["task:a", "task:b", "task:c"]);
    expect([...first]).toEqual([
      ["task:a", 0],
      ["task:b", 1],
      ["task:c", 2],
    ]);
    // In a shorter period, "a" has no tasks. "b" and "c" keep their colors.
    const second = rememberSeriesSlots(first, ["task:b", "task:c"]);
    expect(second.get("task:b")).toBe(1);
    expect(second.get("task:c")).toBe(2);
    // A new series takes the lowest free slot, not the slot of a series on screen.
    const third = rememberSeriesSlots(second, ["task:b", "task:c", "task:d"]);
    expect(third.get("task:d")).toBe(0);
    // When "a" comes back, its old slot is taken, so it takes the next free one.
    const fourth = rememberSeriesSlots(third, ["task:a", "task:b", "task:c", "task:d"]);
    expect(
      new Set(["task:a", "task:b", "task:c", "task:d"].map((key) => fourth.get(key))).size,
    ).toBe(4);
    // Nothing new to remember returns the same map, so the chart does not render again.
    expect(rememberSeriesSlots(fourth, ["task:b", "task:c"])).toBe(fourth);
  });

  it("lists the series that left, which fade out while their bars shrink", async () => {
    const { leavingActivitySeries } = await import("./charts/activity.js");
    expect(
      leavingActivitySeries(
        [presented("a"), presented("b"), presented("c")],
        [presented("b"), presented("d")],
      ),
    ).toEqual([presented("a"), presented("c")]);
    expect(leavingActivitySeries([presented("a")], [presented("a")])).toEqual([]);
  });

  it("animates both charts from their previous values, matched by bucket", () => {
    for (const source of [activitySource, coreSource]) {
      expect(source).toContain("useChartSeriesAnimation()");
      // A bar moves to the bucket with the same start, not to the bar at the same index.
      expect(source).toMatch(/animationMatchBy[:=]/);
      expect(source).toContain("matchByDataKey(");
    }
    const motion = readFileSync(new URL("./charts/chart-motion.ts", import.meta.url), "utf8");
    expect(motion).toContain("isAnimationActive: painted && !reducedMotion");
    const css = readFileSync(new URL("./charts/chart-motion.css", import.meta.url), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    // Recharts copies the series class to each bar, and it mounts new bars for each animation.
    // A rule on the bare class would fade every bar in again on each refresh.
    expect(css).not.toMatch(/(^|[\s,{])\.chart-series[\s,{]/m);
    expect(css).toContain(".recharts-bar.chart-series");
  });
});

function presented(id: string) {
  return { id, label: id, color: "red", total: 1 };
}

function bucket(values: Record<string, number>) {
  return { bucketStart: "2026-10-07T12:00:00.000Z", values };
}

describe("activity chart series", () => {
  it("colors task states by meaning and lists the top of the stack first", async () => {
    const { presentActivitySeries } = await import("./charts/activity.js");
    const labels = ["active", "blocked", "canceled", "failed", "ready", "scheduled", "succeeded"];
    const statusModel: ActivityChartModel = {
      series: labels.map((label, index) => ({ id: `series-${index}`, label, overflow: false })),
      buckets: [bucket(Object.fromEntries(labels.map((_, index) => [`series-${index}`, 1])))],
    };
    const series = presentActivitySeries(statusModel, "status");
    expect(series.map(({ label }) => label)).toEqual([
      "blocked",
      "canceled",
      "failed",
      "scheduled",
      "active",
      "ready",
      "succeeded",
    ]);
    expect(series.find(({ label }) => label === "succeeded")?.color).toBe(
      "var(--workhorse-chart-succeeded)",
    );
    expect(series.find(({ label }) => label === "failed")?.color).toBe(
      "var(--workhorse-chart-failed)",
    );
  });

  it("gives groups palette slots by label and a gray overflow series", async () => {
    const { presentActivitySeries } = await import("./charts/activity.js");
    const groupModel: ActivityChartModel = {
      series: [
        { id: "series-0", label: "billing", overflow: false },
        { id: "series-1", label: "emails", overflow: false },
        { id: "series-2", label: "Other", overflow: true },
      ],
      buckets: [
        bucket({ "series-0": 2, "series-1": 5, "series-2": 1 }),
        bucket({ "series-0": 3, "series-1": 0, "series-2": 4 }),
      ],
    };
    expect(presentActivitySeries(groupModel, "queue")).toEqual([
      { id: "queue:billing", label: "billing", color: "var(--workhorse-series-1)", total: 5 },
      { id: "queue:emails", label: "emails", color: "var(--workhorse-series-2)", total: 5 },
      { id: "queue#other", label: "Other", color: "var(--workhorse-series-other)", total: 5 },
    ]);
    // A remembered slot wins over the sorted order.
    const slots = new Map([
      ["queue:billing", 3],
      ["queue:emails", 0],
    ]);
    expect(presentActivitySeries(groupModel, "queue", slots).map(({ color }) => color)).toEqual([
      "var(--workhorse-series-4)",
      "var(--workhorse-series-1)",
      "var(--workhorse-series-other)",
    ]);
  });

  it("rounds only the highest segment that has a count", async () => {
    const { isTopOfStack } = await import("./charts/chart-tooltip.js");
    const stack = ["a", "b", "c"];
    const row = { a: 2, b: 3, c: 0 };
    expect(isTopOfStack(row, "b", stack)).toBe(true);
    expect(isTopOfStack(row, "a", stack)).toBe(false);
  });

  it("lists only series with a count in the tooltip, largest first, with the total", async () => {
    const { ChartTooltip } = await import("./charts/chart-tooltip.js");
    const html = renderToStaticMarkup(
      createElement(ChartTooltip, {
        title: "12:00",
        values: new Map<string, unknown>([
          ["a", 2],
          ["b", 0],
          ["c", 7],
        ]),
        series: [
          { id: "a", label: "alpha", color: "red" },
          { id: "b", label: "beta", color: "blue" },
          { id: "c", label: "gamma", color: "green" },
        ],
        unit: { one: "task", other: "tasks" },
      }),
    );
    expect(html).toContain("9 tasks");
    expect(html).not.toContain("beta");
    expect(html.indexOf("gamma")).toBeLessThan(html.indexOf("alpha"));
  });

  it("announces the selected bucket through one polite live region", async () => {
    const { ChartTooltip } = await import("./charts/chart-tooltip.js");
    const html = renderToStaticMarkup(
      createElement(ChartTooltip, {
        title: "12:05",
        values: new Map<string, unknown>([
          ["a", 1],
          ["b", 0],
        ]),
        series: [
          { id: "a", label: "alpha", color: "red" },
          { id: "b", label: "beta", color: "blue" },
        ],
        unit: { one: "task", other: "tasks" },
      }),
    );
    // One region reads the time, the total, and each series with a count, as one message.
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(html).toMatch(
      /^<div class="chart-tooltip" role="status" aria-live="polite" aria-atomic="true">/,
    );
    const spoken = html.replace(/<span[^>]*aria-hidden="true"[^>]*><\/span>/g, "");
    expect(
      spoken
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe("12:05 1 task alpha 1");
  });

  it("gives every chart tooltip the same live region", () => {
    // Both charts render `ChartTooltip` as the Recharts content, and no other tooltip content.
    for (const source of [activitySource, coreSource]) {
      expect(source).toContain("<ChartTooltip");
      expect(source).not.toMatch(/role="status"|aria-live/);
    }
  });
});
