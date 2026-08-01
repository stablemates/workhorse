import { describe, expect, it } from "vitest";
import { parseTaskLocation, taskLocationHref } from "./task-location.js";

describe("task location state", () => {
  it("round-trips shareable task filters and omits defaults", () => {
    const state = parseTaskLocation(
      "?filter=retried&tags=billing,weekly&q=invoice*&queue=orders&worker=worker-1&type=order.process&page=3&per=100&period=7d&group=task",
    );
    expect(state).toEqual({
      filter: "retried",
      tags: ["billing", "weekly"],
      search: "invoice*",
      queue: "orders",
      worker: "worker-1",
      jobType: "order.process",
      page: 3,
      pageSize: 100,
      period: "7d",
      group: "task",
    });
    expect(parseTaskLocation(taskLocationHref(state).split("?")[1] ?? "")).toEqual(state);
    expect(
      taskLocationHref({
        filter: "all",
        tags: [],
        search: null,
        queue: null,
        worker: null,
        jobType: null,
        page: 1,
        pageSize: 50,
        period: "1h",
        group: "queue",
      }),
    ).toBe("/tasks");
  });

  it("silently falls back for invalid URL values and accepts remembered chart defaults", () => {
    expect(
      parseTaskLocation("?filter=unknown&page=-2&per=10&period=bad&group=bad", {
        period: "24h",
        group: "worker",
      }),
    ).toMatchObject({ filter: "all", page: 1, pageSize: 50, period: "24h", group: "worker" });
  });

  it("round-trips status activity grouping", () => {
    const state = parseTaskLocation("?group=status");
    expect(state.group).toBe("status");
    expect(taskLocationHref(state)).toBe("/tasks?group=status");
  });

  it("round-trips the canceled task filter used by the sidebar", () => {
    const state = parseTaskLocation("?filter=canceled");
    expect(state.filter).toBe("canceled");
    expect(taskLocationHref(state)).toBe("/tasks?filter=canceled");
  });
});
