import { CronExpressionParser } from "cron-parser";
import type {
  ClaimedJob,
  EnqueueOptions,
  EnqueueRequest,
  JobSnapshot,
  Json,
  Queryable,
  QueueHealth,
} from "./types.js";

export interface ScheduleJobDefinition {
  type: string;
  payload: Json;
  queue?: string;
  maxAttempts?: number;
}

export interface ScheduleDefinition {
  name: string;
  schedule: string;
  enabled?: boolean;
  job: ScheduleJobDefinition;
}

export interface StoredSchedule {
  namespace: string;
  name: string;
  schedule: string;
  revision: bigint;
  lastOccurrenceAt: Date | null;
}

export type MaintenancePhase =
  | "promote"
  | "recover"
  | "history_partitions"
  | "schedule_occurrences";

export interface MaintenancePhaseResult {
  phase: MaintenancePhase;
  rowsAffected: number;
  durationMs: number;
  skippedLock: boolean;
  error: Json;
}
import { MAX_ENQUEUE_BATCH_SIZE } from "./types.js";

type ClaimRow = {
  job_id: string;
  job_type: string;
  payload: Json;
  attempt: number;
  max_attempts: number;
  fence_token: string;
  lease_expires_at: Date;
};

type MaintenancePhaseRow = {
  phase: MaintenancePhase;
  rows_affected: number;
  duration_ms: number;
  skipped_lock: boolean;
  error: Json;
};

function maintenancePhaseResult(row: MaintenancePhaseRow): MaintenancePhaseResult {
  return {
    phase: row.phase,
    rowsAffected: row.rows_affected,
    durationMs: row.duration_ms,
    skippedLock: row.skipped_lock,
    error: row.error,
  };
}

function errorEnvelope(error: unknown): Json {
  // Persist a bounded JSON representation instead of relying on Error's non-enumerable fields.
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  return { name: "NonErrorThrown", message: String(error) };
}

/**
 * Thin TypeScript facade over the versioned PostgreSQL protocol.
 *
 * Correctness lives in SQL functions. Keeping this layer thin prevents each runtime client from
 * inventing its own locking, fencing, or history behavior.
 */
export class Queue {
  constructor(
    private readonly database: Queryable,
    readonly defaultQueue = "default",
  ) {}

