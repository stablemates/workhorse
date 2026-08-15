import type { Json, RetryPolicy } from "@workhorse/core";

export const DEMO_FEATURE_SHOWCASE_SEED_NAME = "feature-showcase-v1";
export const DEMO_FEATURE_SHOWCASE_SOURCE = "feature-showcase-seed";
export const DEMO_FEATURE_RECURRING_SOURCE = "feature-showcase-recurring";

export type DemoFeatureFamily =
  | "ingress-routing"
  | "retry-policies"
  | "durable-checkpoints"
  | "durable-waits"
  | "progress"
  | "timing-controls"
  | "cancellation"
  | "dead-letters-redrive";

export type DemoFeatureBehavior =
  | "success"
  | "retry-once"
  | "retry-twice"
  | "always-fail"
  | "checkpoint"
  | "checkpoint-retry"
  | "multi-checkpoint"
  | "wait"
  | "wait-retry"
  | "progress"
  | "progress-retry"
  | "progress-fail"
  | "timed-success"
  | "timed-slow"
  | "self-cancel"
  | "rotating";

export type DemoFeaturePayload = {
  [key: string]: Json;
  source: typeof DEMO_FEATURE_SHOWCASE_SOURCE | typeof DEMO_FEATURE_RECURRING_SOURCE;
  family: DemoFeatureFamily;
  scenario: string;
  behavior: DemoFeatureBehavior;
  label: string;
  durationMs: number | null;
  waitMs: number | null;
  checkpointCount: number | null;
};

export interface DemoFeatureExample {
  scenario: string;
  label: string;
  behavior: DemoFeatureBehavior;
  tags: string[];
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
  runAfterMs?: number;
  deadlineAfterMs?: number;
  executionTimeoutMs?: number;
  durationMs?: number;
  waitMs?: number;
  checkpointCount?: number;
  idempotencyKey?: string;
  afterEnqueue?: "cancel";
  seedTransition?: "fail" | "fail-and-redrive" | "fail-and-redrive-replay";
}

export interface DemoFeatureShowcaseFamily {
  key: DemoFeatureFamily;
  jobType:
    | "demo.ingress-routing"
    | "demo.retry-policy"
    | "demo.durable-checkpoint"
    | "demo.durable-wait"
    | "demo.progress-reporting"
    | "demo.timing-control"
    | "demo.cancellation"
    | "demo.dead-letter-redrive";
  title: string;
  description: string;
  scheduleName: string;
  schedule: string;
  recurringMaxAttempts: number;
  recurringRetryPolicy?: RetryPolicy;
  examples: readonly [DemoFeatureExample, DemoFeatureExample, DemoFeatureExample];
}

const fastFixedRetry: RetryPolicy = { type: "fixed", delayMs: 250 };

