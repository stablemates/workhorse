import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  context as otelContext,
  metrics as otelMetrics,
  propagation,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import type { Notification, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  Admin,
  CancellationRequestedError,
  DeadlineExceededError,
  EnqueueIdempotencyConflictError,
  ExecutionTimeoutError,
  MAX_JOB_DEPENDENTS,
  ProgressLeaseLostError,
  ProgressRateLimitError,
  Queue,
  Worker,
} from "../src/index.js";
import type { ClaimedJob, Queryable, QueueHealth, QueueOptions } from "../src/index.js";
// The crash harness is worker test support, not published API, so it comes from the source module.
import { InjectedCrashError, type Failpoint } from "../src/worker.js";

registerOpenTelemetry();

type AdminApi = Pick<Admin, keyof Admin>;

function operationalQueue(
  database: Queryable,
  defaultQueue = "default",
  options: QueueOptions = {},
): Queue & AdminApi {
  const queue = Reflect.construct(Queue, [database, defaultQueue, options]) as Queue;
  const admin = new Admin(database, defaultQueue, options);
  return new Proxy(queue, {
    get(target, property, receiver) {
      if (property in target) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      const value = Reflect.get(admin, property, admin) as unknown;
      return typeof value === "function" ? value.bind(admin) : value;
    },
  }) as Queue & AdminApi;
}

export const operationalScenarioNames = [
  "scheduled-promotion-drift",
  "schedule-cadence-jitter",
  "heartbeat-fencing",
  "priority-dispatch",
  "cancellation-lifecycle",
  "deadline-timeout-lifecycle",
  "dead-letter-redrive-lifecycle",
  "query-listing-lifecycle",
  "progress-lifecycle",
  "crash-before-completion",
  "lease-expiry-recovery",
  "retry-paths",
  "idempotent-ingress",
  "coalescing-ingress",
  "dependency-operations",
  "retention-pruning",
  "health-snapshot",
  "worker-concurrency",
  "batch-dispatch",
  "rate-limiting",
  "notification-dispatch",
  "telemetry-context",
] as const;

export type OperationalScenarioName = (typeof operationalScenarioNames)[number];
type ScenarioMetric = number | string | boolean | null;

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

interface OperationalScenarioResult {
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
  /** Recurring occurrences sampled by the loaded cadence scenario. */
  scheduleSamples?: number;
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
  scheduleSamples: number;
  leaseMs: number;
  retryDelayMs: number;
  pruneLimit: number;
  queuePrefix: string;
  scenarios: readonly OperationalScenarioName[];
}

interface OperationalScenarioContext {
  admin: Admin;
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
    name: "schedule-cadence-jitter",
    purpose:
      "Measure recurring-schedule fire delay while a real Worker continuously executes queued jobs.",
    invariants: [
      "every planned sample fires while the worker remains loaded",
      "every planned second creates one durable occurrence and job",
      "all observed fire delays are finite and non-negative",
    ],
    metrics: [
      "scheduleSamples",
      "loadJobsStarted",
      "loadJobsCompleted",
      "maintenanceIntervalMs",
      "fireDelayP50Ms",
      "fireDelayP95Ms",
      "fireDelayMaxMs",
    ],
  },
  {
    name: "heartbeat-fencing",
    purpose: "Compare individual and worker-batched heartbeat cost at concurrency 100.",
    invariants: [
      "all 100 current leases are accepted by individual and batched heartbeats",
      "the batched heartbeat uses one statement and rejects an unowned fence",
      "accepted lease renewals produce HOT runtime updates",
    ],
    metrics: [
      "concurrency",
      "beforeStatements",
      "afterStatements",
      "beforeDurationMs",
      "afterDurationMs",
      "beforeStatementsPerSecond",
      "afterStatementsPerSecond",
      "hotUpdates",
    ],
  },
  {
    name: "priority-dispatch",
    purpose:
      "Compare strict-priority claims with a FIFO baseline, exercise starvation, and bound claim-path work after retained history grows.",
    invariants: [
      "mixed priorities dispatch in strict order while equal-priority jobs retain FIFO order",
      "lower-priority work remains ready while sustained higher-priority arrivals replenish the queue",
      "lifetime history stays outside the live runtime relation and actual claim buffer work remains bounded at fixed ready depth",
    ],
    metrics: [
      "jobsPerCohort",
      "workerConcurrency",
      "baselineClaimP50Ms",
      "baselineClaimP95Ms",
      "mixedClaimP50Ms",
      "mixedClaimP95Ms",
      "baselineThroughputJobsPerSecond",
      "mixedThroughputJobsPerSecond",
      "baselineReadyIndexBytes",
      "mixedReadyIndexBytes",
      "readyIndexBytesBeforeHistory",
      "readyIndexBytesAfterHistory",
      "claimPlanExecutionMsBeforeHistory",
      "claimPlanExecutionMsAfterHistory",
      "claimPlanSharedBlocksBeforeHistory",
      "claimPlanSharedBlocksAfterHistory",
      "retainedJobIdentities",
      "liveRuntimeRows",
      "lowPriorityFloodWaitMs",
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
      "queue, type, and creation-time filters use the bounded routing projection while state comes from authoritative lifecycle rows",
      "claims, retries, promotion, cancellation, completion, and heartbeats do not rewrite routing rows",
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
      "a versioned contract validates and completes while operator reads redact configured fields",
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
      "contractEnqueueMs",
      "contractClaimMs",
      "contractCompleteMs",
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
    name: "coalescing-ingress",
    purpose:
      "Compare bounded keyed debounce and throttle contention with idempotent enqueue while recording durable effects and operating cost.",
    invariants: [
      "debounce replacement covers reset and preserve scheduling with one pending identity per key",
      "concurrent acceptance races, replacements, and replays return the expected structured outcome for every request",
      "structured outcomes and lifecycle events agree with the retained job definition and runtime",
      "coalesced work adds no duplicate notification and FIFO effects",
      "purge removes every retained key and pending job after each cohort",
    ],
    metrics: [
      "requestsPerCohort",
      "keysPerCohort",
      "idempotentEnqueueP50Ms",
      "idempotentEnqueueP95Ms",
      "debounceResetEnqueueP50Ms",
      "debounceResetEnqueueP95Ms",
      "debouncePreserveEnqueueP50Ms",
      "debouncePreserveEnqueueP95Ms",
      "throttleEnqueueP50Ms",
      "throttleEnqueueP95Ms",
      "idempotentKeyIndexBytes",
      "debounceResetKeyIndexBytes",
      "debouncePreserveKeyIndexBytes",
      "throttleKeyIndexBytes",
      "idempotentNotifications",
      "debounceResetNotifications",
      "debouncePreserveNotifications",
      "throttleNotifications",
      "idempotentCleanupMs",
      "debounceResetCleanupMs",
      "debouncePreserveCleanupMs",
      "throttleCleanupMs",
    ],
  },
  {
    name: "dependency-operations",
    purpose:
      "Measure fan-in, wide fan-out settlement, disconnected dependency enqueue concurrency, and cancellation while proving claim work stays bounded as terminal history grows.",
    invariants: [
      "fan-in releases once after every prerequisite resolves",
      "wide fan-out terminal settlement cancels every dependent at the configured bound",
      "concurrent disconnected dependency enqueue creates every requested edge without cross-component lock contention",
      "cancellation applies its declared terminal dependency policy",
      "claim buffer work stays bounded after retained terminal history grows",
      "health reports no blocked dependency after every cohort settles",
    ],
    metrics: [
      "fanIn",
      "fanInReleaseMs",
      "fanOut",
      "fanOutSettlementMs",
      "concurrentDependencyEnqueues",
      "concurrentDependencyEnqueueTotalMs",
      "concurrentDependencyEnqueueP50Ms",
      "concurrentDependencyEnqueueP95Ms",
      "concurrentDependencyEnqueueThroughputPerSecond",
      "cancellationResolutionMs",
      "claimPlanExecutionMsBeforeHistory",
      "claimPlanExecutionMsAfterHistory",
      "claimPlanSharedBlocksBeforeHistory",
      "claimPlanSharedBlocksAfterHistory",
      "retainedJobIdentities",
      "historyJobs",
      "dependencyReleaseEvents",
      "dependencyFailedResolutions",
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
      "the expired lease marks the snapshot critical with the expired-leases reason",
      "state counts and protocol version remain internally consistent",
      "bounded terminal and bucket scans stay uncapped at seed scale",
    ],
    metrics: [
      "readyDepth",
      "scheduledDepth",
      "activeLeases",
      "expiredLeases",
      "statusLevel",
      "reasonCodes",
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
  {
    name: "batch-dispatch",
    purpose:
      "Compare serial and batched handler dispatch with the same per-job durable lifecycle and record bounded operational evidence.",
    invariants: [
      "the batched cohort dispatches full and partial batches while completing the same job count as serial handlers",
      "mixed outcomes settle independently without changing successful peers",
      "every admitted member consumes one slot and one policy admission per job",
      "lease recovery and stale fences isolate one lost member from its batch peers",
      "serial and batched cohorts record claim cost through the same claim path over live ready-index work",
    ],
    metrics: [
      "jobsPerCohort",
      "partialJobsPerCohort",
      "batchMaxSize",
      "serialJobsPerSecond",
      "batchJobsPerSecond",
      "serialPartialJobsPerSecond",
      "batchPartialJobsPerSecond",
      "fullBatches",
      "partialBatches",
      "batchSizeP50",
      "batchLingerP95Ms",
      "serialClaimP95Ms",
      "batchClaimP95Ms",
      "serialClaimCalls",
      "batchClaimCalls",
      "batchMaxActiveSlots",
      "batchTelemetrySeries",
      "concurrencyPolicyAdmittedJobs",
      "ratePolicyAdmittedJobs",
      "recoveredMembers",
      "claimPlanSharedBlocksBeforeHistory",
      "claimPlanSharedBlocksAfterHistory",
    ],
  },
  {
    name: "rate-limiting",
    purpose:
      "Exercise atomic queue bursts, bounded throttling visibility, and PostgreSQL-time refill.",
    invariants: [
      "the configured burst admits exactly its token count across competing workers",
      "ready work remains unclaimed while the queue bucket is empty",
      "status reports throttled depth and a future eligibility timestamp",
      "elapsed PostgreSQL time restores one start without a completion refund",
    ],
    metrics: [
      "burstClaims",
      "throttledReady",
      "nextEligibilityDelayMs",
      "refillWaitMs",
      "refilledClaimMs",
    ],
  },
  {
    name: "notification-dispatch",
    purpose:
      "Compare idle claim pressure and enqueue-to-claim latency between polling-only and notification-assisted workers.",
    invariants: [
      "both dispatch modes execute the committed job",
      "notification-assisted idle dispatch issues fewer empty claims than polling-only dispatch",
      "notification-assisted dispatch retains a bounded polling fallback",
    ],
    metrics: [
      "idleWindowMs",
      "pollingFallbackMs",
      "notificationFallbackMs",
      "pollingIdleClaimCalls",
      "notificationIdleClaimCalls",
      "pollingEnqueueToClaimMs",
      "notificationEnqueueToClaimMs",
      "pollingEnqueueToHandlerMs",
      "notificationEnqueueToHandlerMs",
    ],
  },
  {
    name: "telemetry-context",
    purpose:
      "Compare enqueue and claiming timings with the OpenTelemetry SDK disabled and enabled, without making a performance claim.",
    invariants: [
      "instrumented and baseline batches accept and complete the same number of jobs",
      "trace metadata remains separate from an unchanged application payload",
      "only instrumented claims return a W3C parent context",
      "the active SDK exports spans and metrics for the instrumented cohort",
      "trace metadata adds no dispatch index",
    ],
    metrics: [
      "jobsPerCohort",
      "baselineEnqueueMs",
      "instrumentedEnqueueMs",
      "baselineClaimMs",
      "instrumentedClaimMs",
      "exportedSpans",
      "exportedMetrics",
      "traceContextIndexes",
    ],
  },
] as const;

export const resetWorkhorseStateSql = `TRUNCATE workhorse.job_event, workhorse.attempt_history,
  workhorse.job_redrive, workhorse.queue_purge_request, workhorse.job_query,
  workhorse.rate_limit_bucket, workhorse.rate_limit_policy, workhorse.concurrency_policy,
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
  scheduleSamples: 3,
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
    scheduleSamples: positiveInteger(
      "scheduleSamples",
      options.scheduleSamples ?? defaults.scheduleSamples,
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
  claimedJobs: number;
  emptyClaimCalls: number;
  heartbeatCalls: number;
  heartbeatJobs: number;
  maxConcurrentQueries: number;
  maxConcurrentClaims: number;
  claimsWithoutFreeSlot: number;
  lastSuccessfulClaimAt: number | null;
  claimDurationsMs: readonly number[];
  successfulClaimTimes: readonly number[];
}

class QueryPressureProbe implements Queryable {
  private activeQueries = 0;
  private activeClaims = 0;
  private queries = 0;
  private claimCalls = 0;
  private claimedJobs = 0;
  private emptyClaimCalls = 0;
  private heartbeatCalls = 0;
  private heartbeatJobs = 0;
  private maxConcurrentQueries = 0;
  private maxConcurrentClaims = 0;
  private claimsWithoutFreeSlot = 0;
  private lastSuccessfulClaimAt: number | null = null;
  private readonly claimDurationsMs: number[] = [];
  private readonly successfulClaimTimes: number[] = [];

  constructor(
    private readonly target: Queryable,
    private readonly freeClaimSlots?: () => number,
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const claim = text.includes("workhorse.claim_v1") || text.includes("workhorse.claim_many_v1");
    const claimStartedAt = claim ? performance.now() : 0;
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
    const heartbeat =
      text.includes("workhorse.heartbeat_v1") || text.includes("workhorse.heartbeat_many_v1");
    if (heartbeat) {
      this.heartbeatCalls += 1;
    }
    try {
      const result = await this.target.query<R>(text, values);
      if (heartbeat) this.heartbeatJobs += result.rows.length;
      if (claim) {
        this.claimDurationsMs.push(Math.max(0, performance.now() - claimStartedAt));
        if (result.rows.length > 0) {
          this.claimedJobs += result.rows.length;
          this.lastSuccessfulClaimAt = performance.now();
          this.successfulClaimTimes.push(this.lastSuccessfulClaimAt);
        } else {
          this.emptyClaimCalls += 1;
        }
      }
      return result;
    } finally {
      this.activeQueries -= 1;
      if (claim) this.activeClaims -= 1;
    }
  }

  snapshot(): QueryPressureSnapshot {
    return {
      queries: this.queries,
      claimCalls: this.claimCalls,
      claimedJobs: this.claimedJobs,
      emptyClaimCalls: this.emptyClaimCalls,
      heartbeatCalls: this.heartbeatCalls,
      heartbeatJobs: this.heartbeatJobs,
      maxConcurrentQueries: this.maxConcurrentQueries,
      maxConcurrentClaims: this.maxConcurrentClaims,
      claimsWithoutFreeSlot: this.claimsWithoutFreeSlot,
      lastSuccessfulClaimAt: this.lastSuccessfulClaimAt,
      claimDurationsMs: [...this.claimDurationsMs],
      successfulClaimTimes: [...this.successfulClaimTimes],
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
  const queue = operationalQueue(context.pool, context.queueName);
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

async function scheduleCadenceJitter(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = operationalQueue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const namespace = `${context.queueName}-${Date.now()}`;
  const scheduleType = "benchmark-schedule-cadence";
  const loadType = "benchmark-schedule-load";
  const maintenanceIntervalMs = 1_000;
  const baselineOccurrence = new Date(Math.floor(Date.now() / 1_000) * 1_000);

  await queue.syncSchedules(namespace, [
    {
      name: "every-second",
      schedule: "* * * * * *",
      job: {
        type: scheduleType,
        payload: null,
        queue: context.queueName,
      },
    },
  ]);
  const [definition] = await queue.schedules([namespace]);
  recordInvariant(assertions, "schedule definition synchronized", definition !== undefined, true);
  const baselineJobId = await queue.fireSchedule(
    namespace,
    definition!.name,
    definition!.revision,
    baselineOccurrence,
  );
  recordInvariant(assertions, "baseline occurrence reserved", baselineJobId !== null, true);

  for (let index = 0; index < context.options.jobCount; index += 1) {
    await queue.enqueue(loadType, { index });
  }

  let keepLoaded = true;
  let loadJobsStarted = 0;
  let loadJobsCompleted = 0;
  const worker = new Worker(queue, {
    workerId: `${context.queueName}-worker`,
    queue: context.queueName,
    concurrency: 4,
    leaseMs: 5_000,
    heartbeatMs: 1_000,
    pollMs: 10,
    maintenanceIntervalMs,
    maintenanceTaskPollMs: 60_000,
    registryIntervalMs: 0,
    scheduleNamespaces: [namespace],
    scheduleCatchupLimit: context.options.scheduleSamples,
  })
    .handle(loadType, async () => {
      loadJobsStarted += 1;
      await context.sleep(10);
      if (keepLoaded) await queue.enqueue(loadType, null);
      loadJobsCompleted += 1;
      return null;
    })
    .handle(scheduleType, () => null);

  const running = worker.run();
  try {
    const deadline = performance.now() + (context.options.scheduleSamples + 3) * 1_000;
    while (true) {
      const count = await context.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM workhorse.schedule_occurrence
          WHERE namespace = $1 AND schedule_name = $2 AND occurrence_at > $3`,
        [namespace, definition!.name, baselineOccurrence],
      );
      if (Number(count.rows[0]?.count ?? 0) >= context.options.scheduleSamples) break;
      if (performance.now() >= deadline) {
        throw new Error("Timed out waiting for loaded recurring-schedule samples");
      }
      await context.sleep(10);
    }
  } finally {
    keepLoaded = false;
    worker.stop();
    await running;
  }

  const occurrenceRows = await context.pool.query<{
    fire_delay_ms: string;
    job_id: string | null;
  }>(
    `SELECT extract(epoch FROM (fired_at - occurrence_at)) * 1000 AS fire_delay_ms, job_id
       FROM workhorse.schedule_occurrence
      WHERE namespace = $1 AND schedule_name = $2 AND occurrence_at > $3
      ORDER BY occurrence_at
      LIMIT $4`,
    [namespace, definition!.name, baselineOccurrence, context.options.scheduleSamples],
  );
  const fireDelays = occurrenceRows.rows.map((row) => Number(row.fire_delay_ms));

  recordInvariant(
    assertions,
    "every planned sample fired",
    occurrenceRows.rows.length,
    context.options.scheduleSamples,
  );
  recordInvariant(
    assertions,
    "every occurrence owns one job",
    occurrenceRows.rows.every((row) => row.job_id !== null),
    true,
  );
  recordInvariant(
    assertions,
    "worker remained loaded while schedules fired",
    loadJobsStarted >= context.options.scheduleSamples,
    true,
  );
  recordInvariant(
    assertions,
    "fire delays are finite and non-negative",
    fireDelays.every((value) => Number.isFinite(value) && value >= 0),
    true,
  );

  return {
    name: "schedule-cadence-jitter",
    durationMs: 0,
    metrics: {
      scheduleSamples: context.options.scheduleSamples,
      loadJobsStarted,
      loadJobsCompleted,
      maintenanceIntervalMs,
      fireDelayP50Ms: percentile(fireDelays, 0.5),
      fireDelayP95Ms: percentile(fireDelays, 0.95),
      fireDelayMaxMs: percentile(fireDelays, 1),
    },
    assertions,
  };
}

