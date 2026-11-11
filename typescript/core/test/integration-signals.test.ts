import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  MAX_EXTERNAL_WAIT_ACTOR_CHARACTERS,
  MAX_EXTERNAL_WAIT_NAME_CHARACTERS,
  SignalIdempotencyConflictError,
  SignalWaitConflictError,
  SignalWaitLeaseLostError,
  type Queryable,
  Worker,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin, adminAudit, waitForDatabaseCondition } = createIntegrationTestContext(
  import.meta.url,
);

describe("signals", () => {
  it("rejects names the dashboard would normalize to another identity", async () => {
    const id = await queue.enqueue("signal-name", {});
    const claimed = await queue.claim("signal-name-worker");
    await expect(queue.waitForSignal(claimed!, "signal-name-worker", " approval ")).rejects.toThrow(
      /leading or trailing whitespace/,
    );
    await queue.cancel(id);
  });

  it("counts a name and an actor in code points, as PostgreSQL does", async () => {
    // Each emoji is one code point and two UTF-16 code units.
    const name = "🔔".repeat(MAX_EXTERNAL_WAIT_NAME_CHARACTERS);
    const actor = "🧑".repeat(MAX_EXTERNAL_WAIT_ACTOR_CHARACTERS);
    const id = await queue.enqueue("signal-code-points", {});
    const claimed = await queue.claim("signal-code-points-worker");

    await expect(
      queue.waitForSignal(claimed!, "signal-code-points-worker", `${name}🔔`),
    ).rejects.toThrow(RangeError);
    await expect(
      queue.waitForSignal(claimed!, "signal-code-points-worker", name),
    ).resolves.toMatchObject({ status: "waiting" });
    await expect(
      queue.sendSignal(
        id,
        name,
        { approved: true },
        { idempotencyKey: "signal-code-points-long", requestedBy: `${actor}🧑` },
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      queue.sendSignal(
        id,
        name,
        { approved: true },
        { idempotencyKey: "signal-code-points", requestedBy: actor },
      ),
    ).resolves.toMatchObject({ status: "delivered", payload: { approved: true } });
  });

  it("distinguishes an existing wait from a lost lease", async () => {
    const id = await queue.enqueue("signal-concurrent-wait", {});
    const claimed = await queue.claim("signal-concurrent-wait-worker");
    const declarations = await Promise.allSettled([
      queue.waitForSignal(claimed!, "signal-concurrent-wait-worker", "approval"),
      queue.waitForSignal(claimed!, "signal-concurrent-wait-worker", "approval"),
    ]);

    expect(declarations).toEqual(
      expect.arrayContaining([
        { status: "fulfilled", value: { status: "waiting", payload: null } },
        { status: "rejected", reason: expect.any(SignalWaitConflictError) },
      ]),
    );
    await queue.cancel(id);
  });

  it("does not let another stale generation masquerade as the pending wait owner", async () => {
    const id = await queue.enqueue("signal-pending-owner", {});
    const claimed = await queue.claim("signal-pending-owner-worker");
    await expect(
      queue.waitForSignal(claimed!, "signal-pending-owner-worker", "approval"),
    ).resolves.toMatchObject({ status: "waiting" });

    await expect(
      queue.waitForSignal(
        { ...claimed!, fenceToken: claimed!.fenceToken + 1n },
        "signal-pending-owner-worker",
        "approval",
      ),
    ).rejects.toBeInstanceOf(SignalWaitLeaseLostError);
    await queue.cancel(id);
  });

  it("lists actionable signal waits through the public read API", async () => {
    const id = await queue.enqueue("signal-list", {});
    const worker = new Worker(queue, { workerId: "signal-list-worker" }).handle(
      "signal-list",
      async (_payload, context) => context.waitForSignal("approval"),
    );

    expect(await worker.runOnce()).toBe(true);
    const secondId = await queue.enqueue("signal-list", {});
    expect(await worker.runOnce()).toBe(true);

    const firstPage = await admin.listSignalWaits({ limit: 1 });
    expect(firstPage).toEqual({
      items: [
        {
          taskId: id,
          queue: "default",
          taskType: "signal-list",
          name: "approval",
          attempt: 1,
          createdAt: expect.any(Date),
          deadlineAt: expect.any(Date),
        },
      ],
      nextCursor: { createdAt: expect.any(String), taskId: id, name: "approval" },
    });
    await expect(
      admin.listSignalWaits({ limit: 1, cursor: firstPage.nextCursor! }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ taskId: secondId, name: "approval" })],
      nextCursor: null,
    });

    await queue.sendSignal(
      id,
      "approval",
      { approved: true },
      { idempotencyKey: "signal-list-delivery", requestedBy: "operator" },
    );
    await queue.sendSignal(
      secondId,
      "approval",
      { approved: true },
      { idempotencyKey: "signal-list-delivery-2", requestedBy: "operator" },
    );
    await expect(admin.listSignalWaits()).resolves.toEqual({ items: [], nextCursor: null });
  });

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
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "scheduled" });

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
    await expect(admin.getTask(id)).resolves.toMatchObject({
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
    await expect(admin.getTask(id)).resolves.toMatchObject({
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
         FROM workhorse.task_signal_wait signal
         JOIN workhorse.task_runtime runtime ON runtime.task_id = signal.task_id
        WHERE signal.task_id = $1 AND signal.signal_name = 'approval'`,
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
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "ready", currentAttempt: 2 });
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
      sleepingTasks: 0,
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
      if (context.task.attempt === 1) throw new Error("fail after delivery");
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
    await expect(admin.getTask(id)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 2,
      result: { approved: true },
    });
  });

  it("redrives a failed signal consumer without copying its delivered signal", async () => {
    const sourceId = await queue.enqueue("signal-redrive", {}, { maxAttempts: 1 });
    const worker = new Worker(queue, { workerId: "signal-redrive-worker" }).handle(
      "signal-redrive",
      async (_payload, context) => {
        const received = await context.waitForSignal<{ approved: boolean }>("approval");
        if (context.task.id === sourceId) throw new Error("fail after source delivery");
        return received;
      },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    await queue.sendSignal(
      sourceId,
      "approval",
      { approved: true },
      { idempotencyKey: "signal-redrive-source", requestedBy: "approval-service" },
    );
    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(admin.getTask(sourceId)).resolves.toMatchObject({ state: "failed" });

    const redrive = await admin.redrive(sourceId, {
      actor: "signal-test",
      reason: "retry signal workflow",
      requestId: `signal-redrive-${sourceId}`,
    });
    expect(redrive.status).toBe("redriven");
    const targetId = redrive.targetTaskId!;

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(admin.getTask(targetId)).resolves.toMatchObject({ state: "scheduled" });
    await queue.sendSignal(
      targetId,
      "approval",
      { approved: false },
      { idempotencyKey: "signal-redrive-target", requestedBy: "approval-service" },
    );
    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(admin.getTask(targetId)).resolves.toMatchObject({
      state: "succeeded",
      result: { approved: false },
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

    const timeline = await admin.getTaskTimeline(id);
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

  it("uses the PostgreSQL task deadline as the signal timeout", async () => {
    const deadline = new Date(Date.now() + 30_000);
    const id = await queue.enqueue("signal-timeout", {}, { deadline });
    const worker = new Worker(queue, { workerId: "signal-timeout-worker" }).handle(
      "signal-timeout",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);
    const stored = await pool.query<{ deadline_at: Date; timeout_at: Date }>(
      `SELECT runtime.deadline_at, signal.timeout_at
         FROM workhorse.task_runtime runtime
         JOIN workhorse.task_signal_wait signal ON signal.task_id = runtime.task_id
        WHERE runtime.task_id = $1`,
      [id],
    );
    expect(stored.rows).toEqual([{ deadline_at: deadline, timeout_at: deadline }]);

    // Move the durable PostgreSQL deadline rather than waiting on a narrow wall-clock window. The
    // equality above is the contract under test; this update only makes the timeout due now.
    await pool.query(
      `UPDATE workhorse.task_runtime
          SET deadline_at = clock_timestamp() - interval '1 millisecond'
        WHERE task_id = $1`,
      [id],
    );
    await queue.tick();

    await expect(admin.getTask(id)).resolves.toMatchObject({
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

    await expect(admin.getTask(id)).resolves.toMatchObject({
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
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "canceled" });
  });
});

const send = (version: 1 | 2, taskId: string, key: string, client: Queryable = pool) =>
  client
    .query<{ status: string }>(
      `SELECT status FROM workhorse.send_signal_v${version}($1, 'approval', $2::jsonb, $3, 'review-service')`,
      [taskId, JSON.stringify({ approved: true }), key],
    )
    .then(({ rows }) => rows[0]!.status);
const rejections = async (taskId: string) =>
  (
    await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM workhorse.task_event
        WHERE task_id = $1 AND event_type = 'signal_rejected'`,
      [taskId],
    )
  ).rows[0]!.count;
const failTerminally = async (queueName: string, workerId: string) => {
  const task = (await queue.claim(workerId, { queue: queueName }))!;
  await pool.query(`SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb, -1)`, [
    task.id,
    workerId,
    task.fenceToken.toString(),
    JSON.stringify({ name: "Error", message: "boom" }),
  ]);
};
// Wait until the backend is blocked on a lock that another session holds.
const waitForLock = (pid: number) =>
  waitForDatabaseCondition(async () => {
    const { rows } = await pool.query<{ waiting: boolean }>(
      "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    return rows[0]?.waiting === true;
  });

describe("a signal to a terminal task that has no wait", () => {
  it("answers stale and writes no event, while v1 keeps not_waiting", async () => {
    const id = await queue.enqueue("order.publish", {}, { queue: "signal-terminal" });
    await failTerminally("signal-terminal", "signal-terminal-worker");
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "failed" });

    await expect(send(2, id, "review-77")).resolves.toBe("stale");
    await expect(send(2, id, "review-77")).resolves.toBe("stale");
    expect(await rejections(id)).toBe(0);
    await expect(send(1, id, "review-77")).resolves.toBe("not_waiting");
    expect(await rejections(id)).toBe(1);
  });

  it("answers for a task with no runtime row in each tier", async () => {
    // A full-tier task leaves task_runtime at its terminal transition and keeps its task row.
    const full = await queue.enqueue("order.publish", {}, { queue: "signal-full-terminal" });
    const claimed = (await queue.claim("full-terminal-worker", { queue: "signal-full-terminal" }))!;
    expect(await queue.complete(claimed, "full-terminal-worker", null)).toBe(true);
    await expect(send(2, full, "full")).resolves.toBe("stale");
    // A fast-tier task keeps its live state in fast_task_runtime. It cannot wait for a signal, so
    // a live one answers not_waiting, and a terminal one answers stale with no event.
    await admin.setQueueTier("signal-fast", "fast", adminAudit("fast tier"));
    const fast = await queue.enqueue("order.publish", {}, { queue: "signal-fast" });
    await expect(send(2, fast, "fast-live")).resolves.toBe("not_waiting");
    const [fastTask] = await queue.claimFast("fast-worker", 1, { queue: "signal-fast" });
    expect(fastTask?.id).toBe(fast);
    expect(await queue.complete(fastTask!, "fast-worker", null)).toBe(true);
    await expect(send(2, fast, "fast-terminal")).resolves.toBe("stale");
    expect(await rejections(fast)).toBe(1);
    // An unknown task identity also has no task row.
    await expect(send(2, "00000000-0000-7000-8000-000000000000", "unknown")).resolves.toBe(
      "not_found",
    );
    expect(await rejections(full)).toBe(0);
  });

  it("still answers not_waiting for a live task that has not reached the wait", async () => {
    const id = await queue.enqueue("order.publish", {}, { queue: "signal-early" });
    await expect(send(2, id, "early")).resolves.toBe("not_waiting");
    const claimed = await queue.claim("signal-early-worker", { queue: "signal-early" });
    expect(claimed?.id).toBe(id);
    await expect(send(2, id, "early")).resolves.toBe("not_waiting");
    expect(await rejections(id)).toBe(2);
  });

  it("waits for a terminal transition that holds the runtime row, then answers stale", async () => {
    const id = await queue.enqueue("order.publish", {}, { queue: "signal-terminal-race" });
    const task = (await queue.claim("race-worker", { queue: "signal-terminal-race" }))!;
    const finisher = await pool.connect();
    const sender = await pool.connect();
    try {
      const senderPid = (await sender.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      await finisher.query("BEGIN");
      await finisher.query("SELECT workhorse.complete_v1($1, $2, $3, 'null'::jsonb)", [
        id,
        "race-worker",
        task.fenceToken.toString(),
      ]);
      const pending = send(2, id, "race", sender);
      await waitForLock(senderPid);
      await finisher.query("COMMIT");
      await expect(pending).resolves.toBe("stale");
    } finally {
      await finisher.query("ROLLBACK").catch(() => undefined);
      finisher.release();
      sender.release();
    }
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "succeeded" });
    expect(await rejections(id)).toBe(0);
  });

  it("orders a terminal transition after a send that answered not_waiting", async () => {
    const id = await queue.enqueue("order.publish", {}, { queue: "signal-live-race" });
    const task = (await queue.claim("live-race-worker", { queue: "signal-live-race" }))!;
    const finisher = await pool.connect();
    const sender = await pool.connect();
    try {
      const finisherPid = (await finisher.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      await sender.query("BEGIN");
      await expect(send(2, id, "live-race", sender)).resolves.toBe("not_waiting");
      const completion = finisher.query<{ accepted: boolean }>(
        "SELECT workhorse.complete_v1($1, $2, $3, 'null'::jsonb) AS accepted",
        [id, "live-race-worker", task.fenceToken.toString()],
      );
      await waitForLock(finisherPid);
      await sender.query("COMMIT");
      await expect(completion).resolves.toMatchObject({ rows: [{ accepted: true }] });
    } finally {
      await sender.query("ROLLBACK").catch(() => undefined);
      finisher.release();
      sender.release();
    }
    expect(await rejections(id)).toBe(1);
    await expect(send(2, id, "live-race")).resolves.toBe("stale");
  });
});
