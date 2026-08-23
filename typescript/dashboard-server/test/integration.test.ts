import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { Worker } from "../../core/src/index.js";
import { createIntegrationTestContext } from "../../core/test/support/integration.js";
import { createDashboardHost } from "../src/server/host.js";
import { createDashboardOperatorControllers } from "../src/server/operator-controllers.js";
import { readDashboardJobDetail } from "../src/server/read-model.js";
import { dashboardDatabase } from "../src/server/sql.js";
import type { DashboardRouter } from "../src/server/router.js";

const { admin, pool, queue } = createIntegrationTestContext(import.meta.url);

describe("dashboard signal integration", () => {
  it("rejects an unauthorized delivery before it mutates the waiting execution", async () => {
    const id = await queue.enqueue("signal-unauthorized", {});
    const worker = new Worker(queue, { workerId: "signal-unauthorized-worker" }).handle(
      "signal-unauthorized",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);

    const controllers = createDashboardOperatorControllers({
      run: (_action, operation) => operation({ queue, admin }),
    });
    const host = createDashboardHost({
      database: pool,
      path: "/",
      authorize: (request) =>
        request.headers.get("authorization") === "Bearer valid"
          ? { actor: "authenticated-operator" }
          : false,
      ...controllers,
    });
    const client = (authorized: boolean): RouterClient<DashboardRouter> =>
      createORPCClient(
        new RPCLink({
          url: "http://dashboard.test/rpc",
          fetch: async (request) => {
            const headers = new Headers(request.headers);
            headers.set("origin", "http://dashboard.test");
            if (authorized) headers.set("authorization", "Bearer valid");
            return (
              (await host.handle(new Request(request, { headers }))) ??
              new Response(null, { status: 404 })
            );
          },
        }),
      );
    const input = {
      id,
      name: "approval",
      payload: { approved: true },
      idempotencyKey: "dashboard-delivery",
      audit: {
        actor: "spoofed-operator",
        reason: "approve",
        requestId: "dashboard-request",
      },
    };

    await expect(client(false).dashboard.signalTask(input)).rejects.toThrow(/Forbidden/);
    await expect(client(true).dashboard.signalTask(input)).resolves.toMatchObject({
      status: "delivered",
      deliveredBy: "authenticated-operator",
    });
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { approved: true },
    });
  });
});

describe("dashboard batch execution detail", () => {
  it("returns ordered peers and their matching attempt failures", async () => {
    const queueName = `dashboard-batch-${randomUUID()}`;
    const jobIds = await Promise.all(
      [1, 2].map((value) =>
        queue.enqueue("dashboard-batch", { value }, { queue: queueName, maxAttempts: 1 }),
      ),
    );
    const worker = new Worker(queue, {
      workerId: "dashboard-batch-worker",
      queue: queueName,
      concurrency: 2,
    }).handleBatch("dashboard-batch", { maxSize: 2, lingerMs: 100 }, () => {
      throw new Error("shared provider failure");
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    const detail = await readDashboardJobDetail(dashboardDatabase(pool), jobIds[0]!);

    expect(detail?.batchExecutions).toEqual([
      {
        id: expect.any(String),
        attempt: 1,
        dispatchedAt: expect.any(String),
        batchWideFailure: true,
        members: jobIds.map((id) => ({
          id,
          type: "dashboard-batch",
          attempt: 1,
          outcome: "failed",
          error: expect.objectContaining({ message: "shared provider failure" }),
        })),
      },
    ]);
  });
});
