import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CancellationRequestedError,
  MIN_PROGRESS_UPDATE_INTERVAL_MS,
  type Handler,
  type Queue,
  type Worker,
} from "@workhorse/core";
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
  DEMO_FEATURE_SHOWCASE_FAMILIES,
  demoFeatureRecurringVariant,
  type DemoFeatureBehavior,
  type DemoFeaturePayload,
} from "./feature-showcase.js";
import {
  DEMO_DURABLE_STEP_MS,
  DEMO_DURABLE_TIMER_WAIT_MS,
  DEMO_LONG_RUNNING_MS,
  DURABLE_TIMER_JOB_TYPE,
  DURABLE_TIMER_PREPARE_CHECKPOINT,
  DURABLE_TIMER_PUBLISH_CHECKPOINT,
  DURABLE_TIMER_WAIT_NAME,
  FAILURE_JOB_TYPE,
  LONG_RUNNING_JOB_TYPE,
  ORDER_JOB_TYPE,
  RECURRING_JOB_TYPE,
  REPORT_JOB_TYPE,
  RETRY_CHECKPOINT_NAME,
  RETRY_JOB_TYPE,
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
  /** Used only for the showcase's deliberate self-cancellation. */
  queue: Queue;
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
      await context.sleep(
        `${payload.scenario}:wait`,
        payload.waitMs ?? (variant === null ? 500 : 400 + variant * 300),
      );
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
  for (const family of DEMO_FEATURE_SHOWCASE_FAMILIES) {
    worker.handle(family.jobType, featureShowcaseHandler);
  }
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
