import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  MAX_CHECKPOINT_VALUE_BYTES,
  MAX_PROGRESS_VALUE_BYTES,
  Queue,
  type Queryable,
  Worker,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

describe("checkpoints progress waits", () => {
  it("persists immutable checkpoints with ownership provenance", async () => {
    const id = await queue.enqueue("checkpointed", { orderId: "order-1" });
    const job = await queue.claim("worker-a");

    const saved = await queue.saveCheckpoint(job!, "worker-a", "payment-authorized", {
      authorizationId: "auth-1",
    });
    expect(saved).toMatchObject({
      jobId: id,
      name: "payment-authorized",
      value: { authorizationId: "auth-1" },
      attempt: 1,
      fenceToken: job!.fenceToken,
      workerId: "worker-a",
    });
    await expect(queue.getCheckpoint(id, "payment-authorized")).resolves.toEqual(saved);
    await expect(
      queue.saveCheckpoint(job!, "worker-a", "nullable-result", null),
    ).resolves.toMatchObject({
      name: "nullable-result",
      value: null,
    });

    const repeated = await queue.saveCheckpoint(job!, "worker-a", "payment-authorized", {
      authorizationId: "auth-1",
    });
    expect(repeated).toEqual(saved);
    await expect(
      queue.saveCheckpoint(job!, "worker-a", "payment-authorized", {
        authorizationId: "auth-2",
      }),
    ).rejects.toThrow(/different value/);

    expect(await queue.complete(job!, "worker-a", { ok: true })).toBe(true);
    await expect(queue.getCheckpoint(id, "payment-authorized")).resolves.toEqual(saved);
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY event_id",
      [id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "enqueued",
      "claimed",
      "checkpoint_saved",
      "checkpoint_saved",
      "succeeded",
    ]);
  });

  it("bounds checkpoint values before durable writes", async () => {
    const id = await queue.enqueue("checkpoint-size", {});
    const job = await queue.claim("worker-a");

    await expect(
      queue.saveCheckpoint(job!, "worker-a", "oversized", {
        data: "x".repeat(MAX_CHECKPOINT_VALUE_BYTES + 1),
      }),
    ).rejects.toThrow(/at most 1048576 bytes/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.save_checkpoint_v1(
          $1, $2, $3, 'oversized-sql', to_jsonb(repeat('x', $4))
        )`,
        [id, "worker-a", job!.fenceToken.toString(), MAX_CHECKPOINT_VALUE_BYTES + 1],
      ),
    ).rejects.toThrow(/at most 1048576 bytes/);
    await expect(queue.getCheckpoint(id, "oversized")).resolves.toBeNull();
    await expect(queue.getCheckpoint(id, "oversized-sql")).resolves.toBeNull();
  });

  it("rejects checkpoint writes from a stale ownership generation", async () => {
    const id = await queue.enqueue("checkpointed", {}, { maxAttempts: 2 });
    const stale = await queue.claim("worker-a", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    const current = await queue.claim("worker-b");

    await expect(
      queue.saveCheckpoint(stale!, "worker-a", "stale-step", { shouldNotPersist: true }),
    ).rejects.toThrow(/lease is stale or expired/);
    await expect(queue.getCheckpoint(id, "stale-step")).resolves.toBeNull();
    await expect(
      queue.saveCheckpoint(current!, "worker-b", "current-step", { persisted: true }),
    ).resolves.toMatchObject({ name: "current-step", attempt: 2, workerId: "worker-b" });
  });

  it("serializes checkpoint writes against a concurrent retry transition", async () => {
    const id = await queue.enqueue("checkpoint-race", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a");
    const transition = await pool.connect();

    try {
      await transition.query("BEGIN");
      await transition.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [
        id,
      ]);
      const saving = queue.saveCheckpoint(job!, "worker-a", "racing-step", { persisted: true });
      const rejection = saving.then(
        () => null,
        (error: unknown) => error,
      );
      await sleep(20);
      await transition.query("SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb, 0) AS state", [
        id,
        "worker-a",
        job!.fenceToken.toString(),
        JSON.stringify({ message: "retry" }),
      ]);
      await transition.query("COMMIT");

      await expect(rejection).resolves.toMatchObject({
        name: "CheckpointLeaseLostError",
        message: expect.stringMatching(/lease is stale or expired/),
      });
      await expect(queue.getCheckpoint(id, "racing-step")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "ready", currentAttempt: 2 });
    } finally {
      await transition.query("ROLLBACK").catch(() => undefined);
      transition.release();
    }
  });

  it("serializes checkpoint writes against concurrent terminal completion", async () => {
    const id = await queue.enqueue("checkpoint-complete-race", {});
    const job = await queue.claim("worker-a");
    const transition = await pool.connect();

    try {
      await transition.query("BEGIN");
      await transition.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [
        id,
      ]);
      const rejection = queue
        .saveCheckpoint(job!, "worker-a", "too-late", { persisted: true })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await sleep(20);
      await transition.query("SELECT workhorse.complete_v1($1, $2, $3, $4::jsonb) AS accepted", [
        id,
        "worker-a",
        job!.fenceToken.toString(),
        JSON.stringify({ completed: true }),
      ]);
      await transition.query("COMMIT");

      await expect(rejection).resolves.toMatchObject({ name: "CheckpointLeaseLostError" });
      await expect(queue.getCheckpoint(id, "too-late")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({
        state: "succeeded",
        result: { completed: true },
      });
    } finally {
      await transition.query("ROLLBACK").catch(() => undefined);
      transition.release();
    }
  });

  it("retains checkpoints after terminal failure", async () => {
    const id = await queue.enqueue("checkpoint-failure", {}, { maxAttempts: 1 });
    const job = await queue.claim("worker-a");
    const checkpoint = await queue.saveCheckpoint(job!, "worker-a", "before-failure", {
      prepared: true,
    });

    expect(await queue.fail(job!, "worker-a", new Error("terminal"))).toBe("failed");
    await expect(queue.getCheckpoint(id, "before-failure")).resolves.toEqual(checkpoint);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "failed" });
  });

  it("rechecks checkpoint lease expiry after waiting for the runtime lock", async () => {
    const id = await queue.enqueue("checkpoint-lock-expiry", {});
    const job = await queue.claim("worker-a", { leaseMs: 100 });
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [id]);
      const saving = queue.saveCheckpoint(job!, "worker-a", "expired-while-waiting", {
        persisted: true,
      });
      const rejection = saving.then(
        () => null,
        (error: unknown) => error,
      );
      await sleep(130);
      await blocker.query("COMMIT");

      await expect(rejection).resolves.toMatchObject({
        name: "CheckpointLeaseLostError",
        message: expect.stringMatching(/lease is stale or expired/),
      });
      await expect(queue.getCheckpoint(id, "expired-while-waiting")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("updates bounded mutable progress with fenced provenance and lookup visibility", async () => {
    const id = await queue.enqueue("progress", { batch: "import-1" });
    const job = await queue.claim("progress-worker");

    const first = await queue.updateProgress(job!, "progress-worker", {
      completed: 2,
      total: 10,
      phase: "reading",
    });
    expect(first).toMatchObject({
      jobId: id,
      value: { completed: 2, total: 10, phase: "reading" },
      revision: 1n,
      attempt: 1,
      fenceToken: job!.fenceToken,
      workerId: "progress-worker",
    });
    await expect(queue.getProgress(id)).resolves.toEqual(first);
    await expect(queue.getJob(id)).resolves.toMatchObject({ progress: first });

    const unchanged = await queue.updateProgress(job!, "progress-worker", {
      completed: 2,
      total: 10,
      phase: "reading",
    });
    expect(unchanged).toEqual(first);
    await expect(
      queue.updateProgress(job!, "progress-worker", { completed: 3, total: 10 }),
    ).rejects.toMatchObject({
      name: "ProgressRateLimitError",
      jobId: id,
      retryAfterMs: expect.any(Number),
    });

    await sleep(110);
    const second = await queue.updateProgress(job!, "progress-worker", {
      completed: 3,
      total: 10,
      phase: "writing",
    });
    expect(second).toMatchObject({ revision: 2n, attempt: 1, workerId: "progress-worker" });
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());

    expect(await queue.complete(job!, "progress-worker", { imported: 10 })).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "succeeded", progress: second });
    const events = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'progress_updated' ORDER BY event_id`,
      [id],
    );
    expect(events.rows).toEqual([
      { event_type: "progress_updated", details: expect.objectContaining({ revision: "1" }) },
      { event_type: "progress_updated", details: expect.objectContaining({ revision: "2" }) },
    ]);
  });

  it("bounds progress values and rejects stale ownership generations", async () => {
    await queue.enqueue("progress-bounds", {}, { maxAttempts: 2 });
    const stale = await queue.claim("progress-worker-a", { leaseMs: 100 });

    await expect(
      queue.updateProgress(stale!, "progress-worker-a", {
        data: "x".repeat(MAX_PROGRESS_VALUE_BYTES + 1),
      }),
    ).rejects.toThrow(/at most 65536 bytes/);
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    const current = await queue.claim("progress-worker-b");

    await expect(
      queue.updateProgress(stale!, "progress-worker-a", { stale: true }),
    ).rejects.toMatchObject({ name: "ProgressLeaseLostError" });
    const accepted = await queue.updateProgress(current!, "progress-worker-b", { recovered: true });
    expect(accepted).toMatchObject({ revision: 1n, attempt: 2, workerId: "progress-worker-b" });
  });

  it("rechecks progress lease expiry after waiting for the runtime lock", async () => {
    const id = await queue.enqueue("progress-lock-expiry", {});
    const job = await queue.claim("progress-lock-worker", { leaseMs: 100 });
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [id]);
      const updating = queue
        .updateProgress(job!, "progress-lock-worker", { shouldNotPersist: true })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await sleep(130);
      await blocker.query("COMMIT");

      await expect(updating).resolves.toMatchObject({ name: "ProgressLeaseLostError" });
      await expect(queue.getProgress(id)).resolves.toBeNull();
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("exposes progress helpers to handlers", async () => {
    const id = await queue.enqueue("progress-context", {});
    const observed: unknown[] = [];
    const worker = new Worker(queue, { workerId: "progress-context-worker" }).handle(
      "progress-context",
      async (_payload, context) => {
        observed.push(await context.getProgress());
        const updated = await context.setProgress({ percent: 50, label: "halfway" });
        observed.push(await context.getProgress());
        return { revision: updated.revision.toString() };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(observed).toEqual([
      null,
      expect.objectContaining({ jobId: id, value: { percent: 50, label: "halfway" } }),
    ]);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { revision: "1" },
      progress: { value: { percent: 50, label: "halfway" } },
    });
  });

  it("schedules the first named wait with immutable ownership provenance", async () => {
    const id = await queue.enqueue("wait-first", {});
    const job = await queue.claim("wait-worker", { leaseMs: 10_000 });
    const active = await pool.query<{ attempt_started_at: Date; acquired_at: Date }>(
      `SELECT attempt_started_at, acquired_at
         FROM workhorse.job_runtime
        WHERE job_id = $1`,
      [id],
    );
    const before = Date.now();

    const result = await queue.scheduleWait(job!, "wait-worker", "provider-cooldown", {
      durationMs: 5_000,
    });
    const after = Date.now();

    expect(result.status).toBe("scheduled");
    expect(result.wait).toMatchObject({
      jobId: id,
      name: "provider-cooldown",
      mode: "relative",
      durationMs: 5_000,
      requestedWakeAt: null,
      attempt: 1,
      fenceToken: job!.fenceToken,
      workerId: "wait-worker",
    });
    expect(result.wait.wakeAt.getTime()).toBeGreaterThanOrEqual(before + 5_000);
    expect(result.wait.wakeAt.getTime()).toBeLessThanOrEqual(after + 5_100);
    await expect(queue.getWait(id, "provider-cooldown")).resolves.toEqual(result.wait);
    await expect(queue.listWaits(id)).resolves.toEqual([result.wait]);

    const runtime = await pool.query<{
      state: string;
      run_at: Date;
      current_attempt: number;
      fence_token: string;
      worker_id: string | null;
      expires_at: Date | null;
      wait_name: string | null;
      attempt_started_at: Date;
    }>(
      `SELECT state, run_at, current_attempt, fence_token::text, worker_id, expires_at,
              wait_name, attempt_started_at
         FROM workhorse.job_runtime
        WHERE job_id = $1`,
      [id],
    );
    expect(runtime.rows[0]).toEqual({
      state: "scheduled",
      run_at: result.wait.wakeAt,
      current_attempt: 1,
      fence_token: "0",
      worker_id: null,
      expires_at: null,
      wait_name: "provider-cooldown",
      attempt_started_at: active.rows[0]!.attempt_started_at,
    });
    expect(active.rows[0]!.attempt_started_at).toEqual(active.rows[0]!.acquired_at);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(await queue.complete(job!, "wait-worker", { tooLate: true })).toBe(false);
    expect(await queue.fail(job!, "wait-worker", new Error("too late"))).toBe("stale");
  });

  it("replays relative waits first-write-wins despite duration drift", async () => {
    const id = await queue.enqueue("wait-relative-replay", {});
    const firstClaim = await queue.claim("relative-worker");
    const first = await queue.scheduleWait(firstClaim!, "relative-worker", "backoff", {
      durationMs: 30,
    });
    await sleep(50);
    expect(await queue.promote()).toBe(1);
    const continuation = await queue.claim("relative-worker");

    const replay = await queue.scheduleWait(continuation!, "relative-worker", "backoff", {
      durationMs: 30_000,
    });

    expect(replay).toEqual({ status: "elapsed", wait: first.wait });
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "active",
      currentAttempt: 1,
      fenceToken: continuation!.fenceToken,
    });
    const event = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'wait_replayed'`,
      [id],
    );
    expect(event.rows[0]!.details).toMatchObject({
      name: "backoff",
      mode: "relative",
      requested_duration_ms: 30_000,
      stored_duration_ms: 30,
      stored_wake_at: expect.any(String),
      fence_token: continuation!.fenceToken.toString(),
    });
    expect(new Date(String(event.rows[0]!.details.stored_wake_at))).toEqual(first.wait.wakeAt);
  });

  it("rejects changed absolute targets and relative/absolute mode changes", async () => {
    const id = await queue.enqueue("wait-conflicts", {});
    const firstClaim = await queue.claim("conflict-worker");
    const target = new Date(Date.now() + 30);
    const first = await queue.scheduleWait(firstClaim!, "conflict-worker", "embargo", {
      wakeAt: target,
    });
    expect(first.wait).toMatchObject({
      jobId: id,
      name: "embargo",
      mode: "absolute",
      durationMs: null,
      requestedWakeAt: target,
      wakeAt: target,
    });
    await sleep(50);
    expect(await queue.promote()).toBe(1);
    const continuation = await queue.claim("conflict-worker");

    await expect(
      queue.scheduleWait(continuation!, "conflict-worker", "embargo", {
        wakeAt: new Date(target.getTime() + 1),
      }),
    ).rejects.toMatchObject({ name: "WaitConflictError", existing: first.wait });
    await expect(
      queue.scheduleWait(continuation!, "conflict-worker", "embargo", { durationMs: 1 }),
    ).rejects.toMatchObject({ name: "WaitConflictError", existing: first.wait });
    await expect(queue.getWait(id, "embargo")).resolves.toEqual(first.wait);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active", currentAttempt: 1 });
  });

  it("bounds wait names, relative durations, and absolute timestamps", async () => {
    const id = await queue.enqueue("wait-bounds", {});
    const job = await queue.claim("bounds-worker");
    const schedule = (name: string, options: { durationMs: number } | { wakeAt: Date }) =>
      queue.scheduleWait(job!, "bounds-worker", name, options);

    await expect(schedule("", { durationMs: 1 })).rejects.toThrow(/between 1 and 200/);
    await expect(schedule("x".repeat(201), { durationMs: 1 })).rejects.toThrow(/between 1 and 200/);
    for (const durationMs of [0, -1, 31_536_000_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(schedule(`duration-${durationMs}`, { durationMs })).rejects.toThrow(/duration/i);
    }
    await expect(schedule("invalid-date", { wakeAt: new Date(Number.NaN) })).rejects.toThrow(
      /finite|valid/i,
    );
    await expect(
      schedule("too-far", { wakeAt: new Date(Date.now() + 365 * 86_400_000 + 60_000) }),
    ).rejects.toThrow(/365 days/);
    await expect(
      pool.query(`SELECT * FROM workhorse.schedule_wait_v1($1, $2, $3, 'neither', NULL, NULL)`, [
        id,
        "bounds-worker",
        job!.fenceToken.toString(),
      ]),
    ).rejects.toThrow(/exactly one/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.schedule_wait_v1(
          $1, $2, $3, 'both', 1, clock_timestamp() + interval '1 second'
        )`,
        [id, "bounds-worker", job!.fenceToken.toString()],
      ),
    ).rejects.toThrow(/exactly one/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.schedule_wait_v1($1, $2, $3, 'infinite', NULL, 'infinity')`,
        [id, "bounds-worker", job!.fenceToken.toString()],
      ),
    ).rejects.toThrow(/finite/);
    await expect(queue.getWait(id, "too-far")).resolves.toBeNull();

    const maximum = await schedule("maximum", { durationMs: 31_536_000_000 });
    expect(maximum.status).toBe("scheduled");
    expect(maximum.wait.durationMs).toBe(31_536_000_000);
  });

  it("returns limit_exceeded after 1,000 retained wait names", async () => {
    const id = await queue.enqueue("wait-limit", {});
    const job = await queue.claim("limit-worker");
    await pool.query(
      `INSERT INTO workhorse.job_wait(
         job_id, wait_name, mode, duration_ms, wake_at, attempt, fence_token, worker_id, claimed_at
       )
       SELECT $1, 'seed-' || value, 'relative', 1,
              clock_timestamp() + interval '1 millisecond', 1, $2, $3,
              (SELECT acquired_at FROM workhorse.job_runtime WHERE job_id = $1)
         FROM generate_series(1, 1000) AS value`,
      [id, job!.fenceToken.toString(), "limit-worker"],
    );

    await expect(
      queue.scheduleWait(job!, "limit-worker", "overflow", { durationMs: 1 }),
    ).rejects.toMatchObject({ name: "WaitLimitExceededError" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_wait WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(1_000);
    await expect(queue.getWait(id, "overflow")).resolves.toBeNull();
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active" });
  });

  it("records a past-due first target without releasing active ownership", async () => {
    const id = await queue.enqueue("wait-past-due", {});
    const job = await queue.claim("past-due-worker");
    const target = new Date(Date.now() - 1_000);

    const result = await queue.scheduleWait(job!, "past-due-worker", "already-open", {
      wakeAt: target,
    });

    expect(result).toMatchObject({
      status: "elapsed",
      wait: { name: "already-open", requestedWakeAt: target, wakeAt: target },
    });
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "active",
      fenceToken: job!.fenceToken,
    });
    const event = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'wait_elapsed'`,
      [id],
    );
    expect(event.rows[0]!.details).toMatchObject({
      name: "already-open",
      mode: "absolute",
      reason: "due",
      immediate: true,
      wake_at: expect.any(String),
    });
    expect(new Date(String(event.rows[0]!.details.wake_at))).toEqual(target);
  });

  it("rejects stale generations and non-active runtime states without writing waits", async () => {
    const callSql = async (id: string, workerId: string, fenceToken: bigint, name: string) =>
      (
        await pool.query<{ status: string }>(
          `SELECT status FROM workhorse.schedule_wait_v1($1, $2, $3, $4, 1, NULL)`,
          [id, workerId, fenceToken.toString(), name],
        )
      ).rows[0]!.status;

    const recoveredId = await queue.enqueue("wait-stale", {}, { maxAttempts: 2 });
    const stale = await queue.claim("stale-worker", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    await expect(
      queue.scheduleWait(stale!, "stale-worker", "stale", { durationMs: 1 }),
    ).rejects.toMatchObject({ name: "WaitLeaseLostError" });
    expect(await callSql(recoveredId, "stale-worker", stale!.fenceToken, "ready")).toBe("stale");

    const scheduledId = await queue.enqueue("wait-scheduled", {});
    const scheduledClaim = await queue.claim("scheduled-worker");
    await queue.scheduleWait(scheduledClaim!, "scheduled-worker", "current", {
      durationMs: 60_000,
    });
    expect(
      await callSql(scheduledId, "scheduled-worker", scheduledClaim!.fenceToken, "other"),
    ).toBe("stale");

    const terminalId = await queue.enqueue("wait-terminal", {});
    const terminalClaim = await queue.claim("terminal-worker");
    expect(await queue.complete(terminalClaim!, "terminal-worker", null)).toBe(true);
    expect(
      await callSql(terminalId, "terminal-worker", terminalClaim!.fenceToken, "terminal"),
    ).toBe("stale");

    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM workhorse.job_wait
            WHERE job_id = ANY($1::uuid[])`,
          [[recoveredId, scheduledId, terminalId]],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("rechecks wait lease expiry after waiting for the runtime lock", async () => {
    const id = await queue.enqueue("wait-lock-expiry", {});
    const job = await queue.claim("wait-lock-worker", { leaseMs: 100 });
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [id]);
      const scheduling = queue
        .scheduleWait(job!, "wait-lock-worker", "expired-while-blocked", { durationMs: 1_000 })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await sleep(130);
      await blocker.query("COMMIT");

      await expect(scheduling).resolves.toMatchObject({ name: "WaitLeaseLostError" });
      await expect(queue.getWait(id, "expired-while-blocked")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("returns typed stale when the wait lease expires during the suspension transition", async () => {
    const id = await queue.enqueue("wait-transition-expiry", {});
    const job = await queue.claim("wait-transition-worker", { leaseMs: 250 });

    await pool.query(`
      CREATE OR REPLACE FUNCTION workhorse.test_delay_wait_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_sleep(0.4);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_delay_wait_insert
      BEFORE INSERT ON workhorse.job_wait
      FOR EACH ROW EXECUTE FUNCTION workhorse.test_delay_wait_insert();
    `);

    try {
      await expect(
        queue.scheduleWait(job!, "wait-transition-worker", "expired-during-transition", {
          durationMs: 1_000,
        }),
      ).rejects.toMatchObject({ name: "WaitLeaseLostError" });
      await expect(queue.getWait(id, "expired-during-transition")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active" });
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS test_delay_wait_insert ON workhorse.job_wait;
        DROP FUNCTION IF EXISTS workhorse.test_delay_wait_insert();
      `);
    }
  });

  it.each(["complete", "fail", "recover"] as const)(
    "serializes wait scheduling behind concurrent %s",
    async (transitionKind) => {
      const id = await queue.enqueue(`wait-race-${transitionKind}`, {}, { maxAttempts: 2 });
      const leaseMs = transitionKind === "recover" ? 100 : 10_000;
      const job = await queue.claim("race-worker", { leaseMs });
      const transition = await pool.connect();

      try {
        await transition.query("BEGIN");
        await transition.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [
          id,
        ]);
        const scheduling = queue
          .scheduleWait(job!, "race-worker", "racing-wait", { durationMs: 1_000 })
          .then(
            () => null,
            (error: unknown) => error,
          );
        await sleep(20);

        if (transitionKind === "complete") {
          await transition.query("SELECT workhorse.complete_v1($1, $2, $3, '{}'::jsonb)", [
            id,
            "race-worker",
            job!.fenceToken.toString(),
          ]);
        } else if (transitionKind === "fail") {
          await transition.query("SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb, 0)", [
            id,
            "race-worker",
            job!.fenceToken.toString(),
            JSON.stringify({ message: "retry" }),
          ]);
        } else {
          await sleep(110);
          await transition.query("SELECT workhorse.recover_expired_v1(100)");
        }
        await transition.query("COMMIT");

        await expect(scheduling).resolves.toMatchObject({ name: "WaitLeaseLostError" });
        await expect(queue.getWait(id, "racing-wait")).resolves.toBeNull();
        await expect(queue.getJob(id)).resolves.toMatchObject({
          state: transitionKind === "complete" ? "succeeded" : "ready",
        });
      } finally {
        await transition.query("ROLLBACK").catch(() => undefined);
        transition.release();
      }
    },
  );

  it("carries the wait marker through due promotion and emits lifecycle events", async () => {
    const id = await queue.enqueue("wait-promotion", {});
    const job = await queue.claim("promotion-worker");
    const scheduled = await queue.scheduleWait(job!, "promotion-worker", "promotion-boundary", {
      durationMs: 30,
    });
    await sleep(50);

    expect(await queue.promote()).toBe(1);
    const runtime = await pool.query<{
      state: string;
      wait_name: string | null;
      attempt_started_at: Date;
    }>("SELECT state, wait_name, attempt_started_at FROM workhorse.job_runtime WHERE job_id = $1", [
      id,
    ]);
    expect(runtime.rows[0]).toMatchObject({
      state: "ready",
      wait_name: null,
      attempt_started_at: expect.any(Date),
    });

    const events = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM workhorse.job_event
        WHERE job_id = $1 AND event_type IN ('wait_scheduled', 'wait_elapsed')
        ORDER BY event_id`,
      [id],
    );
    expect(events.rows).toEqual([
      {
        event_type: "wait_scheduled",
        details: expect.objectContaining({
          name: "promotion-boundary",
          mode: "relative",
          duration_ms: 30,
          wake_at: expect.any(String),
        }),
      },
      {
        event_type: "wait_elapsed",
        details: {
          name: "promotion-boundary",
          reason: "due",
          wake_at: expect.any(String),
        },
      },
    ]);
    expect(new Date(String(events.rows[0]!.details.wake_at))).toEqual(scheduled.wait.wakeAt);
    expect(new Date(String(events.rows[1]!.details.wake_at))).toEqual(scheduled.wait.wakeAt);
  });

  it("preserves one logical attempt across suspension and records truthful claim timestamps", async () => {
    const id = await queue.enqueue("wait-success", {});
    let handlerRuns = 0;
    const worker = new Worker(queue, {
      workerId: "wait-success-worker",
      maintenanceIntervalMs: 100,
    }).handle("wait-success", async (_payload, context) => {
      handlerRuns += 1;
      await context.sleep("brief-pause", 30);
      return { handlerRuns };
    });

    expect(await worker.runOnce()).toBe(true);
    const suspended = await pool.query<{ attempt_started_at: Date }>(
      "SELECT attempt_started_at FROM workhorse.job_runtime WHERE job_id = $1",
      [id],
    );
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);

    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 1,
      result: { handlerRuns: 2 },
    });
    const attempts = await pool.query<{
      attempt: number;
      outcome: string;
      started_at: Date;
      claimed_at: Date;
    }>(
      `SELECT attempt, outcome, started_at, claimed_at
         FROM workhorse.attempt_history
        WHERE job_id = $1`,
      [id],
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toMatchObject({ attempt: 1, outcome: "succeeded" });
    expect(attempts.rows[0]!.started_at).toEqual(suspended.rows[0]!.attempt_started_at);
    expect(attempts.rows[0]!.claimed_at.getTime()).toBeGreaterThan(
      attempts.rows[0]!.started_at.getTime(),
    );
    const claims = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'claimed'`,
      [id],
    );
    expect(claims.rows[0]!.count).toBe(2);
  });

  it("closes the same logical attempt when the handler fails after waking", async () => {
    const id = await queue.enqueue("wait-then-fail", {}, { maxAttempts: 1 });
    let handlerRuns = 0;
    const worker = new Worker(queue, {
      workerId: "wait-failure-worker",
      maintenanceIntervalMs: 100,
    }).handle("wait-then-fail", async (_payload, context) => {
      handlerRuns += 1;
      await context.sleep("before-failure", 30);
      throw new Error("failed after wake");
    });

    expect(await worker.runOnce()).toBe(true);
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);

    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "failed", currentAttempt: 1 });
    expect(handlerRuns).toBe(2);
    const attempts = await pool.query(
      "SELECT attempt, outcome FROM workhorse.attempt_history WHERE job_id = $1",
      [id],
    );
    expect(attempts.rows).toEqual([{ attempt: 1, outcome: "failed" }]);
  });

  it("supports multiple distinct durable waits in one logical attempt", async () => {
    const id = await queue.enqueue("multiple-waits", {});
    let handlerRuns = 0;
    let secondTarget: Date | undefined;
    const observedFirstWaits: Array<string | null> = [];
    const worker = new Worker(queue, {
      workerId: "multiple-waits-worker",
      maintenanceIntervalMs: 100,
    }).handle("multiple-waits", async (_payload, context) => {
      handlerRuns += 1;
      observedFirstWaits.push((await context.getWait("first"))?.name ?? null);
      await context.sleep("first", 30);
      secondTarget ??= new Date(Date.now() + 30);
      await context.sleepUntil("second", secondTarget);
      return { handlerRuns };
    });

    expect(await worker.runOnce()).toBe(true);
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);

    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 1,
      result: { handlerRuns: 3 },
    });
    expect(observedFirstWaits).toEqual([null, "first", "first"]);
    const waits = await queue.listWaits(id);
    expect(waits.map((wait) => [wait.name, wait.mode])).toEqual([
      ["first", "relative"],
      ["second", "absolute"],
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("retains waits through terminal outcome and cascades them with the parent job", async () => {
    const id = await queue.enqueue("wait-retention", {});
    const job = await queue.claim("retention-worker");
    const wait = await queue.scheduleWait(job!, "retention-worker", "past", {
      wakeAt: new Date(Date.now() - 1),
    });
    expect(await queue.complete(job!, "retention-worker", { ok: true })).toBe(true);

    await expect(queue.getWait(id, "past")).resolves.toEqual(wait.wait);
    await expect(queue.listWaits(id)).resolves.toEqual([wait.wait]);
    await pool.query("DELETE FROM workhorse.job WHERE id = $1", [id]);
    await expect(queue.getWait(id, "past")).resolves.toBeNull();
    await expect(queue.listWaits(id)).resolves.toEqual([]);
  });

  it("releases the worker slot immediately when a handler suspends", async () => {
    const waitingId = await queue.enqueue("slot-waiting", {});
    const followingId = await queue.enqueue("slot-following", {});
    const handled: string[] = [];
    const worker = new Worker(queue, { workerId: "slot-worker" })
      .handle("slot-waiting", async (_payload, context) => {
        handled.push("waiting");
        await context.sleep("long-wait", 60_000);
        return null;
      })
      .handle("slot-following", () => {
        handled.push("following");
        return { ok: true };
      });

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(waitingId)).resolves.toMatchObject({ state: "scheduled" });
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(followingId)).resolves.toMatchObject({ state: "succeeded" });
    expect(handled).toEqual(["waiting", "following"]);
  });

  it("replays handler code without repeating checkpointed work", async () => {
    const id = await queue.enqueue("checkpoint-before-wait", {});
    let handlerRuns = 0;
    let expensiveOperations = 0;
    const worker = new Worker(queue, {
      workerId: "checkpoint-wait-worker",
      maintenanceIntervalMs: 100,
    }).handle("checkpoint-before-wait", async (_payload, context) => {
      handlerRuns += 1;
      const prepared = await context.checkpoint("prepare", () => {
        expensiveOperations += 1;
        return { operation: expensiveOperations };
      });
      await context.sleep("after-prepare", 30);
      return { prepared, handlerRuns };
    });

    expect(await worker.runOnce()).toBe(true);
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);

    expect(handlerRuns).toBe(2);
    expect(expensiveOperations).toBe(1);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { prepared: { operation: 1 }, handlerRuns: 2 },
    });
  });

  it("does not complete or fail when application code catches the suspension sentinel", async () => {
    const id = await queue.enqueue("caught-wait-sentinel", {});
    let caught = false;
    let codeAfterCatch = false;
    const worker = new Worker(queue, { workerId: "caught-sentinel-worker" }).handle(
      "caught-wait-sentinel",
      async (_payload, context) => {
        try {
          await context.sleep("caught", 60_000);
        } catch {
          caught = true;
        }
        codeAfterCatch = true;
        return { shouldNotComplete: true };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(caught).toBe(true);
    expect(codeAfterCatch).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "scheduled" });
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY event_id",
      [id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "enqueued",
      "claimed",
      "wait_scheduled",
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("records immutable retry and success attempts", async () => {
    const id = await queue.enqueue("email", { to: "a@example.com" }, { maxAttempts: 2 });
    const first = await queue.claim("worker-a");
    expect(await queue.fail(first!, "worker-a", new Error("temporary"), 0)).toBe("ready");
    expect((await queue.getJob(id))?.fenceToken).toBe(0n);
    const second = await queue.claim("worker-a");
    expect(second?.attempt).toBe(2);
    expect(await queue.complete(second!, "worker-a", { ok: true })).toBe(true);

    const attempts = await pool.query(
      "SELECT attempt, outcome FROM workhorse.attempt_history WHERE job_id = $1 ORDER BY attempt",
      [id],
    );
    expect(attempts.rows).toEqual([
      { attempt: 1, outcome: "retry" },
      { attempt: 2, outcome: "succeeded" },
    ]);
    const events = await pool.query(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY event_id",
      [id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "enqueued",
      "claimed",
      "retry_scheduled",
      "claimed",
      "succeeded",
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state, result FROM workhorse.job_outcome WHERE job_id = $1", [id]))
        .rows[0],
    ).toEqual({ state: "succeeded", result: { ok: true } });
  });

  it("uses Sidekiq-inspired SQL backoff with jitter when no retry delay is supplied", async () => {
    const id = await queue.enqueue("backoff", {}, { maxAttempts: 3 });
    const first = await queue.claim("worker-a");
    expect(await queue.fail(first!, "worker-a", new Error("immediate override"), 0)).toBe("ready");

    const second = await queue.claim("worker-a");
    const beforeFailure = new Date();

    expect(second?.attempt).toBe(2);
    expect(await queue.fail(second!, "worker-a", new Error("temporary"))).toBe("scheduled");

    const retry = await pool.query<{
      current_attempt: number;
      run_at: Date;
      delay_seconds: number;
    }>(
      `SELECT current_attempt, run_at,
              extract(epoch FROM (run_at - $2::timestamptz))::double precision AS delay_seconds
         FROM workhorse.job_runtime
        WHERE job_id = $1`,
      [id, beforeFailure],
    );
    expect(retry.rows[0]!.current_attempt).toBe(3);
    expect(retry.rows[0]!.run_at.getTime()).toBeGreaterThan(Date.now());
    // retry count 1: 1^4 + 15 + rand(0..9) * 2 => [16, 34] seconds.
    expect(retry.rows[0]!.delay_seconds).toBeGreaterThanOrEqual(16);
    expect(retry.rows[0]!.delay_seconds).toBeLessThan(35);
  });

  it("validates, persists, and publicly maps retry policies across batch and schedules", async () => {
    for (const [index, retryPolicy] of [
      { type: "fixed", delayMs: 1.5 },
      { type: "fixed", delayMs: 31_536_000_001 },
      { type: "exponential", initialDelayMs: 100, multiplier: 0, maxDelayMs: 1_000 },
      { type: "exponential", initialDelayMs: 1_001, multiplier: 2, maxDelayMs: 1_000 },
      { type: "decorrelated-jitter", baseDelayMs: 1_001, maxDelayMs: 1_000 },
      { type: "fixed", delayMs: 100, extra: true },
    ].entries()) {
      await expect(
        queue.enqueue(`invalid-${index}`, {}, { retryPolicy: retryPolicy as never }),
      ).rejects.toThrow(/retryPolicy|delayMs|multiplier|maxDelayMs/);
    }
    const retryPolicy = {
      type: "exponential" as const,
      initialDelayMs: 1_000,
      multiplier: 3,
      maxDelayMs: 31_536_000_000,
    };
    const [id] = await queue.enqueueMany([
      { type: "mapped", payload: {}, options: { queue: "mapped", retryPolicy } },
    ]);
    await expect(queue.getJob(id!)).resolves.toMatchObject({ retryPolicy });
    await expect(queue.claim("mapped-worker", { queue: "mapped" })).resolves.toMatchObject({
      retryPolicy,
    });

    const scheduledPolicy = {
      type: "decorrelated-jitter" as const,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    };
    await queue.syncSchedules("retry", [
      {
        name: "policy",
        schedule: "0 * * * *",
        job: { type: "scheduled", payload: {}, retryPolicy: scheduledPolicy },
      },
    ]);
    const stored = await pool.query<{ revision: string; retry_policy: unknown }>(
      "SELECT revision::text, retry_policy FROM workhorse.schedule_definition WHERE namespace = 'retry' AND schedule_name = 'policy'",
    );
    expect(stored.rows[0]!.retry_policy).toEqual(scheduledPolicy);
    const scheduledId = await queue.fireSchedule(
      "retry",
      "policy",
      BigInt(stored.rows[0]!.revision),
      new Date("2026-08-01T01:00:00Z"),
    );
    await expect(queue.getJob(scheduledId!)).resolves.toMatchObject({
      retryPolicy: scheduledPolicy,
    });
  });

  it("applies policies to failure and recovery with caps and reproducible decorrelated jitter", async () => {
    const fixed = { type: "fixed" as const, delayMs: 5_000 };
    const failId = await queue.enqueue(
      "fixed-fail",
      {},
      { queue: "fixed-fail", maxAttempts: 2, retryPolicy: fixed },
    );
    const failClaim = await queue.claim("fixed-fail-worker", { queue: "fixed-fail" });
    expect(await queue.fail(failClaim!, "fixed-fail-worker", new Error("retry"))).toBe("scheduled");
    const recoverId = await queue.enqueue(
      "fixed-recover",
      {},
      { queue: "fixed-recover", maxAttempts: 2, retryPolicy: fixed },
    );
    await queue.claim("fixed-recover-worker", { queue: "fixed-recover", leaseMs: 100 });
    await pool.query(
      "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE job_id = $1",
      [recoverId],
    );
    expect((await queue.tick()).find((phase) => phase.phase === "recover")?.rowsAffected).toBe(1);
    const events = await pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM workhorse.job_event WHERE job_id = ANY($1::uuid[]) AND event_type IN ('retry_scheduled', 'lease_expired')",
      [[failId, recoverId]],
    );
    for (const event of events.rows)
      expect(event.details).toMatchObject({
        retry_policy: fixed,
        retry_delay_ms: 5_000,
        retry_delay_source: "policy:fixed",
      });

    const capped = await pool.query<{ delay_ms: string }>(
      `SELECT retry.delay_ms::text FROM generate_series(1, 4) attempt
       CROSS JOIN LATERAL workhorse.retry_delay_v1(gen_random_uuid(), attempt, $1::jsonb, NULL, NULL, 'legacy-handler') retry`,
      [
        JSON.stringify({
          type: "exponential",
          initialDelayMs: 1_000,
          multiplier: 2,
          maxDelayMs: 2_500,
        }),
      ],
    );
    expect(capped.rows.map((row) => Number(row.delay_ms))).toEqual([1_000, 2_000, 2_500, 2_500]);

    const jitter = { type: "decorrelated-jitter" as const, baseDelayMs: 1_000, maxDelayMs: 30_000 };
    const jitterId = await queue.enqueue(
      "jitter",
      {},
      { queue: "jitter", maxAttempts: 3, retryPolicy: jitter },
    );
    let previous: number | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const claim = await new Queue(pool).claim(`jitter-${attempt}`, { queue: "jitter" });
      expect(await queue.fail(claim!, `jitter-${attempt}`, new Error("retry"))).toBe("scheduled");
      const runtime = await pool.query<{ delay: string }>(
        "SELECT previous_retry_delay_ms::text AS delay FROM workhorse.job_runtime WHERE job_id = $1",
        [jitterId],
      );
      const selected = Number(runtime.rows[0]!.delay);
      const replay = await pool.query<{ delay_ms: string }>(
        "SELECT delay_ms::text FROM workhorse.retry_delay_v1($1, $2, $3::jsonb, $4, NULL, 'legacy-handler')",
        [jitterId, attempt, JSON.stringify(jitter), previous],
      );
      expect(Number(replay.rows[0]!.delay_ms)).toBe(selected);
      previous = selected;
      if (attempt === 1)
        await pool.query(
          "UPDATE workhorse.job_runtime SET state = 'ready', run_at = clock_timestamp(), ready_at = clock_timestamp(), sequence = nextval('workhorse.ready_sequence_seq') WHERE job_id = $1",
          [jitterId],
        );
    }
  });

  it("preserves omitted recovery and explicit numeric/callback override precedence", async () => {
    const legacyId = await queue.enqueue("legacy", {}, { queue: "legacy", maxAttempts: 2 });
    await queue.claim("legacy-worker", { queue: "legacy", leaseMs: 100 });
    await pool.query(
      "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE job_id = $1",
      [legacyId],
    );
    expect(await queue.recoverExpired()).toBe(1);
    const policy = { type: "fixed" as const, delayMs: 60_000 };
    const numericId = await queue.enqueue(
      "numeric",
      {},
      { queue: "numeric", maxAttempts: 2, retryPolicy: policy },
    );
    const numeric = await queue.claim("numeric-worker", { queue: "numeric" });
    expect(await queue.fail(numeric!, "numeric-worker", new Error("retry"), 0)).toBe("ready");
    const callbackId = await queue.enqueue(
      "callback",
      {},
      { queue: "callback", maxAttempts: 2, retryPolicy: policy },
    );
    const worker = new Worker(queue, {
      workerId: "callback-worker",
      queue: "callback",
      pollMs: 0,
      retryDelayMs: () => 0,
    }).handle("callback", () => {
      throw new Error("retry");
    });
    expect(await worker.runOnce()).toBe(true);
    const recoveryId = await queue.enqueue(
      "recovery",
      {},
      { queue: "recovery", maxAttempts: 2, retryPolicy: policy },
    );
    await queue.claim("recovery-worker", { queue: "recovery", leaseMs: 100 });
    await pool.query(
      "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE job_id = $1",
      [recoveryId],
    );
    expect(await queue.recoverExpired(100, 0)).toBe(1);
    const sources = await pool.query<{ job_id: string; source: string }>(
      "SELECT job_id, details->>'retry_delay_source' AS source FROM workhorse.job_event WHERE job_id = ANY($1::uuid[]) AND event_type IN ('retry_scheduled', 'lease_expired')",
      [[legacyId, numericId, callbackId, recoveryId]],
    );
    expect(new Map(sources.rows.map((row) => [row.job_id, row.source]))).toEqual(
      new Map([
        [legacyId, "lease-recovery-immediate"],
        [numericId, "override"],
        [callbackId, "override"],
        [recoveryId, "override"],
      ]),
    );
  });

  it("passes the claimed job to retry delay callbacks", async () => {
    const delayMs = 300_000;
    const observed: Array<{ attempt: number; type: string; payload: unknown }> = [];
    const worker = new Worker(queue, {
      workerId: "job-aware-retry-worker",
      pollMs: 0,
      retryDelayMs: (attempt, job) => {
        observed.push({ attempt, type: job.type, payload: job.payload });
        return (job.payload as { retryDelayMs: number }).retryDelayMs;
      },
    });
    worker.handle("job-aware-retry", () => {
      throw new Error("intentional job-aware retry");
    });
    const id = await queue.enqueue(
      "job-aware-retry",
      { retryDelayMs: delayMs },
      { maxAttempts: 2 },
    );
    const before = Date.now();

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(observed).toEqual([
      { attempt: 1, type: "job-aware-retry", payload: { retryDelayMs: delayMs } },
    ]);
    const runtime = await pool.query<{ state: string; current_attempt: number; run_at: Date }>(
      "SELECT state, current_attempt, run_at FROM workhorse.job_runtime WHERE job_id = $1",
      [id],
    );
    expect(runtime.rows[0]).toMatchObject({ state: "scheduled", current_attempt: 2 });
    expect(runtime.rows[0]!.run_at.getTime()).toBeGreaterThanOrEqual(before + delayMs);
    expect(runtime.rows[0]!.run_at.getTime()).toBeLessThanOrEqual(Date.now() + delayMs);
  });

  it("moves a terminal handler failure to failed", async () => {
    const id = await queue.enqueue("email", {}, { maxAttempts: 1 });
    const job = await queue.claim("worker-a");
    expect(await queue.fail(job!, "worker-a", new Error("permanent"))).toBe("failed");
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

  it("rejects retry when the live runtime fence is inconsistent", async () => {
    await queue.enqueue("work", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a");
    await pool.query(
      "UPDATE workhorse.job_runtime SET fence_token = fence_token + 1 WHERE job_id = $1",
      [job!.id],
    );
    await expect(queue.fail(job!, "worker-a", new Error("retry"))).resolves.toBe("stale");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE state = 'active'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE state = 'ready'",
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("recovery CAS skips a runtime whose active fence changed", async () => {
    await queue.enqueue("work", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a", { leaseMs: 100 });
    await pool.query(
      "UPDATE workhorse.job_runtime SET fence_token = fence_token + 1 WHERE job_id = $1",
      [job!.id],
    );
    await sleep(130);
    await expect(queue.recoverExpired()).resolves.toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE state = 'ready'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query("SELECT current_attempt FROM workhorse.job_runtime WHERE job_id = $1", [
          job!.id,
        ])
      ).rows[0].current_attempt,
    ).toBe(2);
  });
  it("does not query durability tables for handlers that use no durability helpers", async () => {
    const durabilityQueries: string[] = [];
    const countingDatabase: Queryable = {
      query(text, values) {
        if (/workhorse\.job_(?:checkpoint|wait)\b/.test(text)) durabilityQueries.push(text);
        return pool.query(text, values ? [...values] : undefined);
      },
    };
    const countingQueue = new Queue(countingDatabase);
    const id = await countingQueue.enqueue("ordinary-handler", { value: 42 });
    const worker = new Worker(countingQueue, { workerId: "ordinary-worker" }).handle<
      { value: number },
      { value: number }
    >("ordinary-handler", ({ value }) => ({ value }));

    expect(await worker.runOnce()).toBe(true);
    await expect(countingQueue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { value: 42 },
    });
    expect(durabilityQueries).toEqual([]);
  });

  it("loads each durability cache only once on first helper use", async () => {
    const durabilityQueries: string[] = [];
    const countingDatabase: Queryable = {
      query(text, values) {
        if (/workhorse\.job_(?:checkpoint|wait)\b/.test(text)) durabilityQueries.push(text);
        return pool.query(text, values ? [...values] : undefined);
      },
    };
    const countingQueue = new Queue(countingDatabase);
    await countingQueue.enqueue("durability-reads", {});
    const worker = new Worker(countingQueue, { workerId: "durability-read-worker" }).handle(
      "durability-reads",
      async (_payload, context) => {
        await Promise.all([
          context.getCheckpoint("first"),
          context.getCheckpoint("second"),
          context.getWait("first"),
          context.getWait("second"),
        ]);
        return null;
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(durabilityQueries.filter((query) => query.includes("job_checkpoint"))).toHaveLength(1);
    expect(durabilityQueries.filter((query) => query.includes("job_wait"))).toHaveLength(1);
  });

  it("reuses a completed checkpoint when a later attempt restarts the handler", async () => {
    const id = await queue.enqueue("checkpoint-retry", {}, { maxAttempts: 2 });
    let externalEffects = 0;
    const worker = new Worker(queue, {
      workerId: "checkpoint-worker",
      retryDelayMs: 0,
    }).handle("checkpoint-retry", async (_payload, context) => {
      const authorization = await context.checkpoint("authorize", () => {
        externalEffects += 1;
        return { authorizationId: `auth-${externalEffects}` };
      });
      if (context.job.attempt === 1) throw new Error("crash after durable checkpoint");
      return authorization;
    });

    expect(await worker.runOnce()).toBe(true);
    expect((await queue.getJob(id))?.state).toBe("ready");
    expect(await worker.runOnce()).toBe(true);

    expect(externalEffects).toBe(1);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { authorizationId: "auth-1" },
    });
    await expect(queue.getCheckpoint(id, "authorize")).resolves.toMatchObject({
      value: { authorizationId: "auth-1" },
      attempt: 1,
      workerId: "checkpoint-worker",
    });
  });

  it("coalesces overlapping handler calls for the same checkpoint name", async () => {
    const id = await queue.enqueue("checkpoint-overlap", {});
    let operations = 0;
    const worker = new Worker(queue, { workerId: "checkpoint-worker" }).handle(
      "checkpoint-overlap",
      async (_payload, context) => {
        const operation = async () => {
          operations += 1;
          await sleep(10);
          return { operation: operations };
        };
        const [first, second] = await Promise.all([
          context.checkpoint("shared", operation),
          context.checkpoint("shared", operation),
        ]);
        return { first, second };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(operations).toBe(1);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      result: {
        first: { operation: 1 },
        second: { operation: 1 },
      },
    });
  });
});
