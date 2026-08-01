import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  EnqueueIdempotencyConflictError,
  InjectedCrashError,
  Queue,
  Worker,
} from "../src/index.js";
import type { Failpoint, Queryable, QueueHealth } from "../src/index.js";

export const operationalScenarioNames = [
  "scheduled-promotion-drift",
  "heartbeat-fencing",
  "crash-before-completion",
  "lease-expiry-recovery",
  "retry-paths",
  "idempotent-ingress",
  "retention-pruning",
  "health-snapshot",
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
] as const;

export const resetWorkhorseStateSql = `TRUNCATE workhorse.job_event, workhorse.attempt_history,
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

export const createHistoryWeekV1Sql = "SELECT workhorse.create_history_week_v1($1::date)";
export const retireHistoryWeekV1Sql = "SELECT workhorse.retire_history_week_v1($1::date)";

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
  const retiredWeek = new Date();
  retiredWeek.setUTCHours(12, 0, 0, 0);
  retiredWeek.setUTCDate(retiredWeek.getUTCDate() - ((retiredWeek.getUTCDay() + 6) % 7) - 14);
  const retiredWeekDate = retiredWeek.toISOString().slice(0, 10);
  const historicalTimestamp = new Date(`${retiredWeekDate}T12:00:00.000Z`);
  await context.pool.query(createHistoryWeekV1Sql, [retiredWeekDate]);
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
  const housekeeping = await queue.housekeep();
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
    "event retention ran through housekeeping",
    housekeeping.find((phase) => phase.phase === "event_retention")?.rowsAffected ?? 0,
    1,
  );
  recordInvariant(
    assertions,
    "attempt retention ran through housekeeping",
    housekeeping.find((phase) => phase.phase === "attempt_retention")?.rowsAffected ?? 0,
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
        housekeeping.find((phase) => phase.phase === "event_retention")?.rowsAffected ?? 0,
      attemptRetentionUnits:
        housekeeping.find((phase) => phase.phase === "attempt_retention")?.rowsAffected ?? 0,
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

export const operationalScenarioImplementations: Readonly<
  Record<OperationalScenarioName, OperationalScenarioRunner>
> = {
  "scheduled-promotion-drift": scheduledPromotionDrift,
  "heartbeat-fencing": heartbeatFencing,
  "crash-before-completion": crashBeforeCompletion,
  "lease-expiry-recovery": leaseExpiryRecovery,
  "retry-paths": retryPaths,
  "idempotent-ingress": idempotentIngress,
  "retention-pruning": retentionPruning,
  "health-snapshot": healthSnapshot,
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
