import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import { Queue } from "@stablemates/workhorse";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import {
  DEMO_QUEUE,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_RECOVERABLE_RETRY_POLICY,
  DURABLE_TIMER_TASK_TYPE,
  REPORT_TASK_TYPE,
  RETRY_TASK_TYPE,
  TIMING_TASK_TYPE,
} from "./constants.js";
import { DEMO_QUEUE_OPTIONS } from "./contracts.js";
import type { DemoDatabase } from "./database.js";

/** A quiet release-validation workload that the staging TypeScript worker can execute alone. */
export async function syncStagingSchedules(pool: Pool): Promise<void> {
  const queue = new Queue(pool, DEMO_QUEUE);
  await queue.syncSchedules(DEMO_SCHEDULE_NAMESPACE, [
    {
      name: "staging.release-validation",
      schedule: "*/10 * * * *",
      task: {
        type: REPORT_TASK_TYPE,
        queue: DEMO_QUEUE,
        payload: { source: "staging", report: "release-validation" },
      },
    },
  ]);
}

/** Each case answers a different release question; startup never copies the production showcase. */
export async function seedStagingData(database: DemoDatabase) {
  const taskIds = await database.transaction(async (transaction) => {
    const marker = await transaction.execute(sql`
      INSERT INTO public.workhorse_demo_seed (name) VALUES ('staging-release-validation-v1')
      ON CONFLICT (name) DO NOTHING RETURNING name
    `);
    if (marker.rows.length === 0) return [] as string[];
    const { queue } = createDrizzleAdapter(transaction, {
      defaultQueue: DEMO_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    const tags = ["staging", "release-validation"];
    const smoke = await queue.enqueue(
      REPORT_TASK_TYPE,
      { source: "staging", report: "candidate-smoke-test" },
      { tags },
    );
    const dependent = await queue.enqueue(
      REPORT_TASK_TYPE,
      { source: "staging", report: "publish-validation-summary" },
      {
        tags: [...tags, "dependency"],
        dependencies: {
          prerequisiteTaskIds: [smoke],
          onSuccess: "release",
          onFailure: "cancel",
          onCancellation: "cancel",
        },
      },
    );
    const retry = await queue.enqueue(
      RETRY_TASK_TYPE,
      { label: "candidate-retry-recovery", failUntilAttempt: 1 },
      {
        tags: [...tags, "retry"],
        maxAttempts: 3,
        retryPolicy: DEMO_RECOVERABLE_RETRY_POLICY,
      },
    );
    const timer = await queue.enqueue(
      DURABLE_TIMER_TASK_TYPE,
      { source: "staging-publication-check" },
      { tags: [...tags, "durable-timer"] },
    );
    const canceled = await queue.enqueue(
      REPORT_TASK_TYPE,
      { source: "staging", report: "superseded-candidate" },
      { tags, runAt: new Date(Date.now() + 86_400_000) },
    );
    await queue.cancel(canceled, {
      requestedBy: "demo-seed",
      reason: "A newer release candidate superseded this validation",
    });
    const scheduled = await queue.enqueue(
      REPORT_TASK_TYPE,
      { source: "staging", report: "overnight-regression" },
      { tags, runAt: new Date(Date.now() + 86_400_000) },
    );
    const deadline = await queue.enqueue(
      TIMING_TASK_TYPE,
      { durationMs: 0, source: "staging-expired-release-window" },
      {
        tags: [...tags, "deadline"],
        deadline: new Date(Date.now() - 1_000),
        maxAttempts: 1,
      },
    );
    return [smoke, dependent, retry, timer, canceled, scheduled, deadline];
  });
  return { seeded: taskIds.length > 0, taskIds };
}
