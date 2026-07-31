import type { QueryResult, QueryResultRow } from "pg";

export interface Queryable {
  /** Minimal structural contract shared by pg Pool and PoolClient. */
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Options persisted as part of the accepted job definition or initial dispatch projection. */
export interface EnqueueOptions {
  queue?: string;
  runAt?: Date;
  maxAttempts?: number;
  tags?: string[];
}

/** One job accepted by {@link Queue.enqueueMany}, with the same semantics as `Queue.enqueue`. */
export interface EnqueueRequest<TPayload extends Json = Json> {
  type: string;
  payload: TPayload;
  options?: EnqueueOptions;
  tags?: string[];
}

/**
 * Maximum supported requests per `enqueueMany` call. This bounds JSON parsing, statement memory,
 * identity allocation, and notification work inside one PostgreSQL transaction.
 */
export const MAX_ENQUEUE_BATCH_SIZE = 1_000;
/** Maximum PostgreSQL canonical JSONB text size accepted for one durable checkpoint value. */
export const MAX_CHECKPOINT_VALUE_BYTES = 1_048_576;
/** Maximum relative duration or first absolute target horizon for one durable wait (365 days). */
export const MAX_WAIT_DURATION_MS = 31_536_000_000;

export interface ClaimedJob<TPayload = Json> {
  /** Stable job identity across all attempts. */
  id: string;
  type: string;
  payload: TPayload;
  /** One-based attempt number. Recovery and retry always create the next number. */
  attempt: number;
  maxAttempts: number;
  /** Ownership generation that must accompany heartbeat, completion, and failure. */
  fenceToken: bigint;
  /** Client-visible expiry snapshot. PostgreSQL remains authoritative. */
  leaseExpiresAt: Date;
}

/** One immutable named result persisted at an explicit handler restart boundary. */
export interface JobCheckpoint<TValue extends Json = Json> {
  jobId: string;
  name: string;
  value: TValue;
  /** Attempt that first persisted this checkpoint. */
  attempt: number;
  /** Ownership generation that authorized the checkpoint write. */
  fenceToken: bigint;
  workerId: string;
  createdAt: Date;
}

/** One immutable named durable timer boundary. */
export interface JobWait {
  jobId: string;
  name: string;
  mode: "relative" | "absolute";
  /** First committed relative duration. Later relative arguments for this name are ignored. */
  durationMs: number | null;
  /** Exact caller target for an absolute wait, or null for a relative wait. */
  requestedWakeAt: Date | null;
  /** PostgreSQL-computed durable target used by promotion. */
  wakeAt: Date;
  /** Logical attempt that first persisted this wait. */
  attempt: number;
  /** Ownership generation that authorized the first write. */
  fenceToken: bigint;
  workerId: string;
  createdAt: Date;
}

export type JobState = "scheduled" | "ready" | "active" | "succeeded" | "failed";

export interface JobSnapshot<TResult = Json> {
  id: string;
  queue: string;
  type: string;
  payload: Json;
  tags: string[];
  state: JobState;
  currentAttempt: number;
  maxAttempts: number;
  /** Current ownership generation, or zero before the first claim. */
  fenceToken: bigint;
  runAt: Date;
  result: TResult | null;
  error: Json | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueHealth {
  /** Canonical schema protocol version installed in this database. */
  schemaVersion: number | null;
  counts: Record<JobState, number>;
  readyDepth: number;
  scheduledDepth: number;
  activeLeases: number;
  expiredLeases: number;
  oldestReadyAgeMs: number | null;
  /** PostgreSQL relation statistics are estimates and may lag until stats flush. */
  relations: Array<{
    relation: string;
    totalBytes: number;
    tableBytes: number;
    indexBytes: number;
    liveTuples: number;
    deadTuples: number;
    modificationsSinceAnalyze: number;
    /** HOT updates divided by all updates, or null when no updates were observed. */
    hotUpdateRatio: number | null;
    lastVacuum: Date | null;
    lastAutovacuum: Date | null;
  }>;
  oldestTransactionAgeMs: number | null;
  /** Sessions currently waiting on PostgreSQL locks, excluding the health query itself. */
  lockWaitCount: number;
  /** Fraction of PostgreSQL's global async notification queue currently occupied. */
  notificationQueueUsage: number;
}
