import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { InjectedCrashError, Queue, Worker } from "../src/index.js";
import type { Failpoint, Queryable, QueueHealth } from "../src/index.js";

export const operationalScenarioNames = [
  "scheduled-promotion-drift",
  "heartbeat-fencing",
  "crash-before-completion",
  "lease-expiry-recovery",
  "retry-paths",
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
  /** Upper bound on terminal jobs seeded for the monthly retirement scenario. */
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
    purpose: "Exercise immediate retry, delayed retry promotion, and terminal exhaustion.",
    invariants: [
      "zero-delay failure returns ready",
      "positive-delay failure returns scheduled and later promotes",
      "a job at its attempt budget enters failed",
    ],
    metrics: ["immediateAttempts", "delayedAttempts", "delayedPromoted", "exhaustedAttempts"],
  },
  {
    name: "retention-pruning",
    purpose: "Measure completed-month history retirement through the versioned partition protocol.",
    invariants: [
      "seeded terminal jobs create event and attempt history in a completed month",
      "retiring the completed month removes its history partitions",
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

export const resetIronshiftStateSql = `TRUNCATE ironshift.job_event, ironshift.attempt_history,
  ironshift.job_outcome, ironshift.job_runtime, ironshift.job RESTART IDENTITY CASCADE;
ALTER SEQUENCE ironshift.fence_token_seq RESTART WITH 1;
ALTER SEQUENCE ironshift.ready_sequence_seq RESTART WITH 1`;

export const createHistoryPartitionsV1Sql =
  "SELECT ironshift.create_history_partitions_v1($1::date)";
export const retireHistoryMonthV1Sql = "SELECT ironshift.retire_history_month_v1($1::date)";

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
  await pool.query(resetIronshiftStateSql);
}

async function measured<T>(now: () => number, operation: () => Promise<T>): Promise<[T, number]> {
  const started = now();
  const result = await operation();
  return [result, Math.max(0, now() - started)];
}

async function rowCount(pool: Queryable, relation: string, jobId?: string): Promise<number> {
  const where = jobId === undefined ? "" : " WHERE job_id = $1";
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ironshift.${relation}${where}`,
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
       FROM ironshift.job_runtime r
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

  const immediateId = await queue.enqueue("retry-immediate", {}, { maxAttempts: 2 });
  const immediateFirst = await queue.claim("retry-worker");
  recordInvariant(
    assertions,
    "immediate retry enters ready",
    await queue.fail(immediateFirst!, "retry-worker", new Error("retry now")),
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
      exhaustedAttempts: (await queue.getJob(exhaustedId))?.currentAttempt ?? null,
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
  const retiredMonth = new Date();
  retiredMonth.setUTCDate(1);
  retiredMonth.setUTCHours(12, 0, 0, 0);
  retiredMonth.setUTCMonth(retiredMonth.getUTCMonth() - 2);
  const retiredMonthDate = `${retiredMonth.getUTCFullYear()}-${String(retiredMonth.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const historicalTimestamp = new Date(`${retiredMonthDate.slice(0, 8)}15T12:00:00.000Z`);
  await context.pool.query(createHistoryPartitionsV1Sql, [retiredMonthDate]);
  await context.pool.query(
    `UPDATE ironshift.job_event e SET occurred_at = $1
      FROM ironshift.job j WHERE j.id = e.job_id AND j.queue_name = $2`,
    [historicalTimestamp, context.queueName],
  );
  await context.pool.query(
    `UPDATE ironshift.attempt_history h SET occurred_at = $1, finished_at = $1
      FROM ironshift.job j WHERE j.id = h.job_id AND j.queue_name = $2`,
    [historicalTimestamp, context.queueName],
  );
  const historyBefore =
    (await rowCount(context.pool, "job_event")) + (await rowCount(context.pool, "attempt_history"));
  await context.pool.query(retireHistoryMonthV1Sql, [retiredMonthDate]);
  const historyAfter =
    (await rowCount(context.pool, "job_event")) + (await rowCount(context.pool, "attempt_history"));
  const pruned = historyBefore - historyAfter;
  const retainedJobs = await rowCount(context.pool, "job");
  recordInvariant(assertions, "terminal history was seeded", historyBefore > 0, true);
  recordInvariant(
    assertions,
    "prune reports removed history",
    historyBefore - historyAfter,
    pruned,
  );
  recordInvariant(assertions, "old history was removed", historyAfter, 0);
  recordInvariant(assertions, "current job identity is retained", retainedJobs, seededJobs);

  return {
    name: "retention-pruning",
    durationMs: 0,
    metrics: { seededJobs, historyBefore, pruned, historyAfter, retainedJobs },
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
    `UPDATE ironshift.job_runtime
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
