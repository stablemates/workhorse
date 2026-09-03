import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { dashboardRouter, isDashboardMutation, type DashboardRpcContext } from "./router.js";

const AUDIT = { actor: "browser", reason: "because", requestId: "request-1" };
const JOB_ID = "00000000-0000-4000-8000-000000000000";

/**
 * One valid input per state-changing procedure.
 *
 * The inputs must validate, because oRPC checks the schema before the handler runs and a rejected
 * input would prove nothing about authorization. The table is asserted to cover exactly the
 * router's mutation set, so a new mutation cannot be added without a row here.
 */
const MUTATION_INPUTS: Readonly<Record<string, unknown>> = {
  enqueueTest: { kind: "success", audit: AUDIT },
  setScheduleEnabled: {
    kind: "user",
    namespace: "reports",
    name: "nightly",
    enabled: true,
    audit: AUDIT,
  },
  setQueuePaused: { queue: "default", paused: true, audit: AUDIT },
  purgeQueue: { queue: "default", audit: AUDIT },
  setWorkerPaused: { workerId: "worker-1", paused: true, audit: AUDIT },
  overrideMaintenancePolicy: { definition: { timezone: "UTC" }, audit: AUDIT },
  revertMaintenancePolicy: { settings: ["timezone"], audit: AUDIT },
  overrideRetentionPolicy: { definition: { jobEventRetentionDays: 7 }, audit: AUDIT },
  revertRetentionPolicy: { settings: ["jobEventRetentionDays"], audit: AUDIT },
  runTaskNow: { id: JOB_ID, audit: AUDIT },
  cancelTask: { id: JOB_ID, audit: AUDIT },
  signalTask: {
    id: JOB_ID,
    name: "approved",
    payload: {},
    idempotencyKey: "signal-1",
    audit: AUDIT,
  },
  completeHumanWait: {
    id: JOB_ID,
    name: "approval",
    result: {},
    idempotencyKey: "wait-1",
    audit: AUDIT,
  },
  redriveTask: { id: JOB_ID, audit: AUDIT },
  redriveDeadLetters: { audit: AUDIT },
};

function readOnlyContext(): DashboardRpcContext {
  return {
    database: { execute: vi.fn<DashboardRpcContext["database"]["execute"]>() },
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

describe("dashboard mutation authorization", () => {
  it("names every state-changing procedure the router declares", () => {
    const declared = Object.keys(dashboardRouter.dashboard).filter((name) =>
      isDashboardMutation(`dashboard.${name}`),
    );

    expect(new Set(declared)).toEqual(new Set(Object.keys(MUTATION_INPUTS)));
  });

  it.each(Object.entries(MUTATION_INPUTS))(
    "refuses %s on a read-only dashboard before touching the database",
    async (name, input) => {
      const context = readOnlyContext();
      const client = createRouterClient(dashboardRouter, { context });

      await expect(
        (client.dashboard as Record<string, (value: unknown) => Promise<unknown>>)[name]?.(input),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(context.database.execute).not.toHaveBeenCalled();
    },
  );

  it.each(Object.keys(MUTATION_INPUTS))(
    "requires a matching Origin for %s, because the host classifies it as a mutation",
    (name) => {
      expect(isDashboardMutation(`dashboard.${name}`)).toBe(true);
    },
  );
});
