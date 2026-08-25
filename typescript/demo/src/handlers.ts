import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CancellationRequestedError,
  JobContractValidationError,
  JobValueSizeLimitError,
  MIN_PROGRESS_UPDATE_INTERVAL_MS,
  type ChildJobRequest,
  type EnqueueRequest,
  type Handler,
  type Json,
  type Queue,
  type Worker,
} from "@stablemates/workhorse";
import { and, eq } from "drizzle-orm";
import {
  DURABLE_DEMO_JOB_TYPE,
  type DurableDemoPayload,
  type DurableDemoScenario,
  durableDemoScenarios,
  parseDurableDemoScenario,
  persistentFailureFor,
} from "./durable-demo.js";
import { orders } from "./schema.js";
import {
  DEMO_FEATURE_RECURRING_SOURCE,
  DEMO_FEATURE_SHOWCASE_FAMILIES,
  demoFeatureRecurringVariant,
  demoFeatureShowcaseFamily,
  type DemoFeatureBehavior,
  type DemoFeatureFamily,
  type DemoFeaturePayload,
} from "./feature-showcase.js";
import { DEMO_CONTRACT_JOB_TYPE } from "./contracts.js";
import {
  CHILD_STEP_JOB_TYPE,
  DEMO_BATCH_LINGER_MS,
  DEMO_BATCH_MAX_SIZE,
  DEMO_DURABLE_STEP_MS,
  DEMO_DURABLE_TIMER_WAIT_MS,
  DEMO_HUMAN_WAIT_NAME,
  DEMO_LONG_RUNNING_MS,
  DEMO_RECURRING_WAIT_TIMEOUT_MS,
  DEMO_SIGNAL_NAME,
  DEMO_SIGNAL_SENDER_DELAY_MS,
  DURABLE_TIMER_JOB_TYPE,
  DURABLE_TIMER_PREPARE_CHECKPOINT,
  DURABLE_TIMER_PUBLISH_CHECKPOINT,
  DURABLE_TIMER_WAIT_NAME,
  FAILURE_JOB_TYPE,
  LONG_RUNNING_JOB_TYPE,
  LANGUAGE_WORKER_JOB_TYPE,
  ORDER_JOB_TYPE,
  RECURRING_JOB_TYPE,
  REPORT_JOB_TYPE,
  RETRY_CHECKPOINT_NAME,
  RETRY_JOB_TYPE,
  SIGNAL_SENDER_JOB_TYPE,
  TIMING_JOB_TYPE,
} from "./constants.js";
import type { DemoDatabase } from "./database.js";

/**
 * Everything the demo handlers need that is not the worker itself.
 *
 * Handlers are registered identically by the dedicated worker process and by the in-process
 * composition used in tests, so this module must never reach for a Hono app, a dashboard refresh
 * hub, or anything else that only exists in the web tier. Operator surfaces learn about progress
 * from PostgreSQL on the dashboard's bounded polling interval.
 */
export interface DemoHandlerDependencies {
  database: DemoDatabase;
  /**
   * Used by the showcase's deliberate self-cancellation and by the handler-driven families:
   * signal senders, recurring dependency chains, and the keyed-ingress and priority drivers.
   */
  queue: Queue;
  /**
   * Ceiling for one `demo.batch-digest` invocation. The caller clamps it to the worker's declared
   * job concurrency because a batch cannot hold more members than the worker has slots.
   */
  batchMaxSize?: number;
  durableStepMs?: number;
  durableTimerWaitMs?: number;
  longRunningJobMs?: number;
  onDurableStepOperation?: (
    scenario: DurableDemoScenario,
    stepName: string,
    attempt: number,
  ) => void;
  onDurableTimerOperation?: (
    operation: "prepare" | "publish",
    attempt: number,
    fenceToken: bigint,
  ) => void;
}

