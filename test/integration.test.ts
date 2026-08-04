import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CancellationRequestedError,
  DeadlineExceededError,
  DEFAULT_IDEMPOTENCY_SCOPE,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  EnqueueIdempotencyConflictError,
  ExecutionTimeoutError,
  InjectedCrashError,
  installSchema,
  type Json,
  type MaintenancePhaseResult,
  MAX_CHECKPOINT_VALUE_BYTES,
  MAX_PROGRESS_VALUE_BYTES,
  MAX_ENQUEUE_BATCH_SIZE,
  MAX_IDEMPOTENCY_KEY_BYTES,
  MAX_IDEMPOTENCY_SCOPE_BYTES,
  MAX_IDEMPOTENCY_TTL_MS,
  Queue,
  RedriveIdempotencyConflictError,
  type Queryable,
  type RetentionPolicyDefinition,
  Worker,
} from "../src/index.js";
import { assertLocalDatabasePurpose, localDatabaseUrl } from "../src/local-database.js";

const databaseUrl = localDatabaseUrl("test");
assertLocalDatabasePurpose(databaseUrl, "test");
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const queue = new Queue(pool);
const safeKeyDigest = (scope: string, key: string) =>
  createHash("sha256").update(`${scope}\x1f${key}`, "utf8").digest("hex").slice(0, 12);
const safeKeyPreview = (key: string) => {
  const characters = [...key];
  if (characters.length <= 4) return "•".repeat(characters.length);
  if (characters.length <= 8) {
    return `${characters.slice(0, 2).join("")}…${characters.slice(-2).join("")}`;
  }
  return `${characters.slice(0, 8).join("")}…${characters.slice(-4).join("")}`;
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
const defaultRetentionPolicy: RetentionPolicyDefinition = {
  jobIdentityRetentionDays: 14,
  terminalOutcomeRetentionDays: 14,
  jobEventRetentionDays: 14,
  attemptHistoryRetentionDays: 14,
  scheduleOccurrenceRetentionDays: 14,
  terminalJobPruneLimit: 1_000,
  historyPartitionsPerPass: 4,
  defaultPartitionRowsPerPass: 10_000,
  occurrenceRowsPerPass: 10_000,
};

async function createFailedJob({
  type,
  queueName = "default",
  payload = {},
  tags = [],
  errorName = "Error",
  deadline,
  executionTimeoutMs,
  retryPolicy,
}: {
  type: string;
  queueName?: string;
  payload?: Json;
  tags?: string[];
  errorName?: string;
  deadline?: Date;
  executionTimeoutMs?: number;
  retryPolicy?: { type: "fixed"; delayMs: number };
}): Promise<string> {
  const id = await queue.enqueue(type, payload, {
    queue: queueName,
    tags,
    maxAttempts: 1,
    deadline,
    executionTimeoutMs,
    retryPolicy,
  });
  const job = await queue.claim(`fixture-${type}`, { queue: queueName });
  expect(job?.id).toBe(id);
  const error = new Error(`${type} failed`);
  error.name = errorName;
  expect(await queue.fail(job!, `fixture-${type}`, error)).toBe("failed");
  return id;
}

beforeAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);
});

beforeEach(async () => {
  await pool.query(`TRUNCATE workhorse.job_event, workhorse.attempt_history,
    workhorse.schedule_occurrence, workhorse.schedule_definition,
    workhorse.queue_control, workhorse.job_wait, workhorse.job_checkpoint,
    workhorse.enqueue_idempotency, workhorse.job_redrive, workhorse.job_outcome, workhorse.job_runtime,
    workhorse.job RESTART IDENTITY CASCADE`);
  await pool.query("ALTER SEQUENCE workhorse.fence_token_seq RESTART WITH 1");
  await queue.syncRetentionPolicy(defaultRetentionPolicy);
  await queue.syncMaintenancePolicy({
    timezone: "UTC",
    partitionPreparationIntervalMs: 21_600_000,
    terminalCleanupIntervalMs: 300_000,
    historyRetentionLocalHour: 3,
  });
  await pool.query(`UPDATE workhorse.maintenance_state SET
    last_started_at = NULL,
    last_completed_at = NULL,
    last_completed_local_date = NULL,
    history_retained_before = CASE WHEN task_name = 'history_retention'
      THEN date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        - interval '14 days'
      ELSE NULL END,
    updated_at = clock_timestamp()`);
});

afterAll(async () => {
  await pool.end();
});

