import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { ClaimedTask } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// heartbeat_v2 renews one lease as heartbeat_many_v2 does. It does not wait for a row lock that
// another transaction holds, and it reports the lease as busy: no renewal and no ownership verdict.
// heartbeat_v1, which Queue.heartbeat() and Queue.heartbeatStatus() call, still waits (SM-1461,
// ADR 0105).

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

const WORKER = "one-lease-busy-worker";
const ERROR = JSON.stringify({ name: "Error", message: "retry at once", stack: null });
const HEARTBEAT_V2 =
  "SELECT workhorse.heartbeat_v2($1::uuid, $2::text, $3::bigint, $4::integer) AS status";

async function claimed(queueName: string): Promise<ClaimedTask> {
  await queue.enqueue("one-lease-busy", {}, { queue: queueName });
  const task = await queue.claim(WORKER, { queue: queueName, leaseMs: 30_000 });
  expect(task).not.toBeNull();
  return task!;
}

async function heartbeatV2(
  taskId: string | null,
  fenceToken: string | null,
  leaseMs: number | null = 30_000,
  workerId: string | null = WORKER,
): Promise<string> {
  const result = await pool.query<{ status: string }>(HEARTBEAT_V2, [
    taskId,
    workerId,
    fenceToken,
    leaseMs,
  ]);
  return result.rows[0]!.status;
}

async function expiresAt(taskId: string): Promise<number> {
  const result = await pool.query<{ expires_at: Date }>(
    `SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1
     UNION ALL
     SELECT expires_at FROM workhorse.fast_task_runtime WHERE task_id = $1`,
    [taskId],
  );
  return result.rows[0]!.expires_at.getTime();
}

/** Open a transaction on its own connection, run `statements` in it, and return the client. */
async function openTransaction(
  statements: readonly { sql: string; parameters?: unknown[] }[],
): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement.sql, statement.parameters);
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function finish(client: PoolClient, command: "COMMIT" | "ROLLBACK"): Promise<void> {
  try {
    await client.query(command);
  } finally {
    client.release();
  }
}

function lockRow(table: "task_runtime" | "fast_task_runtime", taskId: string) {
  return {
    sql: `SELECT FROM workhorse.${table} WHERE task_id = $1 FOR UPDATE`,
    parameters: [taskId],
  };
}

function failNow(task: ClaimedTask) {
  return {
    sql: "SELECT workhorse.fail_v1($1::uuid, $2::text, $3::bigint, $4::jsonb, 0)",
    parameters: [task.id, WORKER, task.fenceToken.toString(), ERROR],
  };
}

