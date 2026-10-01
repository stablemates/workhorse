import { randomUUID } from "node:crypto";
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
 * the queue's admission shards, which every claim locks after it has sampled its ready rows.
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
  // One unbudgeted start proves the late queue admits before the blocker parks its claim.
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
      `SELECT pg_advisory_xact_lock(
                hashtextextended('workhorse:admission-shard:' || $1 || ':' || shard, 0))
         FROM generate_series(0, 7) AS shard`,
      [lateQueue],
    );

    let lateSettled = false;
    lateClaim = late
      .query(SQL_STATEMENTS["claim_v1"], [lateQueue, `${race.name}-late`, race.leaseMs])
      .then((result) => result.rowCount ?? 0)
      .finally(() => {
        lateSettled = true;
      });
    await waitFor(`${race.name}: the late claim never reached the admission shards`, async () =>
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

export interface BudgetChargeGate {
  /** Lets every claim parked at the gate charge its budgets and commit. */
  readonly open: () => Promise<void>;
  /** Opens the gate if needed and removes its trigger. */
  readonly remove: () => Promise<void>;
}

/**
 * Parks every claim on one queue after it has read its budgets' room and before it charges them.
 * A test-only trigger on the claim's runtime update waits for a session lock this gate holds, and a
 * claim updates its runtime rows between the room it computes and the bucket charge.
 */
export async function gateBudgetCharge(pool: Pool, queueName: string): Promise<BudgetChargeGate> {
  const trigger = `budget_charge_gate_${randomUUID().replaceAll("-", "_")}`;
  const literal = queueName.replaceAll("'", "''");
  await pool.query(`
    CREATE OR REPLACE FUNCTION public.workhorse_test_budget_charge_gate() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('workhorse-test:budget-charge-gate:' || NEW.queue_name, 0));
      RETURN NEW;
    END
    $$`);
  const holder = await pool.connect();
  let opened = false;
  const open = async () => {
    if (opened) return;
    opened = true;
    try {
      await holder.query(
        "SELECT pg_advisory_unlock(hashtextextended('workhorse-test:budget-charge-gate:' || $1, 0))",
        [queueName],
      );
    } finally {
      holder.release();
    }
  };
  try {
    await holder.query(
      "SELECT pg_advisory_lock(hashtextextended('workhorse-test:budget-charge-gate:' || $1, 0))",
      [queueName],
    );
    await pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON workhorse.task_runtime FOR EACH ROW
        WHEN (NEW.queue_name = '${literal}' AND OLD.state = 'ready' AND NEW.state = 'active')
        EXECUTE FUNCTION public.workhorse_test_budget_charge_gate()`,
    );
  } catch (error) {
    await open();
    throw error;
  }
  return {
    open,
    remove: async () => {
      await open();
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON workhorse.task_runtime`);
    },
  };
}

/** Waits until a statement in this database, named by a fragment of its text, waits on an advisory lock. */
export async function waitForStatementOnAdvisoryLock(
  pool: Pool,
  fragment: string,
  settled: () => boolean,
): Promise<void> {
  await waitFor(`no statement containing ${fragment} waited on an advisory lock`, async () => {
    if (settled()) return true;
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND wait_event = 'advisory'
            AND strpos(query, $1) > 0
       ) AS waiting`,
      [fragment],
    );
    return result.rows[0]!.waiting;
  });
}