/** Build one handler-originated showcase payload with every optional field explicitly null. */
function recurringPayload(
  family: DemoFeatureFamily,
  scenario: string,
  behavior: DemoFeatureBehavior,
  label: string,
  extra: Partial<DemoFeaturePayload> = {},
): DemoFeaturePayload {
  return {
    source: DEMO_FEATURE_RECURRING_SOURCE,
    family,
    scenario,
    behavior,
    label,
    durationMs: null,
    waitMs: null,
    checkpointCount: null,
    waitMode: null,
    waitTimeoutMs: null,
    childCount: null,
    role: null,
    memberIndex: null,
    shouldFail: null,
    invoiceId: null,
    ...extra,
  };
}

/** Register every demo job handler on one worker. */
export function registerDemoHandlers(worker: Worker, deps: DemoHandlerDependencies): Worker {
  const { database, queue } = deps;
  const durableStepMs = deps.durableStepMs ?? DEMO_DURABLE_STEP_MS;
  const durableTimerWaitMs = deps.durableTimerWaitMs ?? DEMO_DURABLE_TIMER_WAIT_MS;

  worker.handle<{ orderId: string }>(ORDER_JOB_TYPE, async ({ orderId }) => {
    const updated = await database
      .update(orders)
      .set({ status: "processed", processedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.status, "queued")))
      .returning({ id: orders.id });

    if (updated.length === 0) throw new Error(`Order ${orderId} is not queued`);
    return { orderId, processed: true };
  });
  worker.handle<{ label: string; failUntilAttempt?: number }>(
    RETRY_JOB_TYPE,
    async ({ label, failUntilAttempt }, { checkpoint, job }) => {
      const failuresBefore = failUntilAttempt ?? 1;
      const reservation = await checkpoint(RETRY_CHECKPOINT_NAME, () => ({
        reservationId: randomUUID(),
        reservedAt: new Date().toISOString(),
        reservedOnAttempt: job.attempt,
      }));
      if (job.attempt <= failuresBefore) {
        throw new Error(`Intentional demo failure ${job.attempt}/${failuresBefore}`);
      }
      return {
        label,
        recovered: true,
        attempt: job.attempt,
        checkpointReused: reservation.reservedOnAttempt < job.attempt,
        reservation,
      };
    },
  );
  worker.handle<DurableDemoPayload>(
    DURABLE_DEMO_JOB_TYPE,
    async ({ scenario: scenarioInput, failureMode }, { checkpoint, job, signal }) => {
      const scenario = parseDurableDemoScenario(scenarioInput);
      if (!scenario) throw new Error(`Unknown durable demo scenario ${String(scenarioInput)}`);
      const definition = durableDemoScenarios[scenario];
      const artifacts: Record<
        string,
        {
          operationId: string;
          completedAt: string;
          completedOnAttempt: number;
          output: string;
        }
      > = {};
      const operationDelayMs = failureMode === "continuous" ? 0 : durableStepMs;
      const persistentFailAfterStep = persistentFailureFor(scenario).afterStepIndex;

      for (const [stepIndex, step] of definition.steps.entries()) {
        const artifact = await checkpoint(step.name, async () => {
          deps.onDurableStepOperation?.(scenario, step.name, job.attempt);
          await sleep(operationDelayMs, undefined, { signal });
          return {
            operationId: randomUUID(),
            completedAt: new Date().toISOString(),
            completedOnAttempt: job.attempt,
            output: `${step.label} completed`,
          };
        });
        artifacts[step.name] = artifact;

        if (failureMode === "continuous" && stepIndex === persistentFailAfterStep) {
          const nextStep = definition.steps[stepIndex + 1];
          throw new Error(
            nextStep
              ? `Intentional persistent demo failure between durable stages ${step.name} and ${nextStep.name}`
              : `Intentional persistent demo failure at the boundary after durable stage ${step.name}`,
          );
        }

        if (
          failureMode !== "continuous" &&
          job.attempt === 1 &&
          stepIndex === definition.failAfterStep
        ) {
          throw new Error(`Intentional crash after durable step ${step.name}`);
        }
      }

      return {
        scenario,
        completed: true,
        attempt: job.attempt,
        reusedCheckpoints: definition.steps
          .filter((step) => artifacts[step.name]!.completedOnAttempt < job.attempt)
          .map((step) => step.name),
        artifacts,
      };
    },
  );
  worker.handle<{ source: string }>(DURABLE_TIMER_JOB_TYPE, async ({ source }, context) => {
    const currentFence = context.job.fenceToken.toString();
    const prepared = await context.checkpoint(DURABLE_TIMER_PREPARE_CHECKPOINT, () => {
      deps.onDurableTimerOperation?.("prepare", context.job.attempt, context.job.fenceToken);
      return {
        artifactId: randomUUID(),
        preparedAt: new Date().toISOString(),
        preparedOnAttempt: context.job.attempt,
        preparedOnFence: currentFence,
      };
    });

    const existingWait = await context.getWait(DURABLE_TIMER_WAIT_NAME);
    await context.sleep(DURABLE_TIMER_WAIT_NAME, durableTimerWaitMs);
    const durableWait = await context.getWait(DURABLE_TIMER_WAIT_NAME);
    if (!durableWait) throw new Error("Durable timer wait was not replayed");

    const publication = await context.checkpoint(DURABLE_TIMER_PUBLISH_CHECKPOINT, () => {
      deps.onDurableTimerOperation?.("publish", context.job.attempt, context.job.fenceToken);
      return {
        publicationId: randomUUID(),
        publishedAt: new Date().toISOString(),
        publishedOnAttempt: context.job.attempt,
        publishedOnFence: currentFence,
      };
    });

    return {
      source,
      completed: true,
      attempt: context.job.attempt,
      prepareCheckpointReused: prepared.preparedOnFence !== currentFence,
      waitReplayed: existingWait !== null,
      wait: {
        name: durableWait.name,
        wakeAt: new Date(durableWait.wakeAt).toISOString(),
        firstFence: durableWait.fenceToken.toString(),
      },
      prepared,
      publication,
    };
  });
  worker.handle<{ source: string }>(RECURRING_JOB_TYPE, async ({ source }, { job }) => {
    return { source, recurring: true, attempt: job.attempt };
  });
  worker.handle<{ language: string }>(LANGUAGE_WORKER_JOB_TYPE, async ({ language }, { job }) => {
    if (language !== "typescript") {
      throw new Error(`TypeScript worker received language job for ${language}`);
    }
    return { language, runtime: "node", attempt: job.attempt };
  });
  const featureShowcaseHandler: Handler<DemoFeaturePayload> = async (payload, context) => {
    const variant =
      payload.behavior === "rotating" ? demoFeatureRecurringVariant(context.job.id) : null;
    const behavior: DemoFeatureBehavior =
      variant === null
        ? payload.behavior
        : variant === 0
          ? "success"
          : variant === 1
            ? payload.family === "cancellation"
              ? "self-cancel"
              : "retry-once"
            : "always-fail";
    const scenario =
      variant === null ? payload.scenario : `${payload.scenario}:variant-${variant + 1}`;

    if (payload.family === "durable-checkpoints") {
      const checkpointCount = payload.checkpointCount ?? (variant === null ? 1 : variant + 1);
      for (let index = 1; index <= checkpointCount; index += 1) {
        await context.checkpoint(`${payload.scenario}:stage-${index}`, () => ({
          artifactId: randomUUID(),
          stage: index,
          createdOnAttempt: context.job.attempt,
        }));
      }
    }

    if (payload.family === "durable-waits") {
      const waitName = `${payload.scenario}:wait`;
      const waitMs = payload.waitMs ?? (variant === null ? 500 : 400 + variant * 300);
      // The embargo scenario waits on an absolute target; the wake time persists on first
      // scheduling, so the recomputed argument is ignored when the wait replays.
      if (payload.waitMode === "absolute") {
        await context.sleepUntil(waitName, new Date(Date.now() + waitMs));
      } else {
        await context.sleep(waitName, waitMs);
      }
    }

    if (payload.family === "progress") {
      const durationMs = Math.max(payload.durationMs ?? 300, MIN_PROGRESS_UPDATE_INTERVAL_MS);
      await context.setProgress({ scenario, phase: "running", completed: 1, total: 2 });
      await sleep(durationMs, undefined, { signal: context.signal });
      await context.setProgress({ scenario, phase: "finishing", completed: 2, total: 2 });
    } else if (payload.family === "timing-controls" || behavior === "self-cancel") {
      await sleep(payload.durationMs ?? (variant === null ? 250 : 200 + variant * 200), undefined, {
        signal: context.signal,
      });
    }

    if (behavior === "self-cancel") {
      await queue.cancel(context.job.id, {
        requestedBy: "demo-showcase",
        reason: `Cooperative cancellation for ${scenario}`,
      });
      throw new CancellationRequestedError(context.job.id);
    }

    const shouldRetry =
      (behavior === "retry-once" ||
        behavior === "checkpoint-retry" ||
        behavior === "wait-retry" ||
        behavior === "progress-retry") &&
      context.job.attempt === 1;
    const shouldRetryTwice = behavior === "retry-twice" && context.job.attempt <= 2;
    if (
      shouldRetry ||
      shouldRetryTwice ||
      behavior === "always-fail" ||
      behavior === "progress-fail"
    ) {
      throw new Error(
        `Intentional showcase outcome for ${scenario} on attempt ${context.job.attempt}`,
      );
    }

    return {
      family: payload.family,
      scenario,
      variant,
      outcome: context.job.attempt > 1 ? "recovered" : "succeeded",
      attempt: context.job.attempt,
    };
  };
  // The original outcome-shaped families share one generic handler; the families added for
  // dependencies, children, external boundaries, keyed ingress, priority, batching, and contracts
  // each need their own durable API calls and register individually below.
  const genericFamilies: ReadonlySet<DemoFeatureFamily> = new Set([
    "ingress-routing",
    "retry-policies",
    "durable-checkpoints",
    "durable-waits",
    "progress",
    "timing-controls",
    "cancellation",
    "dead-letters-redrive",
  ]);
  for (const family of DEMO_FEATURE_SHOWCASE_FAMILIES) {
    if (genericFamilies.has(family.key)) worker.handle(family.jobType, featureShowcaseHandler);
  }

  const dependencyFamily = demoFeatureShowcaseFamily("job-dependencies");
  worker.handle<DemoFeaturePayload>(
    dependencyFamily.jobType,
    async (payload, context): Promise<Json> => {
      // Each recurring occurrence drives a fresh prerequisite-to-dependent chain, so the
      // dependency lineage keeps growing while the dashboard is open.
      if (payload.behavior === "rotating") {
        const prerequisiteJobId = await queue.enqueue(
          dependencyFamily.jobType,
          recurringPayload(
            "job-dependencies",
            "recurring-chain",
            "success",
            "Recurring chain prerequisite",
            { role: "prerequisite" },
          ),
          { maxAttempts: 1, tags: ["dependency", "recurring", "prerequisite"] },
        );
        const dependentJobId = await queue.enqueue(
          dependencyFamily.jobType,
          recurringPayload(
            "job-dependencies",
            "recurring-chain",
            "success",
            "Recurring chain dependent",
            { role: "dependent" },
          ),
          {
            maxAttempts: 1,
            dependencies: {
              prerequisiteJobIds: [prerequisiteJobId],
              onSuccess: "release",
              onFailure: "fail",
              onCancellation: "cancel",
            },
            tags: ["dependency", "recurring", "dependent"],
          },
        );
        return { scenario: payload.scenario, prerequisiteJobId, dependentJobId };
      }
      if (payload.behavior === "always-fail") {
        throw new Error(`Intentional prerequisite failure for ${payload.scenario}`);
      }
      return {
        scenario: payload.scenario,
        role: payload.role ?? null,
        outcome: "succeeded",
        attempt: context.job.attempt,
      };
    },
  );

  const childFamily = demoFeatureShowcaseFamily("child-workflows");
  worker.handle<DemoFeaturePayload>(
    childFamily.jobType,
    async (payload, context): Promise<Json> => {
      const childRequest = (name: string, failUntilAttempt: number): ChildJobRequest => ({
        name,
        type: CHILD_STEP_JOB_TYPE,
        payload: { scenario: payload.scenario, step: name, failUntilAttempt },
        options: {
          maxAttempts: failUntilAttempt + 1,
          ...(failUntilAttempt > 0 ? { retryPolicy: { type: "fixed", delayMs: 250 } } : {}),
          tags: ["child-job", "child", payload.scenario],
        },
      });
      if (payload.behavior === "single-child" || payload.behavior === "child-retry") {
        const request = childRequest("render-report", payload.behavior === "child-retry" ? 1 : 0);
        const child = await context.runChild<Json>(
          request.name,
          request.type,
          request.payload,
          request.options,
        );
        return { scenario: payload.scenario, child };
      }
      const variant =
        payload.behavior === "rotating" ? demoFeatureRecurringVariant(context.job.id) : null;
      const childCount = payload.childCount ?? (variant === null ? 3 : variant + 1);
      const children = await context.runChildren(
        Array.from({ length: childCount }, (_, index) => childRequest(`shard-${index + 1}`, 0)),
      );
      return { scenario: payload.scenario, childCount, children };
    },
  );
  worker.handle<{ scenario: string; step: string; failUntilAttempt: number }>(
    CHILD_STEP_JOB_TYPE,
    async ({ scenario, step, failUntilAttempt }, { job }) => {
      if (job.attempt <= failUntilAttempt) {
        throw new Error(`Intentional child retry for ${scenario}:${step} attempt ${job.attempt}`);
      }
      return { scenario, step, completedOnAttempt: job.attempt };
    },
  );

  const signalFamily = demoFeatureShowcaseFamily("signals");
  worker.handle<DemoFeaturePayload>(
    signalFamily.jobType,
    async (payload, context): Promise<Json> => {
      const variant =
        payload.behavior === "rotating" ? demoFeatureRecurringVariant(context.job.id) : null;
      const behavior: DemoFeatureBehavior =
        variant === null
          ? payload.behavior
          : variant === 0
            ? "signal-handoff"
            : variant === 1
              ? "signal-operator"
              : "signal-timeout";
      const timeoutMs =
        payload.waitTimeoutMs ??
        (behavior === "signal-timeout" ? 5_000 : DEMO_RECURRING_WAIT_TIMEOUT_MS);
      if (behavior === "signal-handoff") {
        // The checkpoint keeps the sender enqueue exactly-once across the wait's replay.
        await context.checkpoint("enqueue-signal-sender", () =>
          queue.enqueue(
            SIGNAL_SENDER_JOB_TYPE,
            { targetJobId: context.job.id, scenario: payload.scenario },
            {
              runAt: new Date(Date.now() + DEMO_SIGNAL_SENDER_DELAY_MS),
              maxAttempts: 5,
              retryPolicy: { type: "fixed", delayMs: 2_000 },
              tags: ["signal", "sender", payload.scenario],
            },
          ),
        );
      }
      const signal = await context.waitForSignal(DEMO_SIGNAL_NAME, { timeoutMs });
      return { scenario: payload.scenario, behavior, signal };
    },
  );
  worker.handle<{ targetJobId: string; scenario: string }>(
    SIGNAL_SENDER_JOB_TYPE,
    async ({ targetJobId, scenario }, { job }) => {
      const result = await queue.sendSignal(
        targetJobId,
        DEMO_SIGNAL_NAME,
        { scenario, sentBy: "showcase-sender", sentOnAttempt: job.attempt },
        { idempotencyKey: `signal-sender:${job.id}`, requestedBy: "demo-signal-sender" },
      );
      // The waiter may not have suspended yet; retry until the wait exists. Any delivered or
      // already-answered status is a success for the sender.
      if (result.status === "not_waiting" || result.status === "stale") {
        throw new Error(`Signal target ${targetJobId} is not waiting yet (${result.status})`);
      }
      return { targetJobId, scenario, status: result.status };
    },
  );

  const humanFamily = demoFeatureShowcaseFamily("human-decisions");
  worker.handle<DemoFeaturePayload>(
    humanFamily.jobType,
    async (payload, context): Promise<Json> => {
      const variant =
        payload.behavior === "rotating" ? demoFeatureRecurringVariant(context.job.id) : null;
      const behavior: DemoFeatureBehavior =
        variant === null ? payload.behavior : variant === 2 ? "human-expiring" : "human-pending";
      const timeoutMs =
        payload.waitTimeoutMs ??
        (behavior === "human-expiring" ? 5_000 : DEMO_RECURRING_WAIT_TIMEOUT_MS);
      const decision = await context.waitForHuman(
        DEMO_HUMAN_WAIT_NAME,
        {
          scenario: payload.scenario,
          summary: payload.label,
          dashboard: {
            quickAction: { label: "Approve", result: { approved: true } },
          },
        },
        { timeoutMs },
      );
      return { scenario: payload.scenario, behavior, decision };
    },
  );

  const debounceFamily = demoFeatureShowcaseFamily("keyed-debounce");
  worker.handle<DemoFeaturePayload>(
    debounceFamily.jobType,
    async (payload, context): Promise<Json> => {
      // The recurring occurrence is a driver: it performs a keyed enqueue and one replacement and
      // returns both durable dispositions, so coalescing outcomes are visible as a task result.
      if (payload.behavior === "rotating") {
        const debounce = {
          key: `showcase-debounce-${context.job.id}`,
          windowMs: 5_000,
          schedule: "reset",
        } as const;
        const enqueuePass = (pass: number) =>
          queue.enqueueWithResult(
            debounceFamily.jobType,
            recurringPayload(
              "keyed-debounce",
              "recurring-window",
              "success",
              `Debounced refresh pass ${pass}`,
            ),
            { debounce, maxAttempts: 1, tags: ["debounce", "recurring"] },
          );
        const first = await enqueuePass(1);
        const replacement = await enqueuePass(2);
        return {
          scenario: payload.scenario,
          outcomes: [first, replacement].map((result) => ({
            jobId: result.jobId,
            outcome: result.outcome,
            reason: result.reason ?? null,
          })),
        };
      }
      return { scenario: payload.scenario, outcome: "succeeded", attempt: context.job.attempt };
    },
  );

  const throttleFamily = demoFeatureShowcaseFamily("keyed-throttle");
  worker.handle<DemoFeaturePayload>(
    throttleFamily.jobType,
    async (payload, context): Promise<Json> => {
      if (payload.behavior === "rotating") {
        const throttle = { key: `showcase-throttle-${context.job.id}`, windowMs: 5_000 };
        // Throttled repeats coalesce only when they are equivalent, so all three requests are
        // identical; a differing repeat would be refused as a conflict instead of coalescing.
        const request: EnqueueRequest = {
          type: throttleFamily.jobType,
          payload: recurringPayload(
            "keyed-throttle",
            "recurring-window",
            "success",
            "Throttled sync request",
          ),
          options: { throttle, maxAttempts: 1, tags: ["throttle", "recurring"] },
        };
        const outcomes = await queue.enqueueManyWithResults([request, request, request]);
        return {
          scenario: payload.scenario,
          outcomes: outcomes.map((result) => ({
            jobId: result.jobId,
            outcome: result.outcome,
            reason: result.reason ?? null,
          })),
        };
      }
      return { scenario: payload.scenario, outcome: "succeeded", attempt: context.job.attempt };
    },
  );

  const priorityFamily = demoFeatureShowcaseFamily("priority-lanes");
  worker.handle<DemoFeaturePayload>(
    priorityFamily.jobType,
    async (payload, context): Promise<Json> => {
      if (payload.behavior === "rotating") {
        const lanes = [
          { priority: 90, label: "Recurring expedited lane" },
          { priority: 50, label: "Recurring standard lane" },
          { priority: 10, label: "Recurring bulk lane" },
        ];
        const jobIds = await queue.enqueueMany(
          lanes.map((lane) => ({
            type: priorityFamily.jobType,
            payload: recurringPayload("priority-lanes", "recurring-lanes", "success", lane.label),
            options: {
              priority: lane.priority,
              maxAttempts: 1,
              tags: ["priority", "recurring"],
            },
          })),
        );
        return { scenario: payload.scenario, jobIds };
      }
      return {
        scenario: payload.scenario,
        priority: context.job.priority,
        outcome: "succeeded",
        attempt: context.job.attempt,
      };
    },
  );

  const batchFamily = demoFeatureShowcaseFamily("batch-handlers");
  const batchMaxSize = Math.max(1, deps.batchMaxSize ?? DEMO_BATCH_MAX_SIZE);
  worker.handleBatch<DemoFeaturePayload>(
    batchFamily.jobType,
    { maxSize: batchMaxSize, lingerMs: DEMO_BATCH_LINGER_MS },
    (items) => {
      const digestId = randomUUID();
      return items.map(({ payload, context }) =>
        payload.shouldFail
          ? {
              status: "failed",
              error: new Error(`Intentional independent member failure for ${payload.scenario}`),
            }
          : {
              status: "succeeded",
              result: {
                scenario: payload.scenario,
                digestId,
                batchSize: items.length,
                memberIndex: payload.memberIndex ?? null,
                attempt: context.job.attempt,
              },
            },
      );
    },
  );

  worker.handle<DemoFeaturePayload>(
    DEMO_CONTRACT_JOB_TYPE,
    async (payload, context): Promise<Json> => {
      if (payload.behavior === "contract-payload-probe") {
        // A real rejection, surfaced honestly: the probe enqueues a payload the v1 contract
        // refuses and returns the refusal as its own result.
        try {
          await queue.enqueue(
            DEMO_CONTRACT_JOB_TYPE,
            recurringPayload(
              "payload-contracts",
              "recurring-probe",
              "contract-valid",
              "Probe without invoiceId",
            ),
          );
          throw new Error("Expected the v1 contract to refuse a payload without invoiceId");
        } catch (error) {
          if (
            !(error instanceof JobContractValidationError) &&
            !(error instanceof JobValueSizeLimitError)
          ) {
            throw error;
          }
          return {
            approved: true,
            scenario: payload.scenario,
            probedRejection: { name: error.name, message: error.message },
          };
        }
      }
      if (payload.behavior === "contract-result-invalid") {
        // The v1 contract requires a boolean `approved`; completing with this result fails the
        // attempt at the completion boundary rather than inside the handler.
        return { approved: "pending-review", scenario: payload.scenario };
      }
      return {
        approved: true,
        scenario: payload.scenario,
        invoiceId: payload.invoiceId ?? null,
        contractVersion: context.job.contractVersion,
      };
    },
  );
  worker.handle<{ report: string; source: string }>(REPORT_JOB_TYPE, async (payload) => {
    return { ...payload, generated: true };
  });
  worker.handle(FAILURE_JOB_TYPE, () => {
    throw new Error("Intentional terminal demo failure");
  });
  worker.handle(LONG_RUNNING_JOB_TYPE, async (_payload, context) => {
    const durationMs = deps.longRunningJobMs ?? DEMO_LONG_RUNNING_MS;
    if (durationMs >= MIN_PROGRESS_UPDATE_INTERVAL_MS * 2) {
      await context.setProgress({ phase: "running", completed: 0, total: durationMs });
    }
    await sleep(durationMs);
    await context.setProgress({
      phase: "complete",
      completed: durationMs,
      total: durationMs,
    });
    return { completed: true, durationMs };
  });
  worker.handle<{ durationMs: number; source: string }>(
    TIMING_JOB_TYPE,
    async ({ durationMs, source }, { signal }) => {
      await sleep(durationMs, undefined, { signal });
      return { completed: true, durationMs, source };
    },
  );

  return worker;
}
