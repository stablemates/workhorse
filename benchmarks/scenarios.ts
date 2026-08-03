import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { QueryResult, QueryResultRow } from "pg";
import {
  CancellationRequestedError,
  DeadlineExceededError,
  EnqueueIdempotencyConflictError,
  ExecutionTimeoutError,
  InjectedCrashError,
  ProgressLeaseLostError,
  ProgressRateLimitError,
  Queue,
  Worker,
} from "../src/index.js";
import type { ClaimedJob, Failpoint, Queryable, QueueHealth } from "../src/index.js";

export const operationalScenarioNames = [
  "scheduled-promotion-drift",
  "heartbeat-fencing",
  "cancellation-lifecycle",
  "deadline-timeout-lifecycle",
  "dead-letter-redrive-lifecycle",
  "query-listing-lifecycle",
  "progress-lifecycle",
  "crash-before-completion",
  "lease-expiry-recovery",
  "retry-paths",
  "idempotent-ingress",
  "retention-pruning",
  "health-snapshot",
  "worker-concurrency",
] as const;

export type OperationalScenarioName = (typeof operationalScenarioNames)[number];
export type ScenarioMetric = number | string | boolean | null;

export interface OperationalScenarioContract {
  name: OperationalScenarioName;
  purpose: string;
  invariants: readonly string[];
  metrics: readonly string[];
}

export interface ScenarioAssertion {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface OperationalScenarioResult {
  name: OperationalScenarioName;
  durationMs: number;
  metrics: Record<string, ScenarioMetric>;
  assertions: ScenarioAssertion[];
}

export interface OperationalScenarioReport {
  options: ResolvedOperationalScenarioOptions;
  totalDurationMs: number;
  scenarios: OperationalScenarioResult[];
}

export interface OperationalScenarioOptions {
  /** Ready/scheduled jobs used by backlog and health scenarios. */
  jobCount?: number;
  /** Jobs sampled by the heartbeat scenario. */
  heartbeatCount?: number;
  /** Maximum rows promoted or recovered by one maintenance call. */
  batchSize?: number;
  /** Delay before scheduled work becomes due. */
  scheduleDelayMs?: number;
  /** Lease duration used by crash and recovery scenarios. */
  leaseMs?: number;
  /** Delayed retry interval. */
  retryDelayMs?: number;
  /** Upper bound on terminal jobs seeded for the weekly retirement scenario. */
  pruneLimit?: number;
  /** Queue prefix. Every scenario appends its stable scenario name. */
  queuePrefix?: string;
  /** Select a stable subset while retaining contract order. */
  scenarios?: readonly OperationalScenarioName[];
  /** Injectable monotonic clock for deterministic tests. */
  now?: () => number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam for orchestration tests. Production callers should omit this. */
  scenarioImplementations?: Partial<Record<OperationalScenarioName, OperationalScenarioRunner>>;
}

export interface ResolvedOperationalScenarioOptions {
  jobCount: number;
  heartbeatCount: number;
  batchSize: number;
  scheduleDelayMs: number;
  leaseMs: number;
  retryDelayMs: number;
  pruneLimit: number;
  queuePrefix: string;
  scenarios: readonly OperationalScenarioName[];
}

export interface OperationalScenarioContext {
  pool: Queryable;
  options: ResolvedOperationalScenarioOptions;
  queueName: string;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

export type OperationalScenarioRunner = (
  context: OperationalScenarioContext,
) => Promise<OperationalScenarioResult>;

export const operationalScenarioContracts: readonly OperationalScenarioContract[] = [
  {
    name: "scheduled-promotion-drift",
    purpose: "Measure bounded promotion of a due scheduled backlog and observed due-time drift.",
    invariants: [
      "all seeded jobs begin scheduled",
      "all due jobs are promoted in bounded batches",
      "scheduled depth reaches zero and ready depth equals the seed count",
    ],
    metrics: ["jobs", "promotionBatches", "promoted", "driftP50Ms", "driftP95Ms", "driftMaxMs"],
  },
  {
    name: "heartbeat-fencing",
    purpose: "Compare accepted heartbeat cost with rejected stale-fence cost.",
    invariants: [
      "current heartbeats are accepted",
      "heartbeats with a newer, unowned fence are rejected",
      "valid owners can still complete every sampled job",
    ],
    metrics: [
      "jobs",
      "accepted",
      "staleRejected",
      "acceptedMeanMs",
      "staleMeanMs",
      "staleOverheadMs",
    ],
  },
  {
    name: "cancellation-lifecycle",
    purpose:
      "Exercise immediate, cooperative, expired-lease, race, attempt-history, and recurring-occurrence cancellation semantics.",
    invariants: [
      "ready and scheduled jobs cancel immediately without inventing attempt history",
      "a waiting job cancels immediately and records history only because its logical attempt started",
      "active cancellation is delivered through heartbeat status and AbortSignal then acknowledged by the exact fence",
      "an ignored active cancellation materializes as canceled at lease expiry instead of retrying",
      "completion, failure, heartbeat, and wrong-fence acknowledgement cannot overwrite cancellation",
      "repeated requests create no duplicate terminal outcome or cancellation events",
      "cancellation versus completion or failure is first-committer-wins",
      "canceling one recurring occurrence leaves the schedule enabled and the next occurrence independent",
    ],
    metrics: [
      "readyCancelMs",
      "scheduledCancelMs",
      "waitingCancelMs",
      "activeRequestMs",
      "activeRepeatRequestMs",
      "activeAcknowledgeMs",
      "ignoredRequestMs",
      "expiryMaterializationMs",
      "terminalReplayMs",
      "stateQueryMs",
      "eventQueryMs",
      "recurringNextOccurrenceMs",
    ],
  },
  {
    name: "deadline-timeout-lifecycle",
    purpose:
      "Exercise pre-claim deadline exclusion, active cooperative expiry, timeout retry, stale-write fencing, and health pressure.",
    invariants: [
      "a ready job past its absolute deadline is never newly claimed and becomes terminal without invented attempt history",
      "an active deadline is delivered through AbortSignal and fences late completion",
      "an execution timeout closes distinct attempt history and uses remaining retry budget",
      "deadline and timeout pressure are visible in the canonical health snapshot",
    ],
    metrics: [
      "readyDeadlineReapMs",
      "activeDeadlineMs",
      "timeoutRetryMs",
      "pendingDeadlines",
      "overdueDeadlines",
      "activeExecutionTimeouts",
    ],
  },
  {
    name: "dead-letter-redrive-lifecycle",
    purpose:
      "Exercise bounded failure listing, non-mutating preview, audited redrive, exact replay, and immutable source outcomes.",
    invariants: [
      "terminal failures page through the cold outcome relation without entering live dispatch",
      "bulk dry-run returns eligible sources without creating jobs, events, or lineage",
      "redrive creates fresh ready identities while every source outcome remains unchanged",
      "an exact repeated request returns the original target without duplicate lineage",
      "bounded bulk redrive records complete audited lineage for every created target",
    ],
    metrics: [
      "deadLetters",
      "listMs",
      "dryRunMs",
      "singleRedriveMs",
      "replayMs",
      "bulkRedriveMs",
      "previewed",
      "redriven",
      "lineageEdges",
    ],
  },
  {
    name: "query-listing-lifecycle",
    purpose:
      "Exercise operator-only cross-state pagination, bounded payload projection, and merged retained lifecycle history.",
    invariants: [
      "cross-state pages use an immutable cursor and list every seeded identity once",
      "payloads are omitted by default and top-level redaction precedes byte classification",
      "queue, type, state, and creation-time filters share the same bounded projection",
      "heartbeats do not churn the operator projection while lifecycle transitions do",
      "events and closed attempts form one deterministic retained timeline",
      "operator indexes remain separate from every claim-critical index",
    ],
    metrics: [
      "listedJobs",
      "listMs",
      "payloadProjectionMs",
      "timelineMs",
      "timelineEntries",
      "projectionRows",
      "operatorIndexBytes",
    ],
  },
  {
    name: "progress-lifecycle",
    purpose:
      "Exercise fenced mutable progress, bounded write frequency, latest-value lookup, lifecycle telemetry, and terminal retention.",
    invariants: [
      "the exact active ownership generation can replace the latest bounded progress value",
      "identical writes are no-ops and changed writes from one generation are frequency limited",
      "wrong ownership generations cannot mutate progress",
      "lookup returns only the latest revision with its attempt, fence, worker, and timestamps",
      "accepted changes append bounded telemetry and the latest value survives terminal materialization",
    ],
    metrics: [
      "firstUpdateMs",
      "unchangedUpdateMs",
      "rateLimitedUpdateMs",
      "secondUpdateMs",
      "lookupMs",
      "latestRevision",
      "progressEvents",
    ],
  },
  {
    name: "crash-before-completion",
    purpose: "Model deterministic process disappearance at every worker crash boundary.",
    invariants: [
      "every configured failpoint raises InjectedCrashError",
      "pre-completion crashes retain an active durable lease without closing the attempt",
      "an afterComplete crash preserves the succeeded state and closed attempt",
    ],
    metrics: ["boundaries", "handlerRuns", "activeCrashes", "completedCrashes"],
  },
  {
    name: "lease-expiry-recovery",
    purpose: "Recover an abandoned claim and prove stale completion fencing.",
    invariants: [
      "exactly one expired lease is recovered",
      "recovery creates attempt two with a higher fence",
      "the old owner cannot complete and the recovered owner can",
    ],
    metrics: ["recovered", "firstAttempt", "secondAttempt", "fenceAdvance", "recoveryMs"],
  },
  {
    name: "retry-paths",
    purpose:
      "Exercise manual overrides, persisted fixed/exponential/decorrelated-jitter selection, delayed promotion, and terminal exhaustion.",
    invariants: [
      "zero-delay failure returns ready",
      "positive-delay failure returns scheduled and later promotes",
      "persisted retry policies record their PostgreSQL-selected delay and provenance",
      "decorrelated jitter replays deterministically from persisted inputs",
      "a job at its attempt budget enters failed",
    ],
    metrics: [
      "immediateAttempts",
      "delayedAttempts",
      "delayedPromoted",
      "fixedDelayMs",
      "fixedSelectionMs",
      "exponentialDelayMs",
      "exponentialSelectionMs",
      "jitterDelayMs",
      "jitterSelectionMs",
      "policySelectionTotalMs",
      "exhaustedAttempts",
    ],
  },
  {
    name: "idempotent-ingress",
    purpose:
      "Exercise scoped enqueue replay, conflict rollback, batch duplicates, expiry reuse, and full transition timings.",
    invariants: [
      "an equivalent keyed replay returns the original job without duplicate durable or FIFO effects",
      "a material conflict rolls back the whole batch and reports the retained job and request ordinal",
      "equivalent duplicate keys inside one batch preserve result order while unkeyed ingress remains distinct",
      "an expired scoped binding can be reused for a materially different request and a new job identity",
    ],
    metrics: [
      "firstAcceptMs",
      "exactReplayMs",
      "conflictRollbackMs",
      "batchDuplicatesMs",
      "expiryFirstAcceptMs",
      "expiryReuseMs",
      "jobs",
      "bindings",
      "events",
      "runtimes",
    ],
  },
  {
    name: "retention-pruning",
    purpose: "Measure completed-week history retirement through the versioned partition protocol.",
    invariants: [
      "seeded terminal jobs create event and attempt history in a completed week",
      "retiring the completed week removes its history partitions",
      "history retirement does not delete current job identity",
    ],
    metrics: ["seededJobs", "historyBefore", "pruned", "historyAfter", "retainedJobs"],
  },
  {
    name: "health-snapshot",
    purpose: "Capture operator health under seeded ready, scheduled, and expired-lease states.",
    invariants: [
      "ready and scheduled depths match the seed",
      "one active lease is expired",
      "the expired lease explicitly marks the snapshot as degraded",
      "state counts and protocol version remain internally consistent",
    ],
    metrics: [
      "readyDepth",
      "scheduledDepth",
      "activeLeases",
      "expiredLeases",
      "degraded",
      "degradationReason",
      "schemaVersion",
      "snapshotMs",
    ],
  },
  {
    name: "worker-concurrency",
    purpose:
      "Exercise bounded concurrent worker slots and equal-capacity worker topologies while recording throughput, start latency, and database-pressure proxies without excluding claim work from timing.",
    invariants: [
      "concurrency levels preserve the configured slot bound and expose accurate runtime state",
      "claims remain serial, never exceed free slots, and are all included in timed execution",
      "after backlog exhaustion, serial null-claim pressure is bounded by elapsed polling windows rather than configured concurrency",
      "single, balanced, and distributed worker topologies preserve the same total handler-capacity bound",
      "immediate and I/O-like topology profiles complete every job without leaving active or expired leases",
      "each active job retains an independent heartbeat and completes without an expired lease",
      "pause prevents claims and stop prevents new claims while draining active handlers",
    ],
    metrics: [
      "concurrencyLevels",
      "jobsPerLevel",
      "throughput timing and jobs per second by level",
      "maximum handler, slot, query, and claim overlap by level",
      "claim attempts, null claims, polling-window bounds, and heartbeat calls by level",
      "maximum null claims per polling window across concurrency levels",
      "equal-capacity topology throughput, start latency, overlap, and query pressure by handler profile",
      "first-null claim count",
      "shutdown claimed, succeeded, and remaining-ready counts",
    ],
  },
] as const;

export const resetWorkhorseStateSql = `TRUNCATE workhorse.job_event, workhorse.attempt_history,
  workhorse.job_redrive, workhorse.job_query,
  workhorse.enqueue_idempotency, workhorse.job_outcome, workhorse.job_runtime, workhorse.job RESTART IDENTITY CASCADE;
ALTER SEQUENCE workhorse.fence_token_seq RESTART WITH 1;
ALTER SEQUENCE workhorse.ready_sequence_seq RESTART WITH 1;
UPDATE workhorse.retention_policy
   SET job_identity_retention_days = NULL,
       terminal_outcome_retention_days = NULL,
       job_event_retention_days = NULL,
       attempt_history_retention_days = NULL,
       schedule_occurrence_retention_days = 30,
       terminal_job_prune_limit = 1000,
       history_partitions_per_pass = 4,
       default_partition_rows_per_pass = 10000,
       occurrence_rows_per_pass = 10000,
       updated_at = clock_timestamp()
 WHERE singleton`;

export const createHistoryDayV1Sql = "SELECT workhorse.create_history_day_v1($1::date)";
export const retireHistoryDayV1Sql = "SELECT workhorse.retire_history_day_v1($1::date)";

const defaults: ResolvedOperationalScenarioOptions = {
  jobCount: 12,
  heartbeatCount: 5,
  batchSize: 5,
  scheduleDelayMs: 40,
  leaseMs: 40,
  retryDelayMs: 40,
  pruneLimit: 1_000,
  queuePrefix: "operational",
  scenarios: operationalScenarioNames,
};

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function resolveOperationalScenarioOptions(
  options: OperationalScenarioOptions = {},
): ResolvedOperationalScenarioOptions {
  const requested = options.scenarios ?? defaults.scenarios;
  const unknown = requested.find(
    (name) => !operationalScenarioNames.includes(name as OperationalScenarioName),
  );
  if (unknown !== undefined) throw new RangeError(`unknown operational scenario: ${unknown}`);
  if (new Set(requested).size !== requested.length) {
    throw new RangeError("operational scenarios must not contain duplicates");
  }
  const queuePrefix = options.queuePrefix?.trim() ?? defaults.queuePrefix;
  if (queuePrefix.length === 0) throw new RangeError("queuePrefix must not be empty");

  return {
    jobCount: positiveInteger("jobCount", options.jobCount ?? defaults.jobCount),
    heartbeatCount: positiveInteger(
      "heartbeatCount",
      options.heartbeatCount ?? defaults.heartbeatCount,
    ),
    batchSize: positiveInteger("batchSize", options.batchSize ?? defaults.batchSize),
    scheduleDelayMs: positiveInteger(
      "scheduleDelayMs",
      options.scheduleDelayMs ?? defaults.scheduleDelayMs,
    ),
    leaseMs: positiveInteger("leaseMs", options.leaseMs ?? defaults.leaseMs),
    retryDelayMs: positiveInteger("retryDelayMs", options.retryDelayMs ?? defaults.retryDelayMs),
    pruneLimit: positiveInteger("pruneLimit", options.pruneLimit ?? defaults.pruneLimit),
    queuePrefix,
    scenarios: operationalScenarioNames.filter((name) => requested.includes(name)),
  };
}

export function percentile(samples: readonly number[], percentileValue: number): number | null {
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 1) {
    throw new RangeError("percentile must be between 0 and 1");
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  const sorted = [...samples].filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index]!;
}

export function mean(samples: readonly number[]): number | null {
  const finite = samples.filter(Number.isFinite);
  if (finite.length === 0) return null;
  return finite.reduce((total, value) => total + value, 0) / finite.length;
}

export function pollingClaimUpperBound(
  jobCount: number,
  durationMs: number,
  pollMs: number,
  schedulingSlack = 2,
): number {
  return jobCount + Math.ceil(durationMs / pollMs) + schedulingSlack;
}

function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, nested) =>
      nested !== null && typeof nested === "object" && !Array.isArray(nested)
        ? Object.fromEntries(
            // oxlint-disable-next-line unicorn/no-array-sort -- Object.entries returns a fresh array.
            Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : nested,
    ) ?? "undefined"
  );
}

