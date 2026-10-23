import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { Queue } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

// Seeds terminal full-tier tasks that every retention gate already releases. The last task has the
// newest finished_at, so cleanup locks it last. Returns the identities in lock order.
const seed = async (count: number): Promise<string[]> => {
  const { rows } = await pool.query<{ id: string }>(
    `WITH seeded AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
       SELECT 'refs-terminal', 'terminal', '{}'::jsonb, 1,
              $2::timestamptz + make_interval(secs => series)
         FROM generate_series(1, $1::integer) series
       RETURNING id, created_at
     ), outcomes AS (
       INSERT INTO workhorse.task_outcome(
         task_id, state, current_attempt, fence_token, run_at, finished_at, history_through_at
       )
       SELECT id, 'succeeded', 1, 1, created_at, created_at, created_at FROM seeded
       RETURNING task_id, finished_at
     )
     SELECT task_id::text AS id FROM outcomes ORDER BY finished_at, task_id`,
    [count, daysAgo(40)],
  );
  return rows.map((row) => row.id);
};

const remaining = async () =>
  (
    await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM workhorse.task WHERE queue_name = 'refs-terminal'",
    )
  ).rows[0]!.count;

const exists = async (id: string) =>
  (await pool.query("SELECT 1 FROM workhorse.task WHERE id = $1", [id])).rowCount === 1;

// One full-tier batch, called directly so that the test controls when the statement starts. A
// retention age of 1,000 days releases no task, so a call with it only prepares the plans.
const pruneFull = async (client: PoolClient | typeof pool, limit: number, retentionDays = 14) =>
  (
    await client.query<{ pruned: number }>(
      `SELECT pruned FROM workhorse.prune_full_terminal_tasks_internal_v1(
                clock_timestamp() - make_interval(days => $2::integer),
                clock_timestamp() - make_interval(days => $2::integer),
                (SELECT history_retained_before FROM workhorse.maintenance_state
                  WHERE routine_name = 'history_retention'),
                $1::integer)`,
      [limit, retentionDays],
    )
  ).rows[0]!.pruned;

// Enqueues a dependent of the prerequisite on the given connection. The enqueue holds FOR KEY SHARE
// on the prerequisite until its transaction ends.
const enqueueDependent = async (client: PoolClient | typeof pool, prerequisiteId: string) =>
  new Queue(client).enqueue("refs-dependent", null, {
    queue: "refs-dependent",
    dependencies: {
      prerequisiteTaskIds: [prerequisiteId],
      onSuccess: "release",
      onFailure: "release",
      onCancellation: "release",
    },
  });

const terminalTasksPhase = async () =>
  (await queue.pruneTerminalStorage({ force: true })).find(
    ({ phase }) => phase === "terminal_tasks",
  );

describe("terminal cleanup and a concurrent reference", () => {
  it("skips a prerequisite that an open enqueue references and deletes the rest of the batch", async () => {
    const ids = await seed(5);
    const prerequisite = ids[2]!;
    const enqueue = await pool.connect();
    try {
      await enqueue.query("BEGIN");
      await enqueueDependent(enqueue, prerequisite);

      const phase = await terminalTasksPhase();

      expect(phase).toMatchObject({ error: null, rowsAffected: 4 });
      expect(await exists(prerequisite)).toBe(true);
      await enqueue.query("COMMIT");
    } finally {
      enqueue.release();
    }
    expect(await remaining()).toBe(1);
  });

  it("keeps a prerequisite whose dependency committed before the batch locked it", async () => {
    const ids = await seed(5);
    const prerequisite = ids[4]!;
    const dependent = await enqueueDependent(pool, prerequisite);

    expect(await terminalTasksPhase()).toMatchObject({ error: null, rowsAffected: 4 });
    expect(await exists(prerequisite)).toBe(true);
    const lineage = await pool.query<{ released: boolean }>(
      `SELECT released_at IS NOT NULL AS released FROM workhorse.task_dependency
        WHERE dependent_task_id = $1 AND prerequisite_task_id = $2`,
      [dependent, prerequisite],
    );
    expect(lineage.rows).toEqual([{ released: true }]);

    // After the dependent finishes, a later pass prunes the released edge, and the pass after that
    // deletes the prerequisite.
    const claimed = await queue.claim("refs-worker", { queue: "refs-dependent" });
    expect(claimed?.id).toBe(dependent);
    expect(await queue.complete(claimed!, "refs-worker", null)).toBe(true);
    await queue.pruneTerminalStorage({ force: true });
    await queue.pruneTerminalStorage({ force: true });

    expect(await exists(prerequisite)).toBe(false);
    expect(await exists(dependent)).toBe(true);
    expect(await remaining()).toBe(0);
  });

  // The defect needs the enqueue to commit after the cleanup statement takes its snapshot and before
  // the statement locks the prerequisite. At read committed, no lock wait occurs between those two
  // points, so a test cannot hold the statement there. This test makes the gap long: the window
  // holds many rows, and the prerequisite is locked last. It commits the enqueue while the batch
  // runs. With the fix, the batch keeps the prerequisite whatever the timing. Without the fix, it
  // fails with SQLSTATE 23001 only when the commit lands inside the gap.
  it("keeps the rest of the batch when the enqueue commits while the batch runs", async () => {
    const ids = await seed(20_000);
    const prerequisite = ids.at(-1)!;
    const enqueue = await pool.connect();
    const cleanup = await pool.connect();
    try {
      const cleanupPid = (await cleanup.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      expect(await pruneFull(cleanup, 25_000, 1_000)).toBe(0);
      await enqueue.query("BEGIN");
      await enqueueDependent(enqueue, prerequisite);

      const batch = pruneFull(cleanup, 25_000);
      batch.catch(() => undefined);
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const { rows } = await pool.query<{ active: boolean }>(
          "SELECT state = 'active' AS active FROM pg_stat_activity WHERE pid = $1",
          [cleanupPid],
        );
        if (rows[0]?.active) break;
        await sleep(1);
      }
      // The statement takes its snapshot within a few milliseconds and locks the prerequisite
      // after it has sorted and locked the other rows.
      await sleep(10);
      await enqueue.query("COMMIT");
      expect(await batch).toBe(ids.length - 1);
    } finally {
      enqueue.release();
      cleanup.release();
    }
    expect(await exists(prerequisite)).toBe(true);
    expect(await remaining()).toBe(1);
  });
});
