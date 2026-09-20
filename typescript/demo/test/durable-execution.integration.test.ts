/**
 * Work a real worker runs: retries, durable timers, and declared pipelines.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_WORKER_CONCURRENCY,
  DURABLE_TIMER_PREPARE_CHECKPOINT,
  DURABLE_TIMER_PUBLISH_CHECKPOINT,
  DURABLE_TIMER_TASK_TYPE,
  DURABLE_TIMER_WAIT_NAME,
  HEARTBEAT_SCHEDULE_NAME,
  LONG_RUNNING_SCHEDULE_NAME,
  syncDemoSchedules,
} from "../src/app.js";
import { GENERATED_WORKER_ID, createDemoIntegrationSuite } from "./support/demo-integration.js";

const { createTestApplication, dashboardClient, enqueueDemoTest, pool, waitFor } =
  createDemoIntegrationSuite(import.meta.url);

describe("Workhorse demo", () => {
  it("retries an intentional handler failure and exposes both attempts in the dashboard", async () => {
    const { app, workhorse } = createTestApplication();
    workhorse.start();

    try {
      const accepted = {
        ...(await enqueueDemoTest("retry")),
        expectedAttempts: 2,
        expectedCheckpoint: "reserve-capacity",
      };
      expect(accepted.expectedAttempts).toBe(2);
      expect(accepted.expectedCheckpoint).toBe("reserve-capacity");

      let task: { state: string; currentAttempt: number; result: unknown } | undefined;
      for (let attempt = 0; attempt < 80 && task?.state !== "succeeded"; attempt += 1) {
        await sleep(25);
        task = (await workhorse.context.admin.getTask(accepted.taskId)) as typeof task;
      }

      expect(task).toMatchObject({
        state: "succeeded",
        currentAttempt: 2,
        result: {
          recovered: true,
          attempt: 2,
          checkpointReused: true,
          reservation: {
            reservationId: expect.any(String),
            reservedAt: expect.any(String),
            reservedOnAttempt: 1,
          },
        },
      });
      expect(
        (
          await pool.query(
            `SELECT checkpoint_name, checkpoint_value, attempt, fence_token::text, worker_id
               FROM workhorse.task_checkpoint WHERE task_id = $1`,
            [accepted.taskId],
          )
        ).rows,
      ).toEqual([
        {
          checkpoint_name: "reserve-capacity",
          checkpoint_value: {
            reservationId: expect.any(String),
            reservedAt: expect.any(String),
            reservedOnAttempt: 1,
          },
          attempt: 1,
          fence_token: expect.any(String),
          worker_id: expect.stringMatching(GENERATED_WORKER_ID),
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT attempt, outcome FROM workhorse.attempt_history WHERE task_id = $1 ORDER BY attempt",
            [accepted.taskId],
          )
        ).rows,
      ).toEqual([
        { attempt: 1, outcome: "retry" },
        { attempt: 2, outcome: "succeeded" },
      ]);

      const client = dashboardClient(app);
      expect(
        await client.dashboard.tasks({ filter: "retried", page: 1, pageSize: 25 }),
      ).toMatchObject({
        filter: "retried",
        total: 1,
        tasks: [{ id: accepted.taskId, state: "succeeded", attempt: 2 }],
      });
      await expect(client.dashboard.taskCounts()).resolves.toMatchObject({
        all: 1,
        retried: 1,
        completed: 1,
      });
      const workers = await client.dashboard.workers();
      expect(workers.workers).toHaveLength(DEMO_WORKER_CONCURRENCY.length);
      expect(workers.workers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringMatching(GENERATED_WORKER_ID),
            registered: true,
          }),
        ]),
      );
      expect(await client.dashboard.system({ window: "1h" })).toMatchObject({
        window: "1h",
        kpis: { retry: { backoff: 0 }, errorRate: { current: expect.any(Number) } },
      });
      expect(await client.dashboard.taskDetail({ id: accepted.taskId })).toMatchObject({
        identity: { id: accepted.taskId, state: "succeeded" },
        checkpoints: [
          {
            name: "reserve-capacity",
            attempt: 1,
            fenceToken: expect.any(String),
            workerId: expect.stringMatching(GENERATED_WORKER_ID),
            value: { reservedOnAttempt: 1 },
          },
        ],
        attempts: [
          { attempt: 1, outcome: "retry" },
          { attempt: 2, outcome: "succeeded" },
        ],
        events: expect.arrayContaining([
          expect.objectContaining({
            attempt: 1,
            type: "checkpoint_saved",
            details: expect.objectContaining({ name: "reserve-capacity" }),
          }),
        ]),
      });
      expect(
        await pool.query(
          `SELECT count(*)::integer AS count FROM workhorse.task_event
            WHERE task_id = $1 AND event_type = 'checkpoint_saved'`,
          [accepted.taskId],
        ),
      ).toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await workhorse.stop();
    }
  });

  it("suspends and reclaims one logical attempt around a named durable timer", async () => {
    const operations: Array<{ operation: string; attempt: number; fenceToken: string }> = [];
    const { app, workhorse } = createTestApplication({
      workerPollMs: 5,
      maintenanceIntervalMs: 100,
      durableTimerWaitMs: 500,
      onDurableTimerOperation(operation, attempt, fenceToken) {
        operations.push({ operation, attempt, fenceToken: fenceToken.toString() });
      },
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const accepted = {
        ...(await enqueueDemoTest("timer")),
        expectedAttempt: 1,
        prepareCheckpoint: DURABLE_TIMER_PREPARE_CHECKPOINT,
        waitName: DURABLE_TIMER_WAIT_NAME,
        publishCheckpoint: DURABLE_TIMER_PUBLISH_CHECKPOINT,
      };
      expect(accepted).toMatchObject({
        expectedAttempt: 1,
        prepareCheckpoint: DURABLE_TIMER_PREPARE_CHECKPOINT,
        waitName: DURABLE_TIMER_WAIT_NAME,
        publishCheckpoint: DURABLE_TIMER_PUBLISH_CHECKPOINT,
      });

      let suspended:
        | {
            state: string;
            current_attempt: number;
            fence_token: string;
            worker_id: string | null;
            acquired_at: Date | null;
            heartbeat_at: Date | null;
            expires_at: Date | null;
            wait_name: string | null;
            attempt_started_at: Date;
          }
        | undefined;
      for (let poll = 0; poll < 100 && suspended?.state !== "scheduled"; poll += 1) {
        await sleep(10);
        suspended = (
          await pool.query(
            `SELECT state, current_attempt, fence_token::text, worker_id, acquired_at, heartbeat_at,
                    expires_at, wait_name, attempt_started_at
               FROM workhorse.task_runtime WHERE task_id = $1`,
            [accepted.taskId],
          )
        ).rows[0];
      }
      expect(suspended).toMatchObject({
        state: "scheduled",
        current_attempt: 1,
        fence_token: "0",
        worker_id: null,
        acquired_at: null,
        heartbeat_at: null,
        expires_at: null,
        wait_name: DURABLE_TIMER_WAIT_NAME,
        attempt_started_at: expect.any(Date),
      });

      const waits = await pool.query<{
        wait_name: string;
        mode: string;
        duration_ms: string;
        wake_at: Date;
        attempt: number;
        fence_token: string;
        worker_id: string;
      }>(
        `SELECT wait_name, mode, duration_ms::text, wake_at, attempt, fence_token::text, worker_id
           FROM workhorse.task_wait WHERE task_id = $1`,
        [accepted.taskId],
      );
      expect(waits.rows).toEqual([
        {
          wait_name: DURABLE_TIMER_WAIT_NAME,
          mode: "relative",
          duration_ms: "500",
          wake_at: expect.any(Date),
          attempt: 1,
          fence_token: expect.any(String),
          worker_id: expect.stringMatching(GENERATED_WORKER_ID),
        },
      ]);
      const firstFence = waits.rows[0]!.fence_token;
      expect(BigInt(firstFence)).toBeGreaterThan(0n);
      expect(operations).toEqual([{ operation: "prepare", attempt: 1, fenceToken: firstFence }]);
      expect(
        (
          await pool.query(
            `SELECT checkpoint_name, fence_token::text FROM workhorse.task_checkpoint
              WHERE task_id = $1 ORDER BY created_at`,
            [accepted.taskId],
          )
        ).rows,
      ).toEqual([{ checkpoint_name: DURABLE_TIMER_PREPARE_CHECKPOINT, fence_token: firstFence }]);
      expect(
        (
          await pool.query(
            `SELECT event_type FROM workhorse.task_event
              WHERE task_id = $1 ORDER BY occurred_at, event_id`,
            [accepted.taskId],
          )
        ).rows.map((row) => row.event_type),
      ).toEqual(["enqueued", "claimed", "checkpoint_saved", "wait_scheduled"]);

      const scheduledTasks = await client.dashboard.tasks({
        filter: "scheduled",
        page: 1,
        pageSize: 25,
      });
      expect(scheduledTasks.tasks).toEqual([
        expect.objectContaining({
          id: accepted.taskId,
          state: "scheduled",
          attempt: 1,
          workerId: null,
          lastWorkerId: waits.rows[0]!.worker_id,
          waitName: DURABLE_TIMER_WAIT_NAME,
          wakeAt: waits.rows[0]!.wake_at.toISOString(),
          wait: {
            name: DURABLE_TIMER_WAIT_NAME,
            wakeAt: waits.rows[0]!.wake_at.toISOString(),
            mode: "relative",
          },
        }),
      ]);
      expect(await client.dashboard.taskDetail({ id: accepted.taskId })).toMatchObject({
        current: {
          runtime: {
            state: "scheduled",
            attempt: 1,
            fenceToken: "0",
            workerId: null,
            acquiredAt: null,
            heartbeatAt: null,
            expiresAt: null,
            waitName: DURABLE_TIMER_WAIT_NAME,
            attemptStartedAt: suspended!.attempt_started_at.toISOString(),
          },
        },
        waits: [
          {
            name: DURABLE_TIMER_WAIT_NAME,
            mode: "relative",
            durationMs: 500,
            wakeAt: waits.rows[0]!.wake_at.toISOString(),
            attempt: 1,
            fenceToken: firstFence,
            workerId: waits.rows[0]!.worker_id,
          },
        ],
      });

      let finalTask:
        | {
            state: string;
            currentAttempt: number;
            fenceToken: bigint;
            result: Record<string, unknown>;
          }
        | undefined;
      for (let poll = 0; poll < 200 && finalTask?.state !== "succeeded"; poll += 1) {
        await sleep(10);
        finalTask = (await workhorse.context.admin.getTask(accepted.taskId)) as typeof finalTask;
      }
      expect(finalTask).toMatchObject({
        state: "succeeded",
        currentAttempt: 1,
        result: {
          source: "operator",
          completed: true,
          attempt: 1,
          prepareCheckpointReused: true,
          waitReplayed: true,
          wait: { name: DURABLE_TIMER_WAIT_NAME, firstFence },
          prepared: { preparedOnAttempt: 1, preparedOnFence: firstFence },
          publication: { publishedOnAttempt: 1, publishedOnFence: expect.any(String) },
        },
      });

      const claims = await pool.query<{
        fence_token: string;
        occurred_at: Date;
      }>(
        `SELECT details->>'fence_token' AS fence_token, occurred_at
           FROM workhorse.task_event
          WHERE task_id = $1 AND event_type = 'claimed' ORDER BY occurred_at, event_id`,
        [accepted.taskId],
      );
      expect(claims.rows).toHaveLength(2);
      expect(claims.rows[0]!.fence_token).toBe(firstFence);
      const secondFence = claims.rows[1]!.fence_token;
      expect(secondFence).not.toBe(firstFence);
      expect(finalTask!.fenceToken).toBe(BigInt(secondFence));
      expect(operations).toEqual([
        { operation: "prepare", attempt: 1, fenceToken: firstFence },
        { operation: "publish", attempt: 1, fenceToken: secondFence },
      ]);

      const history = await pool.query<{
        attempt: number;
        fence_token: string;
        outcome: string;
        started_at: Date;
        claimed_at: Date;
        finished_at: Date;
      }>(
        `SELECT attempt, fence_token::text, outcome, started_at, claimed_at, finished_at
           FROM workhorse.attempt_history WHERE task_id = $1`,
        [accepted.taskId],
      );
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]).toMatchObject({
        attempt: 1,
        fence_token: secondFence,
        outcome: "succeeded",
        started_at: suspended!.attempt_started_at,
      });
      expect(history.rows[0]!.claimed_at.getTime()).toBeGreaterThan(
        history.rows[0]!.started_at.getTime(),
      );
      expect(
        Math.abs(history.rows[0]!.claimed_at.getTime() - claims.rows[1]!.occurred_at.getTime()),
      ).toBeLessThan(100);
      expect(history.rows[0]!.finished_at.getTime()).toBeGreaterThanOrEqual(
        history.rows[0]!.claimed_at.getTime(),
      );

      const finalDetail = await client.dashboard.taskDetail({ id: accepted.taskId });
      expect(finalDetail).toMatchObject({
        identity: { type: DURABLE_TIMER_TASK_TYPE, state: "succeeded" },
        current: { runtime: null, outcome: { attempt: 1, result: { waitReplayed: true } } },
        checkpoints: [
          { name: DURABLE_TIMER_PREPARE_CHECKPOINT, attempt: 1, fenceToken: firstFence },
          { name: DURABLE_TIMER_PUBLISH_CHECKPOINT, attempt: 1, fenceToken: secondFence },
        ],
        attempts: [
          {
            attempt: 1,
            outcome: "succeeded",
            startedAt: history.rows[0]!.started_at.toISOString(),
            claimedAt: history.rows[0]!.claimed_at.toISOString(),
            executionMs: expect.any(Number),
            elapsedMs: expect.any(Number),
          },
        ],
        waits: [{ name: DURABLE_TIMER_WAIT_NAME, fenceToken: firstFence }],
      });
      expect(finalDetail.attempts[0]!.elapsedMs).toBeGreaterThan(
        finalDetail.attempts[0]!.executionMs + 300,
      );
      expect(finalDetail.events.map((event) => event.type)).toEqual([
        "enqueued",
        "claimed",
        "checkpoint_saved",
        "wait_scheduled",
        "promoted",
        "wait_elapsed",
        "claimed",
        "wait_replayed",
        "checkpoint_saved",
        "succeeded",
      ]);
    } finally {
      await workhorse.stop();
    }
  });

  it("continues a declared durable pipeline without repeating completed steps", async () => {
    const operations: string[] = [];
    const { app, workhorse } = createTestApplication({
      onDurableStepOperation(scenario, stepName, attempt) {
        operations.push(`${scenario}:${stepName}:${attempt}`);
      },
    });
    workhorse.start();

    try {
      const accepted = {
        ...(await enqueueDemoTest("durable", "order-fulfillment")),
        scenario: "order-fulfillment",
        checkpointPlan: [
          "validate-order",
          "reserve-inventory",
          "authorize-payment",
          "arrange-shipment",
        ],
        expectedAttempts: 2,
      };
      expect(accepted).toMatchObject({
        scenario: "order-fulfillment",
        checkpointPlan: [
          "validate-order",
          "reserve-inventory",
          "authorize-payment",
          "arrange-shipment",
        ],
        expectedAttempts: 2,
      });

      let task: { state: string; currentAttempt: number; result: unknown } | undefined;
      for (let attempt = 0; attempt < 80 && task?.state !== "succeeded"; attempt += 1) {
        await sleep(25);
        task = (await workhorse.context.admin.getTask(accepted.taskId)) as typeof task;
      }
      expect(task).toMatchObject({
        state: "succeeded",
        currentAttempt: 2,
        result: {
          scenario: "order-fulfillment",
          completed: true,
          attempt: 2,
          reusedCheckpoints: ["validate-order", "reserve-inventory"],
          artifacts: {
            "validate-order": { completedOnAttempt: 1 },
            "reserve-inventory": { completedOnAttempt: 1 },
            "authorize-payment": { completedOnAttempt: 2 },
            "arrange-shipment": { completedOnAttempt: 2 },
          },
        },
      });

      const checkpointRows = (
        await pool.query<{
          checkpoint_name: string;
          checkpoint_value: { operationId: string; completedOnAttempt: number };
          attempt: number;
        }>(
          `SELECT checkpoint_name, checkpoint_value, attempt
             FROM workhorse.task_checkpoint WHERE task_id = $1 ORDER BY created_at, checkpoint_name`,
          [accepted.taskId],
        )
      ).rows;
      expect(
        checkpointRows.map((row) => ({ name: row.checkpoint_name, attempt: row.attempt })),
      ).toEqual([
        { name: "validate-order", attempt: 1 },
        { name: "reserve-inventory", attempt: 1 },
        { name: "authorize-payment", attempt: 2 },
        { name: "arrange-shipment", attempt: 2 },
      ]);
      expect(new Set(checkpointRows.map((row) => row.checkpoint_value.operationId)).size).toBe(4);
      expect(operations).toEqual([
        "order-fulfillment:validate-order:1",
        "order-fulfillment:reserve-inventory:1",
        "order-fulfillment:authorize-payment:2",
        "order-fulfillment:arrange-shipment:2",
      ]);

      const client = dashboardClient(app);
      expect(await client.dashboard.taskDetail({ id: accepted.taskId })).toMatchObject({
        identity: { id: accepted.taskId, state: "succeeded", type: "demo.durable-pipeline" },
        durability: {
          source: "demo-declared",
          scenario: "order-fulfillment",
          label: "Order fulfillment",
          steps: [
            { name: "validate-order" },
            { name: "reserve-inventory" },
            { name: "authorize-payment" },
            { name: "arrange-shipment" },
          ],
        },
        checkpoints: [{ attempt: 1 }, { attempt: 1 }, { attempt: 2 }, { attempt: 2 }],
      });
      await pool.query(
        `INSERT INTO workhorse.task_checkpoint
          (task_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id)
         VALUES ($1, 'diagnostic-extra', '{"output":"extra evidence"}'::jsonb, 2, 999999, 'test')`,
        [accepted.taskId],
      );
      expect(
        await client.dashboard.tasks({ filter: "retried", page: 1, pageSize: 25 }),
      ).toMatchObject({
        tasks: [
          {
            id: accepted.taskId,
            durability: { completedSteps: 4, totalSteps: 4 },
          },
        ],
      });
      expect(await client.dashboard.taskDetail({ id: accepted.taskId })).toMatchObject({
        durability: { steps: expect.any(Array) },
        checkpoints: expect.arrayContaining([
          expect.objectContaining({
            name: "diagnostic-extra",
            value: { output: "extra evidence" },
          }),
        ]),
      });
      expect(
        await pool.query(
          `SELECT count(*)::integer AS count FROM workhorse.task_event
            WHERE task_id = $1 AND event_type = 'checkpoint_saved'`,
          [accepted.taskId],
        ),
      ).toMatchObject({ rows: [{ count: 4 }] });
    } finally {
      await workhorse.stop();
    }
  });

  it.each([
    {
      scenario: "customer-onboarding",
      reused: ["create-account"],
      operations: [
        "customer-onboarding:create-account:1",
        "customer-onboarding:provision-workspace:2",
        "customer-onboarding:send-welcome:2",
      ],
      checkpointAttempts: [1, 2, 2],
    },
    {
      scenario: "report-publication",
      reused: ["snapshot-data", "render-report", "publish-report"],
      operations: [
        "report-publication:snapshot-data:1",
        "report-publication:render-report:1",
        "report-publication:publish-report:1",
      ],
      checkpointAttempts: [1, 1, 1],
    },
  ] as const)("resumes $scenario from its distinct durable boundary", async (example) => {
    const operations: string[] = [];
    const { workhorse } = createTestApplication({
      onDurableStepOperation(scenario, stepName, attempt) {
        operations.push(`${scenario}:${stepName}:${attempt}`);
      },
    });
    workhorse.start();

    try {
      const accepted = await enqueueDemoTest("durable", example.scenario);
      let task: { state: string; currentAttempt: number; result: unknown } | undefined;
      for (let attempt = 0; attempt < 80 && task?.state !== "succeeded"; attempt += 1) {
        await sleep(25);
        task = (await workhorse.context.admin.getTask(accepted.taskId)) as typeof task;
      }

      expect(task).toMatchObject({
        state: "succeeded",
        currentAttempt: 2,
        result: { reusedCheckpoints: example.reused },
      });
      expect(operations).toEqual(example.operations);
      expect(
        (
          await pool.query<{ attempt: number }>(
            `SELECT attempt FROM workhorse.task_checkpoint
              WHERE task_id = $1 ORDER BY created_at, checkpoint_name`,
            [accepted.taskId],
          )
        ).rows.map((row) => row.attempt),
      ).toEqual(example.checkpointAttempts);
      expect(
        (
          await pool.query<{ attempt: number; outcome: string }>(
            `SELECT attempt, outcome FROM workhorse.attempt_history
              WHERE task_id = $1 ORDER BY attempt`,
            [accepted.taskId],
          )
        ).rows,
      ).toEqual([
        { attempt: 1, outcome: "retry" },
        { attempt: 2, outcome: "succeeded" },
      ]);
    } finally {
      await workhorse.stop();
    }
  });

  it("records an intentional terminal failure and exposes it in the dashboard", async () => {
    const { app, workhorse } = createTestApplication();
    workhorse.start();

    try {
      const accepted = await enqueueDemoTest("failure");

      let state: string | undefined;
      for (let attempt = 0; attempt < 40 && state !== "failed"; attempt += 1) {
        await sleep(25);
        state = (await workhorse.context.admin.getTask(accepted.taskId))?.state;
      }
      expect(state).toBe("failed");

      const client = dashboardClient(app);
      expect(
        await client.dashboard.tasks({ filter: "discarded", page: 1, pageSize: 25 }),
      ).toMatchObject({
        filter: "discarded",
        total: 1,
        tasks: [{ id: accepted.taskId, type: "demo.failure", state: "failed" }],
      });
      await expect(client.dashboard.taskCounts()).resolves.toMatchObject({
        all: 1,
        discarded: 1,
      });
      expect(await client.dashboard.system({ window: "1h" })).toMatchObject({
        status: { level: "healthy", reasons: [] },
        failingTypes: [
          expect.objectContaining({
            queue: "demo",
            type: "demo.failure",
            attempts: 1,
            terminalFailures: 1,
          }),
        ],
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("fires a recurring definition and exposes its occurrence and task in the dashboard", async () => {
    await syncDemoSchedules(pool);
    await pool.query(
      `UPDATE workhorse.schedule_definition
          SET last_evaluated_at = clock_timestamp() - interval '1 hour'
        WHERE namespace = $1 AND schedule_name = ANY($2::text[])`,
      [DEMO_SCHEDULE_NAMESPACE, [HEARTBEAT_SCHEDULE_NAME, LONG_RUNNING_SCHEDULE_NAME]],
    );
    const { app, workhorse } = createTestApplication();
    workhorse.start();

    try {
      let taskId: string | undefined;
      let state: string | undefined;
      for (let attempt = 0; attempt < 40 && state !== "succeeded"; attempt += 1) {
        await sleep(25);
        const occurrence = await pool.query<{ task_id: string | null }>(
          `SELECT task_id FROM workhorse.schedule_occurrence
            WHERE namespace = $1 AND schedule_name = $2
            ORDER BY occurrence_at DESC LIMIT 1`,
          [DEMO_SCHEDULE_NAMESPACE, HEARTBEAT_SCHEDULE_NAME],
        );
        taskId = occurrence.rows[0]?.task_id ?? undefined;
        state = taskId ? (await workhorse.context.admin.getTask(taskId))?.state : undefined;
      }
      expect(taskId).toBeDefined();
      expect(state).toBe("succeeded");

      const longRunningTask = await waitFor(
        async () => {
          const occurrence = await pool.query<{ task_id: string | null }>(
            `SELECT task_id FROM workhorse.schedule_occurrence
              WHERE namespace = $1 AND schedule_name = $2
              ORDER BY occurrence_at DESC LIMIT 1`,
            [DEMO_SCHEDULE_NAMESPACE, LONG_RUNNING_SCHEDULE_NAME],
          );
          const recurringTaskId = occurrence.rows[0]?.task_id;
          return recurringTaskId ? workhorse.context.admin.getTask(recurringTaskId) : null;
        },
        (task) => task?.state === "succeeded",
      );
      expect(longRunningTask).toMatchObject({ type: "demo.long-running", state: "succeeded" });

      const client = dashboardClient(app);
      const cron = await client.dashboard.cron();
      expect(cron.schedules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            namespace: DEMO_SCHEDULE_NAMESPACE,
            name: HEARTBEAT_SCHEDULE_NAME,
            occurrenceCount: 1,
            evaluatorCount: 3,
          }),
          expect.objectContaining({
            namespace: DEMO_SCHEDULE_NAMESPACE,
            name: LONG_RUNNING_SCHEDULE_NAME,
            occurrenceCount: 1,
            evaluatorCount: 3,
          }),
        ]),
      );
      const completed = await client.dashboard.tasks({
        filter: "completed",
        page: 1,
        pageSize: 25,
      });
      expect(completed.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: taskId, type: "demo.recurring", state: "succeeded" }),
          expect.objectContaining({
            type: "demo.long-running",
            state: "succeeded",
          }),
        ]),
      );
    } finally {
      await workhorse.stop();
    }
  });
});
