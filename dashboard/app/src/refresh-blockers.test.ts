import { describe, expect, it, vi } from "vitest";
import {
  createRefreshBlockerRegistry,
  dashboardInputTypeBlocksRefresh,
  dashboardRefreshBlockers,
} from "./refresh-blockers.js";

describe("dashboard focus refresh blocking", () => {
  it("keeps non-editable theme and toggle controls refreshable", () => {
    expect(dashboardInputTypeBlocksRefresh("radio")).toBe(false);
    expect(dashboardInputTypeBlocksRefresh("checkbox")).toBe(false);
    expect(dashboardInputTypeBlocksRefresh("text")).toBe(true);
  });
});

describe("dashboard refresh blocker registry", () => {
  it("keeps refresh blocked until every active control releases its registration", () => {
    const changed = vi.fn<() => void>();
    const registry = createRefreshBlockerRegistry();
    const unsubscribe = registry.subscribe(changed);

    registry.set("focused-input", {
      description: "Auto refresh paused while a dashboard input is focused",
      priority: 0,
    });
    registry.set("task-drawer", {
      description: "Auto refresh paused while task details are open",
      priority: 10,
    });

    expect(registry.getSnapshot()).toEqual({
      blocked: true,
      description: "Auto refresh paused while task details are open",
    });

    registry.set("task-drawer", null);
    expect(registry.getSnapshot()).toEqual({
      blocked: true,
      description: "Auto refresh paused while a dashboard input is focused",
    });

    registry.set("focused-input", null);
    expect(registry.getSnapshot()).toEqual({ blocked: false, description: null });
    expect(changed).toHaveBeenCalledTimes(4);

    unsubscribe();
  });

  it("does not notify polling when a registration repeats the same state", () => {
    const changed = vi.fn<() => void>();
    const registry = createRefreshBlockerRegistry();
    registry.subscribe(changed);
    const blocker = {
      description: "Auto refresh paused while a dropdown is open",
      priority: 20,
    };

    registry.set("dropdown", blocker);
    registry.set("dropdown", blocker);
    registry.set("dropdown", null);
    registry.set("dropdown", null);

    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("explains a pinned task page, and yields to whatever is opened on top of it", () => {
    const registry = createRefreshBlockerRegistry();

    registry.set("pinned-page", dashboardRefreshBlockers.pinnedTaskPage);
    expect(registry.getSnapshot()).toEqual({
      blocked: true,
      description: "Auto refresh paused while the task list is pinned to a page",
    });

    // The drawer is the more immediate explanation while it is open, and the page is still pinned
    // underneath it, so closing the drawer returns to the pinned-page reason rather than resuming.
    registry.set("task-drawer", dashboardRefreshBlockers.taskDrawer);
    expect(registry.getSnapshot().description).toBe(
      "Auto refresh paused while task details are open",
    );
    registry.set("task-drawer", null);
    expect(registry.getSnapshot().description).toBe(
      "Auto refresh paused while the task list is pinned to a page",
    );

    registry.set("pinned-page", null);
    expect(registry.getSnapshot()).toEqual({ blocked: false, description: null });
  });
});
