import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { SignalIdempotencyConflictError, Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

describe("signals", () => {
  it("resumes one waiting execution with the retained signal payload", async () => {
    const id = await queue.enqueue("signal-order", { orderId: "order-1" });
    const worker = new Worker(queue, { workerId: "signal-worker" }).handle(
      "signal-order",
      async (_payload, context) => {
        const signal = await context.waitForSignal<{ approved: boolean }>("approval");
        return { signal };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "scheduled" });

    await expect(
      queue.sendSignal(
        id,
        "approval",
        { approved: true },
        {
          idempotencyKey: "approval-request-1",
          requestedBy: "billing-service",
        },
      ),
    ).resolves.toMatchObject({ status: "delivered", payload: { approved: true } });

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { signal: { approved: true } },
    });
  });

  it("returns the retained delivery for an idempotent duplicate", async () => {
    const id = await queue.enqueue("signal-duplicate", {});
    const worker = new Worker(queue, { workerId: "signal-duplicate-worker" }).handle(
      "signal-duplicate",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);

    const request = { idempotencyKey: "same-delivery", requestedBy: "approval-service" };
    const first = await queue.sendSignal(id, "approval", { approved: true }, request);
    await expect(queue.sendSignal(id, "approval", { approved: true }, request)).resolves.toEqual({
      ...first,
      status: "duplicate",
    });

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { approved: true },
    });
  });

  it("rejects an early delivery but accepts an idempotent retry after the wait exists", async () => {
    const id = await queue.enqueue("signal-early", {});
    const request = { idempotencyKey: "early-retry", requestedBy: "webhook" };
    await expect(
      queue.sendSignal(id, "receipt", { received: true }, request),
    ).resolves.toMatchObject({ status: "not_waiting", payload: null });

    const worker = new Worker(queue, { workerId: "signal-early-worker" }).handle(
      "signal-early",
      async (_payload, context) => context.waitForSignal("receipt"),
    );
    expect(await worker.runOnce()).toBe(true);
    await expect(
      queue.sendSignal(id, "receipt", { received: true }, request),
    ).resolves.toMatchObject({ status: "delivered", payload: { received: true } });
  });

  it("serializes concurrent deliveries so exactly one payload wins", async () => {
    const id = await queue.enqueue("signal-race", {});
    const worker = new Worker(queue, { workerId: "signal-race-worker" }).handle(
      "signal-race",
      async (_payload, context) => context.waitForSignal("winner"),
    );
    expect(await worker.runOnce()).toBe(true);

    const results = await Promise.all([
      queue.sendSignal(
        id,
        "winner",
        { candidate: "a" },
        {
          idempotencyKey: "candidate-a",
          requestedBy: "service-a",
        },
      ),
      queue.sendSignal(
        id,
        "winner",
        { candidate: "b" },
        {
          idempotencyKey: "candidate-b",
          requestedBy: "service-b",
        },
      ),
    ]);
    const statuses = results.map((result) => result.status);
    expect(statuses).toHaveLength(2);
    expect(statuses).toEqual(expect.arrayContaining(["already_delivered", "delivered"]));
    const retained = results.find((result) => result.status === "delivered")!;
    expect(results[0]!.payload).toEqual(retained.payload);
    expect(results[1]!.payload).toEqual(retained.payload);
  });

  it("rejects a late second delivery after the resumed execution finishes", async () => {
    const id = await queue.enqueue("signal-late", {});
    const worker = new Worker(queue, { workerId: "signal-late-worker" }).handle(
      "signal-late",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);
    const timeout = await pool.query<{
      timeout_at: Date;
      runtime_deadline_at: Date;
      timeout_ms: number;
    }>(
      `SELECT signal.timeout_at, runtime.deadline_at AS runtime_deadline_at,
              extract(epoch FROM signal.timeout_at - signal.created_at) * 1000 AS timeout_ms
         FROM workhorse.job_signal_wait signal
         JOIN workhorse.job_runtime runtime ON runtime.job_id = signal.job_id
        WHERE signal.job_id = $1 AND signal.signal_name = 'approval'`,
      [id],
    );
    expect(timeout.rows[0]?.timeout_at).toEqual(timeout.rows[0]?.runtime_deadline_at);
    expect(Number(timeout.rows[0]?.timeout_ms)).toBeCloseTo(7 * 24 * 60 * 60 * 1_000, -2);

    await queue.sendSignal(
      id,
      "approval",
      { approved: true },
      {
        idempotencyKey: "first",
        requestedBy: "first-service",
      },
    );
    expect(await worker.runOnce()).toBe(true);

    await expect(
      queue.sendSignal(
        id,
        "approval",
        { approved: false },
        {
          idempotencyKey: "late",
          requestedBy: "late-service",
        },
      ),
    ).resolves.toMatchObject({
      status: "already_delivered",
      payload: { approved: true },
      deliveredBy: "first-service",
    });
  });

  it("rejects a changed request that reuses a retained idempotency key", async () => {
    const id = await queue.enqueue("signal-conflict", {});
    const worker = new Worker(queue, { workerId: "signal-conflict-worker" }).handle(
      "signal-conflict",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);
    const request = { idempotencyKey: "shared-key", requestedBy: "approver" };
    await queue.sendSignal(id, "approval", { approved: true }, request);

    await expect(
      queue.sendSignal(id, "approval", { approved: false }, request),
    ).rejects.toBeInstanceOf(SignalIdempotencyConflictError);
  });

  it("rejects a stale handler generation before it can declare a wait", async () => {
    const id = await queue.enqueue("signal-stale", {}, { maxAttempts: 2 });
    const stale = await queue.claim("signal-stale-worker", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);

    await expect(
      queue.waitForSignal(stale!, "signal-stale-worker", "approval"),
    ).rejects.toMatchObject({ name: "SignalWaitLeaseLostError" });
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "ready", currentAttempt: 2 });
  });

  it("rejects delivery after cancellation closes the pending wait", async () => {
    const id = await queue.enqueue("signal-canceled", {});
    const worker = new Worker(queue, { workerId: "signal-canceled-worker" }).handle(
      "signal-canceled",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.cancel(id, { requestedBy: "operator" })).resolves.toMatchObject({
      status: "canceled",
    });

    await expect(
      queue.sendSignal(
        id,
        "approval",
        { approved: true },
        {
          idempotencyKey: "after-cancel",
          requestedBy: "approval-service",
        },
      ),
    ).resolves.toMatchObject({ status: "stale", payload: null });
  });

  it("bounds payloads before delivery and excludes signal waits from timer health", async () => {
    const id = await queue.enqueue("signal-bounds", {});
    const worker = new Worker(queue, { workerId: "signal-bounds-worker" }).handle(
      "signal-bounds",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);

    await expect(
      queue.sendSignal(
        id,
        "approval",
        { data: "x".repeat(65_536) },
        {
          idempotencyKey: "oversized",
          requestedBy: "approval-service",
        },
      ),
    ).rejects.toThrow(/at most 65536 bytes/);
    await expect(queue.health()).resolves.toMatchObject({
      sleepingJobs: 0,
      overdueWaits: 0,
      nextWakeAt: null,
    });
  });

  it("replays a delivered signal after a later handler failure retries the attempt", async () => {
    const id = await queue.enqueue("signal-retry", {}, { maxAttempts: 2 });
    const worker = new Worker(queue, {
      workerId: "signal-retry-worker",
      retryDelayMs: 0,
    }).handle("signal-retry", async (_payload, context) => {
      const received = await context.waitForSignal<{ approved: boolean }>("approval");
      if (context.job.attempt === 1) throw new Error("fail after delivery");
      return received;
    });
    expect(await worker.runOnce()).toBe(true);
    await queue.sendSignal(
      id,
      "approval",
      { approved: true },
      {
        idempotencyKey: "retry-delivery",
        requestedBy: "approval-service",
      },
    );
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 2,
      result: { approved: true },
    });
  });

  it("records bounded attribution for accepted and rejected deliveries", async () => {
    const id = await queue.enqueue("signal-audit", {});
    await queue.sendSignal(
      id,
      "approval",
      { approved: false },
      {
        idempotencyKey: "too-soon",
        requestedBy: "early-service",
      },
    );
    const worker = new Worker(queue, { workerId: "signal-audit-worker" }).handle(
      "signal-audit",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);
    await queue.sendSignal(
      id,
      "approval",
      { approved: true },
      {
        idempotencyKey: "accepted",
        requestedBy: "authenticated-service",
      },
    );

    const timeline = await queue.getJobTimeline(id);
    const events = timeline.items.filter((item) => item.kind === "event");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "signal_rejected",
          details: expect.objectContaining({
            reason: "not_waiting",
            requested_by: "early-service",
          }),
        }),
        expect.objectContaining({
          eventType: "signal_received",
          details: expect.objectContaining({ requested_by: "authenticated-service" }),
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("too-soon");
    expect(JSON.stringify(events)).not.toContain('accepted"');
  });

  it("uses the PostgreSQL job deadline as the signal timeout", async () => {
    const id = await queue.enqueue("signal-timeout", {}, { deadline: new Date(Date.now() + 100) });
    const worker = new Worker(queue, { workerId: "signal-timeout-worker" }).handle(
      "signal-timeout",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);
    await sleep(130);
    await queue.tick();

    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "DeadlineExceeded" }),
    });
    await expect(
      queue.sendSignal(
        id,
        "approval",
        { approved: true },
        { idempotencyKey: "after-timeout", requestedBy: "approval-service" },
      ),
    ).resolves.toMatchObject({ status: "stale" });
  });

  it("fails an unanswered signal at the caller's shorter timeout", async () => {
    const id = await queue.enqueue("signal-custom-timeout", {});
    const worker = new Worker(queue, { workerId: "signal-custom-timeout-worker" }).handle(
      "signal-custom-timeout",
      async (_payload, context) => context.waitForSignal("approval", { timeoutMs: 100 }),
    );
    expect(await worker.runOnce()).toBe(true);
    await sleep(130);
    await queue.tick();

    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "DeadlineExceeded" }),
    });
  });

  it("serializes cancellation against signal delivery", async () => {
    const id = await queue.enqueue("signal-cancel-race", {});
    const worker = new Worker(queue, { workerId: "signal-cancel-race-worker" }).handle(
      "signal-cancel-race",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);

    const [cancellation, delivery] = await Promise.all([
      queue.cancel(id, { requestedBy: "operator" }),
      queue.sendSignal(
        id,
        "approval",
        { approved: true },
        { idempotencyKey: "racing-delivery", requestedBy: "service" },
      ),
    ]);
    expect(cancellation.status).toBe("canceled");
    expect(["delivered", "stale"]).toContain(delivery.status);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "canceled" });
  });
});
