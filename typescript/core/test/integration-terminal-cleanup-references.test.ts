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

// Waits in the enqueue backend until the cleanup backend holds a transaction identifier. A backend
// gets one at its first write or row lock. Then the same message commits the enqueue, so no client
// round trip comes between the check and the commit. The wait also stops if the cleanup backend
// went idle after `startedAt`, because then the statement ended. It also stops after 10 s, so a
// slow start makes the try inconclusive, not a failure. Each read of pg_stat_activity clears the
// copy that the transaction keeps. Returns the identifier, or an empty string if the wait stopped
// for another reason.
const commitWhenCleanupLocks = async (
  enqueue: PoolClient,
  { cleanupPid, startedAt }: { cleanupPid: number; startedAt: string },
) => {
  const pid = String(Math.trunc(cleanupPid));
  await enqueue.query(
    `DO $$
     DECLARE
       v_xid text;
       v_ended boolean;
       v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
     BEGIN
       LOOP
         SELECT transactionid::text INTO v_xid FROM pg_locks
          WHERE pid = ${pid} AND locktype = 'transactionid' AND mode = 'ExclusiveLock' AND granted;
         EXIT WHEN v_xid IS NOT NULL;
         PERFORM pg_stat_clear_snapshot();
         SELECT state = 'idle' AND state_change > ${enqueue.escapeLiteral(startedAt)}::timestamptz
           INTO v_ended FROM pg_stat_activity WHERE pid = ${pid};
         EXIT WHEN v_ended OR clock_timestamp() > v_deadline;
       END LOOP;
       PERFORM set_config('workhorse_test.cleanup_xid', COALESCE(v_xid, ''), false);
     END $$;
     COMMIT`,
  );
  return (
    await enqueue.query<{ xid: string }>(
      "SELECT current_setting('workhorse_test.cleanup_xid') AS xid",
    )
  ).rows[0]!.xid;
};

// The transaction that last locked or updated the task row.
const rowLocker = async (id: string) =>
  (await pool.query<{ xmax: string }>("SELECT xmax::text FROM workhorse.task WHERE id = $1", [id]))
    .rows[0]?.xmax;

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
  // points: SKIP LOCKED never waits, and the statement takes its relation locks before its
  // snapshot. Thus a test cannot hold the statement there, and no test can make the commit land in
  // the gap every time. This test makes the gap long: the window holds many rows, and the
  // prerequisite is locked last. With the fix, the batch keeps the prerequisite whatever the
  // timing. Without the fix, it fails with SQLSTATE 23001 only when the commit lands inside the gap.
  //
  // The statement sorts the window with its snapshot, then locks the rows in order. Its first row
  // lock assigns the transaction identifier of the cleanup. Thus that identifier in pg_locks shows
  // that the snapshot exists and the locks have started. The enqueue backend waits for the
  // identifier before it commits. If the wait ends without the identifier, the try is
  // inconclusive. Then the xmax of the prerequisite shows if the commit was in time. If the
  // commit came first, the cleanup locks the prerequisite, and the xmax is the cleanup identifier.
  // Otherwise SKIP LOCKED skips the prerequisite, and the xmax stays the identifier of the enqueue.
  // Each try asserts the product result. If the commit misses the gap, the test tries again. It
  // starts no new try after 20 s, so the last try has time to end. If no try hits the gap, the test
  // passes with a warning note.
  it("keeps the rest of the batch when the enqueue commits while the batch runs", async ({
    annotate,
  }) => {
    const tries = 3;
    const retryDeadline = Date.now() + 20_000;
    const enqueue = await pool.connect();
    const cleanup = await pool.connect();
    try {
      const cleanupPid = (await cleanup.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      expect(await pruneFull(cleanup, 25_000, 1_000)).toBe(0);

      for (let attempt = 1; attempt <= tries; attempt += 1) {
        const ids = await seed(20_000);
        const prerequisite = ids.at(-1)!;
        await enqueue.query("BEGIN");
        // The commit does not wait for the WAL flush, so it becomes visible sooner.
        await enqueue.query("SET LOCAL synchronous_commit = off");
        await enqueueDependent(enqueue, prerequisite);
        const enqueueXid = (
          await enqueue.query<{ xid: string }>("SELECT pg_current_xact_id()::xid::text AS xid")
        ).rows[0]!.xid;
        const startedAt = (
          await enqueue.query<{ at: string }>("SELECT clock_timestamp()::text AS at")
        ).rows[0]!.at;

        const batch = pruneFull(cleanup, 25_000);
        batch.catch(() => undefined);
        const cleanupXid = await commitWhenCleanupLocks(enqueue, { cleanupPid, startedAt });
        expect(await batch).toBe(ids.length - 1);
        expect(await exists(prerequisite)).toBe(true);
        // Each try keeps its own prerequisite, and an earlier prerequisite stays because its
        // dependent never runs.
        expect(await remaining()).toBe(attempt);

        const locker = await rowLocker(prerequisite);
        if (cleanupXid !== "" && locker === cleanupXid) return;
        // If the wait saw the cleanup identifier, the cleanup skipped the prerequisite. If the wait
        // saw no identifier, the order is not known, and the try only counts as a miss.
        expect(
          cleanupXid === "" || locker === enqueueXid,
          `xmax ${String(locker)} is neither the cleanup ${cleanupXid} nor the enqueue ${enqueueXid}`,
        ).toBe(true);
        await annotate(`Try ${String(attempt)} did not commit inside the gap.`);
        if (Date.now() > retryDeadline) break;
      }
      await annotate(
        "No try committed inside the gap, so this run did not prove the race.",
        "warning",
      );
    } finally {
      // A failed try can leave a transaction open, so the pool closes both connections.
      enqueue.release(true);
      cleanup.release(true);
    }
    // Each try seeds and prunes 20,000 tasks, so the case gets more time than the 20 s default.
  }, 60_000);
});
