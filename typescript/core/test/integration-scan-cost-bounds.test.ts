import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);

type PlanNode = {
  "Node Type"?: string;
  "Subplan Name"?: string;
  "Index Name"?: string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
};

async function plan(sql: string, values: unknown[] = []): Promise<PlanNode> {
  const result = await database.pool.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    values,
  );
  return result.rows[0]!["QUERY PLAN"][0]!.Plan;
}

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

type PlanBuffers = { "Shared Hit Blocks": number };

type TickRow = { phase: string; rows_affected: number; skipped_lock: boolean };

async function tick(): Promise<TickRow[]> {
  const result = await database.pool.query<TickRow>(
    "SELECT phase, rows_affected, skipped_lock FROM workhorse.tick_v1()",
  );
  return result.rows;
}

async function registerWorker(
  workerId: string,
  options: { maintenanceIntervalMs: number; leaseMs?: number; heartbeatAgoMs?: number },
): Promise<void> {
  const leaseMs = options.leaseMs ?? 30_000;
  await database.pool.query(
    `INSERT INTO workhorse.worker_registry(
       worker_id, instance_id, hostname, pid, queue_name, concurrency, lease_ms, heartbeat_ms,
       poll_ms, maintenance_interval_ms, maintenance_routine_poll_ms, registry_interval_ms,
       queue_names, last_heartbeat_at
     ) VALUES (
       $1, gen_random_uuid(), 'scan-cost-host', 1, 'scan-cost', 1, $2, $2 / 3, 1000, $3, 60000,
       1000, ARRAY['scan-cost'], clock_timestamp() - $4 * interval '1 millisecond'
     )`,
    [workerId, leaseMs, options.maintenanceIntervalMs, options.heartbeatAgoMs ?? 0],
  );
}

async function insertActive(prefix: string, count: number, expiresIn: string): Promise<void> {
  await database.pool.query(
    `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts)
     SELECT md5($2 || i)::uuid, 'scan-cost', 'scan.cost', '{}'::jsonb, 3
       FROM generate_series(1, $1) AS series(i)`,
    [count, prefix],
  );
  await database.pool.query(
    `INSERT INTO workhorse.task_runtime(
       task_id, queue_name, state, run_at, current_attempt, fence_token, worker_id,
       acquired_at, heartbeat_at, expires_at, attempt_started_at
     )
     SELECT md5($2 || i)::uuid, 'scan-cost', 'active', clock_timestamp(), 1, 1, 'scan-worker',
            clock_timestamp(), clock_timestamp(), clock_timestamp() + $3::interval,
            clock_timestamp()
       FROM generate_series(1, $1) AS series(i)`,
    [count, prefix, expiresIn],
  );
}

async function expireLeaseAndTick(prefix: string): Promise<{ recovered: number; state: string }> {
  await insertActive(prefix, 1, "-1 second");
  const recovered = (await tick()).find((row) => row.phase === "recover")!.rows_affected;
  const state = await database.pool.query<{ state: string }>(
    "SELECT state FROM workhorse.task_runtime WHERE task_id = md5($1 || 1)::uuid",
    [prefix],
  );
  return { recovered, state: state.rows[0]!.state };
}

async function insertFastRuntime(
  count: number,
  prefix: string,
  columns: { enqueuedAt: string; attempt?: number; runAt?: string },
): Promise<void> {
  await database.pool.query(
    `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts)
     SELECT md5($2 || i)::uuid, 'scan-fast', 'scan.fast', '{}'::jsonb, 3
       FROM generate_series(1, $1) AS series(i)`,
    [count, prefix],
  );
  await database.pool.query(
    `INSERT INTO workhorse.fast_task_runtime(
       task_id, queue_name, task_type, state, run_at, sequence, payload, result_max_bytes,
       redact, max_attempts, attempt, enqueued_at
     )
     SELECT md5($2 || i)::uuid, 'scan-fast', 'scan.fast', 'ready', ${columns.runAt ?? columns.enqueuedAt},
            nextval('workhorse.ready_sequence_seq'), '{}'::jsonb, 1048576, false, 3, $3,
            ${columns.enqueuedAt}
       FROM generate_series(1, $1) AS series(i)`,
    [count, prefix, columns.attempt ?? 1],
  );
}

