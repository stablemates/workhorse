import { describe, expect, it } from "vitest";
import { createDashboardRefreshController } from "./dashboard-refresh-controller.js";

describe("dashboard refresh controller", () => {
  it("coordinates blockers, countdowns, and background refreshes", () => {
    let blocked = true;
    const controller = createDashboardRefreshController(() => blocked);
    expect(controller.shouldDiscardBackground(true)).toBe(true);
    expect(controller.autoRefreshPaused(false, null, "15s")).toBe(true);
    expect(controller.pauseDescription(null, 2)).toBe("Auto refresh resumes in 2 seconds");
    blocked = false;
    expect(controller.shouldDiscardBackground(true)).toBe(false);
    expect(controller.pauseDescription("editing", null)).toBe("editing");
  });
});