  async enqueue<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {},
    transaction: Queryable = this.database,
  ): Promise<string> {
    return (await this.enqueueMany([{ type, payload, options }], transaction))[0]!;
  }

  async enqueueMany(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.database,
  ): Promise<string[]> {
    if (requests.length === 0) return [];
    if (requests.length > MAX_ENQUEUE_BATCH_SIZE) {
      throw new RangeError(`enqueueMany accepts at most ${MAX_ENQUEUE_BATCH_SIZE} requests`);
    }

    // Supplying an active PoolClient makes the whole batch participate in the caller's transaction.
    const input = requests.map(({ type, payload, options = {} }) => ({
      queue: options.queue ?? this.defaultQueue,
      type,
      payload,
      runAt: (options.runAt ?? new Date()).toISOString(),
      maxAttempts: options.maxAttempts ?? 25,
    }));
    const result = await transaction.query<{ job_id: string }>(
      "SELECT job_id FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal",
      [JSON.stringify(input)],
    );
    return result.rows.map((row) => row.job_id);
  }

  async promote(limit = 100): Promise<number> {
    // Promotion is bounded so a large delayed backlog cannot create one long lock transaction.
    const result = await this.database.query<{ count: number }>(
      "SELECT workhorse.promote_v1($1) AS count",
      [limit],
    );
    return result.rows[0]!.count;
  }

  async tick(
    options: { promoteLimit?: number; recoverLimit?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    const result = await this.database.query<MaintenancePhaseRow>(
      "SELECT * FROM workhorse.tick_v1($1, $2)",
      [options.promoteLimit ?? 1_000, options.recoverLimit ?? 1_000],
    );
    return result.rows.map(maintenancePhaseResult);
  }

  async housekeep(
    options: { occurrenceRetentionDays?: number; occurrencePruneLimit?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    const result = await this.database.query<MaintenancePhaseRow>(
      "SELECT * FROM workhorse.housekeep_v1($1, $2)",
      [options.occurrenceRetentionDays ?? 30, options.occurrencePruneLimit ?? 10_000],
    );
    return result.rows.map(maintenancePhaseResult);
  }

  async syncSchedules(
    namespace: string,
    definitions: readonly ScheduleDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<void> {
    for (const definition of definitions) {
      try {
        CronExpressionParser.parse(definition.schedule);
      } catch (error) {
        throw new Error(`Invalid cron expression for schedule ${definition.name}`, {
          cause: error,
        });
      }
    }
    const input = definitions.map((definition) => ({
      name: definition.name,
      schedule: definition.schedule,
      enabled: definition.enabled ?? true,
      queue: definition.job.queue ?? this.defaultQueue,
      type: definition.job.type,
      payload: definition.job.payload,
      maxAttempts: definition.job.maxAttempts ?? 25,
    }));
    await this.database.query("SELECT workhorse.sync_schedule_definitions_v1($1, $2::jsonb, $3)", [
      namespace,
      JSON.stringify(input),
      options.prune ?? true,
    ]);
  }

  async schedules(namespaces: readonly string[]): Promise<StoredSchedule[]> {
    if (namespaces.length === 0) return [];
    const result = await this.database.query<{
      namespace: string;
      schedule_name: string;
      cron_expression: string;
      revision: string;
      last_occurrence_at: Date | null;
    }>(
      `SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
              definition.revision::text,
              max(occurrence.occurrence_at) AS last_occurrence_at
         FROM workhorse.schedule_definition definition
         LEFT JOIN workhorse.schedule_occurrence occurrence
           ON occurrence.namespace = definition.namespace
          AND occurrence.schedule_name = definition.schedule_name
        WHERE definition.enabled AND definition.namespace = ANY($1::text[])
        GROUP BY definition.namespace, definition.schedule_name
        ORDER BY definition.namespace, definition.schedule_name`,
      [namespaces],
    );
    return result.rows.map((row) => ({
      namespace: row.namespace,
      name: row.schedule_name,
      schedule: row.cron_expression,
      revision: BigInt(row.revision),
      lastOccurrenceAt: row.last_occurrence_at,
    }));
  }

  async fireSchedule(
    namespace: string,
    name: string,
    revision: bigint,
    occurrenceAt: Date,
  ): Promise<string | null> {
    const result = await this.database.query<{ job_id: string | null }>(
      "SELECT workhorse.fire_schedule_v1($1, $2, $3, $4) AS job_id",
      [namespace, name, revision.toString(), occurrenceAt.toISOString()],
    );
    return result.rows[0]!.job_id;
  }

  async claim<TPayload = Json>(
    workerId: string,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedJob<TPayload> | null> {
    // claim_v1 commits ownership before returning the payload. Handler code must run only after
    // this query resolves so no row lock or claim transaction spans user code.
    const result = await this.database.query<ClaimRow>(
      "SELECT * FROM workhorse.claim_v1($1, $2, $3)",
      [options.queue ?? this.defaultQueue, workerId, options.leaseMs ?? 30_000],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.job_id,
      type: row.job_type,
      payload: row.payload as TPayload,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      fenceToken: BigInt(row.fence_token),
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  async heartbeat(job: ClaimedJob<unknown>, workerId: string, leaseMs = 30_000): Promise<boolean> {
    // False means the worker/fence is stale or the lease already expired. The caller must stop
    // treating the job as owned even if local handler code is still running.
    const result = await this.database.query<{ accepted: boolean }>(
      "SELECT workhorse.heartbeat_v1($1, $2, $3, $4) AS accepted",
      [job.id, workerId, job.fenceToken.toString(), leaseMs],
    );
    return result.rows[0]!.accepted;
  }

  async complete<TResult extends Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    result: TResult,
  ): Promise<boolean> {
    // Completion is conditional on the exact unexpired lease and fence. A stale worker gets false
    // rather than overwriting the result of a recovered attempt.
    const query = await this.database.query<{ accepted: boolean }>(
      "SELECT workhorse.complete_v1($1, $2, $3, $4::jsonb) AS accepted",
      [job.id, workerId, job.fenceToken.toString(), JSON.stringify(result)],
    );
    return query.rows[0]!.accepted;
  }

  async fail(
    job: ClaimedJob<unknown>,
    workerId: string,
    error: unknown,
    retryDelayMs?: number,
  ): Promise<"ready" | "scheduled" | "failed" | "stale"> {
    // PostgreSQL decides whether retry budget remains and atomically closes the old attempt before
    // creating the next projection. Undefined selects SQL-owned backoff; a number explicitly
    // overrides it, including zero for an immediate retry.
    const result = await this.database.query<{ state: "ready" | "scheduled" | "failed" | "stale" }>(
      "SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb, $5) AS state",
      [
        job.id,
        workerId,
        job.fenceToken.toString(),
        JSON.stringify(errorEnvelope(error)),
        retryDelayMs ?? null,
      ],
    );
    return result.rows[0]!.state;
  }

  async recoverExpired(limit = 100, retryDelayMs = 0): Promise<number> {
    // Recovery may be called by many workers. SKIP LOCKED inside the function partitions work
    // between callers while fence checks prevent an old lease from recovering a newer attempt.
    const result = await this.database.query<{ count: number }>(
      "SELECT workhorse.recover_expired_v1($1, $2) AS count",
      [limit, retryDelayMs],
    );
    return result.rows[0]!.count;
  }

  async getJob<TResult = Json>(id: string): Promise<JobSnapshot<TResult> | null> {
    // A job exists in exactly one lifecycle relation: runtime while live, outcome when terminal.
    const result = await this.database.query<{
      id: string;
      queue_name: string;
      job_type: string;
      payload: Json;
      state: JobSnapshot["state"];
      current_attempt: number;
      max_attempts: number;
      version: string;
      run_at: Date;
      result: TResult | null;
      error: Json | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT j.id, j.queue_name, j.job_type, j.payload, COALESCE(r.state, o.state) AS state,
              COALESCE(r.current_attempt, o.current_attempt) AS current_attempt,
              j.max_attempts, COALESCE(r.fence_token, o.fence_token) AS version,
              COALESCE(r.run_at, o.run_at) AS run_at, o.result,
              COALESCE(r.error, o.error) AS error, j.created_at,
              COALESCE(r.updated_at, o.updated_at) AS updated_at
         FROM workhorse.job j
         LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
         LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
        WHERE j.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      queue: row.queue_name,
      type: row.job_type,
      payload: row.payload,
      state: row.state,
      currentAttempt: row.current_attempt,
      maxAttempts: row.max_attempts,
      fenceToken: BigInt(row.version),
      runAt: row.run_at,
      result: row.result,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async health(): Promise<QueueHealth> {
    // Run independent read-only diagnostics concurrently. PostgreSQL statistics are observations,
    // not transactional facts, and can lag until the statistics collector flushes.
    const [version, counts, depths, relations, activity, notification] = await Promise.all([
      this.database.query<{ version: number }>(
        `SELECT CASE
                  WHEN count(*) = 1
                   AND min(version) = max(version)
                   AND NOT EXISTS (
                     SELECT 1
                       FROM unnest(ARRAY['job_current', 'ready_job', 'scheduled_job', 'lease'])
                         AS legacy(relation_name)
                      WHERE to_regclass(format('workhorse.%I', relation_name)) IS NOT NULL
                   )
                  THEN min(version)::integer
                  ELSE NULL
                END AS version
           FROM workhorse.schema_version`,
      ),
      this.database.query<{ state: JobSnapshot["state"]; count: string }>(
        `SELECT state, count(*)::text AS count
           FROM (SELECT state FROM workhorse.job_runtime UNION ALL
                 SELECT state FROM workhorse.job_outcome) lifecycle
          GROUP BY state`,
      ),
      this.database.query<{
        ready: string;
        scheduled: string;
        active: string;
        expired: string;
        oldest_ready_age_ms: number | null;
      }>(`
        SELECT count(*) FILTER (WHERE state = 'ready')::text AS ready,
               count(*) FILTER (WHERE state = 'scheduled')::text AS scheduled,
               count(*) FILTER (WHERE state = 'active')::text AS active,
               count(*) FILTER (WHERE state = 'active' AND expires_at <= clock_timestamp())::text AS expired,
               extract(epoch FROM clock_timestamp() - min(ready_at) FILTER (WHERE state = 'ready')) * 1000
                 AS oldest_ready_age_ms
          FROM workhorse.job_runtime`),
      this.database.query<{
        relation: string;
        total_bytes: string;
        table_bytes: string;
        index_bytes: string;
        live_tuples: string;
        dead_tuples: string;
        modifications_since_analyze: string;
        hot_update_ratio: number | null;
        last_vacuum: Date | null;
        last_autovacuum: Date | null;
      }>(`
        SELECT c.relname AS relation, pg_total_relation_size(c.oid)::text AS total_bytes,
               pg_relation_size(c.oid)::text AS table_bytes, pg_indexes_size(c.oid)::text AS index_bytes,
               COALESCE(s.n_live_tup, 0)::text AS live_tuples, COALESCE(s.n_dead_tup, 0)::text AS dead_tuples,
               COALESCE(s.n_mod_since_analyze, 0)::text AS modifications_since_analyze,
               CASE WHEN COALESCE(s.n_tup_upd, 0) = 0 THEN NULL
                    ELSE s.n_tup_hot_upd::double precision / s.n_tup_upd END AS hot_update_ratio,
               s.last_vacuum, s.last_autovacuum
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
         WHERE n.nspname = 'workhorse' AND c.relkind IN ('r', 'p')
         ORDER BY c.relname`),
      this.database.query<{ age_ms: number | null; lock_wait_count: string }>(`
        SELECT extract(epoch FROM clock_timestamp() - min(xact_start)) * 1000 AS age_ms,
               count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS lock_wait_count
          FROM pg_stat_activity WHERE pid <> pg_backend_pid()`),
      this.database.query<{ usage: number }>("SELECT pg_notification_queue_usage() AS usage"),
    ]);

    const stateCounts: QueueHealth["counts"] = {
      scheduled: 0,
      ready: 0,
      active: 0,
      succeeded: 0,
      failed: 0,
    };
    for (const row of counts.rows) stateCounts[row.state] = Number(row.count);
    const depth = depths.rows[0]!;
    return {
      schemaVersion: version.rows[0]?.version ?? null,
      counts: stateCounts,
      readyDepth: Number(depth.ready),
      scheduledDepth: Number(depth.scheduled),
      activeLeases: Number(depth.active),
      expiredLeases: Number(depth.expired),
      oldestReadyAgeMs:
        depth.oldest_ready_age_ms === null ? null : Number(depth.oldest_ready_age_ms),
      relations: relations.rows.map((row) => ({
        relation: row.relation,
        totalBytes: Number(row.total_bytes),
        tableBytes: Number(row.table_bytes),
        indexBytes: Number(row.index_bytes),
        liveTuples: Number(row.live_tuples),
        deadTuples: Number(row.dead_tuples),
        modificationsSinceAnalyze: Number(row.modifications_since_analyze),
        hotUpdateRatio: row.hot_update_ratio === null ? null : Number(row.hot_update_ratio),
        lastVacuum: row.last_vacuum,
        lastAutovacuum: row.last_autovacuum,
      })),
      oldestTransactionAgeMs:
        activity.rows[0]?.age_ms === null ? null : Number(activity.rows[0]?.age_ms ?? 0),
      lockWaitCount: Number(activity.rows[0]?.lock_wait_count ?? 0),
      notificationQueueUsage: Number(notification.rows[0]?.usage ?? 0),
    };
  }
}