async function heartbeatFencing(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = operationalQueue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const concurrency = 100;
  const workerId = "heartbeat-benchmark-worker";
  const leaseMs = 30_000;
  const heartbeatIntervalMs = leaseMs / 3;
  const jobs: ClaimedJob[] = [];
  for (let index = 0; index < concurrency; index += 1) {
    await queue.enqueue("heartbeat", { index });
    const job = await queue.claim(workerId, {
      leaseMs,
    });
    if (job !== null) jobs.push(job);
  }
  recordInvariant(assertions, "claimed 100 concurrent leases", jobs.length, concurrency);
  await context.pool.query("SELECT pg_stat_force_next_flush()");
  const beforeStats = await context.pool.query<{ hot_updates: string }>(
    `SELECT n_tup_hot_upd::text AS hot_updates FROM pg_stat_user_tables
      WHERE schemaname = 'workhorse' AND relname = 'job_runtime'`,
  );
  const hotBefore = Number(beforeStats.rows[0]?.hot_updates ?? 0);
  const [individualStatuses, beforeDurationMs] = await measured(context.now, () =>
    Promise.all(jobs.map((job) => queue.heartbeatStatus(job, workerId, leaseMs))),
  );
  const [batchStatuses, afterDurationMs] = await measured(context.now, () =>
    queue.heartbeatMany(jobs, workerId, leaseMs),
  );
  for (let sample = 1; sample < 5; sample += 1) {
    await queue.heartbeatMany(jobs, workerId, leaseMs);
  }
  const stale = { ...jobs[0]!, fenceToken: jobs[0]!.fenceToken + 1n };
  const staleStatuses = await queue.heartbeatMany([stale], workerId, leaseMs);
  await delay(1_100);
  await context.pool.query("SELECT pg_stat_force_next_flush()");
  const afterStats = await context.pool.query<{ hot_updates: string }>(
    `SELECT n_tup_hot_upd::text AS hot_updates FROM pg_stat_user_tables
      WHERE schemaname = 'workhorse' AND relname = 'job_runtime'`,
  );
  const hotUpdates = Number(afterStats.rows[0]?.hot_updates ?? 0) - hotBefore;
  recordInvariant(
    assertions,
    "individual heartbeats accepted",
    individualStatuses.every((status) => status === "accepted"),
    true,
  );
  recordInvariant(
    assertions,
    "batch accepted every current lease",
    [...batchStatuses.values()].filter((status) => status === "accepted").length,
    concurrency,
  );
  recordInvariant(assertions, "stale fence rejected", staleStatuses.get(stale.id), "stale");
  recordInvariant(assertions, "heartbeat updates were HOT", hotUpdates > 0, true);
  for (const job of jobs) await queue.complete(job, workerId, { ok: true });
  return {
    name: "heartbeat-fencing",
    durationMs: 0,
    metrics: {
      concurrency,
      beforeStatements: concurrency,
      afterStatements: 1,
      beforeDurationMs,
      afterDurationMs,
      beforeStatementsPerSecond: concurrency / (heartbeatIntervalMs / 1_000),
      afterStatementsPerSecond: 1 / (heartbeatIntervalMs / 1_000),
      hotUpdates,
    },
    assertions,
  };
}

interface ClaimPlanSummary {
  executionTimeMs: number;
  sharedBlocks: number;
}

function summarizeClaimPlan(value: unknown): ClaimPlanSummary {
  const document = Array.isArray(value) ? value[0] : undefined;
  const root =
    document !== null && typeof document === "object" ? (document as Record<string, unknown>) : {};
  let sharedBlocks = 0;
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const nodeSharedBlocks =
      Number(record["Shared Hit Blocks"] ?? 0) + Number(record["Shared Read Blocks"] ?? 0);
    if (Number.isFinite(nodeSharedBlocks)) sharedBlocks = Math.max(sharedBlocks, nodeSharedBlocks);
    const plans = record.Plans;
    if (Array.isArray(plans)) plans.forEach(visit);
  };
  visit(root.Plan);
  return {
    executionTimeMs: Number(root["Execution Time"] ?? 0),
    sharedBlocks,
  };
}

