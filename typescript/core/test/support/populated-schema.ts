import type { Pool } from "pg";

/**
 * A populated installation for the released-artifact migration rehearsal.
 *
 * A schema dump speaks for shape. These helpers give a released artifact the rows a running
 * installation already holds, so the same rehearsal can also show that migrating it preserves
 * them. The seed reaches every shape through the released schema's own SQL functions wherever one
 * exists, so it stays valid as the schema grows.
 */

const fixtureWorker = "fixture-worker";
const runQueue = "fixture-run";
const pendingQueue = "fixture-pending";
const purgedQueue = "fixture-purged";

/**
 * The day whose history partition the fixture creates.
 *
 * A partition is a schema object, so a dump comparison sees it. The date is fixed rather than
 * derived from the clock, so the clean installation the suite compares against can create the same
 * day once and both dumps still agree.
 */
const historyFixtureDay = "2020-01-02";

/** The occurrence second the fixture schedule fires, fixed so the seeded row never moves. */
const scheduleOccurrenceAt = "2021-03-04T05:00:00Z";

/** Creates the fixture's history-day partition of `job_event` and `attempt_history`. */
export async function createHistoryFixtureDay(pool: Pool): Promise<void> {
  await pool.query("SELECT workhorse.create_history_day_v1($1::date)", [historyFixtureDay]);
}