export const DEMO_FEATURE_SHOWCASE_FAMILIES: readonly DemoFeatureShowcaseFamily[] = [
  {
    key: "ingress-routing",
    jobType: "demo.ingress-routing",
    title: "Ingress and routing",
    description: "Immediate, delayed, tagged, and idempotent acceptance paths.",
    scheduleName: "showcase.ingress-routing",
    schedule: "0-59/8 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "immediate-tagged",
        label: "Immediate tagged import",
        behavior: "success",
        tags: ["showcase", "ingress", "immediate", "tagged"],
      },
      {
        scenario: "delayed-routing",
        label: "Delayed partner route",
        behavior: "success",
        runAfterMs: 45_000,
        tags: ["showcase", "ingress", "scheduled", "partner"],
      },
      {
        scenario: "idempotent-acceptance",
        label: "Idempotent webhook acceptance",
        behavior: "success",
        idempotencyKey: "showcase-ingress-idempotent",
        tags: ["showcase", "ingress", "idempotent", "webhook"],
      },
    ],
  },
  {
    key: "retry-policies",
    jobType: "demo.retry-policy",
    title: "Retry policies",
    description: "Fixed, exponential, and decorrelated-jitter outcomes.",
    scheduleName: "showcase.retry-policies",
    schedule: "1-59/8 * * * *",
    recurringMaxAttempts: 3,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "fixed-recovery",
        label: "Fixed retry recovery",
        behavior: "retry-once",
        maxAttempts: 3,
        retryPolicy: { type: "fixed", delayMs: 250 },
        tags: ["showcase", "retry", "fixed", "recovers"],
      },
      {
        scenario: "exponential-recovery",
        label: "Exponential retry recovery",
        behavior: "retry-twice",
        maxAttempts: 4,
        retryPolicy: {
          type: "exponential",
          initialDelayMs: 200,
          multiplier: 2,
          maxDelayMs: 1_000,
        },
        tags: ["showcase", "retry", "exponential", "recovers"],
      },
      {
        scenario: "jitter-exhaustion",
        label: "Jitter retry exhaustion",
        behavior: "always-fail",
        maxAttempts: 2,
        retryPolicy: { type: "decorrelated-jitter", baseDelayMs: 200, maxDelayMs: 500 },
        tags: ["showcase", "retry", "jitter", "intentionally-failing"],
      },
    ],
  },
  {
    key: "durable-checkpoints",
    jobType: "demo.durable-checkpoint",
    title: "Durable checkpoints",
    description: "Single, replayed, and multi-stage restart boundaries.",
    scheduleName: "showcase.durable-checkpoints",
    schedule: "2-59/8 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "single-checkpoint",
        label: "Single durable artifact",
        behavior: "checkpoint",
        checkpointCount: 1,
        tags: ["showcase", "checkpoint", "single"],
      },
      {
        scenario: "checkpoint-replay",
        label: "Checkpoint replay after retry",
        behavior: "checkpoint-retry",
        checkpointCount: 1,
        maxAttempts: 3,
        retryPolicy: fastFixedRetry,
        tags: ["showcase", "checkpoint", "replay", "retry"],
      },
      {
        scenario: "multi-checkpoint",
        label: "Three-stage durable export",
        behavior: "multi-checkpoint",
        checkpointCount: 3,
        tags: ["showcase", "checkpoint", "multi-stage"],
      },
    ],
  },
  {
    key: "durable-waits",
    jobType: "demo.durable-wait",
    title: "Durable waits",
    description: "Lease-releasing waits with replay and retry variation.",
    scheduleName: "showcase.durable-waits",
    schedule: "3-59/8 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "short-provider-wait",
        label: "Short provider cooldown",
        behavior: "wait",
        waitMs: 2_000,
        tags: ["showcase", "durable-wait", "cooldown"],
      },
      {
        scenario: "longer-embargo",
        label: "Longer publication embargo",
        behavior: "wait",
        waitMs: 5_000,
        tags: ["showcase", "durable-wait", "embargo"],
      },
      {
        scenario: "wait-then-retry",
        label: "Wait followed by recoverable retry",
        behavior: "wait-retry",
        waitMs: 3_000,
        maxAttempts: 3,
        retryPolicy: fastFixedRetry,
        tags: ["showcase", "durable-wait", "retry"],
      },
    ],
  },
  {
    key: "progress",
    jobType: "demo.progress-reporting",
    title: "Mutable progress",
    description: "Latest-value progress across success, retry, and failure.",
    scheduleName: "showcase.progress",
    schedule: "4-59/8 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "progress-success",
        label: "Successful catalog scan",
        behavior: "progress",
        durationMs: 700,
        tags: ["showcase", "progress", "success"],
      },
      {
        scenario: "progress-retry",
        label: "Progress retained through retry",
        behavior: "progress-retry",
        durationMs: 500,
        maxAttempts: 3,
        retryPolicy: fastFixedRetry,
        tags: ["showcase", "progress", "retry"],
      },
      {
        scenario: "progress-failure",
        label: "Progress before terminal failure",
        behavior: "progress-fail",
        durationMs: 400,
        maxAttempts: 1,
        tags: ["showcase", "progress", "intentionally-failing"],
      },
    ],
  },
  {
    key: "timing-controls",
    jobType: "demo.timing-control",
    title: "Deadlines and execution timeouts",
    description: "Expired, timed-out, and comfortably completed work.",
    scheduleName: "showcase.timing-controls",
    schedule: "5-59/8 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "expired-deadline",
        label: "Expired before claim",
        behavior: "timed-success",
        deadlineAfterMs: -1_000,
        maxAttempts: 1,
        tags: ["showcase", "deadline", "intentionally-expired"],
      },
      {
        scenario: "execution-timeout",
        label: "Execution budget exceeded",
        behavior: "timed-slow",
        durationMs: 1_500,
        executionTimeoutMs: 250,
        maxAttempts: 1,
        tags: ["showcase", "execution-timeout", "intentionally-failing"],
      },
      {
        scenario: "within-budgets",
        label: "Completed within timing budgets",
        behavior: "timed-success",
        durationMs: 250,
        deadlineAfterMs: 10_000,
        executionTimeoutMs: 5_000,
        maxAttempts: 1,
        tags: ["showcase", "deadline", "execution-timeout", "success"],
      },
    ],
  },
  {
    key: "cancellation",
    jobType: "demo.cancellation",
    title: "Cancellation",
    description: "Immediate ready, future scheduled, and cooperative active cancellation.",
    scheduleName: "showcase.cancellation",
    schedule: "6-59/8 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "cancel-ready",
        label: "Canceled before claim",
        behavior: "success",
        afterEnqueue: "cancel",
        tags: ["showcase", "cancellation", "ready"],
      },
      {
        scenario: "cancel-scheduled",
        label: "Canceled future delivery",
        behavior: "success",
        runAfterMs: 60_000,
        afterEnqueue: "cancel",
        tags: ["showcase", "cancellation", "scheduled"],
      },
      {
        scenario: "cancel-active",
        label: "Cooperative active cancellation",
        behavior: "self-cancel",
        durationMs: 2_000,
        tags: ["showcase", "cancellation", "active", "cooperative"],
      },
    ],
  },
  {
    key: "dead-letters-redrive",
    jobType: "demo.dead-letter-redrive",
    title: "Dead letters and redrive",
    description: "Unredriven failure, successful redrive, and idempotent redrive replay.",
    scheduleName: "showcase.dead-letters-redrive",
    schedule: "7-59/8 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "dead-letter",
        label: "Unredriven terminal failure",
        behavior: "success",
        seedTransition: "fail",
        maxAttempts: 1,
        tags: ["showcase", "dead-letter", "unredriven"],
      },
      {
        scenario: "redrive-success",
        label: "Failed source with successful redrive",
        behavior: "success",
        seedTransition: "fail-and-redrive",
        maxAttempts: 1,
        tags: ["showcase", "dead-letter", "redrive", "success"],
      },
      {
        scenario: "redrive-replay",
        label: "Idempotent redrive replay",
        behavior: "success",
        seedTransition: "fail-and-redrive-replay",
        maxAttempts: 1,
        tags: ["showcase", "dead-letter", "redrive", "idempotent"],
      },
    ],
  },
] as const;

export const DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT = DEMO_FEATURE_SHOWCASE_FAMILIES.reduce(
  (count, family) => count + family.examples.length,
  0,
);

/** Stable per-job rotation so each recurring family naturally produces mixed outcomes over time. */
export function demoFeatureRecurringVariant(jobId: string): 0 | 1 | 2 {
  let hash = 0;
  for (const character of jobId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return (hash % 3) as 0 | 1 | 2;
}