describe("scan cost bounds", () => {
  beforeAll(async () => database.setup());
  beforeEach(async () => {
    // Reset keeps maintenance_state, so a lease scan an earlier test ran would space this one's.
    await database.reset();
    await database.pool.query(
      `UPDATE workhorse.maintenance_state SET lease_recovery_started_at = NULL
        WHERE routine_name = 'tick'`,
    );
  });
  afterAll(async () => database.teardown());

  describe("expired-lease scan spacing", () => {
    it("recovers expired leases on back-to-back direct ticks when no worker is registered", async () => {
      await tick();

      expect(await expireLeaseAndTick("direct-")).toEqual({ recovered: 1, state: "ready" });
    });

    it("leaves the lease scan to a tick that ran it within half the shortest live interval", async () => {
      await registerWorker("scan-cost-slow", { maintenanceIntervalMs: 600_000 });
      await registerWorker("scan-cost-fast", { maintenanceIntervalMs: 60_000 });
      await tick();

      const spaced = await expireLeaseAndTick("spaced-");
      // Promotion still runs on every tick.
      await database.pool.query(
        `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts)
         VALUES (md5('due')::uuid, 'scan-cost', 'scan.cost', '{}'::jsonb, 3)`,
      );
      await database.pool.query(
        `INSERT INTO workhorse.task_runtime(task_id, queue_name, state, run_at)
         VALUES (md5('due')::uuid, 'scan-cost', 'scheduled', clock_timestamp() - interval '1 second')`,
      );
      const promoted = (await tick()).find((row) => row.phase === "promote");

      expect(spaced).toEqual({ recovered: 0, state: "active" });
      expect(promoted).toEqual({ phase: "promote", rows_affected: 1, skipped_lock: false });
    });

    it("recovers a lease skipped by a spaced tick on a later tick within one interval", async () => {
      await registerWorker("scan-cost-worker", { maintenanceIntervalMs: 1_000 });
      await tick();
      const scannedAt = Date.now();
      const spaced = await expireLeaseAndTick("bounded-");

      // A worker at this interval ticks again within 1,000 ms. Half of it has passed by then.
      await sleep(Math.max(0, scannedAt + 600 - Date.now()));
      const recovered = (await tick()).find((row) => row.phase === "recover")!.rows_affected;
      const state = await database.pool.query<{ state: string }>(
        "SELECT state FROM workhorse.task_runtime WHERE task_id = md5('bounded-1')::uuid",
      );

      expect(spaced).toEqual({ recovered: 0, state: "active" });
      expect(Date.now() - scannedAt).toBeLessThan(1_000);
      expect({ recovered, state: state.rows[0]!.state }).toEqual({ recovered: 1, state: "ready" });
    });

    it("does not space the next scan after a recovery phase that failed", async () => {
      await registerWorker("scan-cost-worker", { maintenanceIntervalMs: 60_000 });
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        // tick_v1 reports a phase failure as data; a raising recovery models a lock timeout.
        await client.query(
          `CREATE OR REPLACE FUNCTION workhorse.recover_expired_v1(
             p_limit integer DEFAULT 100, p_retry_delay_ms integer DEFAULT NULL
           ) RETURNS integer LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'recovery failed'; END; $$`,
        );
        const failed = await client.query<{ phase: string; error: unknown }>(
          "SELECT phase, error FROM workhorse.tick_v1() WHERE phase = 'recover'",
        );
        const state = await client.query<{ lease_recovery_started_at: Date | null }>(
          `SELECT lease_recovery_started_at FROM workhorse.maintenance_state
            WHERE routine_name = 'tick'`,
        );

        expect(failed.rows[0]!.error).not.toBeNull();
        expect(state.rows[0]!.lease_recovery_started_at).toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("does not space the next scan when deadline work fills the recovery limit", async () => {
      await registerWorker("scan-cost-worker", { maintenanceIntervalMs: 60_000 });
      await insertActive("limited-", 1, "-1 second");
      await database.pool.query(
        `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts)
         VALUES (md5('past-deadline')::uuid, 'scan-cost', 'scan.cost', '{}'::jsonb, 3)`,
      );
      await database.pool.query(
        `INSERT INTO workhorse.task_runtime(task_id, queue_name, state, run_at, deadline_at)
         VALUES (md5('past-deadline')::uuid, 'scan-cost', 'scheduled',
                 clock_timestamp() + interval '1 hour', clock_timestamp() - interval '1 second')`,
      );

      // The deadline fills a limit of one, so recovery returns before the expired-lease scan.
      await database.pool.query("SELECT * FROM workhorse.tick_v1(100, 1)");
      const next = await database.pool.query<{ rows_affected: number }>(
        "SELECT rows_affected FROM workhorse.tick_v1(100, 1) WHERE phase = 'recover'",
      );
      const lease = await database.pool.query<{ state: string }>(
        "SELECT state FROM workhorse.task_runtime WHERE task_id = md5('limited-1')::uuid",
      );

      expect(next.rows[0]!.rows_affected).toBe(1);
      expect(lease.rows[0]!.state).toBe("ready");
    });

    it("ignores a registration whose heartbeat is older than its own lease", async () => {
      await registerWorker("scan-cost-gone", {
        maintenanceIntervalMs: 600_000,
        leaseMs: 30_000,
        heartbeatAgoMs: 31_000,
      });
      await tick();

      expect(await expireLeaseAndTick("stale-")).toEqual({ recovered: 1, state: "ready" });
    });

    it("does not read the active leases on a tick that leaves the scan to another", async () => {
      await insertActive("healthy-", 5_000, "1 hour");
      await database.pool.query("ANALYZE workhorse.task_runtime");
      await registerWorker("scan-cost-worker", { maintenanceIntervalMs: 60_000 });
      await tick();

      const client = await database.pool.connect();
      try {
        // The first call on a connection compiles the functions; measure the second.
        await client.query("SELECT * FROM workhorse.tick_v1()");
        const explained = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanBuffers }> }>(
          "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM workhorse.tick_v1()",
        );
        const pages = await client.query<{ pages: number }>(
          "SELECT relpages AS pages FROM pg_class WHERE oid = 'workhorse.task_runtime'::regclass",
        );
        const hits = explained.rows[0]!["QUERY PLAN"][0]!.Plan["Shared Hit Blocks"];

        expect(pages.rows[0]!.pages).toBeGreaterThan(100);
        expect(hits).toBeLessThan(pages.rows[0]!.pages / 2);
      } finally {
        client.release();
      }
    });
  });

  describe("fast-tier statistics window", () => {
    const window = `date_bin('1 minute', now(), timestamp '2000-01-01') - interval '5 minutes'`;
    const windowEnd = `date_bin('1 minute', now(), timestamp '2000-01-01') + interval '1 minute'`;

    async function aggregate(from = window, to = windowEnd) {
      const result = await database.pool.query<{
        enqueued: number;
        task_succeeded: number;
        attempt_retry: number;
        wait_samples: number;
      }>(
        `SELECT COALESCE(sum(stats.enqueued), 0)::integer AS enqueued,
                COALESCE(sum(stats.task_succeeded), 0)::integer AS task_succeeded,
                COALESCE(sum(stats.attempt_retry), 0)::integer AS attempt_retry,
                COALESCE(sum(sketch.samples), 0)::integer AS wait_samples
           FROM workhorse.aggregate_stats_v1(${from}, ${to}) stats
           LEFT JOIN LATERAL (
             SELECT sum(value::bigint) AS samples FROM jsonb_each_text(stats.wait_sketch)
           ) sketch ON true`,
      );
      return result.rows[0]!;
    }

    it("leaves a backlog enqueued before the window out of the materialized fast rows", async () => {
      await insertFastRuntime(500, "backlog-", {
        enqueuedAt: "clock_timestamp() - interval '1 day'",
      });
      await insertFastRuntime(3, "fresh-", { enqueuedAt: "clock_timestamp()" });

      const fastRow = nodes(
        await plan(`SELECT * FROM workhorse.aggregate_stats_v1(${window}, ${windowEnd})`),
      ).find((node) => node["Subplan Name"] === "CTE fast_row");

      expect(fastRow?.["Actual Rows"]).toBe(3);
      expect((await aggregate()).enqueued).toBe(3);
    });

    it("keeps a retried row whose only fact in the window is its recorded first attempt", async () => {
      // The queue records attempts, so the closed first attempt left no errors entry. Its claim
      // is in attempt_history, and the retry set run_at after the attempt closed.
      await insertFastRuntime(1, "retried-", {
        enqueuedAt: "clock_timestamp() - interval '1 day'",
        attempt: 2,
        runAt: "clock_timestamp() + interval '1 hour'",
      });
      await database.pool.query(
        `INSERT INTO workhorse.attempt_history(
           task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at
         ) VALUES (
           md5('retried-1')::uuid, 1, 1, 'scan-worker', 'retry', clock_timestamp() - interval '1 minute',
           clock_timestamp() - interval '1 minute', clock_timestamp() - interval '30 seconds'
         )`,
      );

      expect(await aggregate()).toMatchObject({ enqueued: 0, attempt_retry: 1, wait_samples: 1 });
    });

    it("counts an outcome enqueued before the window ends and finished after it", async () => {
      await database.pool.query(
        `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts)
         VALUES (md5('late-close')::uuid, 'scan-fast', 'scan.fast', '{}'::jsonb, 3),
                (md5('after-window')::uuid, 'scan-fast', 'scan.fast', '{}'::jsonb, 3)`,
      );
      await database.pool.query(
        `INSERT INTO workhorse.fast_task_outcome(
           task_id, queue_name, task_type, state, attempt, fence_token, worker_id, claimed_at,
           enqueued_at, finished_at
         ) VALUES
           (md5('late-close')::uuid, 'scan-fast', 'scan.fast', 'succeeded', 1, 1, 'scan-worker',
            clock_timestamp(), clock_timestamp() - interval '7 minutes', clock_timestamp()),
           (md5('after-window')::uuid, 'scan-fast', 'scan.fast', 'succeeded', 1, 1, 'scan-worker',
            clock_timestamp(), clock_timestamp() - interval '1 minute', clock_timestamp())`,
      );

      const from = `date_bin('1 minute', now(), timestamp '2000-01-01') - interval '10 minutes'`;
      const to = `date_bin('1 minute', now(), timestamp '2000-01-01') - interval '3 minutes'`;
      expect(await aggregate(from, to)).toMatchObject({ enqueued: 1, task_succeeded: 0 });
    });
  });

  it("lists fast-tier dead letters from an index of failed outcomes", async () => {
    await database.pool.query(
      `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts)
       SELECT md5('outcome-' || i)::uuid, 'scan-fast', 'scan.fast', '{}'::jsonb, 3
         FROM generate_series(1, 20000) AS series(i)`,
    );
    await database.pool.query(
      `INSERT INTO workhorse.fast_task_outcome(
         task_id, queue_name, task_type, state, attempt, error, fence_token, worker_id, claimed_at,
         enqueued_at, finished_at
       )
       SELECT md5('outcome-' || i)::uuid, 'scan-fast', 'scan.fast',
              CASE WHEN i % 100 = 0 THEN 'failed' ELSE 'succeeded' END, 1,
              CASE WHEN i % 100 = 0 THEN '{"name":"Error","message":"boom"}'::jsonb END,
              1, 'scan-worker', clock_timestamp(), clock_timestamp() - i * interval '1 second',
              clock_timestamp() - i * interval '1 second'
         FROM generate_series(1, 20000) AS series(i)`,
    );
    await database.pool.query("ANALYZE workhorse.fast_task_outcome");

    const listed = await database.pool.query<{ task_id: string }>(
      "SELECT task_id::text FROM workhorse.list_dead_letters_v1('{}'::jsonb, 10)",
    );
    const scans = nodes(
      await plan(
        `SELECT outcome.task_id FROM workhorse.fast_task_outcome outcome
          WHERE outcome.state = 'failed'
          ORDER BY outcome.finished_at DESC, outcome.task_id DESC LIMIT 11`,
      ),
    ).filter((node) => node["Relation Name"] === "fast_task_outcome");

    expect(listed.rows).toHaveLength(10);
    expect(scans.map((node) => node["Index Name"])).toEqual([
      "fast_task_outcome_failed_finished_idx",
    ]);
  });
});
