import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

// A completion or heartbeat that waits for another transaction's row lock must judge the lease at
// the time it gets the lock, not the time it started waiting (SM-1036).

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

type Tier = "fast" | "full";

/** Enqueue one task and give it to `workerId` with fence 1 and a lease that ends after `leaseMs`. */
async function activeTask(tier: Tier, name: string, workerId: string, leaseMs: number) {
  const queueName = `clock-after-lock-${name}`;
  if (tier === "fast") {
    await admin.setQueueTier(queueName, "fast", adminAudit("move to the fast tier"));
  }
  const id = await queue.enqueue("held", {}, { queue: queueName });
  if (tier === "fast") {
    await pool.query(
      `UPDATE workhorse.fast_task_runtime
          SET state = 'active', worker_id = $2, claimed_at = clock_timestamp(),
              expires_at = clock_timestamp() + $3 * interval '1 millisecond', fence_token = 1
        WHERE task_id = $1`,
      [id, workerId, leaseMs],
    );
    return { id, fenceToken: 1n, table: "fast_task_runtime" };
  }
  const task = await queue.claim(workerId, { queue: queueName });
  if (task?.id !== id) throw new Error(`expected to claim ${id}`);
  await pool.query(
    `UPDATE workhorse.task_runtime
        SET expires_at = clock_timestamp() + $2 * interval '1 millisecond'
      WHERE task_id = $1`,
    [id, leaseMs],
  );
  return { id, fenceToken: task.fenceToken, table: "task_runtime" };
}

/**
 * Hold the task's row lock while `statement` runs on another connection, and return the statement's
 * rows with the time the lock was released and the time the statement returned. With a number, the lock is held that long after the
 * statement starts waiting. With "until expiry", the lease must still be live once the statement
 * waits, and the lock is held until PostgreSQL's clock passes the lease.
 */
