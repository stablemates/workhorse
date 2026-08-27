import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { dashboardRouter, type DashboardRpcContext } from "./router.js";

function context(): DashboardRpcContext {
  const database = {
    execute: vi.fn<DashboardRpcContext["database"]["execute"]>(),
  } as DashboardRpcContext["database"];
  return {
    database,
    queue: {} as DashboardRpcContext["queue"],
    admin: {} as DashboardRpcContext["admin"],
    configuredWorkers: [],
    environment: "test",
    authenticatedActor: "operator",
    readQueueHealth: vi.fn<DashboardRpcContext["readQueueHealth"]>(),
    maintenanceLoops: { tickIntervalMs: 1_000 },
    operator: { mode: "read-only" },
  };
}

describe("dashboard read RPC input bounds", () => {
  it.each(["tasks", "events"] as const)("rejects a deep %s page before querying", async (rpc) => {
    const rpcContext = context();
    const client = createRouterClient(dashboardRouter, { context: rpcContext });

    await expect(client.dashboard[rpc]({ page: 101 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(rpcContext.database.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["tasks", { search: "x".repeat(201) }],
    ["tasks", { queue: "x".repeat(201) }],
    ["activity", { worker: "x".repeat(201) }],
    ["events", { jobType: "x".repeat(201) }],
  ] as const)("rejects an oversized %s filter before querying", async (rpc, input) => {
    const rpcContext = context();
    const client = createRouterClient(dashboardRouter, { context: rpcContext });

    await expect(client.dashboard[rpc](input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(rpcContext.database.execute).not.toHaveBeenCalled();
  });
});
