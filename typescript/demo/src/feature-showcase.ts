import type { DependencyTerminalPolicy, Json, RetryPolicy } from "@workhorse-js/core";

export const DEMO_FEATURE_SHOWCASE_SEED_NAME = "feature-showcase-v2";
export const DEMO_FEATURE_SHOWCASE_SOURCE = "feature-showcase-seed";
export const DEMO_FEATURE_RECURRING_SOURCE = "feature-showcase-recurring";
export const DEMO_FEATURE_OPERATOR_SOURCE = "feature-showcase-operator";

export type DemoFeatureFamily =
  | "ingress-routing"
  | "retry-policies"
  | "durable-checkpoints"
  | "durable-waits"
  | "progress"
  | "timing-controls"
  | "cancellation"
  | "dead-letters-redrive"
  | "job-dependencies"
  | "child-workflows"
  | "signals"
  | "human-decisions"
  | "keyed-debounce"
  | "keyed-throttle"
  | "priority-lanes"
  | "batch-handlers"
  | "payload-contracts";

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
  | "single-child"
  | "fan-out-join"
  | "child-retry"
  | "signal-handoff"
  | "signal-operator"
  | "signal-timeout"
  | "human-pending"
  | "human-expiring"
  | "batch-member"
  | "contract-valid"
  | "contract-result-invalid"
  | "contract-payload-probe"
  | "rotating";

export type DemoFeaturePayload = {
  [key: string]: Json;
  source:
    | typeof DEMO_FEATURE_SHOWCASE_SOURCE
    | typeof DEMO_FEATURE_RECURRING_SOURCE
    | typeof DEMO_FEATURE_OPERATOR_SOURCE;
  family: DemoFeatureFamily;
  scenario: string;
  behavior: DemoFeatureBehavior;
  label: string;
  durationMs: number | null;
  waitMs: number | null;
  checkpointCount: number | null;
  /** Durable waits only: an absolute `sleepUntil` target instead of a relative `sleep`. */
  waitMode: "absolute" | null;
  /** Signals and human decisions: how long the external boundary stays answerable. */
  waitTimeoutMs: number | null;
  /** Child workflows: how many named children the parent fans out. */
  childCount: number | null;
  /** Job dependencies: which side of the prerequisite edge this job plays. */
  role: "prerequisite" | "dependent" | null;
  /** Batch handlers: position inside the seeded member group. */
  memberIndex: number | null;
  /** Batch handlers: whether this member settles as an independent failure. */
  shouldFail: boolean | null;
  /** Payload contracts: the field the demo contract requires on every accepted payload. */
  invoiceId: string | null;
};

/** Prerequisite edges seeded ahead of one dependent showcase job. */
export interface DemoFeatureDependencySeed {
  prerequisites: ReadonlyArray<{
    label: string;
    behavior: "success" | "always-fail";
    maxAttempts?: number;
    runAt?: Date;
  }>;
  onFailure: DependencyTerminalPolicy;
  onCancellation: DependencyTerminalPolicy;
}

/** Keyed debounce shape seeded through `enqueueWithResult` replacements. */
export interface DemoFeatureDebounceSeed {
  schedule: "reset" | "preserve";
  replacements: number;
  windowMs: number;
}

