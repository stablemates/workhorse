import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { type BatchHandlerItem, type ClaimedJob, Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { deferred, pool, queue } = createIntegrationTestContext(import.meta.url);

describe("batch handlers", () => {
  it("keeps suspension APIs out of batch-handler contexts", () => {
    type SuspensionMethod =
      | "sleep"
      | "sleepUntil"
      | "waitForSignal"
      | "waitForHuman"
      | "runChild"
      | "runChildren";

    expectTypeOf<
      Extract<keyof BatchHandlerItem["context"], SuspensionMethod>
    >().toEqualTypeOf<never>();
  });

  it("delivers one full priority-ordered batch through the public worker API", async () => {
    const queueName = `batch-full-${randomUUID()}`;
    const seen: number[][] = [];
    const jobs = await Promise.all([
      queue.enqueue("batch-full", { value: 1 }, { queue: queueName, priority: 10 }),
      queue.enqueue("batch-full", { value: 2 }, { queue: queueName, priority: 90 }),
      queue.enqueue("batch-full", { value: 3 }, { queue: queueName, priority: 50 }),
    ]);
    const worker = new Worker(queue, {
      workerId: "batch-full-worker",
      queue: queueName,
      concurrency: 3,
    }).handleBatch<{ value: number }, { value: number }>(
      "batch-full",
      { maxSize: 3, lingerMs: 1_000 },
      (items) => {
        seen.push(items.map((item) => item.payload.value));
        return items.map((item) => ({
          status: "succeeded" as const,
          result: { value: item.payload.value },
        }));
      },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(seen).toEqual([[2, 3, 1]]);
    await expect(Promise.all(jobs.map((id) => queue.getJob(id)))).resolves.toEqual(
      jobs.map((id) => expect.objectContaining({ id, state: "succeeded" })),
    );
  });

  it("settles mixed batch outcomes through independent retry budgets", async () => {
    const queueName = `batch-mixed-${randomUUID()}`;
    const succeededId = await queue.enqueue(
      "batch-mixed",
      { outcome: "succeed" },
      { queue: queueName },
    );
    const retriedId = await queue.enqueue(
      "batch-mixed",
      { outcome: "retry" },
      { queue: queueName, maxAttempts: 2 },
    );
    const failedId = await queue.enqueue(
      "batch-mixed",
      { outcome: "fail" },
      { queue: queueName, maxAttempts: 1 },
    );
    const worker = new Worker(queue, {
      workerId: "batch-mixed-worker",
      queue: queueName,
      concurrency: 3,
      retryDelayMs: 0,
    }).handleBatch<{ outcome: string }, { attempt: number }>(
      "batch-mixed",
      { maxSize: 3, lingerMs: 100 },
      (items) =>
        items.map(({ payload, context }) =>
          payload.outcome === "succeed" || context.job.attempt > 1
            ? {
                status: "succeeded" as const,
                result: { attempt: context.job.attempt },
              }
            : {
                status: "failed" as const,
                error: new Error(`${payload.outcome} on attempt ${context.job.attempt}`),
              },
        ),
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(queue.getJob<{ attempt: number }>(succeededId)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 1,
      result: { attempt: 1 },
    });
    await expect(queue.getJob(retriedId)).resolves.toMatchObject({
      state: "ready",
      currentAttempt: 2,
    });
    await expect(queue.getJob(failedId)).resolves.toMatchObject({
      state: "failed",
      currentAttempt: 1,
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(queue.getJob<{ attempt: number }>(retriedId)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 2,
      result: { attempt: 2 },
    });
    await expect(queue.getJob(failedId)).resolves.toMatchObject({
      state: "failed",
      currentAttempt: 1,
    });
    const attemptCounts = await pool.query<{ job_id: string; attempt_count: string }>(
      `SELECT job_id, count(*)::text AS attempt_count
         FROM workhorse.attempt_history
        WHERE job_id = ANY($1::uuid[])
        GROUP BY job_id`,
      [[succeededId, retriedId, failedId]],
    );
    expect(
      Object.fromEntries(attemptCounts.rows.map((row) => [row.job_id, row.attempt_count])),
    ).toEqual({
      [succeededId]: "1",
      [retriedId]: "2",
      [failedId]: "1",
    });
  });

  it("applies a batch-level handler failure to every member independently", async () => {
    const queueName = `batch-handler-failure-${randomUUID()}`;
    const jobIds = await Promise.all(
      [1, 2].map((value) =>
        queue.enqueue("batch-handler-failure", { value }, { queue: queueName, maxAttempts: 1 }),
      ),
    );
    const worker = new Worker(queue, {
      workerId: "batch-handler-failure-worker",
      queue: queueName,
      concurrency: 2,
    }).handleBatch("batch-handler-failure", { maxSize: 2, lingerMs: 100 }, () => {
      throw new Error("provider batch failed");
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(Promise.all(jobIds.map((id) => queue.getJob(id)))).resolves.toEqual(
      jobIds.map(() =>
        expect.objectContaining({
          state: "failed",
          currentAttempt: 1,
          error: expect.objectContaining({ message: "provider batch failed" }),
        }),
      ),
    );

    const dispatches = await pool.query<{
      job_id: string;
      attempt: number;
      batch_id: string;
      batch_size: number;
      members: Array<{ job_id: string; attempt: number }>;
    }>(
      `SELECT job_id::text, attempt, details->>'batch_id' AS batch_id,
              (details->>'size')::integer AS batch_size, details->'members' AS members
         FROM workhorse.job_event
        WHERE job_id = ANY($1::uuid[]) AND event_type = 'batch_dispatched'
        ORDER BY job_id`,
      [jobIds],
    );
    expect(dispatches.rows).toHaveLength(2);
    expect(new Set(dispatches.rows.map((row) => row.batch_id)).size).toBe(1);
    const orderedMembers = dispatches.rows[0]!.members;
    expect(new Set(orderedMembers.map((member) => member.job_id))).toEqual(new Set(jobIds));
    expect(orderedMembers.map((member) => member.attempt)).toEqual([1, 1]);
    expect(dispatches.rows).toEqual(
      expect.arrayContaining(
        jobIds.map((jobId) =>
          expect.objectContaining({
            job_id: jobId,
            attempt: 1,
            batch_size: 2,
            members: orderedMembers,
          }),
        ),
      ),
    );
    const failures = await pool.query<{ job_id: string; batch_id: string }>(
      `SELECT job_id::text, details->>'batch_id' AS batch_id
         FROM workhorse.job_event
        WHERE job_id = ANY($1::uuid[]) AND event_type = 'batch_failed'
        ORDER BY job_id`,
      [jobIds],
    );
    expect(failures.rows).toEqual(
      dispatches.rows.map(({ job_id, batch_id }) => ({ job_id, batch_id })),
    );
  });

  it("runs the shared callback when dispatch evidence cannot be persisted", async () => {
    const queueName = `batch-evidence-failure-${randomUUID()}`;
    const jobIds = await Promise.all(
      [1, 2].map((value) =>
        queue.enqueue("batch-evidence-failure", { value }, { queue: queueName }),
      ),
    );
    const evidence = vi
      .spyOn(queue, "recordBatchDispatch")
      .mockRejectedValueOnce(new Error("evidence unavailable"));
    const handler = vi.fn<
      (items: readonly BatchHandlerItem[]) => Array<{ status: "succeeded"; result: null }>
    >((items) => items.map(() => ({ status: "succeeded", result: null })));
    const worker = new Worker(queue, {
      workerId: "batch-evidence-failure-worker",
      queue: queueName,
      concurrency: 2,
    }).handleBatch("batch-evidence-failure", { maxSize: 2, lingerMs: 100 }, handler);

    try {
      await expect(worker.runOnce()).resolves.toBe(true);
      expect(handler).toHaveBeenCalledOnce();
      await expect(Promise.all(jobIds.map((id) => queue.getJob(id)))).resolves.toEqual(
        jobIds.map(() => expect.objectContaining({ state: "succeeded" })),
      );
    } finally {
      evidence.mockRestore();
    }
  });

  it("records a dispatched member from its retained claim after ownership changes", async () => {
    const queueName = `batch-retained-claim-${randomUUID()}`;
    const jobId = await queue.enqueue(
      "batch-retained-claim",
      {},
      { queue: queueName, maxAttempts: 2 },
    );
    const claimed = await queue.claim("batch-retained-claim-worker", {
      queue: queueName,
      leaseMs: 100,
    });
    expect(claimed).not.toBeNull();
    await sleep(120);
    await expect(queue.recoverExpired(1, 0)).resolves.toBe(1);

    await expect(
      queue.recordBatchDispatch({
        batchId: randomUUID(),
        jobs: [claimed!],
        workerId: "batch-retained-claim-worker",
      }),
    ).resolves.toBeUndefined();
    await expect(
      pool.query(
        `SELECT 1 FROM workhorse.job_event
          WHERE job_id = $1 AND attempt = 1 AND event_type = 'batch_dispatched'`,
        [jobId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("records retried batch evidence once per member", async () => {
    const queueName = `batch-evidence-retry-${randomUUID()}`;
    await Promise.all(
      [1, 2, 3].map((value) =>
        queue.enqueue("batch-evidence-retry", { value }, { queue: queueName }),
      ),
    );
    const jobs = await Promise.all([
      queue.claim("batch-evidence-retry-worker", { queue: queueName }),
      queue.claim("batch-evidence-retry-worker", { queue: queueName }),
      queue.claim("batch-evidence-retry-worker", { queue: queueName }),
    ]);
    expect(jobs).not.toContain(null);
    const batch = {
      batchId: randomUUID(),
      jobs: [jobs[0]!, jobs[1]!] as [ClaimedJob, ClaimedJob],
      workerId: "batch-evidence-retry-worker",
    };

    await queue.recordBatchDispatch(batch);
    await queue.recordBatchDispatch(batch);
    await expect(
      queue.recordBatchFailure({ ...batch, jobs: [jobs[0]!, jobs[2]!] }),
    ).rejects.toThrow("batch id already records different evidence");
    await queue.recordBatchFailure(batch);
    await queue.recordBatchFailure(batch);

    const evidence = await pool.query<{ event_type: string; event_count: number }>(
      `SELECT event_type, count(*)::integer AS event_count
         FROM workhorse.job_event
        WHERE details->>'batch_id' = $1
        GROUP BY event_type
        ORDER BY event_type`,
      [batch.batchId],
    );
    expect(evidence.rows).toEqual([
      { event_type: "batch_dispatched", event_count: 2 },
      { event_type: "batch_failed", event_count: 2 },
    ]);
  });

  it("rejects every member when the handler omits an outcome payload", async () => {
    const queueName = `batch-invalid-outcome-${randomUUID()}`;
    const jobIds = await Promise.all(
      [1, 2].map((value) =>
        queue.enqueue("batch-invalid-outcome", { value }, { queue: queueName, maxAttempts: 1 }),
      ),
    );
    const worker = new Worker(queue, {
      workerId: "batch-invalid-outcome-worker",
      queue: queueName,
      concurrency: 2,
    }).handleBatch(
      "batch-invalid-outcome",
      { maxSize: 2, lingerMs: 100 },
      (items) => items.map(() => ({ status: "succeeded" })) as never,
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(Promise.all(jobIds.map((id) => queue.getJob(id)))).resolves.toEqual(
      jobIds.map(() =>
        expect.objectContaining({
          state: "failed",
          error: expect.objectContaining({ message: expect.stringContaining("invalid outcome") }),
        }),
      ),
    );
  });

  it("recovers and fences one lost batch member without corrupting its peer", async () => {
    const queueName = `batch-isolation-${randomUUID()}`;
    const staleId = await queue.enqueue(
      "batch-isolation",
      { outcome: "stale" },
      { queue: queueName, maxAttempts: 2 },
    );
    const succeededId = await queue.enqueue(
      "batch-isolation",
      { outcome: "succeed" },
      { queue: queueName },
    );
    const workerId = "batch-isolation-worker";
    const heartbeatStatus = queue.heartbeatStatus.bind(queue);
    const heartbeat = vi
      .spyOn(queue, "heartbeatStatus")
      .mockImplementation((job, owner, leaseMs) =>
        job.id === staleId ? Promise.resolve("accepted") : heartbeatStatus(job, owner, leaseMs),
      );
    const worker = new Worker(queue, {
      workerId,
      queue: queueName,
      concurrency: 2,
      leaseMs: 100,
      heartbeatMs: 20,
    }).handleBatch<{ outcome: string }, { source: string }>(
      "batch-isolation",
      { maxSize: 2, lingerMs: 100 },
      async (items) => {
        const stale = items.find(({ payload }) => payload.outcome === "stale")!;
        await sleep(140);
        await expect(queue.recoverExpired(100, 0)).resolves.toBe(1);
        const reclaimed = await queue.claim("batch-isolation-reclaimer", {
          queue: queueName,
          leaseMs: 1_000,
        });
        expect(reclaimed).toMatchObject({ id: staleId, attempt: 2 });
        expect(reclaimed!.fenceToken).toBeGreaterThan(stale.context.job.fenceToken);
        await expect(
          queue.complete(reclaimed!, "batch-isolation-reclaimer", { source: "reclaimed" }),
        ).resolves.toBe(true);
        return items.map(() => ({
          status: "succeeded" as const,
          result: { source: "handler" },
        }));
      },
    );

    try {
      await expect(worker.runOnce()).resolves.toBe(true);
      await expect(queue.getJob<{ source: string }>(staleId)).resolves.toMatchObject({
        state: "succeeded",
        currentAttempt: 2,
        result: { source: "reclaimed" },
      });
      await expect(queue.getJob<{ source: string }>(succeededId)).resolves.toMatchObject({
        state: "succeeded",
        currentAttempt: 1,
        result: { source: "handler" },
        error: null,
      });
    } finally {
      heartbeat.mockRestore();
    }
  });

  it("cancels one active batch member without canceling its peer", async () => {
    const queueName = `batch-cancel-${randomUUID()}`;
    const canceledId = await queue.enqueue(
      "batch-cancel",
      { outcome: "cancel" },
      { queue: queueName },
    );
    const succeededId = await queue.enqueue(
      "batch-cancel",
      { outcome: "succeed" },
      { queue: queueName },
    );
    const worker = new Worker(queue, {
      workerId: "batch-cancel-worker",
      queue: queueName,
      concurrency: 2,
      leaseMs: 1_000,
      heartbeatMs: 20,
    }).handleBatch<{ outcome: string }, null>(
      "batch-cancel",
      { maxSize: 2, lingerMs: 100 },
      async (items) => {
        const canceled = items.find(({ payload }) => payload.outcome === "cancel")!;
        await queue.cancel(canceled.context.job.id, { requestedBy: "batch-test" });
        await vi.waitFor(() => expect(canceled.context.signal.aborted).toBe(true));
        return items.map(() => ({ status: "succeeded", result: null }));
      },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(queue.getJob(canceledId)).resolves.toMatchObject({ state: "canceled" });
    await expect(queue.getJob(succeededId)).resolves.toMatchObject({
      state: "succeeded",
      error: null,
    });
  });

  it("expires one batch member without timing out its peer", async () => {
    const queueName = `batch-timeout-${randomUUID()}`;
    const timedOutId = await queue.enqueue(
      "batch-timeout",
      { duration: "short" },
      { queue: queueName, executionTimeoutMs: 20, maxAttempts: 1 },
    );
    const succeededId = await queue.enqueue(
      "batch-timeout",
      { duration: "long" },
      { queue: queueName, executionTimeoutMs: 1_000 },
    );
    const worker = new Worker(queue, {
      workerId: "batch-timeout-worker",
      queue: queueName,
      concurrency: 2,
    }).handleBatch<{ duration: string }, null>(
      "batch-timeout",
      { maxSize: 2, lingerMs: 100 },
      async (items) => {
        await sleep(50);
        return items.map(() => ({ status: "succeeded", result: null }));
      },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(queue.getJob(timedOutId)).resolves.toMatchObject({ state: "failed" });
    await expect(queue.getJob(succeededId)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("expires one batch member's deadline without failing its peer", async () => {
    const queueName = `batch-deadline-${randomUUID()}`;
    const deadlineId = await queue.enqueue(
      "batch-deadline",
      { deadline: true },
      { queue: queueName, deadline: new Date(Date.now() + 200), maxAttempts: 1 },
    );
    const succeededId = await queue.enqueue(
      "batch-deadline",
      { deadline: false },
      { queue: queueName },
    );
    const worker = new Worker(queue, {
      workerId: "batch-deadline-worker",
      queue: queueName,
      concurrency: 2,
    }).handleBatch<{ deadline: boolean }, null>(
      "batch-deadline",
      { maxSize: 2, lingerMs: 100 },
      async (items) => {
        await sleep(250);
        return items.map(() => ({ status: "succeeded", result: null }));
      },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(queue.getJob(deadlineId)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "DeadlineExceeded" }),
    });
    await expect(queue.getJob(succeededId)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("admits and accounts for policy-limited batch members one job at a time", async () => {
    const queueName = `batch-policy-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("batch-policy-test", [
      { queue: queueName, maxActive: 2, maxActivePerKey: 1 },
    ]);
    await queue.syncRateLimitPolicies("batch-policy-test", [
      {
        queue: queueName,
        rate: { limit: 2, intervalMs: 100, burst: 2 },
        perKey: { limit: 1, intervalMs: 100, burst: 1 },
      },
    ]);
    for (const [value, priority, concurrencyKey] of [
      [1, 100, "shared"],
      [2, 90, "shared"],
      [3, 80, "other"],
      [4, 70, null],
    ] as const) {
      await queue.enqueue(
        "batch-policy",
        { value },
        {
          queue: queueName,
          priority,
          ...(concurrencyKey === null ? {} : { concurrencyKey }),
        },
      );
    }
    const batches: number[][] = [];
    const worker = new Worker(queue, {
      workerId: "batch-policy-worker",
      queue: queueName,
      concurrency: 4,
      pollMs: 10,
    }).handleBatch<{ value: number }, null>(
      "batch-policy",
      { maxSize: 4, lingerMs: 20 },
      (items) => {
        batches.push(items.map(({ payload }) => payload.value));
        return items.map(() => ({ status: "succeeded", result: null }));
      },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(worker.runOnce()).resolves.toBe(false);
    await sleep(120);
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(batches).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  it("drains an active batch without claiming another member", async () => {
    const queueName = `batch-drain-${randomUUID()}`;
    const jobIds = await Promise.all(
      [1, 2, 3].map((value) => queue.enqueue("batch-drain", { value }, { queue: queueName })),
    );
    const entered = deferred();
    const release = deferred();
    const worker = new Worker(queue, {
      workerId: "batch-drain-worker",
      queue: queueName,
      concurrency: 2,
      pollMs: 10,
      registryIntervalMs: 0,
    }).handleBatch<{ value: number }, null>(
      "batch-drain",
      { maxSize: 2, lingerMs: 100 },
      async (items) => {
        entered.resolve();
        await release.promise;
        return items.map(() => ({ status: "succeeded", result: null }));
      },
    );

    const running = worker.run();
    await entered.promise;
    worker.stop();
    expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, draining: true });
    release.resolve();
    await running;

    const states = (await Promise.all(jobIds.map((id) => queue.getJob(id)))).map(
      (job) => job?.state,
    );
    expect(states.filter((state) => state === "succeeded")).toHaveLength(2);
    expect(states.filter((state) => state === "ready")).toHaveLength(1);
  });

  it("dispatches a partial batch after its linger bound without notification support", async () => {
    const queueName = `batch-partial-${randomUUID()}`;
    const batches: number[][] = [];
    await queue.enqueue("batch-partial", { value: 1 }, { queue: queueName });
    await queue.enqueue("batch-partial", { value: 2 }, { queue: queueName });
    const worker = new Worker(queue, {
      workerId: "batch-partial-worker",
      queue: queueName,
      concurrency: 3,
    }).handleBatch<{ value: number }, null>(
      "batch-partial",
      { maxSize: 3, lingerMs: 40 },
      (items) => {
        batches.push(items.map((item) => item.payload.value));
        return items.map(() => ({ status: "succeeded", result: null }));
      },
    );

    const startedAt = Date.now();
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
    expect(batches).toEqual([[1, 2]]);
  });

  it("keeps job types separate while filling batch handlers", async () => {
    const queueName = `batch-types-${randomUUID()}`;
    const batches: string[][] = [];
    for (const [type, value] of [
      ["batch-a", "a1"],
      ["batch-b", "b1"],
      ["batch-a", "a2"],
      ["batch-b", "b2"],
    ] as const) {
      await queue.enqueue(type, { value }, { queue: queueName });
    }
    const worker = new Worker(queue, {
      workerId: "batch-types-worker",
      queue: queueName,
      concurrency: 4,
    })
      .handleBatch<{ value: string }, null>("batch-a", { maxSize: 2, lingerMs: 100 }, (items) => {
        batches.push(items.map((item) => item.payload.value));
        return items.map(() => ({ status: "succeeded", result: null }));
      })
      .handleBatch<{ value: string }, null>("batch-b", { maxSize: 2, lingerMs: 100 }, (items) => {
        batches.push(items.map((item) => item.payload.value));
        return items.map(() => ({ status: "succeeded", result: null }));
      });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(batches).toEqual([
      ["a1", "a2"],
      ["b1", "b2"],
    ]);
  });

  it("does not duplicate batch members under competing workers", async () => {
    const queueName = `batch-competing-${randomUUID()}`;
    const handled: number[] = [];
    const jobIds = await Promise.all(
      Array.from({ length: 8 }, (_, value) =>
        queue.enqueue("batch-competing", { value }, { queue: queueName }),
      ),
    );
    const createWorker = (workerId: string) =>
      new Worker(queue, { workerId, queue: queueName, concurrency: 4 }).handleBatch<
        { value: number },
        null
      >("batch-competing", { maxSize: 4, lingerMs: 20 }, (items) => {
        handled.push(...items.map((item) => item.payload.value));
        return items.map(() => ({ status: "succeeded", result: null }));
      });

    await expect(
      Promise.all([
        createWorker("batch-competitor-a").runOnce(),
        createWorker("batch-competitor-b").runOnce(),
      ]),
    ).resolves.toEqual([true, true]);
    expect(handled).toHaveLength(8);
    expect(new Set(handled)).toEqual(new Set(Array.from({ length: 8 }, (_, value) => value)));
    await expect(Promise.all(jobIds.map((id) => queue.getJob(id)))).resolves.toEqual(
      jobIds.map((id) => expect.objectContaining({ id, state: "succeeded" })),
    );
  });

  it("validates batch size and linger against worker capacity", () => {
    const worker = new Worker(queue, { concurrency: 2 });
    expect(() =>
      worker.handleBatch("invalid", { maxSize: 0, lingerMs: 1 }, () => [
        { status: "succeeded", result: null },
      ]),
    ).toThrow("maxSize must be a safe integer between 1 and 100");
    expect(() =>
      worker.handleBatch("invalid", { maxSize: 3, lingerMs: 1 }, () => [
        { status: "succeeded", result: null },
      ]),
    ).toThrow("maxSize must not exceed worker concurrency");
    expect(() =>
      worker.handleBatch("invalid", { maxSize: 2, lingerMs: -1 }, () => [
        { status: "succeeded", result: null },
      ]),
    ).toThrow("lingerMs must be a safe integer between 0 and 60000");
  });

  it("snapshots validated batch configuration at registration", async () => {
    const queueName = `batch-options-${randomUUID()}`;
    const options = { maxSize: 2, lingerMs: 100 };
    const batches: number[][] = [];
    const worker = new Worker(queue, {
      workerId: "batch-options-worker",
      queue: queueName,
      concurrency: 2,
    }).handleBatch<{ value: number }, null>("batch-options", options, (items) => {
      batches.push(items.map((item) => item.payload.value));
      return items.map(() => ({ status: "succeeded", result: null }));
    });
    options.maxSize = 0;
    options.lingerMs = 60_001;
    await queue.enqueue("batch-options", { value: 1 }, { queue: queueName });
    await queue.enqueue("batch-options", { value: 2 }, { queue: queueName });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(batches).toEqual([[1, 2]]);
  });
});
