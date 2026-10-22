import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { Worker } from "../../core/src/index.js";
import { createIntegrationTestContext } from "../../core/test/support/integration.js";
import { createDashboardHost } from "../src/server/host.js";
import { createDashboardOperatorControllers } from "../src/server/operator-controllers.js";
import { readDashboardTaskDetail } from "../src/server/read-model.js";
import { dashboardDatabase } from "../src/server/sql.js";
import type { DashboardRouter } from "../src/server/router.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);

describe("dashboard signal integration", () => {
  it("rejects an unauthorized delivery before it mutates the waiting execution", async () => {
    const id = await queue.enqueue("signal-unauthorized", {});
    const worker = new Worker(queue, { workerId: "signal-unauthorized-worker" }).handle(
      "signal-unauthorized",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);

    const controllers = createDashboardOperatorControllers({
      run: (_action, operation) => operation({ admin, queue }),
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
    await expect(admin.getTask(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { approved: true },
    });
  });
});

describe("dashboard batch execution detail", () => {
  it("returns ordered peers and their matching attempt failures", async () => {
    const queueName = `dashboard-batch-${randomUUID()}`;
    // Concurrent enqueues can commit in either order, and the batch lists members in claim order.
    const taskIds: string[] = [];
    for (const value of [1, 2]) {
      taskIds.push(
        await queue.enqueue("dashboard-batch", { value }, { queue: queueName, maxAttempts: 1 }),
      );
    }
    const worker = new Worker(queue, {
      workerId: "dashboard-batch-worker",
      queue: queueName,
      concurrency: 2,
    }).handleBatch("dashboard-batch", { maxSize: 2, lingerMs: 100 }, () => {
      throw new Error("shared provider failure");
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    const detail = await readDashboardTaskDetail(dashboardDatabase(pool), taskIds[0]!);

    expect(detail?.batchExecutions).toEqual([
      {
        id: expect.any(String),
        attempt: 1,
        dispatchedAt: expect.any(String),
        batchWideFailure: true,
        members: taskIds.map((id) => ({
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

function writableClient(): RouterClient<DashboardRouter> {
  const controllers = createDashboardOperatorControllers({
    run: (_action, operation) => operation({ admin, queue }),
  });
  const host = createDashboardHost({
    database: pool,
    path: "/",
    authorize: () => ({ actor: "authenticated-operator" }),
    ...controllers,
  });
  return createORPCClient(
    new RPCLink({
      url: "http://dashboard.test/rpc",
      fetch: async (request) => {
        const headers = new Headers(request.headers);
        headers.set("origin", "http://dashboard.test");
        return (
          (await host.handle(new Request(request, { headers }))) ??
          new Response(null, { status: 404 })
        );
      },
    }),
  );
}
const audit = (reason: string) => ({
  actor: "spoofed-operator",
  reason,
  requestId: `request-${randomUUID()}`,
});
async function queueControl(queueName: string) {
  const result = await pool.query<{
    tier: string;
    record_attempts: boolean;
    record_claims: boolean;
    updated_by: string | null;
    reason: string | null;
  }>(
    `SELECT tier, record_attempts, record_claims, updated_by, reason
       FROM workhorse.queue_control WHERE queue_name = $1`,
    [queueName],
  );
  return result.rows[0];
}

describe("dashboard queue tier and history", () => {
  it("switches an empty queue's tier and records the authenticated actor and reason", async () => {
    const queueName = `dashboard-tier-${randomUUID()}`;
    const client = writableClient();

    await expect(
      client.dashboard.setQueueTier({ queue: queueName, tier: "fast", audit: audit("go fast") }),
    ).resolves.toEqual({ status: "set", tier: "fast" });
    await expect(queueControl(queueName)).resolves.toMatchObject({
      tier: "fast",
      updated_by: "authenticated-operator",
      reason: "go fast",
    });
    const page = await client.dashboard.queues();
    expect(page.queues.find((row) => row.queue === queueName)).toMatchObject({ tier: "fast" });

    await expect(
      client.dashboard.setQueueTier({ queue: queueName, tier: "full", audit: audit("go back") }),
    ).resolves.toEqual({ status: "set", tier: "full" });
    await expect(queueControl(queueName)).resolves.toMatchObject({
      tier: "full",
      reason: "go back",
    });
  });

  it("refuses a queue with a live task and leaves its tier unchanged", async () => {
    const queueName = `dashboard-tier-live-${randomUUID()}`;
    await queue.enqueue("dashboard-tier-live", {}, { queue: queueName });

    await expect(
      writableClient().dashboard.setQueueTier({
        queue: queueName,
        tier: "fast",
        audit: audit("go fast"),
      }),
    ).resolves.toEqual({ status: "live_tasks", tier: null });
    expect((await queueControl(queueName))?.tier ?? "full").toBe("full");
  });

  it("refuses a fast switch for a queue with a concurrency or rate-limit policy", async () => {
    const concurrencyQueue = `dashboard-tier-concurrency-${randomUUID()}`;
    const rateQueue = `dashboard-tier-rate-${randomUUID()}`;
    await queue.syncConcurrencyPolicies(`dashboard-tier-${randomUUID()}`, [
      { queue: concurrencyQueue, maxActive: 1 },
    ]);
    await queue.syncRateLimitPolicies(`dashboard-tier-${randomUUID()}`, [
      { queue: rateQueue, rate: { limit: 1, intervalMs: 60_000, burst: 1 } },
    ]);
    const client = writableClient();

    await expect(
      client.dashboard.setQueueTier({
        queue: concurrencyQueue,
        tier: "fast",
        audit: audit("go fast"),
      }),
    ).resolves.toEqual({ status: "concurrency_policy", tier: null });
    await expect(
      client.dashboard.setQueueTier({ queue: rateQueue, tier: "fast", audit: audit("go fast") }),
    ).resolves.toEqual({ status: "rate_limit_policy", tier: null });
    expect((await queueControl(concurrencyQueue))?.tier ?? "full").toBe("full");
    expect((await queueControl(rateQueue))?.tier ?? "full").toBe("full");
  });

  it("changes one history setting and keeps the omitted one", async () => {
    const queueName = `dashboard-history-${randomUUID()}`;
    const client = writableClient();
    await client.dashboard.setQueueTier({ queue: queueName, tier: "fast", audit: audit("fast") });

    await expect(
      client.dashboard.setQueueHistory({
        queue: queueName,
        recordAttempts: true,
        audit: audit("record attempts"),
      }),
    ).resolves.toEqual({ recordAttempts: true, recordClaims: false });
    await expect(
      client.dashboard.setQueueHistory({
        queue: queueName,
        recordClaims: true,
        audit: audit("record claims"),
      }),
    ).resolves.toEqual({ recordAttempts: true, recordClaims: true });
    const page = await client.dashboard.queues();
    expect(page.queues.find((row) => row.queue === queueName)).toMatchObject({
      tier: "fast",
      recordAttempts: true,
      recordClaims: true,
    });
  });
});