/** Keyed throttle shape seeded through repeat, burst, or per-key acceptance. */
export interface DemoFeatureThrottleSeed {
  shape: "repeat" | "burst" | "per-key";
  windowMs: number;
}

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
  waitMode?: "absolute";
  waitTimeoutMs?: number;
  checkpointCount?: number;
  childCount?: number;
  priority?: number;
  /** Enqueue this many members through one `enqueueMany` batch, all sharing the scenario. */
  seedCount?: number;
  /** Batch handlers: the last seeded member settles as an independent failure. */
  failLastMember?: boolean;
  idempotencyKey?: string;
  afterEnqueue?: "cancel";
  seedTransition?: "fail" | "fail-and-redrive" | "fail-and-redrive-replay";
  seedDependency?: DemoFeatureDependencySeed;
  seedDebounce?: DemoFeatureDebounceSeed;
  seedThrottle?: DemoFeatureThrottleSeed;
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
    | "demo.dead-letter-redrive"
    | "demo.job-dependency"
    | "demo.child-workflow"
    | "demo.signal-wait"
    | "demo.human-decision"
    | "demo.keyed-debounce"
    | "demo.keyed-throttle"
    | "demo.priority-lane"
    | "demo.batch-digest"
    | "demo.contract-check";
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
    schedule: "0-59/17 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "immediate-tagged",
        label: "Immediate tagged import",
        behavior: "success",
        tags: ["ingress", "immediate", "tagged"],
      },
      {
        scenario: "delayed-routing",
        label: "Delayed partner route",
        behavior: "success",
        runAfterMs: 45_000,
        tags: ["ingress", "scheduled", "partner"],
      },
      {
        scenario: "idempotent-acceptance",
        label: "Idempotent webhook acceptance",
        behavior: "success",
        idempotencyKey: "showcase-ingress-idempotent",
        tags: ["ingress", "idempotent", "webhook"],
      },
    ],
  },
  {
    key: "retry-policies",
    jobType: "demo.retry-policy",
    title: "Retry policies",
    description: "Fixed, exponential, and decorrelated-jitter outcomes.",
    scheduleName: "showcase.retry-policies",
    schedule: "1-59/17 * * * *",
    recurringMaxAttempts: 3,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "fixed-recovery",
        label: "Fixed retry recovery",
        behavior: "retry-once",
        maxAttempts: 3,
        retryPolicy: { type: "fixed", delayMs: 250 },
        tags: ["retry", "fixed", "recovers"],
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
        tags: ["retry", "exponential", "recovers"],
      },
      {
        scenario: "jitter-exhaustion",
        label: "Jitter retry exhaustion",
        behavior: "always-fail",
        maxAttempts: 2,
        retryPolicy: { type: "decorrelated-jitter", baseDelayMs: 200, maxDelayMs: 500 },
        tags: ["retry", "jitter", "intentionally-failing"],
      },
    ],
  },
  {
    key: "durable-checkpoints",
    jobType: "demo.durable-checkpoint",
    title: "Durable checkpoints",
    description: "Single, replayed, and multi-stage restart boundaries.",
    scheduleName: "showcase.durable-checkpoints",
    schedule: "2-59/17 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "single-checkpoint",
        label: "Single durable artifact",
        behavior: "checkpoint",
        checkpointCount: 1,
        tags: ["checkpoint", "single"],
      },
      {
        scenario: "checkpoint-replay",
        label: "Checkpoint replay after retry",
        behavior: "checkpoint-retry",
        checkpointCount: 1,
        maxAttempts: 3,
        retryPolicy: fastFixedRetry,
        tags: ["checkpoint", "replay", "retry"],
      },
      {
        scenario: "multi-checkpoint",
        label: "Three-stage durable export",
        behavior: "multi-checkpoint",
        checkpointCount: 3,
        tags: ["checkpoint", "multi-stage"],
      },
    ],
  },
  {
    key: "durable-waits",
    jobType: "demo.durable-wait",
    title: "Durable waits",
    description: "Lease-releasing waits with replay and retry variation.",
    scheduleName: "showcase.durable-waits",
    schedule: "3-59/17 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "short-provider-wait",
        label: "Short provider cooldown",
        behavior: "wait",
        waitMs: 2_000,
        tags: ["durable-wait", "cooldown"],
      },
      {
        scenario: "longer-embargo",
        label: "Absolute-target publication embargo",
        behavior: "wait",
        waitMs: 5_000,
        waitMode: "absolute",
        tags: ["durable-wait", "embargo", "sleep-until"],
      },
      {
        scenario: "wait-then-retry",
        label: "Wait followed by recoverable retry",
        behavior: "wait-retry",
        waitMs: 3_000,
        maxAttempts: 3,
        retryPolicy: fastFixedRetry,
        tags: ["durable-wait", "retry"],
      },
    ],
  },
  {
    key: "progress",
    jobType: "demo.progress-reporting",
    title: "Mutable progress",
    description: "Latest-value progress across success, retry, and failure.",
    scheduleName: "showcase.progress",
    schedule: "4-59/17 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "progress-success",
        label: "Successful catalog scan",
        behavior: "progress",
        durationMs: 700,
        tags: ["progress", "success"],
      },
      {
        scenario: "progress-retry",
        label: "Progress retained through retry",
        behavior: "progress-retry",
        durationMs: 500,
        maxAttempts: 3,
        retryPolicy: fastFixedRetry,
        tags: ["progress", "retry"],
      },
      {
        scenario: "progress-failure",
        label: "Progress before terminal failure",
        behavior: "progress-fail",
        durationMs: 400,
        maxAttempts: 1,
        tags: ["progress", "intentionally-failing"],
      },
    ],
  },
  {
    key: "timing-controls",
    jobType: "demo.timing-control",
    title: "Deadlines and execution timeouts",
    description: "Expired, timed-out, and comfortably completed work.",
    scheduleName: "showcase.timing-controls",
    schedule: "5-59/17 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "expired-deadline",
        label: "Expired before claim",
        behavior: "timed-success",
        deadlineAfterMs: -1_000,
        maxAttempts: 1,
        tags: ["deadline", "intentionally-expired"],
      },
      {
        scenario: "execution-timeout",
        label: "Execution budget exceeded",
        behavior: "timed-slow",
        durationMs: 1_500,
        executionTimeoutMs: 250,
        maxAttempts: 1,
        tags: ["execution-timeout", "intentionally-failing"],
      },
      {
        scenario: "within-budgets",
        label: "Completed within timing budgets",
        behavior: "timed-success",
        durationMs: 250,
        deadlineAfterMs: 10_000,
        executionTimeoutMs: 5_000,
        maxAttempts: 1,
        tags: ["deadline", "execution-timeout", "success"],
      },
    ],
  },
  {
    key: "cancellation",
    jobType: "demo.cancellation",
    title: "Cancellation",
    description: "Immediate ready, future scheduled, and cooperative active cancellation.",
    scheduleName: "showcase.cancellation",
    schedule: "6-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "cancel-ready",
        label: "Canceled before claim",
        behavior: "success",
        afterEnqueue: "cancel",
        tags: ["cancellation", "ready"],
      },
      {
        scenario: "cancel-scheduled",
        label: "Canceled future delivery",
        behavior: "success",
        runAfterMs: 60_000,
        afterEnqueue: "cancel",
        tags: ["cancellation", "scheduled"],
      },
      {
        scenario: "cancel-active",
        label: "Cooperative active cancellation",
        behavior: "self-cancel",
        durationMs: 2_000,
        tags: ["cancellation", "active", "cooperative"],
      },
    ],
  },
  {
    key: "dead-letters-redrive",
    jobType: "demo.dead-letter-redrive",
    title: "Dead letters and redrive",
    description: "Unredriven failure, successful redrive, and idempotent redrive replay.",
    scheduleName: "showcase.dead-letters-redrive",
    schedule: "7-59/17 * * * *",
    recurringMaxAttempts: 2,
    recurringRetryPolicy: fastFixedRetry,
    examples: [
      {
        scenario: "dead-letter",
        label: "Unredriven terminal failure",
        behavior: "success",
        seedTransition: "fail",
        maxAttempts: 1,
        tags: ["dead-letter", "unredriven"],
      },
      {
        scenario: "redrive-success",
        label: "Failed source with successful redrive",
        behavior: "success",
        seedTransition: "fail-and-redrive",
        maxAttempts: 1,
        tags: ["dead-letter", "redrive", "success"],
      },
      {
        scenario: "redrive-replay",
        label: "Idempotent redrive replay",
        behavior: "success",
        seedTransition: "fail-and-redrive-replay",
        maxAttempts: 1,
        tags: ["dead-letter", "redrive", "idempotent"],
      },
    ],
  },
  {
    key: "job-dependencies",
    jobType: "demo.job-dependency",
    title: "Job dependencies",
    description: "Prerequisites gate dependents; failures apply the declared terminal policy.",
    scheduleName: "showcase.job-dependencies",
    schedule: "8-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "release-after-success",
        label: "Dependent released by one prerequisite",
        behavior: "success",
        maxAttempts: 1,
        tags: ["dependency", "release"],
        seedDependency: {
          prerequisites: [
            {
              label: "Prerequisite catalog import",
              behavior: "success",
              runAt: new Date("9999-12-31T23:59:59.999Z"),
            },
          ],
          onFailure: "fail",
          onCancellation: "cancel",
        },
      },
      {
        scenario: "fan-in-join",
        label: "Dependent joining two prerequisites",
        behavior: "success",
        maxAttempts: 1,
        tags: ["dependency", "fan-in"],
        seedDependency: {
          prerequisites: [
            { label: "Prerequisite region export A", behavior: "success" },
            { label: "Prerequisite region export B", behavior: "success" },
          ],
          onFailure: "fail",
          onCancellation: "cancel",
        },
      },
      {
        scenario: "cancel-on-failure",
        label: "Dependent canceled by a failed prerequisite",
        behavior: "success",
        maxAttempts: 1,
        tags: ["dependency", "intentionally-failing"],
        seedDependency: {
          prerequisites: [
            { label: "Failing prerequisite validation", behavior: "always-fail", maxAttempts: 1 },
          ],
          onFailure: "cancel",
          onCancellation: "cancel",
        },
      },
    ],
  },
  {
    key: "child-workflows",
    jobType: "demo.child-workflow",
    title: "Child workflows",
    description: "Parents fan out named children, suspend, and join retained results.",
    scheduleName: "showcase.child-workflows",
    schedule: "9-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "single-child",
        label: "Parent awaiting one rendered child",
        behavior: "single-child",
        maxAttempts: 1,
        tags: ["child-job", "single"],
      },
      {
        scenario: "fan-out-join",
        label: "Parent joining three children by name",
        behavior: "fan-out-join",
        childCount: 3,
        maxAttempts: 1,
        tags: ["child-job", "fan-out"],
      },
      {
        scenario: "child-retry-recovery",
        label: "Child retries before the parent joins",
        behavior: "child-retry",
        maxAttempts: 1,
        tags: ["child-job", "retry"],
      },
    ],
  },
  {
    key: "signals",
    jobType: "demo.signal-wait",
    title: "Signals",
    description: "Suspended handlers resumed by idempotent external signal deliveries.",
    scheduleName: "showcase.signals",
    schedule: "10-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "automated-handoff",
        label: "Signal delivered by a companion task",
        behavior: "signal-handoff",
        waitTimeoutMs: 600_000,
        maxAttempts: 1,
        tags: ["signal", "automated"],
      },
      {
        scenario: "operator-handoff",
        label: "Signal awaiting an operator delivery",
        behavior: "signal-operator",
        waitTimeoutMs: 86_400_000,
        maxAttempts: 1,
        tags: ["signal", "operator"],
      },
      {
        scenario: "expired-handoff",
        label: "Signal wait expiring unanswered",
        behavior: "signal-timeout",
        waitTimeoutMs: 5_000,
        maxAttempts: 1,
        tags: ["signal", "intentionally-failing"],
      },
    ],
  },
  {
    key: "human-decisions",
    jobType: "demo.human-decision",
    title: "Human decisions",
    description: "Suspended handlers waiting for a bounded operator decision.",
    scheduleName: "showcase.human-decisions",
    schedule: "11-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "refund-approval",
        label: "Refund above the automatic limit",
        behavior: "human-pending",
        waitTimeoutMs: 86_400_000,
        maxAttempts: 1,
        tags: ["human-wait", "refund"],
      },
      {
        scenario: "publish-signoff",
        label: "Catalog publication sign-off",
        behavior: "human-pending",
        waitTimeoutMs: 86_400_000,
        maxAttempts: 1,
        tags: ["human-wait", "publication"],
      },
      {
        scenario: "expired-review",
        label: "Review expiring unanswered",
        behavior: "human-expiring",
        waitTimeoutMs: 5_000,
        maxAttempts: 1,
        tags: ["human-wait", "intentionally-failing"],
      },
    ],
  },
  {
    key: "keyed-debounce",
    jobType: "demo.keyed-debounce",
    title: "Keyed debounce",
    description: "PostgreSQL-owned windows replacing still-pending keyed work.",
    scheduleName: "showcase.keyed-debounce",
    schedule: "12-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "trailing-refresh",
        label: "Replacement resetting the trailing window",
        behavior: "success",
        maxAttempts: 1,
        tags: ["debounce", "reset"],
        seedDebounce: { schedule: "reset", replacements: 1, windowMs: 120_000 },
      },
      {
        scenario: "preserved-window",
        label: "Replacement preserving the first run time",
        behavior: "success",
        maxAttempts: 1,
        tags: ["debounce", "preserve"],
        seedDebounce: { schedule: "preserve", replacements: 1, windowMs: 120_000 },
      },
      {
        scenario: "burst-collapse",
        label: "Burst collapsed into one pending task",
        behavior: "success",
        maxAttempts: 1,
        tags: ["debounce", "burst"],
        seedDebounce: { schedule: "reset", replacements: 3, windowMs: 90_000 },
      },
    ],
  },
  {
    key: "keyed-throttle",
    jobType: "demo.keyed-throttle",
    title: "Keyed throttle",
    description: "One accepted keyed task per window, with coalesced repeats.",
    scheduleName: "showcase.keyed-throttle",
    schedule: "13-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "first-through-window",
        label: "First keyed acceptance, repeat coalesced",
        behavior: "success",
        maxAttempts: 1,
        tags: ["throttle", "coalesced"],
        seedThrottle: { shape: "repeat", windowMs: 600_000 },
      },
      {
        scenario: "burst-coalesced",
        label: "Batch burst coalesced into one task",
        behavior: "success",
        maxAttempts: 1,
        tags: ["throttle", "burst"],
        seedThrottle: { shape: "burst", windowMs: 600_000 },
      },
      {
        scenario: "per-key-lanes",
        label: "Independent windows for distinct keys",
        behavior: "success",
        maxAttempts: 1,
        tags: ["throttle", "per-key"],
        seedThrottle: { shape: "per-key", windowMs: 600_000 },
      },
    ],
  },
  {
    key: "priority-lanes",
    jobType: "demo.priority-lane",
    title: "Priority lanes",
    description: "A mixed-priority backlog claimed highest rank first.",
    scheduleName: "showcase.priority-lanes",
    schedule: "14-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "expedited-lane",
        label: "Expedited partner escalation",
        behavior: "success",
        priority: 90,
        maxAttempts: 1,
        tags: ["priority", "expedited"],
      },
      {
        scenario: "standard-lane",
        label: "Standard catalog refresh",
        behavior: "success",
        priority: 50,
        maxAttempts: 1,
        tags: ["priority", "standard"],
      },
      {
        scenario: "bulk-backfill",
        label: "Bulk backfill batch behind live traffic",
        behavior: "success",
        priority: 10,
        seedCount: 3,
        maxAttempts: 1,
        tags: ["priority", "bulk", "enqueue-many"],
      },
    ],
  },
  {
    key: "batch-handlers",
    jobType: "demo.batch-digest",
    title: "Batch handlers",
    description: "Compatible jobs delivered to one handler invocation, settled independently.",
    scheduleName: "showcase.batch-handlers",
    schedule: "15-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "grouped-digest",
        label: "Three members grouped into one digest",
        behavior: "batch-member",
        seedCount: 3,
        maxAttempts: 1,
        tags: ["batch", "grouped", "enqueue-many"],
      },
      {
        scenario: "solo-linger",
        label: "Partial batch dispatched after linger",
        behavior: "batch-member",
        seedCount: 1,
        maxAttempts: 1,
        tags: ["batch", "linger"],
      },
      {
        scenario: "independent-settlement",
        label: "One member fails without failing its batch",
        behavior: "batch-member",
        seedCount: 2,
        failLastMember: true,
        maxAttempts: 1,
        tags: ["batch", "intentionally-failing"],
      },
    ],
  },
  {
    key: "payload-contracts",
    jobType: "demo.contract-check",
    title: "Payload contracts",
    description: "Versioned payload and result validation at the acceptance boundary.",
    scheduleName: "showcase.payload-contracts",
    schedule: "16-59/17 * * * *",
    recurringMaxAttempts: 1,
    examples: [
      {
        scenario: "validated-acceptance",
        label: "Accepted under contract version v1",
        behavior: "contract-valid",
        maxAttempts: 1,
        tags: ["contract", "accepted"],
      },
      {
        scenario: "result-rejection",
        label: "Result rejected by the v1 contract",
        behavior: "contract-result-invalid",
        maxAttempts: 1,
        tags: ["contract", "intentionally-failing"],
      },
      {
        scenario: "payload-rejection-probe",
        label: "Invalid payload refused at enqueue",
        behavior: "contract-payload-probe",
        maxAttempts: 1,
        tags: ["contract", "rejection-probe"],
      },
    ],
  },
] as const;