function jsonEquivalent(actual: unknown, expected: unknown): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

export function recordInvariant(
  assertions: ScenarioAssertion[],
  name: string,
  actual: unknown,
  expected: unknown,
  passes: (actual: unknown, expected: unknown) => boolean = Object.is,
): void {
  const passed = passes(actual, expected);
  assertions.push({ name, passed, expected, actual });
  if (!passed) {
    throw new Error(
      `Operational scenario invariant failed: ${name}. Expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

function queueName(prefix: string, name: OperationalScenarioName): string {
  return `${prefix}-${name}`;
}

async function reset(pool: Queryable): Promise<void> {
  await pool.query(resetWorkhorseStateSql);
}

async function measured<T>(now: () => number, operation: () => Promise<T>): Promise<[T, number]> {
  const started = now();
  const result = await operation();
  return [result, Math.max(0, now() - started)];
}

async function rowCount(pool: Queryable, relation: string, jobId?: string): Promise<number> {
  const where = jobId === undefined ? "" : " WHERE job_id = $1";
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM workhorse.${relation}${where}`,
    jobId === undefined ? [] : [jobId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

interface QueryPressureSnapshot {
  queries: number;
  claimCalls: number;
  heartbeatCalls: number;
  maxConcurrentQueries: number;
  maxConcurrentClaims: number;
  claimsWithoutFreeSlot: number;
}

class QueryPressureProbe implements Queryable {
  private activeQueries = 0;
  private activeClaims = 0;
  private queries = 0;
  private claimCalls = 0;
  private heartbeatCalls = 0;
  private maxConcurrentQueries = 0;
  private maxConcurrentClaims = 0;
  private claimsWithoutFreeSlot = 0;

  constructor(
    private readonly target: Queryable,
    private readonly freeClaimSlots?: () => number,
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const claim = text.includes("workhorse.claim_v1");
    this.queries += 1;
    this.activeQueries += 1;
    this.maxConcurrentQueries = Math.max(this.maxConcurrentQueries, this.activeQueries);
    if (claim) {
      this.claimCalls += 1;
      this.activeClaims += 1;
      this.maxConcurrentClaims = Math.max(this.maxConcurrentClaims, this.activeClaims);
      if (this.freeClaimSlots !== undefined && this.freeClaimSlots() < 1) {
        this.claimsWithoutFreeSlot += 1;
      }
    }
    if (text.includes("workhorse.heartbeat_v1") || text.includes("workhorse.heartbeat_v2")) {
      this.heartbeatCalls += 1;
    }
    try {
      return await this.target.query<R>(text, values);
    } finally {
      this.activeQueries -= 1;
      if (claim) this.activeClaims -= 1;
    }
  }

  snapshot(): QueryPressureSnapshot {
    return {
      queries: this.queries,
      claimCalls: this.claimCalls,
      heartbeatCalls: this.heartbeatCalls,
      maxConcurrentQueries: this.maxConcurrentQueries,
      maxConcurrentClaims: this.maxConcurrentClaims,
      claimsWithoutFreeSlot: this.claimsWithoutFreeSlot,
    };
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(1);
  }
}

async function scheduledPromotionDrift(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const runAt = new Date(Date.now() + context.options.scheduleDelayMs);
  for (let index = 0; index < context.options.jobCount; index += 1) {
    await queue.enqueue("scheduled-drift", { index }, { runAt });
  }
  const seeded = await queue.health();
  recordInvariant(
    assertions,
    "all jobs seeded as scheduled",
    seeded.scheduledDepth,
    context.options.jobCount,
  );

  await context.sleep(context.options.scheduleDelayMs + 5);
  let promoted = 0;
  let promotionBatches = 0;
  while (promoted < context.options.jobCount) {
    const count = await queue.promote(context.options.batchSize);
    promotionBatches += 1;
    promoted += count;
    if (count === 0) break;
  }
  const driftRows = await context.pool.query<{ drift_ms: number }>(
    `SELECT extract(epoch FROM (r.ready_at - r.run_at)) * 1000 AS drift_ms
       FROM workhorse.job_runtime r
      WHERE r.queue_name = $1 AND r.state = 'ready' ORDER BY r.sequence`,
    [context.queueName],
  );
  const drifts = driftRows.rows.map((row) => Math.max(0, Number(row.drift_ms)));
  const health = await queue.health();
  recordInvariant(assertions, "all due jobs promoted", promoted, context.options.jobCount);
  recordInvariant(assertions, "scheduled backlog drained", health.scheduledDepth, 0);
  recordInvariant(
    assertions,
    "ready depth equals seed",
    health.readyDepth,
    context.options.jobCount,
  );
  recordInvariant(
    assertions,
    "promotion remained bounded",
    promotionBatches,
    Math.ceil(context.options.jobCount / context.options.batchSize),
    (actual, expected) => Number(actual) <= Number(expected),
  );

  return {
    name: "scheduled-promotion-drift",
    durationMs: 0,
    metrics: {
      jobs: context.options.jobCount,
      promotionBatches,
      promoted,
      driftP50Ms: percentile(drifts, 0.5),
      driftP95Ms: percentile(drifts, 0.95),
      driftMaxMs: percentile(drifts, 1),
    },
    assertions,
  };
}

async function heartbeatFencing(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const acceptedLatencies: number[] = [];
  const staleLatencies: number[] = [];
  let accepted = 0;
  let staleRejected = 0;

  for (let index = 0; index < context.options.heartbeatCount; index += 1) {
    await queue.enqueue("heartbeat", { index });
    const job = await queue.claim(`heartbeat-worker-${index}`, {
      leaseMs: context.options.leaseMs * 4,
    });
    recordInvariant(assertions, `heartbeat job ${index} claimed`, job !== null, true);
    const [currentAccepted, acceptedMs] = await measured(context.now, () =>
      queue.heartbeat(job!, `heartbeat-worker-${index}`, context.options.leaseMs * 4),
    );
    const staleJob = { ...job!, fenceToken: job!.fenceToken + 1n };
    const [staleAccepted, staleMs] = await measured(context.now, () =>
      queue.heartbeat(staleJob, `heartbeat-worker-${index}`, context.options.leaseMs * 4),
    );
    acceptedLatencies.push(acceptedMs);
    staleLatencies.push(staleMs);
    if (currentAccepted) accepted += 1;
    if (!staleAccepted) staleRejected += 1;
    recordInvariant(assertions, `current heartbeat ${index} accepted`, currentAccepted, true);
    recordInvariant(assertions, `stale heartbeat ${index} rejected`, staleAccepted, false);
    recordInvariant(
      assertions,
      `heartbeat job ${index} completed`,
      await queue.complete(job!, `heartbeat-worker-${index}`, { ok: true }),
      true,
    );
  }

  const acceptedMean = mean(acceptedLatencies);
  const staleMean = mean(staleLatencies);
  return {
    name: "heartbeat-fencing",
    durationMs: 0,
    metrics: {
      jobs: context.options.heartbeatCount,
      accepted,
      staleRejected,
      acceptedMeanMs: acceptedMean,
      staleMeanMs: staleMean,
      staleOverheadMs:
        acceptedMean === null || staleMean === null ? null : staleMean - acceptedMean,
    },
    assertions,
  };
}

async function cancellationLifecycle(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const metrics: Record<string, ScenarioMetric> = {};
  const request = { requestedBy: "benchmark-operator", reason: "deterministic lifecycle proof" };

  const readyJobId = await queue.enqueue("cancel-ready", {});
  const [readyCancel, readyCancelMs] = await measured(context.now, () =>
    queue.cancel(readyJobId, request),
  );
  metrics.readyCancelMs = readyCancelMs;
  recordInvariant(assertions, "ready cancellation is immediate", readyCancel.status, "canceled");
  recordInvariant(
    assertions,
    "ready cancellation creates no attempt history",
    await rowCount(context.pool, "attempt_history", readyJobId),
    0,
  );

  const scheduledJobId = await queue.enqueue(
    "cancel-scheduled",
    {},
    { runAt: new Date(Date.now() + 60_000) },
  );
  const [scheduledCancel, scheduledCancelMs] = await measured(context.now, () =>
    queue.cancel(scheduledJobId, request),
  );
  metrics.scheduledCancelMs = scheduledCancelMs;
  recordInvariant(
    assertions,
    "scheduled cancellation is immediate",
    scheduledCancel.status,
    "canceled",
  );
  recordInvariant(
    assertions,
    "scheduled cancellation creates no attempt history",
    await rowCount(context.pool, "attempt_history", scheduledJobId),
    0,
  );

  const waitingJobId = await queue.enqueue("cancel-waiting", {});
  const waitingClaim = await queue.claim("waiting-worker", { leaseMs: 1_000 });
  recordInvariant(assertions, "waiting seed claimed", waitingClaim?.id, waitingJobId);
  const wait = await queue.scheduleWait(waitingClaim!, "waiting-worker", "benchmark-wait", {
    durationMs: 60_000,
  });
  recordInvariant(assertions, "waiting seed suspended", wait.status, "scheduled");
  const [waitingCancel, waitingCancelMs] = await measured(context.now, () =>
    queue.cancel(waitingJobId, request),
  );
  metrics.waitingCancelMs = waitingCancelMs;
  recordInvariant(
    assertions,
    "waiting cancellation is immediate",
    waitingCancel.status,
    "canceled",
  );
  recordInvariant(
    assertions,
    "waiting cancellation closes its started logical attempt",
    await rowCount(context.pool, "attempt_history", waitingJobId),
    1,
  );

  let activeJob: ClaimedJob | undefined;
  let observedSignal: AbortSignal | undefined;
  let handlerStartedResolve!: () => void;
  const handlerStarted = new Promise<void>((resolve) => {
    handlerStartedResolve = resolve;
  });
  const activeWorker = new Worker(queue, {
    queue: context.queueName,
    workerId: "cancel-active-worker",
    leaseMs: Math.max(200, context.options.leaseMs * 4),
    heartbeatMs: 20,
    pollMs: 1,
  }).handle("cancel-active", async (_payload, handlerContext) => {
    activeJob = handlerContext.job;
    observedSignal = handlerContext.signal;
    handlerStartedResolve();
    if (!handlerContext.signal.aborted) {
      await new Promise<void>((resolve) =>
        handlerContext.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    throw handlerContext.signal.reason;
  });
  const activeJobId = await queue.enqueue("cancel-active", {});
  const activeExecution = activeWorker.runOnce();
  await handlerStarted;
  const [activeRequest, activeRequestMs] = await measured(context.now, () =>
    queue.cancel(activeJobId, request),
  );
  const [activeRepeat, activeRepeatRequestMs] = await measured(context.now, () =>
    queue.cancel(activeJobId, { requestedBy: "ignored-repeat", reason: "ignored-repeat" }),
  );
  metrics.activeRequestMs = activeRequestMs;
  metrics.activeRepeatRequestMs = activeRepeatRequestMs;
  recordInvariant(
    assertions,
    "active cancellation becomes a request",
    activeRequest.status,
    "cancel_requested",
  );
  recordInvariant(
    assertions,
    "repeated active request remains requested",
    activeRepeat.status,
    "cancel_requested",
  );
  recordInvariant(
    assertions,
    "first active request owns attribution",
    activeRepeat.requestedBy,
    request.requestedBy,
  );
  recordInvariant(
    assertions,
    "wrong fence cannot acknowledge cancellation",
    await queue.acknowledgeCancel(
      { ...activeJob!, fenceToken: activeJob!.fenceToken + 1n },
      "cancel-active-worker",
    ),
    false,
  );
  const acknowledgeStarted = context.now();
  await activeExecution;
  metrics.activeAcknowledgeMs = Math.max(0, context.now() - acknowledgeStarted);
  recordInvariant(assertions, "handler AbortSignal was delivered", observedSignal?.aborted, true);
  recordInvariant(
    assertions,
    "handler AbortSignal carries cancellation reason",
    observedSignal?.reason instanceof CancellationRequestedError,
    true,
  );
  recordInvariant(
    assertions,
    "exact fence materializes canceled",
    (await queue.getJob(activeJobId))?.state,
    "canceled",
  );
  recordInvariant(
    assertions,
    "active cancellation records one attempt",
    await rowCount(context.pool, "attempt_history", activeJobId),
    1,
  );
  recordInvariant(
    assertions,
    "stale completion cannot overwrite cancellation",
    await queue.complete(activeJob!, "cancel-active-worker", { stale: true }),
    false,
  );
  recordInvariant(
    assertions,
    "stale failure cannot overwrite cancellation",
    await queue.fail(activeJob!, "cancel-active-worker", new Error("stale"), 0),
    "stale",
  );
  recordInvariant(
    assertions,
    "stale heartbeat status cannot overwrite cancellation",
    await queue.heartbeatStatus(activeJob!, "cancel-active-worker", 200),
    "stale",
  );
  recordInvariant(
    assertions,
    "heartbeat_v1 compatibility rejects canceled ownership",
    await queue.heartbeat(activeJob!, "cancel-active-worker", 200),
    false,
  );

  const ignoredJobId = await queue.enqueue("cancel-ignored", {}, { maxAttempts: 3 });
  const ignoredClaim = await queue.claim("cancel-ignored-worker", {
    leaseMs: Math.max(100, context.options.leaseMs),
  });
  recordInvariant(assertions, "ignored-signal seed claimed", ignoredClaim?.id, ignoredJobId);
  const [ignoredRequest, ignoredRequestMs] = await measured(context.now, () =>
    queue.cancel(ignoredJobId, request),
  );
  metrics.ignoredRequestMs = ignoredRequestMs;
  recordInvariant(
    assertions,
    "ignored signal remains requested while leased",
    ignoredRequest.status,
    "cancel_requested",
  );
  await context.sleep(Math.max(100, context.options.leaseMs) + 5);
  const [expiredMaterialized, expiryMaterializationMs] = await measured(context.now, () =>
    queue.recoverExpired(context.options.batchSize),
  );
  metrics.expiryMaterializationMs = expiryMaterializationMs;
  recordInvariant(assertions, "expiry materializes requested cancellation", expiredMaterialized, 1);
  recordInvariant(
    assertions,
    "expired request becomes canceled",
    (await queue.getJob(ignoredJobId))?.state,
    "canceled",
  );
  recordInvariant(
    assertions,
    "expired requested lease does not create a retry attempt",
    (await queue.getJob(ignoredJobId))?.currentAttempt,
    1,
  );
  recordInvariant(
    assertions,
    "expired requested lease closes one canceled attempt",
    await rowCount(context.pool, "attempt_history", ignoredJobId),
    1,
  );

  const [terminalReplay, terminalReplayMs] = await measured(context.now, () =>
    queue.cancel(activeJobId, { requestedBy: "ignored-terminal-repeat" }),
  );
  metrics.terminalReplayMs = terminalReplayMs;
  recordInvariant(
    assertions,
    "terminal cancellation replay is idempotent",
    terminalReplay.status,
    "canceled",
  );
  const [activeEventRows, eventQueryMs] = await measured(context.now, () =>
    context.pool.query<{ event_type: string; count: string }>(
      `SELECT event_type, count(*)::text AS count
         FROM workhorse.job_event
        WHERE job_id = $1 AND event_type IN ('cancel_requested', 'canceled')
        GROUP BY event_type ORDER BY event_type`,
      [activeJobId],
    ),
  );
  metrics.eventQueryMs = eventQueryMs;
  const activeEventCounts = Object.fromEntries(
    activeEventRows.rows.map((row) => [row.event_type, Number(row.count)]),
  );
  recordInvariant(
    assertions,
    "repeated requests emit one request event",
    activeEventCounts.cancel_requested,
    1,
  );
  recordInvariant(
    assertions,
    "repeated requests emit one terminal event",
    activeEventCounts.canceled,
    1,
  );
  recordInvariant(
    assertions,
    "repeated requests retain one terminal outcome",
    await rowCount(context.pool, "job_outcome", activeJobId),
    1,
  );

  const completionWinsId = await queue.enqueue("cancel-race-complete", {});
  const completionWinsClaim = await queue.claim("cancel-race-complete-worker", { leaseMs: 1_000 });
  recordInvariant(
    assertions,
    "completion race seed claimed",
    completionWinsClaim?.id,
    completionWinsId,
  );
  recordInvariant(
    assertions,
    "completion can commit before cancellation",
    await queue.complete(completionWinsClaim!, "cancel-race-complete-worker", {
      winner: "complete",
    }),
    true,
  );
  const completionLostCancel = await queue.cancel(completionWinsId, request);
  recordInvariant(
    assertions,
    "cancellation observes committed success",
    completionLostCancel.status,
    "already_terminal",
  );
  recordInvariant(assertions, "success remains immutable", completionLostCancel.state, "succeeded");

  const failureWinsId = await queue.enqueue("cancel-race-fail", {}, { maxAttempts: 1 });
  const failureWinsClaim = await queue.claim("cancel-race-fail-worker", { leaseMs: 1_000 });
  recordInvariant(assertions, "failure race seed claimed", failureWinsClaim?.id, failureWinsId);
  recordInvariant(
    assertions,
    "failure can commit before cancellation",
    await queue.fail(failureWinsClaim!, "cancel-race-fail-worker", new Error("winner")),
    "failed",
  );
  const failureLostCancel = await queue.cancel(failureWinsId, request);
  recordInvariant(
    assertions,
    "cancellation observes committed failure",
    failureLostCancel.status,
    "already_terminal",
  );
  recordInvariant(assertions, "failure remains immutable", failureLostCancel.state, "failed");

  const scheduleNamespace = `${context.queueName}-namespace`;
  await queue.syncSchedules(scheduleNamespace, [
    {
      name: "cancel-one-occurrence",
      schedule: "* * * * *",
      job: { type: "recurring-cancel", payload: { source: "schedule" }, queue: context.queueName },
    },
  ]);
  const schedule = (await queue.schedules([scheduleNamespace]))[0]!;
  const occurrenceBase = Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
  const firstOccurrenceAt = new Date(occurrenceBase);
  const nextOccurrenceAt = new Date(occurrenceBase + 60_000);
  const firstOccurrenceId = await queue.fireSchedule(
    scheduleNamespace,
    schedule.name,
    schedule.revision,
    firstOccurrenceAt,
  );
  recordInvariant(assertions, "first recurring occurrence fired", firstOccurrenceId !== null, true);
  recordInvariant(
    assertions,
    "one recurring occurrence can be canceled",
    (await queue.cancel(firstOccurrenceId!, request)).status,
    "canceled",
  );
  const [nextOccurrenceId, recurringNextOccurrenceMs] = await measured(context.now, () =>
    queue.fireSchedule(scheduleNamespace, schedule.name, schedule.revision, nextOccurrenceAt),
  );
  metrics.recurringNextOccurrenceMs = recurringNextOccurrenceMs;
  recordInvariant(
    assertions,
    "next recurring occurrence still fires",
    nextOccurrenceId !== null,
    true,
  );
  recordInvariant(
    assertions,
    "next recurring occurrence is independent",
    nextOccurrenceId !== firstOccurrenceId,
    true,
  );
  recordInvariant(
    assertions,
    "next recurring occurrence remains ready",
    (await queue.getJob(nextOccurrenceId!))?.state,
    "ready",
  );
  const enabledSchedule = await context.pool.query<{ enabled: boolean }>(
    `SELECT enabled FROM workhorse.schedule_definition
      WHERE namespace = $1 AND schedule_name = $2`,
    [scheduleNamespace, schedule.name],
  );
  recordInvariant(
    assertions,
    "canceling an occurrence leaves schedule enabled",
    enabledSchedule.rows[0]?.enabled,
    true,
  );

  const [stateRows, stateQueryMs] = await measured(context.now, () =>
    context.pool.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text AS count
         FROM workhorse.job_outcome
        GROUP BY state ORDER BY state`,
    ),
  );
  metrics.stateQueryMs = stateQueryMs;
  metrics.canceledOutcomes = Number(
    stateRows.rows.find((row) => row.state === "canceled")?.count ?? 0,
  );
  metrics.jobsExercised = 9;

  return { name: "cancellation-lifecycle", durationMs: 0, metrics, assertions };
}

async function deadlineTimeoutLifecycle(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const metrics: Record<string, ScenarioMetric> = {};

  const readyDeadlineId = await queue.enqueue(
    "deadline-ready",
    {},
    { deadline: new Date(Date.now() + 60_000) },
  );
  await context.pool.query(
    `UPDATE workhorse.job SET deadline_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = $1`,
    [readyDeadlineId],
  );
  await context.pool.query(
    `UPDATE workhorse.job_runtime SET deadline_at = clock_timestamp() - interval '1 millisecond'
      WHERE job_id = $1`,
    [readyDeadlineId],
  );
  recordInvariant(
    assertions,
    "expired ready job cannot be newly claimed",
    await queue.claim("deadline-ready-worker"),
    null,
  );
  const [readyReaped, readyDeadlineReapMs] = await measured(context.now, () =>
    queue.recoverExpired(context.options.batchSize),
  );
  metrics.readyDeadlineReapMs = readyDeadlineReapMs;
  recordInvariant(assertions, "expired ready deadline is reaped", readyReaped, 1);
  recordInvariant(
    assertions,
    "never-started deadline becomes terminal failure",
    (await queue.getJob(readyDeadlineId))?.state,
    "failed",
  );
  recordInvariant(
    assertions,
    "never-started deadline invents no attempt history",
    await rowCount(context.pool, "attempt_history", readyDeadlineId),
    0,
  );

  let deadlineReason: unknown;
  let deadlineClaim: ClaimedJob | undefined;
  const deadlineWorkerId = "deadline-active-worker";
  const deadlineWorker = new Worker(queue, {
    queue: context.queueName,
    workerId: deadlineWorkerId,
    leaseMs: 500,
    heartbeatMs: 20,
    pollMs: 1,
  }).handle("deadline-active", async (_payload, handlerContext) => {
    deadlineClaim = handlerContext.job;
    if (!handlerContext.signal.aborted) {
      await new Promise<void>((resolve) =>
        handlerContext.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    deadlineReason = handlerContext.signal.reason;
    throw handlerContext.signal.reason;
  });
  const activeDeadlineId = await queue.enqueue(
    "deadline-active",
    {},
    { deadline: new Date(Date.now() + 60), maxAttempts: 3 },
  );
  const activeDeadlineStarted = context.now();
  await deadlineWorker.runOnce();
  metrics.activeDeadlineMs = Math.max(0, context.now() - activeDeadlineStarted);
  recordInvariant(
    assertions,
    "active deadline delivers distinct AbortSignal reason",
    deadlineReason instanceof DeadlineExceededError,
    true,
  );
  recordInvariant(
    assertions,
    "active deadline is terminal despite retry budget",
    (await queue.getJob(activeDeadlineId))?.state,
    "failed",
  );
  if (!deadlineClaim) throw new Error("deadline handler did not expose its claim");
  recordInvariant(
    assertions,
    "late completion after deadline terminalization is fenced",
    await queue.complete(deadlineClaim, deadlineWorkerId, { late: true }),
    false,
  );

  let timeoutReason: unknown;
  const timeoutWorker = new Worker(queue, {
    queue: context.queueName,
    workerId: "timeout-worker",
    leaseMs: 500,
    heartbeatMs: 20,
    pollMs: 1,
  }).handle("timeout-retry", async (_payload, handlerContext) => {
    if (handlerContext.job.attempt === 2) return { attempt: 2 };
    if (!handlerContext.signal.aborted) {
      await new Promise<void>((resolve) =>
        handlerContext.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    timeoutReason = handlerContext.signal.reason;
    throw handlerContext.signal.reason;
  });
  const timeoutId = await queue.enqueue(
    "timeout-retry",
    {},
    {
      executionTimeoutMs: 60,
      maxAttempts: 2,
      retryPolicy: { type: "fixed", delayMs: 0 },
    },
  );
  const timeoutStarted = context.now();
  await timeoutWorker.runOnce();
  metrics.timeoutRetryMs = Math.max(0, context.now() - timeoutStarted);
  recordInvariant(
    assertions,
    "execution timeout delivers distinct AbortSignal reason",
    timeoutReason instanceof ExecutionTimeoutError,
    true,
  );
  recordInvariant(
    assertions,
    "execution timeout uses remaining retry budget",
    (await queue.getJob(timeoutId))?.currentAttempt,
    2,
  );
  await timeoutWorker.runOnce();
  recordInvariant(
    assertions,
    "retry after timeout can succeed",
    (await queue.getJob(timeoutId))?.state,
    "succeeded",
  );
  const timeoutHistory = await context.pool.query<{ outcome: string }>(
    `SELECT outcome FROM workhorse.attempt_history WHERE job_id = $1 ORDER BY attempt, attempt_id`,
    [timeoutId],
  );
  recordInvariant(
    assertions,
    "timeout history remains distinct from lease expiry",
    timeoutHistory.rows.map((row) => row.outcome),
    ["timeout", "succeeded"],
    jsonEquivalent,
  );

  await queue.enqueue(
    "deadline-health",
    {},
    {
      runAt: new Date(Date.now() + 120_000),
      deadline: new Date(Date.now() + 30_000),
    },
  );
  const healthTimeoutId = await queue.enqueue("timeout-health", {}, { executionTimeoutMs: 60_000 });
  await queue.claim("timeout-health-worker", { leaseMs: 120_000 });
  const health = await queue.health();
  metrics.pendingDeadlines = health.deadlinePressure.pending;
  metrics.overdueDeadlines = health.deadlinePressure.overdue;
  metrics.activeExecutionTimeouts = health.activeExecutionTimeouts;
  recordInvariant(
    assertions,
    "health reports pending deadline pressure",
    health.deadlinePressure.pending >= 1,
    true,
  );
  recordInvariant(
    assertions,
    "health reports active execution timeout",
    health.activeExecutionTimeouts >= 1,
    true,
  );
  recordInvariant(
    assertions,
    "health timeout seed remains active",
    (await queue.getJob(healthTimeoutId))?.state,
    "active",
  );

  return { name: "deadline-timeout-lifecycle", durationMs: 0, metrics, assertions };
}

async function deadLetterRedriveLifecycle(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const metrics: Record<string, ScenarioMetric> = {};
  const sourceIds: string[] = [];

  for (let index = 0; index < 3; index += 1) {
    const sourceId = await queue.enqueue(
      "redrive-source",
      { index },
      {
        deadline: new Date(Date.now() + 60_000),
        executionTimeoutMs: 5_000,
        maxAttempts: 1,
        tags: ["redrive", "operational"],
      },
    );
    const workerId = `redrive-source-worker-${index}`;
    const claimed = await queue.claim(workerId);
    if (!claimed) throw new Error("redrive scenario could not claim its source job");
    await queue.fail(claimed, workerId, new Error(`terminal source ${index}`));
    sourceIds.push(sourceId);
  }

  const [firstPage, listMs] = await measured(context.now, () =>
    queue.listDeadLetters({
      queue: context.queueName,
      type: "redrive-source",
      tags: ["redrive"],
      errorName: "Error",
      limit: 2,
    }),
  );
  const secondPage = await queue.listDeadLetters({
    queue: context.queueName,
    type: "redrive-source",
    limit: 2,
    ...(firstPage.nextCursor === null ? {} : { cursor: firstPage.nextCursor }),
  });
  const listedIds = [...firstPage.items, ...secondPage.items].map((item) => item.jobId);
  metrics.deadLetters = listedIds.length;
  metrics.listMs = listMs;
  recordInvariant(assertions, "failure cursor lists every source once", new Set(listedIds).size, 3);
  recordInvariant(
    assertions,
    "failure listing remains terminal-only",
    firstPage.items[0]?.error !== null,
    true,
  );

  const beforeDryRun = {
    jobs: await rowCount(context.pool, "job"),
    events: await rowCount(context.pool, "job_event"),
    lineage: await rowCount(context.pool, "job_redrive"),
  };
  const [previewPage, dryRunMs] = await measured(context.now, () =>
    queue.redriveMany(
      { queue: context.queueName, type: "redrive-source", tags: ["redrive"] },
      {
        requestedBy: "operational-scenario",
        reason: "preview failed operational sources",
        requestId: "dead-letter-preview",
      },
      { limit: 2, dryRun: true },
    ),
  );
  const preview = previewPage.results;
  const afterDryRun = {
    jobs: await rowCount(context.pool, "job"),
    events: await rowCount(context.pool, "job_event"),
    lineage: await rowCount(context.pool, "job_redrive"),
  };
  metrics.dryRunMs = dryRunMs;
  metrics.previewed = preview.length;
  recordInvariant(
    assertions,
    "dry-run reports only eligible rows",
    preview.map((result) => result.status),
    ["eligible", "eligible"],
    jsonEquivalent,
  );
  recordInvariant(
    assertions,
    "dry-run has no durable side effects",
    afterDryRun,
    beforeDryRun,
    jsonEquivalent,
  );

  const sourceJobId = firstPage.items[0]!.jobId;
  const request = {
    requestedBy: "operational-scenario",
    reason: "retry one inspected terminal failure",
    requestId: "dead-letter-single",
  };
  const [single, singleRedriveMs] = await measured(context.now, () =>
    queue.redrive(sourceJobId, request),
  );
  const [replay, replayMs] = await measured(context.now, () => queue.redrive(sourceJobId, request));
  metrics.singleRedriveMs = singleRedriveMs;
  metrics.replayMs = replayMs;
  recordInvariant(
    assertions,
    "single redrive creates a fresh ready target",
    single.status,
    "redriven",
  );
  recordInvariant(
    assertions,
    "exact replay returns the original target",
    replay.targetJobId,
    single.targetJobId,
  );
  recordInvariant(assertions, "exact replay is classified distinctly", replay.status, "replayed");

  const [bulkPage, bulkRedriveMs] = await measured(context.now, () =>
    queue.redriveMany(
      { queue: context.queueName, type: "redrive-source", errorName: "Error" },
      {
        requestedBy: "operational-scenario",
        reason: "retry a bounded terminal batch",
        requestId: "dead-letter-bulk",
      },
      { limit: 2 },
    ),
  );
  const bulk = bulkPage.results;
  const bulkContinuation =
    bulkPage.nextCursor === null
      ? { results: [], nextCursor: null }
      : await queue.redriveMany(
          { queue: context.queueName, type: "redrive-source", errorName: "Error" },
          {
            requestedBy: "operational-scenario",
            reason: "retry a bounded terminal batch",
            requestId: "dead-letter-bulk",
          },
          { limit: 2, cursor: bulkPage.nextCursor },
        );
  metrics.bulkRedriveMs = bulkRedriveMs;
  metrics.redriven =
    1 +
    [...bulk, ...bulkContinuation.results].filter((result) => result.status === "redriven").length;
  recordInvariant(assertions, "bulk redrive stays bounded", bulk.length, 2);
  recordInvariant(
    assertions,
    "bulk redrive creates ready targets",
    bulk.every((result) => result.status === "redriven" && result.targetState === "ready"),
    true,
  );
  recordInvariant(
    assertions,
    "bulk cursor advances through the remaining backlog",
    bulkContinuation.results.length,
    1,
  );
  recordInvariant(
    assertions,
    "bulk cursor ends only after the backlog page is complete",
    bulkContinuation.nextCursor,
    null,
  );

  const sourceOutcome = await context.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM workhorse.job_outcome
      WHERE job_id = ANY($1::uuid[]) AND state = 'failed'`,
    [sourceIds],
  );
  recordInvariant(
    assertions,
    "redrive leaves every source outcome immutable",
    Number(sourceOutcome.rows[0]?.count ?? 0),
    3,
  );
  const targets = await context.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM workhorse.job_redrive edge
       JOIN workhorse.job target ON target.id = edge.target_job_id
       JOIN workhorse.job_runtime runtime ON runtime.job_id = target.id
      WHERE runtime.state = 'ready' AND target.deadline_at IS NULL
        AND target.execution_timeout_ms = 5000`,
  );
  recordInvariant(
    assertions,
    "fresh targets are ready, retain timeout, and clear absolute deadline",
    Number(targets.rows[0]?.count ?? 0),
    4,
  );
  const lineage = await queue.getRedriveLineage(sourceJobId);
  metrics.lineageEdges = await rowCount(context.pool, "job_redrive");
  recordInvariant(
    assertions,
    "lineage query retains the inspected source",
    lineage.records.length >= 1,
    true,
  );
  recordInvariant(assertions, "small lineage is complete", lineage.truncated, false);
  recordInvariant(assertions, "one edge exists for each created target", metrics.lineageEdges, 4);

  return { name: "dead-letter-redrive-lifecycle", durationMs: 0, metrics, assertions };
}

async function queryListingLifecycle(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const metrics: Record<string, ScenarioMetric> = {};
  const ids = await queue.enqueueMany([
    {
      type: "query-listing-a",
      payload: { public: "alpha", secret: "redact-alpha" },
      options: { queue: context.queueName, tags: ["query", "alpha"] },
    },
    {
      type: "query-listing-b",
      payload: { public: "beta", secret: "redact-beta" },
      options: { queue: context.queueName, tags: ["query", "beta"] },
    },
    {
      type: "query-listing-a",
      payload: { public: "gamma", secret: "redact-gamma" },
      options: { queue: context.queueName, tags: ["query", "gamma"] },
    },
    {
      type: "query-listing-b",
      payload: { public: "delta", secret: "redact-delta" },
      options: { queue: context.queueName, tags: ["query", "delta"] },
    },
  ]);
  const completed = await queue.claim("query-listing-complete", { queue: context.queueName });
  if (!completed) throw new Error("query listing scenario could not claim its completed job");
  await queue.complete(completed, "query-listing-complete", { ok: true });
  const active = await queue.claim("query-listing-active", { queue: context.queueName });
  if (!active) throw new Error("query listing scenario could not claim its active job");

  const projectionBeforeHeartbeat = await context.pool.query<{ updated_at: Date }>(
    "SELECT updated_at FROM workhorse.job_query WHERE job_id = $1",
    [active.id],
  );
  await queue.heartbeat(active, "query-listing-active", 30_000);
  const projectionAfterHeartbeat = await context.pool.query<{ updated_at: Date }>(
    "SELECT updated_at FROM workhorse.job_query WHERE job_id = $1",
    [active.id],
  );
  recordInvariant(
    assertions,
    "heartbeat leaves operator projection timestamp unchanged",
    projectionAfterHeartbeat.rows[0]?.updated_at.getTime(),
    projectionBeforeHeartbeat.rows[0]?.updated_at.getTime(),
  );

  const [firstPage, listMs] = await measured(context.now, () =>
    queue.listJobs({ queue: context.queueName, limit: 2 }),
  );
  const secondPage =
    firstPage.nextCursor === null
      ? { items: [], nextCursor: null }
      : await queue.listJobs({
          queue: context.queueName,
          limit: 2,
          cursor: firstPage.nextCursor,
        });
  const listed = [...firstPage.items, ...secondPage.items];
  metrics.listMs = listMs;
  metrics.listedJobs = listed.length;
  recordInvariant(assertions, "cross-state cursor lists every job once", listed.length, ids.length);
  recordInvariant(
    assertions,
    "cross-state cursor contains no duplicates",
    new Set(listed.map((job) => job.id)).size,
    ids.length,
  );
  recordInvariant(
    assertions,
    "default listing omits every payload",
    listed.every((job) => job.payload === null && job.payloadStatus === "omitted"),
    true,
  );
  recordInvariant(assertions, "final page has no continuation cursor", secondPage.nextCursor, null);

  const createdTimes = listed.map((job) => job.createdAt.getTime());
  const [projected, payloadProjectionMs] = await measured(context.now, () =>
    queue.listJobs({
      queue: context.queueName,
      type: "query-listing-a",
      states: ["ready", "succeeded"],
      createdAfter: new Date(Math.min(...createdTimes) - 1),
      createdBefore: new Date(Math.max(...createdTimes) + 1),
      payload: { include: true, maxBytes: 1_024, redactKeys: ["secret"] },
    }),
  );
  metrics.payloadProjectionMs = payloadProjectionMs;
  recordInvariant(assertions, "combined filters select two jobs", projected.items.length, 2);
  recordInvariant(
    assertions,
    "redaction occurs before bounded payload return",
    projected.items.every(
      (job) =>
        job.payloadStatus === "included" &&
        job.payload !== null &&
        typeof job.payload === "object" &&
        !Array.isArray(job.payload) &&
        !("secret" in job.payload),
    ),
    true,
  );

  const [timeline, timelineMs] = await measured(context.now, () =>
    queue.getJobTimeline(completed.id, { limit: 100 }),
  );
  metrics.timelineMs = timelineMs;
  metrics.timelineEntries = timeline.items.length;
  recordInvariant(
    assertions,
    "timeline contains lifecycle events and the closed attempt",
    new Set(timeline.items.map((entry) => entry.kind)),
    new Set(["event", "attempt"]),
    (actual, expected) =>
      actual instanceof Set &&
      expected instanceof Set &&
      [...expected].every((value) => actual.has(value)),
  );
  recordInvariant(assertions, "small retained timeline is complete", timeline.nextCursor, null);

  metrics.projectionRows = await rowCount(context.pool, "job_query");
  recordInvariant(
    assertions,
    "projection has one row per identity",
    metrics.projectionRows,
    ids.length,
  );
  const indexStorage = await context.pool.query<{ bytes: string }>(`
    SELECT COALESCE(sum(pg_relation_size(indexrelid)), 0)::text AS bytes
      FROM pg_index
     WHERE indrelid = 'workhorse.job_query'::regclass`);
  metrics.operatorIndexBytes = Number(indexStorage.rows[0]?.bytes ?? 0);
  recordInvariant(
    assertions,
    "operator indexes have independently measurable storage",
    Number(metrics.operatorIndexBytes) > 0,
    true,
  );

  return { name: "query-listing-lifecycle", durationMs: 0, metrics, assertions };
}

async function crashBeforeCompletion(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const boundaries: readonly {
    failpoint: Failpoint;
    expectedHandlerRuns: number;
    expectedState: "active" | "succeeded";
    expectedLeases: number;
    expectedAttemptHistory: number;
  }[] = [
    {
      failpoint: "afterClaim",
      expectedHandlerRuns: 0,
      expectedState: "active",
      expectedLeases: 1,
      expectedAttemptHistory: 0,
    },
    {
      failpoint: "beforeHandler",
      expectedHandlerRuns: 0,
      expectedState: "active",
      expectedLeases: 1,
      expectedAttemptHistory: 0,
    },
    {
      failpoint: "afterHandler",
      expectedHandlerRuns: 1,
      expectedState: "active",
      expectedLeases: 1,
      expectedAttemptHistory: 0,
    },
    {
      failpoint: "beforeComplete",
      expectedHandlerRuns: 1,
      expectedState: "active",
      expectedLeases: 1,
      expectedAttemptHistory: 0,
    },
    {
      failpoint: "afterComplete",
      expectedHandlerRuns: 1,
      expectedState: "succeeded",
      expectedLeases: 0,
      expectedAttemptHistory: 1,
    },
  ];
  let handlerRuns = 0;
  let activeCrashes = 0;
  let completedCrashes = 0;

  for (const boundary of boundaries) {
    const jobId = await queue.enqueue(
      "crash",
      { failpoint: boundary.failpoint },
      { maxAttempts: 2 },
    );
    let boundaryHandlerRuns = 0;
    const worker = new Worker(queue, {
      queue: context.queueName,
      workerId: `crash-${boundary.failpoint}`,
      leaseMs: context.options.leaseMs,
      heartbeatMs: Math.max(1, Math.floor(context.options.leaseMs / 2)),
      pollMs: 1,
      failpoint: boundary.failpoint,
    }).handle("crash", () => {
      handlerRuns += 1;
      boundaryHandlerRuns += 1;
      return { ok: true };
    });

    let crash: unknown;
    try {
      await worker.runOnce();
    } catch (error) {
      crash = error;
    }
    const snapshot = await queue.getJob(jobId);
    const leases = await rowCount(context.pool, "job_runtime", jobId);
    const attemptHistoryRows = await rowCount(context.pool, "attempt_history", jobId);
    recordInvariant(
      assertions,
      `${boundary.failpoint} crash was injected`,
      crash instanceof InjectedCrashError && crash.failpoint === boundary.failpoint,
      true,
    );
    recordInvariant(
      assertions,
      `${boundary.failpoint} handler runs`,
      boundaryHandlerRuns,
      boundary.expectedHandlerRuns,
    );
    recordInvariant(
      assertions,
      `${boundary.failpoint} durable state`,
      snapshot?.state,
      boundary.expectedState,
    );
    recordInvariant(
      assertions,
      `${boundary.failpoint} durable leases`,
      leases,
      boundary.expectedLeases,
    );
    recordInvariant(
      assertions,
      `${boundary.failpoint} attempt history`,
      attemptHistoryRows,
      boundary.expectedAttemptHistory,
    );
    if (boundary.expectedState === "active") activeCrashes += 1;
    else completedCrashes += 1;
  }

  return {
    name: "crash-before-completion",
    durationMs: 0,
    metrics: {
      boundaries: boundaries.length,
      handlerRuns,
      activeCrashes,
      completedCrashes,
    },
    assertions,
  };
}

async function leaseExpiryRecovery(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const jobId = await queue.enqueue("recover", {}, { maxAttempts: 2 });
  const first = await queue.claim("expired-worker", { leaseMs: context.options.leaseMs });
  recordInvariant(assertions, "first attempt claimed", first?.id, jobId);
  await context.sleep(context.options.leaseMs + 5);
  const [recovered, recoveryMs] = await measured(context.now, () =>
    queue.recoverExpired(context.options.batchSize),
  );
  const second = await queue.claim("recovery-worker", { leaseMs: context.options.leaseMs * 4 });
  recordInvariant(assertions, "one lease recovered", recovered, 1);
  recordInvariant(assertions, "recovery creates attempt two", second?.attempt, 2);
  recordInvariant(
    assertions,
    "recovery advances fence",
    (second?.fenceToken ?? 0n) > first!.fenceToken,
    true,
  );
  recordInvariant(
    assertions,
    "stale owner completion rejected",
    await queue.complete(first!, "expired-worker", { stale: true }),
    false,
  );
  recordInvariant(
    assertions,
    "recovered owner completion accepted",
    await queue.complete(second!, "recovery-worker", { ok: true }),
    true,
  );

  return {
    name: "lease-expiry-recovery",
    durationMs: 0,
    metrics: {
      recovered,
      firstAttempt: first!.attempt,
      secondAttempt: second!.attempt,
      fenceAdvance: Number(second!.fenceToken - first!.fenceToken),
      recoveryMs,
    },
    assertions,
  };
}

async function retryPaths(context: OperationalScenarioContext): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];

  type RetryEventRow = {
    retry_policy: unknown;
    retry_delay_ms: string;
    retry_delay_source: string;
  };

  const retryEvent = async (jobId: string): Promise<RetryEventRow> => {
    const result = await context.pool.query<RetryEventRow>(
      `SELECT details->'retry_policy' AS retry_policy,
              details->>'retry_delay_ms' AS retry_delay_ms,
              details->>'retry_delay_source' AS retry_delay_source
         FROM workhorse.job_event
        WHERE job_id = $1 AND event_type = 'retry_scheduled'
        ORDER BY event_id DESC
        LIMIT 1`,
      [jobId],
    );
    return result.rows[0]!;
  };

  const immediateId = await queue.enqueue("retry-immediate", {}, { maxAttempts: 2 });
  const immediateFirst = await queue.claim("retry-worker");
  recordInvariant(
    assertions,
    "immediate retry enters ready",
    await queue.fail(immediateFirst!, "retry-worker", new Error("retry now"), 0),
    "ready",
  );
  const immediateSecond = await queue.claim("retry-worker");
  recordInvariant(assertions, "immediate retry is attempt two", immediateSecond?.attempt, 2);
  recordInvariant(
    assertions,
    "immediate retry completes",
    await queue.complete(immediateSecond!, "retry-worker", { ok: true }),
    true,
  );

  const delayedId = await queue.enqueue("retry-delayed", {}, { maxAttempts: 2 });
  const delayedFirst = await queue.claim("retry-worker");
  recordInvariant(
    assertions,
    "delayed retry enters scheduled",
    await queue.fail(
      delayedFirst!,
      "retry-worker",
      new Error("retry later"),
      context.options.retryDelayMs,
    ),
    "scheduled",
  );
  recordInvariant(
    assertions,
    "delayed retry is not immediately claimable",
    await queue.claim("retry-worker"),
    null,
  );
  await context.sleep(context.options.retryDelayMs + 5);
  const delayedPromoted = await queue.promote(context.options.batchSize);
  const delayedSecond = await queue.claim("retry-worker");
  recordInvariant(assertions, "delayed retry promoted", delayedPromoted, 1);
  recordInvariant(assertions, "delayed retry is attempt two", delayedSecond?.attempt, 2);
  recordInvariant(
    assertions,
    "delayed retry completes",
    await queue.complete(delayedSecond!, "retry-worker", { ok: true }),
    true,
  );

  const fixedPolicy = { type: "fixed", delayMs: 1 } as const;
  const fixedId = await queue.enqueue(
    "retry-fixed",
    {},
    { maxAttempts: 2, retryPolicy: fixedPolicy },
  );
  const fixedFirst = await queue.claim("retry-worker");
  const [fixedState, fixedSelectionMs] = await measured(context.now, () =>
    queue.fail(fixedFirst!, "retry-worker", new Error("fixed policy")),
  );
  const fixedEvent = await retryEvent(fixedId);
  recordInvariant(assertions, "fixed policy schedules retry", fixedState, "scheduled");
  recordInvariant(assertions, "fixed policy delay selected", Number(fixedEvent.retry_delay_ms), 1);
  recordInvariant(
    assertions,
    "fixed policy source recorded",
    fixedEvent.retry_delay_source,
    "policy:fixed",
  );
  recordInvariant(
    assertions,
    "fixed policy provenance recorded",
    fixedEvent.retry_policy,
    fixedPolicy,
    jsonEquivalent,
  );

  const exponentialPolicy = {
    type: "exponential",
    initialDelayMs: 1,
    multiplier: 2,
    maxDelayMs: 4,
  } as const;
  const exponentialId = await queue.enqueue(
    "retry-exponential",
    {},
    {
      maxAttempts: 2,
      retryPolicy: exponentialPolicy,
    },
  );
  const exponentialFirst = await queue.claim("retry-worker");
  const [exponentialState, exponentialSelectionMs] = await measured(context.now, () =>
    queue.fail(exponentialFirst!, "retry-worker", new Error("exponential policy")),
  );
  const exponentialEvent = await retryEvent(exponentialId);
  recordInvariant(assertions, "exponential policy schedules retry", exponentialState, "scheduled");
  recordInvariant(
    assertions,
    "exponential policy delay selected",
    Number(exponentialEvent.retry_delay_ms),
    1,
  );
  recordInvariant(
    assertions,
    "exponential policy source recorded",
    exponentialEvent.retry_delay_source,
    "policy:exponential",
  );
  recordInvariant(
    assertions,
    "exponential policy provenance recorded",
    exponentialEvent.retry_policy,
    exponentialPolicy,
    jsonEquivalent,
  );

  const jitterPolicy = { type: "decorrelated-jitter", baseDelayMs: 1, maxDelayMs: 3 } as const;
  const jitterId = await queue.enqueue(
    "retry-jitter",
    {},
    {
      maxAttempts: 2,
      retryPolicy: jitterPolicy,
    },
  );
  const jitterFirst = await queue.claim("retry-worker");
  const [jitterState, jitterSelectionMs] = await measured(context.now, () =>
    queue.fail(jitterFirst!, "retry-worker", new Error("jitter policy")),
  );
  const jitterEvent = await retryEvent(jitterId);
  const jitterDelayMs = Number(jitterEvent.retry_delay_ms);
  const replayedJitter = await context.pool.query<{ delay_ms: string }>(
    `SELECT delay_ms
       FROM workhorse.retry_delay_v1($1, $2, $3::jsonb, $4, $5, $6)`,
    [jitterId, 1, JSON.stringify(jitterPolicy), null, null, "legacy-handler"],
  );
  const recreatedQueue = new Queue(context.pool, context.queueName);
  recordInvariant(assertions, "jitter policy schedules retry", jitterState, "scheduled");
  recordInvariant(
    assertions,
    "jitter policy delay is bounded",
    jitterDelayMs >= jitterPolicy.baseDelayMs && jitterDelayMs <= jitterPolicy.maxDelayMs,
    true,
  );
  recordInvariant(
    assertions,
    "jitter policy source recorded",
    jitterEvent.retry_delay_source,
    "policy:decorrelated-jitter",
  );
  recordInvariant(
    assertions,
    "jitter policy provenance recorded",
    jitterEvent.retry_policy,
    jitterPolicy,
    jsonEquivalent,
  );
  recordInvariant(
    assertions,
    "jitter replay selects the same delay",
    Number(replayedJitter.rows[0]!.delay_ms),
    jitterDelayMs,
  );
  recordInvariant(
    assertions,
    "queue recreation preserves persisted jitter policy",
    (await recreatedQueue.getJob(jitterId))?.retryPolicy,
    jitterPolicy,
    jsonEquivalent,
  );

  await context.sleep(8);
  const policyPromoted = await queue.promote(context.options.batchSize);
  recordInvariant(assertions, "all policy retries promote", policyPromoted, 3);
  for (const policyName of ["fixed", "exponential", "jitter"]) {
    const policyRetry = await queue.claim("retry-worker");
    recordInvariant(assertions, `${policyName} retry is attempt two`, policyRetry?.attempt, 2);
    recordInvariant(
      assertions,
      `${policyName} retry completes`,
      await queue.complete(policyRetry!, "retry-worker", { ok: true }),
      true,
    );
  }

  const exhaustedId = await queue.enqueue("retry-exhausted", {}, { maxAttempts: 1 });
  const exhausted = await queue.claim("retry-worker");
  recordInvariant(
    assertions,
    "attempt budget exhausts to failed",
    await queue.fail(exhausted!, "retry-worker", new Error("terminal")),
    "failed",
  );
  recordInvariant(
    assertions,
    "exhausted job snapshot is failed",
    (await queue.getJob(exhaustedId))?.state,
    "failed",
  );

  return {
    name: "retry-paths",
    durationMs: 0,
    metrics: {
      immediateAttempts: (await queue.getJob(immediateId))?.currentAttempt ?? null,
      delayedAttempts: (await queue.getJob(delayedId))?.currentAttempt ?? null,
      delayedPromoted,
      fixedDelayMs: Number(fixedEvent.retry_delay_ms),
      fixedSelectionMs,
      exponentialDelayMs: Number(exponentialEvent.retry_delay_ms),
      exponentialSelectionMs,
      jitterDelayMs,
      jitterSelectionMs,
      policySelectionTotalMs: fixedSelectionMs + exponentialSelectionMs + jitterSelectionMs,
      exhaustedAttempts: (await queue.getJob(exhaustedId))?.currentAttempt ?? null,
    },
    assertions,
  };
}

async function idempotentIngress(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const state = async () =>
    (
      await context.pool.query<{
        jobs: number;
        bindings: number;
        events: number;
        runtimes: number;
        sequence_last_value: string;
        sequence_is_called: boolean;
      }>(`SELECT
        (SELECT count(*)::integer FROM workhorse.job) AS jobs,
        (SELECT count(*)::integer FROM workhorse.enqueue_idempotency) AS bindings,
        (SELECT count(*)::integer FROM workhorse.job_event) AS events,
        (SELECT count(*)::integer FROM workhorse.job_runtime) AS runtimes,
        (SELECT last_value::text FROM workhorse.ready_sequence_seq) AS sequence_last_value,
        (SELECT is_called FROM workhorse.ready_sequence_seq) AS sequence_is_called`)
    ).rows[0]!;

  const firstOptions = {
    queue: context.queueName,
    maxAttempts: 3,
    retryPolicy: { type: "fixed" as const, delayMs: 25 },
    tags: ["ingress", "durable"],
    idempotency: { key: "exact-replay", scope: "benchmark", ttlMs: 60_000 },
  };
  const [firstId, firstAcceptMs] = await measured(context.now, () =>
    queue.enqueue("idempotent-ingress", { order: 1 }, firstOptions),
  );
  const afterFirst = await state();
  const [replayedId, exactReplayMs] = await measured(context.now, () =>
    queue.enqueue(
      "idempotent-ingress",
      { order: 1 },
      { ...firstOptions, tags: ["durable", "ingress"] },
    ),
  );
  const afterReplay = await state();
  recordInvariant(assertions, "exact replay returns original job", replayedId, firstId);
  recordInvariant(
    assertions,
    "exact replay adds no job, binding, event, runtime, or FIFO state",
    afterReplay,
    afterFirst,
    jsonEquivalent,
  );

  const beforeConflict = await state();
  const [conflict, conflictRollbackMs] = await measured(context.now, async () => {
    try {
      await queue.enqueueMany([
        {
          type: "idempotent-ingress",
          payload: { rollback: true },
          options: {
            queue: context.queueName,
            idempotency: { key: "rollback-candidate", scope: "benchmark", ttlMs: 60_000 },
          },
        },
        {
          type: "idempotent-ingress",
          payload: { order: 2 },
          options: firstOptions,
        },
      ]);
      return null;
    } catch (error) {
      return error;
    }
  });
  const afterConflict = await state();
  recordInvariant(
    assertions,
    "material mismatch returns typed conflict",
    conflict instanceof EnqueueIdempotencyConflictError,
    true,
  );
  recordInvariant(
    assertions,
    "conflict identifies retained job",
    conflict instanceof EnqueueIdempotencyConflictError ? conflict.existingJobId : null,
    firstId,
  );
  recordInvariant(
    assertions,
    "conflict identifies request ordinal",
    conflict instanceof EnqueueIdempotencyConflictError ? conflict.ordinal : null,
    2,
  );
  recordInvariant(
    assertions,
    "conflict rolls back whole batch",
    {
      jobs: afterConflict.jobs,
      bindings: afterConflict.bindings,
      events: afterConflict.events,
      runtimes: afterConflict.runtimes,
    },
    {
      jobs: beforeConflict.jobs,
      bindings: beforeConflict.bindings,
      events: beforeConflict.events,
      runtimes: beforeConflict.runtimes,
    },
    jsonEquivalent,
  );

  const [batchIds, batchDuplicatesMs] = await measured(context.now, () =>
    queue.enqueueMany([
      {
        type: "batch-keyed",
        payload: { stable: true },
        tags: ["beta", "alpha"],
        options: {
          queue: context.queueName,
          idempotency: { key: "batch-duplicate", scope: "benchmark", ttlMs: 60_000 },
        },
      },
      {
        type: "batch-keyed",
        payload: { stable: true },
        tags: ["alpha", "beta"],
        options: {
          queue: context.queueName,
          idempotency: { key: "batch-duplicate", scope: "benchmark", ttlMs: 60_000 },
        },
      },
      {
        type: "batch-unkeyed",
        payload: { stable: true },
        options: { queue: context.queueName },
      },
    ]),
  );
  recordInvariant(
    assertions,
    "batch duplicate preserves repeated result",
    batchIds[1],
    batchIds[0],
  );
  recordInvariant(
    assertions,
    "unkeyed batch request remains distinct",
    batchIds[2] === batchIds[0],
    false,
  );
  recordInvariant(assertions, "batch returns two unique jobs", new Set(batchIds).size, 2);

  const expiryOptions = {
    queue: context.queueName,
    idempotency: { key: "expiry-reuse", scope: "benchmark", ttlMs: 5 },
  };
  const [expiryFirstId, expiryFirstAcceptMs] = await measured(context.now, () =>
    queue.enqueue("expiry-reuse", { version: 1 }, expiryOptions),
  );
  await context.sleep(15);
  const [expiryReusedId, expiryReuseMs] = await measured(context.now, () =>
    queue.enqueue("expiry-reuse", { version: 2 }, expiryOptions),
  );
  recordInvariant(
    assertions,
    "expired binding permits a new identity",
    expiryReusedId === expiryFirstId,
    false,
  );
  const originalExpiryJob = await context.pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM workhorse.job WHERE id = $1",
    [expiryFirstId],
  );
  recordInvariant(
    assertions,
    "expired binding leaves original job intact",
    originalExpiryJob.rows[0]?.count,
    1,
  );
  const activeExpiryBinding = await context.pool.query<{ job_id: string }>(
    "SELECT job_id FROM workhorse.enqueue_idempotency WHERE job_id = $1",
    [expiryReusedId],
  );
  recordInvariant(
    assertions,
    "expiry reuse transfers scoped ownership",
    activeExpiryBinding.rows[0]?.job_id,
    expiryReusedId,
  );

  const finalState = await state();
  recordInvariant(assertions, "scenario accepted expected jobs", finalState.jobs, 5);
  recordInvariant(assertions, "scenario retained expected bindings", finalState.bindings, 3);
  recordInvariant(assertions, "scenario appended one event per accepted job", finalState.events, 5);
  recordInvariant(
    assertions,
    "scenario retained one runtime per accepted job",
    finalState.runtimes,
    5,
  );

  return {
    name: "idempotent-ingress",
    durationMs: 0,
    metrics: {
      firstAcceptMs,
      exactReplayMs,
      conflictRollbackMs,
      batchDuplicatesMs,
      expiryFirstAcceptMs,
      expiryReuseMs,
      jobs: finalState.jobs,
      bindings: finalState.bindings,
      events: finalState.events,
      runtimes: finalState.runtimes,
    },
    assertions,
  };
}

async function retentionPruning(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const seededJobs = Math.min(context.options.jobCount, context.options.pruneLimit, 10);
  for (let index = 0; index < seededJobs; index += 1) {
    await queue.enqueue("retention", { index });
    const job = await queue.claim(`retention-worker-${index}`);
    await queue.complete(job!, `retention-worker-${index}`, { ok: true });
  }
  const retiredDay = new Date();
  retiredDay.setUTCHours(12, 0, 0, 0);
  retiredDay.setUTCDate(retiredDay.getUTCDate() - 14);
  const retiredDayDate = retiredDay.toISOString().slice(0, 10);
  const historicalTimestamp = new Date(`${retiredDayDate}T12:00:00.000Z`);
  await context.pool.query(createHistoryDayV1Sql, [retiredDayDate]);
  await context.pool.query(
    `UPDATE workhorse.job_event e SET occurred_at = $1
      FROM workhorse.job j WHERE j.id = e.job_id AND j.queue_name = $2`,
    [historicalTimestamp, context.queueName],
  );
  await context.pool.query(
    `UPDATE workhorse.attempt_history h SET occurred_at = $1, finished_at = $1
      FROM workhorse.job j WHERE j.id = h.job_id AND j.queue_name = $2`,
    [historicalTimestamp, context.queueName],
  );
  const historyBefore =
    (await rowCount(context.pool, "job_event")) + (await rowCount(context.pool, "attempt_history"));
  await queue.syncRetentionPolicy({
    jobIdentityRetentionDays: null,
    terminalOutcomeRetentionDays: null,
    jobEventRetentionDays: 7,
    attemptHistoryRetentionDays: 7,
    scheduleOccurrenceRetentionDays: 30,
    terminalJobPruneLimit: context.options.pruneLimit,
    historyPartitionsPerPass: 2,
    defaultPartitionRowsPerPass: context.options.pruneLimit,
    occurrenceRowsPerPass: context.options.pruneLimit,
  });
  const historyRetention = await queue.retainHistory({ force: true });
  const historyAfter =
    (await rowCount(context.pool, "job_event")) + (await rowCount(context.pool, "attempt_history"));
  const pruned = historyBefore - historyAfter;
  const retainedJobs = await rowCount(context.pool, "job");
  const health = await queue.health();
  recordInvariant(assertions, "terminal history was seeded", historyBefore > 0, true);
  recordInvariant(
    assertions,
    "prune reports removed history",
    historyBefore - historyAfter,
    pruned,
  );
  recordInvariant(assertions, "old history was removed", historyAfter, 0);
  recordInvariant(assertions, "current job identity is retained", retainedJobs, seededJobs);
  recordInvariant(
    assertions,
    "event retention task ran",
    historyRetention.find((phase) => phase.phase === "event_retention")?.rowsAffected ?? 0,
    1,
  );
  recordInvariant(
    assertions,
    "attempt retention task ran",
    historyRetention.find((phase) => phase.phase === "attempt_retention")?.rowsAffected ?? 0,
    1,
  );
  recordInvariant(
    assertions,
    "retention health reports no expired event partitions",
    health.eligibleHistoryPartitions.jobEvents,
    0,
  );
  recordInvariant(
    assertions,
    "retention health reports no expired attempt partitions",
    health.eligibleHistoryPartitions.attemptHistory,
    0,
  );

  return {
    name: "retention-pruning",
    durationMs: 0,
    metrics: {
      seededJobs,
      historyBefore,
      pruned,
      historyAfter,
      retainedJobs,
      eventRetentionUnits:
        historyRetention.find((phase) => phase.phase === "event_retention")?.rowsAffected ?? 0,
      attemptRetentionUnits:
        historyRetention.find((phase) => phase.phase === "attempt_retention")?.rowsAffected ?? 0,
    },
    assertions,
  };
}

function assertHealthSnapshot(
  assertions: ScenarioAssertion[],
  health: QueueHealth,
  readyCount: number,
  scheduledCount: number,
): void {
  recordInvariant(assertions, "health ready depth", health.readyDepth, readyCount);
  recordInvariant(assertions, "health scheduled depth", health.scheduledDepth, scheduledCount);
  recordInvariant(assertions, "health active leases", health.activeLeases, 1);
  recordInvariant(assertions, "health expired leases", health.expiredLeases, 1);
  recordInvariant(assertions, "health snapshot is degraded", health.expiredLeases > 0, true);
  recordInvariant(assertions, "health active state count", health.counts.active, 1);
  recordInvariant(
    assertions,
    "health schema version is installed",
    (health.schemaVersion ?? 0) >= 1,
    true,
  );
}

async function healthSnapshot(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const readyCount = Math.max(1, Math.floor(context.options.jobCount / 2));
  const scheduledCount = Math.max(1, context.options.jobCount - readyCount);
  for (let index = 0; index < readyCount + 1; index += 1) {
    await queue.enqueue("health-ready", { index });
  }
  for (let index = 0; index < scheduledCount; index += 1) {
    await queue.enqueue("health-scheduled", { index }, { runAt: new Date(Date.now() + 60_000) });
  }
  const expired = await queue.claim("health-expired", { leaseMs: context.options.leaseMs * 4 });
  recordInvariant(assertions, "health expired seed claimed", expired !== null, true);
  await context.pool.query(
    `UPDATE workhorse.job_runtime
        SET expires_at = clock_timestamp() - interval '1 millisecond'
      WHERE job_id = $1 AND state = 'active'`,
    [expired!.id],
  );
  const [health, snapshotMs] = await measured(context.now, () => queue.health());
  assertHealthSnapshot(assertions, health, readyCount, scheduledCount);
  const degraded = health.expiredLeases > 0;
  const degradationReason = degraded ? "expired-leases" : null;

  return {
    name: "health-snapshot",
    durationMs: 0,
    metrics: {
      readyDepth: health.readyDepth,
      scheduledDepth: health.scheduledDepth,
      activeLeases: health.activeLeases,
      expiredLeases: health.expiredLeases,
      degraded,
      degradationReason,
      schemaVersion: health.schemaVersion,
      snapshotMs,
    },
    assertions,
  };
}

async function progressLifecycle(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = new Queue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const id = await queue.enqueue("progress-lifecycle", { source: "benchmark" });
  const job = await queue.claim("benchmark-progress", { leaseMs: 5_000 });
  if (!job) throw new Error("progress lifecycle failed to claim its seeded job");

  const [first, firstUpdateMs] = await measured(context.now, () =>
    queue.updateProgress(job, "benchmark-progress", { completed: 1, total: 2 }),
  );
  const [unchanged, unchangedUpdateMs] = await measured(context.now, () =>
    queue.updateProgress(job, "benchmark-progress", { completed: 1, total: 2 }),
  );

  const rateStarted = context.now();
  let rateLimited = false;
  try {
    await queue.updateProgress(job, "benchmark-progress", { completed: 2, total: 2 });
  } catch (error) {
    rateLimited = error instanceof ProgressRateLimitError;
    if (!rateLimited) throw error;
  }
  const rateLimitedUpdateMs = Math.max(0, context.now() - rateStarted);

  let staleRejected = false;
  try {
    await queue.updateProgress({ ...job, fenceToken: job.fenceToken + 1n }, "benchmark-progress", {
      invalid: true,
    });
  } catch (error) {
    staleRejected = error instanceof ProgressLeaseLostError;
    if (!staleRejected) throw error;
  }

  await context.sleep(110);
  const [second, secondUpdateMs] = await measured(context.now, () =>
    queue.updateProgress(job, "benchmark-progress", { completed: 2, total: 2 }),
  );
  const [snapshot, lookupMs] = await measured(context.now, () => queue.getJob(id));
  const completed = await queue.complete(job, "benchmark-progress", { ok: true });
  const terminal = await queue.getJob(id);
  const eventResult = await context.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM workhorse.job_event
      WHERE job_id = $1 AND event_type = 'progress_updated'`,
    [id],
  );
  const progressEvents = Number(eventResult.rows[0]!.count);

  recordInvariant(assertions, "first progress revision is one", first.revision, 1n);
  recordInvariant(
    assertions,
    "identical progress is a no-op",
    unchanged.revision === first.revision &&
      unchanged.updatedAt.getTime() === first.updatedAt.getTime(),
    true,
  );
  recordInvariant(assertions, "changed progress is frequency limited", rateLimited, true);
  recordInvariant(assertions, "wrong progress fence is rejected", staleRejected, true);
  recordInvariant(assertions, "second accepted progress increments revision", second.revision, 2n);
  recordInvariant(
    assertions,
    "lookup exposes latest progress",
    snapshot?.progress?.revision === second.revision &&
      jsonEquivalent(snapshot?.progress?.value, second.value),
    true,
  );
  recordInvariant(assertions, "progress job completes", completed, true);
  recordInvariant(
    assertions,
    "terminal lookup retains latest progress",
    terminal?.progress?.revision === second.revision &&
      jsonEquivalent(terminal?.progress?.value, second.value),
    true,
  );
  recordInvariant(assertions, "accepted changes append one event each", progressEvents, 2);

  return {
    name: "progress-lifecycle",
    durationMs: 0,
    metrics: {
      firstUpdateMs,
      unchangedUpdateMs,
      rateLimitedUpdateMs,
      secondUpdateMs,
      lookupMs,
      latestRevision: second.revision.toString(),
      progressEvents,
    },
    assertions,
  };
}

async function workerConcurrency(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  const assertions: ScenarioAssertion[] = [];
  const metrics: Record<string, ScenarioMetric> = {};
  const concurrencyLevels = [1, 4, 8];
  const leaseMs = Math.max(200, context.options.leaseMs * 4);
  const heartbeatMs = Math.max(20, Math.min(40, Math.floor(leaseMs / 4)));
  const handlerDelayMs = heartbeatMs * 3;
  const pollMs = 10;
  const pollingSchedulingSlack = 2;
  const nullClaimRates: number[] = [];
  const pollingPressureChecks: boolean[] = [];

  metrics.concurrencyLevels = concurrencyLevels.join(",");
  metrics.jobsPerLevel = context.options.jobCount;
  metrics.handlerDelayMs = handlerDelayMs;
  metrics.leaseMs = leaseMs;
  metrics.heartbeatMs = heartbeatMs;
  metrics.pollMs = pollMs;
  metrics.pollingSchedulingSlack = pollingSchedulingSlack;

  for (const concurrency of concurrencyLevels) {
    await reset(context.pool);
    const seedQueue = new Queue(context.pool, context.queueName);
    for (let index = 0; index < context.options.jobCount; index += 1) {
      await seedQueue.enqueue("concurrency-throughput", { index });
    }

    let worker!: Worker;
    const probe = new QueryPressureProbe(
      context.pool,
      () => concurrency - worker.runtimeState().activeSlots,
    );
    worker = new Worker(new Queue(probe, context.queueName), {
      concurrency,
      workerId: `benchmark-concurrency-${concurrency}`,
      leaseMs,
      heartbeatMs,
      pollMs,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
    });
    let activeHandlers = 0;
    let maxHandlerOverlap = 0;
    let maxActiveSlots = 0;
    let completedHandlers = 0;
    worker.handle("concurrency-throughput", async () => {
      activeHandlers += 1;
      maxHandlerOverlap = Math.max(maxHandlerOverlap, activeHandlers);
      maxActiveSlots = Math.max(maxActiveSlots, worker.runtimeState().activeSlots);
      await context.sleep(handlerDelayMs);
      activeHandlers -= 1;
      completedHandlers += 1;
      if (completedHandlers === context.options.jobCount) worker.stop();
      return { ok: true };
    });

    const beforeTiming = probe.snapshot();
    const started = context.now();
    const monitor = setInterval(() => {
      maxActiveSlots = Math.max(maxActiveSlots, worker.runtimeState().activeSlots);
    }, 1);
    monitor.unref();
    try {
      await worker.run();
    } finally {
      clearInterval(monitor);
    }
    const durationMs = Math.max(0, context.now() - started);
    const afterTiming = probe.snapshot();
    await context.sleep(heartbeatMs);
    const afterWindow = probe.snapshot();
    const succeeded = await rowCount(context.pool, "job_outcome");
    const health = await seedQueue.health();
    const runtimeState = worker.runtimeState();
    const prefix = `concurrency${concurrency}`;
    const claimCalls = afterTiming.claimCalls - beforeTiming.claimCalls;
    const nullClaimCalls = Math.max(0, claimCalls - context.options.jobCount);
    const elapsedPollingWindows = Math.ceil(durationMs / pollMs);
    const claimCallUpperBound = pollingClaimUpperBound(
      context.options.jobCount,
      durationMs,
      pollMs,
      pollingSchedulingSlack,
    );
    const nullClaimRate = nullClaimCalls / Math.max(1, elapsedPollingWindows);
    nullClaimRates.push(nullClaimRate);
    pollingPressureChecks.push(claimCalls <= claimCallUpperBound);

    metrics[`${prefix}DurationMs`] = durationMs;
    metrics[`${prefix}JobsPerSecond`] =
      durationMs === 0 ? null : (context.options.jobCount * 1_000) / durationMs;
    metrics[`${prefix}MaxHandlerOverlap`] = maxHandlerOverlap;
    metrics[`${prefix}MaxActiveSlots`] = maxActiveSlots;
    metrics[`${prefix}QueryCalls`] = afterTiming.queries - beforeTiming.queries;
    metrics[`${prefix}ClaimCalls`] = claimCalls;
    metrics[`${prefix}NullClaimCalls`] = nullClaimCalls;
    metrics[`${prefix}ElapsedPollingWindows`] = elapsedPollingWindows;
    metrics[`${prefix}ClaimCallUpperBound`] = claimCallUpperBound;
    metrics[`${prefix}NullClaimsPerPollingWindow`] = nullClaimRate;
    metrics[`${prefix}HeartbeatCalls`] = afterTiming.heartbeatCalls - beforeTiming.heartbeatCalls;
    metrics[`${prefix}MaxConcurrentQueries`] = afterTiming.maxConcurrentQueries;
    metrics[`${prefix}MaxConcurrentClaims`] = afterTiming.maxConcurrentClaims;

    recordInvariant(
      assertions,
      `${prefix} exposes readonly concurrency`,
      worker.concurrency,
      concurrency,
    );
    recordInvariant(
      assertions,
      `${prefix} runtime state concurrency`,
      runtimeState.concurrency,
      concurrency,
    );
    recordInvariant(
      assertions,
      `${prefix} completes all handlers`,
      completedHandlers,
      context.options.jobCount,
    );
    recordInvariant(
      assertions,
      `${prefix} persists all outcomes`,
      succeeded,
      context.options.jobCount,
    );
    recordInvariant(assertions, `${prefix} leaves no active leases`, health.activeLeases, 0);
    recordInvariant(assertions, `${prefix} leaves no expired leases`, health.expiredLeases, 0);
    recordInvariant(
      assertions,
      `${prefix} handler overlap respects slots`,
      maxHandlerOverlap,
      Math.min(concurrency, context.options.jobCount),
      (actual, expected) => Number(actual) <= Number(expected) && Number(actual) >= 1,
    );
    recordInvariant(
      assertions,
      `${prefix} runtime slots stay bounded`,
      maxActiveSlots,
      concurrency,
      (actual, expected) => Number(actual) <= Number(expected) && Number(actual) >= 1,
    );
    recordInvariant(assertions, `${prefix} claims are serial`, afterTiming.maxConcurrentClaims, 1);
    recordInvariant(
      assertions,
      `${prefix} claims only use free slots`,
      afterTiming.claimsWithoutFreeSlot - beforeTiming.claimsWithoutFreeSlot,
      0,
    );
    recordInvariant(
      assertions,
      `${prefix} polling claim pressure is duration bounded`,
      claimCalls,
      claimCallUpperBound,
      (actual, expected) => Number(actual) <= Number(expected),
    );
    recordInvariant(
      assertions,
      `${prefix} connection pressure tracks slots`,
      afterTiming.maxConcurrentQueries,
      concurrency * 2 + 1,
      (actual, expected) => Number(actual) <= Number(expected),
    );
    recordInvariant(
      assertions,
      `${prefix} every job receives a heartbeat`,
      afterTiming.heartbeatCalls - beforeTiming.heartbeatCalls,
      context.options.jobCount,
      (actual, expected) => Number(actual) >= Number(expected),
    );
    recordInvariant(
      assertions,
      `${prefix} has no claims outside timed window`,
      afterWindow.claimCalls,
      afterTiming.claimCalls,
    );
    recordInvariant(assertions, `${prefix} drains active slots`, runtimeState.activeSlots, 0);
  }

  metrics.maxNullClaimsPerPollingWindow = Math.max(...nullClaimRates);
  recordInvariant(
    assertions,
    "null-claim pressure follows polling windows instead of concurrency",
    pollingPressureChecks.every(Boolean),
    true,
  );

  const topologyCapacity = Math.min(8, context.options.jobCount);
  const topologyProfiles = [
    { name: "immediate", delayMs: 0 },
    { name: "io", delayMs: handlerDelayMs },
  ] as const;
  const topologyShapes = [
    { name: "single", workerCount: 1, concurrency: topologyCapacity },
    ...(topologyCapacity >= 4 && topologyCapacity % 2 === 0
      ? [
          {
            name: "balanced",
            workerCount: 2,
            concurrency: topologyCapacity / 2,
          },
        ]
      : []),
    { name: "distributed", workerCount: topologyCapacity, concurrency: 1 },
  ];
  metrics.topologyCapacity = topologyCapacity;
  metrics.topologyProfiles = topologyProfiles.map((profile) => profile.name).join(",");
  metrics.topologyRuns = topologyProfiles.length * topologyShapes.length;

  for (const profile of topologyProfiles) {
    for (const shape of topologyShapes) {
      await reset(context.pool);
      const queue = new Queue(context.pool, context.queueName);
      await queue.enqueueMany(
        Array.from({ length: context.options.jobCount }, (_, index) => ({
          type: "concurrency-topology",
          payload: { index },
        })),
      );
      const probe = new QueryPressureProbe(context.pool);
      const workers: Worker[] = [];
      const running: Promise<void>[] = [];
      const startLatencies: number[] = [];
      let activeHandlers = 0;
      let maxHandlerOverlap = 0;
      let completedHandlers = 0;
      let processingStartedAt = 0;

      for (let workerIndex = 0; workerIndex < shape.workerCount; workerIndex += 1) {
        const worker = new Worker(new Queue(probe, context.queueName), {
          concurrency: shape.concurrency,
          workerId: `benchmark-topology-${profile.name}-${shape.name}-${workerIndex + 1}`,
          leaseMs,
          heartbeatMs,
          pollMs,
          maintenanceIntervalMs: 60_000,
          maintenanceTaskPollMs: 60_000,
        }).handle("concurrency-topology", async () => {
          startLatencies.push(Math.max(0, context.now() - processingStartedAt));
          activeHandlers += 1;
          maxHandlerOverlap = Math.max(maxHandlerOverlap, activeHandlers);
          if (profile.delayMs > 0) await context.sleep(profile.delayMs);
          activeHandlers -= 1;
          completedHandlers += 1;
          if (completedHandlers === context.options.jobCount) {
            for (const activeWorker of workers) activeWorker.stop();
          }
          return { ok: true };
        });
        workers.push(worker);
      }

      const before = probe.snapshot();
      processingStartedAt = context.now();
      for (const worker of workers) running.push(worker.run());
      await Promise.all(running);
      const durationMs = Math.max(0, context.now() - processingStartedAt);
      const after = probe.snapshot();
      const health = await queue.health();
      const outcomes = await rowCount(context.pool, "job_outcome");
      const prefix = `topology${profile.name}${shape.name}`;
      const totalConfiguredSlots = shape.workerCount * shape.concurrency;

      metrics[`${prefix}Workers`] = shape.workerCount;
      metrics[`${prefix}ConcurrencyPerWorker`] = shape.concurrency;
      metrics[`${prefix}TotalConfiguredSlots`] = totalConfiguredSlots;
      metrics[`${prefix}DurationMs`] = durationMs;
      metrics[`${prefix}JobsPerSecond`] =
        durationMs === 0 ? null : (context.options.jobCount * 1_000) / durationMs;
      metrics[`${prefix}StartLatencyP50Ms`] = percentile(startLatencies, 0.5);
      metrics[`${prefix}StartLatencyP95Ms`] = percentile(startLatencies, 0.95);
      metrics[`${prefix}StartLatencyMaxMs`] = percentile(startLatencies, 1);
      metrics[`${prefix}MaxHandlerOverlap`] = maxHandlerOverlap;
      metrics[`${prefix}QueryCalls`] = after.queries - before.queries;
      metrics[`${prefix}ClaimCalls`] = after.claimCalls - before.claimCalls;
      metrics[`${prefix}HeartbeatCalls`] = after.heartbeatCalls - before.heartbeatCalls;
      metrics[`${prefix}MaxConcurrentQueries`] = after.maxConcurrentQueries;
      metrics[`${prefix}MaxConcurrentClaims`] = after.maxConcurrentClaims;

      recordInvariant(
        assertions,
        `${prefix} completes all handlers`,
        completedHandlers,
        context.options.jobCount,
      );
      recordInvariant(
        assertions,
        `${prefix} persists all outcomes`,
        outcomes,
        context.options.jobCount,
      );
      recordInvariant(assertions, `${prefix} leaves no ready work`, health.readyDepth, 0);
      recordInvariant(assertions, `${prefix} leaves no active leases`, health.activeLeases, 0);
      recordInvariant(assertions, `${prefix} leaves no expired leases`, health.expiredLeases, 0);
      recordInvariant(
        assertions,
        `${prefix} respects total configured slots`,
        maxHandlerOverlap,
        totalConfiguredSlots,
        (actual, expected) => Number(actual) >= 1 && Number(actual) <= Number(expected),
      );
      recordInvariant(
        assertions,
        `${prefix} records every handler start`,
        startLatencies.length,
        context.options.jobCount,
      );
    }
  }

  await reset(context.pool);
  const firstNullQueue = new Queue(context.pool, context.queueName);
  await firstNullQueue.enqueue("first-null", { only: true });
  const firstNullProbe = new QueryPressureProbe(context.pool);
  const firstNullWorker = new Worker(new Queue(firstNullProbe, context.queueName), {
    concurrency: 4,
    workerId: "benchmark-first-null",
    leaseMs,
    heartbeatMs,
    pollMs: 1,
    maintenanceIntervalMs: 100,
    maintenanceTaskPollMs: 100,
  });
  let firstNullHandled = 0;
  firstNullWorker.handle("first-null", () => {
    firstNullHandled += 1;
    return { ok: true };
  });
  await firstNullWorker.runOnce();
  const firstNullPressure = firstNullProbe.snapshot();
  metrics.firstNullClaimCalls = firstNullPressure.claimCalls;
  recordInvariant(assertions, "first-null run handles one job", firstNullHandled, 1);
  recordInvariant(
    assertions,
    "first-null run stops after job plus null",
    firstNullPressure.claimCalls,
    2,
  );
  recordInvariant(
    assertions,
    "first-null claims remain serial",
    firstNullPressure.maxConcurrentClaims,
    1,
  );

  await reset(context.pool);
  const pauseQueue = new Queue(context.pool, context.queueName);
  await pauseQueue.enqueue("pause-guard", { paused: true });
  const pauseProbe = new QueryPressureProbe(context.pool);
  const pauseWorker = new Worker(new Queue(pauseProbe, context.queueName), {
    concurrency: 4,
    workerId: "benchmark-pause",
    leaseMs,
    heartbeatMs,
    pollMs: 1,
    maintenanceIntervalMs: 100,
    maintenanceTaskPollMs: 100,
  });
  pauseWorker.handle("pause-guard", () => ({ ok: true }));
  pauseWorker.pause();
  const pausedWorked = await pauseWorker.runOnce();
  const pausedState = pauseWorker.runtimeState();
  metrics.pausedClaimCalls = pauseProbe.snapshot().claimCalls;
  recordInvariant(assertions, "pause reports paused state", pausedState.paused, true);
  recordInvariant(assertions, "pause keeps active slots empty", pausedState.activeSlots, 0);
  recordInvariant(assertions, "pause runOnce reports no work", pausedWorked, false);
  recordInvariant(assertions, "pause blocks claims", pauseProbe.snapshot().claimCalls, 0);
  pauseWorker.resume();
  recordInvariant(
    assertions,
    "resume clears paused state",
    pauseWorker.runtimeState().paused,
    false,
  );

  await reset(context.pool);
  const shutdownConcurrency = 4;
  const shutdownJobs = shutdownConcurrency + 2;
  const shutdownQueue = new Queue(context.pool, context.queueName);
  for (let index = 0; index < shutdownJobs; index += 1) {
    await shutdownQueue.enqueue("shutdown-drain", { index });
  }
  const shutdownProbe = new QueryPressureProbe(context.pool);
  const shutdownWorker = new Worker(new Queue(shutdownProbe, context.queueName), {
    concurrency: shutdownConcurrency,
    workerId: "benchmark-shutdown",
    leaseMs,
    heartbeatMs,
    pollMs: 1,
    maintenanceIntervalMs: 100,
    maintenanceTaskPollMs: 100,
  });
  let shutdownActive = 0;
  let releaseShutdown!: () => void;
  const shutdownGate = new Promise<void>((resolve) => {
    releaseShutdown = resolve;
  });
  shutdownWorker.handle("shutdown-drain", async () => {
    shutdownActive += 1;
    await shutdownGate;
    shutdownActive -= 1;
    return { ok: true };
  });
  const shutdownRun = shutdownWorker.run();
  await waitFor(
    () => shutdownActive === shutdownConcurrency,
    "all shutdown-test slots to become active",
  );
  shutdownWorker.stop();
  const drainingState = shutdownWorker.runtimeState();
  const claimsAtStop = shutdownProbe.snapshot().claimCalls;
  releaseShutdown();
  await shutdownRun;
  const claimsAfterDrain = shutdownProbe.snapshot().claimCalls;
  const shutdownHealth = await shutdownQueue.health();
  const shutdownSucceeded = await rowCount(context.pool, "job_outcome");
  const drainedState = shutdownWorker.runtimeState();
  metrics.shutdownClaimsAtStop = claimsAtStop;
  metrics.shutdownClaimsAfterDrain = claimsAfterDrain;
  metrics.shutdownSucceeded = shutdownSucceeded;
  metrics.shutdownReady = shutdownHealth.readyDepth;
  recordInvariant(assertions, "stop enters draining state", drainingState.draining, true);
  recordInvariant(
    assertions,
    "stop drains configured active slots",
    claimsAtStop,
    shutdownConcurrency,
  );
  recordInvariant(
    assertions,
    "stop prevents claims while draining",
    claimsAfterDrain,
    claimsAtStop,
  );
  recordInvariant(assertions, "stop completes active jobs", shutdownSucceeded, shutdownConcurrency);
  recordInvariant(assertions, "stop leaves unclaimed jobs ready", shutdownHealth.readyDepth, 2);
  recordInvariant(assertions, "stop finishes with no active slots", drainedState.activeSlots, 0);
  recordInvariant(assertions, "stop leaves no active leases", shutdownHealth.activeLeases, 0);
  recordInvariant(assertions, "stop leaves no expired leases", shutdownHealth.expiredLeases, 0);

  return { name: "worker-concurrency", durationMs: 0, metrics, assertions };
}

export const operationalScenarioImplementations: Readonly<
  Record<OperationalScenarioName, OperationalScenarioRunner>
> = {
  "scheduled-promotion-drift": scheduledPromotionDrift,
  "heartbeat-fencing": heartbeatFencing,
  "cancellation-lifecycle": cancellationLifecycle,
  "deadline-timeout-lifecycle": deadlineTimeoutLifecycle,
  "dead-letter-redrive-lifecycle": deadLetterRedriveLifecycle,
  "query-listing-lifecycle": queryListingLifecycle,
  "progress-lifecycle": progressLifecycle,
  "crash-before-completion": crashBeforeCompletion,
  "lease-expiry-recovery": leaseExpiryRecovery,
  "retry-paths": retryPaths,
  "idempotent-ingress": idempotentIngress,
  "retention-pruning": retentionPruning,
  "health-snapshot": healthSnapshot,
  "worker-concurrency": workerConcurrency,
};

export async function runOperationalScenarios(
  pool: Queryable,
  options: OperationalScenarioOptions = {},
): Promise<OperationalScenarioReport> {
  const resolved = resolveOperationalScenarioOptions(options);
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const implementations = {
    ...operationalScenarioImplementations,
    ...options.scenarioImplementations,
  };
  const started = now();
  const scenarios: OperationalScenarioResult[] = [];

  for (const name of resolved.scenarios) {
    const scenarioStarted = now();
    const result = await implementations[name]({
      pool,
      options: resolved,
      queueName: queueName(resolved.queuePrefix, name),
      now,
      sleep,
    });
    if (result.name !== name) {
      throw new Error(`Operational scenario ${name} returned result for ${result.name}`);
    }
    if (result.assertions.some((assertion) => !assertion.passed)) {
      throw new Error(`Operational scenario ${name} returned a failed invariant`);
    }
    scenarios.push({ ...result, durationMs: Math.max(0, now() - scenarioStarted) });
  }

  return {
    options: resolved,
    totalDurationMs: Math.max(0, now() - started),
    scenarios,
  };
}
