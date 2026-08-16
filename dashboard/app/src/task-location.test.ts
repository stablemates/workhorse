import { describe, expect, it } from "vitest";
import {
  parseTaskLocation,
  taskDetailNavigation,
  taskListingKey,
  taskLocationHref,
} from "./task-location.js";

describe("task location state", () => {
  it("round-trips shareable task filters and omits defaults", () => {
    const state = parseTaskLocation(
      "?filter=retried&tags=billing,weekly&q=invoice*&queue=orders&worker=worker-1&type=order.process&priority=75&sort=priority&page=3&per=100&period=7d&group=task",
    );
    expect(state).toEqual({
      filter: "retried",
      tags: ["billing", "weekly"],
      search: "invoice*",
      queue: "orders",
      worker: "worker-1",
      jobType: "order.process",
      priority: 75,
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
        jobType: null,
        priority: null,
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
      parseTaskLocation(
        "?filter=unknown&priority=101&sort=oldest&page=-2&per=10&period=bad&group=bad",
        {
          period: "24h",
          group: "worker",
        },
      ),
    ).toMatchObject({
      filter: "all",
      priority: null,
      sort: "updated",
      page: 1,
      pageSize: 50,
      period: "24h",
      group: "worker",
    });
  });

  it("accepts default priority as an explicit filter and rejects fractional values", () => {
    expect(parseTaskLocation("?priority=0").priority).toBe(0);
    expect(parseTaskLocation("?priority=1.5").priority).toBeNull();
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

  it("carries the open task detail in the URL beside the listing parameters", () => {
    // A deep link has to restore the same list and the same open task, so the drawer id is
    // parsed alongside the filters rather than instead of them.
    const state = parseTaskLocation("?filter=running&queue=orders&page=2&task=job-42");
    expect(state.taskId).toBe("job-42");
    expect(state.filter).toBe("running");
    expect(state.queue).toBe("orders");
    expect(state.page).toBe(2);
    expect(parseTaskLocation(taskLocationHref(state).split("?")[1] ?? "")).toEqual(state);
  });

  it("drops only the task parameter when the drawer closes", () => {
    // Closing the drawer is not a change of what the operator is looking at, so every filter,
    // the page, and the chart settings survive it untouched.
    const opened = parseTaskLocation(
      "?filter=running&tags=billing&per=100&group=queue&task=job-42",
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
    expect(taskDetailNavigation(null, "job-a")).toBe("push");
    // Swapping tasks happens inside a panel that is already open.
    expect(taskDetailNavigation("job-a", "job-b")).toBe("replace");
    // Closing is a dismissal; Forward must not resurrect the panel.
    expect(taskDetailNavigation("job-a", null)).toBe("replace");
    expect(taskDetailNavigation(null, null)).toBe("replace");
  });

  it("keeps the task list request unchanged while the drawer opens, switches, and closes", () => {
    // The list behind a modeless drawer must not refetch or flash a loader when the operator
    // clicks from one task to the next, so the drawer id is not part of the listing request.
    const closed = parseTaskLocation("?filter=running&queue=orders&tags=billing&page=2&per=100");
    const opened = parseTaskLocation(
      "?filter=running&queue=orders&tags=billing&page=2&per=100&task=job-a",
    );
    expect(taskListingKey(opened)).toBe(taskListingKey(closed));
    expect(taskListingKey({ ...opened, taskId: "job-b" })).toBe(taskListingKey(closed));
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
    expect(taskListingKey({ ...closed, priority: 50 })).not.toBe(taskListingKey(closed));
    expect(taskListingKey({ ...closed, sort: "priority" })).not.toBe(taskListingKey(closed));
  });
});