describe("one-lease busy heartbeat", () => {
  it("answers busy at once while a settlement holds the row, and changes nothing", async () => {
    const task = await claimed("one-lease-busy-settlement");
    const before = await expiresAt(task.id);
    const settlement = await openTransaction([failNow(task)]);
    try {
      const started = performance.now();
      expect(await heartbeatV2(task.id, task.fenceToken.toString())).toBe("busy");
      expect(await queue.tryHeartbeat(task, WORKER)).toBe("busy");
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      await finish(settlement, "ROLLBACK");
    }
    expect(await expiresAt(task.id)).toBe(before);
    expect(await queue.tryHeartbeat(task, WORKER, 60_000)).toBe("accepted");
    expect((await expiresAt(task.id)) - Date.now()).toBeGreaterThan(45_000);
  });

  it("reports stale after a settlement that held the row commits", async () => {
    const task = await claimed("one-lease-busy-commit");
    const settlement = await openTransaction([failNow(task)]);
    try {
      expect(await queue.tryHeartbeat(task, WORKER)).toBe("busy");
    } finally {
      await finish(settlement, "COMMIT");
    }
    expect(await queue.tryHeartbeat(task, WORKER)).toBe("stale");
  });

  it("reports busy and accepted on the fast tier", async () => {
    const fastQueue = "one-lease-busy-fast";
    await expect(
      admin.setQueueTier(fastQueue, "fast", adminAudit("move to the fast tier")),
    ).resolves.toBe("fast");
    const task = await claimed(fastQueue);
    const before = await expiresAt(task.id);
    const holder = await openTransaction([lockRow("fast_task_runtime", task.id)]);
    try {
      expect(await queue.tryHeartbeat(task, WORKER)).toBe("busy");
    } finally {
      await finish(holder, "COMMIT");
    }
    expect(await expiresAt(task.id)).toBe(before);
    expect(await queue.tryHeartbeat(task, WORKER)).toBe("accepted");
  });

  it("is not busy for a key-share lock, as a foreign-key check takes", async () => {
    const task = await claimed("one-lease-busy-key-share");
    const keyShare = await openTransaction([
      {
        sql: "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE",
        parameters: [task.id],
      },
    ]);
    try {
      expect(await queue.tryHeartbeat(task, WORKER)).toBe("accepted");
    } finally {
      await finish(keyShare, "COMMIT");
    }
  });

  it("reports a replaced generation and an unknown task as stale, also while the row is locked", async () => {
    const queueName = "one-lease-busy-replaced";
    const task = await claimed(queueName);
    await pool.query(failNow(task).sql, failNow(task).parameters);
    const next = await queue.claim(WORKER, { queue: queueName, leaseMs: 30_000 });
    expect(next?.id).toBe(task.id);
    const holder = await openTransaction([lockRow("task_runtime", task.id)]);
    try {
      expect(await queue.tryHeartbeat(task, WORKER)).toBe("stale");
    } finally {
      await finish(holder, "COMMIT");
    }
    expect(await heartbeatV2("00000000-0000-4000-8000-000000000001", "1")).toBe("stale");
    expect(await heartbeatV2(null, "1")).toBe("stale");
    expect(await heartbeatV2(task.id, null)).toBe("stale");
  });

  it("reports cancel_requested without a renewal", async () => {
    const task = await claimed("one-lease-busy-cancel");
    const before = await expiresAt(task.id);
    await expect(queue.cancel(task.id)).resolves.toBeTruthy();
    expect(await queue.tryHeartbeat(task, WORKER)).toBe("cancel_requested");
    expect(await expiresAt(task.id)).toBe(before);
  });

  it("checks its input as heartbeat_v1 does, and uses a lease of 30 s by default", async () => {
    const task = await claimed("one-lease-busy-input");
    await expect(heartbeatV2(task.id, task.fenceToken.toString(), 30_000, "")).rejects.toThrow(
      "worker_id must not be empty",
    );
    await expect(heartbeatV2(task.id, task.fenceToken.toString(), 99)).rejects.toThrow(
      "lease_ms must be between 100 and 86400000",
    );
    await expect(heartbeatV2(task.id, task.fenceToken.toString(), null)).rejects.toThrow(
      "lease_ms must be between 100 and 86400000",
    );
    const result = await pool.query<{ status: string }>(
      "SELECT workhorse.heartbeat_v2($1::uuid, $2::text, $3::bigint) AS status",
      [task.id, WORKER, task.fenceToken.toString()],
    );
    expect(result.rows[0]!.status).toBe("accepted");
    const remaining = (await expiresAt(task.id)) - Date.now();
    expect(remaining).toBeGreaterThan(25_000);
    expect(remaining).toBeLessThanOrEqual(30_000);
  });

  it("keeps heartbeatStatus on heartbeat_v1, which waits for the row lock", async () => {
    const task = await claimed("one-lease-busy-v1-waits");
    const holder = await openTransaction([lockRow("task_runtime", task.id)]);
    let answered = false;
    const call = queue.heartbeatStatus(task, WORKER).then((status) => {
      answered = true;
      return status;
    });
    try {
      await sleep(300);
      expect(answered).toBe(false);
    } finally {
      await finish(holder, "COMMIT");
    }
    await expect(call).resolves.toBe("accepted");
  });
});
