import type { QueryResult, QueryResultRow } from "pg";

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface EnqueueOptions {
  queue?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export interface ClaimedJob<TPayload = Json> {
  id: string;
  type: string;
  payload: TPayload;
  attempt: number;
  maxAttempts: number;
  fenceToken: bigint;
  leaseExpiresAt: Date;
}

export type JobState = "scheduled" | "ready" | "active" | "succeeded" | "failed";

export interface JobSnapshot<TResult = Json> {
  id: string;
  queue: string;
  type: string;
  payload: Json;
  state: JobState;
  currentAttempt: number;
  maxAttempts: number;
  fenceToken: bigint;
  runAt: Date;
  result: TResult | null;
  error: Json | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueHealth {
  schemaVersion: number | null;
  counts: Record<JobState, number>;
  readyDepth: number;
  scheduledDepth: number;
  activeLeases: number;
  expiredLeases: number;
  oldestReadyAgeMs: number | null;
  relations: Array<{
    relation: string;
    totalBytes: number;
    tableBytes: number;
    indexBytes: number;
    liveTuples: number;
    deadTuples: number;
    modificationsSinceAnalyze: number;
    hotUpdateRatio: number | null;
    lastVacuum: Date | null;
    lastAutovacuum: Date | null;
  }>;
  oldestTransactionAgeMs: number | null;
  lockWaitCount: number;
  notificationQueueUsage: number;
}
