import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

const { defaultRetentionPolicy, pool, queue } = createIntegrationTestContext(import.meta.url);

// Seeds terminal tasks that every retention gate already releases: identities and outcomes 40 days
// old, with no history rows and a history boundary behind the retained-through watermark.
const seed = async (tier: "full" | "fast", count: number, finishedAt: Date) => {
  if (tier === "full") {
    await pool.query(
      `WITH seeded AS (
         INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
         SELECT 'pace-full', 'full', '{}'::jsonb, 1,
                $2::timestamptz - make_interval(secs => series)
           FROM generate_series(1, $1::integer) series
         RETURNING id, created_at
       )
       INSERT INTO workhorse.task_outcome(
         task_id, state, current_attempt, fence_token, run_at, finished_at, history_through_at
       )
       SELECT id, 'succeeded', 1, 1, created_at, created_at, created_at FROM seeded`,
      [count, finishedAt],
    );
    return;
  }
  await pool.query(
    `WITH seeded AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
       SELECT 'pace-fast', 'fast', '{}'::jsonb, 1, $2::timestamptz - make_interval(secs => series)
         FROM generate_series(1, $1::integer) series
       RETURNING id, created_at
     )
     INSERT INTO workhorse.fast_task_outcome(
       task_id, queue_name, task_type, state, attempt, fence_token, worker_id, claimed_at,
       enqueued_at, finished_at
     )
     SELECT id, 'pace-fast', 'fast', 'succeeded', 1, 1, 'pace-worker', created_at, created_at,
            created_at
       FROM seeded`,
    [count, finishedAt],
  );
};

const remaining = async () => {
  const { rows } = await pool.query<{ full: number; fast: number }>(
    `SELECT (SELECT count(*)::integer FROM workhorse.task_outcome) AS full,
            (SELECT count(*)::integer FROM workhorse.fast_task_outcome) AS fast`,
  );
  return rows[0]!;
};

const pruneBatch = async (limit: number) =>
  (
    await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_tasks_v1(
                clock_timestamp() - interval '14 days', clock_timestamp() - interval '14 days',
                history_retained_before, $1::integer) AS pruned
         FROM workhorse.maintenance_state WHERE routine_name = 'history_retention'`,
      [limit],
    )
  ).rows[0]!.pruned;

const backlogSince = async () =>
  (
    await pool.query<{ since: Date | null }>(
      `SELECT (workhorse.queue_health_v1()->>'terminal_cleanup_backlog_since')::timestamptz AS since`,
    )
  ).rows[0]!.since;

const terminalTasksPruned = (phases: Awaited<ReturnType<typeof queue.pruneTerminalStorage>>) =>
  phases.find(({ phase }) => phase === "terminal_tasks")?.rowsAffected;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

describe("terminal cleanup pace", () => {
  it("splits each batch between the tiers and passes an unused share to the other tier", async () => {
    await seed("full", 10, daysAgo(40));
    await seed("fast", 10, daysAgo(40));

    expect(await pruneBatch(4)).toBe(4);
    expect(await remaining()).toEqual({ full: 8, fast: 8 });
    expect(await pruneBatch(5)).toBe(5);
    expect(await remaining()).toEqual({ full: 6, fast: 5 });

    // A limit of one alternates the tier that goes first, so neither tier waits on the other.
    expect(await pruneBatch(1)).toBe(1);
    expect(await pruneBatch(1)).toBe(1);
    expect(await remaining()).toEqual({ full: 5, fast: 4 });

    await pool.query("DELETE FROM workhorse.task WHERE queue_name = 'pace-full'");
    expect(await pruneBatch(3)).toBe(3);
    expect(await remaining()).toEqual({ full: 0, fast: 1 });

    await pool.query("DELETE FROM workhorse.task WHERE queue_name = 'pace-fast'");
    await seed("full", 6, daysAgo(40));
    expect(await pruneBatch(4)).toBe(4);
    expect(await remaining()).toEqual({ full: 2, fast: 0 });
  });

  it("serves the fast tier while an older full-tier backlog fills every batch", async () => {
    await seed("full", 50, daysAgo(60));
    await seed("fast", 5, daysAgo(20));

    for (let call = 0; call < 5; call += 1) expect(await pruneBatch(2)).toBe(2);
    expect(await remaining()).toEqual({ full: 45, fast: 0 });
  });

  it("schedules a prompt follow-up pass while a pass ends with a full batch", async () => {
    await queue.syncRetentionPolicy({ ...defaultRetentionPolicy, terminalTaskPruneLimit: 2 });
    await seed("full", 40, daysAgo(40));
    // Each delete statement sleeps, so the one-second budget ends the pass with rows left.
    await pool.query(`
      CREATE FUNCTION public.slow_terminal_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.1); RETURN NULL; END;
      $$`);
    await pool.query(`
      CREATE TRIGGER slow_terminal_delete BEFORE DELETE ON workhorse.task
        FOR EACH STATEMENT EXECUTE FUNCTION public.slow_terminal_delete()`);

    const now = new Date();
    try {
      const pruned = terminalTasksPruned(await queue.pruneTerminalStorage({ now }));
      expect(pruned).toBeGreaterThanOrEqual(2);
      expect(pruned).toBeLessThan(40);
    } finally {
      await pool.query("DROP TRIGGER slow_terminal_delete ON workhorse.task");
      await pool.query("DROP FUNCTION public.slow_terminal_delete()");
    }
    expect(await backlogSince()).toEqual(now);

    // The follow-up waits five seconds, not the five-minute terminal_cleanup_interval_ms.
    expect(await queue.pruneTerminalStorage({ now: new Date(now.getTime() + 4_000) })).toEqual([]);
    expect(
      terminalTasksPruned(
        await queue.pruneTerminalStorage({ now: new Date(now.getTime() + 5_000) }),
      ),
    ).toBeGreaterThan(0);
    expect((await remaining()).full).toBe(0);
    expect(await backlogSince()).toBeNull();

    // A pass that drains its backlog returns to the configured interval.
    expect(await queue.pruneTerminalStorage({ now: new Date(now.getTime() + 11_000) })).toEqual([]);
  });

  it("keeps pace with a sustained completion rate of 15 tasks per second", async () => {
    // One worker offers the routine every 60 seconds. Each simulated minute completes 900 tasks,
    // split between the tiers. A pass at the old pace removed 1,000 tasks every five minutes, so
    // this backlog would grow by about 3,500 tasks every five minutes.
    const start = Date.now();
    let maximumBacklog = 0;
    for (let minute = 0; minute < 15; minute += 1) {
      const now = new Date(start + minute * 60_000);
      await seed("full", 450, new Date(now.getTime() - 40 * 86_400_000));
      await seed("fast", 450, new Date(now.getTime() - 40 * 86_400_000));
      await queue.pruneTerminalStorage({ now });
      const { full, fast } = await remaining();
      maximumBacklog = Math.max(maximumBacklog, full + fast);
    }
    // Every pass that leaves rows behind removes at least one full batch a minute later, so the
    // backlog never exceeds what five minutes of completions add before the first follow-up.
    expect(maximumBacklog).toBeLessThanOrEqual(4_500);
  });
});