export const DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT = DEMO_FEATURE_SHOWCASE_FAMILIES.reduce(
  (count, family) => count + family.examples.length,
  0,
);

/** Look one declared family up by key; the catalog is the single owner of job-type names. */
export function demoFeatureShowcaseFamily(key: DemoFeatureFamily): DemoFeatureShowcaseFamily {
  const family = DEMO_FEATURE_SHOWCASE_FAMILIES.find((candidate) => candidate.key === key);
  if (!family) throw new Error(`Unknown demo feature family ${key}`);
  return family;
}

function declaredExample(key: DemoFeatureFamily, scenario: string): DemoFeatureExample {
  const example = demoFeatureShowcaseFamily(key).examples.find(
    (candidate) => candidate.scenario === scenario,
  );
  if (!example) throw new Error(`Unknown demo feature example ${key}/${scenario}`);
  return example;
}

/**
 * The one example per family the dashboard's "Enqueue test task" menu enqueues.
 *
 * Every entry runs live through the ordinary worker path, so a repeat click is always safe:
 * families whose declared examples only make sense as one-time seeds (claimed-and-failed dead
 * letters, forever-blocked dependents, asserted debounce replacements) get a driver example with
 * the `rotating` behavior their handler already runs for the recurring schedules, or a plain
 * example that produces the state on its own.
 */
