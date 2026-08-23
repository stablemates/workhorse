import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Queue, Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);

describe("retry and attempt lifecycle", () => {
  it("records immutable retry and success attempts", async () => {
    const id = await queue.enqueue("email", { to: "a@example.com" }, { maxAttempts: 2 });
    const first = await queue.claim("worker-a");
    expect(await queue.fail(first!, "worker-a", new Error("temporary"), 0)).toBe("ready");
    expect((await admin.getJob(id))?.fenceToken).toBe(0n);
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
    await expect(admin.getJob(id!)).resolves.toMatchObject({ retryPolicy });
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
    await expect(admin.getJob(scheduledId!)).resolves.toMatchObject({
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
    expect((await admin.getJob(id))?.state).toBe("failed");
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
});
