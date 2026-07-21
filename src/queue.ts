import type {
  ClaimedJob,
  EnqueueOptions,
  JobSnapshot,
  Json,
  Queryable,
  QueueHealth,
} from "./types.js";

type ClaimRow = {
  job_id: string;
  job_type: string;
  payload: Json;
  attempt: number;
  max_attempts: number;
  fence_token: string;
  lease_expires_at: Date;
};

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
    // Supplying an active PoolClient makes enqueue participate in the caller's application
    // transaction. The function does not begin or commit a transaction on the caller's behalf.
    const result = await transaction.query<{ job_id: string }>(
      "SELECT ironshift.enqueue_v1($1, $2, $3::jsonb, $4, $5) AS job_id",
      [
        options.queue ?? this.defaultQueue,
        type,
        JSON.stringify(payload),
        options.runAt ?? new Date(),
        options.maxAttempts ?? 3,
      ],
    );
    return result.rows[0]!.job_id;
  }

  async promote(limit = 100): Promise<number> {
    // Promotion is bounded so a large delayed backlog cannot create one long lock transaction.
    const result = await this.database.query<{ count: number }>(
      "SELECT ironshift.promote_v1($1) AS count",
      [limit],
    );
    return result.rows[0]!.count;
  }

  async claim<TPayload = Json>(
    workerId: string,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedJob<TPayload> | null> {
    // claim_v1 commits ownership before returning the payload. Handler code must run only after
    // this query resolves so no row lock or claim transaction spans user code.
    const result = await this.database.query<ClaimRow>(
      "SELECT * FROM ironshift.claim_v1($1, $2, $3)",
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
      "SELECT ironshift.heartbeat_v1($1, $2, $3, $4) AS accepted",
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
      "SELECT ironshift.complete_v1($1, $2, $3, $4::jsonb) AS accepted",
      [job.id, workerId, job.fenceToken.toString(), JSON.stringify(result)],
    );
    return query.rows[0]!.accepted;
  }

  async fail(
    job: ClaimedJob<unknown>,
    workerId: string,
    error: unknown,
    retryDelayMs = 0,
  ): Promise<"ready" | "scheduled" | "failed" | "stale"> {
    // PostgreSQL decides whether retry budget remains and atomically closes the old attempt before
    // creating the next projection. retryDelayMs selects ready versus scheduled placement.
    const result = await this.database.query<{ state: "ready" | "scheduled" | "failed" | "stale" }>(
      "SELECT ironshift.fail_v1($1, $2, $3, $4::jsonb, $5) AS state",
      [
        job.id,
        workerId,
        job.fenceToken.toString(),
        JSON.stringify(errorEnvelope(error)),
        retryDelayMs,
      ],
    );
    return result.rows[0]!.state;
  }

  async recoverExpired(limit = 100, retryDelayMs = 0): Promise<number> {
    // Recovery may be called by many workers. SKIP LOCKED inside the function partitions work
    // between callers while fence checks prevent an old lease from recovering a newer attempt.
    const result = await this.database.query<{ count: number }>(
      "SELECT ironshift.recover_expired_v1($1, $2) AS count",
      [limit, retryDelayMs],
    );
    return result.rows[0]!.count;
  }

  async getJob<TResult = Json>(id: string): Promise<JobSnapshot<TResult> | null> {
    // Operator reads join immutable identity with the current projection. This query is never used
    // by dispatch, so adding operator-facing fields does not expand the ready index.
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
      `SELECT j.id, j.queue_name, j.job_type, j.payload, c.state, c.current_attempt,
              j.max_attempts, c.version, c.run_at, c.result, c.error, j.created_at, c.updated_at
         FROM ironshift.job j JOIN ironshift.job_current c ON c.job_id = j.id
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
        "SELECT max(version)::integer AS version FROM ironshift.schema_version",
      ),
      this.database.query<{ state: JobSnapshot["state"]; count: string }>(
        "SELECT state, count(*)::text AS count FROM ironshift.job_current GROUP BY state",
      ),
      this.database.query<{
        ready: string;
        scheduled: string;
        active: string;
        expired: string;
        oldest_ready_age_ms: number | null;
      }>(`
        SELECT (SELECT count(*) FROM ironshift.ready_job)::text AS ready,
               (SELECT count(*) FROM ironshift.scheduled_job)::text AS scheduled,
               (SELECT count(*) FROM ironshift.lease)::text AS active,
               (SELECT count(*) FROM ironshift.lease WHERE expires_at <= clock_timestamp())::text AS expired,
               (SELECT extract(epoch FROM clock_timestamp() - min(enqueued_at)) * 1000 FROM ironshift.ready_job) AS oldest_ready_age_ms`),
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
         WHERE n.nspname = 'ironshift' AND c.relkind IN ('r', 'p')
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
