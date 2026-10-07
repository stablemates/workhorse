import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivityChartModel } from "./presentation-policy.js";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

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

describe("activity chart state", () => {
  it("shows loading instead of another query's bars", async () => {
    const { activityQueryKey, activityView } = await import("./charts/activity.js");
    const before = activityQueryKey(query);
    const after = activityQueryKey({ ...query, period: "24h" });
    expect(after).not.toBe(before);
    const success = { key: before, model, receivedAt: "2026-10-07T12:00:00.000Z" };
    expect(activityView(after, success, null)).toEqual({ kind: "loading" });
    expect(activityView(before, success, null)).toEqual({ kind: "ready", model });
  });

  it("reports a failed first load as an error, not an empty chart", async () => {
    const { activityQueryKey, activityView } = await import("./charts/activity.js");
    const key = activityQueryKey(query);
    expect(activityView(key, null, { key })).toEqual({ kind: "error" });
  });

  it("keeps the same query's bars as stale when a refresh fails", async () => {
    const { activityQueryKey, activityView } = await import("./charts/activity.js");
    const key = activityQueryKey(query);
    const success = { key, model, receivedAt: "2026-10-07T12:00:00.000Z" };
    expect(activityView(key, success, { key })).toEqual({
      kind: "stale",
      model,
      receivedAt: "2026-10-07T12:00:00.000Z",
    });
    // A failure for a query the controls no longer name says nothing about the current one.
    expect(activityView(key, success, { key: "other" })).toEqual({ kind: "ready", model });
  });

  it("announces errors and stale bars with a retry button", async () => {
    const { ActivityNotice } = await import("./charts/activity.js");
    const render = (view: Parameters<typeof ActivityNotice>[0]["view"]) =>
      renderToStaticMarkup(
        createElement(
          MantineProvider,
          null,
          createElement(ActivityNotice, { view, retry: () => undefined }),
        ),
      );
    const error = render({ kind: "error" });
    expect(error).toContain('role="alert"');
    expect(error).toContain("could not load activity");
    expect(error).toContain(">Retry<");
    const stale = render({ kind: "stale", model, receivedAt: "2026-10-07T12:00:00.000Z" });
    expect(stale).toContain("could not refresh activity");
    expect(stale).toContain(">Retry<");
    expect(render({ kind: "ready", model })).not.toContain('role="alert"');
    expect(render({ kind: "loading" })).not.toContain('role="alert"');
  });
});
