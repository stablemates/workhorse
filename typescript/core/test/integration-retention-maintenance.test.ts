import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { installSchema, Queue, type RetentionPolicyDefinition, Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const {
  defaultRetentionPolicy,
  pool,
  queue,
  waitForDatabaseCondition,
  admin,
  adminAudit,
  createFailedTask,
} = createIntegrationTestContext(import.meta.url);

const stored = async () =>
  (
    await pool.query<{
      task_type: string;
      enqueued: number;
      task_succeeded: number;
      attempt_succeeded: number;
      attempt_retry: number;
      last_error: string | null;
    }>(`SELECT task_type, sum(enqueued)::integer AS enqueued,
               sum(task_succeeded)::integer AS task_succeeded,
               sum(attempt_succeeded)::integer AS attempt_succeeded,
               sum(attempt_retry)::integer AS attempt_retry,
               max(last_error) AS last_error
          FROM workhorse.task_stat_bucket GROUP BY task_type ORDER BY task_type`)
  ).rows;

const scheduleRunLagReported = async () =>
  (await queue.health()).status.reasons.some(
    (reason) => reason.code === "retention-lag" && reason.category === "scheduleOccurrences",
  );

const addScheduleRun = async (hoursPastWindow: number, firedHoursAgo: number) => {
  await pool.query(
    `INSERT INTO workhorse.schedule_definition(
       namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
     ) VALUES ('integration', 'health-cadence', '0 * * * *', 'default', 'health-cadence',
               '{}'::jsonb, 3)
     ON CONFLICT DO NOTHING`,
  );
  // A retention window of 14 days is 336 hours. A '14 days' interval steps calendar days in the
  // session TimeZone, so it is one hour longer or shorter across a daylight-saving change.
  await pool.query(
    `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at, fired_at)
     VALUES ('integration', 'health-cadence',
             clock_timestamp() - interval '336 hours' - make_interval(secs => $1::float8 * 3600),
             clock_timestamp() - make_interval(secs => $2::float8 * 3600))`,
    [hoursPastWindow, firedHoursAgo],
  );
};

// Records a pass that started at its scheduled local time, so the next one falls due a day later.
const recordPass = async (
  startedHoursAgo: number,
  completedLocalDate: "started" | "earlier" | null,
) => {
  await pool.query(
    `WITH pass AS (
       SELECT date_trunc('second', clock_timestamp() - make_interval(secs => $1::float8 * 3600)) AS at
     ), maintenance AS (
       UPDATE workhorse.maintenance_policy
          SET history_retention_local_time = ((SELECT at FROM pass) AT TIME ZONE 'UTC')::time
     ), retention AS (
       UPDATE workhorse.retention_policy SET updated_at = clock_timestamp() - interval '3 days'
     )
     UPDATE workhorse.maintenance_state
        SET last_started_at = pass.at,
            last_completed_local_date = CASE $2::text
              WHEN 'started' THEN (pass.at AT TIME ZONE 'UTC')::date
              WHEN 'earlier' THEN (pass.at AT TIME ZONE 'UTC')::date - 2 END
       FROM pass
      WHERE routine_name = 'history_retention'`,
    [startedHoursAgo, completedLocalDate],
  );
};

const sinceUtcMidnightMs = async () =>
  Number(
    (
      await pool.query<{ ms: string }>(
        `SELECT extract(epoch FROM clock_timestamp()
                  - date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                  * 1000 AS ms`,
      )
    ).rows[0]!.ms,
  );

const hourMs = 3_600_000;
const dayMs = 86_400_000;

// Writes a terminal full-tier task with no history rows, as a retired history partition leaves it.
// It was created and finished ageHours ago, and its history ends historyAgeHours ago.
const insertTerminalTask = async (type: string, ageHours: number, historyAgeHours = ageHours) =>
  (
    await pool.query<{ id: string }>(
      `WITH task AS (
         INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
         VALUES ('retention-holds', $1, '{}'::jsonb, 1,
                 clock_timestamp() - make_interval(secs => $2::float8 * 3600))
         RETURNING id, created_at
       )
       INSERT INTO workhorse.task_outcome(
         task_id, state, current_attempt, fence_token, run_at, result, finished_at,
         history_through_at
       )
       SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at,
              clock_timestamp() - make_interval(secs => $3::float8 * 3600)
         FROM task
       RETURNING task_id AS id`,
      [type, ageHours, historyAgeHours],
    )
  ).rows[0]!.id;

// Row windows of one day, a UTC pass at 00:00, and a watermark one day back. A row whose history
// ends before the watermark is then released, and its scheduled history pass is long past.
const useOneDayRowWindows = async (terminalTaskPruneLimit = 1000) => {
  await queue.syncMaintenancePolicy(
    { timezone: "UTC", historyRetentionLocalTime: "00:00" },
    { force: true },
  );
  await queue.syncRetentionPolicy({
    ...defaultRetentionPolicy,
    taskIdentityRetentionDays: 1,
    terminalOutcomeRetentionDays: 1,
    taskEventRetentionDays: 1,
    attemptHistoryRetentionDays: 1,
    scheduleOccurrenceRetentionDays: 1,
    statisticsRetentionDays: 1,
    terminalTaskPruneLimit,
  });
  await pool.query(
    `UPDATE workhorse.maintenance_state
        SET history_retained_before = clock_timestamp() - interval '24 hours'
      WHERE routine_name = 'history_retention'`,
  );
};

const addHealthSchedule = async () => {
  await pool.query(
    `INSERT INTO workhorse.schedule_definition(
       namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
     ) VALUES ('integration', 'retention-holds', '0 * * * *', 'default', 'retention-holds',
               '{}'::jsonb, 3)
     ON CONFLICT DO NOTHING`,
  );
};

// The references that keep a terminal row. Each one returns after it gives taskId its reference.
const holdReferences = {
  "a schedule occurrence": async (taskId: string) => {
    await addHealthSchedule();
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at, task_id)
       VALUES ('integration', 'retention-holds', clock_timestamp() - interval '1 hour', $1)`,
      [taskId],
    );
  },
  "an enqueue key": async (taskId: string) => {
    await pool.query(
      `INSERT INTO workhorse.enqueue_idempotency(
         idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
       ) VALUES ('retention-holds', sha256(convert_to($1::text, 'UTF8')), '{}'::jsonb, $1::uuid,
                 clock_timestamp() + interval '30 days')`,
      [taskId],
    );
  },
  "a dependency edge to a live dependent": async (taskId: string) => {
    const dependent = await queue.enqueue("retention-hold-dependent", {});
    await pool.query(
      `INSERT INTO workhorse.task_dependency(
         dependent_task_id, prerequisite_task_id, on_failure, on_cancellation, on_success
       ) VALUES ($1, $2, 'fail', 'cancel', 'release')`,
      [dependent, taskId],
    );
  },
  "a young child": async (taskId: string) => {
    const child = await insertTerminalTask("retention-hold-child", 1);
    await pool.query(
      `INSERT INTO workhorse.task_child(parent_task_id, child_task_id, child_name, request_fingerprint)
       VALUES ($1, $2, 'child', '{}'::jsonb)`,
      [taskId, child],
    );
  },
} satisfies Record<string, (taskId: string) => Promise<void>>;

// A redrive needs a failed task with its own history, so this subject is written through the
// public operations and then aged.
const redriveSource = async () => {
  const taskId = await createFailedTask({ type: "retention-hold-source" });
  await admin.redrive(taskId, adminAudit("hold"));
  await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [taskId]);
  await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [taskId]);
  await pool.query(
    `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '20 days'
      WHERE id = $1`,
    [taskId],
  );
  await pool.query(
    `UPDATE workhorse.task_outcome
        SET finished_at = clock_timestamp() - interval '20 days',
            history_through_at = clock_timestamp() - interval '20 days'
      WHERE task_id = $1`,
    [taskId],
  );
  return taskId;
};

const rowLag = async () => {
  const health = await queue.health();
  return [health.retentionLagMs.taskIdentity, health.retentionLagMs.terminalOutcome] as const;
};

// A null expectation means that health skips the row, so neither lag has a value.
const expectRowLag = (lag: readonly (number | null)[], expectedMs: number | null) => {
  const near = (value: number | null) =>
    expectedMs === null ? value === null : value !== null && Math.abs(value - expectedMs) < 60_000;
  expect(lag.map((value) => (near(value) ? "expected" : value))).toEqual(["expected", "expected"]);
};

const expectRowLagNear = (lag: readonly (number | null)[], expectedMs: number) => {
  for (const value of lag) {
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(expectedMs - 60_000);
    expect(value!).toBeLessThan(expectedMs + 60_000);
  }
};

// The lag of a row whose history ends historyAgeHours ago and whose row windows ended earlier. With
// one-day history windows and a UTC pass at 00:00, the pass that releases it is the start of the UTC
// day after its history plus 24 hours.
const releasedRowLagMs = async (historyAgeHours: number) =>
  Number(
    (
      await pool.query<{ ms: string }>(
        `SELECT extract(epoch FROM clock_timestamp() - (
                  date_trunc('day', (clock_timestamp() - make_interval(secs => $1::float8 * 3600)
                    + interval '24 hours') AT TIME ZONE 'UTC') + interval '1 day'
                ) AT TIME ZONE 'UTC') * 1000 AS ms`,
        [historyAgeHours],
      )
    ).rows[0]!.ms,
  );

// Reads of one prune_terminal_tasks_v1 call under a generic plan, behind kept tasks only.
const firstPruneCallReads = async (kept: number) => {
  // TRUNCATE leaves no dead index entries, which an index scan would also count.
  await pool.query(
    "TRUNCATE workhorse.task, workhorse.terminal_prune_position RESTART IDENTITY CASCADE",
  );
  await pool.query(
    `WITH task AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
       SELECT 'retention-generic', 'kept', '{}'::jsonb, 1,
              clock_timestamp() - interval '30 days' + make_interval(secs => position)
         FROM generate_series(1, $1::integer) position
       RETURNING id, created_at
     ), outcome AS (
       INSERT INTO workhorse.task_outcome(
         task_id, state, current_attempt, fence_token, run_at, result, finished_at,
         history_through_at
       )
       SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at FROM task
     )
     INSERT INTO workhorse.enqueue_idempotency(
       idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
     )
     SELECT 'retention-generic', sha256(convert_to(id::text, 'UTF8')), '{}'::jsonb, id,
            clock_timestamp() + interval '30 days'
       FROM task`,
    [kept],
  );
  await pool.query("ANALYZE workhorse.task, workhorse.task_outcome, workhorse.enqueue_idempotency");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL plan_cache_mode = force_generic_plan");
    const reads = async () =>
      Number(
        (
          await client.query<{ tuples: string }>(
            `SELECT pg_stat_get_xact_tuples_returned(
                      'workhorse.task_outcome_retention_idx'::regclass)
                    + pg_stat_get_xact_tuples_returned('workhorse.task_outcome'::regclass)
                    + pg_stat_get_xact_tuples_returned('workhorse.task'::regclass)
                      AS tuples`,
          )
        ).rows[0]!.tuples,
      );
    const before = await reads();
    await client.query(
      `SELECT workhorse.prune_terminal_tasks_v1(
              clock_timestamp() - interval '24 hours', clock_timestamp() - interval '24 hours',
              clock_timestamp() - interval '24 hours', 2)`,
    );
    const read = (await reads()) - before;
    await client.query("ROLLBACK");
    return read;
  } finally {
    client.release();
  }
};

// Reads of one key phase and one released-edge phase, behind members of an open task group that
// each have an expired key and a released edge. "references" counts the index rows of the two
// reference walks, and "tables" counts the rows that each scan returns and each index scan fetches
// from task and task_outcome.
const referencePhaseReads = async (
  kept: number,
  counted: "references" | "tables" = "references",
  plan: "force_generic_plan" | "force_custom_plan" = "force_generic_plan",
) => {
  await pool.query(
    "TRUNCATE workhorse.task, workhorse.task_group, workhorse.terminal_prune_position CASCADE",
  );
  await pool.query(
    `WITH member_group AS (
       INSERT INTO workhorse.task_group(shard_count) VALUES (1) RETURNING id
     ), task AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
       SELECT 'retention-phases', 'kept', '{}'::jsonb, 1,
              clock_timestamp() - interval '30 days' + make_interval(secs => position)
         FROM generate_series(1, $1::integer) position
       RETURNING id, created_at
     ), dependent AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
       SELECT 'retention-phases', 'dependent', '{}'::jsonb, 1, clock_timestamp()
       RETURNING id, created_at
     ), outcome AS (
       INSERT INTO workhorse.task_outcome(
         task_id, state, current_attempt, fence_token, run_at, result, finished_at,
         history_through_at
       )
       SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at FROM task
       UNION ALL
       SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at
         FROM dependent
     ), member AS (
       INSERT INTO workhorse.task_group_member(task_id, group_id, position)
       SELECT task.id, member_group.id, row_number() OVER (ORDER BY task.id)
         FROM task CROSS JOIN member_group
     ), edge AS (
       INSERT INTO workhorse.task_dependency(
         dependent_task_id, prerequisite_task_id, on_failure, on_cancellation, on_success,
         created_at, released_at, resolution
       )
       SELECT dependent.id, task.id, 'fail', 'cancel', 'release',
              clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour',
              'release'
         FROM task CROSS JOIN dependent
     )
     INSERT INTO workhorse.enqueue_idempotency(
       idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
     )
     SELECT 'retention-phases', sha256(convert_to(id::text, 'UTF8')), '{}'::jsonb, id,
            clock_timestamp() - interval '1 hour'
       FROM task`,
    [kept],
  );
  await pool.query(
    "ANALYZE workhorse.task, workhorse.task_outcome, workhorse.enqueue_idempotency, workhorse.task_dependency",
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL plan_cache_mode = ${plan}`);
    const reads = async () =>
      Number(
        (
          await client.query<{ tuples: string }>(
            counted === "references"
              ? `SELECT pg_stat_get_xact_tuples_returned(
                          'workhorse.enqueue_idempotency_expiry_idx'::regclass)
                        + pg_stat_get_xact_tuples_returned(
                          'workhorse.task_dependency_released_retention_idx'::regclass)
                          AS tuples`
              : `SELECT pg_stat_get_xact_tuples_returned('workhorse.task'::regclass)
                        + pg_stat_get_xact_tuples_fetched('workhorse.task'::regclass)
                        + pg_stat_get_xact_tuples_returned('workhorse.task_outcome'::regclass)
                        + pg_stat_get_xact_tuples_fetched('workhorse.task_outcome'::regclass)
                          AS tuples`,
          )
        ).rows[0]!.tuples,
      );
    const before = await reads();
    await client.query("SELECT workhorse.prune_enqueue_idempotency_v1(clock_timestamp(), 1)");
    await client.query("SELECT workhorse.prune_released_dependencies_v1(1)");
    const read = (await reads()) - before;
    await client.query("ROLLBACK");
    return read;
  } finally {
    client.release();
  }
};

const taskExists = async (id: string) =>
  (await pool.query("SELECT 1 FROM workhorse.task WHERE id = $1", [id])).rowCount === 1;

const pruneOneCall = async () =>
  (
    await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_tasks_v1(
              clock_timestamp() - interval '24 hours', clock_timestamp() - interval '24 hours',
              clock_timestamp() - interval '24 hours', 1) AS pruned`,
    )
  ).rows[0]!.pruned;

const keyedFailedTask = async (expiredHoursAgo: number) => {
  const taskId = await createFailedTask({ type: "retention-held-key" });
  await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [taskId]);
  await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [taskId]);
  await pool.query(
    `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '30 days'
      WHERE id = $1`,
    [taskId],
  );
  await pool.query(
    `UPDATE workhorse.task_outcome
        SET finished_at = clock_timestamp() - interval '30 days',
            history_through_at = clock_timestamp() - interval '30 days'
      WHERE task_id = $1`,
    [taskId],
  );
  await pool.query(
    `INSERT INTO workhorse.enqueue_idempotency(
       idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
     ) VALUES ('retention-held-key', sha256(convert_to($1::text, 'UTF8')), '{}'::jsonb,
               $1::uuid, clock_timestamp() - make_interval(secs => $2::float8 * 3600))`,
    [taskId, expiredHoursAgo],
  );
  return taskId;
};

const heldUntil = async (taskId: string) =>
  (
    await pool.query<{ held_until: Date | null }>(
      "SELECT held_until FROM workhorse.task_outcome WHERE task_id = $1",
      [taskId],
    )
  ).rows[0]!.held_until;

const pruneKeys = (client: PoolClient) =>
  client.query("SELECT workhorse.prune_enqueue_idempotency_v1(clock_timestamp(), 10)");

// Writes count old tasks that an enqueue key keeps, lets the main walk pass them, and then deletes
// their keys. The old tasks are then eligible but behind the main position.
const passOldTasks = async (count: number) => {
  await useOneDayRowWindows(1);
  const oldTasks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const oldTask = await insertTerminalTask("retention-sweep-old", 40 * 24 + count - index);
    await pool.query(
      `INSERT INTO workhorse.enqueue_idempotency(
         idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
       ) VALUES ('retention-sweep', sha256(convert_to($1::text, 'UTF8')), '{}'::jsonb,
                 $1::uuid, clock_timestamp() + interval '1 day')`,
      [oldTask],
    );
    oldTasks.push(oldTask);
  }
  await pool.query(
    `WITH task AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
       SELECT 'retention-sweep', 'eligible', '{}'::jsonb, 1,
              clock_timestamp() - interval '30 days' + make_interval(secs => position)
         FROM generate_series(1, 1100) position
       RETURNING id, created_at
     )
     INSERT INTO workhorse.task_outcome(
       task_id, state, current_attempt, fence_token, run_at, result, finished_at,
       history_through_at
     )
     SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at FROM task`,
  );
  for (let call = 0; call < 3; call += 1) await pruneOneCall();
  const position = await pool.query<{ main: Date | null }>(
    "SELECT finished_at AS main FROM workhorse.terminal_prune_position WHERE tier = 'full'",
  );
  expect(position.rows[0]!.main).not.toBeNull();
  for (const oldTask of oldTasks) expect(await taskExists(oldTask)).toBe(true);
  await pool.query("DELETE FROM workhorse.enqueue_idempotency WHERE task_id = ANY($1::uuid[])", [
    oldTasks,
  ]);
  return oldTasks;
};

const passOldTask = async () => (await passOldTasks(1))[0]!;

// With limit 1, each call runs one full-tier batch. The sweep examines R rows before it reaches
// a row, a slice has S rows, a batch locks at most L rows, and sweep batches lock E rows before
// that row. A main batch that deleted rows is followed by a sweep batch. The row therefore goes
// within 2 * (ceil(R / S) + ceil(E / L) + 2) batches (ADR 0122).
const sweepBound = (rows: number, locked: number) =>
  2 * (Math.ceil(rows / 1000) + Math.ceil(locked / 1) + 2);

// Runs work while another connection holds a lock that lockSql takes, and then ends that holder.
const whileLocked = async <T>(lockSql: string, params: unknown[], work: () => Promise<T>) => {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(lockSql, params);
    return await work();
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
};

const lockOutcomeForShare = "SELECT 1 FROM workhorse.task_outcome WHERE task_id = $1 FOR SHARE";
const lockTaskForUpdate = "SELECT 1 FROM workhorse.task WHERE id = $1 FOR UPDATE";

const pruneTerminalBatch = async (limit = 10) =>
  (
    await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_tasks_v1(
              clock_timestamp() - interval '24 hours', clock_timestamp() - interval '24 hours',
              clock_timestamp() - interval '24 hours', $1) AS pruned`,
      [limit],
    )
  ).rows[0]!.pruned;

// Each lag stays within one minute of its value before the reference went.
const expectSameRowLag = (
  before: readonly (number | null)[],
  after: readonly (number | null)[],
) => {
  for (const [index, value] of before.entries()) {
    expect(value).not.toBeNull();
    expect(after[index]).not.toBeNull();
    expect(Math.abs(after[index]! - value!)).toBeLessThan(60_000);
  }
};

// A task that finished 30 days ago with an enqueue key that expired 2 hours ago.
const agedKeyedTask = async (key: string) => {
  const id = await queue.enqueue("retention-reuse", {}, { idempotency: { key, ttlMs: 3_600_000 } });
  const task = await queue.claim("retention-reuse-worker");
  expect(task?.id).toBe(id);
  expect(await queue.complete(task!, "retention-reuse-worker", { done: true })).toBe(true);
  await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [id]);
  await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [id]);
  await pool.query(
    "UPDATE workhorse.task SET created_at = clock_timestamp() - interval '720 hours' WHERE id = $1",
    [id],
  );
  await pool.query(
    `UPDATE workhorse.task_outcome
        SET finished_at = clock_timestamp() - interval '720 hours',
            history_through_at = clock_timestamp() - interval '720 hours'
      WHERE task_id = $1`,
    [id],
  );
  await pool.query(
    `UPDATE workhorse.enqueue_idempotency SET expires_at = clock_timestamp() - interval '2 hours'
      WHERE task_id = $1`,
    [id],
  );
  return id;
};

// The scans of task_outcome in the current transaction of client: its table scans and the scans of
// each of its indexes.
const outcomeReads = async (client: PoolClient) =>
  Number(
    (
      await client.query<{ scans: string }>(
        `SELECT pg_stat_get_xact_numscans('workhorse.task_outcome'::regclass)
                + (SELECT COALESCE(sum(pg_stat_get_xact_numscans(index.indexrelid)), 0)
                     FROM pg_index index
                    WHERE index.indrelid = 'workhorse.task_outcome'::regclass) AS scans`,
      )
    ).rows[0]!.scans,
  );

