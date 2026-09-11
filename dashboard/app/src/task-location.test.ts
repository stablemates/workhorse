import { taskFilterHref } from "./task-location.js";
import { describe, expect, it } from "vitest";
import {
  parseTaskLocation,
  taskDetailNavigation,
  taskListingKey,
  taskLocationHref,
} from "./task-location.js";

describe("task location state", () => {
  it("round-trips precise cursor navigation and ignores malformed cursors", () => {
    const state = {
      ...parseTaskLocation(""),
      cursor: {
        id: "01890abc-0000-7000-8000-000000000001",
        updatedAt: "2026-09-08T01:02:03.123456Z",
        priority: 50,
      },
      direction: "previous" as const,
    };
    const restored = parseTaskLocation(taskLocationHref(state).split("?")[1]!);
    expect(restored).toEqual(state);
    expect(taskListingKey(restored)).not.toBe(taskListingKey(parseTaskLocation("")));
    expect(parseTaskLocation("?cursor=null").cursor).toBeUndefined();
    expect(parseTaskLocation("?cursor=broken").cursor).toBeUndefined();
  });

  it("round-trips shareable task filters and omits defaults", () => {
    const state = parseTaskLocation(
      "?filter=retried&tags=billing,weekly&q=invoice*&queue=orders&worker=worker-1&type=order.process&sort=priority&page=3&per=100&period=7d&group=task",
    );
    expect(state).toEqual({
      filter: "retried",
      tags: ["billing", "weekly"],
      search: "invoice*",
      queue: "orders",
      worker: "worker-1",
      taskType: "order.process",
      sort: "priority",
      page: 3,
      pageSize: 100,
      period: "7d",
      group: "task",
      taskId: null,
    });
    expect(parseTaskLocation(taskLocationHref(state).split("?")[1] ?? "")).toEqual(state);
    expect(
      taskLocationHref({
        filter: "all",
        tags: [],
        search: null,
        queue: null,
        worker: null,
        taskType: null,
        sort: "updated",
        page: 1,
        pageSize: 50,
        period: "1h",
        group: "task",
        taskId: null,
      }),
    ).toBe("/tasks");
  });

  it("silently falls back for invalid URL values and accepts remembered chart defaults", () => {
    expect(
      parseTaskLocation("?filter=unknown&sort=oldest&page=-2&per=10&period=bad&group=bad", {
        period: "24h",
        group: "worker",
      }),
    ).toMatchObject({
      filter: "all",
      sort: "updated",
      page: 1,
      pageSize: 50,
      period: "24h",
      group: "worker",
    });
  });

  it("ignores retired priority filters in old task URLs", () => {
    const state = parseTaskLocation("?priority=75");
    expect(taskLocationHref(state)).toBe("/tasks");
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

  it("round-trips the blocked task filter used by the sidebar", () => {
    const state = parseTaskLocation("?filter=blocked");
    expect(state.filter).toBe("blocked");
    expect(taskLocationHref(state)).toBe("/tasks?filter=blocked");
  });

  it("round-trips the waiting task filter used by the sidebar", () => {
    const state = parseTaskLocation("?filter=waiting");
    expect(state.filter).toBe("waiting");
    expect(taskLocationHref(state)).toBe("/tasks?filter=waiting");
  });

  it("carries the open task detail in the URL beside the listing parameters", () => {
    // A deep link has to restore the same list and the same open task, so the drawer id is
    // parsed alongside the filters rather than instead of them.
    const state = parseTaskLocation("?filter=running&queue=orders&page=2&task=task-42");
    expect(state.taskId).toBe("task-42");
    expect(state.filter).toBe("running");
    expect(state.queue).toBe("orders");
    expect(state.page).toBe(2);
    expect(parseTaskLocation(taskLocationHref(state).split("?")[1] ?? "")).toEqual(state);
  });

  it("drops only the task parameter when the drawer closes", () => {
    // Closing the drawer is not a change of what the operator is looking at, so every filter,
    // the page, and the chart settings survive it untouched.
    const opened = parseTaskLocation(
      "?filter=running&tags=billing&per=100&group=queue&task=task-42",
    );
    expect(taskLocationHref({ ...opened, taskId: null })).toBe(
      "/tasks?filter=running&tags=billing&per=100&group=queue",
    );
  });

  it("treats a blank or oversized task id as no open drawer", () => {
    expect(parseTaskLocation("?task=").taskId).toBe(null);
    expect(parseTaskLocation("?task=%20%20").taskId).toBe(null);
    expect(parseTaskLocation(`?task=${"x".repeat(201)}`).taskId).toBe(null);
    expect(parseTaskLocation(`?task=${"x".repeat(200)}`).taskId).toBe("x".repeat(200));
  });

  it("pushes only when the drawer opens, so Back does not walk every task glanced at", () => {
    expect(taskDetailNavigation(null, "task-a")).toBe("push");
    // Swapping tasks happens inside a panel that is already open.
    expect(taskDetailNavigation("task-a", "task-b")).toBe("replace");
    // Closing is a dismissal; Forward must not resurrect the panel.
    expect(taskDetailNavigation("task-a", null)).toBe("replace");
    expect(taskDetailNavigation(null, null)).toBe("replace");
  });

  it("keeps the task list request unchanged while the drawer opens, switches, and closes", () => {
    // The list behind a modeless drawer must not refetch or flash a loader when the operator
    // clicks from one task to the next, so the drawer id is not part of the listing request.
    const closed = parseTaskLocation("?filter=running&queue=orders&tags=billing&page=2&per=100");
    const opened = parseTaskLocation(
      "?filter=running&queue=orders&tags=billing&page=2&per=100&task=task-a",
    );
    expect(taskListingKey(opened)).toBe(taskListingKey(closed));
    expect(taskListingKey({ ...opened, taskId: "task-b" })).toBe(taskListingKey(closed));
    // Nor do the activity chart controls, which are served by a separate request.
    expect(taskListingKey({ ...opened, period: "7d", group: "worker" })).toBe(
      taskListingKey(closed),
    );

    // Anything that really is a different list still is one.
    expect(taskListingKey({ ...closed, page: 3 })).not.toBe(taskListingKey(closed));
    expect(taskListingKey({ ...closed, filter: "completed" })).not.toBe(taskListingKey(closed));
    expect(taskListingKey({ ...closed, tags: ["billing", "weekly"] })).not.toBe(
      taskListingKey(closed),
    );
    expect(taskListingKey({ ...closed, search: "invoice" })).not.toBe(taskListingKey(closed));
    expect(taskListingKey({ ...closed, sort: "priority" })).not.toBe(taskListingKey(closed));
  });
});

it("clears sidebar pagination and drawer selection while preserving useful filters", () => {
  const state = {
    ...parseTaskLocation("?queue=billing&page=3&task=task-1"),
    cursor: { id: "task-1", updatedAt: "2026-09-10T12:00:00Z", priority: 1 },
    direction: "previous" as const,
  };
  const selected = parseTaskLocation(taskFilterHref(state, "running").split("?")[1] ?? "");
  expect(selected).toMatchObject({ queue: "billing", filter: "running", page: 1, taskId: null });
  expect(selected.cursor).toBeUndefined();
  expect(selected.direction).toBeUndefined();
  expect(state.page).toBe(3);
  expect(state.direction).toBe("previous");
});