async function claimPlan(
  pool: Queryable,
  targetQueueName: string,
  workerId: string,
): Promise<ClaimPlanSummary> {
  const result = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT * FROM workhorse.claim_v1($1::text, $2::text, 30000::integer)`,
    [targetQueueName, workerId],
  );
  return summarizeClaimPlan(result.rows[0]?.["QUERY PLAN"]);
}

async function relationBytes(pool: Queryable, relation: string): Promise<number> {
  const result = await pool.query<{ bytes: string }>(
    "SELECT pg_relation_size($1::regclass)::text AS bytes",
    [relation],
  );
  return Number(result.rows[0]?.bytes ?? 0);
}

async function priorityDispatch(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const assertions: ScenarioAssertion[] = [];
  const jobsPerCohort = Math.max(5, context.options.jobCount * 5);
  const historyJobs = jobsPerCohort * 4;
  const priorityWorkerConcurrency = 4;

  const runCohort = async (
    cohortQueueName: string,
    priorities: readonly number[],
    cohortWorkerConcurrency: number,
  ): Promise<{
    claims: ClaimedJob[];
    claimDurations: number[];
    throughputJobsPerSecond: number;
    readyIndexBytes: number;
  }> => {
    const queue = operationalQueue(context.pool, cohortQueueName);
    for (let offset = 0; offset < priorities.length; offset += 1_000) {
      await queue.enqueueMany(
        priorities.slice(offset, offset + 1_000).map((priority, relativeIndex) => ({
          type: "priority-benchmark",
          payload: { index: offset + relativeIndex },
          options: { priority },
        })),
      );
    }
    const readyIndexBytes = await relationBytes(context.pool, "workhorse.job_runtime_ready_idx");
    const claims: ClaimedJob[] = [];
    const claimDurations: number[] = [];
    const started = context.now();
    let nextClaim = 0;
    await Promise.all(
      Array.from({ length: cohortWorkerConcurrency }, async (_unused, workerSlot) => {
        while (true) {
          const claimIndex = nextClaim;
          nextClaim += 1;
          if (claimIndex >= priorities.length) return;
          const workerId = `${cohortQueueName}-worker-${workerSlot}-${claimIndex}`;
          const [claim, claimMs] = await measured(context.now, () => queue.claim(workerId));
          if (claim === null) {
            throw new Error(`priority cohort ${cohortQueueName} exhausted early`);
          }
          claims.push(claim);
          claimDurations.push(claimMs);
          await context.sleep(1);
          await queue.complete(claim, workerId, null);
        }
      }),
    );
    const durationMs = Math.max(0.001, context.now() - started);
    return {
      claims,
      claimDurations,
      throughputJobsPerSecond: priorities.length / (durationMs / 1_000),
      readyIndexBytes,
    };
  };

  const mixedPriorities = Array.from({ length: jobsPerCohort }, (_unused, index) =>
    index % 20 === 19 ? 100 : index % 20 >= 16 ? 50 : 0,
  );
  const ordering = await runCohort(`${context.queueName}-ordering`, mixedPriorities, 1);
  const mixedClaimOrder = ordering.claims.map((claim) => ({
    priority: claim.priority,
    index: Number((claim.payload as { index: number }).index),
  }));
  const expectedMixedOrder = mixedPriorities
    .map((priority, index) => ({ priority, index }))
    // oxlint-disable-next-line unicorn/no-array-sort -- Array.map returns a fresh array.
    .sort((left, right) => right.priority - left.priority || left.index - right.index);
  recordInvariant(
    assertions,
    "mixed priorities dispatch in strict order with FIFO peers",
    jsonEquivalent(mixedClaimOrder, expectedMixedOrder),
    true,
  );

  await reset(context.pool);
  const baselinePriorities = Array.from({ length: jobsPerCohort }, () => 0);
  const baseline = await runCohort(
    `${context.queueName}-baseline`,
    baselinePriorities,
    priorityWorkerConcurrency,
  );

  await reset(context.pool);
  const mixed = await runCohort(
    `${context.queueName}-mixed`,
    mixedPriorities,
    priorityWorkerConcurrency,
  );

  await reset(context.pool);
  const liveQueueName = `${context.queueName}-live`;
  const seedLiveReady = async (): Promise<void> => {
    const liveQueue = operationalQueue(context.pool, liveQueueName);
    await liveQueue.enqueueMany(
      Array.from({ length: jobsPerCohort }, (_unused, index) => ({
        type: "priority-live",
        payload: { index },
        options: { priority: index % 2 === 0 ? 100 : 0 },
      })),
    );
  };
  await seedLiveReady();
  const readyIndexBytesBeforeHistory = await relationBytes(
    context.pool,
    "workhorse.job_runtime_ready_idx",
  );
  const planBeforeHistory = await claimPlan(
    context.pool,
    liveQueueName,
    "priority-plan-before-history",
  );
  await reset(context.pool);
  await seedLiveReady();
  await runCohort(
    `${context.queueName}-history`,
    Array.from({ length: historyJobs }, () => 0),
    priorityWorkerConcurrency,
  );
  await context.pool.query("VACUUM (ANALYZE) workhorse.job_runtime");
  const readyIndexBytesAfterHistory = await relationBytes(
    context.pool,
    "workhorse.job_runtime_ready_idx",
  );
  const planAfterHistory = await claimPlan(
    context.pool,
    liveQueueName,
    "priority-plan-after-history",
  );
  const retainedJobIdentities = await rowCount(context.pool, "job");
  const liveRuntimeRows = await rowCount(context.pool, "job_runtime");
  recordInvariant(
    assertions,
    "terminal history is absent from the live runtime relation",
    liveRuntimeRows,
    jobsPerCohort,
  );
  recordInvariant(
    assertions,
    "retained identities exceed live claim rows",
    retainedJobIdentities,
    jobsPerCohort + historyJobs,
  );
  recordInvariant(
    assertions,
    "claim plans record shared buffer work",
    planBeforeHistory.sharedBlocks > 0 && planAfterHistory.sharedBlocks > 0,
    true,
  );
  recordInvariant(
    assertions,
    "claim buffer work does not scale with retained history",
    planAfterHistory.sharedBlocks <= planBeforeHistory.sharedBlocks * 2,
    true,
  );

  await reset(context.pool);
  const floodQueue = operationalQueue(context.pool, `${context.queueName}-starvation`);
  await floodQueue.enqueue("low-priority", null, { priority: 0 });
  const floodStarted = context.now();
  let highPriorityClaims = 0;
  for (let index = 0; index < jobsPerCohort; index += 1) {
    await floodQueue.enqueue("high-priority", { index }, { priority: 100 });
    const workerId = `priority-flood-worker-${index}`;
    const claim = await floodQueue.claim(workerId);
    if (claim?.priority === 100) highPriorityClaims += 1;
    if (claim !== null) await floodQueue.complete(claim, workerId, null);
  }
  const lowDuringFlood = await context.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM workhorse.job_runtime
      WHERE queue_name = $1 AND state = 'ready' AND priority = 0`,
    [`${context.queueName}-starvation`],
  );
  const lowPriorityFloodWaitMs = Math.max(0, context.now() - floodStarted);
  recordInvariant(
    assertions,
    "every replenished flood claim selects high priority",
    highPriorityClaims,
    jobsPerCohort,
  );
  recordInvariant(
    assertions,
    "lower-priority work remains ready throughout sustained high-priority load",
    Number(lowDuringFlood.rows[0]?.count ?? 0),
    1,
  );
  const lowClaim = await floodQueue.claim("priority-low-after-flood");
  recordInvariant(assertions, "low priority runs when the flood stops", lowClaim?.priority, 0);
  if (lowClaim !== null) await floodQueue.complete(lowClaim, "priority-low-after-flood", null);

  return {
    name: "priority-dispatch",
    durationMs: 0,
    metrics: {
      jobsPerCohort,
      workerConcurrency: priorityWorkerConcurrency,
      baselineClaimP50Ms: percentile(baseline.claimDurations, 0.5),
      baselineClaimP95Ms: percentile(baseline.claimDurations, 0.95),
      mixedClaimP50Ms: percentile(mixed.claimDurations, 0.5),
      mixedClaimP95Ms: percentile(mixed.claimDurations, 0.95),
      baselineThroughputJobsPerSecond: baseline.throughputJobsPerSecond,
      mixedThroughputJobsPerSecond: mixed.throughputJobsPerSecond,
      baselineReadyIndexBytes: baseline.readyIndexBytes,
      mixedReadyIndexBytes: mixed.readyIndexBytes,
      readyIndexBytesBeforeHistory,
      readyIndexBytesAfterHistory,
      claimPlanExecutionMsBeforeHistory: planBeforeHistory.executionTimeMs,
      claimPlanExecutionMsAfterHistory: planAfterHistory.executionTimeMs,
      claimPlanSharedBlocksBeforeHistory: planBeforeHistory.sharedBlocks,
      claimPlanSharedBlocksAfterHistory: planAfterHistory.sharedBlocks,
      retainedJobIdentities,
      liveRuntimeRows,
      floodHighPriorityClaims: highPriorityClaims,
      lowPriorityFloodWaitMs,
    },
    assertions,
  };
}

async function cancellationLifecycle(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = operationalQueue(context.pool, context.queueName);
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
      await new Promise<void>((resolve) => {
        handlerContext.signal.addEventListener("abort", () => resolve(), { once: true });
      });
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
    (await context.admin.getJob(activeJobId))?.state,
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
    (await context.admin.getJob(ignoredJobId))?.state,
    "canceled",
  );
  recordInvariant(
    assertions,
    "expired requested lease does not create a retry attempt",
    (await context.admin.getJob(ignoredJobId))?.currentAttempt,
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
    (await context.admin.getJob(nextOccurrenceId!))?.state,
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
  const queue = operationalQueue(context.pool, context.queueName);
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
    (await context.admin.getJob(readyDeadlineId))?.state,
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
      await new Promise<void>((resolve) => {
        handlerContext.signal.addEventListener("abort", () => resolve(), { once: true });
      });
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
    (await context.admin.getJob(activeDeadlineId))?.state,
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
      await new Promise<void>((resolve) => {
        handlerContext.signal.addEventListener("abort", () => resolve(), { once: true });
      });
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
    (await context.admin.getJob(timeoutId))?.currentAttempt,
    2,
  );
  await timeoutWorker.runOnce();
  recordInvariant(
    assertions,
    "retry after timeout can succeed",
    (await context.admin.getJob(timeoutId))?.state,
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
    (await context.admin.getJob(healthTimeoutId))?.state,
    "active",
  );

  return { name: "deadline-timeout-lifecycle", durationMs: 0, metrics, assertions };
}

