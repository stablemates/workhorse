import { setTimeout as sleep } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import type { Queue } from "../../src/index.js";
import { SQL_STATEMENTS } from "../../src/queue/sql-catalogue.generated.js";

export interface BudgetAdmissionRace {
  /** Prefix for the budget and both queue names, so one database can run the race more than once. */
  readonly name: string;
  readonly taskType: string;
  readonly maxActive: number;
  readonly queueRate: { limit: number; intervalMs: number; burst: number };
  readonly leaseMs: number;
}

export interface BudgetAdmissionRaceOutcome {
  readonly lateClaims: number;
  readonly holderClaims: number;
  readonly active: number;
}

/**
 * Commits a budgeted task on one queue while that queue's claim is already past its first read, and
 * holds a second claim of the same budget open on another queue until the first claim has admitted
 * or started waiting. The first claim's queue carries a rate policy so a test session can park it on
 * the queue's token-bucket row, which every claim locks after it has sampled its ready rows.
 */
export async function raceBudgetAdmission(
  pool: Pool,
  queue: Queue,
  race: BudgetAdmissionRace,
): Promise<BudgetAdmissionRaceOutcome> {
  const budget = race.name;
  const lateQueue = `${race.name}-late`;
  const holderQueue = `${race.name}-holder`;
  await queue.syncBudgets(race.name, [{ name: budget, maxActive: race.maxActive }]);
  await queue.syncRateLimitPolicies(race.name, [{ queue: lateQueue, rate: race.queueRate }]);
  // One unbudgeted start creates the late queue's token-bucket row for the blocker to lock.
  await queue.enqueue(race.taskType, { role: "bucket" }, { queue: lateQueue });
  if ((await queue.claim(`${race.name}-bucket`, { queue: lateQueue })) === null) {
    throw new Error("the late queue did not admit its unbudgeted start");
  }
  await queue.enqueue(race.taskType, { role: "holder" }, { queue: holderQueue, budget });

  const blocker = await pool.connect();
  const late = await pool.connect();
  const holder = await pool.connect();
  let lateClaim: Promise<number> | undefined;
  try {
    const latePid = await backendPid(late);
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT 1 FROM workhorse.rate_limit_bucket
        WHERE queue_name = $1 AND bucket_scope = 'queue' FOR UPDATE`,
      [lateQueue],
    );

    let lateSettled = false;
    lateClaim = late
      .query(SQL_STATEMENTS["claim_v1"], [lateQueue, `${race.name}-late`, race.leaseMs])
      .then((result) => result.rowCount ?? 0)
      .finally(() => {
        lateSettled = true;
      });
    await waitFor(`${race.name}: the late claim never reached the bucket row`, async () =>
      waitsOn(pool, latePid, null),
    );

    await queue.enqueue(race.taskType, { role: "late" }, { queue: lateQueue, budget });
    await holder.query("BEGIN");
    const held = await holder.query(SQL_STATEMENTS["claim_v1"], [
      holderQueue,
      `${race.name}-holder`,
      race.leaseMs,
    ]);
    await blocker.query("COMMIT");
    await waitFor(
      `${race.name}: the late claim neither finished nor waited for the budget`,
      async () => lateSettled || waitsOn(pool, latePid, "advisory"),
    );
    await holder.query("COMMIT");
    const lateClaims = await lateClaim;

    const active = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM workhorse.task_runtime
        WHERE state = 'active' AND budget_name = $1`,
      [budget],
    );
    return { lateClaims, holderClaims: held.rowCount ?? 0, active: active.rows[0]!.count };
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await holder.query("ROLLBACK").catch(() => undefined);
    await lateClaim?.catch(() => undefined);
    blocker.release();
    late.release();
    holder.release();
  }
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]!.pid;
}

/** Whether a backend waits on a heavyweight lock, optionally of one kind. */
async function waitsOn(pool: Pool, pid: number, lock: string | null): Promise<boolean> {
  const result = await pool.query<{ waiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_stat_activity
        WHERE pid = $1 AND wait_event_type = 'Lock' AND ($2::text IS NULL OR wait_event = $2)
     ) AS waiting`,
    [pid, lock],
  );
  return result.rows[0]!.waiting;
}

async function waitFor(message: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(message);
}
