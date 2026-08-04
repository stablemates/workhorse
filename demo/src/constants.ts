import type { RetryPolicy } from "@workhorse/core";

/**
 * Shared demo constants.
 *
 * The dedicated worker process and the web tier are separate programs that must agree on queue
 * names, job types, schedule names, and worker identities, so those values live here rather than
 * inside either one.
 */

export const ORDER_JOB_TYPE = "order.process";
export const RETRY_JOB_TYPE = "demo.retry";
export const RETRY_CHECKPOINT_NAME = "reserve-capacity";
export const FAILURE_JOB_TYPE = "demo.failure";
export const LONG_RUNNING_JOB_TYPE = "demo.long-running";
export const TIMING_JOB_TYPE = "demo.timing-policy";
export const DURABLE_TIMER_JOB_TYPE = "demo.durable-timer";
export const DURABLE_TIMER_PREPARE_CHECKPOINT = "prepare-publication";
export const DURABLE_TIMER_WAIT_NAME = "publication-delay";
export const DURABLE_TIMER_PUBLISH_CHECKPOINT = "publish-after-wait";
export const RECURRING_JOB_TYPE = "demo.recurring";
export const REPORT_JOB_TYPE = "demo.report";
export const DEMO_QUEUE = "demo";
export const REPRESENTATIVE_SEED_NAME = "default-dashboard-v8";
export const LONG_RUNNING_SEED_NAME = "long-running-dashboard-v1";
export const HISTORICAL_SEED_NAME = "historical-dashboard-v1";
export const HISTORICAL_JOB_COUNT = 362;
export const DEMO_WORKER_POLL_MS = 15_000;
/**
 * Declared execution slots for the demo's two workers.
 *
 * The values are deliberately different so the dashboard shows a heterogeneous fleet: one worker
 * overlaps handlers while the other stays strictly serial. Concurrency is configuration, not a
 * runtime control, so nothing mutates it.
 *
 * The demo deliberately does **not** name its workers. Real deployments rarely do either, so
 * letting the default `<hostname>-<pid>-<random>` identity apply keeps the demo an honest picture
 * of what an operator actually sees: a fleet discovered from PostgreSQL rather than a list the web
 * tier was told about in advance.
 */
export const DEMO_WORKER_CONCURRENCY = [3, 1] as const;
/**
 * Worker identities attached to the seeded historical attempts.
 *
 * Seeded history describes runs that already finished, so it references workers that no longer
 * exist — exactly what real retained history looks like after a few deployments. These are shaped
 * like generated identities and never match a live worker.
 */
export const HISTORICAL_WORKER_IDS = [
  "demo-host-a-4821-9f3c1a02",
  "demo-host-b-5177-2be40d17",
] as const;
export const DEMO_MAINTENANCE_INTERVAL_MS = 1_000;
/**
 * How often a demo worker refreshes its durable registration.
 *
 * Reported slot use and operator pause both travel through this cadence, so the demo keeps it
 * short enough that the workers view tracks overlapping handlers as they happen. Production
 * defaults are deliberately slower.
 */
export const DEMO_REGISTRY_INTERVAL_MS = 250;
export const DEMO_MAINTENANCE_TASK_POLL_MS = 60_000;
export const DEMO_LONG_RUNNING_MS = 20_000;
export const DEMO_LONG_RUNNING_SEED_DELAY_MS = 10_000;
export const DEMO_TIMING_TIMEOUT_MS = 1_000;
export const DEMO_TIMING_HANDLER_MS = 5_000;
export const DEMO_TIMING_POLICY_TIMEOUT_MS = 90_000;
export const DEMO_LONG_RUNNING_SEED_JOBS = [
  { label: "archive-validation" },
  { label: "partner-catalog-sync" },
  { label: "quarterly-report-export" },
] as const;
export const DEMO_DURABLE_STEP_MS = 2_000;
export const DEMO_DURABLE_TIMER_WAIT_MS = 10_000;
export const DEMO_PERSISTENT_RETRY_DELAYS_MS = [5 * 60_000, 7 * 60_000, 10 * 60_000] as const;
/**
 * One persisted policy per intentionally failing seed. Each policy is chosen so the first
 * scheduled retry lands in the same 5, 7, and 10 minute analytic window the demo has always
 * shown, while PostgreSQL, not the worker, now owns the delay.
 */
export const DEMO_PERSISTENT_RETRY_POLICIES: readonly RetryPolicy[] = [
  { type: "fixed", delayMs: DEMO_PERSISTENT_RETRY_DELAYS_MS[0] },
  {
    type: "exponential",
    initialDelayMs: DEMO_PERSISTENT_RETRY_DELAYS_MS[1],
    multiplier: 2,
    maxDelayMs: 30 * 60_000,
  },
  // The jitter cap deliberately equals its base so the published ten minute window stays exact and
  // deterministic for the demo and its assertions while still exercising the jitter code path.
  {
    type: "decorrelated-jitter",
    baseDelayMs: DEMO_PERSISTENT_RETRY_DELAYS_MS[2],
    maxDelayMs: DEMO_PERSISTENT_RETRY_DELAYS_MS[2],
  },
] as const;
/** The recoverable retry seed stays fixed and fast so it still recovers while the demo is watched. */
export const DEMO_RECOVERABLE_RETRY_POLICY: RetryPolicy = { type: "fixed", delayMs: 100 };
export const DEMO_SCHEDULE_NAMESPACE = "workhorse-demo";
export const HEARTBEAT_SCHEDULE_NAME = "heartbeat";
export const REPORT_SCHEDULE_NAME = "demo.report";
export const LONG_RUNNING_SCHEDULE_NAME = "demo.long-running";
/**
 * The demo always asks for the documented 24 hour retention window so a repeated submission is
 * still recognised across a demo session and an operator can see one stable retention claim.
 */
export const DEMO_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
/** Namespace used by the dashboard operator path, kept distinct from HTTP caller namespaces. */
export const DEMO_OPERATOR_IDEMPOTENCY_SCOPE = "workhorse-demo:operator";
/**
 * One fixed operator key. Repeating the menu action is meant to return the same task rather than
 * creating another one, which is the whole point of the demonstration.
 */
export const DEMO_OPERATOR_IDEMPOTENCY_KEY = "operator-idempotent-task";
/** Namespace and key for the single deterministic keyed seed shown on a fresh demo database. */
export const DEMO_SEED_IDEMPOTENCY_SCOPE = "workhorse-demo:seed";
export const DEMO_SEED_IDEMPOTENCY_KEY = "representative-keyed-task";
