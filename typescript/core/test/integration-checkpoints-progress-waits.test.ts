import { setTimeout as sleep } from "node:timers/promises";
import { logs, type LogRecord, type LoggerProvider } from "@opentelemetry/api-logs";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_CHECKPOINT_VALUE_BYTES,
  MAX_PROGRESS_VALUE_BYTES,
  Queue,
  type Queryable,
  Worker,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

registerOpenTelemetry();

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);
const records: LogRecord[] = [];
const provider: LoggerProvider = {
  getLogger: () => ({
    enabled: () => true,
    emit: (record) => records.push(record),
  }),
};

beforeAll(() => {
  logs.setGlobalLoggerProvider(provider);
});

afterAll(() => {
  logs.disable();
});

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
    await expect(admin.getCheckpoint(id, "payment-authorized")).resolves.toEqual(saved);
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
    await expect(admin.getCheckpoint(id, "payment-authorized")).resolves.toEqual(saved);
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY occurred_at, event_id",
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
    await expect(admin.getCheckpoint(id, "oversized")).resolves.toBeNull();
    await expect(admin.getCheckpoint(id, "oversized-sql")).resolves.toBeNull();
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
    await expect(admin.getCheckpoint(id, "stale-step")).resolves.toBeNull();
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
      await expect(admin.getCheckpoint(id, "racing-step")).resolves.toBeNull();
      await expect(admin.getJob(id)).resolves.toMatchObject({ state: "ready", currentAttempt: 2 });
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
      await expect(admin.getCheckpoint(id, "too-late")).resolves.toBeNull();
      await expect(admin.getJob(id)).resolves.toMatchObject({
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
    await expect(admin.getCheckpoint(id, "before-failure")).resolves.toEqual(checkpoint);
    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "failed" });
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
      await expect(admin.getCheckpoint(id, "expired-while-waiting")).resolves.toBeNull();
      await expect(admin.getJob(id)).resolves.toMatchObject({ state: "active" });
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
    await expect(admin.getProgress(id)).resolves.toEqual(first);
    await expect(admin.getJob(id)).resolves.toMatchObject({ progress: first });

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
    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "succeeded", progress: second });
    const events = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'progress_updated' ORDER BY occurred_at, event_id`,
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
      await expect(admin.getProgress(id)).resolves.toBeNull();
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
    await expect(admin.getJob(id)).resolves.toMatchObject({
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
    await expect(admin.getWait(id, "provider-cooldown")).resolves.toEqual(result.wait);
    await expect(admin.listWaits(id)).resolves.toEqual([result.wait]);

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
    await expect(admin.getJob(id)).resolves.toMatchObject({
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
    await expect(admin.getWait(id, "embargo")).resolves.toEqual(first.wait);
    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "active", currentAttempt: 1 });
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
    await expect(admin.getWait(id, "too-far")).resolves.toBeNull();

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
    await expect(admin.getWait(id, "overflow")).resolves.toBeNull();
    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "active" });
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
    await expect(admin.getJob(id)).resolves.toMatchObject({
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
      await expect(admin.getWait(id, "expired-while-blocked")).resolves.toBeNull();
      await expect(admin.getJob(id)).resolves.toMatchObject({ state: "active" });
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
      await expect(admin.getWait(id, "expired-during-transition")).resolves.toBeNull();
      await expect(admin.getJob(id)).resolves.toMatchObject({ state: "active" });
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
        await expect(admin.getWait(id, "racing-wait")).resolves.toBeNull();
        await expect(admin.getJob(id)).resolves.toMatchObject({
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
        ORDER BY occurred_at, event_id`,
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

    await expect(admin.getJob(id)).resolves.toMatchObject({
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

    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "failed", currentAttempt: 1 });
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

    await expect(admin.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 1,
      result: { handlerRuns: 3 },
    });
    expect(observedFirstWaits).toEqual([null, "first", "first"]);
    const waits = await admin.listWaits(id);
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

    await expect(admin.getWait(id, "past")).resolves.toEqual(wait.wait);
    await expect(admin.listWaits(id)).resolves.toEqual([wait.wait]);
    await pool.query("DELETE FROM workhorse.job WHERE id = $1", [id]);
    await expect(admin.getWait(id, "past")).resolves.toBeNull();
    await expect(admin.listWaits(id)).resolves.toEqual([]);
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
    await expect(admin.getJob(waitingId)).resolves.toMatchObject({ state: "scheduled" });
    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(followingId)).resolves.toMatchObject({ state: "succeeded" });
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
    await expect(admin.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { prepared: { operation: 1 }, handlerRuns: 2 },
    });
  });

  it("does not complete or fail when application code catches the suspension sentinel", async () => {
    records.length = 0;
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
    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "scheduled" });
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY occurred_at, event_id",
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
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: "workhorse.handler.signal_swallowed",
          severityText: "WARN",
          attributes: expect.objectContaining({
            "workhorse.job.id": id,
            "workhorse.handler.outcome": "suspended",
          }),
        }),
      ]),
    );
  });

  it("preserves durable suspension when application code catches and throws a different error", async () => {
    const id = await queue.enqueue("rethrown-wait-sentinel", {});
    let caught: unknown;
    const worker = new Worker(queue, { workerId: "rethrown-sentinel-worker" }).handle(
      "rethrown-wait-sentinel",
      async (_payload, context) => {
        try {
          await context.sleep("rethrown", 60_000);
        } catch (error) {
          caught = error;
          throw new Error("replacement handler error", { cause: error });
        }
        return { shouldNotComplete: true };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(caught).toBeDefined();
    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "scheduled" });
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY occurred_at, event_id",
      [id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "enqueued",
      "claimed",
      "wait_scheduled",
    ]);
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
    await expect(admin.getJob(id)).resolves.toMatchObject({
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
    expect((await admin.getJob(id))?.state).toBe("ready");
    expect(await worker.runOnce()).toBe(true);

    expect(externalEffects).toBe(1);
    await expect(admin.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { authorizationId: "auth-1" },
    });
    await expect(admin.getCheckpoint(id, "authorize")).resolves.toMatchObject({
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
    await expect(admin.getJob(id)).resolves.toMatchObject({
      result: {
        first: { operation: 1 },
        second: { operation: 1 },
      },
    });
  });
});