export const DEMO_FEATURE_MENU_EXAMPLES: Readonly<Record<DemoFeatureFamily, DemoFeatureExample>> = {
  "ingress-routing": declaredExample("ingress-routing", "immediate-tagged"),
  "retry-policies": declaredExample("retry-policies", "fixed-recovery"),
  "durable-checkpoints": declaredExample("durable-checkpoints", "multi-checkpoint"),
  "durable-waits": declaredExample("durable-waits", "short-provider-wait"),
  progress: declaredExample("progress", "progress-success"),
  "timing-controls": declaredExample("timing-controls", "within-budgets"),
  cancellation: declaredExample("cancellation", "cancel-active"),
  "dead-letters-redrive": {
    scenario: "operator-dead-letter",
    label: "Fresh dead letter awaiting redrive",
    behavior: "always-fail",
    maxAttempts: 1,
    tags: ["dead-letter", "operator", "intentionally-failing"],
  },
  "job-dependencies": {
    scenario: "operator-dependency-chain",
    label: "Driver spawning a prerequisite and its dependent",
    behavior: "rotating",
    maxAttempts: 1,
    tags: ["dependency", "operator"],
  },
  "child-workflows": declaredExample("child-workflows", "single-child"),
  signals: declaredExample("signals", "operator-handoff"),
  "human-decisions": declaredExample("human-decisions", "refund-approval"),
  "keyed-debounce": {
    scenario: "operator-debounce-window",
    label: "Driver reporting a keyed replacement",
    behavior: "rotating",
    maxAttempts: 1,
    tags: ["debounce", "operator"],
  },
  "keyed-throttle": {
    scenario: "operator-throttle-window",
    label: "Driver reporting coalesced repeats",
    behavior: "rotating",
    maxAttempts: 1,
    tags: ["throttle", "operator"],
  },
  "priority-lanes": {
    scenario: "operator-priority-lanes",
    label: "Driver filling three priority lanes",
    behavior: "rotating",
    maxAttempts: 1,
    tags: ["priority", "operator"],
  },
  "batch-handlers": declaredExample("batch-handlers", "grouped-digest"),
  "payload-contracts": declaredExample("payload-contracts", "validated-acceptance"),
};

/** Stable per-job rotation so each recurring family naturally produces mixed outcomes over time. */
export function demoFeatureRecurringVariant(jobId: string): 0 | 1 | 2 {
  let hash = 0;
  for (const character of jobId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return (hash % 3) as 0 | 1 | 2;
}
