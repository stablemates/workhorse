import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ENQUEUE_BATCH_SIZE } from "../src/types.js";
import type { EnqueueRequest, Json, Queryable } from "../src/types.js";

export const conventionalSchema = "workhorse_benchmark_conventional";
export const conventionalSqlFile = "benchmark-conventional.sql";

export type ConventionalJobState = "scheduled" | "ready" | "active" | "succeeded" | "failed";
export type ConventionalFailState = "ready" | "scheduled" | "failed" | "stale";

export interface ConventionalEnqueueOptions {
  queue?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export interface ConventionalClaimOptions {
  queue?: string;
  leaseMs?: number;
}

export interface ConventionalClaimedJob<TPayload = Json> {
  id: string;
  type: string;
  payload: TPayload;
  attempt: number;
  maxAttempts: number;
  fenceToken: bigint;
  leaseExpiresAt: Date;
}

export interface ConventionalJobSnapshot<TResult = Json> {
  id: string;
  queue: string;
  type: string;
  payload: Json;
  state: ConventionalJobState;
  currentAttempt: number;
  maxAttempts: number;
  fenceToken: bigint;
  workerId: string | null;
  runAt: Date;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
  finishedAt: Date | null;
  result: TResult | null;
  error: Json | null;
  createdAt: Date;
  updatedAt: Date;
}

type ClaimRow = {
  job_id: string;
  job_type: string;
  payload: Json;
  attempt: number;
  max_attempts: number;
  fence_token: string;
  lease_expires_at: Date;
};

function loadSqlFromSourceOrDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Repository-root execution, including tsx from source.
    resolve(process.cwd(), "sql", conventionalSqlFile),
    // Module-relative source or built execution.
    resolve(here, "..", "sql", conventionalSqlFile),
    // Defensive fallback for unusual loaders that place this module one level deeper.
    resolve(here, "..", "..", "sql", conventionalSqlFile),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`Unable to locate ${conventionalSqlFile} in source or dist paths`);
  return readFileSync(path, "utf8");
}

export const conventionalSql = loadSqlFromSourceOrDist();

function errorEnvelope(error: unknown): Json {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  return { name: "NonErrorThrown", message: String(error) };
}

export class ConventionalQueue {
  constructor(
    private readonly database: Queryable,
    readonly defaultQueue = "benchmark",
  ) {}

  async setup(): Promise<void> {
    await this.database.query(conventionalSql);
  }

  async reset(): Promise<void> {
    await this.database.query(`SELECT ${conventionalSchema}.reset_v1()`);
  }

  async enqueue<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: ConventionalEnqueueOptions = {},
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
    const input = requests.map(({ type, payload, options = {} }) => ({
      queue: options.queue ?? this.defaultQueue,
      type,
      payload,
      runAt: (options.runAt ?? new Date()).toISOString(),
      maxAttempts: options.maxAttempts ?? 3,
    }));
    const result = await transaction.query<{ job_id: string }>(
      `SELECT job_id FROM ${conventionalSchema}.enqueue_many_v1($1::jsonb) ORDER BY ordinal`,
      [JSON.stringify(input)],
    );
    return result.rows.map((row) => row.job_id);
  }

  async promote(limit = 100): Promise<number> {
    const result = await this.database.query<{ count: number }>(
      `SELECT ${conventionalSchema}.promote_v1($1) AS count`,
      [limit],
    );
    return result.rows[0]!.count;
  }

  async claim<TPayload = Json>(
    workerId: string,
    options: ConventionalClaimOptions = {},
  ): Promise<ConventionalClaimedJob<TPayload> | null> {
    const result = await this.database.query<ClaimRow>(
      `SELECT * FROM ${conventionalSchema}.claim_v1($1, $2, $3)`,
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

  async heartbeat(
    job: ConventionalClaimedJob<unknown>,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<boolean> {
    const result = await this.database.query<{ accepted: boolean }>(
      `SELECT ${conventionalSchema}.heartbeat_v1($1, $2, $3, $4) AS accepted`,
      [job.id, workerId, job.fenceToken.toString(), leaseMs],
    );
    return result.rows[0]!.accepted;
  }

  async complete<TResult extends Json>(
    job: ConventionalClaimedJob<unknown>,
    workerId: string,
    result: TResult,
  ): Promise<boolean> {
    const query = await this.database.query<{ accepted: boolean }>(
      `SELECT ${conventionalSchema}.complete_v1($1, $2, $3, $4::jsonb) AS accepted`,
      [job.id, workerId, job.fenceToken.toString(), JSON.stringify(result)],
    );
    return query.rows[0]!.accepted;
  }

  async fail(
    job: ConventionalClaimedJob<unknown>,
    workerId: string,
    error: unknown,
    retryDelayMs = 0,
  ): Promise<ConventionalFailState> {
    const result = await this.database.query<{ state: ConventionalFailState }>(
      `SELECT ${conventionalSchema}.fail_v1($1, $2, $3, $4::jsonb, $5) AS state`,
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
    const result = await this.database.query<{ count: number }>(
      `SELECT ${conventionalSchema}.recover_expired_v1($1, $2) AS count`,
      [limit, retryDelayMs],
    );
    return result.rows[0]!.count;
  }

  async getJob<TResult = Json>(id: string): Promise<ConventionalJobSnapshot<TResult> | null> {
    const result = await this.database.query<{
      id: string;
      queue_name: string;
      job_type: string;
      payload: Json;
      state: ConventionalJobState;
      current_attempt: number;
      max_attempts: number;
      fence_token: string;
      worker_id: string | null;
      run_at: Date;
      started_at: Date | null;
      heartbeat_at: Date | null;
      lease_expires_at: Date | null;
      finished_at: Date | null;
      result: TResult | null;
      error: Json | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, queue_name, job_type, payload, state, current_attempt, max_attempts,
              fence_token, worker_id, run_at, started_at, heartbeat_at, lease_expires_at,
              finished_at, result, error, created_at, updated_at
         FROM ${conventionalSchema}.job
        WHERE id = $1`,
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
      fenceToken: BigInt(row.fence_token),
      workerId: row.worker_id,
      runAt: row.run_at,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      leaseExpiresAt: row.lease_expires_at,
      finishedAt: row.finished_at,
      result: row.result,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