async function deadLetterRedriveLifecycle(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = operationalQueue(context.pool, context.queueName);
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
    context.admin.listDeadLetters({
      queue: context.queueName,
      type: "redrive-source",
      tags: ["redrive"],
      errorName: "Error",
      limit: 2,
    }),
  );
  const secondPage = await context.admin.listDeadLetters({
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
    context.admin.redriveMany(
      { queue: context.queueName, type: "redrive-source", tags: ["redrive"] },
      {
        actor: "operational-scenario",
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
    actor: "operational-scenario",
    reason: "retry one inspected terminal failure",
    requestId: "dead-letter-single",
  };
  const [single, singleRedriveMs] = await measured(context.now, () =>
    context.admin.redrive(sourceJobId, request),
  );
  const [replay, replayMs] = await measured(context.now, () =>
    context.admin.redrive(sourceJobId, request),
  );
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
    context.admin.redriveMany(
      { queue: context.queueName, type: "redrive-source", errorName: "Error" },
      {
        actor: "operational-scenario",
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
      : await context.admin.redriveMany(
          { queue: context.queueName, type: "redrive-source", errorName: "Error" },
          {
            actor: "operational-scenario",
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
  const lineage = await context.admin.getRedriveLineage(sourceJobId);
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
  const queue = operationalQueue(context.pool, context.queueName);
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
  const projectionBeforeLifecycle = await context.pool.query<{ job_id: string; xmin: string }>(
    "SELECT job_id, xmin::text AS xmin FROM workhorse.job_query WHERE job_id = ANY($1::uuid[])",
    [ids],
  );
  const completed = await queue.claim("query-listing-complete", { queue: context.queueName });
  if (!completed) throw new Error("query listing scenario could not claim its completed job");
  await queue.complete(completed, "query-listing-complete", { ok: true });
  const active = await queue.claim("query-listing-active", { queue: context.queueName });
  if (!active) throw new Error("query listing scenario could not claim its active job");

  await queue.heartbeat(active, "query-listing-active", 30_000);
  const projectionAfterLifecycle = await context.pool.query<{ job_id: string; xmin: string }>(
    "SELECT job_id, xmin::text AS xmin FROM workhorse.job_query WHERE job_id = ANY($1::uuid[])",
    [ids],
  );
  recordInvariant(
    assertions,
    "lifecycle transitions leave operator routing rows unchanged",
    new Map(projectionAfterLifecycle.rows.map((row) => [row.job_id, row.xmin])),
    new Map(projectionBeforeLifecycle.rows.map((row) => [row.job_id, row.xmin])),
    (actual, expected) =>
      actual instanceof Map &&
      expected instanceof Map &&
      actual.size === expected.size &&
      [...expected].every(([jobId, xmin]) => actual.get(jobId) === xmin),
  );

  const [firstPage, listMs] = await measured(context.now, () =>
    context.admin.listJobs({ queue: context.queueName, limit: 2 }),
  );
  const secondPage =
    firstPage.nextCursor === null
      ? { items: [], nextCursor: null }
      : await context.admin.listJobs({
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
    context.admin.listJobs({
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
    context.admin.getJobTimeline(completed.id, { limit: 100 }),
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
  const queue = operationalQueue(context.pool, context.queueName);
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
    const snapshot = await context.admin.getJob(jobId);
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
  const queue = operationalQueue(context.pool, context.queueName);
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
  const queue = operationalQueue(context.pool, context.queueName);
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
    (await context.admin.getJob(jitterId))?.retryPolicy,
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
    (await context.admin.getJob(exhaustedId))?.state,
    "failed",
  );

  const contractQueue = operationalQueue(context.pool, context.queueName, {
    contracts: {
      "retry-contracted": {
        currentVersion: "1",
        versions: {
          "1": {
            payloadSchema: { type: "object" },
            resultSchema: { type: "object" },
            sensitivePayloadKeys: ["token"],
            sensitiveResultKeys: ["receipt"],
          },
        },
      },
    },
  });
  const [contractId, contractEnqueueMs] = await measured(context.now, () =>
    contractQueue.enqueue("retry-contracted", { token: "benchmark-secret", value: 1 }),
  );
  const [contractJob, contractClaimMs] = await measured(context.now, () =>
    contractQueue.claim("retry-worker"),
  );
  const [contractCompleted, contractCompleteMs] = await measured(context.now, () =>
    contractQueue.complete(contractJob!, "retry-worker", {
      receipt: "benchmark-secret",
      ok: true,
    }),
  );
  const contractSnapshot = await context.admin.getJob(contractId);
  recordInvariant(assertions, "contracted completion is accepted", contractCompleted, true);
  recordInvariant(
    assertions,
    "contract version is retained",
    contractSnapshot?.contractVersion,
    "1",
  );
  recordInvariant(
    assertions,
    "contracted operator payload is redacted",
    contractSnapshot?.payload,
    { value: 1 },
    jsonEquivalent,
  );
  recordInvariant(
    assertions,
    "contracted operator result is redacted",
    contractSnapshot?.result,
    { ok: true },
    jsonEquivalent,
  );

  return {
    name: "retry-paths",
    durationMs: 0,
    metrics: {
      immediateAttempts: (await context.admin.getJob(immediateId))?.currentAttempt ?? null,
      delayedAttempts: (await context.admin.getJob(delayedId))?.currentAttempt ?? null,
      delayedPromoted,
      fixedDelayMs: Number(fixedEvent.retry_delay_ms),
      fixedSelectionMs,
      exponentialDelayMs: Number(exponentialEvent.retry_delay_ms),
      exponentialSelectionMs,
      jitterDelayMs,
      jitterSelectionMs,
      policySelectionTotalMs: fixedSelectionMs + exponentialSelectionMs + jitterSelectionMs,
      exhaustedAttempts: (await context.admin.getJob(exhaustedId))?.currentAttempt ?? null,
      contractEnqueueMs,
      contractClaimMs,
      contractCompleteMs,
    },
    assertions,
  };
}

async function idempotentIngress(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = operationalQueue(context.pool, context.queueName);
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

async function coalescingIngress(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  const assertions: ScenarioAssertion[] = [];
  const metrics: Record<string, ScenarioMetric> = {};
  const keysPerCohort = Math.max(2, Math.min(context.options.batchSize, context.options.jobCount));
  const repeatsPerKey = Math.max(2, Math.ceil(context.options.jobCount / keysPerCohort));
  const requestsPerCohort = keysPerCohort * (repeatsPerKey + 1);
  type CohortMode = "debounce-preserve" | "debounce-reset" | "idempotent" | "throttle";

  const runCohort = async (mode: CohortMode) => {
    await reset(context.pool);
    const cohortQueueName = `${context.queueName}-${mode}`;
    const queue = operationalQueue(context.pool, cohortQueueName);
    const database = context.pool as Queryable & { connect?: () => Promise<PoolClient> };
    if (database.connect === undefined) {
      throw new Error("coalescing benchmark requires a PostgreSQL pool with LISTEN support");
    }
    const listener = await database.connect();
    const notifications: string[] = [];
    const onNotification = (message: Notification) => {
      if (message.payload === cohortQueueName) notifications.push(message.payload);
    };
    listener.on("notification", onNotification);
    await listener.query("LISTEN workhorse_jobs");

    const enqueue = (keyIndex: number, revision: number) => {
      const key = `key-${keyIndex}`;
      if (mode === "idempotent") {
        return queue.enqueueWithResult(
          "coalescing-ingress",
          { key: keyIndex },
          { idempotency: { key, scope: mode, ttlMs: 60_000 } },
        );
      }
      if (mode === "throttle") {
        return queue.enqueueWithResult(
          "coalescing-ingress",
          { key: keyIndex },
          { throttle: { key, scope: mode, windowMs: 60_000 } },
        );
      }
      return queue.enqueueWithResult(
        "coalescing-ingress",
        { key: keyIndex, revision },
        {
          debounce: {
            key,
            scope: mode,
            windowMs: 60_000,
            schedule: mode === "debounce-reset" ? "reset" : "preserve",
          },
        },
      );
    };

    try {
      const requests = await Promise.all(
        Array.from({ length: repeatsPerKey + 1 }, (_, revision) =>
          Array.from({ length: keysPerCohort }, async (_unused, keyIndex) => {
            const [result, durationMs] = await measured(context.now, () =>
              enqueue(keyIndex, revision),
            );
            return { durationMs, keyIndex, result };
          }),
        ).flat(),
      );
      const results = requests.map(({ result }) => result);
      const durationsMs = requests.map(({ durationMs }) => durationMs);
      const accepted = Array.from({ length: keysPerCohort }, (_, keyIndex) =>
        requests.find(
          (request) => request.keyIndex === keyIndex && request.result.outcome === "accepted",
        ),
      );
      if (accepted.some((request) => request === undefined)) {
        throw new Error(`${mode} acceptance race did not retain one seed per key`);
      }
      const finalSnapshots = await Promise.all(
        accepted.map((request) => context.admin.getJob(request!.result.jobId)),
      );
      const state = (
        await context.pool.query<{
          bindings: number;
          debounced_events: number;
          enqueued_events: number;
          fifo_placements: number;
          jobs: number;
          runtimes: number;
        }>(
          `SELECT
             (SELECT count(*)::integer FROM workhorse.job WHERE queue_name = $1) AS jobs,
             (SELECT count(*)::integer FROM workhorse.job_runtime WHERE queue_name = $1)
               AS runtimes,
             (SELECT count(*)::integer
                FROM workhorse.enqueue_idempotency identity
                JOIN workhorse.job ON job.id = identity.job_id
               WHERE job.queue_name = $1) AS bindings,
             (SELECT count(*)::integer
                FROM workhorse.job_runtime
               WHERE queue_name = $1 AND sequence IS NOT NULL) AS fifo_placements,
             (SELECT count(*)::integer
                FROM workhorse.job_event event
                JOIN workhorse.job ON job.id = event.job_id
               WHERE job.queue_name = $1 AND event.event_type = 'enqueued') AS enqueued_events,
             (SELECT count(*)::integer
                FROM workhorse.job_event event
                JOIN workhorse.job ON job.id = event.job_id
               WHERE job.queue_name = $1 AND event.event_type = 'debounced') AS debounced_events`,
          [cohortQueueName],
        )
      ).rows[0]!;
      const indexSize = await context.pool.query<{ bytes: string }>(
        "SELECT pg_indexes_size('workhorse.enqueue_idempotency'::regclass)::text AS bytes",
      );
      const debounceEvents = await context.pool.query<{
        job_id: string;
        request_digest: string;
        stored_request_digest: string;
      }>(
        `SELECT event.job_id, event.details->>'stored_request_digest' AS stored_request_digest,
                event.details->>'request_digest' AS request_digest
           FROM workhorse.job_event event
           JOIN workhorse.job ON job.id = event.job_id
          WHERE job.queue_name = $1 AND event.event_type = 'debounced'
          ORDER BY event.event_id`,
        [cohortQueueName],
      );
      const retainedDigests = await context.pool.query<{ job_id: string; request_digest: string }>(
        `SELECT identity.job_id,
                workhorse.sha256_hex_v1(identity.request_fingerprint::text) AS request_digest
           FROM workhorse.enqueue_idempotency identity
           JOIN workhorse.job ON job.id = identity.job_id
          WHERE job.queue_name = $1`,
        [cohortQueueName],
      );
      const expectedRepeatOutcome =
        mode === "idempotent" ? "replayed" : mode === "throttle" ? "coalesced" : "replaced";
      const expectedFifoPlacements = mode.startsWith("debounce") ? 0 : keysPerCohort;
      const expectedNotifications = mode.startsWith("debounce") ? 0 : keysPerCohort;
      await listener.query("SELECT 1");
      if (expectedNotifications > 0) {
        await waitFor(
          () => notifications.length === expectedNotifications,
          `${mode} accepted-job notifications`,
        );
      }
      const retainedPayloadsValid = finalSnapshots.every((snapshot, keyIndex) => {
        if (snapshot?.payload === null || typeof snapshot?.payload !== "object") return false;
        const payload = snapshot.payload as { key?: unknown; revision?: unknown };
        if (payload.key !== keyIndex) return false;
        return mode.startsWith("debounce")
          ? Number.isInteger(payload.revision) &&
              Number(payload.revision) >= 0 &&
              Number(payload.revision) <= repeatsPerKey
          : payload.revision === undefined;
      });
      const resultsStayOnAcceptedIdentity = requests.every(
        ({ keyIndex, result }) => result.jobId === accepted[keyIndex]!.result.jobId,
      );
      const eventDigestChainsMatch = accepted.every((request) => {
        const events = debounceEvents.rows.filter(
          (event) => event.job_id === request!.result.jobId,
        );
        if (!mode.startsWith("debounce")) return events.length === 0;
        if (events.length !== repeatsPerKey) return false;
        for (let index = 1; index < events.length; index += 1) {
          if (events[index]!.stored_request_digest !== events[index - 1]!.request_digest) {
            return false;
          }
        }
        const retained = retainedDigests.rows.find(
          (digest) => digest.job_id === request!.result.jobId,
        );
        return retained?.request_digest === events.at(-1)?.request_digest;
      });

      recordInvariant(
        assertions,
        `${mode} accepts one identity per key`,
        results.filter(({ outcome }) => outcome === "accepted").length,
        keysPerCohort,
      );
      recordInvariant(
        assertions,
        `${mode} returns its structured repeated outcome`,
        results.filter(({ outcome }) => outcome === expectedRepeatOutcome).length,
        keysPerCohort * repeatsPerKey,
      );
      recordInvariant(
        assertions,
        `${mode} concurrent acceptance race retains one identity`,
        resultsStayOnAcceptedIdentity,
        true,
      );
      recordInvariant(
        assertions,
        `${mode} keeps one durable job per key`,
        state.jobs,
        keysPerCohort,
      );
      recordInvariant(
        assertions,
        `${mode} keeps one live runtime per key`,
        state.runtimes,
        keysPerCohort,
      );
      recordInvariant(
        assertions,
        `${mode} keeps one retained binding per key`,
        state.bindings,
        keysPerCohort,
      );
      recordInvariant(
        assertions,
        `${mode} appends one acceptance event per key`,
        state.enqueued_events,
        keysPerCohort,
      );
      recordInvariant(
        assertions,
        `${mode} lifecycle replacement events match outcomes`,
        state.debounced_events,
        mode.startsWith("debounce") ? keysPerCohort * repeatsPerKey : 0,
      );
      recordInvariant(
        assertions,
        `${mode} event digest chain matches retained state`,
        eventDigestChainsMatch,
        true,
      );
      recordInvariant(
        assertions,
        `${mode} retains a submitted payload`,
        retainedPayloadsValid,
        true,
      );
      recordInvariant(
        assertions,
        `${mode} preserves expected FIFO effects`,
        state.fifo_placements,
        expectedFifoPlacements,
      );
      recordInvariant(
        assertions,
        `${mode} preserves expected notification effects`,
        notifications.length,
        expectedNotifications,
      );
      const [purged, cleanupMs] = await measured(context.now, () =>
        context.admin.purgeQueue(cohortQueueName, {
          actor: "operational-scenario",
          reason: `clean up ${mode} cohort`,
          requestId: `coalescing-${mode}-cleanup`,
        }),
      );
      const cleanupState = (
        await context.pool.query<{ bindings: number; jobs: number }>(
          `SELECT
             (SELECT count(*)::integer FROM workhorse.job WHERE queue_name = $1) AS jobs,
             (SELECT count(*)::integer
                FROM workhorse.enqueue_idempotency
               WHERE job_id = ANY($2::uuid[])) AS bindings`,
          [cohortQueueName, accepted.map((request) => request!.result.jobId)],
        )
      ).rows[0]!;
      recordInvariant(assertions, `${mode} purge removes every pending job`, purged, keysPerCohort);
      recordInvariant(
        assertions,
        `${mode} purge leaves no job or retained key`,
        cleanupState,
        { bindings: 0, jobs: 0 },
        jsonEquivalent,
      );

      if (mode.startsWith("debounce")) {
        const scheduleAccepted = await enqueue(0, 0);
        const initialRunAt = (await context.admin.getJob(scheduleAccepted.jobId))!.runAt;
        await context.sleep(1);
        await enqueue(0, 1);
        const replacedRunAt = (await context.admin.getJob(scheduleAccepted.jobId))!.runAt;
        recordInvariant(
          assertions,
          `${mode} ${mode === "debounce-reset" ? "resets" : "preserves"} its schedule`,
          replacedRunAt.getTime(),
          initialRunAt.getTime(),
          (actual, expected) =>
            mode === "debounce-reset"
              ? Number(actual) > Number(expected)
              : Number(actual) === Number(expected),
        );
        recordInvariant(
          assertions,
          `${mode} removes its schedule-check identity`,
          await context.admin.purgeQueue(cohortQueueName, {
            actor: "operational-scenario",
            reason: `clean up ${mode} schedule check`,
            requestId: `coalescing-${mode}-schedule-cleanup`,
          }),
          1,
        );
      }

      return {
        cleanupMs,
        durationsMs,
        indexBytes: Number(indexSize.rows[0]?.bytes ?? 0),
        notifications: notifications.length,
      };
    } finally {
      await listener.query("UNLISTEN workhorse_jobs");
      listener.off("notification", onNotification);
      listener.release();
    }
  };

  const cohorts = {
    idempotent: await runCohort("idempotent"),
    debounceReset: await runCohort("debounce-reset"),
    debouncePreserve: await runCohort("debounce-preserve"),
    throttle: await runCohort("throttle"),
  };
  metrics.requestsPerCohort = requestsPerCohort;
  metrics.keysPerCohort = keysPerCohort;
  for (const [prefix, cohort] of Object.entries(cohorts)) {
    metrics[`${prefix}EnqueueP50Ms`] = percentile(cohort.durationsMs, 0.5);
    metrics[`${prefix}EnqueueP95Ms`] = percentile(cohort.durationsMs, 0.95);
    metrics[`${prefix}KeyIndexBytes`] = cohort.indexBytes;
    metrics[`${prefix}Notifications`] = cohort.notifications;
    metrics[`${prefix}CleanupMs`] = cohort.cleanupMs;
  }

  return { name: "coalescing-ingress", durationMs: 0, metrics, assertions };
}

async function dependencyOperations(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = operationalQueue(context.pool, context.queueName);
  const assertions: ScenarioAssertion[] = [];
  const fanIn = Math.max(2, Math.min(context.options.jobCount, 100));
  const prerequisiteIds = await queue.enqueueMany(
    Array.from({ length: fanIn }, (_, index) => ({
      type: "dependency-prerequisite",
      payload: { index },
    })),
  );
  const dependentId = await queue.enqueue("dependency-dependent", null, {
    dependencies: {
      prerequisiteJobIds: prerequisiteIds,
      onSuccess: "release",
      onFailure: "fail",
      onCancellation: "cancel",
    },
  });
  const [, fanInReleaseMs] = await measured(context.now, async () => {
    for (let index = 0; index < fanIn; index += 1) {
      const workerId = `dependency-fan-in-${index}`;
      const prerequisite = await queue.claim(workerId);
      if (prerequisite === null) throw new Error("dependency fan-in exhausted early");
      await queue.complete(prerequisite, workerId, null);
    }
  });
  recordInvariant(
    assertions,
    "fan-in releases once after every prerequisite resolves",
    (await context.admin.getJob(dependentId))?.state,
    "ready",
  );
  const dependencyReleaseEvents = (await context.admin.getJobTimeline(dependentId)).items.filter(
    (entry) => entry.kind === "event" && entry.eventType === "dependency_released",
  ).length;
  recordInvariant(assertions, "fan-in records one release transition", dependencyReleaseEvents, 1);

  const fanOut = MAX_JOB_DEPENDENTS;
  const fanOutQueue = operationalQueue(context.pool, `${context.queueName}-fan-out`);
  const fanOutPrerequisiteId = await fanOutQueue.enqueue("dependency-fan-out-prerequisite", null);
  const fanOutDependentIds = await fanOutQueue.enqueueMany(
    Array.from({ length: fanOut }, (_unused, index) => ({
      type: "dependency-fan-out-dependent",
      payload: { index },
      options: { prerequisiteJobId: fanOutPrerequisiteId },
    })),
  );
  const [, fanOutSettlementMs] = await measured(context.now, () =>
    fanOutQueue.cancel(fanOutPrerequisiteId, { requestedBy: "dependency-operations" }),
  );
  const fanOutStates = await Promise.all(
    fanOutDependentIds.map((jobId) => context.admin.getJob(jobId)),
  );
  recordInvariant(
    assertions,
    "wide fan-out terminal settlement cancels every dependent at the configured bound",
    fanOutStates.filter((job) => job?.state === "canceled").length,
    fanOut,
  );

  const contentionQueue = operationalQueue(context.pool, `${context.queueName}-contention`);
  const concurrentDependencyEnqueues = Math.max(
    2,
    Math.min(context.options.jobCount, MAX_JOB_DEPENDENTS),
  );
  const contentionPrerequisiteIds = await contentionQueue.enqueueMany(
    Array.from({ length: concurrentDependencyEnqueues }, (_unused, index) => ({
      type: "dependency-contention-prerequisite",
      payload: { index },
    })),
  );
  const contentionStarted = context.now();
  const contentionRequests = await Promise.all(
    Array.from({ length: concurrentDependencyEnqueues }, async (_unused, index) => {
      const [jobId, durationMs] = await measured(context.now, () =>
        contentionQueue.enqueue(
          "dependency-contention-dependent",
          { index },
          {
            prerequisiteJobId: contentionPrerequisiteIds[index]!,
          },
        ),
      );
      return { jobId, durationMs };
    }),
  );
  const concurrentDependencyEnqueueTotalMs = Math.max(0.001, context.now() - contentionStarted);
  recordInvariant(
    assertions,
    "concurrent disconnected dependency enqueue creates every requested edge without cross-component lock contention",
    new Set(contentionRequests.map((request) => request.jobId)).size,
    concurrentDependencyEnqueues,
  );
  await Promise.all(
    contentionPrerequisiteIds.map((prerequisiteId) =>
      contentionQueue.cancel(prerequisiteId, { requestedBy: "dependency-operations" }),
    ),
  );

  const cancellationPrerequisiteId = await queue.enqueue("dependency-cancel-prerequisite", null);
  const canceledDependentId = await queue.enqueue("dependency-cancel-dependent", null, {
    dependencies: {
      prerequisiteJobIds: [cancellationPrerequisiteId],
      onSuccess: "release",
      onFailure: "fail",
      onCancellation: "cancel",
    },
  });
  const [, cancellationResolutionMs] = await measured(context.now, () =>
    queue.cancel(cancellationPrerequisiteId, { requestedBy: "dependency-operations" }),
  );
  recordInvariant(
    assertions,
    "cancellation applies its declared terminal dependency policy",
    (await context.admin.getJob(canceledDependentId))?.state,
    "canceled",
  );

  const beforeQueueName = `${context.queueName}-plan-before`;
  const beforeQueue = operationalQueue(context.pool, beforeQueueName);
  await beforeQueue.enqueue("dependency-plan-ready", null);
  await context.pool.query("VACUUM (ANALYZE) workhorse.job_runtime");
  const claimPlanBeforeHistory = await claimPlan(
    context.pool,
    beforeQueueName,
    "dependency-plan-before",
  );

  const historyJobs = Math.max(1_000, context.options.jobCount * 100);
  const historyQueueName = `${context.queueName}-history`;
  const historyQueue = operationalQueue(context.pool, historyQueueName);
  await historyQueue.enqueueMany(
    Array.from({ length: historyJobs }, (_, index) => ({
      type: "dependency-plan-history",
      payload: { index },
    })),
  );
  for (let index = 0; index < historyJobs; index += 1) {
    const workerId = `dependency-history-${index}`;
    const job = await historyQueue.claim(workerId);
    if (job === null) throw new Error("dependency claim-plan history exhausted early");
    await historyQueue.complete(job, workerId, null);
  }

  const afterQueueName = `${context.queueName}-plan-after`;
  const afterQueue = operationalQueue(context.pool, afterQueueName);
  await afterQueue.enqueue("dependency-plan-ready", null);
  await context.pool.query("VACUUM (ANALYZE) workhorse.job_runtime");
  const claimPlanAfterHistory = await claimPlan(
    context.pool,
    afterQueueName,
    "dependency-plan-after",
  );
  recordInvariant(
    assertions,
    "claim buffer work stays bounded after retained terminal history grows",
    claimPlanAfterHistory.sharedBlocks <= claimPlanBeforeHistory.sharedBlocks * 2 + 8,
    true,
  );

  const health = await queue.health();
  recordInvariant(
    assertions,
    "health reports no blocked dependency after every cohort settles",
    health.dependencies.blockedJobs,
    0,
  );
  const retainedJobIdentities = await rowCount(context.pool, "job");
  return {
    name: "dependency-operations",
    durationMs: 0,
    metrics: {
      fanIn,
      fanInReleaseMs,
      fanOut,
      fanOutSettlementMs,
      concurrentDependencyEnqueues,
      concurrentDependencyEnqueueTotalMs,
      concurrentDependencyEnqueueP50Ms: percentile(
        contentionRequests.map((request) => request.durationMs),
        0.5,
      ),
      concurrentDependencyEnqueueP95Ms: percentile(
        contentionRequests.map((request) => request.durationMs),
        0.95,
      ),
      concurrentDependencyEnqueueThroughputPerSecond:
        concurrentDependencyEnqueues / (concurrentDependencyEnqueueTotalMs / 1_000),
      cancellationResolutionMs,
      claimPlanExecutionMsBeforeHistory: claimPlanBeforeHistory.executionTimeMs,
      claimPlanExecutionMsAfterHistory: claimPlanAfterHistory.executionTimeMs,
      claimPlanSharedBlocksBeforeHistory: claimPlanBeforeHistory.sharedBlocks,
      claimPlanSharedBlocksAfterHistory: claimPlanAfterHistory.sharedBlocks,
      retainedJobIdentities,
      historyJobs,
      dependencyReleaseEvents,
      dependencyFailedResolutions: health.dependencies.failedResolutions,
    },
    assertions,
  };
}

async function retentionPruning(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const queue = operationalQueue(context.pool, context.queueName);
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
    statisticsRetentionDays: 30,
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
  recordInvariant(assertions, "health snapshot is critical", health.status.level, "critical");
  recordInvariant(
    assertions,
    "health snapshot names the expired lease",
    health.status.reasons.some((reason) => reason.code === "expired-leases"),
    true,
  );
  recordInvariant(
    assertions,
    "health terminal counts uncapped",
    health.terminalCountsCapped,
    false,
  );
  recordInvariant(
    assertions,
    "health bucket count uncapped",
    health.statistics.bucketsCapped,
    false,
  );
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
  const queue = operationalQueue(context.pool, context.queueName);
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

  return {
    name: "health-snapshot",
    durationMs: 0,
    metrics: {
      readyDepth: health.readyDepth,
      scheduledDepth: health.scheduledDepth,
      activeLeases: health.activeLeases,
      expiredLeases: health.expiredLeases,
      statusLevel: health.status.level,
      reasonCodes: health.status.reasons.map((reason) => reason.code).join(","),
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
  const queue = operationalQueue(context.pool, context.queueName);
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
  const [snapshot, lookupMs] = await measured(context.now, () => context.admin.getJob(id));
  const completed = await queue.complete(job, "benchmark-progress", { ok: true });
  const terminal = await context.admin.getJob(id);
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
  const july2026ClaimStatementsPerCompletedJob = 1;

  metrics.concurrencyLevels = concurrencyLevels.join(",");
  metrics.jobsPerLevel = context.options.jobCount;
  metrics.handlerDelayMs = handlerDelayMs;
  metrics.leaseMs = leaseMs;
  metrics.heartbeatMs = heartbeatMs;
  metrics.pollMs = pollMs;
  metrics.pollingSchedulingSlack = pollingSchedulingSlack;
  metrics.july2026ClaimStatementsPerCompletedJob = july2026ClaimStatementsPerCompletedJob;

  for (const concurrency of concurrencyLevels) {
    await reset(context.pool);
    const seedQueue = operationalQueue(context.pool, context.queueName);
    for (let index = 0; index < context.options.jobCount; index += 1) {
      await seedQueue.enqueue("concurrency-throughput", { index });
    }

    let worker!: Worker;
    const probe = new QueryPressureProbe(
      context.pool,
      () => concurrency - worker.runtimeState().activeSlots,
    );
    worker = new Worker(operationalQueue(probe, context.queueName), {
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
    const nullClaimCalls = afterTiming.emptyClaimCalls - beforeTiming.emptyClaimCalls;
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
    metrics[`${prefix}ClaimStatementsPerCompletedJob`] = claimCalls / context.options.jobCount;
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
    if (concurrency === 8) {
      recordInvariant(
        assertions,
        `${prefix} improves on the 2026-07-22 claim-statement baseline`,
        claimCalls / context.options.jobCount,
        july2026ClaimStatementsPerCompletedJob,
        (actual, expected) => Number(actual) < Number(expected),
      );
    }
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
      afterTiming.heartbeatJobs - beforeTiming.heartbeatJobs,
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
      const queue = operationalQueue(context.pool, context.queueName);
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
        const worker = new Worker(operationalQueue(probe, context.queueName), {
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
  const firstNullQueue = operationalQueue(context.pool, context.queueName);
  await firstNullQueue.enqueue("first-null", { only: true });
  const firstNullProbe = new QueryPressureProbe(context.pool);
  const firstNullWorker = new Worker(operationalQueue(firstNullProbe, context.queueName), {
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
    "first-null run batches the job and empty result",
    firstNullPressure.claimCalls,
    1,
  );
  recordInvariant(
    assertions,
    "first-null claims remain serial",
    firstNullPressure.maxConcurrentClaims,
    1,
  );

  await reset(context.pool);
  const pauseQueue = operationalQueue(context.pool, context.queueName);
  await pauseQueue.enqueue("pause-guard", { paused: true });
  const pauseProbe = new QueryPressureProbe(context.pool);
  const pauseWorker = new Worker(operationalQueue(pauseProbe, context.queueName), {
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
  const shutdownQueue = operationalQueue(context.pool, context.queueName);
  for (let index = 0; index < shutdownJobs; index += 1) {
    await shutdownQueue.enqueue("shutdown-drain", { index });
  }
  const shutdownProbe = new QueryPressureProbe(context.pool);
  const shutdownWorker = new Worker(operationalQueue(shutdownProbe, context.queueName), {
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
    "stop fills configured active slots in one claim statement",
    claimsAtStop,
    1,
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

async function batchDispatch(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  const assertions: ScenarioAssertion[] = [];
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  const metricSdkInstalled = otelMetrics.setGlobalMeterProvider(meterProvider);
  const batchMaxSize = Math.max(2, Math.min(8, context.options.batchSize));
  const jobsPerCohort = Math.max(
    batchMaxSize,
    Math.ceil(context.options.jobCount / batchMaxSize) * batchMaxSize,
  );
  const partialJobsPerCohort = batchMaxSize - 1;
  const leaseMs = Math.max(1_000, context.options.leaseMs * 4);
  const heartbeatMs = Math.max(50, Math.floor(leaseMs / 3));

  const runCohort = async (
    mode: "batch" | "serial",
    cohort: "full" | "mixed" | "partial",
    cohortJobs: number,
    lingerMs: number,
  ) => {
    const mixedOutcomes = cohort === "mixed";
    await reset(context.pool);
    const cohortQueueName = `${context.queueName}-${mode}-${cohort}`;
    const seedQueue = operationalQueue(context.pool, cohortQueueName);
    const jobIds = await seedQueue.enqueueMany(
      Array.from({ length: cohortJobs }, (_, index) => ({
        type: "batch-dispatch",
        payload: { index },
        options: { maxAttempts: 1 },
      })),
    );
    let worker!: Worker;
    const probe = new QueryPressureProbe(
      context.pool,
      () => batchMaxSize - worker.runtimeState().activeSlots,
    );
    worker = new Worker(operationalQueue(probe, cohortQueueName), {
      concurrency: batchMaxSize,
      workerId: `benchmark-batch-${mode}`,
      leaseMs,
      heartbeatMs,
      pollMs: 10,
      registryIntervalMs: 0,
    });
    let completedMembers = 0;
    let maxActiveSlots = 0;
    let consumedClaimTimes = 0;
    const batchSizes: number[] = [];
    const batchLingerMs: number[] = [];

    if (mode === "serial") {
      worker.handle<{ index: number }, { ok: boolean }>("batch-dispatch", ({ index }) => {
        completedMembers += 1;
        maxActiveSlots = Math.max(maxActiveSlots, worker.runtimeState().activeSlots);
        if (completedMembers === cohortJobs) worker.stop();
        if (mixedOutcomes && index === 1) throw new Error("expected mixed failure");
        return { ok: true };
      });
    } else {
      worker.handleBatch<{ index: number }, { ok: boolean }>(
        "batch-dispatch",
        { maxSize: batchMaxSize, lingerMs },
        (items) => {
          const claimTimes = probe.snapshot().successfulClaimTimes;
          const firstClaimAt = claimTimes[consumedClaimTimes];
          if (firstClaimAt !== undefined) {
            batchLingerMs.push(Math.max(0, performance.now() - firstClaimAt));
          }
          consumedClaimTimes += items.length;
          batchSizes.push(items.length);
          completedMembers += items.length;
          maxActiveSlots = Math.max(maxActiveSlots, worker.runtimeState().activeSlots);
          if (completedMembers === cohortJobs) worker.stop();
          return items.map(({ payload }) =>
            mixedOutcomes && payload.index === 1
              ? { status: "failed" as const, error: new Error("expected mixed failure") }
              : { status: "succeeded" as const, result: { ok: true } },
          );
        },
      );
    }

    const before = probe.snapshot();
    const started = context.now();
    await worker.run();
    const durationMs = Math.max(0.001, context.now() - started);
    const after = probe.snapshot();
    const health = await seedQueue.health();
    const outcomes = await rowCount(context.pool, "job_outcome");
    const states = await Promise.all(jobIds.map((id) => context.admin.getJob(id)));
    return {
      durationMs,
      jobsPerSecond: (cohortJobs * 1_000) / durationMs,
      completedMembers,
      outcomes,
      succeeded: states.filter((job) => job?.state === "succeeded").length,
      failed: states.filter((job) => job?.state === "failed").length,
      health,
      maxActiveSlots,
      batchSizes,
      batchLingerMs,
      claimCalls: after.claimCalls - before.claimCalls,
      claimDurationsMs: after.claimDurationsMs.slice(before.claimDurationsMs.length),
      claimedJobs: after.claimedJobs - before.claimedJobs,
      maxConcurrentClaims: after.maxConcurrentClaims,
      claimsWithoutFreeSlot: after.claimsWithoutFreeSlot - before.claimsWithoutFreeSlot,
    };
  };

  const serial = await runCohort("serial", "full", jobsPerCohort, 60_000);
  const batched = await runCohort("batch", "full", jobsPerCohort, 60_000);
  const serialPartial = await runCohort("serial", "partial", partialJobsPerCohort, 20);
  const batchedPartial = await runCohort("batch", "partial", partialJobsPerCohort, 20);
  const fullBatches = batched.batchSizes.filter((size) => size === batchMaxSize).length;
  const partialBatches = batchedPartial.batchSizes.filter((size) => size < batchMaxSize).length;

  for (const [name, cohort] of [
    ["serial", serial],
    ["batch", batched],
  ] as const) {
    recordInvariant(
      assertions,
      `${name} cohort completes every member`,
      cohort.completedMembers,
      jobsPerCohort,
    );
    recordInvariant(
      assertions,
      `${name} cohort persists every outcome`,
      cohort.outcomes,
      jobsPerCohort,
    );
    recordInvariant(assertions, `${name} cohort leaves no ready jobs`, cohort.health.readyDepth, 0);
    recordInvariant(
      assertions,
      `${name} cohort leaves no active leases`,
      cohort.health.activeLeases,
      0,
    );
    recordInvariant(
      assertions,
      `${name} cohort leaves no expired leases`,
      cohort.health.expiredLeases,
      0,
    );
    recordInvariant(
      assertions,
      `${name} cohort claim execution remains serial`,
      cohort.maxConcurrentClaims,
      1,
    );
    recordInvariant(
      assertions,
      `${name} cohort claim execution occurs only with free slots`,
      cohort.claimsWithoutFreeSlot,
      0,
    );
    recordInvariant(
      assertions,
      `${name} cohort claimed job count matches jobs`,
      cohort.claimedJobs,
      jobsPerCohort,
    );
    recordInvariant(
      assertions,
      `${name} cohort claim cost samples are finite`,
      cohort.claimDurationsMs.length === cohort.claimCalls &&
        cohort.claimCalls > 0 &&
        cohort.claimDurationsMs.every(Number.isFinite),
      true,
    );
  }
  recordInvariant(assertions, "batch cohort dispatches a full batch", fullBatches > 0, true);
  recordInvariant(
    assertions,
    "serial and batch partial cohorts complete the same jobs",
    serialPartial.completedMembers === partialJobsPerCohort &&
      batchedPartial.completedMembers === partialJobsPerCohort &&
      serialPartial.outcomes === partialJobsPerCohort &&
      batchedPartial.outcomes === partialJobsPerCohort,
    true,
  );
  recordInvariant(assertions, "batch partial cohort dispatches one group", partialBatches, 1);
  recordInvariant(
    assertions,
    "batch partial cohort leaves no active or expired leases",
    batchedPartial.health.activeLeases === 0 && batchedPartial.health.expiredLeases === 0,
    true,
  );
  recordInvariant(
    assertions,
    "batch active slots remain bounded by member capacity",
    batched.maxActiveSlots,
    batchMaxSize,
    (actual, expected) => Number(actual) > 0 && Number(actual) <= Number(expected),
  );

  const serialMixed = await runCohort("serial", "mixed", jobsPerCohort, 60_000);
  const batchedMixed = await runCohort("batch", "mixed", jobsPerCohort, 60_000);
  recordInvariant(
    assertions,
    "serial and batch mixed cohorts isolate one failure equally",
    serialMixed.failed === 1 &&
      batchedMixed.failed === 1 &&
      serialMixed.succeeded === jobsPerCohort - 1 &&
      batchedMixed.succeeded === jobsPerCohort - 1,
    true,
  );

  const runPolicyCohort = async (policy: "concurrency" | "rate") => {
    await reset(context.pool);
    const policyQueueName = `${context.queueName}-policy-${policy}`;
    const policyQueue = operationalQueue(context.pool, policyQueueName);
    if (policy === "concurrency") {
      await policyQueue.syncConcurrencyPolicies("batch-benchmark", [
        { queue: policyQueueName, maxActive: 2 },
      ]);
    } else {
      await policyQueue.syncRateLimitPolicies("batch-benchmark", [
        { queue: policyQueueName, rate: { limit: 2, intervalMs: 60_000, burst: 2 } },
      ]);
    }
    await policyQueue.enqueueMany(
      Array.from({ length: batchMaxSize + 1 }, (_, index) => ({
        type: "batch-policy",
        payload: { index },
      })),
    );
    let admittedJobs = 0;
    let maxActiveSlots = 0;
    let policyWorker!: Worker;
    policyWorker = new Worker(policyQueue, {
      queue: policyQueueName,
      concurrency: batchMaxSize,
      workerId: `benchmark-batch-policy-${policy}`,
      leaseMs,
      heartbeatMs,
      registryIntervalMs: 0,
    }).handleBatch<{ index: number }, null>(
      "batch-policy",
      { maxSize: batchMaxSize, lingerMs: 20 },
      (items) => {
        admittedJobs += items.length;
        maxActiveSlots = Math.max(maxActiveSlots, policyWorker.runtimeState().activeSlots);
        return items.map(() => ({ status: "succeeded", result: null }));
      },
    );
    await policyWorker.runOnce();
    return {
      admittedJobs,
      maxActiveSlots,
      health: await policyQueue.health(),
      rateStatus:
        policy === "rate" ? (await policyQueue.rateLimitStatuses([policyQueueName]))[0]! : null,
    };
  };

  const concurrencyPolicy = await runPolicyCohort("concurrency");
  const ratePolicy = await runPolicyCohort("rate");
  recordInvariant(
    assertions,
    "concurrency policy admits one member for each active count",
    concurrencyPolicy.admittedJobs,
    2,
  );
  recordInvariant(
    assertions,
    "concurrency policy admission occupies one slot per member",
    concurrencyPolicy.maxActiveSlots,
    2,
  );
  recordInvariant(
    assertions,
    "concurrency-limited members remain ready",
    concurrencyPolicy.health.readyDepth,
    batchMaxSize - 1,
  );
  recordInvariant(
    assertions,
    "rate policy admits one member for each available token",
    ratePolicy.admittedJobs,
    2,
  );
  recordInvariant(
    assertions,
    "rate policy status exposes the throttled remainder",
    ratePolicy.rateStatus!.throttledReady,
    batchMaxSize - 1,
  );

  await reset(context.pool);
  const recoveryQueueName = `${context.queueName}-recovery`;
  const recoveryQueue = operationalQueue(context.pool, recoveryQueueName);
  const staleId = await recoveryQueue.enqueue(
    "batch-recovery",
    { member: "stale" },
    { maxAttempts: 2 },
  );
  const peerId = await recoveryQueue.enqueue("batch-recovery", { member: "peer" });
  const recoveryWorkerId = "benchmark-batch-recovery";
  let staleClaim: ClaimedJob | undefined;
  let recoveredMembers = 0;
  let replacementFenceAdvanced = false;
  const recoveryWorker = new Worker(recoveryQueue, {
    queue: recoveryQueueName,
    concurrency: 2,
    workerId: recoveryWorkerId,
    leaseMs,
    heartbeatMs: leaseMs - 1,
    registryIntervalMs: 0,
  }).handleBatch<{ member: string }, { source: string }>(
    "batch-recovery",
    { maxSize: 2, lingerMs: 20 },
    async (items) => {
      staleClaim = items.find(({ payload }) => payload.member === "stale")!.context.job;
      await context.pool.query(
        `UPDATE workhorse.job_runtime
            SET expires_at = clock_timestamp() - interval '1 millisecond'
          WHERE job_id = $1 AND state = 'active'`,
        [staleId],
      );
      recoveredMembers = await recoveryQueue.recoverExpired(100, 0);
      const replacement = await recoveryQueue.claim("benchmark-batch-reclaimer", {
        queue: recoveryQueueName,
        leaseMs,
      });
      replacementFenceAdvanced =
        replacement?.id === staleId && replacement.fenceToken > staleClaim.fenceToken;
      if (replacement === null) throw new Error("batch recovery failed to reclaim its member");
      await recoveryQueue.complete(replacement, "benchmark-batch-reclaimer", {
        source: "recovered",
      });
      return items.map(() => ({ status: "succeeded", result: { source: "handler" } }));
    },
  );
  await recoveryWorker.runOnce();
  const staleCompletionAccepted = await recoveryQueue.complete(staleClaim!, recoveryWorkerId, {
    source: "stale",
  });
  const [recoveredJob, peerJob, recoveryHealth] = await Promise.all([
    context.admin.getJob<{ source: string }>(staleId),
    context.admin.getJob<{ source: string }>(peerId),
    recoveryQueue.health(),
  ]);
  recordInvariant(
    assertions,
    "recovery advances only the lost member fence",
    replacementFenceAdvanced,
    true,
  );
  recordInvariant(
    assertions,
    "recovery rejects the stale member completion",
    staleCompletionAccepted,
    false,
  );
  recordInvariant(
    assertions,
    "recovery preserves the peer outcome",
    recoveredJob?.state === "succeeded" &&
      recoveredJob.currentAttempt === 2 &&
      recoveredJob.result?.source === "recovered" &&
      peerJob?.state === "succeeded" &&
      peerJob.currentAttempt === 1 &&
      peerJob.result?.source === "handler",
    true,
  );
  recordInvariant(assertions, "recovery leaves no active leases", recoveryHealth.activeLeases, 0);
  recordInvariant(assertions, "recovery leaves no expired leases", recoveryHealth.expiredLeases, 0);

  const planLiveJobs = jobsPerCohort;
  const historyJobs = jobsPerCohort * 4;
  const seedPlanReady = async (targetQueueName: string) => {
    const targetQueue = operationalQueue(context.pool, targetQueueName);
    await targetQueue.enqueueMany(
      Array.from({ length: planLiveJobs }, (_, index) => ({
        type: "batch-plan-live",
        payload: { index },
      })),
    );
  };

  await reset(context.pool);
  const planQueueName = `${context.queueName}-plan`;
  await seedPlanReady(planQueueName);
  const claimPlanBeforeHistory = await claimPlan(
    context.pool,
    planQueueName,
    "benchmark-batch-plan-before-history",
  );

  await reset(context.pool);
  const historyQueueName = `${context.queueName}-history`;
  const historyQueue = operationalQueue(context.pool, historyQueueName);
  await historyQueue.enqueueMany(
    Array.from({ length: historyJobs }, (_, index) => ({
      type: "batch-plan-history",
      payload: { index },
    })),
  );
  for (let index = 0; index < historyJobs; index += 1) {
    const workerId = `benchmark-batch-history-${index}`;
    const job = await historyQueue.claim(workerId);
    if (job === null) throw new Error("batch claim-plan history exhausted early");
    await historyQueue.complete(job, workerId, null);
  }
  await seedPlanReady(planQueueName);
  await context.pool.query("VACUUM (ANALYZE) workhorse.job_runtime");
  const claimPlanAfterHistory = await claimPlan(
    context.pool,
    planQueueName,
    "benchmark-batch-plan-after-history",
  );
  const retainedJobIdentities = await rowCount(context.pool, "job");
  const liveRuntimeRows = await rowCount(context.pool, "job_runtime");
  recordInvariant(
    assertions,
    "batch claim plans record shared buffer work",
    claimPlanBeforeHistory.sharedBlocks > 0 && claimPlanAfterHistory.sharedBlocks > 0,
    true,
  );
  recordInvariant(
    assertions,
    "batch claim buffer work stays bounded after retained history grows",
    claimPlanAfterHistory.sharedBlocks <= claimPlanBeforeHistory.sharedBlocks * 2,
    true,
  );
  recordInvariant(assertions, "claim-plan live runtime stays fixed", liveRuntimeRows, planLiveJobs);
  recordInvariant(
    assertions,
    "claim-plan history remains outside live runtime",
    retainedJobIdentities,
    historyJobs + planLiveJobs,
  );

  await meterProvider.forceFlush();
  const exportedMetrics = metricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics);
  const batchSizePoints =
    exportedMetrics.find((metric) => metric.descriptor.name === "workhorse.handler.batch.size")
      ?.dataPoints ?? [];
  const batchLingerPoints =
    exportedMetrics.find((metric) => metric.descriptor.name === "workhorse.handler.batch.linger")
      ?.dataPoints ?? [];
  const expectedBatchAttributeNames = [
    "workhorse.handler.batch.full",
    "workhorse.job.type",
    "workhorse.queue.name",
  ];
  const boundedBatchAttributes = batchSizePoints.every((point) =>
    // oxlint-disable-next-line unicorn/no-array-sort -- Object.keys returns a fresh array.
    jsonEquivalent(Object.keys(point.attributes).sort(), expectedBatchAttributeNames),
  );
  const batchTelemetrySeries = batchSizePoints.length;
  recordInvariant(
    assertions,
    "batch metric SDK installs for the scenario",
    metricSdkInstalled,
    true,
  );
  recordInvariant(
    assertions,
    "batch size telemetry distinguishes full and partial dispatch",
    batchSizePoints.some((point) => point.attributes["workhorse.handler.batch.full"] === true) &&
      batchSizePoints.some((point) => point.attributes["workhorse.handler.batch.full"] === false),
    true,
  );
  recordInvariant(
    assertions,
    "batch linger telemetry covers every bounded size series",
    batchLingerPoints.length,
    batchTelemetrySeries,
  );
  recordInvariant(
    assertions,
    "batch telemetry uses only bounded diagnostic attributes",
    boundedBatchAttributes,
    true,
  );
  await meterProvider.shutdown();
  otelMetrics.disable();

  return {
    name: "batch-dispatch",
    durationMs: 0,
    metrics: {
      jobsPerCohort,
      partialJobsPerCohort,
      batchMaxSize,
      serialJobsPerSecond: serial.jobsPerSecond,
      batchJobsPerSecond: batched.jobsPerSecond,
      fullBatches,
      partialBatches,
      batchSizeP50: percentile([...batched.batchSizes, ...batchedPartial.batchSizes], 0.5),
      batchLingerP95Ms: percentile(
        [...batched.batchLingerMs, ...batchedPartial.batchLingerMs],
        0.95,
      ),
      serialClaimP95Ms: percentile(serial.claimDurationsMs, 0.95),
      batchClaimP95Ms: percentile(batched.claimDurationsMs, 0.95),
      serialClaimCalls: serial.claimCalls,
      batchClaimCalls: batched.claimCalls,
      serialPartialJobsPerSecond: serialPartial.jobsPerSecond,
      batchPartialJobsPerSecond: batchedPartial.jobsPerSecond,
      batchMaxActiveSlots: batched.maxActiveSlots,
      batchTelemetrySeries,
      batchTelemetryAttributeCount: expectedBatchAttributeNames.length,
      concurrencyPolicyAdmittedJobs: concurrencyPolicy.admittedJobs,
      concurrencyPolicyMaxActiveSlots: concurrencyPolicy.maxActiveSlots,
      concurrencyPolicyReady: concurrencyPolicy.health.readyDepth,
      ratePolicyAdmittedJobs: ratePolicy.admittedJobs,
      ratePolicyThrottledReady: ratePolicy.rateStatus!.throttledReady,
      serialMixedSucceeded: serialMixed.succeeded,
      serialMixedFailed: serialMixed.failed,
      batchMixedSucceeded: batchedMixed.succeeded,
      batchMixedFailed: batchedMixed.failed,
      recoveredMembers,
      replacementFenceAdvanced,
      claimPlanExecutionMsBeforeHistory: claimPlanBeforeHistory.executionTimeMs,
      claimPlanExecutionMsAfterHistory: claimPlanAfterHistory.executionTimeMs,
      claimPlanSharedBlocksBeforeHistory: claimPlanBeforeHistory.sharedBlocks,
      claimPlanSharedBlocksAfterHistory: claimPlanAfterHistory.sharedBlocks,
      retainedJobIdentities,
      liveRuntimeRows,
    },
    assertions,
  };
}

async function rateLimiting(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const assertions: ScenarioAssertion[] = [];
  const queue = operationalQueue(context.pool, context.queueName);
  const intervalMs = 100;
  const burst = 2;
  await queue.syncRateLimitPolicies("benchmark", [
    {
      queue: context.queueName,
      rate: { limit: 1, intervalMs, burst },
    },
  ]);
  for (let ordinal = 0; ordinal < burst + 1; ordinal += 1) {
    await queue.enqueue("rate-limiting", { ordinal });
  }

  const competing = await Promise.all([
    queue.claim("rate-burst-a"),
    queue.claim("rate-burst-b"),
    queue.claim("rate-burst-c"),
  ]);
  const burstClaims = competing.filter((claim) => claim !== null).length;
  const status = (await queue.rateLimitStatuses([context.queueName]))[0]!;
  const nextEligibilityDelayMs = Math.max(
    0,
    (status.nextEligibleAt?.getTime() ?? Date.now()) - Date.now(),
  );
  recordInvariant(assertions, "burst admits exactly its capacity", burstClaims, burst);
  recordInvariant(assertions, "empty bucket leaves one ready job", status.throttledReady, 1);
  recordInvariant(
    assertions,
    "throttling reports future eligibility",
    status.nextEligibleAt !== null,
    true,
  );

  const refillStarted = context.now();
  await context.sleep(intervalMs + 10);
  const refillWaitMs = Math.max(0, context.now() - refillStarted);
  const [refilled, refilledClaimMs] = await measured(context.now, () =>
    queue.claim("rate-refilled"),
  );
  recordInvariant(assertions, "elapsed database time restores one start", refilled !== null, true);

  return {
    name: "rate-limiting",
    durationMs: 0,
    metrics: {
      burstClaims,
      throttledReady: status.throttledReady,
      nextEligibilityDelayMs,
      refillWaitMs,
      refilledClaimMs,
    },
    assertions,
  };
}

async function notificationDispatch(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  const assertions: ScenarioAssertion[] = [];
  const idleWindowMs = 400;
  const pollingFallbackMs = 100;
  const notificationFallbackMs = 5_000;

  const runCohort = async (notifications: boolean) => {
    await reset(context.pool);
    const seedQueue = operationalQueue(context.pool, context.queueName);
    const probe = new QueryPressureProbe(context.pool);
    const pollingDatabase: Queryable = { query: probe.query.bind(probe) };
    const connect = (context.pool as Queryable & { connect?: () => Promise<unknown> }).connect;
    if (notifications && typeof connect !== "function") {
      throw new TypeError("Notification dispatch benchmark requires a connect-capable pool");
    }
    const notificationDatabase: Queryable & { connect?: () => Promise<unknown> } = {
      query: probe.query.bind(probe),
      ...(connect === undefined ? {} : { connect: () => connect.call(context.pool) }),
    };
    const workerQueue = operationalQueue(
      notifications ? notificationDatabase : pollingDatabase,
      context.queueName,
    );
    let handled = false;
    const worker = new Worker(workerQueue, {
      workerId: `benchmark-notification-${notifications ? "assisted" : "polling"}`,
      pollMs: notifications ? notificationFallbackMs : pollingFallbackMs,
      registryIntervalMs: 0,
    }).handle("notification-dispatch", () => {
      handled = true;
      return null;
    });

    const running = worker.run();
    try {
      await waitFor(() => probe.snapshot().claimCalls > 0, "initial empty notification claim");
      await context.sleep(20);
      const beforeIdle = probe.snapshot();
      await context.sleep(idleWindowMs);
      const afterIdle = probe.snapshot();
      const enqueuedAt = context.now();
      await seedQueue.enqueue("notification-dispatch", null);
      await waitFor(() => handled, "notification benchmark handler");
      const completed = probe.snapshot();
      return {
        handled,
        idleClaimCalls: afterIdle.claimCalls - beforeIdle.claimCalls,
        enqueueToClaimMs: Math.max(
          0,
          (completed.lastSuccessfulClaimAt ?? context.now()) - enqueuedAt,
        ),
        enqueueToHandlerMs: Math.max(0, context.now() - enqueuedAt),
      };
    } finally {
      worker.stop();
      await running;
    }
  };

  const polling = await runCohort(false);
  const notification = await runCohort(true);
  recordInvariant(assertions, "polling-only dispatch executes the job", polling.handled, true);
  recordInvariant(
    assertions,
    "notification-assisted dispatch executes the job",
    notification.handled,
    true,
  );
  recordInvariant(
    assertions,
    "notification assistance reduces idle empty claims",
    notification.idleClaimCalls < polling.idleClaimCalls,
    true,
  );
  recordInvariant(
    assertions,
    "notification fallback remains bounded",
    notificationFallbackMs,
    5_000,
  );

  return {
    name: "notification-dispatch",
    durationMs: 0,
    metrics: {
      idleWindowMs,
      pollingFallbackMs,
      notificationFallbackMs,
      pollingIdleClaimCalls: polling.idleClaimCalls,
      notificationIdleClaimCalls: notification.idleClaimCalls,
      pollingEnqueueToClaimMs: polling.enqueueToClaimMs,
      notificationEnqueueToClaimMs: notification.enqueueToClaimMs,
      pollingEnqueueToHandlerMs: polling.enqueueToHandlerMs,
      notificationEnqueueToHandlerMs: notification.enqueueToHandlerMs,
    },
    assertions,
  };
}

async function drainTelemetryContextQueue(
  queue: Queue,
  workerId: string,
): Promise<ClaimedJob<{ index: number }>[]> {
  const claimed: ClaimedJob<{ index: number }>[] = [];
  while (true) {
    const job = await queue.claim<{ index: number }>(workerId);
    if (job === null) return claimed;
    claimed.push(job);
    await queue.complete(job, workerId, { ok: true });
  }
}

async function telemetryContext(
  context: OperationalScenarioContext,
): Promise<OperationalScenarioResult> {
  await reset(context.pool);
  const assertions: ScenarioAssertion[] = [];
  const jobsPerCohort = context.options.jobCount;
  const baselineQueue = `${context.queueName}-baseline`;
  const instrumentedQueue = `${context.queueName}-instrumented`;
  const baseline = operationalQueue(context.pool, baselineQueue);
  const instrumented = operationalQueue(context.pool, instrumentedQueue);
  const requests = Array.from({ length: jobsPerCohort }, (_, index) => ({
    type: "telemetry-context",
    payload: { index },
  }));

  const baselineEnqueueStarted = context.now();
  const baselineIds = await baseline.enqueueMany(requests);
  const baselineEnqueueMs = context.now() - baselineEnqueueStarted;
  const baselineClaimStarted = context.now();
  const baselineClaims = await drainTelemetryContextQueue(baseline, "telemetry-baseline");
  const baselineClaimMs = context.now() - baselineClaimStarted;

  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const sdkInstalled = [
    otelContext.setGlobalContextManager(contextManager),
    propagation.setGlobalPropagator(new W3CTraceContextPropagator()),
    otelMetrics.setGlobalMeterProvider(meterProvider),
    trace.setGlobalTracerProvider(tracerProvider),
  ].every(Boolean);

  const instrumentedEnqueueStarted = context.now();
  const instrumentedIds = await instrumented.enqueueMany(requests);
  const instrumentedEnqueueMs = context.now() - instrumentedEnqueueStarted;
  const instrumentedClaimStarted = context.now();
  const instrumentedClaims = await drainTelemetryContextQueue(
    instrumented,
    "telemetry-instrumented",
  );
  const instrumentedClaimMs = context.now() - instrumentedClaimStarted;
  await tracerProvider.forceFlush();
  await meterProvider.forceFlush();
  const exportedSpans = spanExporter.getFinishedSpans().length;
  const exportedMetrics = metricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics).length;
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
  contextManager.disable();
  otelContext.disable();
  propagation.disable();
  trace.disable();
  otelMetrics.disable();
  const indexes = await context.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_indexes
      WHERE schemaname = 'workhorse' AND indexdef ILIKE '%trace_context%'`,
  );
  const traceContextIndexes = Number(indexes.rows[0]?.count ?? 0);

  recordInvariant(assertions, "baseline cohort accepted", baselineIds.length, jobsPerCohort);
  recordInvariant(
    assertions,
    "instrumented cohort accepted",
    instrumentedIds.length,
    jobsPerCohort,
  );
  recordInvariant(assertions, "baseline cohort completed", baselineClaims.length, jobsPerCohort);
  recordInvariant(
    assertions,
    "instrumented cohort completed",
    instrumentedClaims.length,
    jobsPerCohort,
  );
  recordInvariant(
    assertions,
    "baseline claims omit trace context",
    baselineClaims.every((job) => job.traceContext === null),
    true,
  );
  recordInvariant(
    assertions,
    "instrumented claims retain trace context",
    instrumentedClaims.every((job) => job.traceContext?.traceparent !== undefined),
    true,
  );
  recordInvariant(assertions, "OpenTelemetry SDK installed", sdkInstalled, true);
  recordInvariant(assertions, "instrumented spans exported", exportedSpans > 0, true);
  recordInvariant(assertions, "instrumented metrics exported", exportedMetrics > 0, true);
  recordInvariant(
    assertions,
    "payloads remain unchanged",
    instrumentedClaims.every((job, index) => job.payload.index === index),
    true,
  );
  recordInvariant(assertions, "trace context adds no index", traceContextIndexes, 0);

  return {
    name: "telemetry-context",
    durationMs: 0,
    metrics: {
      jobsPerCohort,
      baselineEnqueueMs,
      instrumentedEnqueueMs,
      baselineClaimMs,
      instrumentedClaimMs,
      exportedSpans,
      exportedMetrics,
      traceContextIndexes,
    },
    assertions,
  };
}

const operationalScenarioImplementations: Readonly<
  Record<OperationalScenarioName, OperationalScenarioRunner>
> = {
  "scheduled-promotion-drift": scheduledPromotionDrift,
  "schedule-cadence-jitter": scheduleCadenceJitter,
  "heartbeat-fencing": heartbeatFencing,
  "priority-dispatch": priorityDispatch,
  "cancellation-lifecycle": cancellationLifecycle,
  "deadline-timeout-lifecycle": deadlineTimeoutLifecycle,
  "dead-letter-redrive-lifecycle": deadLetterRedriveLifecycle,
  "query-listing-lifecycle": queryListingLifecycle,
  "progress-lifecycle": progressLifecycle,
  "crash-before-completion": crashBeforeCompletion,
  "lease-expiry-recovery": leaseExpiryRecovery,
  "retry-paths": retryPaths,
  "idempotent-ingress": idempotentIngress,
  "coalescing-ingress": coalescingIngress,
  "dependency-operations": dependencyOperations,
  "retention-pruning": retentionPruning,
  "health-snapshot": healthSnapshot,
  "worker-concurrency": workerConcurrency,
  "batch-dispatch": batchDispatch,
  "rate-limiting": rateLimiting,
  "notification-dispatch": notificationDispatch,
  "telemetry-context": telemetryContext,
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
      admin: new Admin(pool, queueName(resolved.queuePrefix, name)),
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
