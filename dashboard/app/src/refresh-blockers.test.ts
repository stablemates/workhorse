import { describe, expect, it, vi } from "vitest";
import { createRefreshBlockerRegistry } from "./refresh-blockers.js";

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
});