async function callWhileLocked<Row extends object>(
  table: string,
  taskId: string,
  hold: number | "until expiry",
  statement: string,
  values: unknown[],
): Promise<{ rows: Row[]; releasedAt: Date; completedAt: Date }> {
  const blocker = await pool.connect();
  const caller = await pool.connect();
  let call: Promise<{ rows: Row[] }> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT FROM workhorse.${table} WHERE task_id = $1 FOR UPDATE`, [taskId]);
    const callerPid = (await caller.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]!.pid;
    call = caller.query<Row>(statement, values);
    await vi.waitFor(
      async () => {
        const waiting = await pool.query<{ blocked: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
          [callerPid],
        );
        expect(waiting.rows[0]!.blocked).toBe(true);
      },
      { timeout: 10_000, interval: 20 },
    );
    if (hold === "until expiry") {
      const live = await pool.query<{ live: boolean }>(
        `SELECT expires_at > clock_timestamp() AS live FROM workhorse.${table} WHERE task_id = $1`,
        [taskId],
      );
      // The lease must expire during the wait, not before the statement started.
      if (live.rows[0]?.live !== true) throw new Error("the lease expired before the wait began");
      await vi.waitFor(
        async () => {
          const expired = await pool.query<{ expired: boolean }>(
            `SELECT expires_at <= clock_timestamp() AS expired
               FROM workhorse.${table} WHERE task_id = $1`,
            [taskId],
          );
          if (expired.rows[0]?.expired !== true) throw new Error("the lease has not expired yet");
        },
        { timeout: 10_000, interval: 20 },
      );
    } else {
      await sleep(hold);
    }
    const released = await blocker.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    await blocker.query("COMMIT");
    const result = await call;
    const completed = await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    return {
      rows: result.rows,
      releasedAt: released.rows[0]!.now,
      completedAt: completed.rows[0]!.now,
    };
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await call?.catch(() => undefined);
    blocker.release();
    caller.release();
  }
}

const statements = {
  fastAcknowledgeCancel:
    "SELECT workhorse.fast_acknowledge_cancel_v1($2::uuid, $1, $3::bigint) AS acknowledged",
  fastComplete:
    "SELECT workhorse.fast_complete_many_v1($1, ARRAY[$2::uuid], ARRAY[$3::bigint], ARRAY['{\"ok\":true}'::jsonb]) AS accepted",
  fastHeartbeat:
    "SELECT status FROM workhorse.fast_heartbeat_many_v1($1, ARRAY[$2::uuid], ARRAY[$3::bigint], ARRAY[$4::integer])",
  heartbeat: "SELECT workhorse.heartbeat_v1($2::uuid, $1, $3::bigint, $4::integer) AS status",
  heartbeatMany:
    "SELECT status FROM workhorse.heartbeat_many_v1($1, jsonb_build_array(jsonb_build_object('taskId', $2::text, 'fenceToken', $3::bigint, 'leaseMs', $4::integer)))",
} as const;

async function expiresAt(table: string, taskId: string): Promise<Date> {
  const result = await pool.query<{ expires_at: Date }>(
    `SELECT expires_at FROM workhorse.${table} WHERE task_id = $1`,
    [taskId],
  );
  return result.rows[0]!.expires_at;
}

describe("clock after row lock", () => {
  it("rejects a fast completion whose lease expired while it waited for the row lock", async () => {
    const task = await activeTask("fast", "complete-expired", "worker-a", 2_000);
    const { rows } = await callWhileLocked<{ accepted: string[] }>(
      task.table,
      task.id,
      "until expiry",
      statements.fastComplete,
      ["worker-a", task.id, task.fenceToken],
    );

    expect(rows[0]!.accepted).toEqual([]);
    const outcome = await pool.query("SELECT FROM workhorse.fast_task_outcome WHERE task_id = $1", [
      task.id,
    ]);
    expect(outcome.rowCount).toBe(0);
    const runtime = await pool.query<{ state: string }>(
      "SELECT state FROM workhorse.fast_task_runtime WHERE task_id = $1",
      [task.id],
    );
    expect(runtime.rows).toEqual([{ state: "active" }]);
  });

  it("rejects a fast batch completion whose lease expired while another member failed", async () => {
    // Failing an oversized member writes its outcome row. If that write waits, for example behind
    // partition maintenance, a later member's lease can expire before its own completion.
    const oversized = await activeTask("fast", "complete-batch-failing", "worker-a", 60_000);
    const expiring = await activeTask("fast", "complete-batch-expiring", "worker-a", 2_000);
    await pool.query(
      `UPDATE workhorse.fast_task_runtime SET result_max_bytes = 1, max_attempts = 1
        WHERE task_id = $1`,
      [oversized.id],
    );
    const blocker = await pool.connect();
    const caller = await pool.connect();
    let call: Promise<{ rows: { accepted: string[] }[] }> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE workhorse.fast_task_outcome IN SHARE MODE");
      const callerPid = (await caller.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      call = caller.query<{ accepted: string[] }>(
        `SELECT workhorse.fast_complete_many_v1(
                  $1, ARRAY[$2::uuid, $3::uuid], ARRAY[$4::bigint, $5::bigint],
                  ARRAY['{"too":"large"}'::jsonb, '{"ok":true}'::jsonb]
                ) AS accepted`,
        ["worker-a", oversized.id, expiring.id, oversized.fenceToken, expiring.fenceToken],
      );
      await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ blocked: boolean }>(
            "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
            [callerPid],
          );
          expect(waiting.rows[0]!.blocked).toBe(true);
        },
        { timeout: 10_000, interval: 20 },
      );
      const live = await pool.query<{ live: boolean }>(
        "SELECT expires_at > clock_timestamp() AS live FROM workhorse.fast_task_runtime WHERE task_id = $1",
        [expiring.id],
      );
      if (live.rows[0]?.live !== true) throw new Error("the lease expired before the wait began");
      await vi.waitFor(
        async () => {
          const expired = await pool.query<{ expired: boolean }>(
            `SELECT expires_at <= clock_timestamp() AS expired
               FROM workhorse.fast_task_runtime WHERE task_id = $1`,
            [expiring.id],
          );
          if (expired.rows[0]?.expired !== true) throw new Error("the lease has not expired yet");
        },
        { timeout: 10_000, interval: 20 },
      );
      await blocker.query("COMMIT");
      const { rows } = await call;

      expect(rows[0]!.accepted).toEqual([]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await call?.catch(() => undefined);
      blocker.release();
      caller.release();
    }
    const outcomes = await pool.query<{ task_id: string; state: string }>(
      "SELECT task_id, state FROM workhorse.fast_task_outcome WHERE task_id = ANY($1::uuid[])",
      [[oversized.id, expiring.id]],
    );
    expect(outcomes.rows).toEqual([{ task_id: oversized.id, state: "failed" }]);
    const runtime = await pool.query<{ state: string }>(
      "SELECT state FROM workhorse.fast_task_runtime WHERE task_id = $1",
      [expiring.id],
    );
    expect(runtime.rows).toEqual([{ state: "active" }]);
  });

  it("refuses a fast cancellation acknowledgement whose lease expired while it waited for the row lock", async () => {
    const task = await activeTask("fast", "acknowledge-cancel-expired", "worker-a", 2_000);
    await pool.query(
      `UPDATE workhorse.fast_task_runtime
          SET cancel_requested_at = clock_timestamp(), cancel_requested_by = 'operator'
        WHERE task_id = $1`,
      [task.id],
    );
    const { rows } = await callWhileLocked<{ acknowledged: boolean }>(
      task.table,
      task.id,
      "until expiry",
      statements.fastAcknowledgeCancel,
      ["worker-a", task.id, task.fenceToken],
    );

    expect(rows).toEqual([{ acknowledged: false }]);
    const runtime = await pool.query<{ state: string }>(
      "SELECT state FROM workhorse.fast_task_runtime WHERE task_id = $1",
      [task.id],
    );
    expect(runtime.rows).toEqual([{ state: "active" }]);
  });

  it("records an accepted fast completion at the time it got the row lock", async () => {
    const task = await activeTask("fast", "complete-accepted", "worker-a", 60_000);
    const { rows, releasedAt } = await callWhileLocked<{ accepted: string[] }>(
      task.table,
      task.id,
      300,
      statements.fastComplete,
      ["worker-a", task.id, task.fenceToken],
    );

    expect(rows[0]!.accepted).toEqual([task.id]);
    const outcome = await pool.query<{ finished_at: Date }>(
      "SELECT finished_at FROM workhorse.fast_task_outcome WHERE task_id = $1",
      [task.id],
    );
    expect(outcome.rows[0]!.finished_at.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
  });

  it.each([
    ["fast_heartbeat_many_v1", "fast", statements.fastHeartbeat],
    ["heartbeat_v1", "full", statements.heartbeat],
    ["heartbeat_many_v1", "full", statements.heartbeatMany],
  ] as const)(
    "%s does not renew a lease that expired while it waited for the row lock",
    async (name, tier, statement) => {
      const task = await activeTask(tier, `${name}-expired`, "worker-a", 2_000);
      const before = await expiresAt(task.table, task.id);
      const { rows } = await callWhileLocked<{ status: string }>(
        task.table,
        task.id,
        "until expiry",
        statement,
        ["worker-a", task.id, task.fenceToken, 60_000],
      );

      expect(rows).toEqual([{ status: "stale" }]);
      expect(await expiresAt(task.table, task.id)).toEqual(before);
    },
  );

  it.each([
    ["fast_heartbeat_many_v1", "fast", statements.fastHeartbeat],
    ["heartbeat_v1", "full", statements.heartbeat],
    ["heartbeat_many_v1", "full", statements.heartbeatMany],
  ] as const)(
    "%s renews a lease from the time it got the row lock",
    async (name, tier, statement) => {
      const task = await activeTask(tier, `${name}-accepted`, "worker-a", 60_000);
      const { rows, releasedAt, completedAt } = await callWhileLocked<{ status: string }>(
        task.table,
        task.id,
        300,
        statement,
        ["worker-a", task.id, task.fenceToken, 1_000],
      );

      expect(rows).toEqual([{ status: "accepted" }]);
      // The renewal starts between the lock's release and the call's return, so the 60-second
      // lease it replaced cannot pass either bound.
      const renewed = (await expiresAt(task.table, task.id)).getTime();
      expect(renewed).toBeGreaterThanOrEqual(releasedAt.getTime() + 1_000);
      expect(renewed).toBeLessThanOrEqual(completedAt.getTime() + 1_000);
      // Only the full tier records the heartbeat time, so it also shows the exact renewal.
      const lease = await pool.query<{ ms: string }>(
        `SELECT extract(epoch FROM expires_at - heartbeat_at) * 1000 AS ms
           FROM workhorse.task_runtime WHERE task_id = $1`,
        [task.id],
      );
      expect(lease.rows.map((row) => Number(row.ms))).toEqual(tier === "full" ? [1_000] : []);
    },
  );
});
