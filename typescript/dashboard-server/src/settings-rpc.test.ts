import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { dashboardRouter, type DashboardRpcContext } from "./server/router.js";
import { createDashboardQueueHealthReader } from "./server/read-model.js";
import type { DashboardSettingsController } from "./server/types.js";

function context(overrides: Partial<DashboardRpcContext> = {}): DashboardRpcContext {
  const database = {} as DashboardRpcContext["database"];
  return {
    database,
    queue: {} as DashboardRpcContext["queue"],
    admin: {} as DashboardRpcContext["admin"],
    configuredWorkers: [],
    environment: "test",
    authenticatedActor: "operator",
    readQueueHealth: createDashboardQueueHealthReader(database),
    maintenanceLoops: { tickIntervalMs: 1_000 },
    operator: { mode: "read-only" },
    ...overrides,
  };
}

describe("settings RPC", () => {
  it("requires local mutation authority and forwards complete audit context", async () => {
    const readOnly = createRouterClient(dashboardRouter, { context: context() });
    await expect(
      readOnly.dashboard.overrideMaintenancePolicy({
        definition: { historyRetentionLocalTime: "01:30" },
        audit: { actor: "operator", reason: "Move cleanup", requestId: "request-1" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const overrideMaintenancePolicy = vi
      .fn<DashboardSettingsController["overrideMaintenancePolicy"]>()
      .mockResolvedValue(undefined);
    const local = createRouterClient(dashboardRouter, {
      context: context({
        operator: { mode: "writable" },
        settingsController: {
          overrideMaintenancePolicy,
          revertMaintenancePolicy: vi.fn<DashboardSettingsController["revertMaintenancePolicy"]>(),
          overrideRetentionPolicy: vi.fn<DashboardSettingsController["overrideRetentionPolicy"]>(),
          revertRetentionPolicy: vi.fn<DashboardSettingsController["revertRetentionPolicy"]>(),
        },
      }),
    });
    await local.dashboard.overrideMaintenancePolicy({
      definition: { historyRetentionLocalTime: "01:30" },
      audit: { actor: "operator", reason: "Move cleanup", requestId: "request-1" },
    });

    expect(overrideMaintenancePolicy).toHaveBeenCalledWith(
      { historyRetentionLocalTime: "01:30" },
      expect.objectContaining({
        actor: "operator",
        reason: "Move cleanup",
        requestId: "request-1",
        occurredAt: expect.any(String),
      }),
    );
  });
});