describe("live-runtime queue protocol", () => {
  it("installs schema v16 with fenced mutable progress storage", async () => {
    const version = await pool.query<{ version: number }>(
      "SELECT max(version)::integer AS version FROM workhorse.schema_version",
    );
    expect(version.rows[0]?.version).toBe(16);

    const maintenanceFunctions = await pool.query<{
      maintain: string | null;
      tick: string | null;
      housekeep: string | null;
      partitions: string | null;
      retention: string | null;
      terminal: string | null;
    }>(`SELECT
      to_regprocedure('workhorse.maintain_v1(integer,integer,integer,integer)')::text AS maintain,
      to_regprocedure('workhorse.tick_v1(integer,integer)')::text AS tick,
      to_regprocedure('workhorse.housekeep_v1(integer,integer)')::text AS housekeep,
      to_regprocedure('workhorse.prepare_history_partitions_v1(boolean,timestamp with time zone)')::text AS partitions,
      to_regprocedure('workhorse.retain_history_v1(boolean,timestamp with time zone)')::text AS retention,
      to_regprocedure('workhorse.prune_terminal_storage_v1(boolean,timestamp with time zone)')::text AS terminal`);
    expect(maintenanceFunctions.rows[0]).toEqual({
      maintain: null,
      tick: "tick_v1(integer,integer)",
      housekeep: null,
      partitions: "prepare_history_partitions_v1(boolean,timestamp with time zone)",
      retention: "retain_history_v1(boolean,timestamp with time zone)",
      terminal: "prune_terminal_storage_v1(boolean,timestamp with time zone)",
    });

    const maintenancePolicy = await queue.getMaintenancePolicy();
    expect(maintenancePolicy).toMatchObject({
      timezone: "UTC",
      partitionPreparationIntervalMs: 21_600_000,
      terminalCleanupIntervalMs: 300_000,
      historyRetentionLocalHour: 3,
      updatedAt: expect.any(Date),
    });

    const historyPartitions = await pool.query<{ parent: string; partitions: number }>(`
      SELECT parent.relname AS parent, count(*)::integer AS partitions
        FROM pg_inherits inheritance
        JOIN pg_class parent ON parent.oid = inheritance.inhparent
        JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
       WHERE namespace.nspname = 'workhorse'
         AND parent.relname IN ('job_event', 'attempt_history')
       GROUP BY parent.relname
       ORDER BY parent.relname`);
    expect(historyPartitions.rows).toEqual([
      { parent: "attempt_history", partitions: 5 },
      { parent: "job_event", partitions: 5 },
    ]);

    const historyIntegrity = await pool.query<{ foreign_keys: number; triggers: string[] }>(`
      SELECT
        (SELECT count(*)::integer FROM pg_constraint
          WHERE conrelid IN ('workhorse.job_event'::regclass, 'workhorse.attempt_history'::regclass)
            AND contype = 'f') AS foreign_keys,
        (SELECT json_agg(trigger_name ORDER BY trigger_name) FROM (
          SELECT tgname AS trigger_name FROM pg_trigger
           WHERE tgrelid IN ('workhorse.job_event'::regclass, 'workhorse.attempt_history'::regclass)
             AND NOT tgisinternal
        ) triggers) AS triggers`);
    expect(historyIntegrity.rows[0]).toEqual({
      foreign_keys: 0,
      triggers: ["attempt_history_job_exists", "job_event_job_exists"],
    });

    const relations = await pool.query<{ relname: string }>(
      `
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'workhorse'
         AND c.relname = ANY($1::text[])
         AND c.relkind IN ('r', 'p', 'v', 'm')`,
      [["job_current", "ready_job", "scheduled_job", "lease"]],
    );
    expect(relations.rows).toEqual([]);

    const indexes = await pool.query<{ indexname: string }>(
      `
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'workhorse'
         AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [
        [
          "job_runtime_expired_active_idx",
          "job_runtime_ready_idx",
          "job_runtime_scheduled_idx",
          "job_tags_gin_idx",
          "enqueue_idempotency_expiry_idx",
        ],
      ],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "enqueue_idempotency_expiry_idx",
      "job_runtime_expired_active_idx",
      "job_runtime_ready_idx",
      "job_runtime_scheduled_idx",
      "job_tags_gin_idx",
    ]);

    const idempotencyConstraint = await pool.query<{
      deferrable: boolean;
      initially_deferred: boolean;
    }>(`
      SELECT condeferrable AS deferrable, condeferred AS initially_deferred
        FROM pg_constraint
       WHERE conrelid = 'workhorse.enqueue_idempotency'::regclass
         AND contype = 'f'`);
    expect(idempotencyConstraint.rows).toEqual([{ deferrable: true, initially_deferred: true }]);
    const idempotencyColumns = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'workhorse' AND table_name = 'enqueue_idempotency'
       ORDER BY column_name`);
    expect(idempotencyColumns.rows.map((row) => row.column_name)).toContain("idempotency_key_hash");
    expect(idempotencyColumns.rows.map((row) => row.column_name)).not.toContain("idempotency_key");
  });

  it("lists only failed outcomes with filters, a stable cursor, and a partial cold index", async () => {
    const smtp = await createFailedJob({
      type: "email",
      queueName: "mail",
      payload: { recipient: "a@example.test" },
      tags: ["urgent", "tenant-a"],
      errorName: "SmtpError",
    });
    const timeout = await createFailedJob({
      type: "email",
      queueName: "mail",
      tags: ["urgent", "tenant-b"],
      errorName: "TimeoutError",
    });
    const other = await createFailedJob({
      type: "report",
      queueName: "analytics",
      tags: ["urgent"],
      errorName: "SmtpError",
    });
    const succeeded = await queue.enqueue("email", {}, { queue: "mail", tags: ["urgent"] });
    const succeededClaim = await queue.claim("successful-list-fixture", { queue: "mail" });
    expect(succeededClaim?.id).toBe(succeeded);
    expect(await queue.complete(succeededClaim!, "successful-list-fixture", { ok: true })).toBe(
      true,
    );

    const base = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE workhorse.job_outcome SET finished_at = CASE job_id
         WHEN $1 THEN $4::timestamptz - interval '3 hours'
         WHEN $2 THEN $4::timestamptz - interval '2 hours'
         WHEN $3 THEN $4::timestamptz - interval '1 hour'
         ELSE $4::timestamptz END
       WHERE job_id = ANY($5::uuid[])`,
      [smtp, timeout, other, base, [smtp, timeout, other, succeeded]],
    );

    const first = await pool.query<{
      job_id: string;
      queue_name: string;
      job_type: string;
      tags: string[];
      error: { name: string };
      finished_at: Date;
      redrive_count: number;
    }>(`SELECT * FROM workhorse.list_dead_letters_v1($1, 1, NULL, NULL)`, [
      JSON.stringify({
        queue: "mail",
        type: "email",
        tags: ["urgent"],
        finishedAfter: new Date(base.getTime() - 4 * 3_600_000).toISOString(),
        finishedBefore: base.toISOString(),
      }),
    ]);
    expect(first.rows).toMatchObject([
      {
        job_id: timeout,
        queue_name: "mail",
        job_type: "email",
        tags: ["urgent", "tenant-b"],
        error: { name: "TimeoutError" },
        redrive_count: 0,
      },
    ]);
    const second = await pool.query<{ job_id: string }>(
      `SELECT job_id FROM workhorse.list_dead_letters_v1($1, 10, $2, $3)`,
      [JSON.stringify({ queue: "mail", tags: ["urgent"] }), first.rows[0]!.finished_at, timeout],
    );
    expect(second.rows).toEqual([{ job_id: smtp }]);
    const errorFiltered = await pool.query<{ job_id: string }>(
      "SELECT job_id FROM workhorse.list_dead_letters_v1($1, 10, NULL, NULL)",
      [JSON.stringify({ errorName: "SmtpError" })],
    );
    expect(new Set(errorFiltered.rows.map((row) => row.job_id))).toEqual(new Set([other, smtp]));
    expect(errorFiltered.rows.some((row) => row.job_id === succeeded)).toBe(false);

    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'workhorse' AND indexname = 'job_outcome_failed_finished_idx'`,
    );
    expect(index.rows[0]!.indexdef).toMatch(
      /finished_at DESC, job_id DESC.*WHERE \(state = 'failed'/,
    );
    const dispatchIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'workhorse' AND tablename = 'job_runtime'
          AND indexdef ILIKE '%failed%'`,
    );
    expect(dispatchIndexes.rows).toEqual([]);
  });

  it("redrives once with immutable source evidence, exact copy semantics, audit, replay, and safe conflict", async () => {
    const rawRequestId = "operator-secret-request-123456";
    const deadline = new Date(Date.now() + 86_400_000);
    const source = await createFailedJob({
      type: "rebuild-search",
      queueName: "operations",
      payload: { tenant: 42, full: true },
      tags: ["tenant-42", "manual"],
      deadline,
      executionTimeoutMs: 12_345,
      retryPolicy: { type: "fixed", delayMs: 250 },
      errorName: "SearchUnavailable",
    });
    await pool.query(
      `INSERT INTO workhorse.job_checkpoint(
         job_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id
       ) VALUES ($1, 'source-only', '{"done":true}', 1, 1, 'fixture')`,
      [source],
    );
    await pool.query(
      `INSERT INTO workhorse.job_wait(
         job_id, wait_name, mode, duration_ms, wake_at, attempt, fence_token, worker_id, claimed_at
       ) VALUES ($1, 'source-wait', 'relative', 1000, clock_timestamp() + interval '1 second',
                 1, 1, 'fixture', clock_timestamp())`,
      [source],
    );
    const sourceBefore = await pool.query<{ outcome: Record<string, unknown> }>(
      "SELECT to_jsonb(outcome) - 'history_through_at' AS outcome FROM workhorse.job_outcome outcome WHERE job_id = $1",
      [source],
    );

    const created = await pool.query<{
      status: string;
      source_job_id: string;
      target_job_id: string;
      source_state: string;
      target_state: string;
      requested_at: Date;
    }>("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", [
      source,
      "on-call@example.test",
      "upstream recovered",
      rawRequestId,
    ]);
    expect(created.rows[0]).toMatchObject({
      status: "redriven",
      source_job_id: source,
      source_state: "failed",
      target_state: "ready",
    });
    const target = created.rows[0]!.target_job_id;
    expect(target).not.toBe(source);

    const copied = await pool.query(
      `SELECT job.queue_name, job.job_type, job.payload, job.tags, job.max_attempts,
              job.retry_policy, job.deadline_at, job.execution_timeout_ms,
              runtime.state, runtime.current_attempt, runtime.deadline_at AS runtime_deadline_at
         FROM workhorse.job job JOIN workhorse.job_runtime runtime ON runtime.job_id = job.id
        WHERE job.id = $1`,
      [target],
    );
    expect(copied.rows[0]).toMatchObject({
      queue_name: "operations",
      job_type: "rebuild-search",
      payload: { tenant: 42, full: true },
      tags: ["tenant-42", "manual"],
      max_attempts: 1,
      retry_policy: { type: "fixed", delayMs: 250 },
      deadline_at: null,
      execution_timeout_ms: "12345",
      state: "ready",
      current_attempt: 1,
      runtime_deadline_at: null,
    });
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM (
             SELECT 1 FROM workhorse.job_checkpoint WHERE job_id = $1
             UNION ALL SELECT 1 FROM workhorse.job_wait WHERE job_id = $1
           ) durability`,
          [target],
        )
      ).rows[0]!.count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(outcome) - 'history_through_at' AS outcome FROM workhorse.job_outcome outcome WHERE job_id = $1",
          [source],
        )
      ).rows[0],
    ).toEqual(sourceBefore.rows[0]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_outcome WHERE job_id = $1",
          [target],
        )
      ).rows[0]!.count,
    ).toBe(0);

    const audit = await pool.query<{
      requested_by: string;
      reason: string;
      request_id_preview: string;
      request_id_digest: string;
      request_id_length: number;
      source_state: string;
      target_initial_state: string;
      row_text: string;
    }>(
      `SELECT requested_by, reason, request_id_preview, request_id_digest, request_id_length,
              source_state, target_initial_state, to_jsonb(redrive)::text AS row_text
         FROM workhorse.job_redrive redrive WHERE source_job_id = $1`,
      [source],
    );
    expect(audit.rows[0]).toMatchObject({
      requested_by: "on-call@example.test",
      reason: "upstream recovered",
      request_id_preview: "operator…3456",
      request_id_digest: expect.stringMatching(/^[0-9a-f]{12}$/),
      request_id_length: rawRequestId.length,
      source_state: "failed",
      target_initial_state: "ready",
    });
    expect(audit.rows[0]!.row_text).not.toContain(rawRequestId);
    const events = await pool.query<{
      job_id: string;
      event_type: string;
      details: unknown;
      occurred_at: Date;
    }>(
      `SELECT job_id, event_type, details, occurred_at FROM workhorse.job_event
        WHERE job_id = ANY($1::uuid[]) AND event_type IN ('redriven', 'redrive_created')
        ORDER BY event_type`,
      [[source, target]],
    );
    expect(events.rows).toMatchObject([
      { job_id: target, event_type: "redrive_created" },
      { job_id: source, event_type: "redriven" },
    ]);
    expect(events.rows.every((event) => event.occurred_at >= created.rows[0]!.requested_at)).toBe(
      true,
    );
    expect(JSON.stringify(events.rows)).not.toContain(rawRequestId);

    const replay = await pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", [
      source,
      "on-call@example.test",
      "upstream recovered",
      rawRequestId,
    ]);
    expect(replay.rows[0]).toMatchObject({ status: "replayed", target_job_id: target });
    expect(replay.rows[0]!.requested_at).toEqual(created.rows[0]!.requested_at);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job_redrive")).rows[0]!
        .count,
    ).toBe(1);

    let conflict: unknown;
    try {
      await pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", [
        source,
        "on-call@example.test",
        "different reason",
        rawRequestId,
      ]);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: "P1002" });
    const detail = JSON.parse(String((conflict as { detail: string }).detail));
    expect(detail).toMatchObject({
      sourceJobId: source,
      existingTargetJobId: target,
      requestIdPreview: "operator…3456",
      requestIdLength: rawRequestId.length,
      conflictingFields: ["reason"],
    });
    expect(JSON.stringify(detail)).not.toContain(rawRequestId);

    const live = await queue.enqueue("not-failed", {});
    const notFailed = await pool.query(
      "SELECT * FROM workhorse.redrive_v1($1, 'operator', 'reason', 'live')",
      [live],
    );
    expect(notFailed.rows[0]).toMatchObject({
      status: "not_failed",
      source_job_id: live,
      source_state: "ready",
      target_job_id: null,
      requested_at: null,
    });
    const missing = await pool.query(
      "SELECT * FROM workhorse.redrive_v1(gen_random_uuid(), 'operator', 'reason', 'missing')",
    );
    expect(missing.rows[0]).toMatchObject({
      status: "not_found",
      target_job_id: null,
      requested_at: null,
    });
    await expect(
      pool.query("SELECT * FROM workhorse.redrive_v1($1, '', 'reason', 'bounded')", [source]),
    ).rejects.toThrow(/requested_by/);
    await expect(
      pool.query("SELECT * FROM workhorse.redrive_v1($1, 'operator', 'reason', $2)", [
        source,
        "é".repeat(257),
      ]),
    ).rejects.toThrow(/512 UTF-8 bytes/);
  });

  it("serializes concurrent exact redrive requests to one target", async () => {
    const source = await createFailedJob({ type: "concurrent-redrive" });
    const params = [source, "operator", "retry concurrently", "concurrent-request"];
    const [first, second] = await Promise.all([
      pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", params),
      pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", params),
    ]);
    expect(new Set([first.rows[0]!.status, second.rows[0]!.status])).toEqual(
      new Set(["redriven", "replayed"]),
    );
    expect(first.rows[0]!.target_job_id).toBe(second.rows[0]!.target_job_id);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job_redrive")).rows[0]!
        .count,
    ).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]!.count,
    ).toBe(2);
  });

  it("maps dead-letter, redrive, lineage, conflict, and bulk results through the public Queue API", async () => {
    const older = await createFailedJob({
      type: "public-redrive",
      queueName: "public-redrive",
      tags: ["public"],
      errorName: "PublicFailure",
    });
    const newer = await createFailedJob({
      type: "public-redrive",
      queueName: "public-redrive",
      tags: ["public"],
      errorName: "PublicFailure",
    });
    const now = new Date(Date.now() - 10_000);
    await pool.query(
      `UPDATE workhorse.job_outcome SET finished_at = CASE job_id
         WHEN $1 THEN $3::timestamptz - interval '2 hours'
         WHEN $2 THEN $3::timestamptz - interval '1 hour' END
       WHERE job_id = ANY($4::uuid[])`,
      [older, newer, now, [older, newer]],
    );

    const firstPage = await queue.listDeadLetters({
      queue: "public-redrive",
      tags: ["public"],
      errorName: "PublicFailure",
      limit: 1,
    });
    expect(firstPage.items).toMatchObject([
      {
        jobId: newer,
        queue: "public-redrive",
        type: "public-redrive",
        error: { name: "PublicFailure" },
        redriveCount: 0,
        finishedAt: expect.any(Date),
      },
    ]);
    expect(firstPage.nextCursor).toEqual({
      finishedAt: expect.any(String),
      jobId: newer,
    });
    const secondPage = await queue.listDeadLetters({
      queue: "public-redrive",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items.map((item) => item.jobId)).toEqual([older]);
    expect(secondPage.nextCursor).toBeNull();

    const request = {
      requestedBy: "public-operator",
      reason: "validate public mapping",
      requestId: "public-redrive-request",
    };
    const created = await queue.redrive(older, request);
    expect(created).toMatchObject({
      status: "redriven",
      sourceJobId: older,
      targetJobId: expect.any(String),
      sourceState: "failed",
      targetState: "ready",
      requestedAt: expect.any(Date),
    });
    const lineage = await queue.getRedriveLineage(older);
    expect(lineage).toMatchObject({
      records: [
        {
          sourceJobId: older,
          targetJobId: created.targetJobId,
          requestedBy: request.requestedBy,
          reason: request.reason,
          requestIdPreview: "public-r…uest",
          requestIdDigest: expect.stringMatching(/^[0-9a-f]{12}$/),
          requestIdLength: request.requestId.length,
          sourceState: "failed",
          targetInitialState: "ready",
          requestedAt: expect.any(Date),
        },
      ],
      truncated: false,
    });
    let conflict: unknown;
    try {
      await queue.redrive(older, { ...request, reason: "materially different" });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(RedriveIdempotencyConflictError);
    expect(conflict).toMatchObject({
      details: {
        sourceJobId: older,
        existingTargetJobId: created.targetJobId,
        conflictingFields: ["reason"],
      },
    });

    const preview = await queue.redriveMany(
      { queue: "public-redrive", type: "public-redrive", tags: ["public"] },
      {
        requestedBy: "public-operator",
        reason: "bulk public mapping",
        requestId: "public-bulk-request",
      },
      { limit: 2, dryRun: true },
    );
    expect(preview).toMatchObject({
      results: [
        {
          status: "eligible",
          sourceJobId: older,
          targetJobId: null,
          sourceState: "failed",
          targetState: null,
          requestedAt: null,
        },
        {
          status: "eligible",
          sourceJobId: newer,
          targetJobId: null,
          sourceState: "failed",
          targetState: null,
          requestedAt: null,
        },
      ],
      nextCursor: null,
    });
  });

  it("bulk redrive shares filters, bounds oldest-first work, keeps dry-run pure, and replays", async () => {
    const oldest = await createFailedJob({
      type: "bulk-import",
      queueName: "bulk",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    const middle = await createFailedJob({
      type: "bulk-import",
      queueName: "bulk",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    const newest = await createFailedJob({
      type: "bulk-import",
      queueName: "bulk",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    await createFailedJob({
      type: "bulk-import",
      queueName: "other",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    const base = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE workhorse.job_outcome SET finished_at = CASE job_id
         WHEN $1 THEN $4::timestamptz - interval '3 hours'
         WHEN $2 THEN $4::timestamptz - interval '2 hours'
         WHEN $3 THEN $4::timestamptz - interval '1 hour' END
       WHERE job_id = ANY($5::uuid[])`,
      [oldest, middle, newest, base, [oldest, middle, newest]],
    );
    const filter = JSON.stringify({
      queue: "bulk",
      type: "bulk-import",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
      finishedAfter: new Date(base.getTime() - 4 * 3_600_000).toISOString(),
      finishedBefore: base.toISOString(),
    });
    const before = await pool.query<{ jobs: number; redrives: number; events: number }>(
      `SELECT (SELECT count(*)::integer FROM workhorse.job) AS jobs,
              (SELECT count(*)::integer FROM workhorse.job_redrive) AS redrives,
              (SELECT count(*)::integer FROM workhorse.job_event) AS events`,
    );
    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (notification) => notifications.push(notification.payload ?? ""));
    await listener.query("LISTEN workhorse_jobs");
    const preview = await (async () => {
      try {
        const result = await pool.query(
          "SELECT * FROM workhorse.redrive_many_v1($1, 2, true, 'operator', 'bulk recovery', 'bulk-request') ORDER BY ordinal",
          [filter],
        );
        await sleep(25);
        expect(notifications).toEqual([]);
        return result;
      } finally {
        await listener.query("UNLISTEN workhorse_jobs");
        listener.release();
      }
    })();
    expect(preview.rows).toMatchObject([
      {
        ordinal: 1,
        status: "eligible",
        source_job_id: oldest,
        target_job_id: null,
        requested_at: null,
      },
      {
        ordinal: 2,
        status: "eligible",
        source_job_id: middle,
        target_job_id: null,
        requested_at: null,
      },
    ]);
    const afterPreview = await pool.query<{ jobs: number; redrives: number; events: number }>(
      `SELECT (SELECT count(*)::integer FROM workhorse.job) AS jobs,
              (SELECT count(*)::integer FROM workhorse.job_redrive) AS redrives,
              (SELECT count(*)::integer FROM workhorse.job_event) AS events`,
    );
    expect(afterPreview.rows).toEqual(before.rows);

    const created = await pool.query(
      "SELECT * FROM workhorse.redrive_many_v1($1, 2, false, 'operator', 'bulk recovery', 'bulk-request') ORDER BY ordinal",
      [filter],
    );
    expect(created.rows).toMatchObject([
      { ordinal: 1, status: "redriven", source_job_id: oldest, target_state: "ready" },
      { ordinal: 2, status: "redriven", source_job_id: middle, target_state: "ready" },
    ]);
    expect(created.rows.some((row) => row.source_job_id === newest)).toBe(false);
    const replay = await pool.query(
      "SELECT * FROM workhorse.redrive_many_v1($1, 2, false, 'operator', 'bulk recovery', 'bulk-request') ORDER BY ordinal",
      [filter],
    );
    expect(replay.rows.map((row) => row.status)).toEqual(["replayed", "replayed"]);
    expect(replay.rows.map((row) => row.target_job_id)).toEqual(
      created.rows.map((row) => row.target_job_id),
    );
    await expect(
      pool.query(
        "SELECT * FROM workhorse.redrive_many_v1('{}', 1001, true, 'operator', 'reason', 'request')",
      ),
    ).rejects.toThrow(/between 1 and 1000/);
  });

  it("advances bounded bulk redrive across cursor pages including equal finish times", async () => {
    const sourceIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      sourceIds.push(
        await createFailedJob({ type: `bulk-cursor-${index}`, queueName: "bulk-cursor" }),
      );
    }
    const [oldest, ...ties] = sourceIds;
    const boundary = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = CASE WHEN job_id = $1
            THEN $2::timestamptz - interval '1 hour' ELSE $2::timestamptz END
        WHERE job_id = ANY($3::uuid[])`,
      [oldest, boundary, sourceIds],
    );
    const orderedTies = ties[0]! < ties[1]! ? ties : [ties[1]!, ties[0]!];
    const request = {
      requestedBy: "bulk-cursor-operator",
      reason: "drain a bounded backlog",
      requestId: "bulk-cursor-request",
    };

    const first = await queue.redriveMany({ queue: "bulk-cursor" }, request, { limit: 2 });
    expect(first.results.map((result) => result.sourceJobId)).toEqual([oldest, orderedTies[0]]);
    expect(first.nextCursor).toEqual({ finishedAt: expect.any(String), jobId: orderedTies[0] });

    const replay = await queue.redriveMany({ queue: "bulk-cursor" }, request, { limit: 2 });
    expect(replay.results.map((result) => result.status)).toEqual(["replayed", "replayed"]);
    expect(replay.nextCursor).toEqual(first.nextCursor);

    const second = await queue.redriveMany({ queue: "bulk-cursor" }, request, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.results).toMatchObject([
      { status: "redriven", sourceJobId: orderedTies[1], targetJobId: expect.any(String) },
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job_redrive")).rows[0]!
        .count,
    ).toBe(3);
  });

  it("bounds retained lineage traversal and reports truncation", async () => {
    const source = await createFailedJob({
      type: "bounded-lineage-source",
      queueName: "bounded-lineage",
    });
    const first = await queue.redrive(source, {
      requestedBy: "lineage-operator",
      reason: "first generation",
      requestId: "lineage-first",
    });
    const firstTarget = await queue.claim("bounded-lineage-worker", { queue: "bounded-lineage" });
    expect(firstTarget?.id).toBe(first.targetJobId);
    expect(
      await queue.fail(firstTarget!, "bounded-lineage-worker", new Error("first target failed")),
    ).toBe("failed");
    const second = await queue.redrive(first.targetJobId!, {
      requestedBy: "lineage-operator",
      reason: "second generation",
      requestId: "lineage-second",
    });

    expect(await queue.getRedriveLineage(source, 1)).toMatchObject({
      records: [{ sourceJobId: source, targetJobId: first.targetJobId }],
      truncated: true,
    });
    expect(await queue.getRedriveLineage(second.targetJobId!)).toMatchObject({
      records: [
        { sourceJobId: source, targetJobId: first.targetJobId },
        { sourceJobId: first.targetJobId, targetJobId: second.targetJobId },
      ],
      truncated: false,
    });
  });

  it("protects redrive sources until descendant targets are pruned", async () => {
    const source = await createFailedJob({
      type: "retained-redrive",
      queueName: "retention-redrive",
    });
    const redrive = await pool.query<{ target_job_id: string }>(
      "SELECT target_job_id FROM workhorse.redrive_v1($1, 'operator', 'retention proof', 'retention-request')",
      [source],
    );
    const target = redrive.rows[0]!.target_job_id;
    const targetClaim = await queue.claim("retention-redrive-target", {
      queue: "retention-redrive",
    });
    expect(targetClaim?.id).toBe(target);
    expect(
      await queue.fail(targetClaim!, "retention-redrive-target", new Error("target failed")),
    ).toBe("failed");
    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = ANY($1::uuid[])", [
      [source, target],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = ANY($1::uuid[])", [
      [source, target],
    ]);
    await pool.query(
      `UPDATE workhorse.job SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = ANY($1::uuid[])`,
      [[source, target]],
    );
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE job_id = ANY($1::uuid[])`,
      [[source, target]],
    );

    await expect(
      pool.query("DELETE FROM workhorse.job WHERE id = $1", [source]),
    ).rejects.toMatchObject({
      code: "23503",
    });
    const first = await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_jobs_v1(
         clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
         date_trunc('day', clock_timestamp() - interval '30 days'), 10
       ) AS pruned`,
    );
    expect(first.rows[0]!.pruned).toBe(1);
    expect(
      (await pool.query("SELECT id FROM workhorse.job WHERE id = $1", [source])).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query("SELECT id FROM workhorse.job WHERE id = $1", [target])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job_redrive")).rows[0]!
        .count,
    ).toBe(0);
    const second = await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_jobs_v1(
         clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
         date_trunc('day', clock_timestamp() - interval '30 days'), 10
       ) AS pruned`,
    );
    expect(second.rows[0]!.pruned).toBe(1);
    expect(
      (await pool.query("SELECT id FROM workhorse.job WHERE id = $1", [source])).rows,
    ).toHaveLength(0);
  });

  it("validates cancellation metadata and idempotently cancels never-started jobs", async () => {
    const readyId = await queue.enqueue("cancel-ready", { value: 1 });
    await expect(queue.cancel(readyId, { requestedBy: "" })).rejects.toThrow(
      "requested_by must contain between 1 and 200 characters",
    );
    await expect(queue.cancel(readyId, { requestedBy: "x".repeat(201) })).rejects.toThrow(
      "requested_by must contain between 1 and 200 characters",
    );
    await expect(queue.cancel(readyId, { reason: "" })).rejects.toThrow(
      "reason must contain between 1 and 2000 characters",
    );
    await expect(queue.cancel(readyId, { reason: "x".repeat(2001) })).rejects.toThrow(
      "reason must contain between 1 and 2000 characters",
    );

    const first = await queue.cancel(readyId, {
      requestedBy: "integration-test",
      reason: "no longer needed",
    });
    expect(first).toMatchObject({
      status: "canceled",
      jobId: readyId,
      state: "canceled",
      currentAttempt: 1,
      requestedBy: "integration-test",
      reason: "no longer needed",
    });
    expect(first.requestedAt).toBeInstanceOf(Date);
    expect(first.finishedAt).toBeInstanceOf(Date);

    const repeated = await queue.cancel(readyId, {
      requestedBy: "ignored-retry",
      reason: "ignored retry metadata",
    });
    expect(repeated).toEqual(first);
    expect(await queue.getJob(readyId)).toMatchObject({
      state: "canceled",
      currentAttempt: 1,
      fenceToken: 0n,
      error: {
        name: "CancellationRequested",
        message: "job cancellation was requested",
        requested_by: "integration-test",
        reason: "no longer needed",
      },
    });

    const scheduledId = await queue.enqueue("cancel-scheduled", null, {
      runAt: new Date(Date.now() + 60_000),
    });
    expect((await queue.cancel(scheduledId)).status).toBe("canceled");
    const neverStarted = await pool.query<{ job_id: string; attempts: number; events: number }>(
      `SELECT job.id AS job_id,
              (SELECT count(*)::integer FROM workhorse.attempt_history history
                WHERE history.job_id = job.id) AS attempts,
              (SELECT count(*)::integer FROM workhorse.job_event event
                WHERE event.job_id = job.id AND event.event_type = 'canceled') AS events
         FROM workhorse.job job WHERE job.id = ANY($1::uuid[]) ORDER BY job.id`,
      [[readyId, scheduledId]],
    );
    expect(neverStarted.rows).toHaveLength(2);
    expect(neverStarted.rows).toEqual(
      expect.arrayContaining([
        { job_id: readyId, attempts: 0, events: 1 },
        { job_id: scheduledId, attempts: 0, events: 1 },
      ]),
    );

    const missing = await queue.cancel("00000000-0000-4000-8000-000000000001");
    expect(missing).toEqual({
      status: "not_found",
      jobId: "00000000-0000-4000-8000-000000000001",
      state: null,
      currentAttempt: null,
      requestedAt: null,
      requestedBy: null,
      reason: null,
      finishedAt: null,
    });

    const succeededId = await queue.enqueue("already-terminal", null);
    const succeeded = await queue.claim("terminal-worker", { leaseMs: 5_000 });
    expect(succeeded?.id).toBe(succeededId);
    expect(await queue.complete(succeeded!, "terminal-worker", { ok: true })).toBe(true);
    expect(await queue.cancel(succeededId)).toMatchObject({
      status: "already_terminal",
      state: "succeeded",
      currentAttempt: 1,
      requestedAt: null,
    });
  });

  it("cancels a durable wait with the latest retained claim attribution", async () => {
    const id = await queue.enqueue("cancel-wait", null);
    const firstClaim = await queue.claim("wait-cancel-worker-1", { leaseMs: 5_000 });
    expect(firstClaim?.id).toBe(id);
    const originalClaim = await pool.query<{ attempt_started_at: Date; acquired_at: Date }>(
      `SELECT attempt_started_at, acquired_at FROM workhorse.job_runtime WHERE job_id = $1`,
      [id],
    );
    expect(
      await queue.scheduleWait(firstClaim!, "wait-cancel-worker-1", "first-pause", {
        durationMs: 1,
      }),
    ).toMatchObject({ status: "scheduled" });
    await sleep(10);
    expect(await queue.promote()).toBe(1);
    const continuation = await queue.claim("wait-cancel-worker-2", { leaseMs: 5_000 });
    expect(continuation?.id).toBe(id);
    const latestClaim = await pool.query<{ acquired_at: Date }>(
      `SELECT acquired_at FROM workhorse.job_runtime WHERE job_id = $1`,
      [id],
    );
    const scheduled = await queue.scheduleWait(
      continuation!,
      "wait-cancel-worker-2",
      "second-pause",
      {
        durationMs: 60_000,
      },
    );
    expect(scheduled.status).toBe("scheduled");

    expect(await queue.cancel(id, { reason: "timer is obsolete" })).toMatchObject({
      status: "canceled",
      state: "canceled",
      currentAttempt: 1,
      reason: "timer is obsolete",
    });
    const history = await pool.query<{
      attempt: number;
      fence_token: string;
      worker_id: string;
      outcome: string;
      started_at: Date;
      claimed_at: Date;
    }>(
      `SELECT attempt, fence_token::text, worker_id, outcome, started_at, claimed_at
         FROM workhorse.attempt_history WHERE job_id = $1`,
      [id],
    );
    expect(history.rows).toEqual([
      {
        attempt: 1,
        fence_token: continuation!.fenceToken.toString(),
        worker_id: "wait-cancel-worker-2",
        outcome: "canceled",
        started_at: originalClaim.rows[0]!.attempt_started_at,
        claimed_at: latestClaim.rows[0]!.acquired_at,
      },
    ]);
  });

  it("requests active cancellation once and fences every later owner write", async () => {
    const id = await queue.enqueue("cancel-active", null, { maxAttempts: 2 });
    const claimed = await queue.claim("active-cancel-worker", { leaseMs: 5_000 });
    expect(claimed?.id).toBe(id);

    const first = await queue.cancel(id, { requestedBy: "operator-7", reason: "superseded" });
    expect(first).toMatchObject({
      status: "cancel_requested",
      state: "active",
      currentAttempt: 1,
      requestedBy: "operator-7",
      reason: "superseded",
      finishedAt: null,
    });
    expect(await queue.cancel(id, { requestedBy: "operator-8", reason: "duplicate" })).toEqual(
      first,
    );
    expect(await queue.getJob(id)).toMatchObject({
      state: "active",
      cancelRequestedAt: first.requestedAt,
      cancelRequestedBy: "operator-7",
      cancelReason: "superseded",
    });
    expect(await queue.heartbeatStatus(claimed!, "active-cancel-worker", 5_000)).toBe(
      "cancel_requested",
    );
    expect(await queue.heartbeat(claimed!, "active-cancel-worker", 5_000)).toBe(false);
    expect(await queue.complete(claimed!, "active-cancel-worker", null)).toBe(false);
    expect(await queue.fail(claimed!, "active-cancel-worker", new Error("late failure"), 0)).toBe(
      "cancel_requested",
    );
    await expect(
      queue.saveCheckpoint(claimed!, "active-cancel-worker", "late", { value: 1 }),
    ).rejects.toThrow("stale or expired");
    await expect(
      queue.scheduleWait(claimed!, "active-cancel-worker", "late", { durationMs: 1_000 }),
    ).rejects.toThrow("stale or expired");

    const requestEvents = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'cancel_requested'`,
      [id],
    );
    expect(requestEvents.rows[0]?.count).toBe(1);
    expect(await queue.acknowledgeCancel(claimed!, "active-cancel-worker")).toBe(true);
    expect(await queue.acknowledgeCancel(claimed!, "active-cancel-worker")).toBe(false);
    expect(await queue.getJob(id)).toMatchObject({
      state: "canceled",
      cancelRequestedAt: null,
      cancelRequestedBy: null,
      cancelReason: null,
    });
    expect(await queue.heartbeatStatus(claimed!, "active-cancel-worker", 5_000)).toBe("stale");
    expect(await queue.complete(claimed!, "active-cancel-worker", null)).toBe(false);
    expect(await queue.fail(claimed!, "active-cancel-worker", new Error("stale"), 0)).toBe("stale");
    const terminalRows = await pool.query<{ events: number; attempts: number }>(
      `SELECT
        (SELECT count(*)::integer FROM workhorse.job_event
          WHERE job_id = $1 AND event_type = 'canceled') AS events,
        (SELECT count(*)::integer FROM workhorse.attempt_history
          WHERE job_id = $1 AND outcome = 'canceled') AS attempts`,
      [id],
    );
    expect(terminalRows.rows[0]).toEqual({ events: 1, attempts: 1 });
  });

  it("delivers CancellationRequestedError and acknowledges cooperative handler settlement", async () => {
    const started = deferred();
    const aborted = deferred<unknown>();
    const id = await queue.enqueue("cooperative-cancel", null);
    const worker = new Worker(queue, {
      workerId: "cooperative-cancel-worker",
      leaseMs: 5_000,
      heartbeatMs: 100,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
    }).handle("cooperative-cancel", async (_payload, context) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          aborted.resolve(context.signal.reason);
          reject(context.signal.reason);
        };
        if (context.signal.aborted) onAbort();
        else context.signal.addEventListener("abort", onAbort, { once: true });
      });
      return null;
    });

    const execution = worker.runOnce();
    await started.promise;
    expect((await queue.cancel(id)).status).toBe("cancel_requested");
    expect(await aborted.promise).toBeInstanceOf(CancellationRequestedError);
    await execution;
    expect(await queue.getJob(id)).toMatchObject({ state: "canceled" });
  });

  it("acknowledges cancellation after a default-concurrency handler ignores AbortSignal", async () => {
    const started = deferred();
    const aborted = deferred<unknown>();
    const release = deferred();
    const id = await queue.enqueue("ignore-cancel", null);
    const worker = new Worker(queue, {
      workerId: "ignore-cancel-worker",
      leaseMs: 5_000,
      heartbeatMs: 100,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
    }).handle("ignore-cancel", async (_payload, context) => {
      expect(worker.concurrency).toBe(1);
      started.resolve();
      context.signal.addEventListener("abort", () => aborted.resolve(context.signal.reason), {
        once: true,
      });
      await release.promise;
      return { ignored: true };
    });

    const execution = worker.runOnce();
    await started.promise;
    await queue.cancel(id);
    expect(await aborted.promise).toBeInstanceOf(CancellationRequestedError);
    expect(await queue.getJob(id)).toMatchObject({ state: "active" });
    release.resolve();
    await execution;
    expect(await queue.getJob(id)).toMatchObject({ state: "canceled", result: null });
  });

  it("isolates cancellation across concurrent default-concurrency workers", async () => {
    const ids = await Promise.all([
      queue.enqueue("concurrent-worker-cancel", { sequence: 1 }),
      queue.enqueue("concurrent-worker-cancel", { sequence: 2 }),
    ]);
    const started = new Set<string>();
    const bothStarted = deferred();
    const canceledSignal = deferred<unknown>();
    const releaseSibling = deferred();
    const handler = async (
      _payload: unknown,
      context: { job: { id: string }; signal: AbortSignal },
    ) => {
      started.add(context.job.id);
      if (started.size === 2) bothStarted.resolve();
      if (context.job.id === ids[0]) {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              canceledSignal.resolve(context.signal.reason);
              reject(context.signal.reason);
            },
            { once: true },
          );
        });
      } else {
        await releaseSibling.promise;
      }
      return null;
    };
    const firstWorker = new Worker(queue, {
      workerId: "concurrent-cancel-a",
      leaseMs: 5_000,
      heartbeatMs: 100,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
    }).handle("concurrent-worker-cancel", handler);
    const secondWorker = new Worker(queue, {
      workerId: "concurrent-cancel-b",
      leaseMs: 5_000,
      heartbeatMs: 100,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
    }).handle("concurrent-worker-cancel", handler);

    expect(firstWorker.concurrency).toBe(1);
    expect(secondWorker.concurrency).toBe(1);
    const running = Promise.all([firstWorker.runOnce(), secondWorker.runOnce()]);
    try {
      await bothStarted.promise;
      expect((await queue.cancel(ids[0]!)).status).toBe("cancel_requested");
      expect(await canceledSignal.promise).toBeInstanceOf(CancellationRequestedError);
      releaseSibling.resolve();
      await running;
      expect(await Promise.all(ids.map((id) => queue.getJob(id)))).toEqual([
        expect.objectContaining({ id: ids[0], state: "canceled" }),
        expect.objectContaining({ id: ids[1], state: "succeeded" }),
      ]);
    } finally {
      releaseSibling.resolve();
      await queue.cancel(ids[0]!).catch(() => undefined);
      await running.catch(() => undefined);
    }
  });

  it("materializes expired requested cancellation instead of retrying and rejects stale fencing", async () => {
    const id = await queue.enqueue("recover-cancel", null, { maxAttempts: 3 });
    const claimed = await queue.claim("recover-cancel-worker", { leaseMs: 5_000 });
    expect(claimed?.id).toBe(id);
    expect((await queue.cancel(id)).status).toBe("cancel_requested");
    await pool.query(
      `UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 second'
        WHERE job_id = $1`,
      [id],
    );
    expect(await queue.acknowledgeCancel(claimed!, "recover-cancel-worker")).toBe(false);
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(id)).toMatchObject({ state: "canceled", currentAttempt: 1 });
    expect(await queue.heartbeatStatus(claimed!, "recover-cancel-worker", 5_000)).toBe("stale");
    expect(await queue.complete(claimed!, "recover-cancel-worker", null)).toBe(false);
    expect(await queue.fail(claimed!, "recover-cancel-worker", new Error("late"), 0)).toBe("stale");
    const history = await pool.query<{ attempt: number; outcome: string }>(
      "SELECT attempt, outcome FROM workhorse.attempt_history WHERE job_id = $1",
      [id],
    );
    expect(history.rows).toEqual([{ attempt: 1, outcome: "canceled" }]);
  });

  it("validates, persists, and idempotently fingerprints deadlines and execution timeouts", async () => {
    const deadline = new Date(Date.now() + 60_000);
    const options = {
      deadline,
      executionTimeoutMs: 2_500,
      idempotency: { key: "deadline-definition", scope: "p1-03" },
    } as const;
    const first = await queue.enqueue("deadline-definition", { value: 1 }, options);
    expect(await queue.enqueue("deadline-definition", { value: 1 }, options)).toBe(first);
    expect(await queue.getJob(first)).toMatchObject({
      deadlineAt: deadline,
      executionTimeoutMs: 2_500,
    });
    await expect(
      queue.enqueue(
        "deadline-definition",
        { value: 1 },
        {
          ...options,
          executionTimeoutMs: 2_501,
        },
      ),
    ).rejects.toMatchObject({
      conflictingFields: ["executionTimeoutMs"],
    });
    await expect(
      queue.enqueue(
        "deadline-definition",
        { value: 1 },
        { ...options, deadline: new Date(deadline.getTime() + 1) },
      ),
    ).rejects.toMatchObject({ conflictingFields: ["deadline"] });
    await expect(
      pool.query(
        `SELECT * FROM workhorse.enqueue_many_v1(
          '[{"queue":"default","type":"invalid-timeout","executionTimeoutMs":0}]'::jsonb
        )`,
      ),
    ).rejects.toThrow(/executionTimeoutMs must be an integer/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.enqueue_many_v1(
          '[{"queue":"default","type":"invalid-deadline","deadline":"infinity"}]'::jsonb
        )`,
      ),
    ).rejects.toThrow(/deadline must be a finite absolute timestamp/);

    const expired = await queue.enqueue("already-expired", null, {
      queue: "expired-deadline-only",
      deadline: new Date(Date.now() - 1_000),
      maxAttempts: 5,
    });
    expect(
      await queue.claim("expired-deadline-worker", { queue: "expired-deadline-only" }),
    ).toBeNull();
    expect(await queue.getJob(expired)).toMatchObject({
      state: "failed",
      currentAttempt: 1,
      fenceToken: 0n,
      error: { name: "DeadlineExceeded" },
    });
    const evidence = await pool.query<{ event_type: string; outcome: string | null }>(
      `SELECT event.event_type, history.outcome
         FROM workhorse.job_event event
         LEFT JOIN workhorse.attempt_history history ON history.job_id = event.job_id
        WHERE event.job_id = $1 AND event.event_type = 'deadline_exceeded'`,
      [expired],
    );
    expect(evidence.rows).toEqual([{ event_type: "deadline_exceeded", outcome: null }]);
  });

  it("cooperatively aborts active deadlines and durably fences handlers that ignore the signal", async () => {
    const started = deferred();
    const aborted = deferred<unknown>();
    const release = deferred();
    const id = await queue.enqueue("ignored-deadline", null, {
      deadline: new Date(Date.now() + 150),
      maxAttempts: 4,
    });
    const worker = new Worker(queue, {
      workerId: "ignored-deadline-worker",
      leaseMs: 5_000,
      heartbeatMs: 50,
    }).handle("ignored-deadline", async (_payload, context) => {
      started.resolve();
      context.signal.addEventListener("abort", () => aborted.resolve(context.signal.reason), {
        once: true,
      });
      await release.promise;
      return { tooLate: true };
    });

    const execution = worker.runOnce();
    await started.promise;
    expect(await aborted.promise).toBeInstanceOf(DeadlineExceededError);
    await sleep(25);
    expect(await queue.getJob(id)).toMatchObject({
      state: "failed",
      currentAttempt: 1,
      result: null,
      error: { name: "DeadlineExceeded" },
    });
    release.resolve();
    await execution;
    const evidence = await pool.query<{ event_type: string; outcome: string }>(
      `SELECT event.event_type, history.outcome
         FROM workhorse.job_event event
         JOIN workhorse.attempt_history history
           ON history.job_id = event.job_id AND history.attempt = event.attempt
        WHERE event.job_id = $1 AND event.event_type = 'deadline_exceeded'`,
      [id],
    );
    expect(evidence.rows).toEqual([
      { event_type: "deadline_exceeded", outcome: "deadline_exceeded" },
    ]);
  });

  it("retries timed-out attempts with remaining budget and terminally distinguishes exhaustion", async () => {
    const reasons: unknown[] = [];
    const id = await queue.enqueue("attempt-timeout", null, {
      executionTimeoutMs: 100,
      maxAttempts: 2,
    });
    const worker = new Worker(queue, {
      workerId: "attempt-timeout-worker",
      leaseMs: 5_000,
      heartbeatMs: 50,
    }).handle("attempt-timeout", async (_payload, context) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            reasons.push(context.signal.reason);
            reject(context.signal.reason);
          },
          { once: true },
        );
      });
      return null;
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await queue.getJob(id)).toMatchObject({ state: "ready", currentAttempt: 2 });
    expect(await worker.runOnce()).toBe(true);
    expect(reasons).toHaveLength(2);
    expect(reasons.every((reason) => reason instanceof ExecutionTimeoutError)).toBe(true);
    expect(await queue.getJob(id)).toMatchObject({
      state: "failed",
      currentAttempt: 2,
      error: { name: "ExecutionTimeout" },
    });
    const evidence = await pool.query<{ outcome: string; source: string }>(
      `SELECT history.outcome, event.details->>'retry_delay_source' AS source
         FROM workhorse.attempt_history history
         JOIN workhorse.job_event event
           ON event.job_id = history.job_id AND event.attempt = history.attempt
          AND event.event_type = 'execution_timed_out'
        WHERE history.job_id = $1 ORDER BY history.attempt`,
      [id],
    );
    expect(evidence.rows).toEqual([
      { outcome: "timeout", source: "execution-timeout-immediate" },
      { outcome: "timeout", source: null },
    ]);
  });

  it("materializes cancellation requested before an overdue deadline without stranding runtime", async () => {
    const id = await queue.enqueue("cancel-before-deadline", null, {
      deadline: new Date(Date.now() + 120),
      maxAttempts: 3,
    });
    const claimed = await queue.claim("cancel-before-deadline-worker", { leaseMs: 5_000 });
    expect(claimed?.id).toBe(id);
    expect((await queue.cancel(id, { reason: "operator won" })).status).toBe("cancel_requested");
    await sleep(140);
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(id)).toMatchObject({
      state: "canceled",
      error: { name: "CancellationRequested", reason: "operator won" },
    });
    const evidence = await pool.query<{ outcome: string; source: string }>(
      `SELECT history.outcome, event.details->>'source' AS source
         FROM workhorse.attempt_history history
         JOIN workhorse.job_event event ON event.job_id = history.job_id
          AND event.attempt = history.attempt AND event.event_type = 'canceled'
        WHERE history.job_id = $1`,
      [id],
    );
    expect(evidence.rows).toEqual([{ outcome: "canceled", source: "deadline_reaper" }]);
  });

  it("classifies the earliest elapsed deadline or execution-timeout boundary", async () => {
    const timeoutFirstId = await queue.enqueue("timeout-before-deadline", null, {
      deadline: new Date(Date.now() + 60_000),
      executionTimeoutMs: 5_000,
      maxAttempts: 2,
    });
    const timeoutFirst = await queue.claim("timeout-before-deadline-worker", { leaseMs: 5_000 });
    expect(timeoutFirst?.id).toBe(timeoutFirstId);
    await pool.query(
      `UPDATE workhorse.job SET deadline_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [timeoutFirstId],
    );
    await pool.query(
      `UPDATE workhorse.job_runtime
          SET deadline_at = clock_timestamp() - interval '1 second',
              attempt_timeout_at = clock_timestamp() - interval '2 seconds'
        WHERE job_id = $1`,
      [timeoutFirstId],
    );
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(timeoutFirstId)).toMatchObject({
      state: "ready",
      currentAttempt: 2,
      error: { name: "ExecutionTimeout" },
    });
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(timeoutFirstId)).toMatchObject({
      state: "failed",
      currentAttempt: 2,
      error: { name: "DeadlineExceeded" },
    });

    const deadlineFirstId = await queue.enqueue("deadline-before-timeout", null, {
      deadline: new Date(Date.now() + 60_000),
      executionTimeoutMs: 5_000,
      maxAttempts: 2,
    });
    const deadlineFirst = await queue.claim("deadline-before-timeout-worker", { leaseMs: 5_000 });
    expect(deadlineFirst?.id).toBe(deadlineFirstId);
    await pool.query(
      `UPDATE workhorse.job SET deadline_at = clock_timestamp() - interval '2 seconds'
        WHERE id = $1`,
      [deadlineFirstId],
    );
    await pool.query(
      `UPDATE workhorse.job_runtime
          SET deadline_at = clock_timestamp() - interval '2 seconds',
              attempt_timeout_at = clock_timestamp() - interval '1 second'
        WHERE job_id = $1`,
      [deadlineFirstId],
    );
    expect(await queue.expireOwned(deadlineFirst!, "deadline-before-timeout-worker")).toBe(
      "deadline_exceeded",
    );
    expect(await queue.getJob(deadlineFirstId)).toMatchObject({
      state: "failed",
      currentAttempt: 1,
      error: { name: "DeadlineExceeded" },
    });
    const outcomes = await pool.query<{ job_id: string; outcome: string }>(
      `SELECT job_id::text, outcome FROM workhorse.attempt_history
        WHERE job_id = ANY($1::uuid[]) ORDER BY job_id, attempt`,
      [[timeoutFirstId, deadlineFirstId]],
    );
    expect(outcomes.rows).toEqual(
      expect.arrayContaining([
        { job_id: timeoutFirstId, outcome: "timeout" },
        { job_id: deadlineFirstId, outcome: "deadline_exceeded" },
      ]),
    );
  });

  it("returns cancellation after waiting behind a concurrent cancellation request", async () => {
    const id = await queue.enqueue("expire-cancel-race", null, {
      deadline: new Date(Date.now() + 60_000),
    });
    const claimed = await queue.claim("expire-cancel-race-worker", { leaseMs: 5_000 });
    expect(claimed?.id).toBe(id);
    await pool.query(
      `UPDATE workhorse.job SET deadline_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE workhorse.job_runtime SET deadline_at = clock_timestamp() - interval '1 second'
        WHERE job_id = $1`,
      [id],
    );

    const cancelClient = await pool.connect();
    try {
      await cancelClient.query("BEGIN");
      await cancelClient.query("SELECT status FROM workhorse.cancel_v1($1, NULL, $2)", [
        id,
        "cancel won row lock",
      ]);
      const expiring = queue.expireOwned(claimed!, "expire-cancel-race-worker");
      await sleep(25);
      await cancelClient.query("COMMIT");
      expect(await expiring).toBe("cancel_requested");
    } finally {
      await cancelClient.query("ROLLBACK").catch(() => undefined);
      cancelClient.release();
    }
    expect(await queue.acknowledgeCancel(claimed!, "expire-cancel-race-worker")).toBe(true);
    expect(await queue.getJob(id)).toMatchObject({
      state: "canceled",
      error: { name: "CancellationRequested", reason: "cancel won row lock" },
    });
  });

  it("excludes durable wait suspension from attempt execution budget while deadlines keep running", async () => {
    let activations = 0;
    const timeoutId = await queue.enqueue("wait-timeout-budget", null, {
      executionTimeoutMs: 300,
    });
    const timeoutWorker = new Worker(queue, {
      workerId: "wait-timeout-budget-worker",
      leaseMs: 5_000,
      heartbeatMs: 50,
    }).handle("wait-timeout-budget", async (_payload, context) => {
      activations += 1;
      if (activations === 1) await context.sleep("pause", 180);
      return { activations };
    });
    expect(await timeoutWorker.runOnce()).toBe(true);
    await sleep(200);
    await queue.promote();
    expect(await timeoutWorker.runOnce()).toBe(true);
    expect(await queue.getJob(timeoutId)).toMatchObject({
      state: "succeeded",
      currentAttempt: 1,
      result: { activations: 2 },
    });

    const deadlineId = await queue.enqueue("wait-deadline", null, {
      deadline: new Date(Date.now() + 120),
      executionTimeoutMs: 5_000,
    });
    const deadlineWorker = new Worker(queue, {
      workerId: "wait-deadline-worker",
      leaseMs: 5_000,
      heartbeatMs: 50,
    }).handle("wait-deadline", async (_payload, context) => {
      await context.sleep("long-pause", 1_000);
      return null;
    });
    expect(await deadlineWorker.runOnce()).toBe(true);
    await sleep(140);
    expect(await queue.recoverExpired()).toBe(1);
    expect(await queue.getJob(deadlineId)).toMatchObject({
      state: "failed",
      currentAttempt: 1,
      error: { name: "DeadlineExceeded" },
    });
  });

  it("reports deadline and active execution-timeout pressure without broad terminal indexes", async () => {
    const deadline = new Date(Date.now() + 30_000);
    const id = await queue.enqueue("deadline-health", null, {
      deadline,
      executionTimeoutMs: 5_000,
    });
    expect((await queue.claim("deadline-health-worker", { leaseMs: 10_000 }))?.id).toBe(id);
    const health = await queue.health();
    expect(health.deadlinePressure).toEqual({
      pending: 1,
      overdue: 0,
      dueWithinMinute: 1,
      earliestAt: deadline,
    });
    expect(health.activeExecutionTimeouts).toBe(1);
    expect(health.overdueExecutionTimeouts).toBe(0);
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'workhorse'
          AND indexname IN ('job_runtime_deadline_idx', 'job_runtime_timeout_idx')
        ORDER BY indexname`,
    );
    expect(indexes.rows).toEqual([
      expect.objectContaining({
        indexname: "job_runtime_deadline_idx",
        indexdef: expect.stringContaining("WHERE (deadline_at IS NOT NULL)"),
      }),
      expect.objectContaining({
        indexname: "job_runtime_timeout_idx",
        indexdef: expect.stringContaining(
          "WHERE ((state = 'active'::text) AND (attempt_timeout_at IS NOT NULL))",
        ),
      }),
    ]);
  });

  it("lock-orders cancellation against completion, failure, heartbeat, checkpoint, and wait", async () => {
    const transitions: Array<{
      name: string;
      query: string;
      expected: Record<string, unknown>;
    }> = [
      {
        name: "complete",
        query: "SELECT workhorse.complete_v1($1, $2, $3, 'null'::jsonb) AS accepted",
        expected: { accepted: false },
      },
      {
        name: "fail",
        query: 'SELECT workhorse.fail_v1($1, $2, $3, \'{"name":"late"}\'::jsonb, 0) AS state',
        expected: { state: "cancel_requested" },
      },
      {
        name: "heartbeat",
        query: "SELECT workhorse.heartbeat_v2($1, $2, $3, 5000) AS status",
        expected: { status: "cancel_requested" },
      },
      {
        name: "checkpoint",
        query: "SELECT status FROM workhorse.save_checkpoint_v1($1, $2, $3, 'late', 'null'::jsonb)",
        expected: { status: "stale" },
      },
      {
        name: "wait",
        query: "SELECT status FROM workhorse.schedule_wait_v1($1, $2, $3, 'late', 1000, NULL)",
        expected: { status: "stale" },
      },
    ];

    for (const transition of transitions) {
      const workerId = `race-${transition.name}`;
      const id = await queue.enqueue(`race-${transition.name}`, null, { maxAttempts: 1 });
      const claimed = await queue.claim(workerId, { leaseMs: 5_000 });
      expect(claimed?.id).toBe(id);
      const locker = await pool.connect();
      try {
        await locker.query("BEGIN");
        const requested = await locker.query<{ status: string }>(
          "SELECT status FROM workhorse.cancel_v1($1, 'race-test', $2)",
          [id, transition.name],
        );
        expect(requested.rows[0]?.status).toBe("cancel_requested");
        const later = pool.query(transition.query, [id, workerId, claimed!.fenceToken.toString()]);
        await locker.query("COMMIT");
        expect((await later).rows[0]).toEqual(transition.expected);
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
      }
      expect(await queue.acknowledgeCancel(claimed!, workerId)).toBe(true);
    }

    for (const terminal of ["complete", "fail"] as const) {
      const workerId = `terminal-wins-${terminal}`;
      const id = await queue.enqueue(`terminal-wins-${terminal}`, null, { maxAttempts: 1 });
      const claimed = await queue.claim(workerId, { leaseMs: 5_000 });
      const locker = await pool.connect();
      try {
        await locker.query("BEGIN");
        let committedState: string | boolean;
        if (terminal === "complete") {
          committedState = (
            await locker.query<{ accepted: boolean }>(
              "SELECT workhorse.complete_v1($1, $2, $3, 'null'::jsonb) AS accepted",
              [id, workerId, claimed!.fenceToken.toString()],
            )
          ).rows[0]!.accepted;
        } else {
          committedState = (
            await locker.query<{ state: string }>(
              'SELECT workhorse.fail_v1($1, $2, $3, \'{"name":"terminal"}\'::jsonb, 0) AS state',
              [id, workerId, claimed!.fenceToken.toString()],
            )
          ).rows[0]!.state;
        }
        expect(committedState).toBe(terminal === "complete" ? true : "failed");
        const cancellation = queue.cancel(id);
        await locker.query("COMMIT");
        expect(await cancellation).toMatchObject({
          status: "already_terminal",
          state: terminal === "complete" ? "succeeded" : "failed",
        });
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
      }
    }
  });

  it("cancels one recurring occurrence without disabling later occurrences", async () => {
    await queue.syncSchedules("cancel-recurring", [
      {
        name: "pulse",
        schedule: "* * * * *",
        job: { type: "recurring-cancel", payload: { value: 1 } },
      },
    ]);
    const [schedule] = await queue.schedules(["cancel-recurring"]);
    const firstId = await queue.fireSchedule(
      schedule!.namespace,
      schedule!.name,
      schedule!.revision,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(firstId).not.toBeNull();
    expect((await queue.cancel(firstId!)).status).toBe("canceled");
    const secondId = await queue.fireSchedule(
      schedule!.namespace,
      schedule!.name,
      schedule!.revision,
      new Date("2026-01-01T00:01:00.000Z"),
    );
    expect(secondId).not.toBeNull();
    expect(secondId).not.toBe(firstId);
    expect(await queue.getJob(secondId!)).toMatchObject({ state: "ready" });
    expect((await queue.schedules(["cancel-recurring"])).map((item) => item.name)).toEqual([
      "pulse",
    ]);
  });

  it("includes canceled jobs in health counts", async () => {
    const canceledId = await queue.enqueue("health-canceled", null);
    await queue.cancel(canceledId);
    await queue.enqueue("health-ready", null);
    const health = await queue.health();
    expect(health.schemaVersion).toBe(16);
    expect(health.counts).toEqual({
      scheduled: 0,
      ready: 1,
      active: 0,
      succeeded: 0,
      failed: 0,
      canceled: 1,
    });
  });

  it("synchronizes namespaced worker schedules and safely prunes removed definitions", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "0 6 * * *",
        job: {
          type: "generate-report",
          payload: { scope: "daily" },
          queue: "reports",
          maxAttempts: 5,
        },
      },
      {
        name: "disabled-cleanup",
        schedule: "0 2 * * 0",
        enabled: false,
        job: { type: "cleanup", payload: null },
      },
    ]);

    expect(
      (
        await pool.query(
          `SELECT schedule_name, cron_expression, queue_name, job_type, payload, max_attempts,
                  enabled, revision::text
             FROM workhorse.schedule_definition
            WHERE namespace = 'integration'
            ORDER BY schedule_name`,
        )
      ).rows,
    ).toEqual([
      {
        schedule_name: "daily-report",
        cron_expression: "0 6 * * *",
        queue_name: "reports",
        job_type: "generate-report",
        payload: { scope: "daily" },
        max_attempts: 5,
        enabled: true,
        revision: "1",
      },
      {
        schedule_name: "disabled-cleanup",
        cron_expression: "0 2 * * 0",
        queue_name: "default",
        job_type: "cleanup",
        payload: null,
        max_attempts: 25,
        enabled: false,
        revision: "1",
      },
    ]);

    await queue.syncSchedules("integration-other", [
      {
        name: "other-report",
        schedule: "0 8 * * *",
        job: { type: "other-report", payload: {} },
      },
    ]);
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "30 6 * * *",
        job: { type: "generate-report", payload: { scope: "changed" }, queue: "reports" },
      },
    ]);

    expect(
      (
        await pool.query(
          "SELECT namespace, schedule_name, enabled, revision::text FROM workhorse.schedule_definition ORDER BY namespace, schedule_name",
        )
      ).rows,
    ).toEqual([
      {
        namespace: "integration",
        schedule_name: "daily-report",
        enabled: true,
        revision: "2",
      },
      {
        namespace: "integration",
        schedule_name: "disabled-cleanup",
        enabled: false,
        revision: "1",
      },
      {
        namespace: "integration-other",
        schedule_name: "other-report",
        enabled: true,
        revision: "1",
      },
    ]);
  });

  it("rejects invalid cron expressions before persisting a schedule", async () => {
    await expect(
      queue.syncSchedules("integration", [
        {
          name: "invalid",
          schedule: "every sometime",
          job: { type: "invalid", payload: {} },
        },
      ]),
    ).rejects.toThrow(/Invalid cron expression for schedule invalid/);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.schedule_definition"))
        .rows[0]?.count,
    ).toBe(0);
  });

  it("lets workers coordinate recurring occurrences without duplicate jobs", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "heartbeat",
        schedule: "* * * * * *",
        job: { type: "cron-tick", payload: { source: "worker" } },
      },
    ]);
    const first = new Worker(queue, {
      workerId: "scheduler-a",
      scheduleNamespaces: ["integration"],
    }).handle("cron-tick", () => ({ worker: "a" }));
    const second = new Worker(queue, {
      workerId: "scheduler-b",
      scheduleNamespaces: ["integration"],
    }).handle("cron-tick", () => ({ worker: "b" }));

    expect((await Promise.all([first.runOnce(), second.runOnce()])).filter(Boolean)).toHaveLength(
      1,
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = 'integration' AND schedule_name = 'heartbeat'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(1);
  });

  it("rejects stale schedule revisions after a definition changes", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "revision-fence",
        schedule: "0 * * * *",
        job: { type: "old", payload: { revision: 1 } },
      },
    ]);
    const [oldDefinition] = await queue.schedules(["integration"]);
    await queue.syncSchedules("integration", [
      {
        name: "revision-fence",
        schedule: "30 * * * *",
        job: { type: "new", payload: { revision: 2 } },
      },
    ]);

    expect(
      await queue.fireSchedule(
        oldDefinition!.namespace,
        oldDefinition!.name,
        oldDefinition!.revision,
        new Date("2026-07-22T13:30:00.000Z"),
      ),
    ).toBeNull();
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(0);
  });

  it("deduplicates concurrent calls at the schedule occurrence boundary", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "hourly-rollup",
        schedule: "0 * * * *",
        job: { type: "rollup", payload: { scope: "hourly" } },
      },
    ]);
    const [definition] = await queue.schedules(["integration"]);
    const occurrence = new Date("2026-07-22T13:00:00.000Z");
    const results = await Promise.all([
      queue.fireSchedule("integration", "hourly-rollup", definition!.revision, occurrence),
      queue.fireSchedule("integration", "hourly-rollup", definition!.revision, occurrence),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = 'integration' AND schedule_name = 'hourly-rollup'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("releases only an ordinary scheduled task now and preserves recurring schedule state", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "0 8 * * *",
        job: { type: "report", payload: { scope: "daily" } },
      },
    ]);
    const scheduleBefore = await pool.query(
      `SELECT namespace, schedule_name, cron_expression, revision, enabled, updated_at
         FROM workhorse.schedule_definition
        WHERE namespace = 'integration' AND schedule_name = 'daily-report'`,
    );
    const originalRunAt = new Date(Date.now() + 3_600_000);
    const jobId = await queue.enqueue(
      "manual-release",
      {},
      {
        queue: "manual-release",
        runAt: originalRunAt,
      },
    );
    const requestedAt = Date.now();

    await expect(queue.runTaskNow(jobId)).resolves.toMatchObject({
      status: "released",
      jobId,
      state: "ready",
      runAt: expect.any(Date),
    });
    const released = await queue.getJob(jobId);
    expect(released).toMatchObject({ state: "ready" });
    expect(released!.runAt.getTime()).toBeGreaterThanOrEqual(requestedAt);
    expect(released!.runAt.getTime()).toBeLessThan(originalRunAt.getTime());
    await expect(queue.runTaskNow(jobId)).resolves.toMatchObject({
      status: "already_ready",
      state: "ready",
      runAt: released!.runAt,
    });
    await expect(
      pool.query(
        `SELECT attempt, event_type, details FROM workhorse.job_event
          WHERE job_id = $1 AND event_type = 'promoted'`,
        [jobId],
      ),
    ).resolves.toMatchObject({
      rows: [{ attempt: 1, event_type: "promoted", details: { reason: "manual" } }],
    });
    await expect(
      pool.query(
        `SELECT namespace, schedule_name, cron_expression, revision, enabled, updated_at
           FROM workhorse.schedule_definition
          WHERE namespace = 'integration' AND schedule_name = 'daily-report'`,
      ),
    ).resolves.toEqual(scheduleBefore);

    const waitingId = await queue.enqueue("durable-wait", {}, { queue: "durable-wait" });
    const claimed = await queue.claim("wait-worker", { queue: "durable-wait" });
    expect(claimed?.id).toBe(waitingId);
    await queue.scheduleWait(claimed!, "wait-worker", "approval", {
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    const waitingBefore = await queue.getJob(waitingId);
    await expect(queue.runTaskNow(waitingId)).resolves.toMatchObject({
      status: "waiting",
      jobId: waitingId,
      state: "scheduled",
      runAt: waitingBefore!.runAt,
    });
    await expect(queue.getJob(waitingId)).resolves.toMatchObject({
      state: "scheduled",
      runAt: waitingBefore!.runAt,
    });

    const terminalId = await queue.enqueue("terminal", {}, { queue: "run-now-terminal" });
    const terminalClaim = await queue.claim("terminal-worker", { queue: "run-now-terminal" });
    expect(terminalClaim?.id).toBe(terminalId);
    expect(await queue.complete(terminalClaim!, "terminal-worker", { ok: true })).toBe(true);
    await expect(queue.runTaskNow(terminalId)).resolves.toMatchObject({
      status: "not_scheduled",
      jobId: terminalId,
      state: "succeeded",
    });
    await expect(queue.runTaskNow("00000000-0000-4000-8000-000000000099")).resolves.toEqual({
      status: "not_found",
      jobId: "00000000-0000-4000-8000-000000000099",
      state: null,
      runAt: null,
    });
  });

  it("returns per-phase tick and background maintenance telemetry", async () => {
    const scheduledId = await queue.enqueue(
      "scheduled-maintenance",
      {},
      { runAt: new Date(Date.now() + 80) },
    );
    await sleep(100);
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, job_type, payload, max_attempts
       ) VALUES ('integration', 'retention', '0 * * * *', 'default', 'retention', '{}'::jsonb, 3)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
       VALUES ('integration', 'retention', clock_timestamp() - interval '40 days'),
              ('integration', 'retention', clock_timestamp() - interval '39 days')`,
    );

    expect(await queue.tick()).toEqual([
      {
        phase: "promote",
        rowsAffected: 1,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "recover",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
    ]);
    expect((await queue.getJob(scheduledId))?.state).toBe("ready");

    await queue.syncRetentionPolicy({ ...defaultRetentionPolicy, occurrenceRowsPerPass: 1 });
    expect([
      ...(await queue.prepareHistoryPartitions({ force: true })),
      ...(await queue.retainHistory({ force: true })),
      ...(await queue.pruneTerminalStorage({ force: true })),
    ]).toEqual([
      {
        phase: "history_partitions",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "event_retention",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "attempt_retention",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "schedule_occurrences",
        rowsAffected: 1,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "enqueue_idempotency",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "terminal_jobs",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = 'integration' AND schedule_name = 'retention'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("returns skipped phase rows when another session owns a maintenance loop lock", async () => {
    const blocker = await pool.connect();
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtextextended('workhorse:tick', 0))");
      expect(await queue.tick()).toEqual([
        { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
        { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
      ]);
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended('workhorse:tick', 0))");

      await blocker.query(
        "SELECT pg_advisory_lock(hashtextextended('workhorse:maintenance:history-partitions', 0))",
      );
      expect(await queue.prepareHistoryPartitions({ force: true })).toEqual([
        {
          phase: "history_partitions",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
      ]);
      await blocker.query("SELECT pg_advisory_unlock_all()");
      await blocker.query(
        "SELECT pg_advisory_lock(hashtextextended('workhorse:maintenance:history-retention', 0))",
      );
      expect(await queue.retainHistory({ force: true })).toEqual([
        {
          phase: "event_retention",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
        {
          phase: "attempt_retention",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
        {
          phase: "schedule_occurrences",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
      ]);
      await blocker.query("SELECT pg_advisory_unlock_all()");
      await blocker.query(
        "SELECT pg_advisory_lock(hashtextextended('workhorse:maintenance:terminal-storage', 0))",
      );
      expect(await queue.pruneTerminalStorage({ force: true })).toEqual([
        {
          phase: "enqueue_idempotency",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
        {
          phase: "terminal_jobs",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
      ]);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()");
      blocker.release();
    }
  });

  it("persists one IANA maintenance timezone and runs daily retention once after local 03:00", async () => {
    expect(
      await queue.syncMaintenancePolicy({
        timezone: "America/New_York",
        partitionPreparationIntervalMs: 3_600_000,
        terminalCleanupIntervalMs: 60_000,
        historyRetentionLocalHour: 3,
      }),
    ).toMatchObject({
      timezone: "America/New_York",
      partitionPreparationIntervalMs: 3_600_000,
      terminalCleanupIntervalMs: 60_000,
      historyRetentionLocalHour: 3,
    });
    await expect(queue.syncMaintenancePolicy({ timezone: "Mars/Olympus_Mons" })).rejects.toThrow(
      /valid IANA timezone/,
    );

    const beforeSpringForwardBoundary = new Date("2026-03-08T06:59:00.000Z");
    const atSpringForwardBoundary = new Date("2026-03-08T07:00:00.000Z");
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
          "SELECT last_completed_local_date FROM workhorse.maintenance_state WHERE task_name = 'history_retention'",
        )
      ).rows,
    ).toEqual([{ last_completed_local_date: new Date("2026-03-08T05:00:00.000Z") }]);
  });

  it("continues bounded occurrence retention on the same local date until the backlog clears", async () => {
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, job_type, payload, max_attempts
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
    await queue.syncMaintenancePolicy({ timezone: "UTC", historyRetentionLocalHour: 3 });

    const first = await queue.retainHistory({ now: new Date("2026-08-02T03:00:00.000Z") });
    const second = await queue.retainHistory({ now: new Date("2026-08-02T03:01:00.000Z") });
    const third = await queue.retainHistory({ now: new Date("2026-08-02T03:02:00.000Z") });
    expect(first[2]).toMatchObject({ phase: "schedule_occurrences", rowsAffected: 1 });
    expect(second[2]).toMatchObject({ phase: "schedule_occurrences", rowsAffected: 1 });
    expect(third).toEqual([]);
  });

  it("globally rate-limits interval maintenance tasks while allowing explicit forced runs", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    expect(await queue.prepareHistoryPartitions({ now })).toHaveLength(1);
    expect(await queue.prepareHistoryPartitions({ now: new Date(now.getTime() + 1_000) })).toEqual(
      [],
    );
    expect(await queue.prepareHistoryPartitions({ force: true, now })).toHaveLength(1);

    expect(await queue.pruneTerminalStorage({ now })).toHaveLength(2);
    expect(await queue.pruneTerminalStorage({ now: new Date(now.getTime() + 1_000) })).toEqual([]);
    expect(await queue.pruneTerminalStorage({ force: true, now })).toHaveLength(2);
  });

  it("isolates housekeeping phases when partition replenishment fails", async () => {
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, job_type, payload, max_attempts
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
        EXECUTE format('DROP TABLE workhorse.%I', 'job_event_' || suffix);
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
  it("refuses to turn an existing v1 schema into a mixed installation", async () => {
    await pool.query("DROP SCHEMA workhorse CASCADE");
    try {
      await pool.query(`
        CREATE SCHEMA workhorse;
        CREATE TABLE workhorse.schema_version (version integer PRIMARY KEY);
        INSERT INTO workhorse.schema_version(version) VALUES (1);
        CREATE TABLE workhorse.job_current (id uuid PRIMARY KEY)`);
      await expect(installSchema(pool)).rejects.toThrow(/non-v16 or mixed workhorse schema/);
      const version = await pool.query<{ version: number }>(
        "SELECT version FROM workhorse.schema_version",
      );
      expect(version.rows).toEqual([{ version: 1 }]);
      expect(
        (await pool.query("SELECT to_regclass('workhorse.job_runtime') AS relation")).rows[0],
      ).toEqual({ relation: null });
    } finally {
      await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
      await installSchema(pool);
    }
  });

  it("enqueues a mixed batch atomically while preserving result and ready FIFO order", async () => {
    const runAt = new Date(Date.now() + 60_000);
    const ids = await queue.enqueueMany([
      { type: "first", payload: { order: 1 } },
      { type: "later", payload: { order: 2 }, options: { runAt } },
      { type: "third", payload: { order: 3 }, options: { maxAttempts: 5 } },
    ]);

    expect(ids).toHaveLength(3);
    expect((await queue.getJob(ids[0]!))?.type).toBe("first");
    expect((await queue.getJob(ids[1]!))?.state).toBe("scheduled");
    expect((await queue.getJob(ids[2]!))?.maxAttempts).toBe(5);
    expect((await queue.claim("worker-a"))?.id).toBe(ids[0]);
    expect((await queue.claim("worker-b"))?.id).toBe(ids[2]);

    const events = await pool.query<{ job_id: string; event_type: string }>(
      "SELECT job_id, event_type FROM workhorse.job_event WHERE event_type = 'enqueued' ORDER BY event_id",
    );
    expect(events.rows).toEqual(ids.map((jobId) => ({ job_id: jobId, event_type: "enqueued" })));
  });

  it("replays an equivalent scoped key without duplicate job, event, FIFO, or notify effects", async () => {
    const queueName = "idempotency-replay";
    const rawKey = "sensitive-request-key-that-must-never-leak";
    const scope = "tenant-a";
    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (message) => notifications.push(message.payload ?? ""));
    try {
      await listener.query("LISTEN workhorse_jobs");
      const options = {
        queue: queueName,
        tags: ["durable"],
        retryPolicy: { type: "fixed" as const, delayMs: 25 },
        idempotency: { key: rawKey, scope, ttlMs: 60_000 },
      };
      const first = await queue.enqueue("invoice.capture", { invoiceId: "inv-1" }, options);
      const firstRuntime = await pool.query<{ sequence: string }>(
        "SELECT sequence::text FROM workhorse.job_runtime WHERE job_id = $1",
        [first],
      );
      const firstSequenceState = await pool.query<{ last_value: string; is_called: boolean }>(
        "SELECT last_value::text, is_called FROM workhorse.ready_sequence_seq",
      );
      await sleep(10);
      const replay = await queue.enqueue("invoice.capture", { invoiceId: "inv-1" }, options);
      await sleep(50);

      expect(replay).toBe(first);
      expect(
        (
          await pool.query(`SELECT
            (SELECT count(*)::integer FROM workhorse.job) AS jobs,
            (SELECT count(*)::integer FROM workhorse.job_event) AS events,
            (SELECT count(*)::integer FROM workhorse.job_runtime) AS runtimes`)
        ).rows[0],
      ).toEqual({ jobs: 1, events: 1, runtimes: 1 });
      expect(
        (
          await pool.query<{ sequence: string }>(
            "SELECT sequence::text FROM workhorse.job_runtime WHERE job_id = $1",
            [first],
          )
        ).rows,
      ).toEqual(firstRuntime.rows);
      expect(
        (
          await pool.query<{ last_value: string; is_called: boolean }>(
            "SELECT last_value::text, is_called FROM workhorse.ready_sequence_seq",
          )
        ).rows,
      ).toEqual(firstSequenceState.rows);
      expect(notifications.filter((payload) => payload === queueName)).toHaveLength(1);
      const event = await pool.query<{ details: Record<string, unknown> }>(
        "SELECT details FROM workhorse.job_event WHERE job_id = $1 AND event_type = 'enqueued'",
        [first],
      );
      const storedDigest = await pool.query<{ request_digest: string }>(
        `SELECT workhorse.sha256_hex_v1(request_fingerprint::text) AS request_digest
           FROM workhorse.enqueue_idempotency WHERE job_id = $1`,
        [first],
      );
      expect(event.rows[0]?.details).toMatchObject({
        idempotency: {
          scope,
          key_preview: safeKeyPreview(rawKey),
          key_digest: safeKeyDigest(scope, rawKey),
          key_length: [...rawKey].length,
          ttl_ms: 60_000,
          expires_at: expect.any(String),
          request_digest: storedDigest.rows[0]?.request_digest,
        },
      });
      expect(JSON.stringify(event.rows[0]?.details)).not.toContain(rawKey);
    } finally {
      await listener.query("UNLISTEN workhorse_jobs");
      listener.release();
    }
  });

  it("isolates keys by scope and applies documented defaults", async () => {
    const first = await queue.enqueue("scoped", {}, { idempotency: { key: "shared" } });
    const replay = await queue.enqueue(
      "scoped",
      {},
      {
        idempotency: {
          key: "shared",
          scope: DEFAULT_IDEMPOTENCY_SCOPE,
          ttlMs: DEFAULT_IDEMPOTENCY_TTL_MS,
        },
      },
    );
    const otherScope = await queue.enqueue(
      "scoped",
      {},
      {
        idempotency: { key: "shared", scope: "other" },
      },
    );

    expect(replay).toBe(first);
    expect(otherScope).not.toBe(first);
    expect(
      (
        await pool.query(
          `SELECT idempotency_scope, job_id
             FROM workhorse.enqueue_idempotency ORDER BY idempotency_scope`,
        )
      ).rows,
    ).toEqual([
      { idempotency_scope: "default", job_id: first },
      { idempotency_scope: "other", job_id: otherScope },
    ]);
  });

  it("raises a typed conflict for material request or retention-window mismatch", async () => {
    const rawKey = "private-conflict-key-that-must-not-leak";
    const scope = "tenant";
    const first = await queue.enqueue(
      "conflict",
      { version: 1 },
      {
        queue: "critical",
        maxAttempts: 3,
        idempotency: { key: rawKey, scope, ttlMs: 60_000 },
      },
    );
    const conflict = await queue
      .enqueue(
        "conflict",
        { version: 2 },
        {
          queue: "critical",
          maxAttempts: 3,
          idempotency: { key: rawKey, scope, ttlMs: 60_000 },
        },
      )
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(EnqueueIdempotencyConflictError);
    expect(conflict).toMatchObject({
      scope,
      keyPreview: safeKeyPreview(rawKey),
      keyDigest: safeKeyDigest(scope, rawKey),
      keyLength: [...rawKey].length,
      existingJobId: first,
      ordinal: 1,
      conflictingFields: ["payload"],
      storedRequestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      rejectedRequestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(conflict).not.toHaveProperty("key");
    expect(JSON.stringify(conflict)).not.toContain(rawKey);
    expect((conflict as Error).message).not.toContain(rawKey);
    const expectedDigests = await pool.query<{
      stored_request_digest: string;
      rejected_request_digest: string;
    }>(
      `SELECT workhorse.sha256_hex_v1(request_fingerprint::text) AS stored_request_digest,
              workhorse.sha256_hex_v1(
                jsonb_set(request_fingerprint, '{payload}', '{"version": 2}'::jsonb)::text
              ) AS rejected_request_digest
         FROM workhorse.enqueue_idempotency WHERE job_id = $1`,
      [first],
    );
    expect(conflict).toMatchObject({
      storedRequestDigest: expectedDigests.rows[0]?.stored_request_digest,
      rejectedRequestDigest: expectedDigests.rows[0]?.rejected_request_digest,
    });

    const rawSqlError = await pool
      .query("SELECT * FROM workhorse.enqueue_many_v1($1::jsonb)", [
        JSON.stringify([
          {
            queue: "critical",
            type: "conflict",
            payload: { version: 2 },
            maxAttempts: 3,
            retryPolicy: null,
            tags: [],
            idempotency: { key: rawKey, scope, ttlMs: 60_000 },
          },
        ]),
      ])
      .catch((error: unknown) => error);
    expect(rawSqlError).toMatchObject({ code: "P1001" });
    expect(JSON.stringify(rawSqlError)).not.toContain(rawKey);
    await expect(
      queue.enqueue(
        "conflict",
        { version: 1 },
        {
          queue: "critical",
          maxAttempts: 3,
          idempotency: { key: rawKey, scope, ttlMs: 60_001 },
        },
      ),
    ).rejects.toMatchObject({ conflictingFields: ["ttlMs"] });
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0],
    ).toEqual({ count: 1 });
  });

  it("treats tags as a set for replay while preserving the first job's stored tag order", async () => {
    const first = await queue.enqueue(
      "tag-equivalence",
      {},
      {
        tags: ["zeta", "alpha", "zeta"],
        idempotency: { key: "tag-equivalence" },
      },
    );
    const replay = await queue.enqueue(
      "tag-equivalence",
      {},
      {
        tags: ["alpha", "zeta"],
        idempotency: { key: "tag-equivalence" },
      },
    );
    expect(replay).toBe(first);
    expect((await queue.getJob(first))?.tags).toEqual(["zeta", "alpha", "zeta"]);
  });

  it("keeps omitted keyed runAt replayable but treats explicit runAt as material", async () => {
    const omitted = await queue.enqueue(
      "run-at-omitted",
      {},
      {
        idempotency: { key: "run-at-omitted" },
      },
    );
    await sleep(10);
    await expect(
      queue.enqueue("run-at-omitted", {}, { idempotency: { key: "run-at-omitted" } }),
    ).resolves.toBe(omitted);

    const firstRunAt = new Date(Date.now() + 60_000);
    await queue.enqueue(
      "run-at-explicit",
      {},
      {
        runAt: firstRunAt,
        idempotency: { key: "run-at-explicit" },
      },
    );
    await expect(
      queue.enqueue(
        "run-at-explicit",
        {},
        {
          runAt: new Date(firstRunAt.getTime() + 1),
          idempotency: { key: "run-at-explicit" },
        },
      ),
    ).rejects.toMatchObject({ conflictingFields: ["runAt"] });
  });

  it("preserves v9 default runAt serialization only for unkeyed requests", async () => {
    let serialized: Array<Record<string, unknown>> = [];
    const transaction: Queryable = {
      async query() {
        serialized = JSON.parse(String(arguments[1]?.[0])) as Array<Record<string, unknown>>;
        return { rows: [{ job_id: "unkeyed" }, { job_id: "keyed" }] } as never;
      },
    };
    await queue.enqueueMany(
      [
        { type: "unkeyed", payload: {} },
        { type: "keyed", payload: {}, options: { idempotency: { key: "keyed" } } },
      ],
      transaction,
    );
    expect(serialized[0]?.runAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(serialized[1]).not.toHaveProperty("runAt");
  });

  it("sanitizes syntactically valid malformed PostgreSQL conflict details", async () => {
    const transaction: Queryable = {
      async query() {
        throw { code: "P1001", detail: JSON.stringify({ scope: "partial" }) };
      },
    };
    const error = await queue
      .enqueue("malformed-conflict", {}, { idempotency: { key: "secret" } }, transaction)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EnqueueIdempotencyConflictError);
    expect(error).toMatchObject({
      details: {
        scope: "unknown",
        keyPreview: "unknown",
        keyDigest: "000000000000",
        keyLength: 0,
        existingJobId: "unknown",
        ordinal: 0,
        conflictingFields: [],
        storedRequestDigest: "0".repeat(64),
        rejectedRequestDigest: "0".repeat(64),
      },
    });
    expect((error as Error).message).not.toContain("undefined");
  });

  it("preserves safe PostgreSQL conflict details through adapter error causes", async () => {
    const details = {
      scope: "tenant-safe",
      keyPreview: "wrapped-key",
      keyDigest: "0123456789ab",
      keyLength: 11,
      existingJobId: "123e4567-e89b-42d3-a456-426614174000",
      ordinal: 2,
      conflictingFields: ["payload", "ttlMs"],
      storedRequestDigest: "a".repeat(64),
      rejectedRequestDigest: "b".repeat(64),
    };
    const postgresError = Object.assign(new Error("PostgreSQL conflict"), {
      detail: JSON.stringify(details),
    });
    const adapterError = Object.assign(
      new Error("Adapter query failed", { cause: postgresError }),
      {
        code: "P1001",
      },
    );
    const transaction: Queryable = {
      async query() {
        throw adapterError;
      },
    };

    const error = await queue
      .enqueue("wrapped-conflict", {}, { idempotency: { key: "wrapped-key" } }, transaction)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnqueueIdempotencyConflictError);
    expect(error).toMatchObject({ details, ...details });
  });

  it("validates idempotency UTF-8 byte and TTL bounds in PostgreSQL", async () => {
    expect(Buffer.byteLength("é".repeat(256))).toBe(MAX_IDEMPOTENCY_KEY_BYTES);
    expect(Buffer.byteLength("é".repeat(128))).toBe(MAX_IDEMPOTENCY_SCOPE_BYTES);
    await expect(
      queue.enqueue(
        "bounds",
        {},
        {
          idempotency: {
            key: "é".repeat(256),
            scope: "é".repeat(128),
            ttlMs: MAX_IDEMPOTENCY_TTL_MS,
          },
        },
      ),
    ).resolves.toEqual(expect.any(String));
    await expect(
      queue.enqueue("bounds-minimum", {}, { idempotency: { key: "minimum-ttl", ttlMs: 1 } }),
    ).resolves.toEqual(expect.any(String));
    await expect(
      queue.enqueue("bounds", {}, { idempotency: { key: "é".repeat(257) } }),
    ).rejects.toThrow(/512 UTF-8 bytes/);
    await expect(
      queue.enqueue("bounds", {}, { idempotency: { key: "scope", scope: "é".repeat(129) } }),
    ).rejects.toThrow(/256 UTF-8 bytes/);
    for (const ttlMs of [0, 1.5, MAX_IDEMPOTENCY_TTL_MS + 1]) {
      await expect(
        queue.enqueue(
          "bounds",
          {},
          {
            idempotency: { key: `ttl-${ttlMs}`, ttlMs } as never,
          },
        ),
      ).rejects.toThrow(/ttlMs must be an integer/);
    }
    await expect(
      pool.query(
        `SELECT * FROM workhorse.enqueue_many_v1(
          '[{"queue":"default","type":"direct","idempotency":{"key":""}}]'::jsonb
        )`,
      ),
    ).rejects.toThrow(/1 and 512 UTF-8 bytes/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.enqueue_many_v1(
          '[{"queue":"default","type":"direct","idempotency":{}}]'::jsonb
        )`,
      ),
    ).rejects.toThrow(/requires a string key/);
  });

  it("serializes concurrent exact replays through the scoped unique index", async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, () =>
        queue.enqueue(
          "concurrent",
          { stable: true },
          {
            idempotency: { key: "concurrent-key", scope: "tenant", ttlMs: 60_000 },
          },
        ),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    expect(
      (
        await pool.query(`SELECT
          (SELECT count(*)::integer FROM workhorse.job) AS jobs,
          (SELECT count(*)::integer FROM workhorse.enqueue_idempotency) AS keys,
          (SELECT count(*)::integer FROM workhorse.job_event) AS events`)
      ).rows[0],
    ).toEqual({ jobs: 1, keys: 1, events: 1 });
  });

  it("prevents reverse-order overlapping keyed batches from deadlocking", async () => {
    const runBatch = async (order: readonly [string, string]) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '2s'");
        const ids = await queue.enqueueMany(
          order.map((key) => ({
            type: `deadlock-${key}`,
            payload: { key },
            options: { idempotency: { key, scope: "deadlock", ttlMs: 60_000 } },
          })),
          client,
        );
        await client.query("COMMIT");
        return ids;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
    const [forward, reverse] = await Promise.all([
      runBatch(["alpha", "omega"]),
      runBatch(["omega", "alpha"]),
    ]);
    expect(forward[0]).toBe(reverse[1]);
    expect(forward[1]).toBe(reverse[0]);
    expect(new Set([...forward, ...reverse]).size).toBe(2);
  });

  it("preserves same-batch ordering for keyed and unkeyed requests and rolls back conflicts", async () => {
    const ids = await queue.enqueueMany([
      { type: "keyed-a", payload: { order: 1 }, options: { idempotency: { key: "a" } } },
      { type: "keyed-a", payload: { order: 1 }, options: { idempotency: { key: "a" } } },
      { type: "unkeyed", payload: { order: 2 } },
      { type: "keyed-b", payload: { order: 3 }, options: { idempotency: { key: "b" } } },
    ]);
    expect(ids[1]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(3);
    expect((await queue.claim("batch-1"))?.id).toBe(ids[0]);
    expect((await queue.claim("batch-2"))?.id).toBe(ids[2]);
    expect((await queue.claim("batch-3"))?.id).toBe(ids[3]);

    await expect(
      queue.enqueueMany([
        { type: "before", payload: {}, options: { idempotency: { key: "rollback-before" } } },
        { type: "same", payload: { value: 1 }, options: { idempotency: { key: "collision" } } },
        { type: "same", payload: { value: 2 }, options: { idempotency: { key: "collision" } } },
      ]),
    ).rejects.toMatchObject({ name: "EnqueueIdempotencyConflictError", ordinal: 3 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.enqueue_idempotency WHERE job_id IN (SELECT id FROM workhorse.job WHERE job_type IN ('before', 'same'))",
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  });

  it("rolls back keyed enqueue with caller transactions and permits expiry reuse", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await queue.enqueue("transactional", {}, { idempotency: { key: "rolled-back" } }, client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.enqueue_idempotency"))
        .rows[0],
    ).toEqual({ count: 0 });

    const first = await queue.enqueue(
      "expiring",
      { version: 1 },
      {
        idempotency: { key: "reuse", ttlMs: 5 },
      },
    );
    await sleep(15);
    const reused = await queue.enqueue(
      "expiring",
      { version: 2 },
      {
        idempotency: { key: "reuse", ttlMs: 5 },
      },
    );
    expect(reused).not.toBe(first);
    expect((await queue.getJob(first))?.payload).toEqual({ version: 1 });
    expect((await queue.getJob(reused))?.payload).toEqual({ version: 2 });
  });

  it("keeps omitted-key enqueue behavior fully non-deduplicating", async () => {
    const first = await queue.enqueue("ordinary", { same: true });
    const second = await queue.enqueue("ordinary", { same: true });
    expect(second).not.toBe(first);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0],
    ).toEqual({ count: 2 });
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.enqueue_idempotency"))
        .rows[0],
    ).toEqual({ count: 0 });
    const events = await pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM workhorse.job_event ORDER BY event_id",
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows.every((row) => !("idempotency" in row.details))).toBe(true);
  });

  it("round-trips tags and supports indexed overlap filtering", async () => {
    const billingId = await queue.enqueue(
      "invoice.capture",
      { invoiceId: "inv-1" },
      { tags: ["billing", "priority"] },
    );
    const reportId = (
      await queue.enqueueMany([
        { type: "report.weekly", payload: {}, tags: ["reports", "weekly"] },
        { type: "email.send", payload: {}, tags: ["email", "transactional"] },
      ])
    )[0]!;

    await expect(queue.getJob(billingId)).resolves.toMatchObject({
      id: billingId,
      tags: ["billing", "priority"],
    });
    await expect(queue.getJob(reportId)).resolves.toMatchObject({
      id: reportId,
      tags: ["reports", "weekly"],
    });
    const tagged = await pool.query<{ id: string }>(
      "SELECT id FROM workhorse.job WHERE tags && $1::text[] ORDER BY id",
      [["billing", "weekly"]],
    );
    expect(new Set(tagged.rows.map((row) => row.id))).toEqual(new Set([billingId, reportId]));

    await expect(queue.enqueue("invalid", {}, { tags: [""] })).rejects.toThrow(/non-empty tags/);
    await expect(
      queue.enqueue(
        "too-many",
        {},
        { tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) },
      ),
    ).rejects.toThrow(/at most 20/);
  });

  it("pauses claims, resumes dispatch, and purges only non-active jobs from one queue", async () => {
    const queueName = "managed";
    const activeId = await queue.enqueue("active", {}, { queue: queueName });
    const active = await queue.claim("worker-active", { queue: queueName });
    expect(active?.id).toBe(activeId);

    const readyId = await queue.enqueue("ready", {}, { queue: queueName });
    const scheduledId = await queue.enqueue(
      "scheduled",
      {},
      {
        queue: queueName,
        runAt: new Date(Date.now() + 60_000),
      },
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at
       ) VALUES ($1, 1, 1, 'purge-history-worker', 'succeeded', clock_timestamp(), clock_timestamp())`,
      [scheduledId],
    );
    const otherId = await queue.enqueue("other", {}, { queue: "other" });

    await queue.pauseQueue(queueName);
    expect(await queue.claim("worker-paused", { queue: queueName })).toBeNull();
    expect(
      await pool.query("SELECT paused FROM workhorse.queue_control WHERE queue_name = $1", [
        queueName,
      ]),
    ).toMatchObject({ rows: [{ paused: true }] });

    await queue.resumeQueue(queueName);
    expect((await queue.claim("worker-resumed", { queue: queueName }))?.id).toBe(readyId);

    await queue.enqueue("ready-after-resume", {}, { queue: queueName });
    expect(await queue.purgeQueue(queueName)).toBe(2);
    expect(await queue.getJob(activeId)).toMatchObject({ state: "active" });
    expect(await queue.getJob(readyId)).toMatchObject({ state: "active" });
    expect(await queue.getJob(scheduledId)).toBeNull();
    expect(await queue.getJob(otherId)).toMatchObject({ state: "ready" });
    expect(
      (
        await pool.query(
          `SELECT
             (SELECT count(*)::integer FROM workhorse.job_event WHERE job_id = $1) AS events,
             (SELECT count(*)::integer FROM workhorse.attempt_history WHERE job_id = $1) AS attempts`,
          [scheduledId],
        )
      ).rows[0],
    ).toEqual({ events: 0, attempts: 0 });
    expect(await queue.purgeQueue(queueName)).toBe(0);
  });

  it("purges ready and scheduled keyed bindings immediately while retaining active bindings", async () => {
    const queueName = "keyed-purge";
    const activeId = await queue.enqueue(
      "purge-active",
      {},
      {
        queue: queueName,
        idempotency: { key: "active-binding" },
      },
    );
    expect((await queue.claim("purge-worker", { queue: queueName }))?.id).toBe(activeId);
    const readyId = await queue.enqueue(
      "purge-ready",
      {},
      {
        queue: queueName,
        idempotency: { key: "ready-binding" },
      },
    );
    const scheduledId = await queue.enqueue(
      "purge-scheduled",
      {},
      {
        queue: queueName,
        runAt: new Date(Date.now() + 60_000),
        idempotency: { key: "scheduled-binding" },
      },
    );

    expect(await queue.purgeQueue(queueName)).toBe(2);
    expect(await queue.getJob(activeId)).toMatchObject({ state: "active" });
    expect(await queue.getJob(readyId)).toBeNull();
    expect(await queue.getJob(scheduledId)).toBeNull();
    expect(
      (await pool.query("SELECT job_id FROM workhorse.enqueue_idempotency ORDER BY job_id")).rows,
    ).toEqual([{ job_id: activeId }]);

    const reusedReady = await queue.enqueue(
      "purge-ready-reused",
      { version: 2 },
      {
        queue: queueName,
        idempotency: { key: "ready-binding" },
      },
    );
    const reusedScheduled = await queue.enqueue(
      "purge-scheduled-reused",
      { version: 2 },
      {
        queue: queueName,
        idempotency: { key: "scheduled-binding" },
      },
    );
    expect(reusedReady).not.toBe(readyId);
    expect(reusedScheduled).not.toBe(scheduledId);
    await expect(
      queue.enqueue(
        "purge-active-changed",
        {},
        {
          queue: queueName,
          idempotency: { key: "active-binding" },
        },
      ),
    ).rejects.toBeInstanceOf(EnqueueIdempotencyConflictError);
  });

  it("serializes queue purge with a concurrent history insert", async () => {
    const queueName = "purge-history-race";
    const id = await queue.enqueue("purge-history-race", {}, { queue: queueName });
    const inserter = await pool.connect();
    try {
      await inserter.query("BEGIN");
      await inserter.query(
        `INSERT INTO workhorse.job_event(job_id, event_type) VALUES ($1, 'concurrent-purge')`,
        [id],
      );
      let settled = false;
      const purge = queue.purgeQueue(queueName).finally(() => {
        settled = true;
      });
      await sleep(25);
      expect(settled).toBe(false);
      await inserter.query("COMMIT");

      expect(await purge).toBe(1);
      expect(await queue.getJob(id)).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer AS count FROM workhorse.job_event WHERE job_id = $1",
            [id],
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await inserter.query("ROLLBACK").catch(() => undefined);
      inserter.release();
    }
  });

  it("treats an empty enqueue batch as a query-free no-op", async () => {
    const transaction = { query: async () => Promise.reject(new Error("query must not run")) };
    await expect(queue.enqueueMany([], transaction)).resolves.toEqual([]);
  });

  it("bounds batch size client-side and classifies a batch against one timestamp", async () => {
    const transaction = { query: async () => Promise.reject(new Error("query must not run")) };
    const tooMany = Array.from({ length: MAX_ENQUEUE_BATCH_SIZE + 1 }, () => ({
      type: "bounded",
      payload: {},
    }));
    await expect(queue.enqueueMany(tooMany, transaction)).rejects.toThrow(
      `at most ${MAX_ENQUEUE_BATCH_SIZE}`,
    );

    const runAt = new Date(Date.now() + 20);
    const ids = await queue.enqueueMany(
      Array.from({ length: MAX_ENQUEUE_BATCH_SIZE }, (_, order) => ({
        type: "same-boundary",
        payload: { order },
        options: { runAt },
      })),
    );
    const states = await pool.query<{ state: string }>(
      "SELECT DISTINCT state FROM workhorse.job_runtime WHERE job_id = ANY($1::uuid[])",
      [ids],
    );
    expect(states.rows).toHaveLength(1);
  });

  it("rolls back the entire batch for invalid input and participates in caller transactions", async () => {
    await expect(
      queue.enqueueMany([
        { type: "valid", payload: {} },
        { type: "", payload: {} },
      ]),
    ).rejects.toThrow("each request requires");
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0].count,
    ).toBe(0);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await queue.enqueueMany([{ type: "rolled-back", payload: {} }], client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0].count,
    ).toBe(0);
  });

  it("notifies once per distinct queue containing ready jobs", async () => {
    const alpha = "enqueue-many-integration-alpha";
    const beta = "enqueue-many-integration-beta";
    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (message) => notifications.push(message.payload ?? ""));
    try {
      await listener.query("LISTEN workhorse_jobs");
      await queue.enqueueMany([
        { type: "a", payload: {}, options: { queue: alpha } },
        { type: "b", payload: {}, options: { queue: alpha } },
        { type: "c", payload: {}, options: { queue: beta } },
        {
          type: "later",
          payload: {},
          options: { queue: "scheduled-only", runAt: new Date(Date.now() + 60_000) },
        },
      ]);
      await sleep(50);
      const relevant = notifications.filter((payload) => payload === alpha || payload === beta);
      expect(relevant).toHaveLength(2);
      expect(new Set(relevant)).toEqual(new Set([alpha, beta]));
    } finally {
      await listener.query("UNLISTEN workhorse_jobs");
      listener.release();
    }
  });

  it("participates in a caller transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await queue.enqueue("email", { to: "a@example.com" }, {}, client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0].count,
    ).toBe(0);
  });

  it("defaults enqueued jobs to 25 attempts in both client and SQL entry points", async () => {
    const clientId = await queue.enqueue("client-default", {});
    const sqlResult = await pool.query<{ job_id: string }>(
      "SELECT workhorse.enqueue_v1('default', 'sql-default', '{}'::jsonb) AS job_id",
    );
    const batchResult = await pool.query<{ job_id: string }>(
      "SELECT job_id FROM workhorse.enqueue_many_v1($1::jsonb)",
      [
        JSON.stringify([
          {
            queue: "default",
            type: "batch-default",
            payload: {},
            runAt: new Date().toISOString(),
          },
        ]),
      ],
    );

    const attempts = await pool.query<{ job_type: string; max_attempts: number }>(
      "SELECT job_type, max_attempts FROM workhorse.job WHERE id = ANY($1::uuid[]) ORDER BY job_type",
      [[clientId, sqlResult.rows[0]!.job_id, batchResult.rows[0]!.job_id]],
    );
    expect(attempts.rows).toEqual([
      { job_type: "batch-default", max_attempts: 25 },
      { job_type: "client-default", max_attempts: 25 },
      { job_type: "sql-default", max_attempts: 25 },
    ]);
  });

  it("separates scheduled work and promotes only when due", async () => {
    const id = await queue.enqueue(
      "email",
      { to: "a@example.com" },
      { runAt: new Date(Date.now() + 120) },
    );
    expect((await queue.getJob(id))?.state).toBe("scheduled");
    expect(await queue.claim("worker-a")).toBeNull();
    await sleep(150);
    expect(await queue.promote()).toBe(1);
    expect((await queue.getJob(id))?.state).toBe("ready");
    expect((await queue.claim("worker-a"))?.id).toBe(id);
  });

  it("lets running workers drain work while a paused worker stops claiming until resumed", async () => {
    const handledBy: string[] = [];
    const pausedWorker = new Worker(queue, {
      workerId: "paused-worker",
      pollMs: 1,
    }).handle<{ sequence: number }>("pause-control", ({ sequence }) => {
      handledBy.push(`paused:${sequence}`);
      return { sequence };
    });
    const runningWorker = new Worker(queue, {
      workerId: "running-worker",
      pollMs: 1,
    }).handle<{ sequence: number }>("pause-control", ({ sequence }) => {
      handledBy.push(`running:${sequence}`);
      return { sequence };
    });
    const initialIds: string[] = [];
    for (const sequence of [1, 2, 3]) {
      initialIds.push(await queue.enqueue("pause-control", { sequence }));
    }

    pausedWorker.pause();
    expect(pausedWorker.isPaused()).toBe(true);
    expect(await pausedWorker.runOnce()).toBe(false);
    while (await runningWorker.runOnce()) {
      // Drain all ready work without allowing the paused worker to compete for claims.
    }

    expect(handledBy).toEqual(["running:1", "running:2", "running:3"]);
    await expect(Promise.all(initialIds.map((id) => queue.getJob(id)))).resolves.toEqual(
      initialIds.map((id) => expect.objectContaining({ id, state: "succeeded" })),
    );

    const resumedId = await queue.enqueue("pause-control", { sequence: 4 });
    pausedWorker.resume();
    expect(pausedWorker.isPaused()).toBe(false);
    expect(await pausedWorker.runOnce()).toBe(true);
    expect(handledBy.at(-1)).toBe("paused:4");
    await expect(queue.getJob(resumedId)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("allows an active job to finish after its worker is paused", async () => {
    let releaseHandler!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const worker = new Worker(queue, {
      workerId: "pause-in-flight",
      heartbeatMs: 50,
      leaseMs: 500,
    }).handle("pause-in-flight", async () => {
      markStarted();
      await released;
      return { completedWhilePaused: true };
    });
    const jobId = await queue.enqueue("pause-in-flight", {});

    const run = worker.runOnce();
    await started;
    worker.pause();
    releaseHandler();

    await expect(run).resolves.toBe(true);
    expect(worker.isPaused()).toBe(true);
    await expect(queue.getJob(jobId)).resolves.toMatchObject({
      state: "succeeded",
      result: { completedWhilePaused: true },
    });
    expect(await worker.runOnce()).toBe(false);
  });

  it("bounds overlap, claims only free slots, and breaks the claim loop on the first null", async () => {
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    for (const sequence of [1, 2]) await queue.enqueue("bounded-batch", { sequence });
    const claim = vi.spyOn(queue, "claim");
    const worker = new Worker(queue, {
      workerId: "bounded-batch-worker",
      concurrency: 5,
      pollMs: 0,
    }).handle("bounded-batch", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active -= 1;
      return null;
    });

    try {
      const run = worker.runOnce();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2));

      expect(claim).toHaveBeenCalledTimes(3);
      expect(worker.runtimeState()).toEqual({
        concurrency: 5,
        activeSlots: 2,
        paused: false,
        draining: false,
      });

      release.resolve();
      await expect(run).resolves.toBe(true);
      expect(maxActive).toBe(2);
      expect(worker.runtimeState().activeSlots).toBe(0);
    } finally {
      claim.mockRestore();
    }
  });

  it("refills a freed run slot while a sibling handler remains blocked", async () => {
    const firstRelease = deferred();
    const secondRelease = deferred();
    const thirdRelease = deferred();
    const thirdStarted = deferred();
    const started: number[] = [];
    let secondBlocked = true;
    for (const sequence of [1, 2, 3]) await queue.enqueue("continuous-refill", { sequence });
    const worker = new Worker(queue, {
      workerId: "continuous-refill-worker",
      concurrency: 2,
      pollMs: 1_000,
    }).handle<{ sequence: number }>("continuous-refill", async ({ sequence }) => {
      started.push(sequence);
      if (sequence === 1) await firstRelease.promise;
      if (sequence === 2) {
        await secondRelease.promise;
        secondBlocked = false;
      }
      if (sequence === 3) {
        thirdStarted.resolve();
        await thirdRelease.promise;
      }
      return { sequence };
    });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(started).toEqual([1, 2]));
      firstRelease.resolve();
      await thirdStarted.promise;

      expect(secondBlocked).toBe(true);
      expect(started).toEqual([1, 2, 3]);
      expect(worker.runtimeState().activeSlots).toBe(2);
    } finally {
      worker.stop();
      firstRelease.resolve();
      secondRelease.resolve();
      thirdRelease.resolve();
      await running;
    }
  });

  it("serializes public runOnce calls and preserves default single-job compatibility", async () => {
    const firstRelease = deferred();
    const secondRelease = deferred();
    const started: number[] = [];
    for (const sequence of [1, 2]) await queue.enqueue("serialized-run-once", { sequence });
    const worker = new Worker(queue, {
      workerId: "serialized-run-once-worker",
      pollMs: 0,
    }).handle<{ sequence: number }>("serialized-run-once", async ({ sequence }) => {
      started.push(sequence);
      await (sequence === 1 ? firstRelease.promise : secondRelease.promise);
      return { sequence };
    });

    const first = worker.runOnce();
    const second = worker.runOnce();
    await vi.waitFor(() => expect(started).toEqual([1]));
    expect(worker.concurrency).toBe(1);
    expect(worker.runtimeState().activeSlots).toBe(1);

    firstRelease.resolve();
    await expect(first).resolves.toBe(true);
    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    secondRelease.resolve();
    await expect(second).resolves.toBe(true);
    expect(worker.runtimeState().activeSlots).toBe(0);
  });

  it("keeps per-job heartbeats running while paused and does not claim more work", async () => {
    const release = deferred();
    const ids = await Promise.all(
      [1, 2, 3].map((sequence) => queue.enqueue("paused-concurrency", { sequence })),
    );
    const heartbeat = vi.spyOn(queue, "heartbeatStatus");
    const worker = new Worker(queue, {
      workerId: "paused-concurrency-worker",
      concurrency: 2,
      heartbeatMs: 20,
      leaseMs: 500,
      pollMs: 0,
    }).handle("paused-concurrency", async () => {
      await release.promise;
      return null;
    });

    try {
      const run = worker.runOnce();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2));
      worker.pause();
      await vi.waitFor(() => {
        const heartbeatingIds = new Set(heartbeat.mock.calls.map(([job]) => job.id));
        expect(heartbeatingIds.size).toBe(2);
        expect([...heartbeatingIds].every((id) => ids.includes(id))).toBe(true);
      });

      expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, paused: true });
      release.resolve();
      await expect(run).resolves.toBe(true);
      expect(await worker.runOnce()).toBe(false);
      const states = await Promise.all(ids.map(async (id) => (await queue.getJob(id))?.state));
      expect(states.filter((state) => state === "ready")).toHaveLength(1);
      expect(states.filter((state) => state === "succeeded")).toHaveLength(2);
    } finally {
      heartbeat.mockRestore();
    }
  });

  it("runs independent per-job heartbeats without overlapping a slow heartbeat", async () => {
    const releaseHandlers = deferred();
    const heartbeatGates = new Map<string, ReturnType<typeof deferred<"accepted">>[]>();
    const heartbeatCalls = new Map<string, number>();
    const inFlight = new Map<string, number>();
    const maxInFlight = new Map<string, number>();
    for (const sequence of [1, 2]) await queue.enqueue("slow-heartbeat", { sequence });
    const heartbeat = vi.spyOn(queue, "heartbeatStatus").mockImplementation((job) => {
      const active = (inFlight.get(job.id) ?? 0) + 1;
      inFlight.set(job.id, active);
      maxInFlight.set(job.id, Math.max(maxInFlight.get(job.id) ?? 0, active));
      heartbeatCalls.set(job.id, (heartbeatCalls.get(job.id) ?? 0) + 1);
      const gate = deferred<"accepted">();
      const gates = heartbeatGates.get(job.id) ?? [];
      gates.push(gate);
      heartbeatGates.set(job.id, gates);
      return gate.promise.finally(() => {
        inFlight.set(job.id, (inFlight.get(job.id) ?? 1) - 1);
      });
    });
    const worker = new Worker(queue, {
      workerId: "slow-heartbeat-worker",
      concurrency: 2,
      heartbeatMs: 10,
      leaseMs: 500,
      pollMs: 0,
    }).handle("slow-heartbeat", async () => {
      await releaseHandlers.promise;
      return null;
    });

    try {
      const run = worker.runOnce();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2));
      await vi.waitFor(() => expect(heartbeatGates.size).toBe(2));
      const [firstId, secondId] = [...heartbeatGates.keys()];
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();

      await sleep(40);
      expect(heartbeatCalls.get(firstId!)).toBe(1);
      expect(heartbeatCalls.get(secondId!)).toBe(1);
      heartbeatGates.get(firstId!)![0]!.resolve("accepted");
      await vi.waitFor(() => expect(heartbeatCalls.get(firstId!)).toBe(2));

      expect(heartbeatCalls.get(secondId!)).toBe(1);
      expect(inFlight.get(firstId!)).toBe(1);
      expect(inFlight.get(secondId!)).toBe(1);
      expect(maxInFlight.get(firstId!)).toBe(1);
      expect(maxInFlight.get(secondId!)).toBe(1);

      releaseHandlers.resolve();
      await expect(run).resolves.toBe(true);
      const callsAtSettlement = new Map(heartbeatCalls);
      for (const gates of heartbeatGates.values()) {
        for (const gate of gates) gate.resolve("accepted");
      }
      await sleep(30);
      expect(heartbeatCalls).toEqual(callsAtSettlement);
    } finally {
      releaseHandlers.resolve();
      for (const gates of heartbeatGates.values()) {
        for (const gate of gates) gate.resolve("accepted");
      }
      heartbeat.mockRestore();
    }
  });

  it("stops new claims and resolves run only after every active slot drains", async () => {
    const release = deferred();
    const ids = await Promise.all(
      [1, 2, 3].map((sequence) => queue.enqueue("graceful-concurrency-drain", { sequence })),
    );
    const worker = new Worker(queue, {
      workerId: "graceful-concurrency-drain-worker",
      concurrency: 2,
      pollMs: 0,
    }).handle("graceful-concurrency-drain", async () => {
      await release.promise;
      return null;
    });

    const running = worker.run();
    await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2));
    const blockedRunOnce = worker.runOnce();
    let runOnceResolved = false;
    void blockedRunOnce.then(() => {
      runOnceResolved = true;
    });
    await sleep(20);
    expect(runOnceResolved).toBe(false);

    worker.stop();
    expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, draining: true });
    let resolved = false;
    void running.then(() => {
      resolved = true;
    });
    await sleep(20);
    expect(resolved).toBe(false);

    release.resolve();
    await expect(running).resolves.toBeUndefined();
    await expect(blockedRunOnce).resolves.toBe(false);
    expect(worker.runtimeState()).toEqual({
      concurrency: 2,
      activeSlots: 0,
      paused: false,
      draining: false,
    });
    const states = await Promise.all(ids.map(async (id) => (await queue.getJob(id))?.state));
    expect(states.filter((state) => state === "ready")).toHaveLength(1);
    expect(states.filter((state) => state === "succeeded")).toHaveLength(2);
  });

  it("drains both active handlers after signal abort without claiming queued work", async () => {
    const controller = new AbortController();
    const releases = [deferred(), deferred()];
    const bothStarted = deferred();
    const startedIds: string[] = [];
    const ids: string[] = [];
    for (const sequence of [0, 1, 2]) {
      ids.push(await queue.enqueue("signal-abort-drain", { sequence }));
    }
    const claim = vi.spyOn(queue, "claim");
    const heartbeat = vi.spyOn(queue, "heartbeatStatus");
    const worker = new Worker(queue, {
      workerId: "signal-abort-drain-worker",
      concurrency: 2,
      heartbeatMs: 10,
      leaseMs: 500,
      pollMs: 0,
    }).handle<{ sequence: number }>("signal-abort-drain", async ({ sequence }, context) => {
      startedIds.push(context.job.id);
      if (startedIds.length === 2) bothStarted.resolve();
      await releases[sequence]!.promise;
      return { sequence };
    });

    const heartbeatCount = (id: string) =>
      heartbeat.mock.calls.filter(([job]) => job.id === id).length;
    const running = worker.run(controller.signal);

    try {
      await bothStarted.promise;
      expect(startedIds).toEqual(ids.slice(0, 2));
      expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, paused: false });

      const countsAtAbort = new Map(ids.slice(0, 2).map((id) => [id, heartbeatCount(id)]));
      controller.abort();
      await vi.waitFor(() => {
        for (const id of ids.slice(0, 2)) {
          expect(heartbeatCount(id)).toBeGreaterThan(countsAtAbort.get(id)!);
        }
      });
      expect(claim).toHaveBeenCalledTimes(2);
      await expect(queue.getJob(ids[2]!)).resolves.toMatchObject({ state: "ready" });

      let runSettled = false;
      void running.then(() => {
        runSettled = true;
      });
      releases[0]!.resolve();
      await vi.waitFor(async () => expect((await queue.getJob(ids[0]!))?.state).toBe("succeeded"));
      expect(runSettled).toBe(false);
      expect(worker.runtimeState().activeSlots).toBe(1);

      const secondCountAfterFirstRelease = heartbeatCount(ids[1]!);
      await vi.waitFor(() =>
        expect(heartbeatCount(ids[1]!)).toBeGreaterThan(secondCountAfterFirstRelease),
      );
      expect(claim).toHaveBeenCalledTimes(2);
      await expect(queue.getJob(ids[2]!)).resolves.toMatchObject({ state: "ready" });

      releases[1]!.resolve();
      await expect(running).resolves.toBeUndefined();
      expect(worker.runtimeState().activeSlots).toBe(0);
      await expect(Promise.all(ids.slice(0, 2).map((id) => queue.getJob(id)))).resolves.toEqual(
        ids.slice(0, 2).map((id) => expect.objectContaining({ id, state: "succeeded" })),
      );
      await expect(queue.getJob(ids[2]!)).resolves.toMatchObject({ state: "ready" });
    } finally {
      controller.abort();
      for (const release of releases) release.resolve();
      await running.catch(() => undefined);
      claim.mockRestore();
      heartbeat.mockRestore();
    }
  });

  it("honors a same-turn stop before run starts without claiming", async () => {
    const id = await queue.enqueue("same-turn-stop", {});
    const claim = vi.spyOn(queue, "claim");
    const worker = new Worker(queue, { workerId: "same-turn-stop-worker" }).handle(
      "same-turn-stop",
      () => null,
    );

    try {
      const running = worker.run();
      worker.stop();
      await expect(running).resolves.toBeUndefined();
      expect(claim).not.toHaveBeenCalled();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "ready" });
    } finally {
      claim.mockRestore();
    }
  });

  it("honors stop while run is queued behind runOnce without claiming again", async () => {
    const release = deferred();
    const started = deferred();
    const firstId = await queue.enqueue("queued-run-stop", { sequence: 1 });
    const secondId = await queue.enqueue("queued-run-stop", { sequence: 2 });
    const claim = vi.spyOn(queue, "claim");
    const worker = new Worker(queue, {
      workerId: "queued-run-stop-worker",
      pollMs: 0,
    }).handle("queued-run-stop", async () => {
      started.resolve();
      await release.promise;
      return null;
    });

    try {
      const once = worker.runOnce();
      await started.promise;
      const queuedRun = worker.run();
      worker.stop();
      release.resolve();

      await expect(once).resolves.toBe(true);
      await expect(queuedRun).resolves.toBeUndefined();
      expect(claim).toHaveBeenCalledTimes(1);
      await expect(queue.getJob(firstId)).resolves.toMatchObject({ state: "succeeded" });
      await expect(queue.getJob(secondId)).resolves.toMatchObject({ state: "ready" });
    } finally {
      release.resolve();
      claim.mockRestore();
    }
  });

  it.each([
    { maxAttempts: 2, expectedState: "ready", expectedAttempt: 2 },
    { maxAttempts: 1, expectedState: "failed", expectedAttempt: 1 },
  ] as const)(
    "settles successful siblings and recovers a concurrent crash with maxAttempts $maxAttempts",
    async ({ maxAttempts, expectedState, expectedAttempt }) => {
      const siblingsStarted = deferred();
      const releaseSiblings = deferred();
      const startedSiblings = new Set<number>();
      let crashedClaim:
        | { id: string; attempt: number; fenceToken: bigint; leaseExpiresAt: Date }
        | undefined;
      const [crashedId, ...siblingIds] = await Promise.all([
        queue.enqueue("batch-crash-settlement", { sequence: 1 }, { maxAttempts }),
        queue.enqueue("batch-crash-settlement", { sequence: 2 }),
        queue.enqueue("batch-crash-settlement", { sequence: 3 }),
      ]);
      const workerId = `batch-crash-settlement-${maxAttempts}`;
      const worker = new Worker(queue, {
        workerId,
        concurrency: 3,
        leaseMs: 10_000,
        heartbeatMs: 1_000,
        pollMs: 0,
        failpoint: (point, job) => {
          const shouldCrash =
            point === "beforeHandler" && (job.payload as { sequence: number }).sequence === 1;
          if (shouldCrash) {
            crashedClaim = {
              id: job.id,
              attempt: job.attempt,
              fenceToken: job.fenceToken,
              leaseExpiresAt: job.leaseExpiresAt,
            };
          }
          return shouldCrash;
        },
      }).handle<{ sequence: number }>("batch-crash-settlement", async ({ sequence }) => {
        startedSiblings.add(sequence);
        if (startedSiblings.size === 2) siblingsStarted.resolve();
        await releaseSiblings.promise;
        return { sequence };
      });

      const run = worker.runOnce();
      await siblingsStarted.promise;
      expect(crashedClaim).toBeDefined();
      const crash = crashedClaim!;
      expect(crash).toMatchObject({ id: crashedId, attempt: 1 });

      let settled = false;
      void run.catch(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseSiblings.resolve();
      await expect(run).rejects.toMatchObject({
        name: "InjectedCrashError",
        failpoint: "beforeHandler",
      });
      expect(worker.runtimeState().activeSlots).toBe(0);
      await expect(Promise.all(siblingIds.map((id) => queue.getJob(id)))).resolves.toEqual(
        siblingIds.map((id) => expect.objectContaining({ id, state: "succeeded" })),
      );

      const active = await pool.query<{
        state: string;
        current_attempt: number;
        fence_token: string;
        worker_id: string | null;
        expires_at: Date | null;
      }>(
        `SELECT state, current_attempt, fence_token::text, worker_id, expires_at
         FROM workhorse.job_runtime WHERE job_id = $1`,
        [crashedId],
      );
      expect(active.rows[0]).toEqual({
        state: "active",
        current_attempt: 1,
        fence_token: crash.fenceToken.toString(),
        worker_id: workerId,
        expires_at: crash.leaseExpiresAt,
      });
      await expect(queue.getJob(crashedId)).resolves.toMatchObject({
        state: "active",
        currentAttempt: 1,
        fenceToken: crash.fenceToken,
        result: null,
        error: null,
      });
      expect(
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE job_id = $1",
            [crashedId],
          )
        ).rows[0]!.count,
      ).toBe(0);

      await pool.query(
        "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE job_id = $1",
        [crashedId],
      );
      expect(await queue.recoverExpired(100, 0)).toBe(1);
      await expect(queue.getJob(crashedId)).resolves.toMatchObject({
        state: expectedState,
        currentAttempt: expectedAttempt,
        result: null,
      });

      const recoveredRuntime = await pool.query<{
        state: string;
        current_attempt: number;
        fence_token: string;
        worker_id: string | null;
        expires_at: Date | null;
      }>(
        `SELECT state, current_attempt, fence_token::text, worker_id, expires_at
         FROM workhorse.job_runtime WHERE job_id = $1`,
        [crashedId],
      );
      const expectedRuntimeRows =
        expectedState === "ready"
          ? [
              {
                state: "ready",
                current_attempt: 2,
                fence_token: "0",
                worker_id: null,
                expires_at: null,
              },
            ]
          : [];
      expect(recoveredRuntime.rows).toEqual(expectedRuntimeRows);
    },
  );

  it("keeps run maintenance cadence independent from active handlers", async () => {
    const release = deferred();
    await queue.enqueue("maintenance-during-handler", {});
    const tick = vi.spyOn(queue, "tick");
    const worker = new Worker(queue, {
      workerId: "maintenance-during-handler-worker",
      heartbeatMs: 50,
      leaseMs: 500,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 1_000,
      pollMs: 1_000,
    }).handle("maintenance-during-handler", async () => {
      await release.promise;
      return null;
    });

    try {
      const running = worker.run();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(1));
      await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(2), { timeout: 500 });

      worker.stop();
      release.resolve();
      await expect(running).resolves.toBeUndefined();
    } finally {
      tick.mockRestore();
    }
  });

  it("runs tick and scheduled maintenance tasks on independent cadences with phase telemetry", async () => {
    const jobId = await queue.enqueue(
      "scheduled-worker",
      { ok: true },
      { runAt: new Date(Date.now() + 80) },
    );
    await sleep(100);
    await queue.syncMaintenancePolicy({ timezone: "UTC", historyRetentionLocalHour: 0 });

    const telemetry: ReturnType<Worker["maintenanceTelemetry"]> = [];
    const worker = new Worker(queue, {
      workerId: "worker-maintenance",
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 1_000,
      onMaintenance: (event) => telemetry.push(event),
    }).handle("scheduled-worker", () => ({ ok: true }));
    expect(await worker.runOnce()).toBe(true);
    expect((await queue.getJob(jobId))?.state).toBe("succeeded");
    expect(telemetry.map(({ loop, phase }) => `${loop}:${phase}`)).toEqual([
      "tick:promote",
      "tick:recover",
      "history_partitions:history_partitions",
      "history_retention:event_retention",
      "history_retention:attempt_retention",
      "history_retention:schedule_occurrences",
      "terminal_storage:enqueue_idempotency",
      "terminal_storage:terminal_jobs",
    ]);
    expect(worker.maintenanceTelemetry()).toEqual(telemetry);

    await sleep(110);
    expect(await worker.runOnce()).toBe(false);
    expect(telemetry.slice(8).map(({ loop, phase }) => `${loop}:${phase}`)).toEqual([
      "tick:promote",
      "tick:recover",
    ]);
  });

  it("keeps idle claim polling on pollMs despite more frequent maintenance wakeups", async () => {
    const tickResults: MaintenancePhaseResult[] = [
      { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: false, error: null },
      { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: false, error: null },
    ];
    const partitionResults: MaintenancePhaseResult[] = [
      {
        phase: "history_partitions",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    const retentionResults: MaintenancePhaseResult[] = [
      {
        phase: "event_retention",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "attempt_retention",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "schedule_occurrences",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    const terminalResults: MaintenancePhaseResult[] = [
      {
        phase: "enqueue_idempotency",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "terminal_jobs",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const tick = vi.spyOn(queue, "tick").mockResolvedValue(tickResults);
    const prepareHistoryPartitions = vi
      .spyOn(queue, "prepareHistoryPartitions")
      .mockResolvedValue(partitionResults);
    const retainHistory = vi.spyOn(queue, "retainHistory").mockResolvedValue(retentionResults);
    const pruneTerminalStorage = vi
      .spyOn(queue, "pruneTerminalStorage")
      .mockResolvedValue(terminalResults);
    const claim = vi.spyOn(queue, "claim").mockResolvedValue(null);

    try {
      const worker = new Worker(queue, {
        workerId: "idle-cadence",
        pollMs: 15_000,
        maintenanceIntervalMs: 1_000,
        maintenanceTaskPollMs: 60_000,
      });

      await worker.runOnce();
      now.mockReturnValue(1_000);
      await worker.runOnce();
      now.mockReturnValue(2_000);
      await worker.runOnce();
      now.mockReturnValue(14_999);
      await worker.runOnce();

      expect(tick).toHaveBeenCalledTimes(4);
      expect(claim).toHaveBeenCalledTimes(1);

      now.mockReturnValue(15_000);
      await worker.runOnce();
      expect(claim).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
      tick.mockRestore();
      prepareHistoryPartitions.mockRestore();
      retainHistory.mockRestore();
      pruneTerminalStorage.mockRestore();
      claim.mockRestore();
    }
  });

  it("does not scan recurring schedules when the tick advisory lock is skipped", async () => {
    const skippedTick: MaintenancePhaseResult[] = [
      { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
      { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
    ];
    const ownedTick: MaintenancePhaseResult[] = skippedTick.map((result) => ({
      ...result,
      skippedLock: false,
    }));
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const tick = vi.spyOn(queue, "tick").mockResolvedValueOnce(skippedTick);
    const prepareHistoryPartitions = vi
      .spyOn(queue, "prepareHistoryPartitions")
      .mockResolvedValue([]);
    const retainHistory = vi.spyOn(queue, "retainHistory").mockResolvedValue([]);
    const pruneTerminalStorage = vi.spyOn(queue, "pruneTerminalStorage").mockResolvedValue([]);
    const schedules = vi.spyOn(queue, "schedules").mockResolvedValue([]);
    const claim = vi.spyOn(queue, "claim").mockResolvedValue(null);

    try {
      const worker = new Worker(queue, {
        workerId: "schedule-lock-gate",
        pollMs: 15_000,
        maintenanceIntervalMs: 100,
        scheduleNamespaces: ["integration"],
      });

      await worker.runOnce();
      expect(schedules).not.toHaveBeenCalled();

      tick.mockResolvedValueOnce(ownedTick);
      now.mockReturnValue(100);
      await worker.runOnce();
      expect(schedules).toHaveBeenCalledOnce();
      expect(schedules).toHaveBeenCalledWith(["integration"]);
    } finally {
      now.mockRestore();
      tick.mockRestore();
      prepareHistoryPartitions.mockRestore();
      retainHistory.mockRestore();
      pruneTerminalStorage.mockRestore();
      schedules.mockRestore();
      claim.mockRestore();
    }
  });

  it("claims exclusively and rejects stale completion after recovery", async () => {
    const id = await queue.enqueue("email", { to: "a@example.com" }, { maxAttempts: 2 });
    const first = await queue.claim("worker-a", { leaseMs: 100 });
    expect(first?.id).toBe(id);
    expect(await queue.claim("worker-b", { leaseMs: 100 })).toBeNull();
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    expect((await queue.getJob(id))?.fenceToken).toBe(0n);
    const second = await queue.claim("worker-b", { leaseMs: 1_000 });
    expect(second?.attempt).toBe(2);
    expect(second!.fenceToken).toBeGreaterThan(first!.fenceToken);
    expect(await queue.complete(first!, "worker-a", { stale: true })).toBe(false);
    expect(await queue.complete(second!, "worker-b", { delivered: true })).toBe(true);
    expect((await queue.getJob<{ delivered: boolean }>(id))?.result).toEqual({ delivered: true });
  });

  it("terminally fails an exhausted expired attempt without retaining runtime", async () => {
    const id = await queue.enqueue("email", {}, { maxAttempts: 1 });
    await queue.claim("worker-a", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    expect((await queue.getJob(id))?.state).toBe("failed");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state FROM workhorse.job_outcome WHERE job_id = $1", [id])).rows[0]
        .state,
    ).toBe("failed");
  });

  it("heartbeats only the current fenced lease", async () => {
    await queue.enqueue("email", { to: "a@example.com" });
    const job = await queue.claim("worker-a", { leaseMs: 1_000 });
    expect(await queue.heartbeat(job!, "worker-a", 1_000)).toBe(true);
    expect(
      await queue.heartbeat({ ...job!, fenceToken: job!.fenceToken + 1n }, "worker-a", 1_000),
    ).toBe(false);
    expect(await queue.heartbeat(job!, "worker-b", 1_000)).toBe(false);
  });

  it("persists immutable checkpoints with ownership provenance", async () => {
    const id = await queue.enqueue("checkpointed", { orderId: "order-1" });
    const job = await queue.claim("worker-a");

    const saved = await queue.saveCheckpoint(job!, "worker-a", "payment-authorized", {
      authorizationId: "auth-1",
    });
    expect(saved).toMatchObject({
      jobId: id,
      name: "payment-authorized",
      value: { authorizationId: "auth-1" },
      attempt: 1,
      fenceToken: job!.fenceToken,
      workerId: "worker-a",
    });
    await expect(queue.getCheckpoint(id, "payment-authorized")).resolves.toEqual(saved);
    await expect(
      queue.saveCheckpoint(job!, "worker-a", "nullable-result", null),
    ).resolves.toMatchObject({
      name: "nullable-result",
      value: null,
    });

    const repeated = await queue.saveCheckpoint(job!, "worker-a", "payment-authorized", {
      authorizationId: "auth-1",
    });
    expect(repeated).toEqual(saved);
    await expect(
      queue.saveCheckpoint(job!, "worker-a", "payment-authorized", {
        authorizationId: "auth-2",
      }),
    ).rejects.toThrow(/different value/);

    expect(await queue.complete(job!, "worker-a", { ok: true })).toBe(true);
    await expect(queue.getCheckpoint(id, "payment-authorized")).resolves.toEqual(saved);
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY event_id",
      [id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "enqueued",
      "claimed",
      "checkpoint_saved",
      "checkpoint_saved",
      "succeeded",
    ]);
  });

  it("bounds checkpoint values before durable writes", async () => {
    const id = await queue.enqueue("checkpoint-size", {});
    const job = await queue.claim("worker-a");

    await expect(
      queue.saveCheckpoint(job!, "worker-a", "oversized", {
        data: "x".repeat(MAX_CHECKPOINT_VALUE_BYTES + 1),
      }),
    ).rejects.toThrow(/at most 1048576 bytes/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.save_checkpoint_v1(
          $1, $2, $3, 'oversized-sql', to_jsonb(repeat('x', $4))
        )`,
        [id, "worker-a", job!.fenceToken.toString(), MAX_CHECKPOINT_VALUE_BYTES + 1],
      ),
    ).rejects.toThrow(/at most 1048576 bytes/);
    await expect(queue.getCheckpoint(id, "oversized")).resolves.toBeNull();
    await expect(queue.getCheckpoint(id, "oversized-sql")).resolves.toBeNull();
  });

  it("rejects checkpoint writes from a stale ownership generation", async () => {
    const id = await queue.enqueue("checkpointed", {}, { maxAttempts: 2 });
    const stale = await queue.claim("worker-a", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    const current = await queue.claim("worker-b");

    await expect(
      queue.saveCheckpoint(stale!, "worker-a", "stale-step", { shouldNotPersist: true }),
    ).rejects.toThrow(/lease is stale or expired/);
    await expect(queue.getCheckpoint(id, "stale-step")).resolves.toBeNull();
    await expect(
      queue.saveCheckpoint(current!, "worker-b", "current-step", { persisted: true }),
    ).resolves.toMatchObject({ name: "current-step", attempt: 2, workerId: "worker-b" });
  });

  it("serializes checkpoint writes against a concurrent retry transition", async () => {
    const id = await queue.enqueue("checkpoint-race", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a");
    const transition = await pool.connect();

    try {
      await transition.query("BEGIN");
      await transition.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [
        id,
      ]);
      const saving = queue.saveCheckpoint(job!, "worker-a", "racing-step", { persisted: true });
      const rejection = saving.then(
        () => null,
        (error: unknown) => error,
      );
      await sleep(20);
      await transition.query("SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb, 0) AS state", [
        id,
        "worker-a",
        job!.fenceToken.toString(),
        JSON.stringify({ message: "retry" }),
      ]);
      await transition.query("COMMIT");

      await expect(rejection).resolves.toMatchObject({
        name: "CheckpointLeaseLostError",
        message: expect.stringMatching(/lease is stale or expired/),
      });
      await expect(queue.getCheckpoint(id, "racing-step")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "ready", currentAttempt: 2 });
    } finally {
      await transition.query("ROLLBACK").catch(() => undefined);
      transition.release();
    }
  });

  it("serializes checkpoint writes against concurrent terminal completion", async () => {
    const id = await queue.enqueue("checkpoint-complete-race", {});
    const job = await queue.claim("worker-a");
    const transition = await pool.connect();

    try {
      await transition.query("BEGIN");
      await transition.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [
        id,
      ]);
      const rejection = queue
        .saveCheckpoint(job!, "worker-a", "too-late", { persisted: true })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await sleep(20);
      await transition.query("SELECT workhorse.complete_v1($1, $2, $3, $4::jsonb) AS accepted", [
        id,
        "worker-a",
        job!.fenceToken.toString(),
        JSON.stringify({ completed: true }),
      ]);
      await transition.query("COMMIT");

      await expect(rejection).resolves.toMatchObject({ name: "CheckpointLeaseLostError" });
      await expect(queue.getCheckpoint(id, "too-late")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({
        state: "succeeded",
        result: { completed: true },
      });
    } finally {
      await transition.query("ROLLBACK").catch(() => undefined);
      transition.release();
    }
  });

  it("retains checkpoints after terminal failure", async () => {
    const id = await queue.enqueue("checkpoint-failure", {}, { maxAttempts: 1 });
    const job = await queue.claim("worker-a");
    const checkpoint = await queue.saveCheckpoint(job!, "worker-a", "before-failure", {
      prepared: true,
    });

    expect(await queue.fail(job!, "worker-a", new Error("terminal"))).toBe("failed");
    await expect(queue.getCheckpoint(id, "before-failure")).resolves.toEqual(checkpoint);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "failed" });
  });

  it("rechecks checkpoint lease expiry after waiting for the runtime lock", async () => {
    const id = await queue.enqueue("checkpoint-lock-expiry", {});
    const job = await queue.claim("worker-a", { leaseMs: 100 });
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [id]);
      const saving = queue.saveCheckpoint(job!, "worker-a", "expired-while-waiting", {
        persisted: true,
      });
      const rejection = saving.then(
        () => null,
        (error: unknown) => error,
      );
      await sleep(130);
      await blocker.query("COMMIT");

      await expect(rejection).resolves.toMatchObject({
        name: "CheckpointLeaseLostError",
        message: expect.stringMatching(/lease is stale or expired/),
      });
      await expect(queue.getCheckpoint(id, "expired-while-waiting")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("updates bounded mutable progress with fenced provenance and lookup visibility", async () => {
    const id = await queue.enqueue("progress", { batch: "import-1" });
    const job = await queue.claim("progress-worker");

    const first = await queue.updateProgress(job!, "progress-worker", {
      completed: 2,
      total: 10,
      phase: "reading",
    });
    expect(first).toMatchObject({
      jobId: id,
      value: { completed: 2, total: 10, phase: "reading" },
      revision: 1n,
      attempt: 1,
      fenceToken: job!.fenceToken,
      workerId: "progress-worker",
    });
    await expect(queue.getProgress(id)).resolves.toEqual(first);
    await expect(queue.getJob(id)).resolves.toMatchObject({ progress: first });

    const unchanged = await queue.updateProgress(job!, "progress-worker", {
      completed: 2,
      total: 10,
      phase: "reading",
    });
    expect(unchanged).toEqual(first);
    await expect(
      queue.updateProgress(job!, "progress-worker", { completed: 3, total: 10 }),
    ).rejects.toMatchObject({
      name: "ProgressRateLimitError",
      jobId: id,
      retryAfterMs: expect.any(Number),
    });

    await sleep(110);
    const second = await queue.updateProgress(job!, "progress-worker", {
      completed: 3,
      total: 10,
      phase: "writing",
    });
    expect(second).toMatchObject({ revision: 2n, attempt: 1, workerId: "progress-worker" });
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());

    expect(await queue.complete(job!, "progress-worker", { imported: 10 })).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "succeeded", progress: second });
    const events = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'progress_updated' ORDER BY event_id`,
      [id],
    );
    expect(events.rows).toEqual([
      { event_type: "progress_updated", details: expect.objectContaining({ revision: "1" }) },
      { event_type: "progress_updated", details: expect.objectContaining({ revision: "2" }) },
    ]);
  });

  it("bounds progress values and rejects stale ownership generations", async () => {
    await queue.enqueue("progress-bounds", {}, { maxAttempts: 2 });
    const stale = await queue.claim("progress-worker-a", { leaseMs: 100 });

    await expect(
      queue.updateProgress(stale!, "progress-worker-a", {
        data: "x".repeat(MAX_PROGRESS_VALUE_BYTES + 1),
      }),
    ).rejects.toThrow(/at most 65536 bytes/);
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    const current = await queue.claim("progress-worker-b");

    await expect(
      queue.updateProgress(stale!, "progress-worker-a", { stale: true }),
    ).rejects.toMatchObject({ name: "ProgressLeaseLostError" });
    const accepted = await queue.updateProgress(current!, "progress-worker-b", { recovered: true });
    expect(accepted).toMatchObject({ revision: 1n, attempt: 2, workerId: "progress-worker-b" });
  });

  it("rechecks progress lease expiry after waiting for the runtime lock", async () => {
    const id = await queue.enqueue("progress-lock-expiry", {});
    const job = await queue.claim("progress-lock-worker", { leaseMs: 100 });
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [id]);
      const updating = queue
        .updateProgress(job!, "progress-lock-worker", { shouldNotPersist: true })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await sleep(130);
      await blocker.query("COMMIT");

      await expect(updating).resolves.toMatchObject({ name: "ProgressLeaseLostError" });
      await expect(queue.getProgress(id)).resolves.toBeNull();
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("exposes progress helpers to handlers", async () => {
    const id = await queue.enqueue("progress-context", {});
    const observed: unknown[] = [];
    const worker = new Worker(queue, { workerId: "progress-context-worker" }).handle(
      "progress-context",
      async (_payload, context) => {
        observed.push(await context.getProgress());
        const updated = await context.setProgress({ percent: 50, label: "halfway" });
        observed.push(await context.getProgress());
        return { revision: updated.revision.toString() };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(observed).toEqual([
      null,
      expect.objectContaining({ jobId: id, value: { percent: 50, label: "halfway" } }),
    ]);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { revision: "1" },
      progress: { value: { percent: 50, label: "halfway" } },
    });
  });

  it("schedules the first named wait with immutable ownership provenance", async () => {
    const id = await queue.enqueue("wait-first", {});
    const job = await queue.claim("wait-worker", { leaseMs: 10_000 });
    const active = await pool.query<{ attempt_started_at: Date; acquired_at: Date }>(
      `SELECT attempt_started_at, acquired_at
         FROM workhorse.job_runtime
        WHERE job_id = $1`,
      [id],
    );
    const before = Date.now();

    const result = await queue.scheduleWait(job!, "wait-worker", "provider-cooldown", {
      durationMs: 5_000,
    });
    const after = Date.now();

    expect(result.status).toBe("scheduled");
    expect(result.wait).toMatchObject({
      jobId: id,
      name: "provider-cooldown",
      mode: "relative",
      durationMs: 5_000,
      requestedWakeAt: null,
      attempt: 1,
      fenceToken: job!.fenceToken,
      workerId: "wait-worker",
    });
    expect(result.wait.wakeAt.getTime()).toBeGreaterThanOrEqual(before + 5_000);
    expect(result.wait.wakeAt.getTime()).toBeLessThanOrEqual(after + 5_100);
    await expect(queue.getWait(id, "provider-cooldown")).resolves.toEqual(result.wait);
    await expect(queue.listWaits(id)).resolves.toEqual([result.wait]);

    const runtime = await pool.query<{
      state: string;
      run_at: Date;
      current_attempt: number;
      fence_token: string;
      worker_id: string | null;
      expires_at: Date | null;
      wait_name: string | null;
      attempt_started_at: Date;
    }>(
      `SELECT state, run_at, current_attempt, fence_token::text, worker_id, expires_at,
              wait_name, attempt_started_at
         FROM workhorse.job_runtime
        WHERE job_id = $1`,
      [id],
    );
    expect(runtime.rows[0]).toEqual({
      state: "scheduled",
      run_at: result.wait.wakeAt,
      current_attempt: 1,
      fence_token: "0",
      worker_id: null,
      expires_at: null,
      wait_name: "provider-cooldown",
      attempt_started_at: active.rows[0]!.attempt_started_at,
    });
    expect(active.rows[0]!.attempt_started_at).toEqual(active.rows[0]!.acquired_at);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(await queue.complete(job!, "wait-worker", { tooLate: true })).toBe(false);
    expect(await queue.fail(job!, "wait-worker", new Error("too late"))).toBe("stale");
  });

  it("replays relative waits first-write-wins despite duration drift", async () => {
    const id = await queue.enqueue("wait-relative-replay", {});
    const firstClaim = await queue.claim("relative-worker");
    const first = await queue.scheduleWait(firstClaim!, "relative-worker", "backoff", {
      durationMs: 30,
    });
    await sleep(50);
    expect(await queue.promote()).toBe(1);
    const continuation = await queue.claim("relative-worker");

    const replay = await queue.scheduleWait(continuation!, "relative-worker", "backoff", {
      durationMs: 30_000,
    });

    expect(replay).toEqual({ status: "elapsed", wait: first.wait });
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "active",
      currentAttempt: 1,
      fenceToken: continuation!.fenceToken,
    });
    const event = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'wait_replayed'`,
      [id],
    );
    expect(event.rows[0]!.details).toMatchObject({
      name: "backoff",
      mode: "relative",
      requested_duration_ms: 30_000,
      stored_duration_ms: 30,
      stored_wake_at: expect.any(String),
      fence_token: continuation!.fenceToken.toString(),
    });
    expect(new Date(String(event.rows[0]!.details.stored_wake_at))).toEqual(first.wait.wakeAt);
  });

  it("rejects changed absolute targets and relative/absolute mode changes", async () => {
    const id = await queue.enqueue("wait-conflicts", {});
    const firstClaim = await queue.claim("conflict-worker");
    const target = new Date(Date.now() + 30);
    const first = await queue.scheduleWait(firstClaim!, "conflict-worker", "embargo", {
      wakeAt: target,
    });
    expect(first.wait).toMatchObject({
      jobId: id,
      name: "embargo",
      mode: "absolute",
      durationMs: null,
      requestedWakeAt: target,
      wakeAt: target,
    });
    await sleep(50);
    expect(await queue.promote()).toBe(1);
    const continuation = await queue.claim("conflict-worker");

    await expect(
      queue.scheduleWait(continuation!, "conflict-worker", "embargo", {
        wakeAt: new Date(target.getTime() + 1),
      }),
    ).rejects.toMatchObject({ name: "WaitConflictError", existing: first.wait });
    await expect(
      queue.scheduleWait(continuation!, "conflict-worker", "embargo", { durationMs: 1 }),
    ).rejects.toMatchObject({ name: "WaitConflictError", existing: first.wait });
    await expect(queue.getWait(id, "embargo")).resolves.toEqual(first.wait);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active", currentAttempt: 1 });
  });

  it("bounds wait names, relative durations, and absolute timestamps", async () => {
    const id = await queue.enqueue("wait-bounds", {});
    const job = await queue.claim("bounds-worker");
    const schedule = (name: string, options: { durationMs: number } | { wakeAt: Date }) =>
      queue.scheduleWait(job!, "bounds-worker", name, options);

    await expect(schedule("", { durationMs: 1 })).rejects.toThrow(/between 1 and 200/);
    await expect(schedule("x".repeat(201), { durationMs: 1 })).rejects.toThrow(/between 1 and 200/);
    for (const durationMs of [0, -1, 31_536_000_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(schedule(`duration-${durationMs}`, { durationMs })).rejects.toThrow(/duration/i);
    }
    await expect(schedule("invalid-date", { wakeAt: new Date(Number.NaN) })).rejects.toThrow(
      /finite|valid/i,
    );
    await expect(
      schedule("too-far", { wakeAt: new Date(Date.now() + 365 * 86_400_000 + 60_000) }),
    ).rejects.toThrow(/365 days/);
    await expect(
      pool.query(`SELECT * FROM workhorse.schedule_wait_v1($1, $2, $3, 'neither', NULL, NULL)`, [
        id,
        "bounds-worker",
        job!.fenceToken.toString(),
      ]),
    ).rejects.toThrow(/exactly one/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.schedule_wait_v1(
          $1, $2, $3, 'both', 1, clock_timestamp() + interval '1 second'
        )`,
        [id, "bounds-worker", job!.fenceToken.toString()],
      ),
    ).rejects.toThrow(/exactly one/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.schedule_wait_v1($1, $2, $3, 'infinite', NULL, 'infinity')`,
        [id, "bounds-worker", job!.fenceToken.toString()],
      ),
    ).rejects.toThrow(/finite/);
    await expect(queue.getWait(id, "too-far")).resolves.toBeNull();

    const maximum = await schedule("maximum", { durationMs: 31_536_000_000 });
    expect(maximum.status).toBe("scheduled");
    expect(maximum.wait.durationMs).toBe(31_536_000_000);
  });

  it("returns limit_exceeded after 1,000 retained wait names", async () => {
    const id = await queue.enqueue("wait-limit", {});
    const job = await queue.claim("limit-worker");
    await pool.query(
      `INSERT INTO workhorse.job_wait(
         job_id, wait_name, mode, duration_ms, wake_at, attempt, fence_token, worker_id, claimed_at
       )
       SELECT $1, 'seed-' || value, 'relative', 1,
              clock_timestamp() + interval '1 millisecond', 1, $2, $3,
              (SELECT acquired_at FROM workhorse.job_runtime WHERE job_id = $1)
         FROM generate_series(1, 1000) AS value`,
      [id, job!.fenceToken.toString(), "limit-worker"],
    );

    await expect(
      queue.scheduleWait(job!, "limit-worker", "overflow", { durationMs: 1 }),
    ).rejects.toMatchObject({ name: "WaitLimitExceededError" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_wait WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(1_000);
    await expect(queue.getWait(id, "overflow")).resolves.toBeNull();
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active" });
  });

  it("records a past-due first target without releasing active ownership", async () => {
    const id = await queue.enqueue("wait-past-due", {});
    const job = await queue.claim("past-due-worker");
    const target = new Date(Date.now() - 1_000);

    const result = await queue.scheduleWait(job!, "past-due-worker", "already-open", {
      wakeAt: target,
    });

    expect(result).toMatchObject({
      status: "elapsed",
      wait: { name: "already-open", requestedWakeAt: target, wakeAt: target },
    });
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "active",
      fenceToken: job!.fenceToken,
    });
    const event = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'wait_elapsed'`,
      [id],
    );
    expect(event.rows[0]!.details).toMatchObject({
      name: "already-open",
      mode: "absolute",
      reason: "due",
      immediate: true,
      wake_at: expect.any(String),
    });
    expect(new Date(String(event.rows[0]!.details.wake_at))).toEqual(target);
  });

  it("rejects stale generations and non-active runtime states without writing waits", async () => {
    const callSql = async (id: string, workerId: string, fenceToken: bigint, name: string) =>
      (
        await pool.query<{ status: string }>(
          `SELECT status FROM workhorse.schedule_wait_v1($1, $2, $3, $4, 1, NULL)`,
          [id, workerId, fenceToken.toString(), name],
        )
      ).rows[0]!.status;

    const recoveredId = await queue.enqueue("wait-stale", {}, { maxAttempts: 2 });
    const stale = await queue.claim("stale-worker", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    await expect(
      queue.scheduleWait(stale!, "stale-worker", "stale", { durationMs: 1 }),
    ).rejects.toMatchObject({ name: "WaitLeaseLostError" });
    expect(await callSql(recoveredId, "stale-worker", stale!.fenceToken, "ready")).toBe("stale");

    const scheduledId = await queue.enqueue("wait-scheduled", {});
    const scheduledClaim = await queue.claim("scheduled-worker");
    await queue.scheduleWait(scheduledClaim!, "scheduled-worker", "current", {
      durationMs: 60_000,
    });
    expect(
      await callSql(scheduledId, "scheduled-worker", scheduledClaim!.fenceToken, "other"),
    ).toBe("stale");

    const terminalId = await queue.enqueue("wait-terminal", {});
    const terminalClaim = await queue.claim("terminal-worker");
    expect(await queue.complete(terminalClaim!, "terminal-worker", null)).toBe(true);
    expect(
      await callSql(terminalId, "terminal-worker", terminalClaim!.fenceToken, "terminal"),
    ).toBe("stale");

    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM workhorse.job_wait
            WHERE job_id = ANY($1::uuid[])`,
          [[recoveredId, scheduledId, terminalId]],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("rechecks wait lease expiry after waiting for the runtime lock", async () => {
    const id = await queue.enqueue("wait-lock-expiry", {});
    const job = await queue.claim("wait-lock-worker", { leaseMs: 100 });
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [id]);
      const scheduling = queue
        .scheduleWait(job!, "wait-lock-worker", "expired-while-blocked", { durationMs: 1_000 })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await sleep(130);
      await blocker.query("COMMIT");

      await expect(scheduling).resolves.toMatchObject({ name: "WaitLeaseLostError" });
      await expect(queue.getWait(id, "expired-while-blocked")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("returns typed stale when the wait lease expires during the suspension transition", async () => {
    const id = await queue.enqueue("wait-transition-expiry", {});
    const job = await queue.claim("wait-transition-worker", { leaseMs: 250 });

    await pool.query(`
      CREATE OR REPLACE FUNCTION workhorse.test_delay_wait_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_sleep(0.4);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_delay_wait_insert
      BEFORE INSERT ON workhorse.job_wait
      FOR EACH ROW EXECUTE FUNCTION workhorse.test_delay_wait_insert();
    `);

    try {
      await expect(
        queue.scheduleWait(job!, "wait-transition-worker", "expired-during-transition", {
          durationMs: 1_000,
        }),
      ).rejects.toMatchObject({ name: "WaitLeaseLostError" });
      await expect(queue.getWait(id, "expired-during-transition")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active" });
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS test_delay_wait_insert ON workhorse.job_wait;
        DROP FUNCTION IF EXISTS workhorse.test_delay_wait_insert();
      `);
    }
  });

  it.each(["complete", "fail", "recover"] as const)(
    "serializes wait scheduling behind concurrent %s",
    async (transitionKind) => {
      const id = await queue.enqueue(`wait-race-${transitionKind}`, {}, { maxAttempts: 2 });
      const leaseMs = transitionKind === "recover" ? 100 : 10_000;
      const job = await queue.claim("race-worker", { leaseMs });
      const transition = await pool.connect();

      try {
        await transition.query("BEGIN");
        await transition.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [
          id,
        ]);
        const scheduling = queue
          .scheduleWait(job!, "race-worker", "racing-wait", { durationMs: 1_000 })
          .then(
            () => null,
            (error: unknown) => error,
          );
        await sleep(20);

        if (transitionKind === "complete") {
          await transition.query("SELECT workhorse.complete_v1($1, $2, $3, '{}'::jsonb)", [
            id,
            "race-worker",
            job!.fenceToken.toString(),
          ]);
        } else if (transitionKind === "fail") {
          await transition.query("SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb, 0)", [
            id,
            "race-worker",
            job!.fenceToken.toString(),
            JSON.stringify({ message: "retry" }),
          ]);
        } else {
          await sleep(110);
          await transition.query("SELECT workhorse.recover_expired_v1(100)");
        }
        await transition.query("COMMIT");

        await expect(scheduling).resolves.toMatchObject({ name: "WaitLeaseLostError" });
        await expect(queue.getWait(id, "racing-wait")).resolves.toBeNull();
        await expect(queue.getJob(id)).resolves.toMatchObject({
          state: transitionKind === "complete" ? "succeeded" : "ready",
        });
      } finally {
        await transition.query("ROLLBACK").catch(() => undefined);
        transition.release();
      }
    },
  );

  it("carries the wait marker through due promotion and emits lifecycle events", async () => {
    const id = await queue.enqueue("wait-promotion", {});
    const job = await queue.claim("promotion-worker");
    const scheduled = await queue.scheduleWait(job!, "promotion-worker", "promotion-boundary", {
      durationMs: 30,
    });
    await sleep(50);

    expect(await queue.promote()).toBe(1);
    const runtime = await pool.query<{
      state: string;
      wait_name: string | null;
      attempt_started_at: Date;
    }>("SELECT state, wait_name, attempt_started_at FROM workhorse.job_runtime WHERE job_id = $1", [
      id,
    ]);
    expect(runtime.rows[0]).toMatchObject({
      state: "ready",
      wait_name: null,
      attempt_started_at: expect.any(Date),
    });

    const events = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM workhorse.job_event
        WHERE job_id = $1 AND event_type IN ('wait_scheduled', 'wait_elapsed')
        ORDER BY event_id`,
      [id],
    );
    expect(events.rows).toEqual([
      {
        event_type: "wait_scheduled",
        details: expect.objectContaining({
          name: "promotion-boundary",
          mode: "relative",
          duration_ms: 30,
          wake_at: expect.any(String),
        }),
      },
      {
        event_type: "wait_elapsed",
        details: {
          name: "promotion-boundary",
          reason: "due",
          wake_at: expect.any(String),
        },
      },
    ]);
    expect(new Date(String(events.rows[0]!.details.wake_at))).toEqual(scheduled.wait.wakeAt);
    expect(new Date(String(events.rows[1]!.details.wake_at))).toEqual(scheduled.wait.wakeAt);
  });

  it("preserves one logical attempt across suspension and records truthful claim timestamps", async () => {
    const id = await queue.enqueue("wait-success", {});
    let handlerRuns = 0;
    const worker = new Worker(queue, {
      workerId: "wait-success-worker",
      maintenanceIntervalMs: 100,
    }).handle("wait-success", async (_payload, context) => {
      handlerRuns += 1;
      await context.sleep("brief-pause", 30);
      return { handlerRuns };
    });

    expect(await worker.runOnce()).toBe(true);
    const suspended = await pool.query<{ attempt_started_at: Date }>(
      "SELECT attempt_started_at FROM workhorse.job_runtime WHERE job_id = $1",
      [id],
    );
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);

    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 1,
      result: { handlerRuns: 2 },
    });
    const attempts = await pool.query<{
      attempt: number;
      outcome: string;
      started_at: Date;
      claimed_at: Date;
    }>(
      `SELECT attempt, outcome, started_at, claimed_at
         FROM workhorse.attempt_history
        WHERE job_id = $1`,
      [id],
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toMatchObject({ attempt: 1, outcome: "succeeded" });
    expect(attempts.rows[0]!.started_at).toEqual(suspended.rows[0]!.attempt_started_at);
    expect(attempts.rows[0]!.claimed_at.getTime()).toBeGreaterThan(
      attempts.rows[0]!.started_at.getTime(),
    );
    const claims = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'claimed'`,
      [id],
    );
    expect(claims.rows[0]!.count).toBe(2);
  });

  it("closes the same logical attempt when the handler fails after waking", async () => {
    const id = await queue.enqueue("wait-then-fail", {}, { maxAttempts: 1 });
    let handlerRuns = 0;
    const worker = new Worker(queue, {
      workerId: "wait-failure-worker",
      maintenanceIntervalMs: 100,
    }).handle("wait-then-fail", async (_payload, context) => {
      handlerRuns += 1;
      await context.sleep("before-failure", 30);
      throw new Error("failed after wake");
    });

    expect(await worker.runOnce()).toBe(true);
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);

    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "failed", currentAttempt: 1 });
    expect(handlerRuns).toBe(2);
    const attempts = await pool.query(
      "SELECT attempt, outcome FROM workhorse.attempt_history WHERE job_id = $1",
      [id],
    );
    expect(attempts.rows).toEqual([{ attempt: 1, outcome: "failed" }]);
  });

  it("supports multiple distinct durable waits in one logical attempt", async () => {
    const id = await queue.enqueue("multiple-waits", {});
    let handlerRuns = 0;
    let secondTarget: Date | undefined;
    const observedFirstWaits: Array<string | null> = [];
    const worker = new Worker(queue, {
      workerId: "multiple-waits-worker",
      maintenanceIntervalMs: 100,
    }).handle("multiple-waits", async (_payload, context) => {
      handlerRuns += 1;
      observedFirstWaits.push((await context.getWait("first"))?.name ?? null);
      await context.sleep("first", 30);
      secondTarget ??= new Date(Date.now() + 30);
      await context.sleepUntil("second", secondTarget);
      return { handlerRuns };
    });

    expect(await worker.runOnce()).toBe(true);
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);

    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 1,
      result: { handlerRuns: 3 },
    });
    expect(observedFirstWaits).toEqual([null, "first", "first"]);
    const waits = await queue.listWaits(id);
    expect(waits.map((wait) => [wait.name, wait.mode])).toEqual([
      ["first", "relative"],
      ["second", "absolute"],
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("retains waits through terminal outcome and cascades them with the parent job", async () => {
    const id = await queue.enqueue("wait-retention", {});
    const job = await queue.claim("retention-worker");
    const wait = await queue.scheduleWait(job!, "retention-worker", "past", {
      wakeAt: new Date(Date.now() - 1),
    });
    expect(await queue.complete(job!, "retention-worker", { ok: true })).toBe(true);

    await expect(queue.getWait(id, "past")).resolves.toEqual(wait.wait);
    await expect(queue.listWaits(id)).resolves.toEqual([wait.wait]);
    await pool.query("DELETE FROM workhorse.job WHERE id = $1", [id]);
    await expect(queue.getWait(id, "past")).resolves.toBeNull();
    await expect(queue.listWaits(id)).resolves.toEqual([]);
  });

  it("releases the worker slot immediately when a handler suspends", async () => {
    const waitingId = await queue.enqueue("slot-waiting", {});
    const followingId = await queue.enqueue("slot-following", {});
    const handled: string[] = [];
    const worker = new Worker(queue, { workerId: "slot-worker" })
      .handle("slot-waiting", async (_payload, context) => {
        handled.push("waiting");
        await context.sleep("long-wait", 60_000);
        return null;
      })
      .handle("slot-following", () => {
        handled.push("following");
        return { ok: true };
      });

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(waitingId)).resolves.toMatchObject({ state: "scheduled" });
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(followingId)).resolves.toMatchObject({ state: "succeeded" });
    expect(handled).toEqual(["waiting", "following"]);
  });

  it("replays handler code without repeating checkpointed work", async () => {
    const id = await queue.enqueue("checkpoint-before-wait", {});
    let handlerRuns = 0;
    let expensiveOperations = 0;
    const worker = new Worker(queue, {
      workerId: "checkpoint-wait-worker",
      maintenanceIntervalMs: 100,
    }).handle("checkpoint-before-wait", async (_payload, context) => {
      handlerRuns += 1;
      const prepared = await context.checkpoint("prepare", () => {
        expensiveOperations += 1;
        return { operation: expensiveOperations };
      });
      await context.sleep("after-prepare", 30);
      return { prepared, handlerRuns };
    });

    expect(await worker.runOnce()).toBe(true);
    await sleep(110);
    expect(await worker.runOnce()).toBe(true);

    expect(handlerRuns).toBe(2);
    expect(expensiveOperations).toBe(1);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { prepared: { operation: 1 }, handlerRuns: 2 },
    });
  });

  it("does not complete or fail when application code catches the suspension sentinel", async () => {
    const id = await queue.enqueue("caught-wait-sentinel", {});
    let caught = false;
    let codeAfterCatch = false;
    const worker = new Worker(queue, { workerId: "caught-sentinel-worker" }).handle(
      "caught-wait-sentinel",
      async (_payload, context) => {
        try {
          await context.sleep("caught", 60_000);
        } catch {
          caught = true;
        }
        codeAfterCatch = true;
        return { shouldNotComplete: true };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(caught).toBe(true);
    expect(codeAfterCatch).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "scheduled" });
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY event_id",
      [id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "enqueued",
      "claimed",
      "wait_scheduled",
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("records immutable retry and success attempts", async () => {
    const id = await queue.enqueue("email", { to: "a@example.com" }, { maxAttempts: 2 });
    const first = await queue.claim("worker-a");
    expect(await queue.fail(first!, "worker-a", new Error("temporary"), 0)).toBe("ready");
    expect((await queue.getJob(id))?.fenceToken).toBe(0n);
    const second = await queue.claim("worker-a");
    expect(second?.attempt).toBe(2);
    expect(await queue.complete(second!, "worker-a", { ok: true })).toBe(true);

    const attempts = await pool.query(
      "SELECT attempt, outcome FROM workhorse.attempt_history WHERE job_id = $1 ORDER BY attempt",
      [id],
    );
    expect(attempts.rows).toEqual([
      { attempt: 1, outcome: "retry" },
      { attempt: 2, outcome: "succeeded" },
    ]);
    const events = await pool.query(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY event_id",
      [id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "enqueued",
      "claimed",
      "retry_scheduled",
      "claimed",
      "succeeded",
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state, result FROM workhorse.job_outcome WHERE job_id = $1", [id]))
        .rows[0],
    ).toEqual({ state: "succeeded", result: { ok: true } });
  });

  it("uses Sidekiq-inspired SQL backoff with jitter when no retry delay is supplied", async () => {
    const id = await queue.enqueue("backoff", {}, { maxAttempts: 3 });
    const first = await queue.claim("worker-a");
    expect(await queue.fail(first!, "worker-a", new Error("immediate override"), 0)).toBe("ready");

    const second = await queue.claim("worker-a");
    const beforeFailure = new Date();

    expect(second?.attempt).toBe(2);
    expect(await queue.fail(second!, "worker-a", new Error("temporary"))).toBe("scheduled");

    const retry = await pool.query<{
      current_attempt: number;
      run_at: Date;
      delay_seconds: number;
    }>(
      `SELECT current_attempt, run_at,
              extract(epoch FROM (run_at - $2::timestamptz))::double precision AS delay_seconds
         FROM workhorse.job_runtime
        WHERE job_id = $1`,
      [id, beforeFailure],
    );
    expect(retry.rows[0]!.current_attempt).toBe(3);
    expect(retry.rows[0]!.run_at.getTime()).toBeGreaterThan(Date.now());
    // retry count 1: 1^4 + 15 + rand(0..9) * 2 => [16, 34] seconds.
    expect(retry.rows[0]!.delay_seconds).toBeGreaterThanOrEqual(16);
    expect(retry.rows[0]!.delay_seconds).toBeLessThan(35);
  });

  it("validates, persists, and publicly maps retry policies across batch and schedules", async () => {
    for (const [index, retryPolicy] of [
      { type: "fixed", delayMs: 1.5 },
      { type: "fixed", delayMs: 31_536_000_001 },
      { type: "exponential", initialDelayMs: 100, multiplier: 0, maxDelayMs: 1_000 },
      { type: "exponential", initialDelayMs: 1_001, multiplier: 2, maxDelayMs: 1_000 },
      { type: "decorrelated-jitter", baseDelayMs: 1_001, maxDelayMs: 1_000 },
      { type: "fixed", delayMs: 100, extra: true },
    ].entries()) {
      await expect(
        queue.enqueue(`invalid-${index}`, {}, { retryPolicy: retryPolicy as never }),
      ).rejects.toThrow(/retryPolicy|delayMs|multiplier|maxDelayMs/);
    }
    const retryPolicy = {
      type: "exponential" as const,
      initialDelayMs: 1_000,
      multiplier: 3,
      maxDelayMs: 31_536_000_000,
    };
    const [id] = await queue.enqueueMany([
      { type: "mapped", payload: {}, options: { queue: "mapped", retryPolicy } },
    ]);
    await expect(queue.getJob(id!)).resolves.toMatchObject({ retryPolicy });
    await expect(queue.claim("mapped-worker", { queue: "mapped" })).resolves.toMatchObject({
      retryPolicy,
    });

    const scheduledPolicy = {
      type: "decorrelated-jitter" as const,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    };
    await queue.syncSchedules("retry", [
      {
        name: "policy",
        schedule: "0 * * * *",
        job: { type: "scheduled", payload: {}, retryPolicy: scheduledPolicy },
      },
    ]);
    const stored = await pool.query<{ revision: string; retry_policy: unknown }>(
      "SELECT revision::text, retry_policy FROM workhorse.schedule_definition WHERE namespace = 'retry' AND schedule_name = 'policy'",
    );
    expect(stored.rows[0]!.retry_policy).toEqual(scheduledPolicy);
    const scheduledId = await queue.fireSchedule(
      "retry",
      "policy",
      BigInt(stored.rows[0]!.revision),
      new Date("2026-08-01T01:00:00Z"),
    );
    await expect(queue.getJob(scheduledId!)).resolves.toMatchObject({
      retryPolicy: scheduledPolicy,
    });
  });

  it("applies policies to failure and recovery with caps and reproducible decorrelated jitter", async () => {
    const fixed = { type: "fixed" as const, delayMs: 5_000 };
    const failId = await queue.enqueue(
      "fixed-fail",
      {},
      { queue: "fixed-fail", maxAttempts: 2, retryPolicy: fixed },
    );
    const failClaim = await queue.claim("fixed-fail-worker", { queue: "fixed-fail" });
    expect(await queue.fail(failClaim!, "fixed-fail-worker", new Error("retry"))).toBe("scheduled");
    const recoverId = await queue.enqueue(
      "fixed-recover",
      {},
      { queue: "fixed-recover", maxAttempts: 2, retryPolicy: fixed },
    );
    await queue.claim("fixed-recover-worker", { queue: "fixed-recover", leaseMs: 100 });
    await pool.query(
      "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE job_id = $1",
      [recoverId],
    );
    expect((await queue.tick()).find((phase) => phase.phase === "recover")?.rowsAffected).toBe(1);
    const events = await pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM workhorse.job_event WHERE job_id = ANY($1::uuid[]) AND event_type IN ('retry_scheduled', 'lease_expired')",
      [[failId, recoverId]],
    );
    for (const event of events.rows)
      expect(event.details).toMatchObject({
        retry_policy: fixed,
        retry_delay_ms: 5_000,
        retry_delay_source: "policy:fixed",
      });

    const capped = await pool.query<{ delay_ms: string }>(
      `SELECT retry.delay_ms::text FROM generate_series(1, 4) attempt
       CROSS JOIN LATERAL workhorse.retry_delay_v1(gen_random_uuid(), attempt, $1::jsonb, NULL, NULL, 'legacy-handler') retry`,
      [
        JSON.stringify({
          type: "exponential",
          initialDelayMs: 1_000,
          multiplier: 2,
          maxDelayMs: 2_500,
        }),
      ],
    );
    expect(capped.rows.map((row) => Number(row.delay_ms))).toEqual([1_000, 2_000, 2_500, 2_500]);

    const jitter = { type: "decorrelated-jitter" as const, baseDelayMs: 1_000, maxDelayMs: 30_000 };
    const jitterId = await queue.enqueue(
      "jitter",
      {},
      { queue: "jitter", maxAttempts: 3, retryPolicy: jitter },
    );
    let previous: number | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const claim = await new Queue(pool).claim(`jitter-${attempt}`, { queue: "jitter" });
      expect(await queue.fail(claim!, `jitter-${attempt}`, new Error("retry"))).toBe("scheduled");
      const runtime = await pool.query<{ delay: string }>(
        "SELECT previous_retry_delay_ms::text AS delay FROM workhorse.job_runtime WHERE job_id = $1",
        [jitterId],
      );
      const selected = Number(runtime.rows[0]!.delay);
      const replay = await pool.query<{ delay_ms: string }>(
        "SELECT delay_ms::text FROM workhorse.retry_delay_v1($1, $2, $3::jsonb, $4, NULL, 'legacy-handler')",
        [jitterId, attempt, JSON.stringify(jitter), previous],
      );
      expect(Number(replay.rows[0]!.delay_ms)).toBe(selected);
      previous = selected;
      if (attempt === 1)
        await pool.query(
          "UPDATE workhorse.job_runtime SET state = 'ready', run_at = clock_timestamp(), ready_at = clock_timestamp(), sequence = nextval('workhorse.ready_sequence_seq') WHERE job_id = $1",
          [jitterId],
        );
    }
  });

  it("preserves omitted recovery and explicit numeric/callback override precedence", async () => {
    const legacyId = await queue.enqueue("legacy", {}, { queue: "legacy", maxAttempts: 2 });
    await queue.claim("legacy-worker", { queue: "legacy", leaseMs: 100 });
    await pool.query(
      "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE job_id = $1",
      [legacyId],
    );
    expect(await queue.recoverExpired()).toBe(1);
    const policy = { type: "fixed" as const, delayMs: 60_000 };
    const numericId = await queue.enqueue(
      "numeric",
      {},
      { queue: "numeric", maxAttempts: 2, retryPolicy: policy },
    );
    const numeric = await queue.claim("numeric-worker", { queue: "numeric" });
    expect(await queue.fail(numeric!, "numeric-worker", new Error("retry"), 0)).toBe("ready");
    const callbackId = await queue.enqueue(
      "callback",
      {},
      { queue: "callback", maxAttempts: 2, retryPolicy: policy },
    );
    const worker = new Worker(queue, {
      workerId: "callback-worker",
      queue: "callback",
      pollMs: 0,
      retryDelayMs: () => 0,
    }).handle("callback", () => {
      throw new Error("retry");
    });
    expect(await worker.runOnce()).toBe(true);
    const recoveryId = await queue.enqueue(
      "recovery",
      {},
      { queue: "recovery", maxAttempts: 2, retryPolicy: policy },
    );
    await queue.claim("recovery-worker", { queue: "recovery", leaseMs: 100 });
    await pool.query(
      "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE job_id = $1",
      [recoveryId],
    );
    expect(await queue.recoverExpired(100, 0)).toBe(1);
    const sources = await pool.query<{ job_id: string; source: string }>(
      "SELECT job_id, details->>'retry_delay_source' AS source FROM workhorse.job_event WHERE job_id = ANY($1::uuid[]) AND event_type IN ('retry_scheduled', 'lease_expired')",
      [[legacyId, numericId, callbackId, recoveryId]],
    );
    expect(new Map(sources.rows.map((row) => [row.job_id, row.source]))).toEqual(
      new Map([
        [legacyId, "lease-recovery-immediate"],
        [numericId, "override"],
        [callbackId, "override"],
        [recoveryId, "override"],
      ]),
    );
  });

  it("passes the claimed job to retry delay callbacks", async () => {
    const delayMs = 300_000;
    const observed: Array<{ attempt: number; type: string; payload: unknown }> = [];
    const worker = new Worker(queue, {
      workerId: "job-aware-retry-worker",
      pollMs: 0,
      retryDelayMs: (attempt, job) => {
        observed.push({ attempt, type: job.type, payload: job.payload });
        return (job.payload as { retryDelayMs: number }).retryDelayMs;
      },
    });
    worker.handle("job-aware-retry", () => {
      throw new Error("intentional job-aware retry");
    });
    const id = await queue.enqueue(
      "job-aware-retry",
      { retryDelayMs: delayMs },
      { maxAttempts: 2 },
    );
    const before = Date.now();

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(observed).toEqual([
      { attempt: 1, type: "job-aware-retry", payload: { retryDelayMs: delayMs } },
    ]);
    const runtime = await pool.query<{ state: string; current_attempt: number; run_at: Date }>(
      "SELECT state, current_attempt, run_at FROM workhorse.job_runtime WHERE job_id = $1",
      [id],
    );
    expect(runtime.rows[0]).toMatchObject({ state: "scheduled", current_attempt: 2 });
    expect(runtime.rows[0]!.run_at.getTime()).toBeGreaterThanOrEqual(before + delayMs);
    expect(runtime.rows[0]!.run_at.getTime()).toBeLessThanOrEqual(Date.now() + delayMs);
  });

  it("moves a terminal handler failure to failed", async () => {
    const id = await queue.enqueue("email", {}, { maxAttempts: 1 });
    const job = await queue.claim("worker-a");
    expect(await queue.fail(job!, "worker-a", new Error("permanent"))).toBe("failed");
    expect((await queue.getJob(id))?.state).toBe("failed");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state FROM workhorse.job_outcome WHERE job_id = $1", [id])).rows[0]
        .state,
    ).toBe("failed");
  });

  it("rejects retry when the live runtime fence is inconsistent", async () => {
    await queue.enqueue("work", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a");
    await pool.query(
      "UPDATE workhorse.job_runtime SET fence_token = fence_token + 1 WHERE job_id = $1",
      [job!.id],
    );
    await expect(queue.fail(job!, "worker-a", new Error("retry"))).resolves.toBe("stale");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE state = 'active'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE state = 'ready'",
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("recovery CAS skips a runtime whose active fence changed", async () => {
    await queue.enqueue("work", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a", { leaseMs: 100 });
    await pool.query(
      "UPDATE workhorse.job_runtime SET fence_token = fence_token + 1 WHERE job_id = $1",
      [job!.id],
    );
    await sleep(130);
    await expect(queue.recoverExpired()).resolves.toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE state = 'ready'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query("SELECT current_attempt FROM workhorse.job_runtime WHERE job_id = $1", [
          job!.id,
        ])
      ).rows[0].current_attempt,
    ).toBe(2);
  });

  it("runs a registered handler end to end", async () => {
    const id = await queue.enqueue("sum", { a: 2, b: 3 });
    const worker = new Worker(queue, { workerId: "worker-a" }).handle<
      { a: number; b: number },
      { total: number }
    >("sum", ({ a, b }) => ({ total: a + b }));
    expect(await worker.runOnce()).toBe(true);
    expect((await queue.getJob<{ total: number }>(id))?.result).toEqual({ total: 5 });
  });

  it("does not query durability tables for handlers that use no durability helpers", async () => {
    const durabilityQueries: string[] = [];
    const countingDatabase: Queryable = {
      query(text, values) {
        if (/workhorse\.job_(?:checkpoint|wait)\b/.test(text)) durabilityQueries.push(text);
        return pool.query(text, values ? [...values] : undefined);
      },
    };
    const countingQueue = new Queue(countingDatabase);
    const id = await countingQueue.enqueue("ordinary-handler", { value: 42 });
    const worker = new Worker(countingQueue, { workerId: "ordinary-worker" }).handle<
      { value: number },
      { value: number }
    >("ordinary-handler", ({ value }) => ({ value }));

    expect(await worker.runOnce()).toBe(true);
    await expect(countingQueue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { value: 42 },
    });
    expect(durabilityQueries).toEqual([]);
  });

  it("loads each durability cache only once on first helper use", async () => {
    const durabilityQueries: string[] = [];
    const countingDatabase: Queryable = {
      query(text, values) {
        if (/workhorse\.job_(?:checkpoint|wait)\b/.test(text)) durabilityQueries.push(text);
        return pool.query(text, values ? [...values] : undefined);
      },
    };
    const countingQueue = new Queue(countingDatabase);
    await countingQueue.enqueue("durability-reads", {});
    const worker = new Worker(countingQueue, { workerId: "durability-read-worker" }).handle(
      "durability-reads",
      async (_payload, context) => {
        await Promise.all([
          context.getCheckpoint("first"),
          context.getCheckpoint("second"),
          context.getWait("first"),
          context.getWait("second"),
        ]);
        return null;
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(durabilityQueries.filter((query) => query.includes("job_checkpoint"))).toHaveLength(1);
    expect(durabilityQueries.filter((query) => query.includes("job_wait"))).toHaveLength(1);
  });

  it("reuses a completed checkpoint when a later attempt restarts the handler", async () => {
    const id = await queue.enqueue("checkpoint-retry", {}, { maxAttempts: 2 });
    let externalEffects = 0;
    const worker = new Worker(queue, {
      workerId: "checkpoint-worker",
      retryDelayMs: 0,
    }).handle("checkpoint-retry", async (_payload, context) => {
      const authorization = await context.checkpoint("authorize", () => {
        externalEffects += 1;
        return { authorizationId: `auth-${externalEffects}` };
      });
      if (context.job.attempt === 1) throw new Error("crash after durable checkpoint");
      return authorization;
    });

    expect(await worker.runOnce()).toBe(true);
    expect((await queue.getJob(id))?.state).toBe("ready");
    expect(await worker.runOnce()).toBe(true);

    expect(externalEffects).toBe(1);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { authorizationId: "auth-1" },
    });
    await expect(queue.getCheckpoint(id, "authorize")).resolves.toMatchObject({
      value: { authorizationId: "auth-1" },
      attempt: 1,
      workerId: "checkpoint-worker",
    });
  });

  it("coalesces overlapping handler calls for the same checkpoint name", async () => {
    const id = await queue.enqueue("checkpoint-overlap", {});
    let operations = 0;
    const worker = new Worker(queue, { workerId: "checkpoint-worker" }).handle(
      "checkpoint-overlap",
      async (_payload, context) => {
        const operation = async () => {
          operations += 1;
          await sleep(10);
          return { operation: operations };
        };
        const [first, second] = await Promise.all([
          context.checkpoint("shared", operation),
          context.checkpoint("shared", operation),
        ]);
        return { first, second };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(operations).toBe(1);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      result: {
        first: { operation: 1 },
        second: { operation: 1 },
      },
    });
  });

  it.each([
    ["afterClaim", 0, "active"],
    ["beforeHandler", 0, "active"],
    ["afterHandler", 1, "active"],
    ["beforeComplete", 1, "active"],
    ["afterComplete", 1, "succeeded"],
  ] as const)("models a crash at %s", async (failpoint, expectedEffects, expectedState) => {
    const id = await queue.enqueue("work", {}, { maxAttempts: 2 });
    let effects = 0;
    const worker = new Worker(queue, {
      workerId: "crashing-worker",
      leaseMs: 100,
      heartbeatMs: 50,
      failpoint,
    }).handle("work", () => {
      effects += 1;
      return { ok: true };
    });

    await expect(worker.runOnce()).rejects.toBeInstanceOf(InjectedCrashError);
    expect(effects).toBe(expectedEffects);
    expect((await queue.getJob(id))?.state).toBe(expectedState);

    if (expectedState === "active") await sleep(130);
    const recovered = await queue.recoverExpired();
    const stateAfterRecovery = (await queue.getJob(id))?.state;
    expect(recovered).toBe(expectedState === "active" ? 1 : 0);
    expect(stateAfterRecovery).toBe(expectedState === "active" ? "ready" : "succeeded");
  });

  it("reports queue and PostgreSQL health", async () => {
    const waitingId = await queue.enqueue("waiting", {});
    const waiting = await queue.claim("health-worker");
    expect(waiting?.id).toBe(waitingId);
    const scheduledWait = await queue.scheduleWait(waiting!, "health-worker", "health-window", {
      durationMs: 60_000,
    });
    await queue.enqueue("ready", {});
    await queue.enqueue("later", {}, { runAt: new Date(Date.now() + 60_000) });
    const health = await queue.health();
    expect(health.schemaVersion).toBe(16);
    expect(health.readyDepth).toBe(1);
    expect(health.scheduledDepth).toBe(2);
    expect(health.sleepingJobs).toBe(1);
    expect(health.overdueWaits).toBe(0);
    expect(health.nextWakeAt).toEqual(scheduledWait.wait.wakeAt);
    expect(health.relations.some((relation) => relation.relation === "job_runtime")).toBe(true);
    expect(health.lockWaitCount).toBeGreaterThanOrEqual(0);
    expect(health.notificationQueueUsage).toBeGreaterThanOrEqual(0);
  });

  it("round trips retention policy defaults and rejects unsafe or malformed policies in PostgreSQL", async () => {
    await expect(queue.getRetentionPolicy()).resolves.toMatchObject(defaultRetentionPolicy);

    const definition: RetentionPolicyDefinition = {
      jobIdentityRetentionDays: 90,
      terminalOutcomeRetentionDays: 60,
      jobEventRetentionDays: 30,
      attemptHistoryRetentionDays: 45,
      scheduleOccurrenceRetentionDays: 14,
      terminalJobPruneLimit: 17,
      historyPartitionsPerPass: 2,
      defaultPartitionRowsPerPass: 23,
      occurrenceRowsPerPass: 29,
    };
    const persisted = await queue.syncRetentionPolicy(definition);
    expect(persisted).toEqual({ ...definition, updatedAt: expect.any(Date) });
    await expect(queue.getRetentionPolicy()).resolves.toEqual(persisted);

    await expect(
      queue.syncRetentionPolicy({
        ...definition,
        jobIdentityRetentionDays: 10,
        jobEventRetentionDays: 11,
      }),
    ).rejects.toThrow(/retention_policy_check/);
    await expect(
      queue.syncRetentionPolicy({
        ...definition,
        jobIdentityRetentionDays: null,
      }),
    ).rejects.toThrow(/retention_policy_check/);
    await expect(
      pool.query(
        `UPDATE workhorse.retention_policy
            SET job_identity_retention_days = 30,
                terminal_outcome_retention_days = NULL
          WHERE singleton`,
      ),
    ).rejects.toThrow(/retention_policy_check/);
    await expect(
      queue.syncRetentionPolicy({ ...definition, historyPartitionsPerPass: 0 }),
    ).rejects.toThrow(/history_partitions_per_pass/);

    const withoutLimits = await queue.syncRetentionPolicy({
      jobIdentityRetentionDays: null,
      terminalOutcomeRetentionDays: null,
      jobEventRetentionDays: null,
      attemptHistoryRetentionDays: null,
      scheduleOccurrenceRetentionDays: 30,
    });
    expect(withoutLimits).toMatchObject({
      terminalJobPruneLimit: definition.terminalJobPruneLimit,
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

  it("preserves daily completion on identical retention policy sync and invalidates changed windows", async () => {
    await pool.query(`
      UPDATE workhorse.maintenance_state
         SET last_completed_local_date = '2026-08-02'
       WHERE task_name = 'history_retention'`);

    await queue.syncRetentionPolicy(defaultRetentionPolicy);
    expect(
      (
        await pool.query<{ completed: string | null }>(`
          SELECT last_completed_local_date::text AS completed
            FROM workhorse.maintenance_state
           WHERE task_name = 'history_retention'`)
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
           WHERE task_name = 'history_retention'`)
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
      jobIdentityRetentionDays: 36_500,
      terminalOutcomeRetentionDays: 36_500,
      jobEventRetentionDays: 1,
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
          `SELECT to_regclass('workhorse.job_event_20180101') AS first_event,
                  to_regclass('workhorse.job_event_20180102') AS second_event,
                  to_regclass('workhorse.attempt_history_20180101') AS first_attempt,
                  to_regclass('workhorse.attempt_history_20180102') AS second_attempt`,
        )
      ).rows[0],
    ).toEqual({
      first_event: null,
      second_event: "job_event_20180102",
      first_attempt: "attempt_history_20180101",
      second_attempt: "attempt_history_20180102",
    });

    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.job(queue_name, job_type, payload, max_attempts, created_at)
        SELECT 'default', 'old-event', '{}'::jsonb, 1, '2017-01-01'::timestamptz
          FROM generate_series(1, 3)
        RETURNING id
      )
      INSERT INTO workhorse.job_event(job_id, event_type, occurred_at)
      SELECT id, 'old-default', '2017-01-01'::timestamptz FROM identities`);
    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.job(queue_name, job_type, payload, max_attempts, created_at)
        SELECT 'default', 'old-attempt', '{}'::jsonb, 1, '2017-01-01'::timestamptz
          FROM generate_series(1, 3)
        RETURNING id
      )
      INSERT INTO workhorse.attempt_history(
        job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, occurred_at
      )
      SELECT id, 1, 1, 'retention-worker', 'succeeded',
             '2017-01-01'::timestamptz, '2017-01-01'::timestamptz, '2017-01-01'::timestamptz
        FROM identities`);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      jobEventRetentionDays: 1,
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
          (SELECT count(*)::integer FROM workhorse.job_event_default) AS events,
          (SELECT count(*)::integer FROM workhorse.attempt_history_default) AS attempts`)
      ).rows[0],
    ).toEqual({ events: 1, attempts: 1 });
  });

  it("deletes only safely unattributed terminal jobs and never live jobs", async () => {
    const finish = async (type: string) => {
      const id = await queue.enqueue(type, {});
      const job = await queue.claim("retention-worker");
      expect(job?.id).toBe(id);
      expect(await queue.complete(job!, "retention-worker", { done: true })).toBe(true);
      await pool.query(
        `UPDATE workhorse.job
            SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.job_event
            SET occurred_at = clock_timestamp() - interval '40 days' WHERE job_id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.attempt_history
            SET started_at = clock_timestamp() - interval '40 days',
                claimed_at = clock_timestamp() - interval '40 days',
                finished_at = clock_timestamp() - interval '40 days',
                occurred_at = clock_timestamp() - interval '40 days'
          WHERE job_id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.job_outcome
            SET finished_at = clock_timestamp() - interval '40 days',
                history_through_at = clock_timestamp() - interval '40 days'
          WHERE job_id = $1`,
        [id],
      );
      return id;
    };

    const deletable = await finish("deletable");
    const secondDeletable = await finish("second-deletable");
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = clock_timestamp() - interval '39 days' WHERE job_id = $1`,
      [secondDeletable],
    );
    const eventGuard = await finish("event-guard");
    const attemptGuard = await finish("attempt-guard");
    const occurrenceGuard = await finish("occurrence-guard");
    const recentOutcome = await finish("recent-outcome");
    const live = await queue.enqueue("live", {});
    await pool.query(
      `UPDATE workhorse.job SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
      [live],
    );

    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = ANY($1::uuid[])", [
      [deletable, secondDeletable, attemptGuard, occurrenceGuard, recentOutcome],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = ANY($1::uuid[])", [
      [deletable, secondDeletable, eventGuard, occurrenceGuard, recentOutcome],
    ]);
    await pool.query(
      `INSERT INTO workhorse.job_event(job_id, event_type) VALUES ($1, 'late-retained')`,
      [eventGuard],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at
       ) VALUES ($1, 2, 2, 'late-retention-worker', 'succeeded', clock_timestamp(), clock_timestamp())`,
      [attemptGuard],
    );
    await pool.query(
      `UPDATE workhorse.job_outcome SET finished_at = clock_timestamp() WHERE job_id = $1`,
      [recentOutcome],
    );
    await pool.query(
      `INSERT INTO workhorse.job_checkpoint(
         job_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id
       ) VALUES ($1, 'retained-until-delete', '{}'::jsonb, 1, 1, 'retention-worker')`,
      [deletable],
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, job_type, payload, max_attempts
       ) VALUES ('retention', 'guard', '0 * * * *', 'default', 'guard', '{}'::jsonb, 1)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at, job_id)
       VALUES ('retention', 'guard', clock_timestamp(), $1)`,
      [occurrenceGuard],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      jobIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      jobEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalJobPruneLimit: 1,
    });
    expect(await queue.retainHistory({ force: true })).toHaveLength(3);

    expect((await queue.pruneTerminalStorage({ force: true }))[1]).toMatchObject({
      phase: "terminal_jobs",
      rowsAffected: 1,
      error: null,
    });
    expect(await queue.getJob(deletable)).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_checkpoint WHERE job_id = $1",
          [deletable],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(await queue.getJob(secondDeletable)).not.toBeNull();
    expect((await queue.pruneTerminalStorage({ force: true }))[1]).toMatchObject({
      phase: "terminal_jobs",
      rowsAffected: 1,
      error: null,
    });
    expect(await queue.getJob(secondDeletable)).toBeNull();
    for (const retained of [eventGuard, attemptGuard, occurrenceGuard, recentOutcome, live]) {
      expect(await queue.getJob(retained)).not.toBeNull();
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
      const job = await queue.claim(`retention-${key}`);
      expect(job?.id).toBe(id);
      expect(await queue.complete(job!, `retention-${key}`, { done: true })).toBe(true);
      await pool.query("DELETE FROM workhorse.job_event WHERE job_id = $1", [id]);
      await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = $1", [id]);
      await pool.query(
        `UPDATE workhorse.job SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
        [id],
      );
      await pool.query(
        `UPDATE workhorse.job_outcome
            SET finished_at = clock_timestamp() - interval '40 days',
                history_through_at = clock_timestamp() - interval '40 days'
          WHERE job_id = $1`,
        [id],
      );
      return id;
    };

    const expired = await finishKeyed("expired-cleanup", 5);
    const retained = await finishKeyed("retained-cleanup", 60_000);
    await sleep(15);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      jobIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      jobEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalJobPruneLimit: 10,
    });

    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases[0]).toMatchObject({
      phase: "enqueue_idempotency",
      rowsAffected: 1,
      error: null,
    });
    expect(phases[1]).toMatchObject({ phase: "terminal_jobs", rowsAffected: 1, error: null });
    expect(await queue.getJob(expired)).toBeNull();
    expect(await queue.getJob(retained)).not.toBeNull();
    expect(
      (await pool.query("SELECT job_id FROM workhorse.enqueue_idempotency ORDER BY job_id")).rows,
    ).toEqual([{ job_id: retained }]);
  });

  it("serializes terminal deletion with concurrent history insertion", async () => {
    const id = await queue.enqueue("retention-race", {});
    const job = await queue.claim("retention-race-worker");
    expect(job?.id).toBe(id);
    expect(await queue.complete(job!, "retention-race-worker", { done: true })).toBe(true);
    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = $1", [id]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = $1", [id]);
    await pool.query(
      `UPDATE workhorse.job
          SET created_at = clock_timestamp() - interval '40 days' WHERE id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE job_id = $1`,
      [id],
    );

    const deleting = await pool.connect();
    const inserting = await pool.connect();
    try {
      await deleting.query("BEGIN");
      await expect(
        deleting.query(
          `SELECT workhorse.prune_terminal_jobs_v1(
             clock_timestamp() - interval '30 days',
             clock_timestamp() - interval '30 days',
             date_trunc('day', clock_timestamp() - interval '30 days'), 1
           ) AS pruned`,
        ),
      ).resolves.toMatchObject({ rows: [{ pruned: 1 }] });

      const insert = inserting.query(
        `INSERT INTO workhorse.job_event(job_id, event_type) VALUES ($1, 'concurrent')`,
        [id],
      );
      await sleep(25);
      await deleting.query("COMMIT");
      await expect(insert).rejects.toMatchObject({ code: "23503" });
    } finally {
      await deleting.query("ROLLBACK").catch(() => undefined);
      deleting.release();
      inserting.release();
    }
    await expect(queue.getJob(id)).resolves.toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_event WHERE job_id = $1",
          [id],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("reports retention boundaries, lag, eligible partitions, and exact default counts", async () => {
    const oldDay = "2016-01-04";
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [oldDay]);
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [oldDay]);
    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.job(queue_name, job_type, payload, max_attempts, created_at)
        VALUES ('default', 'health-event', '{}'::jsonb, 1, '2015-01-01'),
               ('default', 'health-attempt', '{}'::jsonb, 1, '2015-01-01')
        RETURNING id, job_type
      )
      INSERT INTO workhorse.job_event(job_id, event_type, occurred_at)
      SELECT id, 'old-default', '2015-01-01' FROM identities WHERE job_type = 'health-event';
      WITH identity AS (
        SELECT id FROM workhorse.job WHERE job_type = 'health-attempt'
      )
      INSERT INTO workhorse.attempt_history(
        job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, occurred_at
      ) SELECT id, 1, 1, 'health-worker', 'succeeded', '2015-01-01', '2015-01-01',
               '2015-01-01' FROM identity`);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      jobIdentityRetentionDays: 30,
      jobEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
    });

    const health = await queue.health();
    expect(health.retentionPolicy).toMatchObject({
      jobEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
    });
    expect(health.oldestRetainedAt.jobEvents?.toISOString().slice(0, 10)).toBe("2015-01-01");
    expect(health.oldestRetainedAt.attemptHistory?.toISOString().slice(0, 10)).toBe("2015-01-01");
    expect(health.retentionLagMs.jobEvents).toBeGreaterThan(0);
    expect(health.retentionLagMs.attemptHistory).toBeGreaterThan(0);
    expect(health.eligibleHistoryPartitions).toMatchObject({ jobEvents: 1, attemptHistory: 1 });
    expect(health.defaultHistoryRows).toEqual({ jobEvents: 1, attemptHistory: 1 });
    expect(health.defaultHistoryRowsCapped).toEqual({ jobEvents: false, attemptHistory: false });

    const zonedClient = await pool.connect();
    try {
      await zonedClient.query("SET TIME ZONE 'Pacific/Kiritimati'");
      const zonedHealth = await new Queue(zonedClient).health();
      expect(zonedHealth.eligibleHistoryPartitions).toEqual(health.eligibleHistoryPartitions);
      expect(zonedHealth.retentionLagMs.jobEvents).toBeCloseTo(
        health.retentionLagMs.jobEvents!,
        -3,
      );
      expect(zonedHealth.retentionLagMs.attemptHistory).toBeCloseTo(
        health.retentionLagMs.attemptHistory!,
        -3,
      );
    } finally {
      await zonedClient.query("RESET TIME ZONE");
      zonedClient.release();
    }
  });

  it("caps fallback-row health scans and marks the reported lower bound", async () => {
    await pool.query(`
      WITH identities AS (
        INSERT INTO workhorse.job(queue_name, job_type, payload, max_attempts, created_at)
        SELECT 'default', 'health-cap', '{}'::jsonb, 1, '2001-01-01'::timestamptz
          FROM generate_series(1, 10002)
        RETURNING id
      )
      INSERT INTO workhorse.job_event(job_id, event_type, occurred_at)
      SELECT id, 'health-cap', '2001-01-01'::timestamptz FROM identities`);

    const health = await queue.health();
    expect(health.defaultHistoryRows.jobEvents).toBe(10_001);
    expect(health.defaultHistoryRowsCapped.jobEvents).toBe(true);
    expect(health.defaultHistoryRows.attemptHistory).toBe(0);
    expect(health.defaultHistoryRowsCapped.attemptHistory).toBe(false);
  });

  it("computes identity lag from terminal jobs and ignores a partial history boundary day", async () => {
    await queue.enqueue("live-boundary", {});
    const boundary = await pool.query<{ day_start: string }>(
      `SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date - 30)::text AS day_start`,
    );
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [boundary.rows[0]!.day_start]);
    const partialBoundaryJob = await queue.enqueue("partial-boundary", {});
    await pool.query(
      `INSERT INTO workhorse.job_event(job_id, event_type, occurred_at)
       VALUES (
         $1, 'partial-boundary',
         (
           ((clock_timestamp() AT TIME ZONE 'UTC')::date - 30)::timestamp
           + interval '12 hours'
         ) AT TIME ZONE 'UTC'
       )`,
      [partialBoundaryJob],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      jobIdentityRetentionDays: 30,
      jobEventRetentionDays: 30,
    });

    const health = await queue.health();
    expect(health.oldestRetainedAt.jobIdentity).toBeNull();
    expect(health.retentionLagMs.jobEvents).toBe(0);
  });

  it("does not report terminal outcome lag before the identity anchor is eligible", async () => {
    const id = await queue.enqueue("terminal-lag-gates", {});
    const job = await queue.claim("retention-health-worker");
    expect(job?.id).toBe(id);
    expect(await queue.complete(job!, "retention-health-worker", { done: true })).toBe(true);
    await pool.query(
      `UPDATE workhorse.job
          SET created_at = clock_timestamp() - interval '30 days' WHERE id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = clock_timestamp() - interval '30 days' WHERE job_id = $1`,
      [id],
    );
    await queue.syncRetentionPolicy({
      jobIdentityRetentionDays: 365,
      terminalOutcomeRetentionDays: 1,
      jobEventRetentionDays: 365,
      attemptHistoryRetentionDays: 365,
      scheduleOccurrenceRetentionDays: 365,
    });

    const protectedHealth = await queue.health();
    expect(protectedHealth.oldestRetainedAt.terminalOutcome).not.toBeNull();
    expect(protectedHealth.retentionLagMs.jobIdentity).toBeNull();
    expect(protectedHealth.retentionLagMs.terminalOutcome).toBeNull();

    await queue.syncRetentionPolicy({
      jobIdentityRetentionDays: 1,
      terminalOutcomeRetentionDays: 1,
      jobEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
      scheduleOccurrenceRetentionDays: 1,
    });
    const eligible = await queue.health();
    expect(eligible.retentionLagMs.jobIdentity).toBeGreaterThan(0);
    expect(eligible.retentionLagMs.terminalOutcome).toBeGreaterThan(0);
  });

  it("creates and retires completed daily history partitions", async () => {
    const oldDay = "2020-01-08";
    const historicalTimestamp = "2020-01-08T12:00:00.000Z";
    const historicalJobId = "00000000-0000-4000-8000-000000000001";
    await pool.query(
      `INSERT INTO workhorse.job(id, queue_name, job_type, payload, max_attempts, created_at)
       VALUES ($1, 'default', 'historical', '{}'::jsonb, 1, $2)`,
      [historicalJobId, historicalTimestamp],
    );
    await pool.query(
      `INSERT INTO workhorse.job_event(job_id, event_type, occurred_at)
       VALUES ($1, 'fallback', $2)`,
      [historicalJobId, historicalTimestamp],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, occurred_at
       ) VALUES ($1, 1, 1, 'fallback-worker', 'succeeded', $2, $2, $2, $2)`,
      [historicalJobId, historicalTimestamp],
    );
    const fallbackRelations = await pool.query<{ relation: string }>(
      `
      SELECT tableoid::regclass::text AS relation FROM workhorse.job_event WHERE job_id = $1
      UNION ALL
      SELECT tableoid::regclass::text FROM workhorse.attempt_history WHERE job_id = $1
      ORDER BY relation`,
      [historicalJobId],
    );
    expect(fallbackRelations.rows).toEqual([
      { relation: "attempt_history_default" },
      { relation: "job_event_default" },
    ]);

    await pool.query("SELECT workhorse.create_history_day_v1($1)", [oldDay]);
    expect(
      (await pool.query("SELECT to_regclass('workhorse.job_event_20200108') AS relation")).rows[0]
        .relation,
    ).not.toBeNull();
    expect(
      (await pool.query("SELECT to_regclass('workhorse.attempt_history_20200108') AS relation"))
        .rows[0].relation,
    ).not.toBeNull();
    const migratedRelations = await pool.query<{ relation: string }>(
      `
      SELECT tableoid::regclass::text AS relation FROM workhorse.job_event WHERE job_id = $1
      UNION ALL
      SELECT tableoid::regclass::text FROM workhorse.attempt_history WHERE job_id = $1
      ORDER BY relation`,
      [historicalJobId],
    );
    expect(migratedRelations.rows).toEqual([
      { relation: "attempt_history_20200108" },
      { relation: "job_event_20200108" },
    ]);
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [oldDay]);
    expect(
      (await pool.query("SELECT to_regclass('workhorse.job_event_20200108') AS relation")).rows[0]
        .relation,
    ).toBeNull();
    await expect(
      pool.query(
        "SELECT workhorse.retire_history_day_v1((clock_timestamp() AT TIME ZONE 'UTC')::date)",
      ),
    ).rejects.toThrow(/only completed history days can be retired/);
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
          EXECUTE format('DROP TABLE workhorse.%I', 'job_event_' || suffix);
          EXECUTE format('DROP TABLE workhorse.%I', 'attempt_history_' || suffix);
        END LOOP;
      END
      $$`);
    expect(await queue.prepareHistoryPartitions({ force: true })).toMatchObject([
      { phase: "history_partitions", rowsAffected: 2, skippedLock: false, error: null },
    ]);
    const horizon = await pool.query<{ missing: number }>(`
      SELECT count(*) FILTER (
               WHERE to_regclass(format('workhorse.%I', 'job_event_' || suffix)) IS NULL
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
          `SELECT to_regclass('workhorse.job_event_20210201') IS NOT NULL AS event_exists,
                  to_regclass('workhorse.attempt_history_20210201') IS NOT NULL AS attempt_exists`,
        )
      ).rows[0],
    ).toEqual({ event_exists: true, attempt_exists: true });
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
          "SELECT workhorse.retire_history_partitions_v1('job_event', $1, 1) AS retired",
          ["2014-03-04"],
        ),
      ).resolves.toMatchObject({ rows: [{ retired: 0 }] });
      await zonedClient.query("ROLLBACK");
      await blocker.query("COMMIT");

      await expect(
        pool.query("SELECT workhorse.retire_history_partitions_v1('job_event', $1, 1) AS retired", [
          "2014-03-04",
        ]),
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
      CREATE TABLE retention_external.job_event_2014w10
        PARTITION OF workhorse.job_event
        FOR VALUES FROM ('2014-03-03') TO ('2014-03-10')`);

    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE retention_external.job_event_2014w10 IN ACCESS SHARE MODE");
      const startedAt = Date.now();
      await expect(
        pool.query("SELECT workhorse.retire_history_partitions_v1('job_event', $1, 1) AS retired", [
          "2014-03-10",
        ]),
      ).resolves.toMatchObject({ rows: [{ retired: 0 }] });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }

    await expect(
      pool.query("SELECT workhorse.retire_history_partitions_v1('job_event', $1, 1) AS retired", [
        "2014-03-10",
      ]),
    ).resolves.toMatchObject({ rows: [{ retired: 1 }] });
    expect(
      (await pool.query("SELECT to_regclass('retention_external.job_event_2014w10') AS relation"))
        .rows[0]?.relation,
    ).toBeNull();
    await pool.query("DROP SCHEMA retention_external");
  });

  it("installs and reconverges the v16 operator projection, indexes, functions, and lifecycle triggers", async () => {
    const objects = await pool.query<{
      projection: string | null;
      list_jobs: string | null;
      timeline: string | null;
      projection_has_payload: boolean;
    }>(`SELECT
      to_regclass('workhorse.job_query')::text AS projection,
      to_regprocedure('workhorse.list_jobs_v1(jsonb,integer,timestamp with time zone,uuid,text,jsonb)')::text AS list_jobs,
      to_regprocedure('workhorse.list_job_timeline_v1(uuid,integer,timestamp with time zone,text,bigint)')::text AS timeline,
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'workhorse' AND table_name = 'job_query' AND column_name = 'payload'
      ) AS projection_has_payload`);
    expect(objects.rows[0]).toEqual({
      projection: "job_query",
      list_jobs: "list_jobs_v1(jsonb,integer,timestamp with time zone,uuid,text,jsonb)",
      timeline: "list_job_timeline_v1(uuid,integer,timestamp with time zone,text,bigint)",
      projection_has_payload: false,
    });

    const indexes = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'workhorse'
         AND indexname IN (
           'job_query_created_idx', 'job_query_queue_created_idx',
           'job_query_type_created_idx', 'job_query_state_created_idx',
           'attempt_history_job_time_idx'
         ) ORDER BY indexname`);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "attempt_history_job_time_idx",
      "job_query_created_idx",
      "job_query_queue_created_idx",
      "job_query_state_created_idx",
      "job_query_type_created_idx",
    ]);

    const triggers = await pool.query<{ tgname: string }>(`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid IN ('workhorse.job_runtime'::regclass, 'workhorse.job_outcome'::regclass)
         AND NOT tgisinternal AND tgname LIKE '%query_projection%'
       ORDER BY tgname`);
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "job_outcome_query_projection_insert",
      "job_runtime_query_projection_insert",
      "job_runtime_query_projection_update",
    ]);

    const id = await queue.enqueue("projection-converge", { ignored: true });
    await pool.query("UPDATE workhorse.job_query SET state = 'scheduled' WHERE job_id = $1", [id]);
    await installSchema(pool);
    expect(
      (await pool.query("SELECT state FROM workhorse.job_query WHERE job_id = $1", [id])).rows[0],
    ).toEqual({ state: "ready" });
  });

  it("projects meaningful live and terminal transitions without heartbeat churn", async () => {
    const id = await queue.enqueue("projection-transitions", { value: 1 }, { maxAttempts: 1 });
    expect(
      (
        await pool.query(
          "SELECT state, current_attempt FROM workhorse.job_query WHERE job_id = $1",
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "ready", current_attempt: 1 });

    const claimed = await queue.claim("projection-worker");
    expect(claimed?.id).toBe(id);
    const active = await pool.query<{ state: string; updated_at: Date }>(
      "SELECT state, updated_at FROM workhorse.job_query WHERE job_id = $1",
      [id],
    );
    expect(active.rows[0]?.state).toBe("active");
    await sleep(5);
    expect(await queue.heartbeat(claimed!, "projection-worker", 30_000)).toBe(true);
    const afterHeartbeat = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM workhorse.job_query WHERE job_id = $1",
      [id],
    );
    expect(afterHeartbeat.rows[0]?.updated_at.getTime()).toBe(active.rows[0]?.updated_at.getTime());

    const requested = await queue.cancel(id, { requestedBy: "operator", reason: "maintenance" });
    expect(requested.status).toBe("cancel_requested");
    expect(
      (
        await pool.query(
          `SELECT state, cancel_requested_by, cancel_reason,
                  cancel_requested_at IS NOT NULL AS requested
             FROM workhorse.job_query WHERE job_id = $1`,
          [id],
        )
      ).rows[0],
    ).toEqual({
      state: "active",
      cancel_requested_by: "operator",
      cancel_reason: "maintenance",
      requested: true,
    });
    expect(
      (
        await pool.query("SELECT workhorse.acknowledge_cancel_v1($1, $2, $3) AS accepted", [
          id,
          "projection-worker",
          claimed!.fenceToken.toString(),
        ])
      ).rows[0]?.accepted,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT state, cancel_requested_by, cancel_reason FROM workhorse.job_query WHERE job_id = $1",
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "canceled", cancel_requested_by: "operator", cancel_reason: "maintenance" });
  });

  it("lists mixed live and terminal jobs with every filter and immutable same-time cursors", async () => {
    const createdAt = "2025-01-02T03:04:05.123456Z";
    const ids = [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
    ];
    await pool.query(
      `INSERT INTO workhorse.job(id, queue_name, job_type, payload, tags, max_attempts, created_at)
       VALUES ($1, 'query-a', 'email', '{"n":1}', ARRAY['one'], 3, $4),
              ($2, 'query-a', 'email', '{"n":2}', ARRAY['two'], 3, $4),
              ($3, 'query-b', 'report', '{"n":3}', ARRAY['three'], 3, $4)`,
      [...ids, createdAt],
    );
    await pool.query(
      `INSERT INTO workhorse.job_runtime(
         job_id, queue_name, state, current_attempt, run_at, ready_at, sequence, updated_at
       ) VALUES ($1, 'query-a', 'ready', 1, $2, $2, nextval('workhorse.ready_sequence_seq'), $2)`,
      [ids[0], createdAt],
    );
    await pool.query(
      `INSERT INTO workhorse.job_outcome(
         job_id, state, current_attempt, fence_token, run_at, result, finished_at, updated_at
       ) VALUES
         ($1, 'succeeded', 1, 1, $3, '{}', $3, $3),
         ($2, 'succeeded', 2, 1, $3, '{}', $3, $3)`,
      [ids[1], ids[2], createdAt],
    );

    const filtered = await queue.listJobs({
      queue: "query-a",
      type: "email",
      states: ["ready", "succeeded"],
      createdAfter: new Date("2025-01-02T03:04:05.123Z"),
      createdBefore: new Date("2025-01-02T03:04:05.124Z"),
      limit: 2,
    });
    expect(filtered.items.map((item) => item.id)).toEqual([ids[1], ids[0]]);
    expect(filtered.nextCursor).toBeNull();

    const first = await queue.listJobs({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    await pool.query(
      `INSERT INTO workhorse.job(id, queue_name, job_type, payload, max_attempts, created_at)
       VALUES ('00000000-0000-0000-0000-000000000004', 'query-new', 'new', '{}', 1, $1)`,
      [createdAt],
    );
    await pool.query(
      `INSERT INTO workhorse.job_runtime(
         job_id, queue_name, state, run_at, ready_at, sequence, updated_at
       ) VALUES (
         '00000000-0000-0000-0000-000000000004', 'query-new', 'ready', $1, $1,
         nextval('workhorse.ready_sequence_seq'), $1
       )`,
      [createdAt],
    );
    const second = await queue.listJobs({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    // This is the documented weak consistency boundary: a concurrent row before the cursor is not
    // duplicated into the later page, and no snapshot claim is made for it.
    expect(second.items.some((item) => item.id.endsWith("0004"))).toBe(false);
  });

  it("binds list cursors to normalized filters and payload projections", async () => {
    for (const [id, type] of [
      ["10000000-0000-0000-0000-000000000001", "bound-a"],
      ["10000000-0000-0000-0000-000000000002", "bound-a"],
    ] as const) {
      await pool.query(
        `INSERT INTO workhorse.job(id, queue_name, job_type, payload, max_attempts, created_at)
         VALUES ($1, 'bound', $2, '{"secret":"x"}', 1, '2025-02-01T00:00:00Z')`,
        [id, type],
      );
      await pool.query(
        `INSERT INTO workhorse.job_runtime(
           job_id, queue_name, state, run_at, ready_at, sequence, updated_at
         ) VALUES ($1, 'bound', 'ready', '2025-02-01T00:00:00Z', '2025-02-01T00:00:00Z',
           nextval('workhorse.ready_sequence_seq'), '2025-02-01T00:00:00Z')`,
        [id],
      );
    }
    const first = await queue.listJobs({ type: "bound-a", limit: 1 });
    expect(first.nextCursor?.signature).toMatch(/^[0-9a-f]{16}$/);
    await expect(
      queue.listJobs({ type: "bound-b", limit: 1, cursor: first.nextCursor! }),
    ).rejects.toThrow(/cursor does not match/);
    await expect(
      queue.listJobs({
        type: "bound-a",
        limit: 1,
        cursor: first.nextCursor!,
        payload: { include: true },
      }),
    ).rejects.toThrow(/cursor does not match/);
    await expect(
      pool.query("SELECT * FROM workhorse.list_jobs_v1('{}', 1, now(), NULL, NULL, '{}')"),
    ).rejects.toThrow(/provided together/);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const timezoneFirst = await client.query<{
        job_id: string;
        cursor_created_at: string;
        cursor_signature: string;
      }>(
        `SELECT job_id, cursor_created_at::text AS cursor_created_at, cursor_signature
           FROM workhorse.list_jobs_v1($1, 1, NULL, NULL, NULL, '{}')`,
        [JSON.stringify({ type: "bound-a", createdAfter: "2025-01-01T00:00:00Z" })],
      );
      await client.query("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
      const timezoneSecond = await client.query(
        `SELECT job_id
           FROM workhorse.list_jobs_v1($1, 1, $2, $3, $4, '{}')`,
        [
          JSON.stringify({ type: "bound-a", createdAfter: "2025-01-01T00:00:00Z" }),
          timezoneFirst.rows[0]!.cursor_created_at,
          timezoneFirst.rows[0]!.job_id,
          timezoneFirst.rows[0]!.cursor_signature,
        ],
      );
      expect(timezoneSecond.rowCount).toBe(1);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("omits payloads by default and redacts before enforcing byte bounds", async () => {
    const objectId = await queue.enqueue("payload-object", {
      visible: "ok",
      secret: "x".repeat(10_000),
      nested: { secret: "retained" },
    });
    const omitted = await queue.listJobs({ type: "payload-object" });
    expect(omitted.items[0]).toMatchObject({
      id: objectId,
      payload: null,
      payloadStatus: "omitted",
      payloadBytes: null,
    });
    const expectedBytes = Number(
      (
        await pool.query<{ bytes: number }>(
          `SELECT octet_length(($1::jsonb - ARRAY['secret'])::text)::integer AS bytes`,
          [
            JSON.stringify({
              visible: "ok",
              secret: "x".repeat(10_000),
              nested: { secret: "retained" },
            }),
          ],
        )
      ).rows[0]?.bytes,
    );
    const included = await queue.listJobs({
      type: "payload-object",
      payload: { include: true, maxBytes: expectedBytes, redactKeys: ["secret"] },
    });
    expect(included.items[0]).toMatchObject({
      payload: { visible: "ok", nested: { secret: "retained" } },
      payloadStatus: "included",
      payloadBytes: expectedBytes,
    });
    const tooLarge = await queue.listJobs({
      type: "payload-object",
      payload: { include: true, maxBytes: expectedBytes - 1, redactKeys: ["secret"] },
    });
    expect(tooLarge.items[0]).toMatchObject({
      payload: null,
      payloadStatus: "too_large",
      payloadBytes: expectedBytes,
    });

    await queue.enqueue("payload-scalar", "secret");
    await queue.enqueue("payload-array", ["secret", { secret: "retained" }]);
    expect(
      (
        await queue.listJobs({
          states: ["ready"],
          payload: { include: true, maxBytes: 1_024, redactKeys: ["secret"] },
        })
      ).items
        .filter((item) => item.type.startsWith("payload-"))
        .map((item) => item.payload),
    ).toEqual([
      ["secret", { secret: "retained" }],
      "secret",
      { visible: "ok", nested: { secret: "retained" } },
    ]);

    for (const [projection, message] of [
      [{ include: true, maxBytes: 0 }, /between 1 and 1048576/],
      [{ include: true, maxBytes: 1048577 }, /between 1 and 1048576/],
      [{ include: true, redactKeys: ["x", "x"] }, /unique/],
      [{ include: true, redactKeys: [""] }, /1 to 200/],
      [{ include: true, unknown: true }, /permits only/],
    ] as const) {
      await expect(
        pool.query("SELECT * FROM workhorse.list_jobs_v1('{}', 1, NULL, NULL, NULL, $1)", [
          JSON.stringify(projection),
        ]),
      ).rejects.toThrow(message);
    }
    await expect(queue.listJobs({ unknown: true } as never)).rejects.toThrow(
      /query contains unknown field: unknown/,
    );
    await expect(
      queue.listJobs({ payload: { include: true, unknown: true } } as never),
    ).rejects.toThrow(/payload contains unknown field: unknown/);
  });

  it("uses only dedicated operator indexes for global, queue, type, and state creation scans", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const queries = [
        [
          "job_query_created_idx",
          "SELECT * FROM workhorse.job_query ORDER BY created_at DESC, job_id DESC LIMIT 10",
        ],
        [
          "job_query_queue_created_idx",
          "SELECT * FROM workhorse.job_query WHERE queue_name = 'q' ORDER BY created_at DESC, job_id DESC LIMIT 10",
        ],
        [
          "job_query_type_created_idx",
          "SELECT * FROM workhorse.job_query WHERE job_type = 't' ORDER BY created_at DESC, job_id DESC LIMIT 10",
        ],
        [
          "job_query_state_created_idx",
          "SELECT * FROM workhorse.job_query WHERE state = 'ready' ORDER BY created_at DESC, job_id DESC LIMIT 10",
        ],
      ] as const;
      for (const [indexName, sql] of queries) {
        const plan = (
          await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF) ${sql}`)
        ).rows
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(plan).toContain(indexName);
        expect(plan).not.toMatch(
          /job_runtime_(ready|scheduled|expired_active|deadline|timeout)_idx/,
        );
      }
      const combinedPlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT * FROM workhorse.job_query
           WHERE queue_name = 'query-a'
             AND job_type = 'email'
             AND state = ANY (ARRAY['ready', 'succeeded'])
           ORDER BY created_at DESC, job_id DESC LIMIT 10`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      expect(combinedPlan).toMatch(/job_query_(queue|type|state)_created_idx/);
      expect(combinedPlan).not.toMatch(
        /job_runtime_(ready|scheduled|expired_active|deadline|timeout)_idx/,
      );
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("merges retained events and attempts with stable equal-time cursors and exact final pages", async () => {
    const jobId = "20000000-0000-0000-0000-000000000001";
    const sameTime = "2025-03-04T05:06:07.123456Z";
    await pool.query(
      `INSERT INTO workhorse.job(id, queue_name, job_type, payload, max_attempts, created_at)
       VALUES ($1, 'timeline', 'timeline', '{}', 2, '2025-03-01T00:00:00Z')`,
      [jobId],
    );
    await pool.query(
      `INSERT INTO workhorse.job_event(job_id, attempt, event_type, details, occurred_at)
       VALUES ($1, 1, 'older-event', '{"position":"old"}', '2025-03-04T05:06:06Z'),
              ($1, 1, 'same-event', '{"position":"event"}', $2),
              ($1, 2, 'newer-event', '{"position":"new"}', '2025-03-04T05:06:08Z')`,
      [jobId, sameTime],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, error, occurred_at
       ) VALUES (
         $1, 1, 7, 'timeline-worker', 'retry', '2025-03-04T05:00:00Z',
         '2025-03-04T05:00:01Z', $2, '{"name":"Retry"}', $2
       )`,
      [jobId, sameTime],
    );

    const first = await queue.getJobTimeline(jobId, { limit: 2 });
    expect(
      first.items.map((item) => [item.kind, item.kind === "event" ? item.eventType : item.outcome]),
    ).toEqual([
      ["event", "newer-event"],
      ["event", "same-event"],
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await queue.getJobTimeline(jobId, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.kind)).toEqual(["attempt", "event"]);
    expect(second.items[0]).toMatchObject({
      kind: "attempt",
      attempt: 1,
      fenceToken: 7n,
      workerId: "timeline-worker",
      outcome: "retry",
      error: { name: "Retry" },
    });
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => `${item.kind}:${item.recordId}`))
        .size,
    ).toBe(4);

    await expect(
      pool.query("SELECT * FROM workhorse.list_job_timeline_v1($1, 10, $2, 'unknown', 1)", [
        jobId,
        sameTime,
      ]),
    ).rejects.toThrow(/event or attempt/);
    await expect(
      pool.query("SELECT * FROM workhorse.list_job_timeline_v1($1, 10, $2, NULL, 1)", [
        jobId,
        sameTime,
      ]),
    ).rejects.toThrow(/provided together/);

    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = $1", [jobId]);
    expect((await queue.getJobTimeline(jobId)).items.map((item) => item.kind)).toEqual(["attempt"]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = $1", [jobId]);
    expect((await queue.getJobTimeline(jobId)).items).toEqual([]);
    expect((await queue.getJobTimeline("20000000-0000-0000-0000-000000000099")).items).toEqual([]);
  });
});
