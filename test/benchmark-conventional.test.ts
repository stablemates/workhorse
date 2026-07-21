import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  conventionalSchema,
  ConventionalQueue,
  conventionalSql,
} from "../benchmarks/conventional.js";
import { assertLocalDatabasePurpose, localDatabaseUrl } from "../src/local-database.js";

const databaseUrl = localDatabaseUrl("test");
assertLocalDatabasePurpose(databaseUrl, "test");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const queue = new ConventionalQueue(pool, "benchmark-conventional-test");

async function enqueueSequence(jobId: string): Promise<number | null> {
  const result = await pool.query<{ enqueue_sequence: string | null }>(
    `SELECT enqueue_sequence FROM ${conventionalSchema}.job WHERE id = $1`,
    [jobId],
  );
  const value = result.rows[0]!.enqueue_sequence;
  return value === null ? null : Number(value);
}

beforeAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${conventionalSchema} CASCADE`);
  await queue.setup();
});

beforeEach(async () => {
  await queue.reset();
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${conventionalSchema} CASCADE`);
  await pool.end();
});

describe("conventional benchmark SQL", () => {
  it("defines the resettable enqueue sequence in the ready claim path", () => {
    expect(conventionalSql).toContain(
      "CREATE SEQUENCE IF NOT EXISTS ironshift_benchmark_conventional.enqueue_sequence_seq",
    );
    expect(conventionalSql).toContain("(queue_name, enqueue_sequence, id)");
    expect(conventionalSql).toContain("ORDER BY enqueue_sequence, id");
    expect(conventionalSql).toContain("enqueue_sequence_seq RESTART WITH 1");
  });

  it("sets up and resets queue data and monotonic sequences", async () => {
    const first = await queue.enqueue("first", {});
    const second = await queue.enqueue("second", {});
    expect([await enqueueSequence(first), await enqueueSequence(second)]).toEqual([1, 2]);

    await queue.reset();
    expect(
      (await pool.query(`SELECT count(*)::integer AS count FROM ${conventionalSchema}.job`)).rows[0]
        .count,
    ).toBe(0);

    const afterReset = await queue.enqueue("after-reset", {});
    expect(await enqueueSequence(afterReset)).toBe(1);
    const claimed = await queue.claim("worker-reset");
    expect(claimed?.fenceToken).toBe(1n);
  });

  it("enqueues, claims in FIFO order, and completes", async () => {
    const first = await queue.enqueue("first", { order: 1 });
    await queue.enqueue("second", { order: 2 });

    const claimed = await queue.claim<{ order: number }>("worker-a");
    expect(claimed?.id).toBe(first);
    expect(claimed?.payload).toEqual({ order: 1 });
    expect(await queue.complete(claimed!, "worker-a", { ok: true })).toBe(true);
    expect((await queue.getJob<{ ok: boolean }>(first))?.result).toEqual({ ok: true });
  });

  it("rejects a heartbeat from a stale fence generation", async () => {
    await queue.enqueue("heartbeat", {});
    const claimed = await queue.claim("worker-a", { leaseMs: 1_000 });

    expect(await queue.heartbeat(claimed!, "worker-a", 1_000)).toBe(true);
    expect(
      await queue.heartbeat(
        { ...claimed!, fenceToken: claimed!.fenceToken + 1n },
        "worker-a",
        1_000,
      ),
    ).toBe(false);
  });

  it("puts an immediate retry at the tail of the ready FIFO", async () => {
    const retriedId = await queue.enqueue("retried", {}, { maxAttempts: 2 });
    const firstAttempt = await queue.claim("worker-a");
    const waitingId = await queue.enqueue("waiting", {});

    expect(await queue.fail(firstAttempt!, "worker-a", new Error("temporary"))).toBe("ready");
    expect(await enqueueSequence(retriedId)).toBeGreaterThan((await enqueueSequence(waitingId))!);

    expect((await queue.claim("worker-b"))?.id).toBe(waitingId);
    const retry = await queue.claim("worker-c");
    expect(retry?.id).toBe(retriedId);
    expect(retry?.attempt).toBe(2);
  });

  it("assigns a fresh FIFO sequence only when scheduled work is promoted", async () => {
    const scheduledId = await queue.enqueue(
      "scheduled",
      {},
      { runAt: new Date(Date.now() + 60_000) },
    );
    const readyId = await queue.enqueue("ready", {});
    expect(await enqueueSequence(scheduledId)).toBeNull();

    await pool.query(
      `UPDATE ${conventionalSchema}.job SET run_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [scheduledId],
    );
    expect(await queue.promote()).toBe(1);
    expect(await enqueueSequence(scheduledId)).toBeGreaterThan((await enqueueSequence(readyId))!);
    expect((await queue.claim("worker-a"))?.id).toBe(readyId);
    expect((await queue.claim("worker-b"))?.id).toBe(scheduledId);
  });

  it("recovers an expired lease at the FIFO tail and fences the stale worker", async () => {
    const recoveredId = await queue.enqueue("recover", {}, { maxAttempts: 2 });
    const staleClaim = await queue.claim("worker-stale", { leaseMs: 1_000 });
    const waitingId = await queue.enqueue("waiting", {});

    await pool.query(
      `UPDATE ${conventionalSchema}.job SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [recoveredId],
    );
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.complete(staleClaim!, "worker-stale", { stale: true })).toBe(false);
    expect(await enqueueSequence(recoveredId)).toBeGreaterThan((await enqueueSequence(waitingId))!);

    expect((await queue.claim("worker-current"))?.id).toBe(waitingId);
    const recovered = await queue.claim("worker-recovery");
    expect(recovered?.id).toBe(recoveredId);
    expect(recovered?.attempt).toBe(2);
    expect(recovered!.fenceToken).toBeGreaterThan(staleClaim!.fenceToken);
  });
});
