import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  CancellationRequestedError,
  DeadlineExceededError,
  ExecutionTimeoutError,
  type Json,
  Queue,
  Worker,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { deferred, pool, queue } = createIntegrationTestContext(import.meta.url);

describe("claim lease fence", () => {
  it("validates cancellation metadata and idempotently cancels never-started jobs", async () => {
    const readyId = await queue.enqueue("cancel-ready", { value: 1 });
    await expect(queue.cancel(readyId, { requestedBy: "" })).rejects.toThrow(
      "requested_by must contain between 1 and 200 characters",
    );
    await expect(queue.cancel(readyId, { requestedBy: "x".repeat(201) })).rejects.toThrow(
      "requested_by must contain between 1 and 200 characters",
    );
    await expect(queue.cancel(readyId, { reason: "" })).rejects.toThrow(
      "reason must contain between 1 and 2000 characters",
    );
    await expect(queue.cancel(readyId, { reason: "x".repeat(2001) })).rejects.toThrow(
      "reason must contain between 1 and 2000 characters",
    );

    const first = await queue.cancel(readyId, {
      requestedBy: "integration-test",
      reason: "no longer needed",
    });
    expect(first).toMatchObject({
      status: "canceled",
      jobId: readyId,
      state: "canceled",
      currentAttempt: 1,
      requestedBy: "integration-test",
      reason: "no longer needed",
    });
    expect(first.requestedAt).toBeInstanceOf(Date);
    expect(first.finishedAt).toBeInstanceOf(Date);

    const repeated = await queue.cancel(readyId, {
      requestedBy: "ignored-retry",
      reason: "ignored retry metadata",
    });
    expect(repeated).toEqual(first);
    expect(await queue.getJob(readyId)).toMatchObject({
      state: "canceled",
      currentAttempt: 1,
      fenceToken: 0n,
      error: {
        name: "CancellationRequested",
        message: "job cancellation was requested",
        requested_by: "integration-test",
        reason: "no longer needed",
      },
    });

    const scheduledId = await queue.enqueue("cancel-scheduled", null, {
      runAt: new Date(Date.now() + 60_000),
    });
    expect((await queue.cancel(scheduledId)).status).toBe("canceled");
    const neverStarted = await pool.query<{ job_id: string; attempts: number; events: number }>(
      `SELECT job.id AS job_id,
              (SELECT count(*)::integer FROM workhorse.attempt_history history
                WHERE history.job_id = job.id) AS attempts,
              (SELECT count(*)::integer FROM workhorse.job_event event
                WHERE event.job_id = job.id AND event.event_type = 'canceled') AS events
         FROM workhorse.job job WHERE job.id = ANY($1::uuid[]) ORDER BY job.id`,
      [[readyId, scheduledId]],
    );
    expect(neverStarted.rows).toHaveLength(2);
    expect(neverStarted.rows).toEqual(
      expect.arrayContaining([
        { job_id: readyId, attempts: 0, events: 1 },
        { job_id: scheduledId, attempts: 0, events: 1 },
      ]),
    );

    const missing = await queue.cancel("00000000-0000-4000-8000-000000000001");
    expect(missing).toEqual({
      status: "not_found",
      jobId: "00000000-0000-4000-8000-000000000001",
      state: null,
      currentAttempt: null,
      requestedAt: null,
      requestedBy: null,
      reason: null,
      finishedAt: null,
    });

    const succeededId = await queue.enqueue("already-terminal", null);
    const succeeded = await queue.claim("terminal-worker", { leaseMs: 5_000 });
    expect(succeeded?.id).toBe(succeededId);
    expect(await queue.complete(succeeded!, "terminal-worker", { ok: true })).toBe(true);
    expect(await queue.cancel(succeededId)).toMatchObject({
      status: "already_terminal",
      state: "succeeded",
      currentAttempt: 1,
      requestedAt: null,
    });
  });

  it("cancels a durable wait with the latest retained claim attribution", async () => {
    const id = await queue.enqueue("cancel-wait", null);
    const firstClaim = await queue.claim("wait-cancel-worker-1", { leaseMs: 5_000 });
    expect(firstClaim?.id).toBe(id);
    const originalClaim = await pool.query<{ attempt_started_at: Date; acquired_at: Date }>(
      `SELECT attempt_started_at, acquired_at FROM workhorse.job_runtime WHERE job_id = $1`,
      [id],
    );
    expect(
      await queue.scheduleWait(firstClaim!, "wait-cancel-worker-1", "first-pause", {
        durationMs: 1,
      }),
    ).toMatchObject({ status: "scheduled" });
    await sleep(10);
    expect(await queue.promote()).toBe(1);
    const continuation = await queue.claim("wait-cancel-worker-2", { leaseMs: 5_000 });
    expect(continuation?.id).toBe(id);
    const latestClaim = await pool.query<{ acquired_at: Date }>(
      `SELECT acquired_at FROM workhorse.job_runtime WHERE job_id = $1`,
      [id],
    );
    const scheduled = await queue.scheduleWait(
      continuation!,
      "wait-cancel-worker-2",
      "second-pause",
      {
        durationMs: 60_000,
      },
    );
    expect(scheduled.status).toBe("scheduled");

    expect(await queue.cancel(id, { reason: "timer is obsolete" })).toMatchObject({
      status: "canceled",
      state: "canceled",
      currentAttempt: 1,
      reason: "timer is obsolete",
    });
    const history = await pool.query<{
      attempt: number;
      fence_token: string;
      worker_id: string;
      outcome: string;
      started_at: Date;
      claimed_at: Date;
    }>(
      `SELECT attempt, fence_token::text, worker_id, outcome, started_at, claimed_at
         FROM workhorse.attempt_history WHERE job_id = $1`,
      [id],
    );
    expect(history.rows).toEqual([
      {
        attempt: 1,
        fence_token: continuation!.fenceToken.toString(),
        worker_id: "wait-cancel-worker-2",
        outcome: "canceled",
        started_at: originalClaim.rows[0]!.attempt_started_at,
        claimed_at: latestClaim.rows[0]!.acquired_at,
      },
    ]);
  });

  it("requests active cancellation once and fences every later owner write", async () => {
    const id = await queue.enqueue("cancel-active", null, { maxAttempts: 2 });
    const claimed = await queue.claim("active-cancel-worker", { leaseMs: 5_000 });
    expect(claimed?.id).toBe(id);

    const first = await queue.cancel(id, { requestedBy: "operator-7", reason: "superseded" });
    expect(first).toMatchObject({
      status: "cancel_requested",
      state: "active",
      currentAttempt: 1,
      requestedBy: "operator-7",
      reason: "superseded",
      finishedAt: null,
    });
    expect(await queue.cancel(id, { requestedBy: "operator-8", reason: "duplicate" })).toEqual(
      first,
    );
    expect(await queue.getJob(id)).toMatchObject({
      state: "active",
      cancelRequestedAt: first.requestedAt,
      cancelRequestedBy: "operator-7",
      cancelReason: "superseded",
    });
    expect(await queue.heartbeatStatus(claimed!, "active-cancel-worker", 5_000)).toBe(
      "cancel_requested",
    );
    expect(await queue.heartbeat(claimed!, "active-cancel-worker", 5_000)).toBe(false);
    expect(await queue.complete(claimed!, "active-cancel-worker", null)).toBe(false);
    expect(await queue.fail(claimed!, "active-cancel-worker", new Error("late failure"), 0)).toBe(
      "cancel_requested",
    );
    await expect(
      queue.saveCheckpoint(claimed!, "active-cancel-worker", "late", { value: 1 }),
    ).rejects.toThrow("stale or expired");
    await expect(
      queue.scheduleWait(claimed!, "active-cancel-worker", "late", { durationMs: 1_000 }),
    ).rejects.toThrow("stale or expired");

    const requestEvents = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'cancel_requested'`,
      [id],
    );
    expect(requestEvents.rows[0]?.count).toBe(1);
    expect(await queue.acknowledgeCancel(claimed!, "active-cancel-worker")).toBe(true);
    expect(await queue.acknowledgeCancel(claimed!, "active-cancel-worker")).toBe(false);
    expect(await queue.getJob(id)).toMatchObject({
      state: "canceled",
      cancelRequestedAt: null,
      cancelRequestedBy: null,
      cancelReason: null,
    });
    expect(await queue.heartbeatStatus(claimed!, "active-cancel-worker", 5_000)).toBe("stale");
    expect(await queue.complete(claimed!, "active-cancel-worker", null)).toBe(false);
    expect(await queue.fail(claimed!, "active-cancel-worker", new Error("stale"), 0)).toBe("stale");
    const terminalRows = await pool.query<{ events: number; attempts: number }>(
      `SELECT
        (SELECT count(*)::integer FROM workhorse.job_event
          WHERE job_id = $1 AND event_type = 'canceled') AS events,
        (SELECT count(*)::integer FROM workhorse.attempt_history
          WHERE job_id = $1 AND outcome = 'canceled') AS attempts`,
      [id],
    );
    expect(terminalRows.rows[0]).toEqual({ events: 1, attempts: 1 });
  });

  it("delivers CancellationRequestedError and acknowledges cooperative handler settlement", async () => {
    const started = deferred();
    const aborted = deferred<unknown>();
    const id = await queue.enqueue("cooperative-cancel", null);
    const worker = new Worker(queue, {
      workerId: "cooperative-cancel-worker",
      leaseMs: 5_000,
      heartbeatMs: 100,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
    }).handle("cooperative-cancel", async (_payload, context) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          aborted.resolve(context.signal.reason);
          reject(context.signal.reason);
        };
        if (context.signal.aborted) onAbort();
        else context.signal.addEventListener("abort", onAbort, { once: true });
      });
      return null;
    });

    const execution = worker.runOnce();
    await started.promise;
    expect((await queue.cancel(id)).status).toBe("cancel_requested");
    expect(await aborted.promise).toBeInstanceOf(CancellationRequestedError);
    await execution;
    expect(await queue.getJob(id)).toMatchObject({ state: "canceled" });
  });

  it("acknowledges cancellation after a default-concurrency handler ignores AbortSignal", async () => {
    const started = deferred();
    const aborted = deferred<unknown>();
    const release = deferred();
    const id = await queue.enqueue("ignore-cancel", null);
    const worker = new Worker(queue, {
      workerId: "ignore-cancel-worker",
      leaseMs: 5_000,
      heartbeatMs: 100,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
    }).handle("ignore-cancel", async (_payload, context) => {
      expect(worker.concurrency).toBe(1);
      started.resolve();
      context.signal.addEventListener("abort", () => aborted.resolve(context.signal.reason), {
        once: true,
      });
      await release.promise;
      return { ignored: true };
    });

    const execution = worker.runOnce();
    await started.promise;
    await queue.cancel(id);
    expect(await aborted.promise).toBeInstanceOf(CancellationRequestedError);
    expect(await queue.getJob(id)).toMatchObject({ state: "active" });
    release.resolve();
    await execution;
    expect(await queue.getJob(id)).toMatchObject({ state: "canceled", result: null });
  });

  it("materializes cancellation while a handler is scheduling a durable wait", async () => {
    const schedulingStarted = deferred();
    const releaseScheduling = deferred();
    const racingQueue = new Proxy(queue, {
      get(target, property, receiver) {
        if (property !== "scheduleWait") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<Queue["scheduleWait"]>) => {
          schedulingStarted.resolve();
          await releaseScheduling.promise;
          return target.scheduleWait(...args);
        };
      },
    });
    const id = await queue.enqueue("cancel-during-wait", null);
    const worker = new Worker(racingQueue, {
      workerId: "cancel-during-wait-worker",
      leaseMs: 5_000,
      heartbeatMs: 1_000,
    }).handle("cancel-during-wait", async (_payload, context) => {
      await context.sleep("blocked-wait", 60_000);
      return { shouldNotComplete: true };
    });

    const execution = worker.runOnce();
    try {
      await schedulingStarted.promise;
      expect(await queue.cancel(id)).toMatchObject({ status: "cancel_requested" });
      releaseScheduling.resolve();
      await expect(execution).resolves.toBe(true);
    } finally {
      releaseScheduling.resolve();
      await execution.catch(() => undefined);
    }

    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "canceled", result: null });
    await expect(queue.listWaits(id)).resolves.toEqual([]);
  });

  it("isolates cancellation across concurrent default-concurrency workers", async () => {
    const ids = await Promise.all([
      queue.enqueue("concurrent-worker-cancel", { sequence: 1 }),
      queue.enqueue("concurrent-worker-cancel", { sequence: 2 }),
    ]);
    const started = new Set<string>();
    const bothStarted = deferred();
    const canceledSignal = deferred<unknown>();
    const releaseSibling = deferred();
    const handler = async (
      _payload: unknown,
      context: { job: { id: string }; signal: AbortSignal },
    ) => {
      started.add(context.job.id);
      if (started.size === 2) bothStarted.resolve();
      if (context.job.id === ids[0]) {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              canceledSignal.resolve(context.signal.reason);
              reject(context.signal.reason);
            },
            { once: true },
          );
        });
      } else {
        await releaseSibling.promise;
      }
      return null;
    };
    const firstWorker = new Worker(queue, {
      workerId: "concurrent-cancel-a",
      leaseMs: 5_000,
      heartbeatMs: 100,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
    }).handle("concurrent-worker-cancel", handler);
    const secondWorker = new Worker(queue, {
      workerId: "concurrent-cancel-b",
      leaseMs: 5_000,
      heartbeatMs: 100,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
    }).handle("concurrent-worker-cancel", handler);

    expect(firstWorker.concurrency).toBe(1);
    expect(secondWorker.concurrency).toBe(1);
    const running = Promise.all([firstWorker.runOnce(), secondWorker.runOnce()]);
    try {
      await bothStarted.promise;
      expect((await queue.cancel(ids[0]!)).status).toBe("cancel_requested");
      expect(await canceledSignal.promise).toBeInstanceOf(CancellationRequestedError);
      releaseSibling.resolve();
      await running;
      expect(await Promise.all(ids.map((id) => queue.getJob(id)))).toEqual([
        expect.objectContaining({ id: ids[0], state: "canceled" }),
        expect.objectContaining({ id: ids[1], state: "succeeded" }),
      ]);
    } finally {
      releaseSibling.resolve();
      await queue.cancel(ids[0]!).catch(() => undefined);
      await running.catch(() => undefined);
    }
  });

  it("materializes expired requested cancellation instead of retrying and rejects stale fencing", async () => {
    const id = await queue.enqueue("recover-cancel", null, { maxAttempts: 3 });
    const claimed = await queue.claim("recover-cancel-worker", { leaseMs: 5_000 });
    expect(claimed?.id).toBe(id);
    expect((await queue.cancel(id)).status).toBe("cancel_requested");
    await pool.query(
      `UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 second'
        WHERE job_id = $1`,
      [id],
    );
    expect(await queue.acknowledgeCancel(claimed!, "recover-cancel-worker")).toBe(false);
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(id)).toMatchObject({ state: "canceled", currentAttempt: 1 });
    expect(await queue.heartbeatStatus(claimed!, "recover-cancel-worker", 5_000)).toBe("stale");
    expect(await queue.complete(claimed!, "recover-cancel-worker", null)).toBe(false);
    expect(await queue.fail(claimed!, "recover-cancel-worker", new Error("late"), 0)).toBe("stale");
    const history = await pool.query<{ attempt: number; outcome: string }>(
      "SELECT attempt, outcome FROM workhorse.attempt_history WHERE job_id = $1",
      [id],
    );
    expect(history.rows).toEqual([{ attempt: 1, outcome: "canceled" }]);
  });

  it("validates, persists, and idempotently fingerprints deadlines and execution timeouts", async () => {
    const deadline = new Date(Date.now() + 60_000);
    const options = {
      deadline,
      executionTimeoutMs: 2_500,
      idempotency: { key: "deadline-definition", scope: "p1-03" },
    } as const;
    const first = await queue.enqueue("deadline-definition", { value: 1 }, options);
    expect(await queue.enqueue("deadline-definition", { value: 1 }, options)).toBe(first);
    expect(await queue.getJob(first)).toMatchObject({
      deadlineAt: deadline,
      executionTimeoutMs: 2_500,
    });
    await expect(
      queue.enqueue(
        "deadline-definition",
        { value: 1 },
        {
          ...options,
          executionTimeoutMs: 2_501,
        },
      ),
    ).rejects.toMatchObject({
      conflictingFields: ["executionTimeoutMs"],
    });
    await expect(
      queue.enqueue(
        "deadline-definition",
        { value: 1 },
        { ...options, deadline: new Date(deadline.getTime() + 1) },
      ),
    ).rejects.toMatchObject({ conflictingFields: ["deadline"] });
    await expect(
      pool.query(
        `SELECT * FROM workhorse.enqueue_many_v1(
          '[{"queue":"default","type":"invalid-timeout","executionTimeoutMs":0}]'::jsonb
        )`,
      ),
    ).rejects.toThrow(/executionTimeoutMs must be an integer/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.enqueue_many_v1(
          '[{"queue":"default","type":"invalid-deadline","deadline":"infinity"}]'::jsonb
        )`,
      ),
    ).rejects.toThrow(/deadline must be a finite absolute timestamp/);

    const expired = await queue.enqueue("already-expired", null, {
      queue: "expired-deadline-only",
      deadline: new Date(Date.now() - 1_000),
      maxAttempts: 5,
    });
    expect(
      await queue.claim("expired-deadline-worker", { queue: "expired-deadline-only" }),
    ).toBeNull();
    expect(await queue.getJob(expired)).toMatchObject({
      state: "failed",
      currentAttempt: 1,
      fenceToken: 0n,
      error: { name: "DeadlineExceeded" },
    });
    const evidence = await pool.query<{ event_type: string; outcome: string | null }>(
      `SELECT event.event_type, history.outcome
         FROM workhorse.job_event event
         LEFT JOIN workhorse.attempt_history history ON history.job_id = event.job_id
        WHERE event.job_id = $1 AND event.event_type = 'deadline_exceeded'`,
      [expired],
    );
    expect(evidence.rows).toEqual([{ event_type: "deadline_exceeded", outcome: null }]);
  });

  it("cooperatively aborts active deadlines and durably fences handlers that ignore the signal", async () => {
    const started = deferred();
    const aborted = deferred<unknown>();
    const release = deferred();
    const id = await queue.enqueue("ignored-deadline", null, {
      deadline: new Date(Date.now() + 150),
      maxAttempts: 4,
    });
    const worker = new Worker(queue, {
      workerId: "ignored-deadline-worker",
      leaseMs: 5_000,
      heartbeatMs: 50,
    }).handle("ignored-deadline", async (_payload, context) => {
      started.resolve();
      context.signal.addEventListener("abort", () => aborted.resolve(context.signal.reason), {
        once: true,
      });
      await release.promise;
      return { tooLate: true };
    });

    const execution = worker.runOnce();
    await started.promise;
    expect(await aborted.promise).toBeInstanceOf(DeadlineExceededError);
    await sleep(25);
    expect(await queue.getJob(id)).toMatchObject({
      state: "failed",
      currentAttempt: 1,
      result: null,
      error: { name: "DeadlineExceeded" },
    });
    release.resolve();
    await execution;
    const evidence = await pool.query<{ event_type: string; outcome: string }>(
      `SELECT event.event_type, history.outcome
         FROM workhorse.job_event event
         JOIN workhorse.attempt_history history
           ON history.job_id = event.job_id AND history.attempt = event.attempt
        WHERE event.job_id = $1 AND event.event_type = 'deadline_exceeded'`,
      [id],
    );
    expect(evidence.rows).toEqual([
      { event_type: "deadline_exceeded", outcome: "deadline_exceeded" },
    ]);
  });

  it("retries timed-out attempts with remaining budget and terminally distinguishes exhaustion", async () => {
    const reasons: unknown[] = [];
    const id = await queue.enqueue("attempt-timeout", null, {
      executionTimeoutMs: 100,
      maxAttempts: 2,
    });
    const worker = new Worker(queue, {
      workerId: "attempt-timeout-worker",
      leaseMs: 5_000,
      heartbeatMs: 50,
    }).handle("attempt-timeout", async (_payload, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            reasons.push(context.signal.reason);
            reject(context.signal.reason);
          },
          { once: true },
        );
      });
      return null;
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await queue.getJob(id)).toMatchObject({ state: "ready", currentAttempt: 2 });
    expect(await worker.runOnce()).toBe(true);
    expect(reasons).toHaveLength(2);
    expect(reasons.every((reason) => reason instanceof ExecutionTimeoutError)).toBe(true);
    expect(await queue.getJob(id)).toMatchObject({
      state: "failed",
      currentAttempt: 2,
      error: { name: "ExecutionTimeout" },
    });
    const evidence = await pool.query<{ outcome: string; source: string }>(
      `SELECT history.outcome, event.details->>'retry_delay_source' AS source
         FROM workhorse.attempt_history history
         JOIN workhorse.job_event event
           ON event.job_id = history.job_id AND event.attempt = history.attempt
          AND event.event_type = 'execution_timed_out'
        WHERE history.job_id = $1 ORDER BY history.attempt`,
      [id],
    );
    expect(evidence.rows).toEqual([
      { outcome: "timeout", source: "execution-timeout-immediate" },
      { outcome: "timeout", source: null },
    ]);
  });

  it("durably times out an attempt whose local timer fires before the database clock agrees", async () => {
    // Regression for the not_due swallow. node-postgres hands attemptTimeoutAt back at millisecond
    // precision while PostgreSQL stores microseconds, so the worker's local expiration timer can
    // fire before clock_timestamp() reaches the stored value and expire_owned_v1 answers not_due.
    // The worker used to treat that answer as completion and abandon the attempt in active state.
    // This claim wrapper widens the natural sub-millisecond window to one no scheduler can hide:
    // the timer fires 100ms early, and the worker must keep asking until the database agrees.
    const skewMs = 100;
    const earlyTimerQueue = new Proxy(queue, {
      get(target, property, receiver) {
        if (property !== "claim") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<Queue["claim"]>) => {
          const claimed = await target.claim(...args);
          if (claimed?.attemptTimeoutAt) {
            claimed.attemptTimeoutAt = new Date(claimed.attemptTimeoutAt.getTime() - skewMs);
          }
          return claimed;
        };
      },
    });
    const id = await queue.enqueue("early-timer-timeout", null, {
      executionTimeoutMs: 200,
      maxAttempts: 2,
    });
    const reasons: unknown[] = [];
    const worker = new Worker(earlyTimerQueue, {
      workerId: "early-timer-worker",
      leaseMs: 5_000,
      heartbeatMs: 50,
    }).handle("early-timer-timeout", async (_payload, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            reasons.push(context.signal.reason);
            reject(context.signal.reason);
          },
          { once: true },
        );
      });
      return null;
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await queue.getJob(id)).toMatchObject({ state: "ready", currentAttempt: 2 });
    expect(await worker.runOnce()).toBe(true);
    expect(reasons).toHaveLength(2);
    expect(reasons.every((reason) => reason instanceof ExecutionTimeoutError)).toBe(true);
    expect(await queue.getJob(id)).toMatchObject({
      state: "failed",
      currentAttempt: 2,
      error: { name: "ExecutionTimeout" },
    });
  });

  it("keeps lease recovery authoritative when it wins an attempt-timeout race", async () => {
    const expirationStarted = deferred();
    const releaseExpiration = deferred();
    const localTimerLeadMs = 400;
    const racingQueue = new Proxy(queue, {
      get(target, property, receiver) {
        if (property === "claim") {
          return async (...args: Parameters<Queue["claim"]>) => {
            const claimed = await target.claim(...args);
            if (claimed?.attemptTimeoutAt) {
              claimed.attemptTimeoutAt = new Date(
                claimed.attemptTimeoutAt.getTime() - localTimerLeadMs,
              );
            }
            return claimed;
          };
        }
        if (property === "expireOwned") {
          return async (...args: Parameters<Queue["expireOwned"]>) => {
            expirationStarted.resolve();
            await releaseExpiration.promise;
            return target.expireOwned(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const id = await queue.enqueue("timeout-lease-race", null, {
      executionTimeoutMs: 500,
      maxAttempts: 2,
    });
    const reasons: unknown[] = [];
    const worker = new Worker(racingQueue, {
      workerId: "timeout-lease-race-worker",
      leaseMs: 5_000,
      heartbeatMs: 1_000,
      retryDelayMs: 0,
    }).handle("timeout-lease-race", async (_payload, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            reasons.push(context.signal.reason);
            reject(context.signal.reason);
          },
          { once: true },
        );
      });
      return null;
    });

    const execution = worker.runOnce();
    try {
      await expirationStarted.promise;
      await pool.query(
        "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE job_id = $1",
        [id],
      );
      expect(await queue.recoverExpired(100, 0)).toBe(1);
      releaseExpiration.resolve();
      await expect(execution).resolves.toBe(true);
    } finally {
      releaseExpiration.resolve();
      await execution.catch(() => undefined);
    }

    expect(reasons).toEqual([expect.any(ExecutionTimeoutError)]);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "ready", currentAttempt: 2 });
    const history = await pool.query<{ outcome: string }>(
      "SELECT outcome FROM workhorse.attempt_history WHERE job_id = $1",
      [id],
    );
    expect(history.rows).toEqual([{ outcome: "lease_expired" }]);
  });

  it("materializes cancellation requested before an overdue deadline without stranding runtime", async () => {
    const id = await queue.enqueue("cancel-before-deadline", null, {
      deadline: new Date(Date.now() + 120),
      maxAttempts: 3,
    });
    const claimed = await queue.claim("cancel-before-deadline-worker", { leaseMs: 5_000 });
    expect(claimed?.id).toBe(id);
    expect((await queue.cancel(id, { reason: "operator won" })).status).toBe("cancel_requested");
    await sleep(140);
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(id)).toMatchObject({
      state: "canceled",
      error: { name: "CancellationRequested", reason: "operator won" },
    });
    const evidence = await pool.query<{ outcome: string; source: string }>(
      `SELECT history.outcome, event.details->>'source' AS source
         FROM workhorse.attempt_history history
         JOIN workhorse.job_event event ON event.job_id = history.job_id
          AND event.attempt = history.attempt AND event.event_type = 'canceled'
        WHERE history.job_id = $1`,
      [id],
    );
    expect(evidence.rows).toEqual([{ outcome: "canceled", source: "deadline_reaper" }]);
  });

  it("classifies the earliest elapsed deadline or execution-timeout boundary", async () => {
    const timeoutFirstId = await queue.enqueue("timeout-before-deadline", null, {
      deadline: new Date(Date.now() + 60_000),
      executionTimeoutMs: 5_000,
      maxAttempts: 2,
    });
    const timeoutFirst = await queue.claim("timeout-before-deadline-worker", { leaseMs: 5_000 });
    expect(timeoutFirst?.id).toBe(timeoutFirstId);
    await pool.query(
      `UPDATE workhorse.job SET deadline_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [timeoutFirstId],
    );
    await pool.query(
      `UPDATE workhorse.job_runtime
          SET deadline_at = clock_timestamp() - interval '1 second',
              attempt_timeout_at = clock_timestamp() - interval '2 seconds'
        WHERE job_id = $1`,
      [timeoutFirstId],
    );
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(timeoutFirstId)).toMatchObject({
      state: "ready",
      currentAttempt: 2,
      error: { name: "ExecutionTimeout" },
    });
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(timeoutFirstId)).toMatchObject({
      state: "failed",
      currentAttempt: 2,
      error: { name: "DeadlineExceeded" },
    });

    const deadlineFirstId = await queue.enqueue("deadline-before-timeout", null, {
      deadline: new Date(Date.now() + 60_000),
      executionTimeoutMs: 5_000,
      maxAttempts: 2,
    });
    const deadlineFirst = await queue.claim("deadline-before-timeout-worker", { leaseMs: 5_000 });
    expect(deadlineFirst?.id).toBe(deadlineFirstId);
    await pool.query(
      `UPDATE workhorse.job SET deadline_at = clock_timestamp() - interval '2 seconds'
        WHERE id = $1`,
      [deadlineFirstId],
    );
    await pool.query(
      `UPDATE workhorse.job_runtime
          SET deadline_at = clock_timestamp() - interval '2 seconds',
              attempt_timeout_at = clock_timestamp() - interval '1 second'
        WHERE job_id = $1`,
      [deadlineFirstId],
    );
    expect(await queue.expireOwned(deadlineFirst!, "deadline-before-timeout-worker")).toBe(
      "deadline_exceeded",
    );
    expect(await queue.getJob(deadlineFirstId)).toMatchObject({
      state: "failed",
      currentAttempt: 1,
      error: { name: "DeadlineExceeded" },
    });
    const outcomes = await pool.query<{ job_id: string; outcome: string }>(
      `SELECT job_id::text, outcome FROM workhorse.attempt_history
        WHERE job_id = ANY($1::uuid[]) ORDER BY job_id, attempt`,
      [[timeoutFirstId, deadlineFirstId]],
    );
    expect(outcomes.rows).toEqual(
      expect.arrayContaining([
        { job_id: timeoutFirstId, outcome: "timeout" },
        { job_id: deadlineFirstId, outcome: "deadline_exceeded" },
      ]),
    );
  });

  it("returns cancellation after waiting behind a concurrent cancellation request", async () => {
    const id = await queue.enqueue("expire-cancel-race", null, {
      deadline: new Date(Date.now() + 60_000),
    });
    const claimed = await queue.claim("expire-cancel-race-worker", { leaseMs: 5_000 });
    expect(claimed?.id).toBe(id);
    await pool.query(
      `UPDATE workhorse.job SET deadline_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE workhorse.job_runtime SET deadline_at = clock_timestamp() - interval '1 second'
        WHERE job_id = $1`,
      [id],
    );

    const cancelClient = await pool.connect();
    try {
      await cancelClient.query("BEGIN");
      await cancelClient.query("SELECT status FROM workhorse.cancel_v1($1, NULL, $2)", [
        id,
        "cancel won row lock",
      ]);
      const expiring = queue.expireOwned(claimed!, "expire-cancel-race-worker");
      await sleep(25);
      await cancelClient.query("COMMIT");
      expect(await expiring).toBe("cancel_requested");
    } finally {
      await cancelClient.query("ROLLBACK").catch(() => undefined);
      cancelClient.release();
    }
    expect(await queue.acknowledgeCancel(claimed!, "expire-cancel-race-worker")).toBe(true);
    expect(await queue.getJob(id)).toMatchObject({
      state: "canceled",
      error: { name: "CancellationRequested", reason: "cancel won row lock" },
    });
  });

  it("excludes durable wait suspension from attempt execution budget while deadlines keep running", async () => {
    let activations = 0;
    const timeoutId = await queue.enqueue("wait-timeout-budget", null, {
      executionTimeoutMs: 300,
    });
    const timeoutWorker = new Worker(queue, {
      workerId: "wait-timeout-budget-worker",
      leaseMs: 5_000,
      heartbeatMs: 50,
    }).handle("wait-timeout-budget", async (_payload, context) => {
      activations += 1;
      if (activations === 1) await context.sleep("pause", 180);
      return { activations };
    });
    expect(await timeoutWorker.runOnce()).toBe(true);
    await sleep(200);
    await queue.promote();
    expect(await timeoutWorker.runOnce()).toBe(true);
    expect(await queue.getJob(timeoutId)).toMatchObject({
      state: "succeeded",
      currentAttempt: 1,
      result: { activations: 2 },
    });

    const deadlineId = await queue.enqueue("wait-deadline", null, {
      deadline: new Date(Date.now() + 120),
      executionTimeoutMs: 5_000,
    });
    const deadlineWorker = new Worker(queue, {
      workerId: "wait-deadline-worker",
      leaseMs: 5_000,
      heartbeatMs: 50,
    }).handle("wait-deadline", async (_payload, context) => {
      await context.sleep("long-pause", 1_000);
      return null;
    });
    expect(await deadlineWorker.runOnce()).toBe(true);
    await sleep(140);
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(deadlineId)).toMatchObject({
      state: "failed",
      currentAttempt: 1,
      error: { name: "DeadlineExceeded" },
    });
  });

  it("reports deadline and active execution-timeout pressure without broad terminal indexes", async () => {
    const deadline = new Date(Date.now() + 30_000);
    const id = await queue.enqueue("deadline-health", null, {
      deadline,
      executionTimeoutMs: 5_000,
    });
    expect((await queue.claim("deadline-health-worker", { leaseMs: 10_000 }))?.id).toBe(id);
    const health = await queue.health();
    expect(health.deadlinePressure).toEqual({
      pending: 1,
      overdue: 0,
      dueWithinMinute: 1,
      earliestAt: deadline,
    });
    expect(health.activeExecutionTimeouts).toBe(1);
    expect(health.overdueExecutionTimeouts).toBe(0);
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'workhorse'
          AND indexname IN ('job_runtime_deadline_idx', 'job_runtime_timeout_idx')
        ORDER BY indexname`,
    );
    expect(indexes.rows).toEqual([
      expect.objectContaining({
        indexname: "job_runtime_deadline_idx",
        indexdef: expect.stringContaining("WHERE (deadline_at IS NOT NULL)"),
      }),
      expect.objectContaining({
        indexname: "job_runtime_timeout_idx",
        indexdef: expect.stringContaining(
          "WHERE ((state = 'active'::text) AND (attempt_timeout_at IS NOT NULL))",
        ),
      }),
    ]);
  });

  it("lock-orders cancellation against completion, failure, heartbeat, checkpoint, and wait", async () => {
    const transitions: Array<{
      name: string;
      query: string;
      expected: Record<string, unknown>;
    }> = [
      {
        name: "complete",
        query: "SELECT workhorse.complete_v1($1, $2, $3, 'null'::jsonb) AS accepted",
        expected: { accepted: false },
      },
      {
        name: "fail",
        query: 'SELECT workhorse.fail_v1($1, $2, $3, \'{"name":"late"}\'::jsonb, 0) AS state',
        expected: { state: "cancel_requested" },
      },
      {
        name: "heartbeat",
        query: "SELECT workhorse.heartbeat_v2($1, $2, $3, 5000) AS status",
        expected: { status: "cancel_requested" },
      },
      {
        name: "checkpoint",
        query: "SELECT status FROM workhorse.save_checkpoint_v1($1, $2, $3, 'late', 'null'::jsonb)",
        expected: { status: "stale" },
      },
      {
        name: "wait",
        query: "SELECT status FROM workhorse.schedule_wait_v1($1, $2, $3, 'late', 1000, NULL)",
        expected: { status: "stale" },
      },
    ];

    for (const transition of transitions) {
      const workerId = `race-${transition.name}`;
      const id = await queue.enqueue(`race-${transition.name}`, null, { maxAttempts: 1 });
      const claimed = await queue.claim(workerId, { leaseMs: 5_000 });
      expect(claimed?.id).toBe(id);
      const locker = await pool.connect();
      try {
        await locker.query("BEGIN");
        const requested = await locker.query<{ status: string }>(
          "SELECT status FROM workhorse.cancel_v1($1, 'race-test', $2)",
          [id, transition.name],
        );
        expect(requested.rows[0]?.status).toBe("cancel_requested");
        const later = pool.query(transition.query, [id, workerId, claimed!.fenceToken.toString()]);
        await locker.query("COMMIT");
        expect((await later).rows[0]).toEqual(transition.expected);
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
      }
      expect(await queue.acknowledgeCancel(claimed!, workerId)).toBe(true);
    }

    for (const terminal of ["complete", "fail"] as const) {
      const workerId = `terminal-wins-${terminal}`;
      const id = await queue.enqueue(`terminal-wins-${terminal}`, null, { maxAttempts: 1 });
      const claimed = await queue.claim(workerId, { leaseMs: 5_000 });
      const locker = await pool.connect();
      try {
        await locker.query("BEGIN");
        let committedState: string | boolean;
        if (terminal === "complete") {
          committedState = (
            await locker.query<{ accepted: boolean }>(
              "SELECT workhorse.complete_v1($1, $2, $3, 'null'::jsonb) AS accepted",
              [id, workerId, claimed!.fenceToken.toString()],
            )
          ).rows[0]!.accepted;
        } else {
          committedState = (
            await locker.query<{ state: string }>(
              'SELECT workhorse.fail_v1($1, $2, $3, \'{"name":"terminal"}\'::jsonb, 0) AS state',
              [id, workerId, claimed!.fenceToken.toString()],
            )
          ).rows[0]!.state;
        }
        expect(committedState).toBe(terminal === "complete" ? true : "failed");
        const cancellation = queue.cancel(id);
        await locker.query("COMMIT");
        expect(await cancellation).toMatchObject({
          status: "already_terminal",
          state: terminal === "complete" ? "succeeded" : "failed",
        });
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
      }
    }
  });

  it("claims exclusively and rejects stale completion after recovery", async () => {
    const id = await queue.enqueue("email", { to: "a@example.com" }, { maxAttempts: 2 });
    const first = await queue.claim("worker-a", { leaseMs: 100 });
    expect(first?.id).toBe(id);
    expect(await queue.claim("worker-b", { leaseMs: 100 })).toBeNull();
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    expect((await queue.getJob(id))?.fenceToken).toBe(0n);
    const second = await queue.claim("worker-b", { leaseMs: 1_000 });
    expect(second?.attempt).toBe(2);
    expect(second!.fenceToken).toBeGreaterThan(first!.fenceToken);
    expect(await queue.complete(first!, "worker-a", { stale: true })).toBe(false);
    expect(await queue.complete(second!, "worker-b", { delivered: true })).toBe(true);
    expect((await queue.getJob<{ delivered: boolean }>(id))?.result).toEqual({ delivered: true });
  });

  it("enforces queue concurrency atomically across competing claims", async () => {
    const queueName = `concurrency-total-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("test", [{ queue: queueName, maxActive: 1 }]);
    const firstId = await queue.enqueue("limited", { ordinal: 1 }, { queue: queueName });
    const secondId = await queue.enqueue("limited", { ordinal: 2 }, { queue: queueName });

    const first = await queue.claim("total-worker-a", { queue: queueName });
    expect(first?.id).toBe(firstId);
    await expect(queue.claim("total-worker-b", { queue: queueName })).resolves.toBeNull();

    await expect(queue.complete(first!, "total-worker-a", null)).resolves.toBe(true);
    await expect(queue.claim("total-worker-b", { queue: queueName })).resolves.toMatchObject({
      id: secondId,
    });
  });

  it("serializes first policy activation against claims that already started", async () => {
    const queueName = `concurrency-activation-${randomUUID()}`;
    await queue.enqueue("limited", { ordinal: 1 }, { queue: queueName });
    await queue.enqueue("limited", { ordinal: 2 }, { queue: queueName });
    const deployment = await pool.connect();

    try {
      await deployment.query("BEGIN");
      await deployment.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('workhorse:concurrency-policy:' || $1, 0))",
        [queueName],
      );
      const claims = Promise.all([
        queue.claim("activation-worker-a", { queue: queueName }),
        queue.claim("activation-worker-b", { queue: queueName }),
      ]);
      await sleep(20);
      await deployment.query(
        "SELECT * FROM workhorse.sync_concurrency_policies_v1($1, $2::jsonb, true)",
        ["activation-test", JSON.stringify([{ queue: queueName, maxActive: 1 }])],
      );
      await deployment.query("COMMIT");

      const admitted = (await claims).filter((job) => job !== null);
      expect(admitted).toHaveLength(1);
      await expect(queue.claim("activation-worker-c", { queue: queueName })).resolves.toBeNull();
    } finally {
      await deployment.query("ROLLBACK").catch(() => undefined);
      deployment.release();
    }
  });

  it("serializes heartbeat lease renewal with policy admission", async () => {
    const queueName = `concurrency-heartbeat-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("heartbeat-test", [{ queue: queueName, maxActive: 1 }]);
    await queue.enqueue("limited", { ordinal: 1 }, { queue: queueName });
    await queue.enqueue("limited", { ordinal: 2 }, { queue: queueName });
    const held = await queue.claim("heartbeat-holder", { queue: queueName, leaseMs: 100 });
    const heartbeat = await pool.connect();

    try {
      await heartbeat.query("BEGIN");
      await expect(
        heartbeat.query<{ status: string }>(
          "SELECT workhorse.heartbeat_v2($1, $2, $3, 1000) AS status",
          [held!.id, "heartbeat-holder", held!.fenceToken.toString()],
        ),
      ).resolves.toMatchObject({ rows: [{ status: "accepted" }] });
      await sleep(120);

      let settled = false;
      const competing = queue
        .claim("heartbeat-competitor", { queue: queueName })
        .finally(() => (settled = true));
      await sleep(20);
      expect(settled).toBe(false);
      await heartbeat.query("COMMIT");
      await expect(competing).resolves.toBeNull();
    } finally {
      await heartbeat.query("ROLLBACK").catch(() => undefined);
      heartbeat.release();
    }
  });

  it("computes claim lease timestamps after waiting for policy locks", async () => {
    const queueName = `concurrency-timestamp-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("timestamp-test", [{ queue: queueName, maxActive: 1 }]);
    await queue.enqueue("limited", {}, { queue: queueName });
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM workhorse.concurrency_policy WHERE queue_name = $1 FOR UPDATE",
        [queueName],
      );
      const claiming = queue.claim("timestamp-worker", { queue: queueName, leaseMs: 100 });
      await sleep(120);
      await blocker.query("COMMIT");

      const claimed = await claiming;
      expect(claimed).not.toBeNull();
      expect(claimed!.leaseExpiresAt.getTime() - Date.now()).toBeGreaterThan(50);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("uses bounded work-conserving lookahead when the FIFO head key is saturated", async () => {
    const queueName = `concurrency-key-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("test", [
      { queue: queueName, maxActive: 3, maxActivePerKey: 1 },
    ]);
    const firstA = await queue.enqueue("keyed", {}, { queue: queueName, concurrencyKey: "a" });
    await queue.enqueue("keyed", {}, { queue: queueName, concurrencyKey: "a" });
    const firstB = await queue.enqueue("keyed", {}, { queue: queueName, concurrencyKey: "b" });

    await expect(queue.claim("key-worker-a", { queue: queueName })).resolves.toMatchObject({
      id: firstA,
    });
    await expect(queue.claim("key-worker-b", { queue: queueName })).resolves.toMatchObject({
      id: firstB,
    });
    await expect(queue.claim("key-worker-c", { queue: queueName })).resolves.toBeNull();
  });

  it("restores dispatch capacity at lease expiry without promising mutual exclusion", async () => {
    const queueName = `concurrency-expiry-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("test", [{ queue: queueName, maxActive: 1 }]);
    await queue.enqueue("expiring", { ordinal: 1 }, { queue: queueName });
    const secondId = await queue.enqueue("expiring", { ordinal: 2 }, { queue: queueName });

    await expect(
      queue.claim("expiry-worker-a", { queue: queueName, leaseMs: 100 }),
    ).resolves.toMatchObject({ payload: { ordinal: 1 } });
    await sleep(120);
    await expect(queue.claim("expiry-worker-b", { queue: queueName })).resolves.toMatchObject({
      id: secondId,
    });
  });

  it("synchronizes token-bucket policies and limits starts across completed jobs", async () => {
    const queueName = `rate-limit-total-${randomUUID()}`;
    await expect(
      queue.syncRateLimitPolicies("test", [
        {
          queue: queueName,
          rate: { limit: 1, intervalMs: 100, burst: 1 },
        },
      ]),
    ).resolves.toMatchObject([
      {
        namespace: "test",
        queue: queueName,
        rate: { limit: 1, intervalMs: 100, burst: 1 },
        perKey: null,
      },
    ]);

    const firstId = await queue.enqueue("rate-limited", { ordinal: 1 }, { queue: queueName });
    const secondId = await queue.enqueue("rate-limited", { ordinal: 2 }, { queue: queueName });
    const first = await queue.claim("rate-worker-a", { queue: queueName });
    expect(first?.id).toBe(firstId);
    await expect(queue.complete(first!, "rate-worker-a", null)).resolves.toBe(true);
    await expect(queue.claim("rate-worker-b", { queue: queueName })).resolves.toBeNull();
    await expect(queue.rateLimitStatuses([queueName])).resolves.toMatchObject([
      {
        queue: queueName,
        availableTokens: expect.any(Number),
        throttledReady: 1,
        throttledKeys: 0,
        nextEligibleAt: expect.any(Date),
        sampleCapped: false,
      },
    ]);

    await sleep(110);
    await expect(queue.claim("rate-worker-b", { queue: queueName })).resolves.toMatchObject({
      id: secondId,
    });
    await expect(queue.rateLimitPolicies([queueName])).resolves.toMatchObject([
      {
        queue: queueName,
        rate: { limit: 1, intervalMs: 100, burst: 1 },
      },
    ]);
  });

  it("admits another key while the FIFO head key is throttled", async () => {
    const queueName = `rate-limit-key-${randomUUID()}`;
    await queue.syncRateLimitPolicies("test", [
      {
        queue: queueName,
        rate: { limit: 100, intervalMs: 1_000, burst: 100 },
        perKey: { limit: 1, intervalMs: 150, burst: 1 },
      },
    ]);
    const firstA = await queue.enqueue("key-rate", {}, { queue: queueName, concurrencyKey: "a" });
    await queue.enqueue("key-rate", {}, { queue: queueName, concurrencyKey: "a" });
    const firstB = await queue.enqueue("key-rate", {}, { queue: queueName, concurrencyKey: "b" });

    await expect(queue.claim("key-rate-worker-a", { queue: queueName })).resolves.toMatchObject({
      id: firstA,
    });
    await expect(queue.claim("key-rate-worker-b", { queue: queueName })).resolves.toMatchObject({
      id: firstB,
    });
    await expect(queue.claim("key-rate-worker-c", { queue: queueName })).resolves.toBeNull();
  });

  it("consumes one queue token across competing claims and recovers by elapsed database time", async () => {
    const queueName = `rate-limit-atomic-${randomUUID()}`;
    await queue.syncRateLimitPolicies("test", [
      { queue: queueName, rate: { limit: 1, intervalMs: 100, burst: 1 } },
    ]);
    await queue.enqueueMany([
      { type: "atomic-rate", payload: { ordinal: 1 }, options: { queue: queueName } },
      { type: "atomic-rate", payload: { ordinal: 2 }, options: { queue: queueName } },
    ]);

    const claims = await Promise.all([
      queue.claim("atomic-rate-worker-a", { queue: queueName }),
      queue.claim("atomic-rate-worker-b", { queue: queueName }),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    await sleep(110);
    await expect(queue.claim("atomic-rate-worker-c", { queue: queueName })).resolves.not.toBeNull();
  });

  it("refills continuously between interval boundaries", async () => {
    const queueName = `rate-limit-continuous-${randomUUID()}`;
    await queue.syncRateLimitPolicies("test", [
      { queue: queueName, rate: { limit: 2, intervalMs: 1_000, burst: 2 } },
    ]);
    await queue.enqueueMany([
      { type: "continuous-rate", payload: 1, options: { queue: queueName } },
      { type: "continuous-rate", payload: 2, options: { queue: queueName } },
      { type: "continuous-rate", payload: 3, options: { queue: queueName } },
    ]);
    await expect(queue.claim("continuous-rate-a", { queue: queueName })).resolves.not.toBeNull();
    await expect(queue.claim("continuous-rate-b", { queue: queueName })).resolves.not.toBeNull();
    await pool.query(
      `UPDATE workhorse.rate_limit_bucket
          SET refilled_at = clock_timestamp() - interval '250 milliseconds'
        WHERE queue_name = $1 AND bucket_scope = 'queue'`,
      [queueName],
    );

    const partial = (await queue.rateLimitStatuses([queueName]))[0]!.availableTokens;
    expect(partial).toBeGreaterThan(0.4);
    expect(partial).toBeLessThan(1);
    await expect(queue.claim("continuous-rate-c", { queue: queueName })).resolves.toBeNull();

    await pool.query(
      `UPDATE workhorse.rate_limit_bucket
          SET refilled_at = clock_timestamp() - interval '550 milliseconds'
        WHERE queue_name = $1 AND bucket_scope = 'queue'`,
      [queueName],
    );
    await expect(queue.claim("continuous-rate-c", { queue: queueName })).resolves.not.toBeNull();
  });

  it("rolls token consumption back with a crashed claim transaction", async () => {
    const queueName = `rate-limit-rollback-${randomUUID()}`;
    await queue.syncRateLimitPolicies("test", [
      { queue: queueName, rate: { limit: 1, intervalMs: 60_000, burst: 1 } },
    ]);
    await queue.enqueueMany([
      { type: "rollback-rate", payload: 1, options: { queue: queueName } },
      { type: "rollback-rate", payload: 2, options: { queue: queueName } },
    ]);

    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await expect(
        new Queue(transaction).claim("rollback-rate-crashed", { queue: queueName }),
      ).resolves.not.toBeNull();
      await transaction.query("ROLLBACK");
    } finally {
      transaction.release();
    }

    await expect(
      queue.claim("rollback-rate-survivor", { queue: queueName }),
    ).resolves.not.toBeNull();
    await expect(queue.claim("rollback-rate-blocked", { queue: queueName })).resolves.toBeNull();
  });

  it("bounds durable state by pruning fully refilled key buckets during claims", async () => {
    const queueName = `rate-limit-key-pruning-${randomUUID()}`;
    await queue.syncRateLimitPolicies("test", [
      {
        queue: queueName,
        rate: { limit: 100, intervalMs: 1_000, burst: 100 },
        perKey: { limit: 1, intervalMs: 100, burst: 1 },
      },
    ]);
    for (const key of ["a", "b", "c"]) {
      await queue.enqueue("pruned-key-rate", null, { queue: queueName, concurrencyKey: key });
      const claimed = await queue.claim(`pruned-key-${key}`, { queue: queueName });
      await queue.complete(claimed!, `pruned-key-${key}`, null);
    }
    await pool.query(
      `UPDATE workhorse.rate_limit_bucket
          SET refilled_at = clock_timestamp() - interval '1 second'
        WHERE queue_name = $1 AND bucket_scope = 'key'`,
      [queueName],
    );
    await queue.enqueue("pruned-key-rate", null, {
      queue: queueName,
      concurrencyKey: "replacement",
    });
    await expect(
      queue.claim("pruned-key-replacement", { queue: queueName }),
    ).resolves.not.toBeNull();
    await expect(
      pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM workhorse.rate_limit_bucket
          WHERE queue_name = $1 AND bucket_scope = 'key'`,
        [queueName],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("charges retries as new starts and validates deployment ownership", async () => {
    const queueName = `rate-limit-retry-${randomUUID()}`;
    await queue.syncRateLimitPolicies("deployment-a", [
      { queue: queueName, rate: { limit: 1, intervalMs: 100, burst: 1 } },
    ]);
    await expect(
      queue.syncRateLimitPolicies("deployment-b", [
        { queue: queueName, rate: { limit: 1, intervalMs: 100, burst: 1 } },
      ]),
    ).rejects.toThrow(/owned by another namespace/);
    await expect(
      queue.syncRateLimitPolicies("deployment-a", [
        { queue: queueName, rate: { limit: 0, intervalMs: 100, burst: 1 } },
      ]),
    ).rejects.toThrow(/bounded positive integers/);

    await queue.enqueue("rate-retry", {}, { queue: queueName, maxAttempts: 2 });
    const first = await queue.claim("rate-retry-worker", { queue: queueName });
    await expect(queue.fail(first!, "rate-retry-worker", new Error("retry"), 0)).resolves.toBe(
      "ready",
    );
    await expect(queue.claim("rate-retry-worker", { queue: queueName })).resolves.toBeNull();
    await sleep(110);
    await expect(queue.claim("rate-retry-worker", { queue: queueName })).resolves.toMatchObject({
      attempt: 2,
    });
  });

  it("does not manufacture tokens when the persisted refill clock is ahead", async () => {
    const queueName = `rate-limit-clock-${randomUUID()}`;
    await queue.syncRateLimitPolicies("test", [
      { queue: queueName, rate: { limit: 1, intervalMs: 100, burst: 1 } },
    ]);
    await queue.enqueueMany([
      { type: "clock-rate", payload: 1, options: { queue: queueName } },
      { type: "clock-rate", payload: 2, options: { queue: queueName } },
    ]);
    await expect(queue.claim("clock-rate-worker", { queue: queueName })).resolves.not.toBeNull();
    const skewed = await pool.query<{ refilled_at: Date }>(
      `UPDATE workhorse.rate_limit_bucket
          SET refilled_at = clock_timestamp() + interval '1 hour'
        WHERE queue_name = $1 AND bucket_scope = 'queue'
        RETURNING refilled_at`,
      [queueName],
    );

    await sleep(110);
    await expect(queue.claim("clock-rate-worker", { queue: queueName })).resolves.toBeNull();
    await sleep(110);
    await expect(queue.claim("clock-rate-worker", { queue: queueName })).resolves.toBeNull();
    await expect(
      pool.query<{ refilled_at: Date }>(
        `SELECT refilled_at FROM workhorse.rate_limit_bucket
          WHERE queue_name = $1 AND bucket_scope = 'queue'`,
        [queueName],
      ),
    ).resolves.toMatchObject({ rows: [{ refilled_at: skewed.rows[0]!.refilled_at }] });
  });

  it("uses selective live-work indexes for concurrency admission checks", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");

      const activePlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT count(*)
            FROM workhorse.job_runtime active
           WHERE active.state = 'active'
             AND active.queue_name = 'concurrency-plan'
             AND active.expires_at > clock_timestamp()`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      expect(activePlan).toContain("job_runtime_active_queue_key_expiry_idx");

      const readyPlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT runtime.job_id, runtime.concurrency_key, runtime.sequence
            FROM workhorse.job_runtime runtime
            JOIN workhorse.job job ON job.id = runtime.job_id
           WHERE runtime.state = 'ready'
             AND runtime.queue_name = 'concurrency-plan'
             AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
             AND (job.execution_timeout_ms IS NULL
               OR runtime.execution_used_ms < job.execution_timeout_ms)
           ORDER BY runtime.sequence, runtime.job_id
           LIMIT 100
           FOR UPDATE OF runtime SKIP LOCKED`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      expect(readyPlan).toContain("job_runtime_ready_idx");
      expect(`${activePlan}\n${readyPlan}`).not.toMatch(
        /job_outcome|job_event|attempt_history|job_query/,
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("terminally fails an exhausted expired attempt without retaining runtime", async () => {
    const id = await queue.enqueue("email", {}, { maxAttempts: 1 });
    await queue.claim("worker-a", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    expect((await queue.getJob(id))?.state).toBe("failed");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state FROM workhorse.job_outcome WHERE job_id = $1", [id])).rows[0]
        .state,
    ).toBe("failed");
  });

  it("heartbeats only the current fenced lease", async () => {
    await queue.enqueue("email", { to: "a@example.com" });
    const job = await queue.claim("worker-a", { leaseMs: 1_000 });
    expect(await queue.heartbeat(job!, "worker-a", 1_000)).toBe(true);
    expect(
      await queue.heartbeat({ ...job!, fenceToken: job!.fenceToken + 1n }, "worker-a", 1_000),
    ).toBe(false);
    expect(await queue.heartbeat(job!, "worker-b", 1_000)).toBe(false);
  });
  it("persists bounded trace context separately from the payload and returns it on claim", async () => {
    const traceContext = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    };
    const enqueued = await pool.query<{ job_id: string }>(
      "SELECT job_id FROM workhorse.enqueue_many_v1($1::jsonb)",
      [JSON.stringify([{ queue: "default", type: "traced", payload: { value: 1 }, traceContext }])],
    );

    const stored = await pool.query<{ payload: Json; trace_context: Json }>(
      "SELECT payload, trace_context FROM workhorse.job WHERE id = $1",
      [enqueued.rows[0]!.job_id],
    );
    expect(stored.rows[0]).toEqual({ payload: { value: 1 }, trace_context: traceContext });
    expect((await queue.claim("trace-worker"))?.traceContext).toEqual(traceContext);

    await expect(
      pool.query("SELECT * FROM workhorse.enqueue_many_v1($1::jsonb)", [
        JSON.stringify([
          {
            queue: "default",
            type: "invalid-trace",
            payload: null,
            traceContext: { traceparent: "valid-shape", baggage: "not accepted" },
          },
        ]),
      ]),
    ).rejects.toThrow(/traceContext/);
  });
});