// A finished task group of one member that finished 26 hours ago, with its shard row.
const finishedGroupOf = async (member: string) => {
  const group = (
    await pool.query<{ id: string }>(
      `INSERT INTO workhorse.task_group(
         state, result, total_count, succeeded_count, sealed_at, finished_at, shard_count
       ) VALUES ('finished', 'succeeded', 1, 1, clock_timestamp() - interval '26 hours',
                 clock_timestamp() - interval '26 hours', 1)
       RETURNING id`,
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO workhorse.task_group_shard(group_id, shard, total_count, succeeded_count)
     VALUES ($1, 0, 1, 1)`,
    [group],
  );
  await pool.query(
    `INSERT INTO workhorse.task_group_member(task_id, group_id, position, outcome, counted_at)
     VALUES ($1, $2, 1, 'succeeded', clock_timestamp())`,
    [member, group],
  );
  return group;
};

const groupExists = async (id: string) =>
  (await pool.query("SELECT 1 FROM workhorse.task_group WHERE id = $1", [id])).rowCount === 1;

// A parent that finished 30 days ago with a child that became eligible about 3 hours ago.
const parentWithEligibleChild = async () => {
  const parent = await insertTerminalTask("retention-held-parent", 30 * 24);
  const child = await insertTerminalTask("retention-held-child", 27, 50);
  await pool.query(
    `INSERT INTO workhorse.task_child(parent_task_id, child_task_id, child_name, request_fingerprint)
     VALUES ($1, $2, 'child', '{}'::jsonb)`,
    [parent, child],
  );
  return { parent, child };
};

const prerequisiteWithFinishedDependent = async () => {
  const prerequisite = await insertTerminalTask("retention-held-prerequisite", 30 * 24);
  const dependent = await insertTerminalTask("retention-held-dependent", 26);
  await pool.query(
    `INSERT INTO workhorse.task_dependency(
       dependent_task_id, prerequisite_task_id, on_failure, on_cancellation, on_success,
       created_at, released_at, resolution
     ) VALUES ($1, $2, 'fail', 'cancel', 'release', clock_timestamp() - interval '27 hours',
               clock_timestamp() - interval '27 hours', 'release')`,
    [dependent, prerequisite],
  );
  return { prerequisite, dependent };
};

// A failed source that finished 30 days ago, with a target that it redrove. finishTarget completes
// the target and ages it past its windows, and otherwise the target stays ready.
const agedRedriveSource = async (finishTarget: boolean) => {
  const source = await createFailedTask({ type: "retention-held-source" });
  const target = (await admin.redrive(source, adminAudit("held source"))).targetTaskId!;
  if (finishTarget) {
    const task = await queue.claim("retention-held-source-worker");
    expect(task?.id).toBe(target);
    expect(await queue.complete(task!, "retention-held-source-worker", {})).toBe(true);
  }
  const aged = finishTarget ? [source, target] : [source];
  await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [aged]);
  await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [aged]);
  await pool.query(
    `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '720 hours'
      WHERE id = ANY($1::uuid[])`,
    [aged],
  );
  await pool.query(
    `UPDATE workhorse.task_outcome
        SET finished_at = clock_timestamp() - interval '720 hours',
            history_through_at = clock_timestamp() - interval '720 hours'
      WHERE task_id = ANY($1::uuid[])`,
    [aged],
  );
  return { source, target };
};

// A task that finished 30 days ago with a schedule occurrence whose window ended 25 hours ago.
const taskWithExpiredOccurrence = async () => {
  const taskId = await insertTerminalTask("retention-held-occurrence", 30 * 24);
  await addHealthSchedule();
  await pool.query(
    `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at, task_id)
     VALUES ('integration', 'retention-holds',
             date_trunc('second', clock_timestamp() - interval '49 hours'), $1)`,
    [taskId],
  );
  return taskId;
};

const occurrenceCount = async (taskId: string) =>
  (await pool.query("SELECT 1 FROM workhorse.schedule_occurrence WHERE task_id = $1", [taskId]))
    .rowCount;

const pruneOccurrences = () =>
  pool.query(
    "SELECT workhorse.prune_schedule_occurrences_v1(clock_timestamp() - interval '24 hours', 1000)",
  );

// Moves a terminal task 30 days back and removes its history rows.
const ageTerminalTask = async (id: string) => {
  await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [id]);
  await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [id]);
  await pool.query(
    "UPDATE workhorse.task SET created_at = clock_timestamp() - interval '720 hours' WHERE id = $1",
    [id],
  );
  await pool.query(
    `UPDATE workhorse.task_outcome
        SET finished_at = clock_timestamp() - interval '720 hours',
            history_through_at = clock_timestamp() - interval '720 hours'
      WHERE task_id = $1`,
    [id],
  );
};

describe("retention maintenance", () => {
  it("keeps an operator maintenance-time override until it is reverted", async () => {
    await queue.syncMaintenancePolicy(
      { timezone: "UTC", historyRetentionLocalTime: "03:00" },
      { force: true },
    );
    await queue.overrideMaintenancePolicy({ historyRetentionLocalTime: "01:30" });

    await queue.syncMaintenancePolicy({
      timezone: "UTC",
      historyRetentionLocalTime: "04:15",
    });
    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      historyRetentionLocalTime: "01:30",
      provenance: {
        historyRetentionLocalTime: {
          source: "operator",
          applicationDefault: "04:15",
        },
      },
    });

    await queue.revertMaintenancePolicy(["historyRetentionLocalTime"]);
    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      historyRetentionLocalTime: "04:15",
      provenance: {
        historyRetentionLocalTime: {
          source: "application",
          applicationDefault: "04:15",
        },
      },
    });
  });

  it("keeps operator retention overrides while application defaults continue to update", async () => {
    await queue.syncRetentionPolicy(defaultRetentionPolicy, { force: true });
    await queue.overrideRetentionPolicy({
      taskIdentityRetentionDays: 30,
      taskEventRetentionDays: 30,
    });

    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 21,
      taskEventRetentionDays: 21,
    });
    await expect(queue.getRetentionPolicy()).resolves.toMatchObject({
      taskEventRetentionDays: 30,
      provenance: {
        taskEventRetentionDays: { source: "operator", applicationDefault: 21 },
      },
    });

    await queue.revertRetentionPolicy(["taskEventRetentionDays"]);
    await expect(queue.getRetentionPolicy()).resolves.toMatchObject({
      taskEventRetentionDays: 21,
      provenance: {
        taskEventRetentionDays: { source: "application", applicationDefault: 21 },
      },
    });
  });

  it("restores omitted optional settings to application defaults during a forced sync", async () => {
    await queue.syncMaintenancePolicy(
      { timezone: "UTC", partitionPreparationIntervalMs: 60_000 },
      { force: true },
    );
    await queue.syncRetentionPolicy(
      { ...defaultRetentionPolicy, terminalTaskPruneLimit: 50 },
      { force: true },
    );
    await queue.overrideMaintenancePolicy({ partitionPreparationIntervalMs: 120_000 });
    await queue.overrideRetentionPolicy({ terminalTaskPruneLimit: 75 });

    await queue.syncMaintenancePolicy({ timezone: "UTC" }, { force: true });
    await queue.syncRetentionPolicy(
      {
        taskIdentityRetentionDays: defaultRetentionPolicy.taskIdentityRetentionDays,
        terminalOutcomeRetentionDays: defaultRetentionPolicy.terminalOutcomeRetentionDays,
        taskEventRetentionDays: defaultRetentionPolicy.taskEventRetentionDays,
        attemptHistoryRetentionDays: defaultRetentionPolicy.attemptHistoryRetentionDays,
        scheduleOccurrenceRetentionDays: defaultRetentionPolicy.scheduleOccurrenceRetentionDays,
        statisticsRetentionDays: defaultRetentionPolicy.statisticsRetentionDays,
      },
      { force: true },
    );

    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      partitionPreparationIntervalMs: 60_000,
      provenance: { partitionPreparationIntervalMs: { source: "application" } },
    });
    await expect(queue.getRetentionPolicy()).resolves.toMatchObject({
      terminalTaskPruneLimit: 50,
      provenance: { terminalTaskPruneLimit: { source: "application" } },
    });
  });

  it("previews bounded rows that shorter retention would make eligible", async () => {
    const id = await queue.enqueue("retention-preview", {});
    const claimed = await queue.claim("retention-preview-worker");
    await queue.complete(claimed!, "retention-preview-worker", { ok: true });
    await pool.query("UPDATE workhorse.task SET created_at = '2020-01-01' WHERE id = $1", [id]);
    await pool.query(
      "UPDATE workhorse.task_outcome SET finished_at = '2020-01-02' WHERE task_id = $1",
      [id],
    );

    await expect(
      queue.previewRetentionPolicy({
        taskIdentityRetentionDays: 1,
        terminalOutcomeRetentionDays: 1,
      }),
    ).resolves.toMatchObject({
      eligible: { terminalTasks: 1 },
      capped: { terminalTasks: false },
    });
  });

  it("merges the definition and caps each count in dashboard_retention_preview_v1", async () => {
    // 10,001 old hourly buckets: one more than the cap.
    await pool.query(
      `INSERT INTO workhorse.task_stat_bucket_hour(bucket_start, queue_name, task_type, enqueued)
       SELECT timestamptz '2020-01-01 00:00Z', 'preview-' || n, 'retention-preview-cap', 1
         FROM generate_series(1, 10001) n`,
    );
    const preview = async (definition: Record<string, number | null>) =>
      (
        await pool.query<{
          result: { eligible: Record<string, number>; capped: Record<string, boolean> };
        }>("SELECT workhorse.dashboard_retention_preview_v1($1::jsonb) AS result", [
          JSON.stringify({ definition }),
        ])
      ).rows[0]!.result;

    // An absent setting keeps the effective 14 days.
    await expect(preview({})).resolves.toMatchObject({
      eligible: { statistics: 10_000 },
      capped: { statistics: true },
    });
    // An explicit null disables the category.
    await expect(preview({ statisticsRetentionDays: null })).resolves.toMatchObject({
      eligible: { statistics: 0 },
      capped: { statistics: false },
    });
    // A longer window than the age of the rows makes none of them eligible.
    await expect(preview({ statisticsRetentionDays: 36_500 })).resolves.toMatchObject({
      eligible: { statistics: 0 },
      capped: { statistics: false },
    });
    await expect(preview({})).resolves.toEqual({
      eligible: {
        terminalTasks: expect.any(Number),
        taskEvents: expect.any(Number),
        attemptHistory: expect.any(Number),
        scheduleOccurrences: expect.any(Number),
        statistics: 10_000,
      },
      capped: {
        terminalTasks: false,
        taskEvents: false,
        attemptHistory: false,
        scheduleOccurrences: false,
        statistics: true,
      },
    });
  });

  it("persists one IANA maintenance timezone and runs daily retention once after local time", async () => {
    expect(
      await queue.syncMaintenancePolicy({
        timezone: "America/New_York",
        partitionPreparationIntervalMs: 3_600_000,
        terminalCleanupIntervalMs: 60_000,
        historyRetentionLocalTime: "03:30",
      }),
    ).toMatchObject({
      timezone: "America/New_York",
      partitionPreparationIntervalMs: 3_600_000,
      terminalCleanupIntervalMs: 60_000,
      historyRetentionLocalTime: "03:30",
    });
    await expect(queue.syncMaintenancePolicy({ timezone: "Mars/Olympus_Mons" })).rejects.toThrow(
      /valid IANA timezone/,
    );

    const beforeSpringForwardBoundary = new Date("2026-03-08T06:59:00.000Z");
    const atSpringForwardBoundary = new Date("2026-03-08T07:30:00.000Z");
    expect(await queue.retainHistory({ now: beforeSpringForwardBoundary })).toEqual([]);
    expect(await queue.retainHistory({ now: atSpringForwardBoundary })).toHaveLength(3);
    expect(await queue.retainHistory({ now: new Date("2026-03-08T08:00:00.000Z") })).toEqual([]);
    await queue.syncMaintenancePolicy({ timezone: "America/New_York" });
    expect(await queue.retainHistory({ now: new Date("2026-03-08T09:00:00.000Z") })).toEqual([]);
    await queue.syncMaintenancePolicy({
      timezone: "America/New_York",
      partitionPreparationIntervalMs: 7_200_000,
    });
    expect(await queue.retainHistory({ now: new Date("2026-03-08T10:00:00.000Z") })).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT last_completed_local_date::text AS last_completed_local_date FROM workhorse.maintenance_state WHERE routine_name = 'history_retention'",
        )
      ).rows,
    ).toEqual([{ last_completed_local_date: "2026-03-08" }]);
  });

  it("continues bounded occurrence retention on the same local date until the backlog clears", async () => {
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
       ) VALUES ('retention-backlog', 'daily', '0 0 * * *', 'default', 'backlog', '{}'::jsonb, 1)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
       VALUES ('retention-backlog', 'daily', '2020-01-01T00:00:00Z'),
              ('retention-backlog', 'daily', '2020-01-02T00:00:00Z')`,
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      occurrenceRowsPerPass: 1,
    });
    await queue.syncMaintenancePolicy({ timezone: "UTC", historyRetentionLocalTime: "03:00" });

    const first = await queue.retainHistory({ now: new Date("2026-08-02T03:00:00.000Z") });
    const second = await queue.retainHistory({ now: new Date("2026-08-02T03:01:00.000Z") });
    const third = await queue.retainHistory({ now: new Date("2026-08-02T03:02:00.000Z") });
    expect(first[2]).toMatchObject({ phase: "schedule_occurrences", rowsAffected: 1 });
    expect(second[2]).toMatchObject({ phase: "schedule_occurrences", rowsAffected: 1 });
    expect(third).toEqual([]);
  });

  it("globally rate-limits interval maintenance routines while allowing explicit forced runs", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    expect(await queue.prepareHistoryPartitions({ now })).toHaveLength(1);
    expect(await queue.prepareHistoryPartitions({ now: new Date(now.getTime() + 1_000) })).toEqual(
      [],
    );
    expect(await queue.prepareHistoryPartitions({ force: true, now })).toHaveLength(1);

    expect(await queue.pruneTerminalStorage({ now })).toHaveLength(4);
    expect(await queue.pruneTerminalStorage({ now: new Date(now.getTime() + 1_000) })).toEqual([]);
    expect(await queue.pruneTerminalStorage({ force: true, now })).toHaveLength(4);
  });

  it("keeps due state and retention on the database clock when the worker clock is fast", async () => {
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
       ) VALUES ('clock-skew', 'daily', '0 0 * * *', 'default', 'clock-skew', '{}'::jsonb, 1)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
       VALUES ('clock-skew', 'daily', clock_timestamp() - interval '13 days')`,
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      scheduleOccurrenceRetentionDays: 14,
    });
    await queue.syncMaintenancePolicy({ timezone: "UTC", historyRetentionLocalTime: "00:00" });
    const worker = new Worker(queue, { workerId: "fast-clock-worker" });

    // Only Date moves. The worker's intervals use the monotonic clock, so the pass still runs.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 86_400_000 });
    try {
      await worker.runOnce();
    } finally {
      vi.useRealTimers();
    }

    const occurrences = await pool.query(
      "SELECT 1 FROM workhorse.schedule_occurrence WHERE namespace = 'clock-skew'",
    );
    expect(occurrences.rowCount).toBe(1);
    const routines = await pool.query<{ routine_name: string; ahead: boolean; started: boolean }>(
      `SELECT routine_name, last_started_at > clock_timestamp() AS ahead,
              last_started_at IS NOT NULL AS started
         FROM workhorse.maintenance_state
        WHERE routine_name IN ('history_partitions', 'history_retention')
        ORDER BY routine_name`,
    );
    expect(routines.rows).toEqual([
      { routine_name: "history_partitions", ahead: false, started: true },
      { routine_name: "history_retention", ahead: false, started: true },
    ]);
  });

  it("retains bounded routine history while omitting idle tick executions", async () => {
    await queue.tick();
    await expect(
      pool.query(
        "SELECT count(*)::integer AS count FROM workhorse.maintenance_run WHERE routine_name = 'tick'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const taskId = await queue.enqueue(
      "maintenance-history",
      {},
      { runAt: new Date(Date.now() + 60_000) },
    );
    await pool.query(
      "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 second' WHERE task_id = $1",
      [taskId],
    );
    await queue.tick();
    await expect(
      pool.query(
        `SELECT outcome, rows_affected, jsonb_array_length(phases) AS phase_count
           FROM workhorse.maintenance_run WHERE routine_name = 'tick'`,
      ),
    ).resolves.toMatchObject({
      rows: [{ outcome: "succeeded", rows_affected: 1, phase_count: 2 }],
    });

    const secondTaskId = await queue.enqueue(
      "maintenance-history-second",
      {},
      { runAt: new Date(Date.now() + 60_000) },
    );
    await pool.query(
      "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 second' WHERE task_id = $1",
      [secondTaskId],
    );
    await queue.tick();
    await expect(
      pool.query(
        "SELECT count(*)::integer AS count FROM workhorse.maintenance_run WHERE routine_name = 'tick'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    await pool.query(`
      SELECT workhorse.record_maintenance_run_internal_v1(
        'history_partitions',
        clock_timestamp() + make_interval(secs => sequence),
        clock_timestamp() + make_interval(secs => sequence + 0.001),
        'succeeded', sequence,
        jsonb_build_array(jsonb_build_object(
          'phase', 'history_partitions', 'rowsAffected', sequence,
          'durationMs', 1, 'error', NULL
        ))
      )
        FROM generate_series(1, 55) AS runs(sequence)
    `);
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count, min(rows_affected)::integer AS oldest_retained
           FROM workhorse.maintenance_run WHERE routine_name = 'history_partitions'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 50, oldest_retained: 6 }] });

    const dashboard = await pool.query<{
      result: { maintenance: { routines: Array<{ routine: string; runs: unknown[] }> } };
    }>(
      `SELECT workhorse.dashboard_cron_v1(
        '{"maintenanceLoops":{"tickIntervalMs":1000}}'::jsonb
      ) AS result`,
    );
    expect(dashboard.rows[0]!.result.maintenance.routines).toContainEqual(
      expect.objectContaining({
        routine: "history_partitions",
        recordedRunCount: 50,
        runs: expect.arrayContaining([
          expect.objectContaining({ outcome: "succeeded", rowsAffected: 55 }),
        ]),
      }),
    );
    const partitionRoutine = dashboard.rows[0]!.result.maintenance.routines.find(
      (routine) => routine.routine === "history_partitions",
    );
    expect(partitionRoutine?.runs).toHaveLength(5);
  });

  it("isolates housekeeping phases when partition replenishment fails", async () => {
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
       ) VALUES ('integration', 'isolation', '0 * * * *', 'default', 'isolation', '{}'::jsonb, 3)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
       VALUES ('integration', 'isolation', clock_timestamp() - interval '40 days')`,
    );
    await pool.query(`
      DO $$
      DECLARE suffix text := to_char(current_date + 3, 'YYYYMMDD');
      BEGIN
        EXECUTE format('DROP TABLE workhorse.%I', 'task_event_' || suffix);
        EXECUTE format('DROP TABLE workhorse.%I', 'attempt_history_' || suffix);
      END
      $$`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION workhorse.create_history_day_v1(p_day date)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced partition replenishment failure';
      END
      $$`);

    try {
      const partitionResults = await queue.prepareHistoryPartitions({ force: true });
      expect(partitionResults[0]).toMatchObject({
        phase: "history_partitions",
        rowsAffected: 0,
        skippedLock: false,
        error: { message: "forced partition replenishment failure" },
      });
      await expect(
        pool.query(
          `SELECT outcome, phases->0->'error'->>'message' AS message
             FROM workhorse.maintenance_run
            WHERE routine_name = 'history_partitions'
            ORDER BY started_at DESC, run_id DESC LIMIT 1`,
        ),
      ).resolves.toMatchObject({
        rows: [{ outcome: "failed", message: "forced partition replenishment failure" }],
      });
      const retentionResults = await queue.retainHistory({ force: true });
      expect(retentionResults[2]).toMatchObject({
        phase: "schedule_occurrences",
        rowsAffected: 1,
        skippedLock: false,
        error: null,
      });
    } finally {
      await installSchema(pool);
    }
  });

  it("materializes closed minutes of statistics and converges when a minute is recomputed", async () => {
    await queue.enqueue("stat-alpha", {});
    await queue.enqueue("stat-alpha", {});
    await queue.enqueue("stat-beta", {});
    await queue.tick();
    const worker = new Worker(queue, {
      workerId: "worker-statistics",
    })
      .handle("stat-alpha", () => ({ ok: true }))
      .handle("stat-beta", () => {
        throw new Error("stat failure");
      });
    for (let index = 0; index < 3; index += 1) await worker.runOnce();

    // Roll up as if the minute holding this work had already closed.
    const later = new Date(Date.now() + 120_000);
    const first = await queue.rollupStatistics({ now: later });
    expect(first.map(({ phase }) => phase)).toEqual(["stat_rollup", "stat_retention"]);
    expect(first.every(({ error }) => error === null)).toBe(true);

    expect(await stored()).toEqual([
      {
        task_type: "stat-alpha",
        enqueued: 2,
        task_succeeded: 2,
        attempt_succeeded: 2,
        attempt_retry: 0,
        last_error: null,
      },
      {
        task_type: "stat-beta",
        enqueued: 1,
        task_succeeded: 0,
        attempt_succeeded: 0,
        attempt_retry: 1,
        last_error: "stat failure",
      },
    ]);

    // A bucket is a pure function of the history in its minute, so rerunning the pass rewrites the
    // same numbers rather than adding to them.
    const before = await stored();
    await queue.rollupStatistics({ force: true, now: later });
    await queue.rollupStatistics({ force: true, now: later });
    expect(await stored()).toEqual(before);
  });

  it("rate limits the statistics rollup on the policy cadence and lets zero opt out", async () => {
    const later = new Date(Date.now() + 120_000);
    const first = await queue.rollupStatistics({ now: later });
    expect(first.map(({ phase }) => phase)).toEqual(["stat_rollup", "stat_retention"]);

    // Within the policy interval the pass returns without work rather than rewriting buckets.
    const gated = await queue.rollupStatistics({ now: later });
    expect(gated).toEqual([]);

    // Past the interval the pass runs again.
    const dueAgain = await queue.rollupStatistics({ now: new Date(later.getTime() + 61_000) });
    expect(dueAgain.map(({ phase }) => phase)).toEqual(["stat_rollup", "stat_retention"]);

    // A zero interval opts the fleet out; force still runs an explicit operator pass.
    await queue.overrideMaintenancePolicy({ statisticsRollupIntervalMs: 0 });
    const disabled = await queue.rollupStatistics({ now: new Date(later.getTime() + 300_000) });
    expect(disabled).toEqual([]);
    const forced = await queue.rollupStatistics({
      force: true,
      now: new Date(later.getTime() + 300_000),
    });
    expect(forced.map(({ phase }) => phase)).toEqual(["stat_rollup", "stat_retention"]);
  });

  it("keeps operator statistics-cadence overrides while sync updates application defaults", async () => {
    await queue.overrideMaintenancePolicy({
      statisticsRollupIntervalMs: 120_000,
      statisticsRecomputeBuckets: 10,
    });
    await queue.syncMaintenancePolicy({
      timezone: "UTC",
      statisticsRollupIntervalMs: 30_000,
      statisticsGroupLimit: 500,
      statisticsRecomputeBuckets: 5,
    });
    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      statisticsRollupIntervalMs: 120_000,
      statisticsGroupLimit: 500,
      statisticsRecomputeBuckets: 10,
      provenance: {
        statisticsRollupIntervalMs: { source: "operator", applicationDefault: 30_000 },
        statisticsGroupLimit: { source: "application", applicationDefault: 500 },
        statisticsRecomputeBuckets: { source: "operator", applicationDefault: 5 },
      },
    });

    await queue.revertMaintenancePolicy([
      "statisticsRollupIntervalMs",
      "statisticsRecomputeBuckets",
    ]);
    await expect(queue.getMaintenancePolicy()).resolves.toMatchObject({
      statisticsRollupIntervalMs: 30_000,
      statisticsRecomputeBuckets: 5,
      provenance: {
        statisticsRollupIntervalMs: { source: "application", applicationDefault: 30_000 },
      },
    });
  });

  it("stitches materialized buckets to a live tail so a window covers unrolled minutes", async () => {
    await queue.enqueue("stat-tail", {});
    await queue.tick();

    const window = async () =>
      (
        await pool.query<{ enqueued: number }>(
          `SELECT COALESCE(sum(enqueued), 0)::integer AS enqueued
             FROM workhorse.stat_buckets_v1(
               date_bin('1 minute', clock_timestamp(),
                 timestamp '2000-01-01' AT TIME ZONE 'UTC') - interval '1 hour',
               clock_timestamp()
             )`,
        )
      ).rows[0]!.enqueued;

    // Nothing is materialized yet: the window is derived entirely from raw history.
    expect(
      (await pool.query<{ count: string }>("SELECT count(*) FROM workhorse.task_stat_bucket"))
        .rows[0]?.count,
    ).toBe("0");
    expect(await window()).toBe(1);

    await queue.rollupStatistics({ now: new Date(Date.now() + 120_000) });
    expect(
      (await pool.query<{ count: string }>("SELECT count(*) FROM workhorse.task_stat_bucket"))
        .rows[0]?.count,
    ).not.toBe("0");
    // The same window now reads a materialized bucket and still reports the same total.
    expect(await window()).toBe(1);
  });

  it("derives hourly and daily tiers and reads mergeable wait percentiles from them", async () => {
    const taskId = await queue.enqueue("stat-tiered", {});
    const claimed = await queue.claim("stat-tiered-worker");
    expect(claimed?.id).toBe(taskId);

    await pool.query(
      `UPDATE workhorse.task_event
          SET occurred_at = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '1 hour 5 minutes'
        WHERE task_id = $1 AND event_type = 'enqueued'`,
      [taskId],
    );
    await pool.query(
      `UPDATE workhorse.task_event
          SET occurred_at = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '1 hour 15 minutes'
        WHERE task_id = $1 AND event_type = 'claimed'`,
      [taskId],
    );
    await pool.query(
      `UPDATE workhorse.task_stat_state
          SET rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '1 hour',
              hourly_rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '1 hour',
              daily_rolled_up_through = date_bin('1 day', clock_timestamp(),
                timestamp '2000-01-01' AT TIME ZONE 'UTC')`,
    );

    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    const result = await queue.rollupStatistics({
      force: true,
      now: tomorrow,
      maxBuckets: 2 * 24 * 60,
    });
    expect(result.every(({ error }) => error === null)).toBe(true);

    const tiers = await pool.query<{ minutes: string; hours: string; days: string }>(
      `SELECT (SELECT count(*) FROM workhorse.task_stat_bucket) AS minutes,
              (SELECT count(*) FROM workhorse.task_stat_bucket_hour) AS hours,
              (SELECT count(*) FROM workhorse.task_stat_bucket_day) AS days`,
    );
    expect(Number(tiers.rows[0]!.minutes)).toBeGreaterThan(0);
    expect(Number(tiers.rows[0]!.hours)).toBeGreaterThan(0);
    expect(Number(tiers.rows[0]!.days)).toBeGreaterThan(0);

    const percentile = await pool.query<{ p50_ms: number | null }>(
      `SELECT workhorse.stat_sketch_percentile_v1(
                workhorse.stat_sketch_merge_v1(array_agg(stat.wait_sketch)), 0.50
              ) AS p50_ms
         FROM workhorse.stat_buckets_v1(
           date_bin('1 day', clock_timestamp(), timestamp '2000-01-01' AT TIME ZONE 'UTC'),
           $1::timestamptz
         ) stat`,
      [tomorrow],
    );
    expect(percentile.rows[0]!.p50_ms).toBeGreaterThanOrEqual(590_000);
    expect(percentile.rows[0]!.p50_ms).toBeLessThanOrEqual(610_000);

    await expect(
      pool.query(
        `SELECT * FROM workhorse.stat_buckets_v1(
           clock_timestamp() - interval '30 days', clock_timestamp()
         )`,
      ),
    ).rejects.toThrow("hour-aligned lower bound");
  });

  it("counts every hour once in a long window that crosses daylight saving in the session TimeZone", async () => {
    // 1 January to 15 April 2026 05:00Z crosses the 8 March transition in America/New_York.
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-04-15T05:00:00Z");
    const hours = (to.getTime() - from.getTime()) / 3_600_000;
    // Both tiers hold the whole window, so a boundary an hour off would drop or repeat an hour.
    await pool.query(
      `INSERT INTO workhorse.task_stat_bucket_hour(bucket_start, queue_name, task_type, enqueued)
       SELECT hour, 'default', 'stat-dst', 1
         FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 hour', interval '1 hour') hour`,
      [from, to],
    );
    await pool.query(
      `INSERT INTO workhorse.task_stat_bucket_day(bucket_start, queue_name, task_type, enqueued)
       SELECT day, 'default', 'stat-dst', 24
         FROM generate_series($1::timestamptz, $2::timestamptz, interval '24 hours') day`,
      [from, to],
    );

    const client = await pool.connect();
    try {
      await client.query("SET TimeZone = 'America/New_York'");
      const total = await client.query<{ enqueued: number }>(
        `SELECT COALESCE(sum(enqueued), 0)::integer AS enqueued
           FROM workhorse.stat_buckets_v1($1, $2) WHERE task_type = 'stat-dst'`,
        [from, to],
      );
      expect(total.rows[0]!.enqueued).toBe(hours);
    } finally {
      await client.query("RESET TimeZone");
      client.release();
    }
  });

  it("folds statistics beyond the group limit into an overflow type instead of growing unbounded", async () => {
    const taskIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      taskIds.push(await queue.enqueue(`stat-type-${index}`, {}));
    }
    // The group limit applies to each bucket. If the enqueues cross a minute boundary, each bucket
    // stays under the limit and nothing folds. One event time keeps all five in one bucket.
    await pool.query(
      `UPDATE workhorse.task_event
          SET occurred_at = (SELECT min(occurred_at) FROM workhorse.task_event
                              WHERE task_id = ANY($1::uuid[]))
        WHERE task_id = ANY($1::uuid[])`,
      [taskIds],
    );
    await queue.overrideMaintenancePolicy({ statisticsGroupLimit: 2 });
    await queue.rollupStatistics({ now: new Date(Date.now() + 120_000) });
    const rows = await pool.query<{ task_type: string; enqueued: number }>(
      `SELECT task_type, sum(enqueued)::integer AS enqueued
         FROM workhorse.task_stat_bucket GROUP BY task_type ORDER BY task_type`,
    );
    expect(rows.rows).toHaveLength(3);
    const overflow = rows.rows.find((row) => row.task_type === "__other__");
    expect(overflow?.enqueued).toBe(3);
    expect(rows.rows.reduce((total, row) => total + row.enqueued, 0)).toBe(5);
  });

  it("prunes statistics buckets on their own policy, bounded per pass", async () => {
    const taskId = await queue.enqueue("stat-prune", {});
    await queue.tick();
    // The rollup runs in the first minutes of the enqueue's UTC day, so it cannot close that day.
    // If the rollup used the wall clock near UTC midnight, it could close the day. It would then
    // write the day bucket that this test inserts below.
    const dayStart = (
      await pool.query<{ at: Date }>(
        `UPDATE workhorse.task_event
            SET occurred_at = date_bin('1 day', occurred_at,
                  timestamp '2000-01-01' AT TIME ZONE 'UTC')
          WHERE task_id = $1 AND event_type = 'enqueued'
          RETURNING occurred_at AS at`,
        [taskId],
      )
    ).rows[0]!.at;
    await pool.query(
      `UPDATE workhorse.task_stat_state
          SET rolled_up_through = $1, hourly_rolled_up_through = $1, daily_rolled_up_through = $1`,
      [dayStart],
    );
    await queue.rollupStatistics({ now: new Date(dayStart.getTime() + 120_000) });
    await pool.query(
      `INSERT INTO workhorse.task_stat_bucket_day (bucket_start, queue_name, task_type, enqueued)
       SELECT date_bin('1 day', bucket_start, timestamp '2000-01-01' AT TIME ZONE 'UTC'),
              queue_name, task_type, sum(enqueued)
         FROM workhorse.task_stat_bucket
        GROUP BY 1, 2, 3`,
    );
    // The event ages with its buckets. Otherwise the recompute window of a later rollup starts at
    // the event's minute and writes its buckets again inside the retention window.
    await pool.query(
      "UPDATE workhorse.task_event SET occurred_at = occurred_at - interval '30 days' WHERE task_id = $1",
      [taskId],
    );
    await pool.query(
      "UPDATE workhorse.task_stat_bucket SET bucket_start = bucket_start - interval '30 days'",
    );
    await pool.query(
      "UPDATE workhorse.task_stat_bucket_hour SET bucket_start = bucket_start - interval '30 days'",
    );
    await pool.query(
      "UPDATE workhorse.task_stat_bucket_day SET bucket_start = bucket_start - interval '30 days'",
    );

    const storedBuckets = async () =>
      Number(
        (
          await pool.query<{ count: string }>(
            `SELECT sum(count)::text AS count FROM (
               SELECT count(*) FROM workhorse.task_stat_bucket
               UNION ALL SELECT count(*) FROM workhorse.task_stat_bucket_hour
               UNION ALL SELECT count(*) FROM workhorse.task_stat_bucket_day
             ) tiers`,
          )
        ).rows[0]!.count,
      );

    // Statistics deliberately sit outside the identity chain: aggregates may outlive the history
    // they were derived from, so a long statistics window with short history retention is legal.
    await queue.syncRetentionPolicy({ ...defaultRetentionPolicy, statisticsRetentionDays: 365 });
    await queue.rollupStatistics({ force: true, now: new Date() });
    expect(await storedBuckets()).toBeGreaterThan(0);

    await queue.syncRetentionPolicy({ ...defaultRetentionPolicy, statisticsRetentionDays: 1 });
    const pruned = await queue.rollupStatistics({ force: true, now: new Date() });
    expect(pruned.find((phase) => phase.phase === "stat_retention")?.rowsAffected).toBeGreaterThan(
      0,
    );
    expect(await storedBuckets()).toBe(0);
  });

  it("bounds statistics pruning by the configured rows per pass", async () => {
    await pool.query(
      `INSERT INTO workhorse.task_stat_bucket (bucket_start, queue_name, task_type, enqueued)
       SELECT clock_timestamp() - make_interval(days => 30, mins => i), 'default', 'bulk', 1
         FROM generate_series(1, 5) i`,
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      statisticsRetentionDays: 1,
      statisticsRowsPerPass: 2,
    });
    const first = await queue.rollupStatistics({ now: new Date() });
    expect(first.find((phase) => phase.phase === "stat_retention")?.rowsAffected).toBe(2);
    expect(
      Number(
        (await pool.query<{ count: string }>("SELECT count(*) FROM workhorse.task_stat_bucket"))
          .rows[0]!.count,
      ),
    ).toBe(3);
  });

  it("reports rollup progress through health", async () => {
    const behind = await queue.health();
    expect(behind.statistics.lastRunAt).toBeNull();
    const now = new Date();
    await queue.rollupStatistics({ now });
    const caught = await queue.health();
    expect(caught.statistics.lastRunAt).not.toBeNull();
    expect(caught.statistics.lagMs).toBeLessThan(120_000);
    expect(caught.statistics.rolledUpThrough.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(caught.statistics.buckets).toBe(0);
  });

  it("reports history size with daily partitions folded into their parent", async () => {
    await queue.enqueue("stat-size", {});
    const health = await queue.health();
    const events = health.observations.relations.find(
      (relation) => relation.relation === "task_event",
    );
    // The partitioned parent owns no storage itself, so an unaggregated reading is always zero.
    expect(events?.partitions).toBeGreaterThan(0);
    expect(events?.totalBytes).toBeGreaterThan(0);
    const buckets = health.observations.relations.find(
      (relation) => relation.relation === "task_stat_bucket",
    );
    expect(buckets?.partitions).toBe(0);
  });

  it("refuses to delete raw history past the rollup watermark", async () => {
    await queue.enqueue("stat-retention", {});
    await queue.tick();
    // Hold the watermark far in the past, as a stalled rollup would.
    await pool.query(
      `UPDATE workhorse.task_stat_state
          SET rolled_up_through = clock_timestamp() - interval '30 days'`,
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
    });
    await pool.query(
      `UPDATE workhorse.task_event SET occurred_at = clock_timestamp() - interval '10 days'`,
    );

    await queue.retainHistory({ force: true });
    const retained = await pool.query<{ count: string }>(
      "SELECT count(*) FROM workhorse.task_event",
    );
    // The cutoff was clamped to the watermark, so history older than the policy survives the pass.
    expect(Number(retained.rows[0]!.count)).toBeGreaterThan(0);

    await pool.query(
      `UPDATE workhorse.task_stat_state
          SET rolled_up_through = date_bin('1 minute', clock_timestamp(),
            timestamp '2000-01-01' AT TIME ZONE 'UTC')`,
    );
    await queue.retainHistory({ force: true });
    const pruned = await pool.query<{ count: string }>("SELECT count(*) FROM workhorse.task_event");
    expect(Number(pruned.rows[0]!.count)).toBeLessThan(Number(retained.rows[0]!.count));
  });

  it.each([
    {
      end: "at H:17",
      t0: "date_trunc('hour', clock_timestamp() - interval '3 days') + interval '17 minutes'",
    },
    { end: "at H:00", t0: "date_trunc('hour', clock_timestamp() - interval '3 days')" },
    {
      end: "at H:01",
      t0: "date_trunc('hour', clock_timestamp() - interval '3 days') + interval '1 minute'",
    },
    {
      end: "at UTC midnight",
      t0: "date_trunc('day', (clock_timestamp() - interval '72 hours') AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '20 hours'",
    },
    {
      end: "one minute after UTC midnight",
      t0: "date_trunc('day', (clock_timestamp() - interval '72 hours') AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '20 hours 1 minute'",
    },
  ])(
    "keeps each statistics bucket that a catch-up pass ending $end still needs",
    async ({ t0: t0Sql }) => {
      // 300 enqueued events, one for each minute from t0 three days ago, and a rollup that stopped
      // two minutes after the first one. The first pass of 240 minutes ends four hours after t0.
      const start = await pool.query<{ t0: Date }>(`SELECT ${t0Sql} AS t0`);
      const t0 = start.rows[0]!.t0;
      await pool.query(
        `SELECT count(*) FROM workhorse.enqueue_many_v1((
         SELECT jsonb_agg(jsonb_build_object('queue', 'stat-catch-up', 'type', 'stat',
                                             'payload', '{}'::jsonb))
           FROM generate_series(1, 300)))`,
      );
      await pool.query(
        `WITH numbered AS (
         SELECT event.event_id, event.occurred_at AS old_at,
                row_number() OVER (ORDER BY event.event_id) - 1 AS n
           FROM workhorse.task_event event
           JOIN workhorse.task task ON task.id = event.task_id
          WHERE task.queue_name = 'stat-catch-up' AND event.event_type = 'enqueued')
       UPDATE workhorse.task_event event
          SET occurred_at = $1::timestamptz + make_interval(mins => numbered.n::integer)
         FROM numbered
        WHERE event.event_id = numbered.event_id AND event.occurred_at = numbered.old_at`,
        [t0],
      );
      await pool.query(
        `UPDATE workhorse.task_stat_state
          SET rolled_up_through = $1::timestamptz + interval '2 minutes',
              hourly_rolled_up_through = date_trunc('hour', $1::timestamptz),
              daily_rolled_up_through = date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC')
                AT TIME ZONE 'UTC',
              last_run_at = $1::timestamptz + interval '2 minutes'`,
        [t0],
      );
      await pool.query(
        `DELETE FROM workhorse.task_stat_bucket;
       DELETE FROM workhorse.task_stat_bucket_hour;
       DELETE FROM workhorse.task_stat_bucket_day;`,
      );

      // Catch up as run_maintenance_v1 does: passes of 240 minutes at the real clock.
      for (let pass = 0; pass < 30; pass += 1) {
        const rows = await pool.query<{ error: unknown }>(
          "SELECT * FROM workhorse.rollup_stats_v1(true, clock_timestamp(), 240)",
        );
        expect(rows.rows.map(({ error }) => error)).toEqual([null, null]);
        const caughtUp = await pool.query<{ caught_up: boolean }>(
          `SELECT rolled_up_through >= date_bin('1 minute', clock_timestamp(),
                  timestamp '2000-01-01' AT TIME ZONE 'UTC') - interval '1 minute' AS caught_up
           FROM workhorse.task_stat_state WHERE singleton`,
        );
        if (caughtUp.rows[0]!.caught_up) break;
      }

      const hours = await pool.query<{ enqueued: number }>(
        `SELECT COALESCE(sum(enqueued), 0)::integer AS enqueued
         FROM workhorse.task_stat_bucket_hour WHERE queue_name = 'stat-catch-up'`,
      );
      expect(hours.rows[0]!.enqueued).toBe(300);
      // Each complete day holds the raw count of that day.
      const days = await pool.query<{ day: Date; tier: number; raw: number }>(
        `WITH raw AS (
         SELECT date_bin('1 day', event.occurred_at, timestamp '2000-01-01' AT TIME ZONE 'UTC') AS day,
                count(*)::integer AS raw
           FROM workhorse.task_event event
           JOIN workhorse.task task ON task.id = event.task_id
          WHERE task.queue_name = 'stat-catch-up' AND event.event_type = 'enqueued'
          GROUP BY 1)
       SELECT raw.day, COALESCE(sum(bucket.enqueued), 0)::integer AS tier, raw.raw
         FROM raw
         LEFT JOIN workhorse.task_stat_bucket_day bucket
           ON bucket.bucket_start = raw.day AND bucket.queue_name = 'stat-catch-up'
        WHERE raw.day < (SELECT daily_rolled_up_through FROM workhorse.task_stat_state)
        GROUP BY raw.day, raw.raw
        ORDER BY raw.day`,
      );
      expect(days.rows.length).toBeGreaterThan(0);
      for (const row of days.rows) expect(row.tier).toBe(row.raw);
    },
  );

  it.each([
    { hold: "the rollup watermark", exportHold: false },
    { hold: "the cold export watermark", exportHold: true },
  ])(
    "records a pass that $hold holds back as incomplete and keeps it due",
    async ({ exportHold }) => {
      await queue.syncMaintenancePolicy(
        { timezone: "UTC", historyRetentionLocalTime: "00:00" },
        { force: true },
      );
      await queue.syncRetentionPolicy(defaultRetentionPolicy);
      const day = await pool.query<{ partition: string; today: string }>(
        `SELECT 'task_event_' || to_char(((clock_timestamp() AT TIME ZONE 'UTC')::date - 16)::timestamp,
                                         'YYYYMMDD') AS partition,
                ((clock_timestamp() AT TIME ZONE 'UTC')::date)::text AS today`,
      );
      const { partition, today } = day.rows[0]!;
      await pool.query(
        "SELECT workhorse.create_history_day_v1((clock_timestamp() AT TIME ZONE 'UTC')::date - 16)",
      );
      // A fixed 480 hours keeps a UTC midnight in a session TimeZone with daylight saving.
      const twentyDaysAgo =
        "date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '480 hours'";
      if (exportHold) {
        await queue.setColdExportPolicy({ enabled: true });
        await pool.query(
          `UPDATE workhorse.cold_export_dataset SET exported_through = ${twentyDaysAgo}`,
        );
      } else {
        await pool.query(
          `UPDATE workhorse.task_stat_state
              SET rolled_up_through = ${twentyDaysAgo},
                  hourly_rolled_up_through = ${twentyDaysAgo},
                  daily_rolled_up_through = ${twentyDaysAgo}`,
        );
      }
      const lastRun = async () =>
        (
          await pool.query<{ outcome: string; last_completed_local_date: string | null }>(
            `SELECT run.outcome, state.last_completed_local_date::text AS last_completed_local_date
               FROM workhorse.maintenance_run run
               CROSS JOIN workhorse.maintenance_state state
              WHERE run.routine_name = 'history_retention'
                AND state.routine_name = 'history_retention'
              ORDER BY run.started_at DESC, run.run_id DESC LIMIT 1`,
          )
        ).rows[0];
      const partitionExists = async () =>
        (
          await pool.query<{ present: boolean }>(
            "SELECT to_regclass('workhorse.' || $1::text) IS NOT NULL AS present",
            [partition],
          )
        ).rows[0]!.present;
      const before = await pool.query<{ last_completed_local_date: string | null }>(
        `SELECT last_completed_local_date::text AS last_completed_local_date
           FROM workhorse.maintenance_state WHERE routine_name = 'history_retention'`,
      );

      expect(await queue.retainHistory({ force: true })).toHaveLength(3);
      expect(await lastRun()).toEqual({
        outcome: "incomplete",
        last_completed_local_date: before.rows[0]!.last_completed_local_date,
      });
      expect(await partitionExists()).toBe(true);
      // The held pass stays due, so the next offer on the same local date runs it again.
      expect(await queue.retainHistory()).toHaveLength(3);
      expect((await lastRun())?.outcome).toBe("incomplete");

      // The hold ends, and the next offer drops the expired partition and completes.
      if (exportHold) {
        await pool.query(
          `UPDATE workhorse.cold_export_dataset
              SET exported_through = date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC')
                AT TIME ZONE 'UTC'`,
        );
      } else {
        await pool.query(
          `UPDATE workhorse.task_stat_state
              SET rolled_up_through = date_bin('1 minute', clock_timestamp(),
                    timestamp '2000-01-01' AT TIME ZONE 'UTC')`,
        );
      }
      expect(await queue.retainHistory()).toHaveLength(3);
      expect(await partitionExists()).toBe(false);
      expect(await lastRun()).toEqual({ outcome: "succeeded", last_completed_local_date: today });
      expect(await queue.retainHistory()).toEqual([]);
    },
  );

  it("round trips retention policy defaults and rejects unsafe or malformed policies in PostgreSQL", async () => {
    await expect(queue.getRetentionPolicy()).resolves.toMatchObject(defaultRetentionPolicy);

    const definition: RetentionPolicyDefinition = {
      taskIdentityRetentionDays: 90,
      terminalOutcomeRetentionDays: 60,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 45,
      scheduleOccurrenceRetentionDays: 14,
      statisticsRetentionDays: 120,
      terminalTaskPruneLimit: 17,
      historyPartitionsPerPass: 2,
      defaultPartitionRowsPerPass: 23,
      occurrenceRowsPerPass: 29,
      statisticsRowsPerPass: 31,
    };
    const persisted = await queue.syncRetentionPolicy(definition);
    expect(persisted).toMatchObject({
      ...definition,
      provenance: {
        taskIdentityRetentionDays: { source: "application", applicationDefault: 90 },
        taskEventRetentionDays: { source: "application", applicationDefault: 30 },
      },
      updatedAt: expect.any(Date),
    });
    await expect(queue.getRetentionPolicy()).resolves.toEqual(persisted);

    await expect(
      queue.syncRetentionPolicy({
        ...definition,
        taskIdentityRetentionDays: 10,
        taskEventRetentionDays: 11,
      }),
    ).rejects.toThrow(/retention_policy_check/);
    await expect(
      queue.syncRetentionPolicy({
        ...definition,
        taskIdentityRetentionDays: null,
      }),
    ).rejects.toThrow(/retention_policy_check/);
    await expect(
      pool.query(
        `UPDATE workhorse.retention_policy
            SET task_identity_retention_days = 30,
                terminal_outcome_retention_days = NULL
          WHERE singleton`,
      ),
    ).rejects.toThrow(/retention_policy_check/);
    await expect(
      queue.syncRetentionPolicy({ ...definition, historyPartitionsPerPass: 0 }),
    ).rejects.toThrow(/history_partitions_per_pass/);

    const withoutLimits = await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: null,
      terminalOutcomeRetentionDays: null,
      taskEventRetentionDays: null,
      attemptHistoryRetentionDays: null,
      scheduleOccurrenceRetentionDays: 30,
      statisticsRetentionDays: null,
    });
    expect(withoutLimits).toMatchObject({
      terminalTaskPruneLimit: definition.terminalTaskPruneLimit,
      historyPartitionsPerPass: definition.historyPartitionsPerPass,
      defaultPartitionRowsPerPass: definition.defaultPartitionRowsPerPass,
      occurrenceRowsPerPass: definition.occurrenceRowsPerPass,
    });

    await queue.syncRetentionPolicy({
      ...withoutLimits,
      occurrenceRowsPerPass: 1_000_000,
    });
    await expect(
      pool.query("SELECT workhorse.prune_schedule_occurrences_v1(clock_timestamp(), 1000000)"),
    ).resolves.toMatchObject({ rows: [{ prune_schedule_occurrences_v1: 0 }] });
  });

  it("synchronizes queue-scoped concurrency policies as desired state", async () => {
    const policies = await queue.syncConcurrencyPolicies("deployment-a", [
      { queue: "mail", maxActive: 8, maxActivePerKey: 2 },
      { queue: "reports", maxActive: 3 },
    ]);
    expect(policies).toEqual([
      {
        namespace: "deployment-a",
        queue: "mail",
        maxActive: 8,
        maxActivePerKey: 2,
        updatedAt: expect.any(Date),
      },
      {
        namespace: "deployment-a",
        queue: "reports",
        maxActive: 3,
        maxActivePerKey: null,
        updatedAt: expect.any(Date),
      },
    ]);

    await expect(
      queue.syncConcurrencyPolicies("deployment-a", [
        { queue: "mail", maxActive: 1, maxActivePerKey: 2 },
      ]),
    ).rejects.toThrow(/max_active_per_key/);
    await expect(
      queue.syncConcurrencyPolicies("deployment-b", [{ queue: "mail", maxActive: 4 }]),
    ).rejects.toThrow(/owned by another namespace/);

    await queue.syncConcurrencyPolicies("deployment-a", [{ queue: "mail", maxActive: 5 }]);
    await expect(queue.listConcurrencyPolicies()).resolves.toMatchObject([
      { queue: "mail", maxActive: 5, maxActivePerKey: null },
    ]);
    // The deprecated alias stays for the rest of 0.x and reads through the new method.
    await expect(queue.concurrencyPolicies()).resolves.toEqual(
      await queue.listConcurrencyPolicies(),
    );
  });

  it("reports bounded concurrency utilization and blocked-ready depth through health", async () => {
    const queueName = `health-concurrency-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("health-test", [
      { queue: queueName, maxActive: 1, maxActivePerKey: 1 },
    ]);
    await queue.enqueue("health-concurrency", {}, { queue: queueName, concurrencyKey: "tenant" });
    await queue.enqueue("health-concurrency", {}, { queue: queueName, concurrencyKey: "tenant" });
    await queue.claim("health-concurrency-worker", { queue: queueName });

    const health = await queue.health();
    expect(health.concurrencyPolicies).toMatchObject({
      capped: false,
      policies: [
        {
          namespace: "health-test",
          queue: queueName,
          maxActive: 1,
          active: 1,
          available: 0,
          blockedReady: 1,
          maxActivePerKey: 1,
          saturatedKeys: 1,
          highestKeyActive: 1,
        },
      ],
    });
    await expect(queue.queueMetricSnapshot()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queue: queueName,
          concurrencyLimit: 1,
          concurrencyActive: 1,
          blockedReadyDepth: 1,
        }),
      ]),
    );
  });

  it("excludes keyless capacity from the highest keyed utilization summary", async () => {
    const queueName = `health-keyless-concurrency-${randomUUID()}`;
    await queue.syncConcurrencyPolicies("health-keyless-test", [
      { queue: queueName, maxActive: 3, maxActivePerKey: 2 },
    ]);
    await queue.enqueue("health-concurrency", {}, { queue: queueName });
    await queue.enqueue("health-concurrency", {}, { queue: queueName });
    await queue.enqueue("health-concurrency", {}, { queue: queueName, concurrencyKey: "tenant" });
    await queue.claim("health-keyless-a", { queue: queueName });
    await queue.claim("health-keyless-b", { queue: queueName });
    await queue.claim("health-keyed", { queue: queueName });

    expect((await queue.health()).concurrencyPolicies.policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queue: queueName, active: 3, highestKeyActive: 1 }),
      ]),
    );
  });

  it("preserves daily completion on identical retention policy sync and invalidates changed windows", async () => {
    await pool.query(`
      UPDATE workhorse.maintenance_state
         SET last_completed_local_date = '2026-08-02'
       WHERE routine_name = 'history_retention'`);

    await queue.syncRetentionPolicy(defaultRetentionPolicy);
    expect(
      (
        await pool.query<{ completed: string | null }>(`
          SELECT last_completed_local_date::text AS completed
            FROM workhorse.maintenance_state
           WHERE routine_name = 'history_retention'`)
      ).rows[0]?.completed,
    ).toBe("2026-08-02");

    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      scheduleOccurrenceRetentionDays: 13,
    });
    expect(
      (
        await pool.query<{ completed: string | null }>(`
          SELECT last_completed_local_date::text AS completed
            FROM workhorse.maintenance_state
           WHERE routine_name = 'history_retention'`)
      ).rows[0]?.completed,
    ).toBeNull();
  });

  it("retires event and attempt partitions independently and bounds partition/default work", async () => {
    const firstDay = "2018-01-01";
    const secondDay = "2018-01-02";
    for (const day of [firstDay, secondDay]) {
      await pool.query("SELECT workhorse.retire_history_day_v1($1)", [day]);
      await pool.query("SELECT workhorse.create_history_day_v1($1)", [day]);
    }
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 36_500,
      terminalOutcomeRetentionDays: 36_500,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 36_500,
      scheduleOccurrenceRetentionDays: 36_500,
      historyPartitionsPerPass: 1,
    });

    const firstPass = await queue.retainHistory({ force: true });
    expect(firstPass[0]).toMatchObject({
      phase: "event_retention",
      rowsAffected: 1,
      error: null,
    });
    expect(firstPass[1]).toMatchObject({
      phase: "attempt_retention",
      rowsAffected: 0,
      error: null,
    });
    expect(
      (
        await pool.query(
          `SELECT to_regclass('workhorse.task_event_20180101') AS first_event,
                  to_regclass('workhorse.task_event_20180102') AS second_event,
                  to_regclass('workhorse.attempt_history_20180101') AS first_attempt,
                  to_regclass('workhorse.attempt_history_20180102') AS second_attempt`,
        )
      ).rows[0],
    ).toEqual({
      first_event: null,
      second_event: "task_event_20180102",
      first_attempt: "attempt_history_20180101",
      second_attempt: "attempt_history_20180102",
    });

    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
        SELECT 'default', 'old-event', '{}'::jsonb, 1, '2017-01-01'::timestamptz
          FROM generate_series(1, 3)
        RETURNING id
      )
      INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
      SELECT id, 'old-default', '2017-01-01'::timestamptz FROM identities`);
    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
        SELECT 'default', 'old-attempt', '{}'::jsonb, 1, '2017-01-01'::timestamptz
          FROM generate_series(1, 3)
        RETURNING id
      )
      INSERT INTO workhorse.attempt_history(
        task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, occurred_at
      )
      SELECT id, 1, 1, 'retention-worker', 'succeeded',
             '2017-01-01'::timestamptz, '2017-01-01'::timestamptz, '2017-01-01'::timestamptz
        FROM identities`);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      historyPartitionsPerPass: 1,
      defaultPartitionRowsPerPass: 2,
    });
    const boundedPass = await queue.retainHistory({ force: true });
    expect(boundedPass[0]).toMatchObject({ phase: "event_retention", rowsAffected: 3 });
    expect(boundedPass[1]).toMatchObject({ phase: "attempt_retention", rowsAffected: 3 });
    expect(
      (
        await pool.query(`SELECT
          (SELECT count(*)::integer FROM workhorse.task_event_default) AS events,
          (SELECT count(*)::integer FROM workhorse.attempt_history_default) AS attempts`)
      ).rows[0],
    ).toEqual({ events: 1, attempts: 1 });
  });

  it("deletes only safely unattributed terminal tasks and never live tasks", async () => {
    const finish = async (type: string) => {
      const id = await queue.enqueue(type, {});
      const task = await queue.claim("retention-worker");
      expect(task?.id).toBe(id);
      expect(await queue.complete(task!, "retention-worker", { done: true })).toBe(true);
      await pool.query(
        `UPDATE workhorse.task
            SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.task_event
            SET occurred_at = clock_timestamp() - interval '40 days' WHERE task_id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.attempt_history
            SET started_at = clock_timestamp() - interval '40 days',
                claimed_at = clock_timestamp() - interval '40 days',
                finished_at = clock_timestamp() - interval '40 days',
                occurred_at = clock_timestamp() - interval '40 days'
          WHERE task_id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.task_outcome
            SET finished_at = clock_timestamp() - interval '40 days',
                history_through_at = clock_timestamp() - interval '40 days'
          WHERE task_id = $1`,
        [id],
      );
      return id;
    };

    const deletable = await finish("deletable");
    const secondDeletable = await finish("second-deletable");
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '39 days' WHERE task_id = $1`,
      [secondDeletable],
    );
    const eventGuard = await finish("event-guard");
    const attemptGuard = await finish("attempt-guard");
    const occurrenceGuard = await finish("occurrence-guard");
    const recentOutcome = await finish("recent-outcome");
    const live = await queue.enqueue("live", {});
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
      [live],
    );

    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [
      [deletable, secondDeletable, attemptGuard, occurrenceGuard, recentOutcome],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      [deletable, secondDeletable, eventGuard, occurrenceGuard, recentOutcome],
    ]);
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, event_type) VALUES ($1, 'late-retained')`,
      [eventGuard],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at
       ) VALUES ($1, 2, 2, 'late-retention-worker', 'succeeded', clock_timestamp(), clock_timestamp())`,
      [attemptGuard],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome SET finished_at = clock_timestamp() WHERE task_id = $1`,
      [recentOutcome],
    );
    await pool.query(
      `INSERT INTO workhorse.task_checkpoint(
         task_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id
       ) VALUES ($1, 'retained-until-delete', '{}'::jsonb, 1, 1, 'retention-worker')`,
      [deletable],
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
       ) VALUES ('retention', 'guard', '0 * * * *', 'default', 'guard', '{}'::jsonb, 1)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at, task_id)
       VALUES ('retention', 'guard', clock_timestamp(), $1)`,
      [occurrenceGuard],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalTaskPruneLimit: 1,
    });
    expect(await queue.retainHistory({ force: true })).toHaveLength(3);

    // One batch of one deletes the oldest eligible identity first.
    expect(
      (
        await pool.query<{ pruned: number }>(
          `SELECT workhorse.prune_terminal_tasks_v1(
                    clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
                    history_retained_before, 1) AS pruned
             FROM workhorse.maintenance_state WHERE routine_name = 'history_retention'`,
        )
      ).rows[0]?.pruned,
    ).toBe(1);
    expect(await admin.getTask(deletable)).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.task_checkpoint WHERE task_id = $1",
          [deletable],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(await admin.getTask(secondDeletable)).not.toBeNull();
    expect(
      (await queue.pruneTerminalStorage({ force: true })).find(
        ({ phase }) => phase === "terminal_tasks",
      ),
    ).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 1,
      error: null,
    });
    expect(await admin.getTask(secondDeletable)).toBeNull();
    for (const retained of [eventGuard, attemptGuard, occurrenceGuard, recentOutcome, live]) {
      expect(await admin.getTask(retained)).not.toBeNull();
    }
  });

  it("cleans expired enqueue keys before terminal identity pruning in the same pass", async () => {
    const finishKeyed = async (key: string, ttlMs: number) => {
      const id = await queue.enqueue(
        "idempotency-retention",
        {},
        {
          idempotency: { key, ttlMs },
        },
      );
      const task = await queue.claim(`retention-${key}`);
      expect(task?.id).toBe(id);
      expect(await queue.complete(task!, `retention-${key}`, { done: true })).toBe(true);
      await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [id]);
      await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [id]);
      await pool.query(
        `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.task_outcome
            SET finished_at = clock_timestamp() - interval '40 days',
                history_through_at = clock_timestamp() - interval '40 days'
          WHERE task_id = $1`,
        [id],
      );
      return id;
    };

    const expired = await finishKeyed("expired-cleanup", 5);
    const retained = await finishKeyed("retained-cleanup", 60_000);
    await sleep(15);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalTaskPruneLimit: 10,
    });

    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases[0]).toMatchObject({
      phase: "enqueue_idempotency",
      rowsAffected: 1,
      error: null,
    });
    expect(phases[1]).toMatchObject({
      phase: "released_dependencies",
      rowsAffected: 0,
      error: null,
    });
    expect(phases[2]).toMatchObject({ phase: "terminal_tasks", rowsAffected: 1, error: null });
    expect(await admin.getTask(expired)).toBeNull();
    expect(await admin.getTask(retained)).not.toBeNull();
    expect(
      (await pool.query("SELECT task_id FROM workhorse.enqueue_idempotency ORDER BY task_id")).rows,
    ).toEqual([{ task_id: retained }]);
  });

  it("retains signal and human-wait evidence until the terminal outcome is also eligible", async () => {
    const id = await queue.enqueue("wait-retention", {});
    const worker = new Worker(queue, { workerId: "wait-retention-worker" }).handle(
      "wait-retention",
      async (_payload, context) => {
        await context.waitForSignal("signal");
        return context.waitForHuman("decision", { prompt: "Continue?" });
      },
    );
    expect(await worker.runOnce()).toBe(true);
    await queue.sendSignal(
      id,
      "signal",
      { received: true },
      { idempotencyKey: "signal", requestedBy: "service" },
    );
    expect(await worker.runOnce()).toBe(true);
    await queue.completeHumanWait(
      id,
      "decision",
      { approved: true },
      { idempotencyKey: "decision", requestedBy: "operator" },
    );
    expect(await worker.runOnce()).toBe(true);

    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [id]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [id]);
    await pool.query(
      `UPDATE workhorse.task
          SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
      [id],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
    });

    expect(
      (await queue.pruneTerminalStorage({ force: true })).find(
        ({ phase }) => phase === "terminal_tasks",
      ),
    ).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 0,
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::integer FROM workhorse.task_signal_wait WHERE task_id = $1) AS signals,
           (SELECT count(*)::integer FROM workhorse.task_human_wait WHERE task_id = $1) AS humans`,
        [id],
      ),
    ).resolves.toMatchObject({ rows: [{ signals: 1, humans: 1 }] });

    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = $1`,
      [id],
    );
    expect(
      (await queue.pruneTerminalStorage({ force: true })).find(
        ({ phase }) => phase === "terminal_tasks",
      ),
    ).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 1,
    });
    await expect(admin.getTask(id)).resolves.toBeNull();
  });

  it("serializes terminal deletion with concurrent history insertion", async () => {
    const id = await queue.enqueue("retention-race", {});
    const task = await queue.claim("retention-race-worker");
    expect(task?.id).toBe(id);
    expect(await queue.complete(task!, "retention-race-worker", { done: true })).toBe(true);
    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [id]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [id]);
    await pool.query(
      `UPDATE workhorse.task
          SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = $1`,
      [id],
    );

    const deleting = await pool.connect();
    const inserting = await pool.connect();
    try {
      await deleting.query("BEGIN");
      await expect(
        deleting.query(
          `SELECT workhorse.prune_terminal_tasks_v1(
             clock_timestamp() - interval '30 days',
             clock_timestamp() - interval '30 days',
             date_trunc('day', clock_timestamp() - interval '30 days'), 1
           ) AS pruned`,
        ),
      ).resolves.toMatchObject({ rows: [{ pruned: 1 }] });

      const insert = inserting
        .query(`INSERT INTO workhorse.task_event(task_id, event_type) VALUES ($1, 'concurrent')`, [
          id,
        ])
        .catch((error: unknown) => error);
      await sleep(25);
      await deleting.query("COMMIT");
      await expect(insert).resolves.toMatchObject({ code: "23503" });
    } finally {
      await deleting.query("ROLLBACK").catch(() => undefined);
      deleting.release();
      inserting.release();
    }
    await expect(admin.getTask(id)).resolves.toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.task_event WHERE task_id = $1",
          [id],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it.each([
    ["the fast tier", true],
    ["the full tier", false],
  ] as const)(
    "prunes past a window of redrive sources pinned by younger targets when %s goes first",
    async (_tier, fastFirst) => {
      // A source stays while its target exists, and its target finishes later. A window filled with
      // pinned sources once kept every pass from reaching the targets that release them.
      const limit = 2;
      const sources: string[] = [];
      for (let index = 0; index < limit * 4; index += 1) {
        sources.push(await createFailedTask({ type: "redriven-source" }));
      }
      const liveSource = await createFailedTask({ type: "live-redrive-source" });
      const targets: string[] = [];
      for (const source of sources) {
        const redrive = await admin.redrive(source, adminAudit("bulk recovery"));
        targets.push(redrive.targetTaskId!);
      }
      for (let index = 0; index < targets.length; index += 1) {
        const task = await queue.claim("redrive-retention-worker");
        expect(targets).toContain(task?.id);
        expect(await queue.complete(task!, "redrive-retention-worker", { done: true })).toBe(true);
      }
      const unrelated: string[] = [];
      for (let index = 0; index < limit; index += 1) {
        const id = await queue.enqueue("unrelated", {});
        const task = await queue.claim("redrive-retention-worker");
        expect(task?.id).toBe(id);
        expect(await queue.complete(task!, "redrive-retention-worker", { done: true })).toBe(true);
        unrelated.push(id);
      }
      const liveTarget = (await admin.redrive(liveSource, adminAudit("live recovery")))
        .targetTaskId!;

      const age = async (ids: string[], finishedDaysAgo: number) => {
        await pool.query(
          `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '41 days'
          WHERE id = ANY($1::uuid[])`,
          [ids],
        );
        await pool.query(
          `UPDATE workhorse.task_outcome
            SET finished_at = clock_timestamp() - make_interval(days => $2),
                history_through_at = clock_timestamp() - make_interval(days => $2)
          WHERE task_id = ANY($1::uuid[])`,
          [ids, finishedDaysAgo],
        );
      };
      await age([liveSource, liveTarget], 40);
      await age(sources, 39);
      await age(targets, 35);
      await age(unrelated, 33);
      await pool.query("DELETE FROM workhorse.task_event");
      await pool.query("DELETE FROM workhorse.attempt_history");
      await pool.query(
        `UPDATE workhorse.maintenance_state SET terminal_prune_fast_first = $1
          WHERE routine_name = 'terminal_storage'`,
        [fastFirst],
      );

      const prune = async () => {
        const result = await pool.query<{ pruned: number }>(
          `SELECT workhorse.prune_terminal_tasks_v1(
                  clock_timestamp() - interval '30 days',
                  clock_timestamp() - interval '30 days',
                  date_trunc('day', clock_timestamp() - interval '30 days'), $1
                ) AS pruned`,
          [limit],
        );
        // Read the flag in its own statement so it sees this pass's update, not the previous one.
        const state = await pool.query<{ starved: boolean }>(
          `SELECT terminal_prune_dependency_starved AS starved FROM workhorse.maintenance_state
          WHERE routine_name = 'terminal_storage'`,
        );
        expect(state.rows).toEqual([{ starved: false }]);
        return result.rows[0]!.pruned;
      };
      const remaining = async (ids: string[]) =>
        new Set(
          (
            await pool.query<{ id: string }>(
              "SELECT id FROM workhorse.task WHERE id = ANY($1::uuid[])",
              [ids],
            )
          ).rows.map(({ id }) => id),
        );

      // Each pass deletes a full batch, and a source goes only after its own target. A batch walks
      // its slice in circular order from the stored position of its tier (ADR 0122), so a source
      // that its target released can go after younger unrelated tasks.
      const tracked = [...sources, ...targets, ...unrelated];
      const deletedInPass = new Map<string, number>();
      for (let pass = 1; pass <= tracked.length / limit; pass += 1) {
        expect(await prune()).toBe(limit);
        const left = await remaining(tracked);
        for (const id of tracked)
          if (!left.has(id) && !deletedInPass.has(id)) deletedInPass.set(id, pass);
      }
      expect(deletedInPass.size).toBe(tracked.length);
      sources.forEach((source, index) => {
        expect(deletedInPass.get(source)).toBeGreaterThanOrEqual(
          deletedInPass.get(targets[index]!)!,
        );
      });

      expect(await prune()).toBe(0);
      expect(await remaining([liveSource, liveTarget])).toEqual(new Set([liveSource, liveTarget]));
    },
  );

  it("reports retention boundaries, lag, eligible partitions, and exact default counts", async () => {
    const oldDay = "2016-01-04";
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [oldDay]);
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [oldDay]);
    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
        VALUES ('default', 'health-event', '{}'::jsonb, 1, '2015-01-01'),
               ('default', 'health-attempt', '{}'::jsonb, 1, '2015-01-01')
        RETURNING id, task_type
      )
      INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
      SELECT id, 'old-default', '2015-01-01' FROM identities WHERE task_type = 'health-event';
      WITH identity AS (
        SELECT id FROM workhorse.task WHERE task_type = 'health-attempt'
      )
      INSERT INTO workhorse.attempt_history(
        task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, occurred_at
      ) SELECT id, 1, 1, 'health-worker', 'succeeded', '2015-01-01', '2015-01-01',
               '2015-01-01' FROM identity`);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
    });

    const health = await queue.health();
    expect(health.retentionPolicy).toMatchObject({
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
    });
    expect(health.oldestRetainedAt.taskEvents?.toISOString().slice(0, 10)).toBe("2015-01-01");
    expect(health.oldestRetainedAt.attemptHistory?.toISOString().slice(0, 10)).toBe("2015-01-01");
    expect(health.retentionLagMs.taskEvents).toBeGreaterThan(0);
    expect(health.retentionLagMs.attemptHistory).toBeGreaterThan(0);
    expect(health.eligibleHistoryPartitions).toMatchObject({ taskEvents: 1, attemptHistory: 1 });
    expect(health.defaultHistoryRows).toEqual({ taskEvents: 1, attemptHistory: 1 });
    expect(health.defaultHistoryRowsCapped).toEqual({ taskEvents: false, attemptHistory: false });

    const zonedClient = await pool.connect();
    try {
      await zonedClient.query("SET TIME ZONE 'Pacific/Kiritimati'");
      const zonedHealth = await new Queue(zonedClient).health();
      expect(zonedHealth.eligibleHistoryPartitions).toEqual(health.eligibleHistoryPartitions);
      // A broken session-timezone dependency would shift the day-boundary lag by hours; the
      // tolerance only needs to absorb the wall-clock between two consecutive snapshots.
      expect(zonedHealth.retentionLagMs.taskEvents).toBeCloseTo(
        health.retentionLagMs.taskEvents!,
        -4,
      );
      expect(zonedHealth.retentionLagMs.attemptHistory).toBeCloseTo(
        health.retentionLagMs.attemptHistory!,
        -4,
      );
    } finally {
      await zonedClient.query("RESET TIME ZONE");
      zonedClient.release();
    }
  });

  it("caps fallback-row health scans and marks the reported lower bound", async () => {
    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
        SELECT 'default', 'health-cap', '{}'::jsonb, 1, '2001-01-01'::timestamptz
          FROM generate_series(1, 10002)
        RETURNING id
      )
      INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
      SELECT id, 'health-cap', '2001-01-01'::timestamptz FROM identities`);

    const health = await queue.health();
    expect(health.defaultHistoryRows.taskEvents).toBe(10_001);
    expect(health.defaultHistoryRowsCapped.taskEvents).toBe(true);
    expect(health.defaultHistoryRows.attemptHistory).toBe(0);
    expect(health.defaultHistoryRowsCapped.attemptHistory).toBe(false);
  });

  it("computes identity lag from terminal tasks and ignores a partial history boundary day", async () => {
    await queue.enqueue("live-boundary", {});
    const boundary = await pool.query<{ day_start: string }>(
      `SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date - 30)::text AS day_start`,
    );
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [boundary.rows[0]!.day_start]);
    const partialBoundaryTask = await queue.enqueue("partial-boundary", {});
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
       VALUES (
         $1, 'partial-boundary',
         (
           ((clock_timestamp() AT TIME ZONE 'UTC')::date - 30)::timestamp
           + interval '12 hours'
         ) AT TIME ZONE 'UTC'
       )`,
      [partialBoundaryTask],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      taskEventRetentionDays: 30,
    });

    const health = await queue.health();
    expect(health.oldestRetainedAt.taskIdentity).toBeNull();
    expect(health.retentionLagMs.taskEvents).toBe(0);
  });

  it("does not report terminal outcome lag before the identity anchor is eligible", async () => {
    const id = await queue.enqueue("terminal-lag-gates", {});
    const task = await queue.claim("retention-health-worker");
    expect(task?.id).toBe(id);
    expect(await queue.complete(task!, "retention-health-worker", { done: true })).toBe(true);
    await pool.query(
      `UPDATE workhorse.task
          SET created_at = clock_timestamp() - interval '30 days' WHERE id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '30 days',
              history_through_at = clock_timestamp() - interval '30 days'
        WHERE task_id = $1`,
      [id],
    );
    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 365,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 365,
      attemptHistoryRetentionDays: 365,
      scheduleOccurrenceRetentionDays: 365,
      statisticsRetentionDays: 365,
    });

    const protectedHealth = await queue.health();
    expect(protectedHealth.oldestRetainedAt.terminalOutcome).not.toBeNull();
    expect(protectedHealth.retentionLagMs.taskIdentity).toBeNull();
    expect(protectedHealth.retentionLagMs.terminalOutcome).toBeNull();

    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 1,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      scheduleOccurrenceRetentionDays: 1,
      statisticsRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });
    const eligible = await queue.health();
    expect(eligible.retentionLagMs.taskIdentity).toBeGreaterThan(0);
    expect(eligible.retentionLagMs.terminalOutcome).toBeGreaterThan(0);
  });

  it("does not report row lag while history retention still holds the row", async () => {
    // Workhorse deletes a terminal task only after daily history retention has passed the task's
    // history. History retention advances in whole days, so a row can pass both row windows hours
    // before the prune may delete it. Health measures lag only against rows the prune could delete.
    const id = await queue.enqueue("row-lag-history-gate", {});
    const task = await queue.claim("retention-health-worker");
    expect(task?.id).toBe(id);
    expect(await queue.complete(task!, "retention-health-worker", { done: true })).toBe(true);
    await pool.query(
      `UPDATE workhorse.task
          SET created_at = clock_timestamp() - interval '30 days' WHERE id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '30 days' WHERE task_id = $1`,
      [id],
    );
    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 1,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      scheduleOccurrenceRetentionDays: 1,
      statisticsRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });

    const held = await queue.health();
    expect(held.retentionLagMs.taskIdentity).toBeNull();
    expect(held.retentionLagMs.terminalOutcome).toBeNull();
    expect(held.status.reasons.map((reason) => reason.code)).not.toContain("retention-lag");
    expect((await queue.pruneTerminalStorage({ force: true }))[2]).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 0,
    });

    await pool.query(
      `UPDATE workhorse.task_outcome
          SET history_through_at = clock_timestamp() - interval '30 days' WHERE task_id = $1`,
      [id],
    );
    const released = await queue.health();
    expect(released.retentionLagMs.taskIdentity).toBeGreaterThan(0);
    expect(released.retentionLagMs.terminalOutcome).toBeGreaterThan(0);
    expect(released.status.reasons).toContainEqual(
      expect.objectContaining({ code: "retention-lag", category: "taskIdentity" }),
    );
  });

  it("does not report row lag while an unfinished task group holds the row", async () => {
    // Terminal cleanup keeps each member of a task group that has not finished, because the group
    // needs its member outcomes when it finishes (ADR 0095). An open or sealed group can stay
    // unfinished for any length of time, so health does not count its members as lag. A group that
    // finishes releases all its members at once, so lag counts from the finish of the group.
    const groupQueue = "row-lag-group";
    const workerId = "retention-health-worker";
    const groupMember = (payload: number, runAt?: Date) => ({
      type: "row-lag-group-member",
      payload,
      options: { queue: groupQueue, maxAttempts: 1, ...(runAt ? { runAt } : {}) },
    });
    const callback = {
      type: "row-lag-group-callback",
      payload: {},
      options: { queue: "callbacks" },
    };
    const callbacks = { onFinish: callback, onSuccess: callback, onFailure: callback };

    const open = await queue.createTaskGroup(callbacks);
    const [openMember] = await queue.addToTaskGroup(open.id, [groupMember(1)]);
    // The second member of the sealed group waits far in the future, so the group cannot finish.
    const { group: sealed, tasks: sealedMembers } = await queue.taskGroup(callbacks, (builder) =>
      builder.add([groupMember(2), groupMember(3, new Date("2999-01-01T00:00:00Z"))]),
    );
    const claimed = await queue.claimMany(workerId, 10, { queue: groupQueue });
    expect(claimed.map((task) => task.id).toSorted()).toEqual(
      [openMember!.taskId, sealedMembers[0]!.taskId].toSorted(),
    );
    for (const task of claimed) {
      expect(await queue.complete(task, workerId, { done: true })).toBe(true);
    }
    const heldIds = claimed.map((task) => task.id);
    await pool.query(
      `UPDATE workhorse.task
          SET created_at = clock_timestamp() - interval '30 days' WHERE id = ANY($1::uuid[])`,
      [heldIds],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '30 days',
              history_through_at = clock_timestamp() - interval '30 days'
        WHERE task_id = ANY($1::uuid[])`,
      [heldIds],
    );
    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 1,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      scheduleOccurrenceRetentionDays: 1,
      statisticsRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });

    const groupState = async (id: string) =>
      (
        await pool.query<{ state: string }>(
          "SELECT state FROM workhorse.task_group WHERE id = $1",
          [id],
        )
      ).rows[0]?.state;
    const rowLagReported = (health: Awaited<ReturnType<typeof queue.health>>) =>
      health.status.reasons.filter((reason) => reason.code === "retention-lag");

    // 1. Both groups are unfinished, so neither held member is lag, and the prune deletes neither.
    const held = await queue.health();
    expect(held.retentionLagMs.taskIdentity).toBeNull();
    expect(held.retentionLagMs.terminalOutcome).toBeNull();
    expect(rowLagReported(held)).toEqual([]);
    expect((await queue.pruneTerminalStorage({ force: true }))[2]).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 0,
    });
    expect(await groupState(open.id)).toBe("open");
    expect(await groupState(sealed.id)).toBe("sealed");

    // 2. The open group finishes now. Its member passed its windows 29 days ago, but lag counts
    // from the finish of the group, so it is still inside its budget.
    expect((await queue.sealTaskGroup(open.id)).state).toBe("finished");
    const finished = await queue.health();
    for (const lag of [
      finished.retentionLagMs.taskIdentity,
      finished.retentionLagMs.terminalOutcome,
    ]) {
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThan(60_000);
    }
    expect(rowLagReported(finished)).toEqual([]);

    // 3. If the group finished long ago and the prune did not run, the member is lag.
    await pool.query(
      `UPDATE workhorse.task_group
          SET finished_at = clock_timestamp() - interval '1 day' WHERE id = $1`,
      [open.id],
    );
    const late = await queue.health();
    expect(late.retentionLagMs.taskIdentity).toBeGreaterThan(86_400_000 - 60_000);
    expect(late.retentionLagMs.terminalOutcome).toBeGreaterThan(86_400_000 - 60_000);
    expect(rowLagReported(late)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "taskIdentity" }),
        expect.objectContaining({ category: "terminalOutcome" }),
      ]),
    );

    // 4. The prune deletes the member of the finished group. The test aged only the history
    // boundary, so it also removes the history rows that a real history pass drops first. The
    // sealed group still holds its member, so health reports no lag again.
    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [heldIds]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      heldIds,
    ]);
    expect((await queue.pruneTerminalStorage({ force: true }))[2]).toMatchObject({
      phase: "terminal_tasks",
      rowsAffected: 1,
    });
    const remaining = await pool.query<{ id: string }>(
      "SELECT id FROM workhorse.task WHERE id = ANY($1::uuid[])",
      [heldIds],
    );
    expect(remaining.rows.map((row) => row.id)).toEqual([sealedMembers[0]!.taskId]);
    const cleared = await queue.health();
    expect(cleared.retentionLagMs.taskIdentity).toBeNull();
    expect(cleared.retentionLagMs.terminalOutcome).toBeNull();
    expect(rowLagReported(cleared)).toEqual([]);
  });

  it("does not let a member of a group that finished just now hide an older ungrouped row", async () => {
    // The finish of a group does not follow the age of its members. A member that is older than an
    // ungrouped row can therefore be inside its budget while the ungrouped row is overdue.
    const workerId = "retention-health-worker";
    const callback = {
      type: "row-lag-hide-callback",
      payload: {},
      options: { queue: "callbacks" },
    };
    const { group, tasks } = await queue.taskGroup(
      { onFinish: callback, onSuccess: callback, onFailure: callback },
      (builder) =>
        builder.add([
          { type: "row-lag-hide-member", payload: 1, options: { queue: "row-lag-hide" } },
        ]),
    );
    const memberId = tasks[0]!.taskId;
    const ungroupedId = await queue.enqueue(
      "row-lag-hide-ungrouped",
      {},
      { queue: "row-lag-hide" },
    );
    for (const task of await queue.claimMany(workerId, 10, { queue: "row-lag-hide" })) {
      expect(await queue.complete(task, workerId, { done: true })).toBe(true);
    }
    expect(
      (
        await pool.query<{ state: string }>(
          "SELECT state FROM workhorse.task_group WHERE id = $1",
          [group.id],
        )
      ).rows[0]?.state,
    ).toBe("finished");
    // The member finished 30 days ago, the ungrouped task 20 days ago. Only the ungrouped task is
    // overdue, because the group of the member finished just now.
    for (const [id, age] of [
      [memberId, "30 days"],
      [ungroupedId, "20 days"],
    ] as const) {
      await pool.query(
        `UPDATE workhorse.task SET created_at = clock_timestamp() - $2::interval WHERE id = $1`,
        [id, age],
      );
      await pool.query(
        `UPDATE workhorse.task_outcome
            SET finished_at = clock_timestamp() - $2::interval,
                history_through_at = clock_timestamp() - $2::interval
          WHERE task_id = $1`,
        [id, age],
      );
    }
    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 1,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      scheduleOccurrenceRetentionDays: 1,
      statisticsRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });

    const health = await queue.health();
    // The ungrouped task passed its windows 19 days ago, and its history pass came later.
    for (const lag of [health.retentionLagMs.taskIdentity, health.retentionLagMs.terminalOutcome]) {
      expect(lag).toBeGreaterThan(17 * 86_400_000);
      expect(lag).toBeLessThan(20 * 86_400_000);
    }
    expect(health.status.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "retention-lag", category: "taskIdentity" }),
        expect.objectContaining({ code: "retention-lag", category: "terminalOutcome" }),
      ]),
    );
  });

  it("counts row lag from the earliest due member of the finished task groups", async () => {
    // A member is due at the later of its row window and the finish of its group. Member A passed
    // its windows 30 seconds ago, and its group finished three days ago, so A is due now. Member B
    // passed its windows 16 days ago, but its group finished two days ago, so B is due two days ago.
    // The group of A finished first, but B is the member that is overdue.
    const workerId = "retention-health-worker";
    const callback = { type: "row-lag-due-callback", payload: {}, options: { queue: "callbacks" } };
    const oneMemberGroup = async (payload: number) => {
      const { group, tasks } = await queue.taskGroup(
        { onFinish: callback, onSuccess: callback, onFailure: callback },
        (builder) =>
          builder.add([{ type: "row-lag-due-member", payload, options: { queue: "row-lag-due" } }]),
      );
      return { groupId: group.id, taskId: tasks[0]!.taskId };
    };
    const memberA = await oneMemberGroup(1);
    const memberB = await oneMemberGroup(2);
    for (const task of await queue.claimMany(workerId, 10, { queue: "row-lag-due" })) {
      expect(await queue.complete(task, workerId, { done: true })).toBe(true);
    }
    for (const [member, rowAge, groupAge] of [
      [memberA, "1 day 30 seconds", "3 days"],
      [memberB, "17 days", "2 days"],
    ] as const) {
      await pool.query(
        `UPDATE workhorse.task SET created_at = clock_timestamp() - $2::interval WHERE id = $1`,
        [member.taskId, rowAge],
      );
      // The history of both rows is old, so the history pass is not the instant that decides.
      await pool.query(
        `UPDATE workhorse.task_outcome
            SET finished_at = clock_timestamp() - $2::interval,
                history_through_at = clock_timestamp() - interval '17 days'
          WHERE task_id = $1`,
        [member.taskId, rowAge],
      );
      await pool.query(
        `UPDATE workhorse.task_group
            SET finished_at = clock_timestamp() - $2::interval
          WHERE id = $1 AND state = 'finished'`,
        [member.groupId, groupAge],
      );
    }
    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 1,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      scheduleOccurrenceRetentionDays: 1,
      statisticsRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });

    const health = await queue.health();
    for (const lag of [health.retentionLagMs.taskIdentity, health.retentionLagMs.terminalOutcome]) {
      expect(lag).toBeGreaterThan(2 * 86_400_000 - 60_000);
      expect(lag).toBeLessThan(2 * 86_400_000 + 60_000);
    }
    expect(health.status.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "retention-lag", category: "taskIdentity" }),
        expect.objectContaining({ code: "retention-lag", category: "terminalOutcome" }),
      ]),
    );
  });

  it("counts row lag from the member whose history pass released it first", async () => {
    // Two members of one group finished 15 and 30 days ago, and the group finished 10 days ago.
    // History windows are 14 days, so the history of the first member became releasable at today's
    // UTC midnight, while the second member has been due since its group finished.
    const workerId = "retention-health-worker";
    const callback = {
      type: "row-lag-release-callback",
      payload: {},
      options: { queue: "callbacks" },
    };
    const { group, tasks } = await queue.taskGroup(
      { onFinish: callback, onSuccess: callback, onFailure: callback },
      (builder) =>
        builder.add([
          { type: "row-lag-release-member", payload: 1, options: { queue: "row-lag-release" } },
          { type: "row-lag-release-member", payload: 2, options: { queue: "row-lag-release" } },
        ]),
    );
    for (const task of await queue.claimMany(workerId, 10, { queue: "row-lag-release" })) {
      expect(await queue.complete(task, workerId, { done: true })).toBe(true);
    }
    await queue.syncMaintenancePolicy(
      { timezone: "UTC", historyRetentionLocalTime: "00:00" },
      { force: true },
    );
    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 14,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 14,
      attemptHistoryRetentionDays: 14,
      scheduleOccurrenceRetentionDays: 14,
      statisticsRetentionDays: 14,
    });
    await queue.retainHistory({ force: true });
    // The member that is due today gets the smaller task id, so an order by group finish and then
    // by task id would pick it first.
    const [dueToday, overdue] = tasks.map((task) => task.taskId).toSorted();
    for (const [taskId, finishedAge] of [
      [dueToday!, "15 days"],
      [overdue!, "30 days"],
    ] as const) {
      await pool.query(
        `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '31 days' WHERE id = $1`,
        [taskId],
      );
      await pool.query(
        `UPDATE workhorse.task_outcome
            SET finished_at = clock_timestamp() - $2::interval,
                history_through_at = clock_timestamp() - $2::interval
          WHERE task_id = $1`,
        [taskId, finishedAge],
      );
    }
    await pool.query(
      `UPDATE workhorse.task_group
          SET finished_at = clock_timestamp() - interval '10 days'
        WHERE id = $1 AND state = 'finished'`,
      [group.id],
    );

    const health = await queue.health();
    for (const lag of [health.retentionLagMs.taskIdentity, health.retentionLagMs.terminalOutcome]) {
      expect(lag).toBeGreaterThan(10 * 86_400_000 - 60_000);
      expect(lag).toBeLessThan(10 * 86_400_000 + 60_000);
    }
  });

  it("counts row lag from the history pass that released the row", async () => {
    // One daily history pass releases a whole day of rows, and the oldest of them passed its row
    // window about a day earlier. The bounded prune needs several runs to delete them, so lag counts
    // from the scheduled pass that released the row whenever that pass came later.
    const id = await queue.enqueue("row-lag-release", {});
    const task = await queue.claim("retention-health-worker");
    expect(task?.id).toBe(id);
    expect(await queue.complete(task!, "retention-health-worker", { done: true })).toBe(true);
    await queue.syncMaintenancePolicy(
      { timezone: "UTC", historyRetentionLocalTime: "00:00" },
      { force: true },
    );
    await queue.syncRetentionPolicy({
      taskIdentityRetentionDays: 5,
      terminalOutcomeRetentionDays: 5,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      scheduleOccurrenceRetentionDays: 1,
      statisticsRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });
    const age = async (createdAndFinished: string, historyThrough: string) => {
      await pool.query(
        `UPDATE workhorse.task SET created_at = ${createdAndFinished} WHERE id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.task_outcome
            SET finished_at = ${createdAndFinished}, history_through_at = ${historyThrough}
          WHERE task_id = $1`,
        [id],
      );
    };
    // The row passed its windows 25 days ago, but its history became releasable at today's UTC
    // midnight, when the pass scheduled for 00:00 fell due.
    await age(
      "clock_timestamp() - interval '30 days'",
      "date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'" +
        " - interval '1 day 1 minute'",
    );
    const before = await sinceUtcMidnightMs();
    const released = await queue.health();
    const after = await sinceUtcMidnightMs();
    for (const lag of [
      released.retentionLagMs.taskIdentity,
      released.retentionLagMs.terminalOutcome,
    ]) {
      expect(lag).toBeGreaterThanOrEqual(Math.floor(before) - 1);
      expect(lag).toBeLessThanOrEqual(Math.ceil(after) + 1);
    }

    // History released four days ago does not shorten the lag of a row that passed its windows
    // one day ago.
    await age("clock_timestamp() - interval '6 days'", "clock_timestamp() - interval '6 days'");
    const windowed = await queue.health();
    for (const lag of [
      windowed.retentionLagMs.taskIdentity,
      windowed.retentionLagMs.terminalOutcome,
    ]) {
      expect(lag).toBeGreaterThan(86_400_000 - 60_000);
      expect(lag).toBeLessThan(86_400_000 + 60_000);
    }
  });

  it("deletes the tasks with no key when the keyed tasks fill the lock window", async () => {
    // With a limit of 1, cleanup once locked the four oldest terminal tasks. Each of them had an
    // enqueue key, so each pass deleted nothing and locked the same rows again (SM-1935).
    await queue.syncRetentionPolicy({ ...defaultRetentionPolicy, terminalTaskPruneLimit: 1 });
    const ttlMs = 30 * dayMs;
    const ids = await queue.enqueueMany([
      ...["k1", "k2", "k3", "k4"].map((key) => ({
        type: "keyed",
        payload: {},
        options: { queue: "ret", idempotency: { key, ttlMs } },
      })),
      ...[1, 2, 3].map(() => ({ type: "plain", payload: {}, options: { queue: "ret" } })),
    ]);
    for (const id of ids) await queue.cancel(id, { requestedBy: "f2", reason: "proof" });
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '21 days'
        WHERE queue_name = 'ret'`,
    );
    await pool.query(
      `UPDATE workhorse.task_outcome outcome
          SET finished_at = clock_timestamp() - CASE WHEN task.task_type = 'keyed'
                THEN interval '20 days' ELSE interval '19 days' END,
              history_through_at = clock_timestamp() - CASE WHEN task.task_type = 'keyed'
                THEN interval '20 days' ELSE interval '19 days' END
         FROM workhorse.task task
        WHERE task.id = outcome.task_id AND task.queue_name = 'ret'`,
    );
    await pool.query(
      `DELETE FROM workhorse.task_event event USING workhorse.task task
        WHERE task.id = event.task_id AND task.queue_name = 'ret'`,
    );
    await pool.query(
      `DELETE FROM workhorse.attempt_history attempt USING workhorse.task task
        WHERE task.id = attempt.task_id AND task.queue_name = 'ret'`,
    );

    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases.find(({ phase }) => phase === "terminal_tasks")).toMatchObject({
      rowsAffected: 3,
      error: null,
    });
    const left = await pool.query<{ task_type: string; count: number }>(
      `SELECT task_type, count(*)::integer AS count FROM workhorse.task
        WHERE queue_name = 'ret' GROUP BY task_type ORDER BY task_type`,
    );
    expect(left.rows).toEqual([{ task_type: "keyed", count: 4 }]);
  });

  it.each(Object.keys(holdReferences) as (keyof typeof holdReferences)[])(
    "deletes eligible tasks behind a window of tasks that %s keeps",
    async (reference) => {
      // Four kept tasks are older than three eligible tasks. With a limit of 1, the lock window once
      // held the four kept tasks, so no pass reached the eligible ones (SM-1935).
      await useOneDayRowWindows(1);
      const kept: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const id = await insertTerminalTask("retention-kept", 30 * 24 + index);
        await holdReferences[reference](id);
        kept.push(id);
      }
      const eligible: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        eligible.push(await insertTerminalTask("retention-eligible", 20 * 24 + index));
      }

      const phases = await queue.pruneTerminalStorage({ force: true });
      expect(phases.find(({ phase }) => phase === "terminal_tasks")).toMatchObject({
        rowsAffected: 3,
        error: null,
      });
      for (const id of eligible) expect(await taskExists(id)).toBe(false);
      for (const id of kept) expect(await taskExists(id)).toBe(true);

      // A later pass deletes nothing. It reports a dependency edge that keeps a prerequisite, and
      // only that reference.
      const later = await queue.pruneTerminalStorage({ force: true });
      expect(later.find(({ phase }) => phase === "terminal_tasks")).toMatchObject({
        rowsAffected: 0,
      });
      expect((await queue.health()).dependencies.retentionPruneStarved).toBe(
        reference === "a dependency edge to a live dependent",
      );
    },
  );

  it("deletes eligible tasks behind more kept tasks than one batch examines", async () => {
    // One batch examines a slice of at least 1,000 rows past the cutoffs. 3,100 kept tasks come
    // first, more than three slices, so a scan of the whole table breaks the bound of one call. Each batch continues after the slice of the batch before it, so a bounded number of
    // batches reaches the eligible tasks, and one batch never reads more than its slice.
    await useOneDayRowWindows(2);
    await pool.query(
      `WITH task AS (
         INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
         SELECT 'retention-slices', CASE WHEN position <= 3100 THEN 'kept' ELSE 'eligible' END,
                '{}'::jsonb, 1, clock_timestamp() - interval '30 days' + make_interval(secs => position)
           FROM generate_series(1, 3103) position
         RETURNING id, task_type, created_at
       ), outcome AS (
         INSERT INTO workhorse.task_outcome(
           task_id, state, current_attempt, fence_token, run_at, result, finished_at,
           history_through_at
         )
         SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at FROM task
       )
       INSERT INTO workhorse.enqueue_idempotency(
         idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
       )
       SELECT 'retention-slices', sha256(convert_to(id::text, 'UTF8')), '{}'::jsonb, id,
              clock_timestamp() + interval '30 days'
         FROM task WHERE task_type = 'kept'`,
    );
    // With statistics, a generic plan can prefer a scan of the whole table to one lookup per row.
    await pool.query(
      "ANALYZE workhorse.task, workhorse.task_outcome, workhorse.enqueue_idempotency",
    );
    const eligibleLeft = async () =>
      Number(
        (
          await pool.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM workhorse.task
              WHERE queue_name = 'retention-slices' AND task_type = 'eligible'`,
          )
        ).rows[0]!.count,
      );
    const batch = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The counter can hold earlier reads of this connection, so the test reads its difference.
        // A generic plan must keep the bound too, so the batch plans each statement as one.
        await client.query("SET LOCAL plan_cache_mode = force_generic_plan");
        // The index rows and the sequential rows of task_outcome that the transaction read.
        const readTuples = async () =>
          Number(
            (
              await client.query<{ tuples: string }>(
                `SELECT pg_stat_get_xact_tuples_returned(
                          'workhorse.task_outcome_retention_idx'::regclass)
                        + pg_stat_get_xact_tuples_returned('workhorse.task_outcome'::regclass)
                          AS tuples`,
              )
            ).rows[0]!.tuples,
          );
        const before = await readTuples();
        const pruned = await client.query<{ pruned: number }>(
          `SELECT workhorse.prune_terminal_tasks_v1(
                  clock_timestamp() - interval '24 hours', clock_timestamp() - interval '24 hours',
                  clock_timestamp() - interval '24 hours', 2) AS pruned`,
        );
        const read = (await readTuples()) - before;
        await client.query("COMMIT");
        return { pruned: pruned.rows[0]!.pruned, read };
      } finally {
        client.release();
      }
    };

    // One call runs at most three tier batches, and each batch reads at most one slice. The index
    // can still return the entries of the three rows that earlier batches deleted.
    const first = await batch();
    expect(first.pruned).toBe(0);
    expect(first.read).toBeLessThanOrEqual(3 * 1000 + 3);
    let calls = 1;
    while ((await eligibleLeft()) > 0 && calls < 20) {
      const next = await batch();
      expect(next.read).toBeLessThanOrEqual(3 * 1000 + 3);
      calls += 1;
    }
    // Every second batch of the tier is a sweep batch, so the main walk moves by one slice in two
    // calls. 3,103 rows then take at most eight calls, and two more calls delete what the last
    // slice found.
    expect(await eligibleLeft()).toBe(0);
    expect(calls).toBeLessThanOrEqual(10);
  });

  it("reads the same rows in one batch call behind 1,100 or 1,400 kept tasks", async () => {
    // Under a generic plan, the lock statement once read the whole outcome table, so the work of a
    // batch grew with the kept tasks. Each call now reads its slices of 1,000 rows, whatever follows.
    await useOneDayRowWindows(2);
    expect(await firstPruneCallReads(1400)).toBe(await firstPruneCallReads(1100));
  });

  it("records no backlog and stops when kept tasks alone remain past the cutoffs", async () => {
    // More kept tasks than one slice examines and no eligible task. The walk comes round to where
    // its run of empty batches began, removes its position, and ends the pass with no backlog.
    await useOneDayRowWindows(1);
    await pool.query(
      `WITH task AS (
         INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
         SELECT 'retention-quiet', 'kept', '{}'::jsonb, 1,
                clock_timestamp() - interval '30 days' + make_interval(secs => position)
           FROM generate_series(1, 1500) position
         RETURNING id, created_at
       ), outcome AS (
         INSERT INTO workhorse.task_outcome(
           task_id, state, current_attempt, fence_token, run_at, result, finished_at,
           history_through_at
         )
         SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at FROM task
       )
       INSERT INTO workhorse.enqueue_idempotency(
         idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
       )
       SELECT 'retention-quiet', sha256(convert_to(id::text, 'UTF8')), '{}'::jsonb, id,
              clock_timestamp() + interval '30 days'
         FROM task`,
    );

    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases.find(({ phase }) => phase === "terminal_tasks")).toMatchObject({
      rowsAffected: 0,
      error: null,
    });
    const state = await pool.query<{ since: Date | null; positions: number }>(
      `SELECT terminal_cleanup_backlog_since AS since,
              (SELECT count(*)::integer FROM workhorse.terminal_prune_position
                WHERE finished_at IS NOT NULL) AS positions
         FROM workhorse.maintenance_state WHERE routine_name = 'terminal_storage'`,
    );
    expect(state.rows).toEqual([{ since: null, positions: 0 }]);
  });

  it("keeps the expiry of a key while another transaction locks its task", async () => {
    // The key expired one hour ago, so the task is due one hour ago. Another transaction locks the
    // task, so this pass cannot delete it. The key stays with the task, and health still counts
    // the lag from the expiry, not from the end of the task window.
    await useOneDayRowWindows();
    const taskId = await insertTerminalTask("retention-locked-key", 30 * 24);
    await pool.query(
      `INSERT INTO workhorse.enqueue_idempotency(
         idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
       ) VALUES ('retention-locked-key', sha256(convert_to($1::text, 'UTF8')), '{}'::jsonb,
                 $1::uuid, clock_timestamp() - interval '1 hour')`,
      [taskId],
    );
    expectRowLagNear(await rowLag(), hourMs);
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM workhorse.task WHERE id = $1 FOR UPDATE", [taskId]);
      await queue.pruneTerminalStorage({ force: true });
      await locker.query("COMMIT");
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }
    expect(await taskExists(taskId)).toBe(true);
    expectRowLagNear(await rowLag(), hourMs);

    await queue.pruneTerminalStorage({ force: true });
    expect(await taskExists(taskId)).toBe(false);
    expect(
      (await pool.query("SELECT 1 FROM workhorse.enqueue_idempotency WHERE task_id = $1", [taskId]))
        .rowCount,
    ).toBe(0);
  });

  it("does not wait for an enqueue that holds the expired key of a task", async () => {
    // An enqueue locks keys in key order. If cleanup waited for a key, it could deadlock with such
    // an enqueue, so cleanup takes the key with SKIP LOCKED and leaves its task for a later batch.
    await useOneDayRowWindows();
    const taskId = await insertTerminalTask("retention-key-lock", 30 * 24);
    await pool.query(
      `INSERT INTO workhorse.enqueue_idempotency(
         idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
       ) VALUES ('retention-key-lock', sha256(convert_to($1::text, 'UTF8')), '{}'::jsonb,
                 $1::uuid, clock_timestamp() - interval '1 hour')`,
      [taskId],
    );
    const holder = await pool.connect();
    const cleaner = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM workhorse.enqueue_idempotency WHERE task_id = $1 FOR UPDATE",
        [taskId],
      );
      await cleaner.query("BEGIN");
      // A wait for the key would fail this statement after one second.
      await cleaner.query("SET LOCAL lock_timeout = '1s'");
      const pruned = await cleaner.query<{ pruned: number }>(
        `SELECT workhorse.prune_terminal_tasks_v1(
                clock_timestamp() - interval '24 hours', clock_timestamp() - interval '24 hours',
                clock_timestamp() - interval '24 hours', 10) AS pruned`,
      );
      expect(pruned.rows[0]!.pruned).toBe(0);
      await cleaner.query("COMMIT");
      await holder.query("COMMIT");
    } finally {
      await cleaner.query("ROLLBACK").catch(() => undefined);
      await holder.query("ROLLBACK").catch(() => undefined);
      cleaner.release();
      holder.release();
    }
    expect(await taskExists(taskId)).toBe(true);
    await queue.pruneTerminalStorage({ force: true });
    expect(await taskExists(taskId)).toBe(false);
  });

  it("holds no lock on the key of a task that it leaves for another held reference", async () => {
    // The task has an expired key and a released edge to a finished dependent. Another transaction
    // holds the edge, so the batch leaves the task. It must not keep the lock on the key, or an
    // enqueue with that key waits until the pass commits.
    await useOneDayRowWindows();
    const taskId = await insertTerminalTask("retention-two-references", 30 * 24);
    const dependent = await insertTerminalTask("retention-two-references-dependent", 4);
    await pool.query(
      `INSERT INTO workhorse.enqueue_idempotency(
         idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
       ) VALUES ('retention-two-references', sha256(convert_to($1::text, 'UTF8')), '{}'::jsonb,
                 $1::uuid, clock_timestamp() - interval '1 hour')`,
      [taskId],
    );
    await pool.query(
      `INSERT INTO workhorse.task_dependency(
         dependent_task_id, prerequisite_task_id, on_failure, on_cancellation, on_success,
         created_at, released_at, resolution
       ) VALUES ($1, $2, 'fail', 'cancel', 'release', clock_timestamp() - interval '5 hours',
                 clock_timestamp() - interval '5 hours', 'release')`,
      [dependent, taskId],
    );
    const holder = await pool.connect();
    const cleaner = await pool.connect();
    const enqueuer = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM workhorse.task_dependency WHERE prerequisite_task_id = $1 FOR UPDATE",
        [taskId],
      );
      await cleaner.query("BEGIN");
      const pruned = await cleaner.query<{ pruned: number }>(
        `SELECT workhorse.prune_terminal_tasks_v1(
                clock_timestamp() - interval '24 hours', clock_timestamp() - interval '24 hours',
                clock_timestamp() - interval '24 hours', 10) AS pruned`,
      );
      expect(pruned.rows[0]!.pruned).toBe(0);
      await expect(
        enqueuer.query(
          "SELECT 1 FROM workhorse.enqueue_idempotency WHERE task_id = $1 FOR UPDATE NOWAIT",
          [taskId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await cleaner.query("COMMIT");
      await holder.query("COMMIT");
    } finally {
      await cleaner.query("ROLLBACK").catch(() => undefined);
      await holder.query("ROLLBACK").catch(() => undefined);
      enqueuer.release();
      cleaner.release();
      holder.release();
    }
    expect(await taskExists(taskId)).toBe(true);
  });

  it("reads the same key and edge rows in one pass behind 1,100 or 1,400 kept tasks", async () => {
    // Members of an open task group stay, and each has an expired key and a released edge to a
    // finished dependent. The key and edge phases delete those references, so with a limit of 1
    // each phase walk reads a few index rows, whatever the kept tasks. On tables this small, a
    // generic plan of these phases can also read each whole table, as it did before this change.
    await useOneDayRowWindows(1);
    const small = await referencePhaseReads(1100);
    expect(await referencePhaseReads(1400)).toBe(small);
    expect(small).toBeLessThan(10);
  });

  it.each(["force_generic_plan", "force_custom_plan"] as const)(
    "reads the same task and outcome rows in the key and edge phases behind 1,100 or 1,400 kept tasks (%s)",
    async (plan) => {
      // Each phase looks up the task and the outcome of each reference that it deletes by primary
      // key, so with a limit of 1 the reads do not grow with the kept tasks (ADR 0122).
      await useOneDayRowWindows(1);
      const small = await referencePhaseReads(1100, "tables", plan);
      expect(await referencePhaseReads(1400, "tables", plan)).toBe(small);
      expect(small).toBeLessThan(20);
    },
  );

  it("reports a dependency pin that one slice of a pass saw", async () => {
    // Enqueue keys keep 1,499 old tasks, and a live dependent keeps the 750th. The pass deletes
    // nothing, and the slice that holds the pin is not its last slice.
    await useOneDayRowWindows(1);
    const dependent = await queue.enqueue("retention-pin-dependent", {});
    await pool.query(
      `WITH task AS (
         INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
         SELECT 'retention-pin', CASE WHEN position = 750 THEN 'pinned' ELSE 'kept' END,
                '{}'::jsonb, 1,
                clock_timestamp() - interval '30 days' + make_interval(secs => position)
           FROM generate_series(1, 1500) position
         RETURNING id, task_type, created_at
       ), outcome AS (
         INSERT INTO workhorse.task_outcome(
           task_id, state, current_attempt, fence_token, run_at, result, finished_at,
           history_through_at
         )
         SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at FROM task
       ), edge AS (
         INSERT INTO workhorse.task_dependency(
           dependent_task_id, prerequisite_task_id, on_failure, on_cancellation, on_success
         )
         SELECT $1::uuid, id, 'fail', 'cancel', 'release' FROM task WHERE task_type = 'pinned'
       )
       INSERT INTO workhorse.enqueue_idempotency(
         idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
       )
       SELECT 'retention-pin', sha256(convert_to(id::text, 'UTF8')), '{}'::jsonb, id,
              clock_timestamp() + interval '30 days'
         FROM task WHERE task_type = 'kept'`,
      [dependent],
    );
    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases.find(({ phase }) => phase === "terminal_tasks")).toMatchObject({
      rowsAffected: 0,
    });
    expect((await queue.health()).dependencies.retentionPruneStarved).toBe(true);
  });

  it("reports no dependency pin for a row that waits for its identity window", async () => {
    // The identity window is 30 days, and the outcome and history windows are 1 day. A task that
    // finished 10 days ago is in the slice of the batch, but it waits for its identity window. Its
    // live dependent therefore does not show a pass that a dependency edge stops.
    await queue.syncMaintenancePolicy(
      { timezone: "UTC", historyRetentionLocalTime: "00:00" },
      { force: true },
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 1,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
    });
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET history_retained_before = clock_timestamp() - interval '24 hours'
        WHERE routine_name = 'history_retention'`,
    );
    const prerequisite = await insertTerminalTask("retention-pin-waiting", 10 * 24);
    await holdReferences["a dependency edge to a live dependent"](prerequisite);
    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases.find(({ phase }) => phase === "terminal_tasks")).toMatchObject({
      rowsAffected: 0,
    });
    expect(await taskExists(prerequisite)).toBe(true);
    expect((await queue.health()).dependencies.retentionPruneStarved).toBe(false);
  });

  it("does not lock a released redrive source that another target still keeps", async () => {
    const source = await createFailedTask({ type: "redrive-two-targets" });
    const oldTarget = (await admin.redrive(source, adminAudit("first"))).targetTaskId!;
    const first = await queue.claim("redrive-two-targets-worker");
    expect(first?.id).toBe(oldTarget);
    expect(await queue.complete(first!, "redrive-two-targets-worker", {})).toBe(true);
    await pool.query(
      `UPDATE workhorse.task_outcome SET state = 'failed', error = '{"name":"Error"}'::jsonb,
              result = NULL
        WHERE task_id = $1`,
      [oldTarget],
    );
    const youngTarget = (
      await pool.query<{ target_task_id: string }>(
        "SELECT target_task_id FROM workhorse.redrive_v1($1, 'operator', 'second', 'second-request')",
        [source],
      )
    ).rows[0]!.target_task_id;
    expect(youngTarget).not.toBe(oldTarget);
    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [
      [source, oldTarget],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      [source, oldTarget],
    ]);
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '41 days'
        WHERE id = ANY($1::uuid[])`,
      [[source, oldTarget]],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = ANY($1::uuid[])`,
      [[source, oldTarget]],
    );
    const cleaner = await pool.connect();
    const other = await pool.connect();
    try {
      await cleaner.query("BEGIN");
      await cleaner.query(
        `SELECT workhorse.prune_terminal_tasks_v1(
                clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
                clock_timestamp() - interval '30 days', 10)`,
      );
      // The batch deleted the old target. The young target still keeps the source, so the batch
      // must not hold a lock on it.
      await expect(
        other.query("SELECT 1 FROM workhorse.task WHERE id = $1 FOR UPDATE NOWAIT", [source]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await cleaner.query("COMMIT");
    } finally {
      await cleaner.query("ROLLBACK").catch(() => undefined);
      cleaner.release();
      other.release();
    }
    expect(await taskExists(oldTarget)).toBe(false);
    expect(await taskExists(source)).toBe(true);
  });

  describe("the sweep walk", () => {
    // Task A is the oldest terminal task, and an enqueue key keeps it. The main walk passes it.
    // Then the key goes, so A can go, but A is behind the position of the main walk. Each call
    // gets one new eligible task, so each main batch fills and the main walk never wraps. The sweep
    // walk takes every second batch and reaches A (ADR 0122).

    it("deletes a row behind the main walk within the bound while each call fills", async () => {
      const oldTask = await passOldTask();
      // The sweep starts at the oldest row, and A is that row: R is 1 and E is 0.
      let calls = 0;
      while ((await taskExists(oldTask)) && calls < 10) {
        await insertTerminalTask("retention-sweep-new", 25 * 24);
        expect(await pruneOneCall()).toBe(1);
        calls += 1;
      }
      expect(await taskExists(oldTask)).toBe(false);
      expect(calls).toBeLessThanOrEqual(sweepBound(1, 0));
    });

    it("deletes six rows behind the main walk within the bound while each call fills", async () => {
      // The schedule of the review: limit 1, six old rows, and one new eligible row for each call.
      // The sweep examines the six old rows from the oldest, so for the last one R is 6 and E is 5.
      const oldTasks = await passOldTasks(6);
      const bound = sweepBound(6, 5);
      let calls = 0;
      const remaining = async () => {
        let count = 0;
        for (const oldTask of oldTasks) if (await taskExists(oldTask)) count += 1;
        return count;
      };
      while ((await remaining()) > 0 && calls < bound + 5) {
        await insertTerminalTask("retention-sweep-new", 25 * 24);
        expect(await pruneOneCall()).toBe(1);
        calls += 1;
      }
      expect(await remaining()).toBe(0);
      expect(calls).toBeLessThanOrEqual(bound);
    });

    it("deletes a row behind the main walk in one full pass", async () => {
      const oldTask = await passOldTask();
      await queue.pruneTerminalStorage({ force: true });
      expect(await taskExists(oldTask)).toBe(false);
    });
  });

  it("counts a prerequisite from the finish of its dependent after the edge went", async () => {
    // The released edge goes in the released-edge phase. Another transaction locks the
    // prerequisite, so the terminal phase leaves it. Health still counts it from the finish of its
    // dependent, which task_outcome.held_until keeps.
    await useOneDayRowWindows();
    const prerequisite = await insertTerminalTask("retention-held-edge", 30 * 24);
    const dependent = await insertTerminalTask("retention-held-edge-dependent", 4);
    await pool.query(
      `INSERT INTO workhorse.task_dependency(
         dependent_task_id, prerequisite_task_id, on_failure, on_cancellation, on_success,
         created_at, released_at, resolution
       ) VALUES ($1, $2, 'fail', 'cancel', 'release', clock_timestamp() - interval '5 hours',
                 clock_timestamp() - interval '5 hours', 'release')`,
      [dependent, prerequisite],
    );
    expectRowLagNear(await rowLag(), 4 * hourMs);
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM workhorse.task WHERE id = $1 FOR UPDATE", [prerequisite]);
      await queue.pruneTerminalStorage({ force: true });
      await locker.query("COMMIT");
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }
    expect(
      (
        await pool.query(
          "SELECT 1 FROM workhorse.task_dependency WHERE prerequisite_task_id = $1",
          [prerequisite],
        )
      ).rowCount,
    ).toBe(0);
    expect(await taskExists(prerequisite)).toBe(true);
    expectRowLagNear(await rowLag(), 4 * hourMs);
  });

  describe("the held_until write", () => {
    // The key phase and the released-edge phase take keys, edges, and outcomes with SKIP LOCKED,
    // so they never wait. An application write that needs a row that the pass wrote waits until
    // the pass commits, as it does for a row that cleanup deletes (ADR 0122).

    it("keeps a key for a later pass while another transaction holds its outcome", async () => {
      await useOneDayRowWindows();
      const heldKey = await keyedFailedTask(2);
      const heldOutcome = await keyedFailedTask(2);
      const holder = await pool.connect();
      const cleaner = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT 1 FROM workhorse.enqueue_idempotency WHERE task_id = $1 FOR UPDATE",
          [heldKey],
        );
        // A redrive takes the outcome of its source FOR SHARE.
        await holder.query("SELECT 1 FROM workhorse.task_outcome WHERE task_id = $1 FOR SHARE", [
          heldOutcome,
        ]);
        await cleaner.query("BEGIN");
        await cleaner.query("SET LOCAL lock_timeout = '1s'");
        await pruneKeys(cleaner);
        await cleaner.query("COMMIT");
        await holder.query("COMMIT");
      } finally {
        await cleaner.query("ROLLBACK").catch(() => undefined);
        await holder.query("ROLLBACK").catch(() => undefined);
        cleaner.release();
        holder.release();
      }
      const keys = async () =>
        (
          await pool.query<{ task_id: string }>(
            `SELECT task_id FROM workhorse.enqueue_idempotency WHERE task_id = ANY($1::uuid[])
              ORDER BY task_id`,
            [[heldKey, heldOutcome]],
          )
        ).rows.map((row) => row.task_id);
      // The pass skipped the held key. It needed to write the outcome of the other task to delete
      // its key, and it skipped that outcome, so that key stays too. Health counts both tasks from
      // the expiry of their keys.
      expect(await keys()).toEqual([heldKey, heldOutcome].toSorted());
      expect(await heldUntil(heldOutcome)).toBeNull();
      expectRowLagNear(await rowLag(), 2 * hourMs);
      // After the other transaction ends, the next pass deletes both keys and records the expiry.
      const cleaner2 = await pool.connect();
      try {
        await pruneKeys(cleaner2);
      } finally {
        cleaner2.release();
      }
      expect(await keys()).toEqual([]);
      expect(await heldUntil(heldOutcome)).not.toBeNull();
      expectRowLagNear(await rowLag(), 2 * hourMs);
    });

    it("keeps an edge for a later pass while another transaction holds its outcome", async () => {
      await useOneDayRowWindows();
      const edges: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const prerequisite = await insertTerminalTask("retention-held-edge-wait", 30 * 24);
        const dependent = await insertTerminalTask("retention-held-edge-wait-dependent", 4);
        await pool.query(
          `INSERT INTO workhorse.task_dependency(
             dependent_task_id, prerequisite_task_id, on_failure, on_cancellation, on_success,
             created_at, released_at, resolution
           ) VALUES ($1, $2, 'fail', 'cancel', 'release', clock_timestamp() - interval '5 hours',
                     clock_timestamp() - interval '5 hours', 'release')`,
          [dependent, prerequisite],
        );
        edges.push(prerequisite);
      }
      const [heldEdge, heldOutcome] = edges as [string, string];
      const holder = await pool.connect();
      const cleaner = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT 1 FROM workhorse.task_dependency WHERE prerequisite_task_id = $1 FOR UPDATE",
          [heldEdge],
        );
        await holder.query("SELECT 1 FROM workhorse.task_outcome WHERE task_id = $1 FOR SHARE", [
          heldOutcome,
        ]);
        await cleaner.query("BEGIN");
        await cleaner.query("SET LOCAL lock_timeout = '1s'");
        await cleaner.query("SELECT workhorse.prune_released_dependencies_v1(10)");
        await cleaner.query("COMMIT");
        await holder.query("COMMIT");
      } finally {
        await cleaner.query("ROLLBACK").catch(() => undefined);
        await holder.query("ROLLBACK").catch(() => undefined);
        cleaner.release();
        holder.release();
      }
      const left = await pool.query<{ prerequisite_task_id: string }>(
        `SELECT prerequisite_task_id FROM workhorse.task_dependency
          WHERE prerequisite_task_id = ANY($1::uuid[])`,
        [edges],
      );
      // The held outcome keeps its edge, so health counts its prerequisite from the finish of the
      // dependent.
      expect(left.rows.map((row) => row.prerequisite_task_id).toSorted()).toEqual(
        [heldEdge, heldOutcome].toSorted(),
      );
      expect(await heldUntil(heldOutcome)).toBeNull();
      expectRowLagNear(await rowLag(), 4 * hourMs);
      await pool.query("SELECT workhorse.prune_released_dependencies_v1(10)");
      expect(
        (
          await pool.query(
            "SELECT 1 FROM workhorse.task_dependency WHERE prerequisite_task_id = ANY($1::uuid[])",
            [edges],
          )
        ).rowCount,
      ).toBe(0);
      expect(await heldUntil(heldOutcome)).not.toBeNull();
      expectRowLagNear(await rowLag(), 4 * hourMs);
    });

    it.each([
      {
        lag: "outcome",
        outcomeDays: 1,
        createdDays: 40,
        finishedDays: 40,
        identityLagDays: 10,
        outcomeLagDays: 20,
      },
      {
        lag: "identity",
        outcomeDays: 30,
        createdDays: 70,
        finishedDays: 35,
        identityLagDays: 20,
        outcomeLagDays: 5,
      },
    ])(
      "records a key expiry that ends after the $lag window only",
      async ({ outcomeDays, createdDays, finishedDays, identityLagDays, outcomeLagDays }) => {
        // The identity window is 30 days, and the key expired 20 days ago. The expiry is inside one
        // row window and after the other, so it moves the due instant of one lag only. The phase
        // must still record it, and health must still count that lag from it.
        const identityDays = 30;
        await queue.syncMaintenancePolicy(
          { timezone: "UTC", historyRetentionLocalTime: "00:00" },
          { force: true },
        );
        await queue.syncRetentionPolicy({
          ...defaultRetentionPolicy,
          taskIdentityRetentionDays: identityDays,
          terminalOutcomeRetentionDays: outcomeDays,
          taskEventRetentionDays: 1,
          attemptHistoryRetentionDays: 1,
        });
        await pool.query(
          `UPDATE workhorse.maintenance_state
              SET history_retained_before = clock_timestamp() - interval '24 hours'
            WHERE routine_name = 'history_retention'`,
        );
        const taskId = await insertTerminalTask("retention-held-window", finishedDays * 24);
        await pool.query(
          `UPDATE workhorse.task SET created_at = clock_timestamp() - make_interval(hours => $2)
            WHERE id = $1`,
          [taskId, createdDays * 24],
        );
        await pool.query(
          `INSERT INTO workhorse.enqueue_idempotency(
             idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
           ) VALUES ('retention-held-window', sha256(convert_to($1::text, 'UTF8')), '{}'::jsonb,
                     $1::uuid, clock_timestamp() - interval '480 hours')`,
          [taskId],
        );
        const expectLags = async () => {
          const [identity, outcome] = await rowLag();
          expectRowLagNear([identity], identityLagDays * dayMs);
          expectRowLagNear([outcome], outcomeLagDays * dayMs);
        };
        await expectLags();
        await pool.query("SELECT workhorse.prune_enqueue_idempotency_v1(clock_timestamp(), 10)");
        expect(await heldUntil(taskId)).not.toBeNull();
        await expectLags();
      },
    );

    it("makes a redrive, an enqueue, and a completion wait at most until the pass commits", async () => {
      await useOneDayRowWindows();
      const source = await keyedFailedTask(2);
      const live = await queue.enqueue("retention-held-live", {});
      const cleaner = await pool.connect();
      const other = await pool.connect();
      try {
        await cleaner.query("BEGIN");
        await pruneKeys(cleaner);
        expect(
          (
            await cleaner.query<{ held_until: Date | null }>(
              "SELECT held_until FROM workhorse.task_outcome WHERE task_id = $1",
              [source],
            )
          ).rows[0]!.held_until,
        ).not.toBeNull();
        await other.query("SET lock_timeout = '300ms'");
        // A redrive takes the outcome that the pass wrote, so it waits for the pass.
        await expect(
          other.query("SELECT * FROM workhorse.redrive_v1($1, 'operator', 'wait', 'wait-1')", [
            source,
          ]),
        ).rejects.toMatchObject({ code: "55P03" });
        // An enqueue that writes the key that the pass deleted waits for the pass, as it does on
        // main, because the delete holds the key row until the commit.
        await expect(
          other.query(
            `INSERT INTO workhorse.enqueue_idempotency(
               idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
             ) VALUES ('retention-held-key', sha256(convert_to($1::text, 'UTF8')), '{}'::jsonb,
                       $2::uuid, clock_timestamp() + interval '1 hour')`,
            [source, live],
          ),
        ).rejects.toMatchObject({ code: "55P03" });
        // A claim and a completion of another task touch no row of the pass.
        const otherQueue = new Queue(other);
        const claimed = await otherQueue.claim("retention-held-worker");
        expect(claimed?.id).toBe(live);
        expect(await otherQueue.complete(claimed!, "retention-held-worker", {})).toBe(true);
        await cleaner.query("COMMIT");
        await other.query("RESET lock_timeout");
        const redriven = await other.query(
          "SELECT * FROM workhorse.redrive_v1($1, 'operator', 'after', 'after-1')",
          [source],
        );
        expect(redriven.rowCount).toBe(1);
      } finally {
        await cleaner.query("ROLLBACK").catch(() => undefined);
        await other.query("RESET lock_timeout").catch(() => undefined);
        cleaner.release();
        other.release();
      }
    });
  });

  it("records a backlog when a pass ends before it examined every row past the cutoffs", async () => {
    // More kept tasks than one health walk examines come first, so queue health reports no row lag.
    // With a limit of 1, the pass cannot delete all eligible tasks in its one second. It records a
    // backlog, and terminal-cleanup-backlog reports the late cleanup when that backlog outlasts its
    // budget.
    await useOneDayRowWindows(1);
    await pool.query(
      `WITH task AS (
         INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
         SELECT 'retention-late', CASE WHEN position <= 1100 THEN 'kept' ELSE 'eligible' END,
                '{}'::jsonb, 1, clock_timestamp() - interval '30 days' + make_interval(secs => position)
           FROM generate_series(1, 4100) position
         RETURNING id, task_type, created_at
       ), outcome AS (
         INSERT INTO workhorse.task_outcome(
           task_id, state, current_attempt, fence_token, run_at, result, finished_at,
           history_through_at
         )
         SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at FROM task
       )
       INSERT INTO workhorse.enqueue_idempotency(
         idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
       )
       SELECT 'retention-late', sha256(convert_to(id::text, 'UTF8')), '{}'::jsonb, id,
              clock_timestamp() + interval '30 days'
         FROM task WHERE task_type = 'kept'`,
    );
    await pool.query(
      "ANALYZE workhorse.task, workhorse.task_outcome, workhorse.enqueue_idempotency",
    );
    expect(await rowLag()).toEqual([null, null]);

    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases.find(({ phase }) => phase === "terminal_tasks")?.rowsAffected).toBeLessThan(3000);
    const state = await pool.query<{ since: Date | null }>(
      `SELECT terminal_cleanup_backlog_since AS since FROM workhorse.maintenance_state
        WHERE routine_name = 'terminal_storage'`,
    );
    expect(state.rows[0]!.since).not.toBeNull();

    // The passes stay behind for seven hours, longer than the default budget of six hours.
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET terminal_cleanup_backlog_since = clock_timestamp() - interval '7 hours'
        WHERE routine_name = 'terminal_storage'`,
    );
    expect((await queue.health()).status.reasons).toContainEqual(
      expect.objectContaining({ code: "terminal-cleanup-backlog", severity: "degraded" }),
    );
  });

  describe("a removed reference keeps the end of its hold", () => {
    // Each statement that removes a reference that a health gate skips saves the end of that hold
    // on the task that it held, so health still counts that task from the end (ADR 0122).

    it("an enqueue that reuses an expired key saves the expiry on the old task", async () => {
      await useOneDayRowWindows();
      const old = await agedKeyedTask("retention-reuse-saved");
      const before = await rowLag();
      expectRowLagNear(before, 2 * hourMs);
      await queue.enqueue("retention-reuse", {}, { idempotency: { key: "retention-reuse-saved" } });
      expect(await heldUntil(old)).not.toBeNull();
      expectSameRowLag(before, await rowLag());
    });

    it("an enqueue that reuses an expired key does not wait for a held outcome", async () => {
      await useOneDayRowWindows();
      const old = await agedKeyedTask("retention-reuse-held");
      const enqueued = await whileLocked(lockOutcomeForShare, [old], async () => {
        const client = await pool.connect();
        try {
          await client.query("SET lock_timeout = '300ms'");
          return await new Queue(client).enqueue(
            "retention-reuse",
            {},
            { idempotency: { key: "retention-reuse-held" } },
          );
        } finally {
          await client.query("RESET lock_timeout").catch(() => undefined);
          client.release();
        }
      });
      expect(enqueued).not.toBe(old);
      // The enqueue continued without the write, so this task counts from its windows until the
      // next cleanup pass deletes it.
      expect(await heldUntil(old)).toBeNull();
    });

    it("an enqueue with a new key or no key reads no outcome row", async () => {
      await useOneDayRowWindows();
      const old = await agedKeyedTask("retention-reuse-reads");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Each call runs in this one transaction, so its counters add up.
        const enqueue = (request: Record<string, unknown>) =>
          client.query("SELECT * FROM workhorse.enqueue_many_v1($1::jsonb)", [
            JSON.stringify([
              { queue: "default", type: "retention-reuse", payload: {}, ...request },
            ]),
          ]);
        const start = await outcomeReads(client);
        await enqueue({});
        await enqueue({ idempotency: { key: "fresh", ttlMs: 3_600_000 } });
        expect((await outcomeReads(client)) - start).toBe(0);
        // The reuse of an expired key reads the outcome of the old task, so the count works.
        await enqueue({ idempotency: { key: "retention-reuse-reads", ttlMs: 3_600_000 } });
        expect((await outcomeReads(client)) - start).toBeGreaterThan(0);
        await client.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      expect(await heldUntil(old)).toBeNull();
    });

    it("a cleanup batch that deletes a child saves its eligibility on the parent", async () => {
      await useOneDayRowWindows();
      const { parent, child } = await parentWithEligibleChild();
      const before = await rowLag();
      // Another transaction locks the parent, so the batch deletes only the child.
      await whileLocked(lockTaskForUpdate, [parent], () => pruneTerminalBatch());
      expect(await taskExists(child)).toBe(false);
      expect(await taskExists(parent)).toBe(true);
      expect(await heldUntil(parent)).not.toBeNull();
      expectSameRowLag(before, await rowLag());
    });

    it("a cleanup batch keeps a child while another transaction holds the parent outcome", async () => {
      await useOneDayRowWindows();
      const { parent, child } = await parentWithEligibleChild();
      // One holder locks the task of the parent, so only the child is a candidate, and the
      // outcome of the parent, as a redrive does.
      await whileLocked(
        `SELECT 1 FROM workhorse.task task
           JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
          WHERE task.id = $1
            FOR UPDATE OF task FOR SHARE OF outcome`,
        [parent],
        () => pruneTerminalBatch(),
      );
      expect(await taskExists(child)).toBe(true);
      expect(await heldUntil(parent)).toBeNull();
    });

    it("a cleanup batch that deletes a dependent saves its finish on the prerequisite", async () => {
      await useOneDayRowWindows();
      const { prerequisite, dependent } = await prerequisiteWithFinishedDependent();
      const before = await rowLag();
      expectRowLagNear(before, 26 * hourMs);
      // The batch runs alone, so the released-edge phase did not delete the edge first.
      await pruneTerminalBatch();
      expect(await taskExists(dependent)).toBe(false);
      expect(await taskExists(prerequisite)).toBe(true);
      expect(await heldUntil(prerequisite)).not.toBeNull();
      expectSameRowLag(before, await rowLag());
    });

    it("a cleanup batch that deletes a target saves the end on the redrive source", async () => {
      await useOneDayRowWindows();
      const { source, target } = await agedRedriveSource(true);
      // Another transaction locks the source, so the batch deletes only the target.
      await whileLocked(lockTaskForUpdate, [source], () => pruneTerminalBatch());
      expect(await taskExists(target)).toBe(false);
      expect(await taskExists(source)).toBe(true);
      expect(await heldUntil(source)).not.toBeNull();
      // The hold ended when the target went, so the source is late from that instant.
      expectRowLagNear(await rowLag(), 0);
    });

    it("the occurrence cleanup saves the end of the occurrence hold", async () => {
      await useOneDayRowWindows();
      const taskId = await taskWithExpiredOccurrence();
      const before = await rowLag();
      await pruneOccurrences();
      expect(await occurrenceCount(taskId)).toBe(0);
      expect(await heldUntil(taskId)).not.toBeNull();
      expectSameRowLag(before, await rowLag());
    });

    it("the occurrence cleanup keeps an occurrence while another transaction holds the outcome", async () => {
      await useOneDayRowWindows();
      const taskId = await taskWithExpiredOccurrence();
      await whileLocked(lockOutcomeForShare, [taskId], () => pruneOccurrences());
      expect(await occurrenceCount(taskId)).toBe(1);
      expect(await heldUntil(taskId)).toBeNull();
    });

    it("the deletion of a finished group saves its finish on the member that stays", async () => {
      await useOneDayRowWindows();
      const member = await insertTerminalTask("retention-held-member", 30 * 24);
      const group = await finishedGroupOf(member);
      const before = await rowLag();
      expectRowLagNear(before, 26 * hourMs);
      await pool.query(
        "SELECT workhorse.maintain_task_groups_v1(clock_timestamp() - interval '24 hours', 10)",
      );
      expect(await groupExists(group)).toBe(false);
      expect(await heldUntil(member)).not.toBeNull();
      expectSameRowLag(before, await rowLag());
    });

    it("keeps a finished group while another transaction holds a member outcome", async () => {
      await useOneDayRowWindows();
      const member = await insertTerminalTask("retention-held-member", 30 * 24);
      const group = await finishedGroupOf(member);
      await whileLocked(lockOutcomeForShare, [member], () =>
        pool.query(
          "SELECT workhorse.maintain_task_groups_v1(clock_timestamp() - interval '24 hours', 10)",
        ),
      );
      expect(await groupExists(group)).toBe(true);
      expect(await heldUntil(member)).toBeNull();
    });

    it("a queue purge that deletes a pending target saves the end on the redrive source", async () => {
      await useOneDayRowWindows();
      const { source, target } = await agedRedriveSource(false);
      const queueName = (
        await pool.query<{ queue_name: string }>(
          "SELECT queue_name FROM workhorse.task WHERE id = $1",
          [target],
        )
      ).rows[0]!.queue_name;
      await admin.purgeQueue(queueName, adminAudit("purge held target"));
      expect(await taskExists(target)).toBe(false);
      expect(await taskExists(source)).toBe(true);
      expect(await heldUntil(source)).not.toBeNull();
      expectRowLagNear(await rowLag(), 0);
    });

    it("a queue purge that deletes a pending dependent saves the end on the prerequisite", async () => {
      await useOneDayRowWindows();
      const prerequisite = await queue.enqueue("retention-purge-prerequisite", {});
      const dependent = await queue.enqueue(
        "retention-purge-dependent",
        {},
        { queue: "retention-purge-dependents", prerequisiteTaskId: prerequisite },
      );
      const task = await queue.claim("retention-purge-worker");
      expect(task?.id).toBe(prerequisite);
      expect(await queue.complete(task!, "retention-purge-worker", {})).toBe(true);
      await ageTerminalTask(prerequisite);
      await admin.purgeQueue("retention-purge-dependents", adminAudit("purge held dependent"));
      expect(await taskExists(dependent)).toBe(false);
      expect(await heldUntil(prerequisite)).not.toBeNull();
      expectRowLagNear(await rowLag(), 0);
    });

    it("a queue purge that deletes a pending child saves the end on the parent", async () => {
      await useOneDayRowWindows();
      const parentId = await queue.enqueue("retention-purge-parent", {});
      const parent = await queue.claim("retention-purge-worker");
      expect(parent?.id).toBe(parentId);
      await queue.createChild(
        parent!,
        "retention-purge-worker",
        "child",
        "retention-purge-child",
        {},
        {
          queue: "retention-purge-children",
        },
      );
      // A parent cannot complete while it has a pending child, so an operator cancels it.
      await pool.query("SELECT workhorse.cancel_v1($1, NULL, 'retention test')", [parentId]);
      expect(
        (await pool.query("SELECT 1 FROM workhorse.task_outcome WHERE task_id = $1", [parentId]))
          .rowCount,
      ).toBe(1);
      await ageTerminalTask(parentId);
      await admin.purgeQueue("retention-purge-children", adminAudit("purge held child"));
      expect(await heldUntil(parentId)).not.toBeNull();
      expectRowLagNear(await rowLag(), 0);
    });

    it("a cleanup batch saves the end on a parent that it keeps for a locked grandparent", async () => {
      // G is kept by its key and holds P, and P holds C. Another transaction locks the outcome of G,
      // so the batch keeps P. It then deletes C and saves the end of that hold on P.
      await useOneDayRowWindows();
      const grandparent = await insertTerminalTask("retention-held-grandparent", 30 * 24);
      await holdReferences["an enqueue key"](grandparent);
      const parent = await insertTerminalTask("retention-held-parent", 30 * 24);
      const child = await insertTerminalTask("retention-held-child", 27, 50);
      for (const [from, to] of [
        [grandparent, parent],
        [parent, child],
      ] as const) {
        await pool.query(
          `INSERT INTO workhorse.task_child(
             parent_task_id, child_task_id, child_name, request_fingerprint
           ) VALUES ($1, $2, $3, '{}'::jsonb)`,
          [from, to, `child-${to}`],
        );
      }
      const before = await rowLag();
      await whileLocked(lockOutcomeForShare, [grandparent], () => pruneTerminalBatch());
      expect(await taskExists(child)).toBe(false);
      expect(await taskExists(parent)).toBe(true);
      expect(await heldUntil(parent)).not.toBeNull();
      expectSameRowLag(before, await rowLag());
    });

    it("a cleanup batch and a purge that each delete one target both keep the source end", async () => {
      // The source has a finished target and a pending target. The batch deletes the first one
      // and has not committed when a purge deletes the second one.
      await useOneDayRowWindows();
      const { source, target: finished } = await agedRedriveSource(true);
      const pending = (await admin.redrive(source, adminAudit("second target"))).targetTaskId!;
      const queueName = (
        await pool.query<{ queue_name: string }>(
          "SELECT queue_name FROM workhorse.task WHERE id = $1",
          [pending],
        )
      ).rows[0]!.queue_name;
      const cleaner = await pool.connect();
      try {
        await cleaner.query("BEGIN");
        await cleaner.query(
          `SELECT workhorse.prune_terminal_tasks_v1(
                  clock_timestamp() - interval '24 hours', clock_timestamp() - interval '24 hours',
                  clock_timestamp() - interval '24 hours', 10)`,
        );
        await admin.purgeQueue(queueName, adminAudit("purge second target"));
        await cleaner.query("COMMIT");
      } finally {
        await cleaner.query("ROLLBACK").catch(() => undefined);
        cleaner.release();
      }
      expect(await taskExists(finished)).toBe(false);
      expect(await taskExists(pending)).toBe(false);
      expect(await taskExists(source)).toBe(true);
      expect(await heldUntil(source)).not.toBeNull();
    });

    it("a queue purge that deletes a pending fast-tier target saves the end on the source", async () => {
      // The queue of a full-tier source moved to the fast tier, so its redrive target is fast.
      await useOneDayRowWindows();
      const source = await createFailedTask({
        type: "retention-fast-source",
        queueName: "retention-fast",
      });
      await pool.query(
        "SELECT workhorse.set_queue_tier_v1('retention-fast', 'fast', 'operator', 'retention test')",
      );
      const target = (await admin.redrive(source, adminAudit("fast target"))).targetTaskId!;
      expect(
        (await pool.query("SELECT 1 FROM workhorse.fast_task_runtime WHERE task_id = $1", [target]))
          .rowCount,
      ).toBe(1);
      await ageTerminalTask(source);
      await admin.purgeQueue("retention-fast", adminAudit("purge fast target"));
      expect(await taskExists(target)).toBe(false);
      expect(await heldUntil(source)).not.toBeNull();
      expectRowLagNear(await rowLag(), 0);
    });
  });

  it("keeps the sweep position when a sweep batch fills its limit in a short slice", async () => {
    // Three old tasks are eligible behind the main position. The next batch is a sweep batch, and
    // its slice from the oldest row to the main position is short. It fills its limit of 1, so the
    // sweep continues after the task that it deleted, not from the oldest row again.
    const oldTasks = await passOldTasks(3);
    await pool.query(
      `UPDATE workhorse.terminal_prune_position
          SET sweep_next = true, sweep_finished_at = NULL, sweep_task_id = NULL
        WHERE tier = 'full'`,
    );
    expect(await pruneOneCall()).toBe(1);
    expect(await taskExists(oldTasks[0]!)).toBe(false);
    const position = await pool.query<{ sweep_task_id: string | null }>(
      "SELECT sweep_task_id FROM workhorse.terminal_prune_position WHERE tier = 'full'",
    );
    expect(position.rows[0]!.sweep_task_id).toBe(oldTasks[0]);
  });

  it("deletes a redrive source in the batch that deletes its last target", async () => {
    // A source stays while its target exists. When one call deleted the target and had room left,
    // the source waited for a later pass, and health counted it as lag from its own windows then.
    const source = await createFailedTask({ type: "redrive-same-batch-source" });
    const target = (await admin.redrive(source, adminAudit("same batch"))).targetTaskId!;
    const task = await queue.claim("redrive-same-batch-worker");
    expect(task?.id).toBe(target);
    expect(await queue.complete(task!, "redrive-same-batch-worker", { done: true })).toBe(true);
    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [
      [source, target],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      [source, target],
    ]);
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '41 days'
        WHERE id = ANY($1::uuid[])`,
      [[source, target]],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = ANY($1::uuid[])`,
      [[source, target]],
    );
    // The fast tier goes first, so the full tier gets the whole limit in one call.
    await pool.query(
      `UPDATE workhorse.maintenance_state SET terminal_prune_fast_first = true
        WHERE routine_name = 'terminal_storage'`,
    );
    const pruned = await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_tasks_v1(
              clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
              clock_timestamp() - interval '30 days', 2) AS pruned`,
    );
    expect(pruned.rows[0]!.pruned).toBe(2);
    expect(await taskExists(source)).toBe(false);
    expect(await taskExists(target)).toBe(false);
  });

  it("deletes a redrive chain in one batch while the batch has room", async () => {
    // A failed, an operator redrove it as B, B failed, and the operator redrove B as C. C
    // succeeded. One batch with room deletes C, then B, then A.
    const first = await createFailedTask({ type: "redrive-chain" });
    const second = (await admin.redrive(first, adminAudit("chain 1"))).targetTaskId!;
    const failing = await queue.claim("redrive-chain-worker");
    expect(failing?.id).toBe(second);
    expect(await queue.fail(failing!, "redrive-chain-worker", new Error("again"))).toBe("failed");
    const third = (await admin.redrive(second, adminAudit("chain 2"))).targetTaskId!;
    const last = await queue.claim("redrive-chain-worker");
    expect(last?.id).toBe(third);
    expect(await queue.complete(last!, "redrive-chain-worker", { done: true })).toBe(true);
    const chain = [first, second, third];
    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [chain]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      chain,
    ]);
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '41 days'
        WHERE id = ANY($1::uuid[])`,
      [chain],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = ANY($1::uuid[])`,
      [chain],
    );
    await pool.query(
      `UPDATE workhorse.maintenance_state SET terminal_prune_fast_first = true
        WHERE routine_name = 'terminal_storage'`,
    );
    const pruned = await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_tasks_v1(
              clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
              clock_timestamp() - interval '30 days', 10) AS pruned`,
    );
    expect(pruned.rows[0]!.pruned).toBe(3);
    for (const id of chain) expect(await taskExists(id)).toBe(false);
  });

  describe("row retention holds", () => {
    // Health counts a row as lag only when cleanup can delete it, or when cleanup or history
    // retention is late to remove the reference that keeps it (ADR 0122). Each case writes one
    // row that passed its windows 19 days ago, gives it one reference, and then checks the row lag
    // of health and the result of one cleanup pass. The lag counts from the end of a hold.
    type Hold = (taskId: string) => Promise<void>;
    const withHold = (hold: Hold) => async () => {
      const taskId = await insertTerminalTask("retention-hold-subject", 20 * 24);
      await hold(taskId);
      return taskId;
    };
    // "released" is the lag from the history pass that released the row, which is later than the end
    // of its row windows.
    const cases: Array<[string, () => Promise<string>, number | "released" | null, boolean]> = [
      ["no reference", withHold(async () => undefined), "released", true],
      ["a redrive target that is live", redriveSource, null, false],
      [
        "a dependency edge to a live dependent",
        withHold(holdReferences["a dependency edge to a live dependent"]),
        null,
        false,
      ],
      [
        "a released dependency edge to a dependent that finished 4 hours ago",
        withHold(async (taskId) => {
          const dependent = await insertTerminalTask("retention-hold-dependent", 4);
          await pool.query(
            `INSERT INTO workhorse.task_dependency(
               dependent_task_id, prerequisite_task_id, on_failure, on_cancellation, on_success,
               created_at, released_at, resolution
             ) VALUES ($1, $2, 'fail', 'cancel', 'release', clock_timestamp() - interval '5 hours',
                       clock_timestamp() - interval '5 hours', 'release')`,
            [dependent, taskId],
          );
        }),
        4 * hourMs,
        true,
      ],
      [
        "a live child",
        withHold(async (taskId) => {
          const child = await queue.enqueue("retention-hold-child", {});
          await pool.query(
            `INSERT INTO workhorse.task_child(
               parent_task_id, child_task_id, child_name, request_fingerprint
             ) VALUES ($1, $2, 'child', '{}'::jsonb)`,
            [taskId, child],
          );
        }),
        null,
        false,
      ],
      ["a child inside its windows", withHold(holdReferences["a young child"]), null, false],
      [
        "a child that passed its windows 5 hours ago",
        withHold(async (taskId) => {
          const child = await insertTerminalTask("retention-hold-child", 29, 72);
          await pool.query(
            `INSERT INTO workhorse.task_child(
               parent_task_id, child_task_id, child_name, request_fingerprint
             ) VALUES ($1, $2, 'child', '{}'::jsonb)`,
            [taskId, child],
          );
        }),
        5 * hourMs,
        true,
      ],
      [
        "a schedule occurrence inside its window",
        withHold(holdReferences["a schedule occurrence"]),
        null,
        false,
      ],
      [
        "a schedule occurrence that expired 3 hours ago",
        withHold(async (taskId) => {
          // The pass runs at the instant of the expiry, so the hold ends at the expiry.
          await pool.query(
            `UPDATE workhorse.maintenance_policy
                SET history_retention_local_time =
                      (date_trunc('second', clock_timestamp() - interval '3 hours')
                        AT TIME ZONE 'UTC')::time`,
          );
          await addHealthSchedule();
          await pool.query(
            `INSERT INTO workhorse.schedule_occurrence(
               namespace, schedule_name, occurrence_at, task_id
             ) VALUES ('integration', 'retention-holds',
                       date_trunc('second', clock_timestamp() - interval '3 hours')
                         - interval '24 hours', $1)`,
            [taskId],
          );
        }),
        3 * hourMs,
        false,
      ],
      [
        "an enqueue key that has not expired",
        withHold(holdReferences["an enqueue key"]),
        null,
        false,
      ],
      [
        "an enqueue key that expired 2 hours ago",
        withHold(async (taskId) => {
          await pool.query(
            `INSERT INTO workhorse.enqueue_idempotency(
               idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
             ) VALUES ('retention-holds', sha256(convert_to($1::text, 'UTF8')), '{}'::jsonb,
                       $1::uuid, clock_timestamp() - interval '2 hours')`,
            [taskId],
          );
        }),
        2 * hourMs,
        true,
      ],
      [
        "a history row",
        withHold(async (taskId) => {
          await pool.query(
            `INSERT INTO workhorse.task_event(task_id, event_type) VALUES ($1, 'retention-hold')`,
            [taskId],
          );
        }),
        "released",
        false,
      ],
    ];

    it.each(cases)("measures a row with %s", async (_name, subject, expectedLagMs, deleted) => {
      await useOneDayRowWindows();
      const taskId = await subject();

      const lag = await rowLag();
      const expected =
        expectedLagMs === "released" ? await releasedRowLagMs(20 * 24) : expectedLagMs;
      expectRowLag(lag, expected);
      await queue.pruneTerminalStorage({ force: true });
      expect(await taskExists(taskId)).toBe(!deleted);
    });

    it("counts a terminal row that still has a runtime row", async () => {
      // A runtime row with an outcome breaks the state model, so health does not hide it.
      await useOneDayRowWindows();
      const taskId = await queue.enqueue("retention-hold-runtime", {});
      await pool.query(
        `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '20 days'
          WHERE id = $1`,
        [taskId],
      );
      await pool.query(
        `INSERT INTO workhorse.task_outcome(
           task_id, state, current_attempt, fence_token, run_at, result, finished_at,
           history_through_at
         ) VALUES ($1, 'succeeded', 1, 1, clock_timestamp(), '{}'::jsonb,
                   clock_timestamp() - interval '20 days', clock_timestamp() - interval '20 days')`,
        [taskId],
      );
      await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [taskId]);

      expectRowLagNear(await rowLag(), await releasedRowLagMs(20 * 24));
      await queue.pruneTerminalStorage({ force: true });
      expect(await taskExists(taskId)).toBe(true);
    });
  });

  it("does not let a member that is not due hide an overdue member behind it", async () => {
    // Member A is older, but its group finished one minute ago, so it is due one minute ago.
    // Member B is younger, and its group finished five days ago. A walk that stops at the first
    // member in age order reports one minute; the overdue member is B (SM-1990).
    const workerId = "retention-health-worker";
    const callback = {
      type: "row-lag-behind-callback",
      payload: {},
      options: { queue: "callbacks" },
    };
    const oneMemberGroup = async (payload: number) => {
      const { group, tasks } = await queue.taskGroup(
        { onFinish: callback, onSuccess: callback, onFailure: callback },
        (builder) =>
          builder.add([
            { type: "row-lag-behind-member", payload, options: { queue: "row-lag-behind" } },
          ]),
      );
      return { groupId: group.id, taskId: tasks[0]!.taskId };
    };
    const memberA = await oneMemberGroup(1);
    const memberB = await oneMemberGroup(2);
    for (const task of await queue.claimMany(workerId, 10, { queue: "row-lag-behind" })) {
      expect(await queue.complete(task, workerId, { done: true })).toBe(true);
    }
    await useOneDayRowWindows();
    for (const [member, rowAge, groupAge] of [
      [memberA, "30 days", "1 minute"],
      [memberB, "20 days", "5 days"],
    ] as const) {
      await pool.query(
        `UPDATE workhorse.task SET created_at = clock_timestamp() - $2::interval WHERE id = $1`,
        [member.taskId, rowAge],
      );
      await pool.query(
        `UPDATE workhorse.task_outcome
            SET finished_at = clock_timestamp() - $2::interval,
                history_through_at = clock_timestamp() - $2::interval
          WHERE task_id = $1`,
        [member.taskId, rowAge],
      );
      await pool.query(
        `UPDATE workhorse.task_group SET finished_at = clock_timestamp() - $2::interval
          WHERE id = $1 AND state = 'finished'`,
        [member.groupId, groupAge],
      );
    }

    expectRowLagNear(await rowLag(), 5 * dayMs);
  });

  it("measures a retention window as a fixed number of hours in every session TimeZone", async () => {
    // A window of N days is N times 24 hours (ADR 0122). Choose N so that the window crosses one
    // daylight-saving change in New York. A calendar step of N days in a New York session is then
    // one hour longer or shorter than in a UTC session.
    const { rows } = await pool.query<{ days: number }>(
      `WITH clock AS (SELECT clock_timestamp() AS now)
       SELECT min(days)::integer AS days
         FROM clock CROSS JOIN generate_series(1, 400) days
        WHERE (clock.now AT TIME ZONE 'America/New_York')
              - ((clock.now - make_interval(hours => 24 * days)) AT TIME ZONE 'America/New_York')
              <> make_interval(hours => 24 * days)`,
    );
    const days = rows[0]!.days;
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: days,
      terminalOutcomeRetentionDays: days,
      // Short history windows put the history pass that releases the row long before its window.
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      scheduleOccurrenceRetentionDays: 1,
    });
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET history_retained_before = clock_timestamp()
        WHERE routine_name = 'history_retention'`,
    );
    await insertTerminalTask("fixed-window", (days + 3) * 24);
    const health = async (timeZone: string) => {
      const client = await pool.connect();
      try {
        await client.query(`SET TIME ZONE '${timeZone}'`);
        return await new Queue(client).health();
      } finally {
        await client.query("RESET TIME ZONE");
        client.release();
      }
    };
    const utc = await health("UTC");
    const newYork = await health("America/New_York");
    expect(utc.retentionLagMs.taskIdentity).toBeGreaterThan(0);
    expect(newYork.retentionLagMs.taskIdentity).toBeCloseTo(utc.retentionLagMs.taskIdentity!, -4);
    expect(newYork.retentionLagMs.terminalOutcome).toBeCloseTo(
      utc.retentionLagMs.terminalOutcome!,
      -4,
    );
  });

  it("writes no retention window as a calendar step of days in the tracked schema", async () => {
    // make_interval(days => n) steps calendar days in the session TimeZone. Each retention window
    // in the schema is a fixed number of hours instead (ADR 0122).
    const schema = await readFile(
      new URL("../../../sql/schema/current.sql", import.meta.url),
      "utf8",
    );
    expect(schema).not.toMatch(/make_interval\(\s*days\s*=>/);
  });

  describe("schedule-run retention health", () => {
    // The fixture keeps schedule runs for 14 days and allows 6 hours of row-retention lag.
    const budgetMs = 21_600_000;

    it("ignores schedule runs that expire between daily passes", async () => {
      await addScheduleRun(8 - 1 / 60, 9);
      await recordPass(8, "started");

      const health = await queue.health();
      expect(health.retentionLagMs.scheduleOccurrences).toBeGreaterThan(budgetMs);
      expect(await scheduleRunLagReported()).toBe(false);
    });

    it("reports schedule runs a pass left behind and clears them once passes catch up", async () => {
      await queue.syncRetentionPolicy({ ...defaultRetentionPolicy, occurrenceRowsPerPass: 1 });
      await addScheduleRun(10, 24);
      await addScheduleRun(9, 24);

      await queue.retainHistory({ force: true });
      expect(await scheduleRunLagReported()).toBe(true);

      await queue.retainHistory({ force: true });
      expect(await scheduleRunLagReported()).toBe(false);
    });

    it("ignores schedule runs fired after the latest pass started", async () => {
      await addScheduleRun(15, 1);
      await recordPass(8, null);

      expect(await scheduleRunLagReported()).toBe(false);
    });

    it("reports an overdue pass only after the budget and while expired runs remain", async () => {
      await addScheduleRun(8, 9);
      await recordPass(29, "started");
      expect(await scheduleRunLagReported()).toBe(false);

      await recordPass(31, "started");
      expect(await scheduleRunLagReported()).toBe(true);

      await pool.query(`DELETE FROM workhorse.schedule_occurrence`);
      await addScheduleRun(-1, 9);
      expect(await scheduleRunLagReported()).toBe(false);
    });

    it("dates an unrun pass from the oldest expired run at any time of day", async () => {
      // The scheduled time was an hour ago, so a due time that restarts daily would read one hour.
      await pool.query(
        `UPDATE workhorse.maintenance_policy
            SET history_retention_local_time =
                  ((clock_timestamp() - interval '1 hour') AT TIME ZONE 'UTC')::time(0)`,
      );
      await addScheduleRun(8, 9);
      expect(await scheduleRunLagReported()).toBe(false);

      await addScheduleRun(30, 31);
      expect(await scheduleRunLagReported()).toBe(true);
    });

    it("dates an unrun pass by instant when daylight saving time ends", async () => {
      // The run expires at 01:45 EDT, before the scheduled 01:30 repeats as 06:30 UTC.
      await pool.query(
        `UPDATE workhorse.maintenance_policy
            SET timezone = 'America/New_York', history_retention_local_time = '01:30'`,
      );
      await pool.query(
        `INSERT INTO workhorse.schedule_definition(
           namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
         ) VALUES ('integration', 'health-cadence', '0 * * * *', 'default', 'health-cadence',
                   '{}'::jsonb, 3)`,
      );
      await pool.query(
        `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at, fired_at)
         VALUES ('integration', 'health-cadence',
                 '2026-10-18T05:45:00Z', '2026-10-18T05:45:00Z')`,
      );

      // Queue health reads clock_timestamp(), so this session resolves it to a fixed instant. A UTC
      // session keeps the 14-day window from gaining the hour that New York repeats.
      const client = await pool.connect();
      const reportedAt = async (now: string) => {
        await client.query(
          `CREATE OR REPLACE FUNCTION fixed_clock.clock_timestamp() RETURNS timestamptz
             LANGUAGE sql AS $$ SELECT '${now}'::timestamptz $$`,
        );
        const { rows } = await client.query<{ reported: boolean }>(
          `SELECT jsonb_path_exists(
                    workhorse.queue_health_v1($1::timestamptz)->'status'->'reasons',
                    '$[*] ? (@.code == "retention-lag" && @.category == "scheduleOccurrences")'
                  ) AS reported`,
          [now],
        );
        return rows[0]?.reported;
      };
      try {
        await client.query("CREATE SCHEMA fixed_clock");
        await client.query("SET search_path TO fixed_clock, pg_catalog, public");
        await client.query("SET TIME ZONE 'UTC'");
        expect(await reportedAt("2026-11-01T12:29:00Z")).toBe(false);
        expect(await reportedAt("2026-11-01T12:31:00Z")).toBe(true);
      } finally {
        await client.query("RESET search_path");
        await client.query("RESET TIME ZONE");
        await client.query("DROP SCHEMA IF EXISTS fixed_clock CASCADE");
        client.release();
      }
    });

    it("follows the latest start while other history keeps a pass incomplete", async () => {
      // Incomplete event retention reruns the pass every tick, so its last completed date goes stale.
      await addScheduleRun(6, 6);
      await recordPass(7, "earlier");

      expect(await scheduleRunLagReported()).toBe(false);
    });

    it("stops measuring a pass that ran under a replaced retention window", async () => {
      await addScheduleRun(15, 9);
      await recordPass(8, null);
      expect(await scheduleRunLagReported()).toBe(true);

      await queue.syncRetentionPolicy({
        ...defaultRetentionPolicy,
        scheduleOccurrenceRetentionDays: 13,
      });
      expect(await scheduleRunLagReported()).toBe(false);
    });

    it("keeps the raw budget for other retention categories", async () => {
      const evaluated = await pool.query<{
        status: { reasons: Array<{ code: string; category?: string }> };
      }>(
        `SELECT workhorse.evaluate_queue_health_v1(
           (workhorse.queue_health_v1() - 'status') || jsonb_build_object(
             'task_identity_lag_ms', $1::numeric + 1
           ),
           to_jsonb(workhorse.get_queue_health_policy_v1())
         ) AS status`,
        [budgetMs],
      );
      expect(evaluated.rows[0]?.status.reasons).toContainEqual(
        expect.objectContaining({ code: "retention-lag", category: "taskIdentity" }),
      );
    });
  });

  it("prepares more history days than the snapshot demands over a full preparation interval", async () => {
    // Workhorse demands prepared storage for today and the three days after it, while preparation
    // runs on an elapsed-time cadence that notices nothing at the UTC midnight boundary. When both
    // windows were four days wide, every rollover left the furthest demanded day uncreated until
    // the next pass, so the queue read critical with missing-history-partitions once a day.
    const snapshotHorizonDays = 3;
    const intervalsMs = [60_000, 21_600_000, 86_400_000, 604_800_000];

    // At every cadence the policy accepts, the horizon covers the days the UTC date can advance
    // before the next pass and still leaves slack for a pass that starts late.
    const slack = await pool.query<{ interval_ms: number; least_slack: number }>(
      `SELECT intervals.interval_ms,
              min(horizon.days - (advanced.days + $1))::integer AS least_slack
         FROM unnest($2::integer[]) AS intervals(interval_ms)
         CROSS JOIN LATERAL (
           SELECT workhorse.history_partition_horizon_days_v1(intervals.interval_ms) AS days
         ) horizon
         CROSS JOIN generate_series(0, 23) AS offsets(hour)
         CROSS JOIN LATERAL (
           SELECT ((started.at + make_interval(secs => intervals.interval_ms / 1000.0))
                     AT TIME ZONE 'UTC')::date
                - (started.at AT TIME ZONE 'UTC')::date AS days
             FROM (
               SELECT timestamptz '2026-03-01 00:00:00+00'
                    + make_interval(hours => offsets.hour) AS at
             ) started
         ) advanced
        GROUP BY intervals.interval_ms
        ORDER BY intervals.interval_ms`,
      [snapshotHorizonDays, intervalsMs],
    );
    expect(slack.rows).toEqual(
      intervalsMs.map((intervalMs) => ({
        interval_ms: intervalMs,
        least_slack: expect.any(Number) as number,
      })),
    );
    for (const row of slack.rows) {
      expect({ intervalMs: row.interval_ms, atLeastOneDay: row.least_slack >= 1 }).toEqual({
        intervalMs: row.interval_ms,
        atLeastOneDay: true,
      });
    }

    // A pass that lands a second before a UTC midnight is the worst case: the date advances at
    // once, and nothing prepares storage again until the whole interval has elapsed.
    const preparedAt = Date.parse("2087-04-10T23:59:59.000Z");
    const configured = await pool.query<{ interval_ms: number }>(
      `SELECT partition_preparation_interval_ms AS interval_ms
         FROM workhorse.maintenance_policy WHERE singleton`,
    );
    const state = await pool.query<{ started_at: Date | null; completed_at: Date | null }>(
      `SELECT last_started_at AS started_at, last_completed_at AS completed_at
         FROM workhorse.maintenance_state WHERE routine_name = 'history_partitions'`,
    );
    const marker = (await pool.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at;
    try {
      for (const intervalMs of intervalsMs) {
        await pool.query(
          `UPDATE workhorse.maintenance_policy SET partition_preparation_interval_ms = $1
            WHERE singleton`,
          [intervalMs],
        );
        await pool.query("SELECT workhorse.prepare_history_partitions_v1(true, $1::timestamptz)", [
          new Date(preparedAt).toISOString(),
        ]);
        const missing = await pool.query<{ missing: number }>(
          `SELECT count(*)::integer AS missing
             FROM generate_series(
               date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC'),
               date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC') + interval '3 days',
               interval '1 day'
             ) AS demanded(day_start)
            WHERE to_regclass(
                    format('workhorse.%I', 'task_event_' || to_char(demanded.day_start, 'YYYYMMDD'))
                  ) IS NULL
               OR to_regclass(
                    format(
                      'workhorse.%I',
                      'attempt_history_' || to_char(demanded.day_start, 'YYYYMMDD')
                    )
                  ) IS NULL`,
          [new Date(preparedAt + intervalMs).toISOString()],
        );
        expect({ intervalMs, missing: missing.rows[0]?.missing }).toEqual({
          intervalMs,
          missing: 0,
        });
      }
    } finally {
      await pool.query(
        `UPDATE workhorse.maintenance_policy SET partition_preparation_interval_ms = $1
          WHERE singleton`,
        [configured.rows[0]!.interval_ms],
      );
      await pool.query(
        `UPDATE workhorse.maintenance_state
            SET last_started_at = $1, last_completed_at = $2
          WHERE routine_name = 'history_partitions'`,
        [state.rows[0]?.started_at ?? null, state.rows[0]?.completed_at ?? null],
      );
      await pool.query(
        `DELETE FROM workhorse.maintenance_run
          WHERE routine_name = 'history_partitions' AND started_at >= $1`,
        [marker],
      );
      await pool.query(`DO $$
        DECLARE leftover record;
        BEGIN
          FOR leftover IN
            SELECT relation.relname AS name
              FROM pg_class relation
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'workhorse'
               AND relation.relkind = 'r'
               AND (relation.relname LIKE 'task_event_2087%'
                 OR relation.relname LIKE 'attempt_history_2087%')
          LOOP
            EXECUTE format('DROP TABLE IF EXISTS workhorse.%I', leftover.name);
          END LOOP;
        END $$`);
    }
  });

  it("creates and retires completed daily history partitions", async () => {
    const oldDay = "2020-01-08";
    const historicalTimestamp = "2020-01-08T12:00:00.000Z";
    const historicalTaskId = "00000000-0000-4000-8000-000000000001";
    await pool.query(
      `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts, created_at)
       VALUES ($1, 'default', 'historical', '{}'::jsonb, 1, $2)`,
      [historicalTaskId, historicalTimestamp],
    );
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
       VALUES ($1, 'fallback', $2)`,
      [historicalTaskId, historicalTimestamp],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, occurred_at
       ) VALUES ($1, 1, 1, 'fallback-worker', 'succeeded', $2, $2, $2, $2)`,
      [historicalTaskId, historicalTimestamp],
    );
    const fallbackRelations = await pool.query<{ relation: string }>(
      `
      SELECT tableoid::regclass::text AS relation FROM workhorse.task_event WHERE task_id = $1
      UNION ALL
      SELECT tableoid::regclass::text FROM workhorse.attempt_history WHERE task_id = $1
      ORDER BY relation`,
      [historicalTaskId],
    );
    expect(fallbackRelations.rows).toEqual([
      { relation: "attempt_history_default" },
      { relation: "task_event_default" },
    ]);
    const fallbackIdentities = (
      await pool.query<{ event_id: string; attempt_id: string }>(
        `SELECT event.event_id::text, history.attempt_id::text
           FROM workhorse.task_event event
           JOIN workhorse.attempt_history history USING (task_id)
          WHERE event.task_id = $1`,
        [historicalTaskId],
      )
    ).rows[0];

    await pool.query("SELECT workhorse.create_history_day_v1($1)", [oldDay]);
    expect(
      (await pool.query("SELECT to_regclass('workhorse.task_event_20200108') AS relation")).rows[0]
        .relation,
    ).not.toBeNull();
    expect(
      (await pool.query("SELECT to_regclass('workhorse.attempt_history_20200108') AS relation"))
        .rows[0].relation,
    ).not.toBeNull();
    const migratedRelations = await pool.query<{ relation: string }>(
      `
      SELECT tableoid::regclass::text AS relation FROM workhorse.task_event WHERE task_id = $1
      UNION ALL
      SELECT tableoid::regclass::text FROM workhorse.attempt_history WHERE task_id = $1
      ORDER BY relation`,
      [historicalTaskId],
    );
    expect(migratedRelations.rows).toEqual([
      { relation: "attempt_history_20200108" },
      { relation: "task_event_20200108" },
    ]);
    expect(
      (
        await pool.query<{ event_id: string; attempt_id: string }>(
          `SELECT event.event_id::text, history.attempt_id::text
             FROM workhorse.task_event event
             JOIN workhorse.attempt_history history USING (task_id)
            WHERE event.task_id = $1`,
          [historicalTaskId],
        )
      ).rows[0],
    ).toEqual(fallbackIdentities);
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [oldDay]);
    expect(
      (await pool.query("SELECT to_regclass('workhorse.task_event_20200108') AS relation")).rows[0]
        .relation,
    ).toBeNull();
    await expect(
      pool.query(
        "SELECT workhorse.retire_history_day_v1((clock_timestamp() AT TIME ZONE 'UTC')::date)",
      ),
    ).rejects.toThrow(/only completed history days can be retired/);
  });

  it("creates a history partition without deadlocking a concurrent retry transition", async () => {
    const gate = await pool.connect();
    const observer = await pool.connect();
    const futureDay = "2098-08-10";
    const lockKey = "workhorse:test:history-partition-transition";
    const id = await queue.enqueue("partition-transition", {}, { maxAttempts: 2 });
    const task = await queue.claim("partition-transition-worker");
    expect(task?.id).toBe(id);

    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION workhorse.test_pause_attempt_history_insert()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(
            hashtextextended('workhorse:test:history-partition-transition', 0)
          );
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_pause_attempt_history_insert
        BEFORE INSERT ON workhorse.attempt_history
        FOR EACH ROW EXECUTE FUNCTION workhorse.test_pause_attempt_history_insert();
      `);
      await gate.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);

      const failing = queue.fail(
        task!,
        "partition-transition-worker",
        new Error("expected retry"),
        0,
      );
      await waitForDatabaseCondition(async () => {
        const result = await observer.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
             WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND wait_event_type = 'Lock'
               AND query LIKE 'SELECT workhorse.fail_v1%'
          ) AS waiting`);
        return result.rows[0]!.waiting;
      });

      const partitioning = pool.query("SELECT workhorse.create_history_day_v1($1)", [futureDay]);
      await waitForDatabaseCondition(async () => {
        const result = await observer.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
             WHERE relation = 'workhorse.attempt_history'::regclass
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND mode = 'AccessExclusiveLock'
               AND NOT granted
          ) AS waiting`);
        return result.rows[0]!.waiting;
      });

      await gate.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      expect(await Promise.allSettled([failing, partitioning])).toEqual([
        expect.objectContaining({ status: "fulfilled", value: "ready" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
    } finally {
      await gate.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      gate.release();
      observer.release();
      await pool.query(
        "DROP TRIGGER IF EXISTS test_pause_attempt_history_insert ON workhorse.attempt_history",
      );
      await pool.query("DROP FUNCTION IF EXISTS workhorse.test_pause_attempt_history_insert()");
      await pool.query("DROP TABLE IF EXISTS workhorse.task_event_20980810");
      await pool.query("DROP TABLE IF EXISTS workhorse.attempt_history_20980810");
    }
  });

  it("replenishes the three-day history partition horizon during partition preparation", async () => {
    await pool.query(`
      DO $$
      DECLARE day_offset integer;
      DECLARE suffix text;
      BEGIN
        FOR day_offset IN 2..3 LOOP
          suffix := to_char(
            (clock_timestamp() AT TIME ZONE 'UTC')::date + day_offset,
            'YYYYMMDD'
          );
          EXECUTE format('DROP TABLE workhorse.%I', 'task_event_' || suffix);
          EXECUTE format('DROP TABLE workhorse.%I', 'attempt_history_' || suffix);
        END LOOP;
      END
      $$`);
    expect(await queue.prepareHistoryPartitions({ force: true })).toMatchObject([
      { phase: "history_partitions", rowsAffected: 2, skippedLock: false, error: null },
    ]);
    const horizon = await pool.query<{ missing: number }>(`
      SELECT count(*) FILTER (
               WHERE to_regclass(format('workhorse.%I', 'task_event_' || suffix)) IS NULL
                  OR to_regclass(format('workhorse.%I', 'attempt_history_' || suffix)) IS NULL
             )::integer AS missing
        FROM (
          SELECT to_char(
                   (clock_timestamp() AT TIME ZONE 'UTC')::date + day_offset,
                   'YYYYMMDD'
                 ) AS suffix
            FROM generate_series(0, 3) AS days(day_offset)
        ) expected`);
    expect(horizon.rows[0]?.missing).toBe(0);
  });

  it("defers a history day while a reader holds a parent lock and creates it on a later pass", async () => {
    const reader = await pool.connect();
    const observer = await pool.connect();
    const caller = await pool.connect();
    const { rows } = await pool.query<{ day: string; suffix: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, to_char(day, 'YYYYMMDD') AS suffix
         FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date + 3 AS day) horizon`,
    );
    const { day, suffix } = rows[0]!;
    const dayExists = async () =>
      (
        await pool.query<{ exists: boolean }>(
          `SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS exists`,
          [`workhorse.task_event_${suffix}`, `workhorse.attempt_history_${suffix}`],
        )
      ).rows[0]!.exists;
    const exclusiveRequestWaits = async () =>
      (
        await observer.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
              WHERE relation = 'workhorse.task_event'::regclass
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND mode = 'AccessExclusiveLock' AND NOT granted
           ) AS waiting`,
        )
      ).rows[0]!.waiting;
    // Polls without a pause, because the bounded request waits only a short time.
    const pollUntil = async (expected: boolean, limitMs: number) => {
      const startedAt = performance.now();
      while (performance.now() - startedAt < limitMs) {
        if ((await exclusiveRequestWaits()) === expected) return performance.now();
      }
      throw new Error(`the exclusive request did not ${expected ? "start" : "end"} waiting`);
    };
    await pool.query(`DROP TABLE workhorse.task_event_${suffix}`);
    await pool.query(`DROP TABLE workhorse.attempt_history_${suffix}`);
    await pool.query(
      `UPDATE workhorse.maintenance_state SET last_completed_at = NULL
        WHERE routine_name = 'history_partitions'`,
    );

    let readerOpen = false;
    try {
      // pg_dump takes ACCESS SHARE on each table it reads and keeps it until it ends.
      await reader.query("BEGIN");
      readerOpen = true;
      await reader.query("LOCK TABLE ONLY workhorse.task_event IN ACCESS SHARE MODE");

      const maintenance = queue.runMaintenance();
      const waitStartedAt = await pollUntil(true, 10_000);
      // A lifecycle transition that starts behind an unbounded ACCESS EXCLUSIVE request waits
      // until the reader ends. The bounded request lets it continue while the reader still runs.
      const lifecycle = (async () => {
        const id = await queue.enqueue("partition-lock-reader", {});
        const task = await queue.claim("partition-lock-worker");
        expect(task?.id).toBe(id);
        return queue.complete(task!, "partition-lock-worker", { done: true });
      })();
      const waitEndedAt = await pollUntil(false, 10_000);
      // The limit is 250 ms. The margin allows for a loaded host.
      expect(waitEndedAt - waitStartedAt).toBeLessThan(2_000);
      const deadline = sleep(10_000, "timed out", { ref: false });
      await expect(Promise.race([lifecycle, deadline])).resolves.toBe(true);
      expect(
        (await maintenance).find((result) => result.phase === "history_partitions"),
      ).toMatchObject({ rowsAffected: 0, skippedLock: true, error: null });
      await expect(
        pool.query(
          `SELECT run.outcome, run.phases->0->>'deferredDay' AS deferred_day,
                  state.last_completed_at
             FROM workhorse.maintenance_run run
             JOIN workhorse.maintenance_state state USING (routine_name)
            WHERE run.routine_name = 'history_partitions'
            ORDER BY run.started_at DESC, run.run_id DESC LIMIT 1`,
        ),
      ).resolves.toMatchObject({
        rows: [{ outcome: "incomplete", deferred_day: day, last_completed_at: null }],
      });
      expect(await dayExists()).toBe(false);

      // A deferral restores the caller's lock_timeout for the rest of its transaction.
      await caller.query("BEGIN");
      await caller.query("SET LOCAL lock_timeout = '7s'");
      await expect(
        caller.query("SELECT * FROM workhorse.prepare_history_partitions_v1(true)"),
      ).resolves.toMatchObject({ rows: [{ skipped_lock: true, error: null }] });
      await expect(caller.query("SHOW lock_timeout")).resolves.toMatchObject({
        rows: [{ lock_timeout: "7s" }],
      });
      await caller.query("ROLLBACK");

      await reader.query("COMMIT");
      readerOpen = false;
      expect(
        (await queue.runMaintenance()).find((result) => result.phase === "history_partitions"),
      ).toMatchObject({ rowsAffected: 1, skippedLock: false, error: null });
      expect(await dayExists()).toBe(true);
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      if (readerOpen) await reader.query("ROLLBACK").catch(() => undefined);
      reader.release();
      observer.release();
      caller.release();
    }
  });

  it("runs partition retirement and creation after terminal cleanup so it holds no parent lock", async () => {
    const gate = await pool.connect();
    const observer = await pool.connect();
    const lockKey = "workhorse:test:maintenance-after-partitions";
    const { rows } = await pool.query<{ suffix: string }>(
      `SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date + 3, 'YYYYMMDD') AS suffix`,
    );
    const { suffix } = rows[0]!;
    const expiredDay = "2018-01-01";
    const partitions = async () =>
      (
        await observer.query<{ expired: boolean; created: boolean }>(
          `SELECT to_regclass('workhorse.task_event_20180101') IS NOT NULL
                    AND to_regclass('workhorse.attempt_history_20180101') IS NOT NULL AS expired,
                  to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS created`,
          [`workhorse.task_event_${suffix}`, `workhorse.attempt_history_${suffix}`],
        )
      ).rows[0];
    await pool.query(`DROP TABLE workhorse.task_event_${suffix}`);
    await pool.query(`DROP TABLE workhorse.attempt_history_${suffix}`);
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [expiredDay]);
    // Daily retention, terminal cleanup, and partition preparation are all due in this pass.
    await pool.query(
      `UPDATE workhorse.maintenance_policy SET history_retention_local_time = '00:00:00'`,
    );
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET last_completed_at = NULL, last_completed_local_date = NULL
        WHERE routine_name IN ('history_partitions', 'terminal_storage', 'history_retention')`,
    );

    try {
      // Terminal cleanup starts by marking its maintenance_state row. The trigger pauses it there.
      await pool.query(`
        CREATE OR REPLACE FUNCTION workhorse.test_pause_terminal_storage()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.routine_name = 'terminal_storage' THEN
            PERFORM pg_advisory_xact_lock(
              hashtextextended('workhorse:test:maintenance-after-partitions', 0)
            );
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_pause_terminal_storage
        BEFORE UPDATE ON workhorse.maintenance_state
        FOR EACH ROW EXECUTE FUNCTION workhorse.test_pause_terminal_storage();
      `);
      await gate.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);

      const maintenance = queue.runMaintenance();
      await waitForDatabaseCondition(async () => {
        const result = await observer.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           ) AS waiting`,
        );
        return result.rows[0]!.waiting;
      });
      // Terminal cleanup is paused inside the maintenance call. Retention has not retired the
      // expired day yet, and no history parent may be locked exclusively, so lifecycle
      // transitions keep running.
      expect(await partitions()).toEqual({ expired: true, created: false });
      await expect(
        observer.query<{ locked: string[] }>(
          `SELECT COALESCE(array_agg(relation::regclass::text ORDER BY relation::regclass::text),
                           '{}') AS locked
             FROM pg_locks
            WHERE relation IN ('workhorse.task_event'::regclass,
                               'workhorse.attempt_history'::regclass)
              -- Every scratch database copies one template, so the relation OIDs repeat in the
              -- databases of the other test files that run at the same time.
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND mode = 'AccessExclusiveLock'`,
        ),
      ).resolves.toMatchObject({ rows: [{ locked: [] }] });
      const id = await queue.enqueue("partition-lock-order", {});
      const task = await queue.claim("partition-lock-order-worker");
      expect(task?.id).toBe(id);

      await gate.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      const phases = await maintenance;
      expect(phases.map((result) => result.phase)).toEqual([
        expect.stringMatching(/^stat_/),
        ...phases.slice(1, -9).map(() => expect.stringMatching(/^stat_/)),
        "enqueue_idempotency",
        "released_dependencies",
        "terminal_tasks",
        "task_groups",
        "worker_registry",
        "event_retention",
        "attempt_retention",
        "schedule_occurrences",
        "history_partitions",
      ]);
      expect(phases.find((result) => result.phase === "event_retention")).toMatchObject({
        rowsAffected: 1,
        error: null,
      });
      expect(phases.find((result) => result.phase === "attempt_retention")).toMatchObject({
        rowsAffected: 1,
        error: null,
      });
      expect(phases.find((result) => result.phase === "history_partitions")).toMatchObject({
        rowsAffected: 1,
        skippedLock: false,
        error: null,
      });
      expect(await partitions()).toEqual({ expired: false, created: true });
    } finally {
      await gate.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      gate.release();
      observer.release();
      await pool.query(
        "DROP TRIGGER IF EXISTS test_pause_terminal_storage ON workhorse.maintenance_state",
      );
      await pool.query("DROP FUNCTION IF EXISTS workhorse.test_pause_terminal_storage()");
    }
  });

  it("repairs a partially missing daily history partition", async () => {
    const day = "2021-02-01";
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [day]);
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [day]);
    await pool.query("DROP TABLE workhorse.attempt_history_20210201");

    await expect(
      pool.query("SELECT workhorse.create_history_day_v1($1)", [day]),
    ).resolves.toBeDefined();
    expect(
      (
        await pool.query(
          `SELECT to_regclass('workhorse.task_event_20210201') IS NOT NULL AS event_exists,
                  to_regclass('workhorse.attempt_history_20210201') IS NOT NULL AS attempt_exists`,
        )
      ).rows[0],
    ).toEqual({ event_exists: true, attempt_exists: true });
  });

  it("stages a history day in pg_temp even when the search path names a writable schema first", async () => {
    const day = "2017-07-07";
    const suffix = "20170707";
    const occurredAt = `${day}T06:00:00Z`;
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [day]);
    const identity = await pool.query<{ id: string }>(
      `INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
       VALUES ('default', 'pg-temp-staging', '{}'::jsonb, 1, $1) RETURNING id`,
      [occurredAt],
    );
    const taskId = identity.rows[0]!.id;
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, event_type, occurred_at) VALUES ($1, 'staged', $2)`,
      [taskId, occurredAt],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, occurred_at
       ) VALUES ($1, 1, 1, 'pg-temp-worker', 'succeeded', $2, $2, $2)`,
      [taskId, occurredAt],
    );

    const planting = await pool.connect();
    try {
      await planting.query("CREATE SCHEMA planted_staging");
      // The names the function gives its staging tables, with the same shape, in a schema the
      // session searches before pg_temp. An unqualified reference finds these instead.
      await planting.query(
        `CREATE TABLE planted_staging.workhorse_task_event_${suffix}
           (LIKE workhorse.task_event INCLUDING DEFAULTS)`,
      );
      await planting.query(
        `CREATE TABLE planted_staging.workhorse_attempt_history_${suffix}
           (LIKE workhorse.attempt_history INCLUDING DEFAULTS)`,
      );
      await planting.query(
        `INSERT INTO planted_staging.workhorse_task_event_${suffix}(task_id, event_type, occurred_at)
         VALUES ($1, 'planted', $2)`,
        [taskId, occurredAt],
      );
      await planting.query(
        `INSERT INTO planted_staging.workhorse_attempt_history_${suffix}(
           task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, occurred_at
         ) VALUES ($1, 2, 2, 'planted-worker', 'failed', $2, $2, $2)`,
        [taskId, occurredAt],
      );
      await planting.query("SET search_path TO planted_staging, pg_temp, public");

      await planting.query("SELECT workhorse.create_history_day_v1($1)", [day]);

      // The planted tables survive, so maintenance dropped its own staging tables rather than
      // theirs, and the new partitions hold the rows that were really in the default partitions.
      await expect(
        planting.query(
          `SELECT (SELECT count(*)::integer FROM planted_staging.workhorse_task_event_${suffix}) AS planted_events,
                  (SELECT count(*)::integer FROM planted_staging.workhorse_attempt_history_${suffix}) AS planted_attempts`,
        ),
      ).resolves.toMatchObject({ rows: [{ planted_events: 1, planted_attempts: 1 }] });
      await expect(
        pool.query(
          `SELECT (SELECT array_agg(event_type) FROM workhorse.task_event_${suffix}) AS events,
                  (SELECT array_agg(worker_id) FROM workhorse.attempt_history_${suffix}) AS attempts`,
        ),
      ).resolves.toMatchObject({ rows: [{ events: ["staged"], attempts: ["pg-temp-worker"] }] });
    } finally {
      await planting.query("RESET search_path").catch(() => undefined);
      await planting.query("DROP SCHEMA IF EXISTS planted_staging CASCADE").catch(() => undefined);
      planting.release();
    }
  });

  it("uses one UTC advisory lock key for daily retirement in every session timezone", async () => {
    const day = "2014-03-03";
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [day]);
    const blocker = await pool.connect();
    const zonedClient = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('workhorse:history-day:2014-03-03', 0))`,
      );
      await zonedClient.query("BEGIN");
      await zonedClient.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      await expect(
        zonedClient.query(
          "SELECT workhorse.retire_history_partitions_v1('task_event', $1, 1) AS retired",
          ["2014-03-04"],
        ),
      ).resolves.toMatchObject({ rows: [{ retired: 0 }] });
      await zonedClient.query("ROLLBACK");
      await blocker.query("COMMIT");

      await expect(
        pool.query(
          "SELECT workhorse.retire_history_partitions_v1('task_event', $1, 1) AS retired",
          ["2014-03-04"],
        ),
      ).resolves.toMatchObject({ rows: [{ retired: 1 }] });
    } finally {
      await zonedClient.query("ROLLBACK").catch(() => undefined);
      await blocker.query("ROLLBACK").catch(() => undefined);
      zonedClient.release();
      blocker.release();
    }
  });

  it("retires the discovered qualified partition without waiting indefinitely for DDL locks", async () => {
    await pool.query("DROP SCHEMA IF EXISTS retention_external CASCADE");
    await pool.query("CREATE SCHEMA retention_external");
    await pool.query(`
      CREATE TABLE retention_external.task_event_2014w10
        PARTITION OF workhorse.task_event
        FOR VALUES FROM ('2014-03-03') TO ('2014-03-10')`);

    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE retention_external.task_event_2014w10 IN ACCESS SHARE MODE");
      const startedAt = Date.now();
      await expect(
        pool.query(
          "SELECT workhorse.retire_history_partitions_v1('task_event', $1, 1) AS retired",
          ["2014-03-10"],
        ),
      ).resolves.toMatchObject({ rows: [{ retired: 0 }] });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }

    await expect(
      pool.query("SELECT workhorse.retire_history_partitions_v1('task_event', $1, 1) AS retired", [
        "2014-03-10",
      ]),
    ).resolves.toMatchObject({ rows: [{ retired: 1 }] });
    expect(
      (await pool.query("SELECT to_regclass('retention_external.task_event_2014w10') AS relation"))
        .rows[0]?.relation,
    ).toBeNull();
    await pool.query("DROP SCHEMA retention_external");
  });
});