/** One table's rows, projected to the columns it had when the snapshot's shape was recorded. */
export interface SeededTableRows {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * Populates a freshly installed released artifact.
 *
 * The seed covers the shapes a migration could damage: a job in every state the schema can hold, a
 * job set whose history spans two partitions, a schedule with its fired occurrence, a checkpoint
 * and a wait, audit records, and a concurrency and a rate limit policy.
 */
export async function seedReleasedSchema(pool: Pool): Promise<void> {
  await createHistoryFixtureDay(pool);

  await pool.query(`SELECT workhorse.sync_concurrency_policies_v1($1, $2::jsonb, false)`, [
    "fixture",
    JSON.stringify([{ queue: runQueue, maxActive: 100, maxActivePerKey: 10 }]),
  ]);
  await pool.query(`SELECT workhorse.sync_rate_limit_policies_v1($1, $2::jsonb, false)`, [
    "fixture",
    JSON.stringify([
      {
        queue: runQueue,
        rate: { limit: 1000, intervalMs: 60000, burst: 1000 },
        perKey: { limit: 1000, intervalMs: 60000, burst: 1000 },
      },
    ]),
  ]);

  await pool.query(
    `SELECT workhorse.register_worker_v1(
       $1, $2::uuid, $3, $4, $5::text[], $6::text[], 4, 30000, 5000, 100, 1000, 250, 1000, 0, false,
       NULL::integer, NULL::text, NULL::text
     )`,
    [
      fixtureWorker,
      "00000000-0000-4000-8000-00000000f1c7",
      "fixture-host",
      4321,
      [runQueue, pendingQueue],
      ["fixture"],
    ],
  );

  // Claims are FIFO within a priority, so enqueue order below is claim order.
  const runJobs = await enqueueBatch(pool, [
    { queue: runQueue, type: "fixture.succeed", payload: { step: "succeed" }, maxAttempts: 5 },
    { queue: runQueue, type: "fixture.fail", payload: { step: "fail" }, maxAttempts: 1 },
    { queue: runQueue, type: "fixture.wait", payload: { step: "wait" }, maxAttempts: 5 },
    {
      queue: runQueue,
      type: "fixture.work",
      payload: { step: "work" },
      maxAttempts: 5,
      concurrencyKey: "fixture-key",
    },
    { queue: runQueue, type: "fixture.set", payload: { step: "set" }, maxAttempts: 5 },
    { queue: runQueue, type: "fixture.cancel", payload: { step: "cancel" }, maxAttempts: 5 },
  ]);

  const succeeded = await claim(pool, runQueue);
  await pool.query("SELECT workhorse.complete_v1($1::uuid, $2, $3::bigint, $4::jsonb)", [
    succeeded.job_id,
    fixtureWorker,
    succeeded.fence_token,
    JSON.stringify({ outcome: "ok" }),
  ]);

  const failed = await claim(pool, runQueue);
  await pool.query("SELECT workhorse.fail_v1($1::uuid, $2, $3::bigint, $4::jsonb)", [
    failed.job_id,
    fixtureWorker,
    failed.fence_token,
    JSON.stringify({ message: "fixture failure" }),
  ]);

  const waiting = await claim(pool, runQueue);
  await pool.query(
    `SELECT workhorse.schedule_wait_v1($1::uuid, $2, $3::bigint, $4, $5::bigint, NULL)`,
    [waiting.job_id, fixtureWorker, waiting.fence_token, "fixture-wait", 3_600_000],
  );

  const working = await claim(pool, runQueue);
  await pool.query(`SELECT workhorse.save_checkpoint_v1($1::uuid, $2, $3::bigint, $4, $5::jsonb)`, [
    working.job_id,
    fixtureWorker,
    working.fence_token,
    "fixture-checkpoint",
    JSON.stringify({ cursor: 42 }),
  ]);
  await pool.query(`SELECT workhorse.update_progress_v1($1::uuid, $2, $3::bigint, $4::jsonb)`, [
    working.job_id,
    fixtureWorker,
    working.fence_token,
    JSON.stringify({ percent: 50 }),
  ]);

  // A job set leaves its parent blocked on the children it created, so one call reaches the set
  // edges, the dependency edges, and the only state no other seeded job holds.
  const parent = await claim(pool, runQueue);
  await pool.query(
    `SELECT workhorse.create_children_v1($1::uuid, $2, $3::bigint, $4::jsonb, 'settled')`,
    [
      parent.job_id,
      fixtureWorker,
      parent.fence_token,
      JSON.stringify([
        {
          name: "first",
          request: { queue: pendingQueue, type: "fixture.child", payload: { index: 1 } },
        },
        {
          name: "second",
          request: { queue: pendingQueue, type: "fixture.child", payload: { index: 2 } },
        },
      ]),
    ],
  );

  const canceled = runJobs.at(-1);
  await pool.query("SELECT workhorse.cancel_v1($1::uuid, $2, $3)", [
    canceled,
    "fixture-operator",
    "fixture cancellation",
  ]);

  await enqueueBatch(pool, [
    { queue: pendingQueue, type: "fixture.ready", payload: { state: "ready" }, maxAttempts: 5 },
    {
      queue: pendingQueue,
      type: "fixture.scheduled",
      payload: { state: "scheduled" },
      maxAttempts: 5,
      runAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    {
      queue: pendingQueue,
      type: "fixture.idempotent",
      payload: { state: "ready" },
      maxAttempts: 5,
      idempotency: { key: "fixture-key", scope: "fixture", ttlMs: 86_400_000 },
    },
  ]);

  await pool.query("SELECT workhorse.sync_schedule_definitions_v1($1, $2::jsonb, false)", [
    "fixture",
    JSON.stringify([
      {
        name: "hourly",
        schedule: "0 * * * *",
        queue: pendingQueue,
        type: "fixture.cron",
        payload: { source: "cron" },
        maxAttempts: 5,
      },
    ]),
  ]);
  await pool.query("SELECT workhorse.fire_schedule_v1($1, $2, 1::bigint, $3::timestamptz)", [
    "fixture",
    "hourly",
    scheduleOccurrenceAt,
  ]);

  // A purge request is the destructive-operation audit record, and a paused queue is the operator
  // control beside it.
  await enqueueBatch(pool, [
    { queue: purgedQueue, type: "fixture.purged", payload: { state: "purged" }, maxAttempts: 5 },
  ]);
  await pool.query("SELECT workhorse.purge_queue_v1($1, $2, $3, $4)", [
    purgedQueue,
    "fixture-operator",
    "fixture purge",
    "fixture-purge-request",
  ]);
  await pool.query("SELECT workhorse.set_queue_paused_v1($1, true, $2, $3, $4)", [
    pendingQueue,
    "fixture-operator",
    "fixture pause",
    "fixture-pause-request",
  ]);

  // No function chooses `occurred_at`, so the rows that belong to the fixture's history day are the
  // one place the seed inserts directly. Every other history row carries the clock's day and stays
  // in the default partition, which is what makes the seed span more than one partition.
  await pool.query(
    `INSERT INTO workhorse.job_event(job_id, attempt, event_type, details, occurred_at)
     VALUES ($1::uuid, 1, 'fixture_archived', $2::jsonb, $3::timestamptz)`,
    [succeeded.job_id, JSON.stringify({ note: "history day" }), `${historyFixtureDay}T04:05:06Z`],
  );
  await pool.query(
    `INSERT INTO workhorse.attempt_history(
       job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at,
       occurred_at
     ) VALUES (
       $1::uuid, 1, 1, $2, 'succeeded', $3::timestamptz, $3::timestamptz, $3::timestamptz,
       $3::timestamptz
     )`,
    [succeeded.job_id, fixtureWorker, `${historyFixtureDay}T04:05:06Z`],
  );
}

/**
 * Reads every seeded row back as JSON, one entry per table.
 *
 * Pass the snapshot taken before a migration as `shape` to read the same tables and the same
 * columns again. A migration that adds a column then leaves the comparison alone, while one that
 * rewrites a value it already released fails it.
 */
export async function readSeededRows(
  pool: Pool,
  shape?: readonly SeededTableRows[],
): Promise<SeededTableRows[]> {
  const tables = shape ?? (await seededShape(pool));
  const snapshots: SeededTableRows[] = [];
  for (const { table, columns } of tables) {
    const identifier = `"workhorse"."${table.replaceAll('"', '""')}"`;
    const result = await pool.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(source) AS row FROM ${identifier} AS source`,
    );
    const rows = result.rows.map(({ row }) =>
      Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
    );
    // Ordering on the projection rather than on the stored row keeps the two snapshots aligned even
    // when a migration has added a column that would otherwise reorder them.
    rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    snapshots.push({ table, columns, rows });
  }
  return snapshots;
}

/**
 * The tables and columns a snapshot covers: every `workhorse` relation that holds rows, minus the
 * version bookkeeping a migration is supposed to change and the suite already asserts by itself.
 */
async function seededShape(pool: Pool): Promise<{ table: string; columns: string[] }[]> {
  const result = await pool.query<{ table: string; columns: string[] }>(
    `SELECT relation.relname::text AS table,
            array_agg(attribute.attname::text ORDER BY attribute.attnum) AS columns
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
      WHERE namespace.nspname = 'workhorse'
        AND relation.relkind IN ('r', 'p')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND relation.relname <> ALL($1::text[])
        AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = relation.oid)
      GROUP BY relation.relname
      ORDER BY relation.relname`,
    [["schema_version", "schema_migration", "protocol_version"]],
  );
  return result.rows;
}

async function enqueueBatch(pool: Pool, requests: readonly object[]): Promise<string[]> {
  const result = await pool.query<{ job_id: string }>(
    "SELECT job_id FROM workhorse.enqueue_batch_v1($1::jsonb) ORDER BY ordinal",
    [JSON.stringify(requests)],
  );
  return result.rows.map((row) => row.job_id);
}

async function claim(
  pool: Pool,
  queueName: string,
): Promise<{ job_id: string; fence_token: string }> {
  const result = await pool.query<{ job_id: string; fence_token: string }>(
    "SELECT job_id, fence_token FROM workhorse.claim_v1($1, $2, 600000)",
    [queueName, fixtureWorker],
  );
  const claimed = result.rows[0];
  if (claimed === undefined) throw new Error(`the fixture found no ready job on ${queueName}`);
  return claimed;
}
