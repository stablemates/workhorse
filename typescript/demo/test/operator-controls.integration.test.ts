/**
 * What the dashboard operator may do, and what the demo audits when it does.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Queue } from "@stablemates/workhorse";
import { readDashboardIdempotencyEvidence } from "@stablemates/workhorse-dashboard/wire";
import {
  createLocalOperator,
  createLocalScheduleController,
  DEMO_OPERATOR_IDEMPOTENCY_KEY,
  DEMO_OPERATOR_IDEMPOTENCY_SCOPE,
  DEMO_OPERATOR_MAX_PENDING_TASKS,
  DEMO_QUEUE,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_WORKER_CONCURRENCY,
  DURABLE_TIMER_TASK_TYPE,
  HEARTBEAT_SCHEDULE_NAME,
  RECURRING_TASK_TYPE,
  REPORT_SCHEDULE_NAME,
  syncDemoSchedules,
} from "../src/app.js";
import { createDemoIntegrationSuite } from "./support/demo-integration.js";

const { createTestApplication, dashboardClient, database, pool, waitForRegisteredWorker } =
  createDemoIntegrationSuite(import.meta.url);

describe("Workhorse demo", () => {
  it("keeps default dashboard operator read-only", async () => {
    const { app } = createTestApplication();
    const client = dashboardClient(app);

    await expect(
      client.dashboard.enqueueTest({
        kind: "success",
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-enqueue" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    await expect(
      client.dashboard.setSchedulePaused({
        kind: "user",
        namespace: DEMO_SCHEDULE_NAMESPACE,
        name: HEARTBEAT_SCHEDULE_NAME,
        paused: true,
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-toggle" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    await expect(
      client.dashboard.setQueuePaused({
        queue: "default",
        paused: true,
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-queue" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    await expect(
      client.dashboard.purgeQueue({
        queue: "default",
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-purge" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    await expect(
      client.dashboard.setWorkerPaused({
        workerId: "any-worker",
        paused: true,
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-worker" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    expect(
      await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_demo_audit"),
    ).toMatchObject({
      rows: [{ count: 0 }],
    });
  });

  it("keeps a long-running test task active for the configured duration", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningTaskMs: 250,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "long-running",
        audit: {
          actor: "operator",
          reason: "observe active work",
          requestId: "audit-long-running",
        },
      });

      let observedRunning = false;
      for (let attempt = 0; attempt < 40 && !observedRunning; attempt += 1) {
        await sleep(10);
        observedRunning = (
          await client.dashboard.tasks({ filter: "running", page: 1, pageSize: 25 })
        ).tasks.some((task) => task.id === enqueued.taskId);
      }
      expect(observedRunning).toBe(true);

      let detail = await client.dashboard.taskDetail({ id: enqueued.taskId });
      for (let attempt = 0; attempt < 40 && detail.identity.state !== "succeeded"; attempt += 1) {
        await sleep(10);
        detail = await client.dashboard.taskDetail({ id: enqueued.taskId });
      }
      expect(detail).toMatchObject({
        identity: { id: enqueued.taskId, type: "demo.long-running", state: "succeeded" },
        progress: {
          value: { phase: "complete", completed: 250, total: 250 },
          revision: "2",
          attempt: 1,
        },
        current: { outcome: { result: { completed: true, durationMs: 250 } } },
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("enqueues a deterministic checkpoint retry from the dashboard operator", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);

    const enqueued = await client.dashboard.enqueueTest({
      kind: "retry",
      priority: 73,
      audit: {
        actor: "operator",
        reason: "show durable checkpoint reuse",
        requestId: "audit-checkpoint-retry",
      },
    });

    expect(await client.dashboard.taskDetail({ id: enqueued.taskId })).toMatchObject({
      identity: { id: enqueued.taskId, type: "demo.retry", state: "ready", priority: 73 },
      payload: { label: "operator-retry", failUntilAttempt: 1 },
      checkpoints: [],
    });
    expect(
      await pool.query("SELECT max_attempts, tags FROM workhorse.task WHERE id = $1", [
        enqueued.taskId,
      ]),
    ).toMatchObject({
      rows: [{ max_attempts: 3, tags: ["demo-test", "durable-checkpoint"] }],
    });
    expect(
      (await client.dashboard.system({ window: "1h" })).queues.find(
        (row) => row.queue === DEMO_QUEUE,
      )?.priorityBacklog,
    ).toContainEqual(expect.objectContaining({ priority: 73, ready: 1 }));
    await expect(
      client.dashboard.enqueueTest({
        kind: "success",
        priority: 101,
        audit: {
          actor: "operator",
          reason: "reject invalid priority",
          requestId: "invalid-priority",
        },
      }),
    ).rejects.toThrow(/input validation/i);

    const timer = await client.dashboard.enqueueTest({
      kind: "timer",
      audit: {
        actor: "operator",
        reason: "show named durable timer replay",
        requestId: "audit-durable-timer",
      },
    });
    expect(await client.dashboard.taskDetail({ id: timer.taskId })).toMatchObject({
      identity: { id: timer.taskId, type: DURABLE_TIMER_TASK_TYPE, state: "ready" },
      payload: { source: "operator" },
      waits: [],
      checkpoints: [],
    });
    expect(
      await pool.query("SELECT max_attempts, tags FROM workhorse.task WHERE id = $1", [
        timer.taskId,
      ]),
    ).toMatchObject({
      rows: [
        {
          max_attempts: 1,
          tags: ["demo-test", "durable-checkpoint", "durable-timer"],
        },
      ],
    });
    expect(
      await pool.query(
        `SELECT action, target FROM public.workhorse_demo_audit WHERE request_id = $1`,
        ["audit-durable-timer"],
      ),
    ).toMatchObject({ rows: [{ action: "enqueueTest", target: "task:timer" }] });

    for (const example of [
      { scenario: "order-fulfillment", totalSteps: 4 },
      { scenario: "customer-onboarding", totalSteps: 3 },
      { scenario: "report-publication", totalSteps: 3 },
    ] as const) {
      const durable = await client.dashboard.enqueueTest({
        kind: "durable",
        scenario: example.scenario,
        audit: {
          actor: "operator",
          reason: `show ${example.scenario} durable progress`,
          requestId: `audit-durable-${example.scenario}`,
        },
      });
      const detail = await client.dashboard.taskDetail({ id: durable.taskId });
      expect(detail).toMatchObject({
        identity: { id: durable.taskId, type: "demo.durable-pipeline", state: "ready" },
        payload: { scenario: example.scenario },
        durability: { source: "demo-declared", scenario: example.scenario },
        checkpoints: [],
      });
      expect(detail.durability?.steps).toHaveLength(example.totalSteps);
      expect(
        await client.dashboard.tasks({ filter: "queued", page: 1, pageSize: 25 }),
      ).toMatchObject({
        tasks: expect.arrayContaining([
          expect.objectContaining({
            id: durable.taskId,
            durability: { completedSteps: 0, totalSteps: example.totalSteps },
          }),
        ]),
      });
    }
  });

  it("enqueues the declared live example for a feature family with its audit trail", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);

    const contract = await client.dashboard.enqueueTest({
      kind: "feature",
      feature: "payload-contracts",
      priority: 12,
      audit: {
        actor: "operator",
        reason: "show contract validation",
        requestId: "audit-feature-contract",
      },
    });
    expect(await client.dashboard.taskDetail({ id: contract.taskId })).toMatchObject({
      identity: {
        id: contract.taskId,
        type: "demo.contract-check",
        state: "ready",
        priority: 12,
      },
      payload: {
        source: "feature-showcase-operator",
        family: "payload-contracts",
        scenario: "validated-acceptance",
        invoiceId: "INV-validated-acceptance",
      },
    });
    expect(
      await pool.query(
        `SELECT action, target, after FROM public.workhorse_demo_audit WHERE request_id = $1`,
        ["audit-feature-contract"],
      ),
    ).toMatchObject({
      rows: [
        {
          action: "enqueueTest",
          target: "task:feature:payload-contracts",
          after: expect.objectContaining({ taskId: contract.taskId, memberCount: 1 }),
        },
      ],
    });

    // The batch example accepts its whole member group in one click, so a digest can form.
    const batch = await client.dashboard.enqueueTest({
      kind: "feature",
      feature: "batch-handlers",
      audit: {
        actor: "operator",
        reason: "show one grouped digest",
        requestId: "audit-feature-batch",
      },
    });
    expect(batch.taskId).toEqual(expect.any(String));
    expect(
      await pool.query(
        `SELECT count(*)::integer AS members FROM workhorse.task
          WHERE task_type = 'demo.batch-digest'
            AND payload->>'source' = 'feature-showcase-operator'`,
      ),
    ).toMatchObject({ rows: [{ members: 3 }] });

    await expect(
      client.dashboard.enqueueTest({
        kind: "feature",
        audit: {
          actor: "operator",
          reason: "reject a missing family",
          requestId: "audit-feature-missing",
        },
      }),
    ).rejects.toThrow(/input validation/i);
  });

  it("runs an operator feature example through the ordinary worker path", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "feature",
        feature: "ingress-routing",
        audit: {
          actor: "operator",
          reason: "run one live ingress example",
          requestId: "audit-feature-ingress",
        },
      });
      let detail = await client.dashboard.taskDetail({ id: enqueued.taskId });
      for (let attempt = 0; attempt < 200 && detail.identity.state !== "succeeded"; attempt += 1) {
        await sleep(10);
        detail = await client.dashboard.taskDetail({ id: enqueued.taskId });
      }
      expect(detail).toMatchObject({
        identity: { id: enqueued.taskId, type: "demo.ingress-routing", state: "succeeded" },
        payload: {
          source: "feature-showcase-operator",
          family: "ingress-routing",
          scenario: "immediate-tagged",
        },
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("supports audited local enqueue and schedule toggles", async () => {
    await syncDemoSchedules(pool);
    const { app } = createTestApplication({
      operator: createLocalOperator(database),
      scheduleController: createLocalScheduleController(database),
    });
    const client = dashboardClient(app);

    const enqueued = await client.dashboard.enqueueTest({
      kind: "success",
      audit: { actor: "operator", reason: "smoke enqueue", requestId: "audit-enqueue" },
    });
    expect(enqueued.taskId).toEqual(expect.any(String));
    expect(await client.dashboard.taskDetail({ id: enqueued.taskId })).toMatchObject({
      identity: { id: enqueued.taskId, state: "ready" },
      payload: { source: "operator" },
    });
    expect(
      await client.dashboard.setSchedulePaused({
        kind: "user",
        namespace: DEMO_SCHEDULE_NAMESPACE,
        name: REPORT_SCHEDULE_NAME,
        paused: true,
        audit: { actor: "operator", reason: "pause reports", requestId: "audit-toggle" },
      }),
    ).toEqual({ paused: true });
    await syncDemoSchedules(pool);
    expect(
      await pool.query(
        `SELECT configured_enabled, paused FROM workhorse.schedule_definition
          WHERE namespace = $1 AND schedule_name = $2`,
        [DEMO_SCHEDULE_NAMESPACE, REPORT_SCHEDULE_NAME],
      ),
    ).toMatchObject({ rows: [{ configured_enabled: true, paused: true }] });
    expect(
      (
        await pool.query(
          `SELECT action, target, actor, reason, request_id, before, after, status
             FROM public.workhorse_demo_audit ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      {
        action: "enqueueTest",
        target: "task:success",
        actor: "local-demo",
        reason: "smoke enqueue",
        request_id: "audit-enqueue",
        before: null,
        after: expect.objectContaining({ taskId: enqueued.taskId }),
        status: "succeeded",
      },
      {
        action: "setSchedulePaused",
        target: `schedule:${DEMO_SCHEDULE_NAMESPACE}:${REPORT_SCHEDULE_NAME}`,
        actor: "local-demo",
        reason: "pause reports",
        request_id: "audit-toggle",
        before: { paused: false },
        after: { paused: true },
        status: "succeeded",
      },
    ]);
  });

  it("refuses operator admissions while the pending-work budget is saturated", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const queue = new Queue(pool, DEMO_QUEUE);

    // Tasks admitted outside the operator surface still occupy the same fleet budget.
    const taskIds = await queue.enqueueMany(
      Array.from({ length: DEMO_OPERATOR_MAX_PENDING_TASKS }, (_, index) => ({
        type: RECURRING_TASK_TYPE,
        payload: { source: "budget-fill", index },
      })),
    );

    await expect(
      client.dashboard.enqueueTest({
        kind: "success",
        audit: { actor: "operator", reason: "saturated budget", requestId: "audit-budget" },
      }),
    ).rejects.toThrow(/operator-admitted work/);
    // Every task-creating mutation shares the ceiling, not just enqueueTest.
    await expect(
      client.dashboard.redriveDeadLetters({
        queue: null,
        taskType: null,
        tags: [],
        limit: 1,
        cursor: null,
        audit: { actor: "operator", reason: "saturated budget", requestId: "audit-budget-redrive" },
      }),
    ).rejects.toThrow(/operator-admitted work/);
    // Mutations that act on existing work stay available under saturation; this one drains it.
    await expect(
      client.dashboard.cancelTask({
        id: taskIds[0]!,
        audit: { actor: "operator", requestId: "audit-budget-cancel" },
      }),
    ).resolves.toMatchObject({ status: "canceled" });
    await expect(
      client.dashboard.enqueueTest({
        kind: "success",
        audit: { actor: "operator", reason: "drained budget", requestId: "audit-budget-drained" },
      }),
    ).resolves.toMatchObject({ taskId: expect.any(String) });
  });

  it("pauses a local worker through RPC and audits the in-memory state change", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      // Workers are unnamed, so the fleet is discovered from the registry rather than assumed.
      const defaultQueueWorker = await waitForRegisteredWorker(client);
      const workerId = defaultQueueWorker.id;
      expect(defaultQueueWorker).toMatchObject({
        paused: false,
        registered: true,
        lastHeartbeatAt: expect.any(String),
      });
      await expect(client.dashboard.workers()).resolves.toMatchObject({ canManageWorkers: true });
      await expect(
        client.dashboard.setWorkerPaused({
          workerId,
          paused: true,
          audit: {
            actor: "operator",
            reason: "pause one demo worker",
            requestId: "worker-pause",
          },
        }),
      ).resolves.toEqual({ paused: true });

      await expect(client.dashboard.workers()).resolves.toMatchObject({
        workers: expect.arrayContaining([
          expect.objectContaining({
            id: workerId,
            paused: true,
            registered: true,
            lastHeartbeatAt: expect.any(String),
          }),
        ]),
      });
      expect(
        (
          await pool.query(
            `SELECT action, target, actor, reason, request_id, before, after, status
               FROM public.workhorse_demo_audit ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        {
          action: "setWorkerPaused",
          target: `worker:${workerId}`,
          actor: "local-demo",
          reason: "pause one demo worker",
          request_id: "worker-pause",
          before: { paused: false },
          after: { paused: true },
          status: "succeeded",
        },
      ]);
    } finally {
      await workhorse.stop();
    }
  });

  it("declares deterministic demo worker concurrency and projects it through RPC", async () => {
    expect(DEMO_WORKER_CONCURRENCY).toEqual([3, 3, 3]);

    const { app, workhorse } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    // Declared concurrency travels through the durable registry rather than a process-local Worker
    // object, and the workers are unnamed, so the fleet is discovered rather than looked up by id.
    workhorse.start();

    try {
      const defaultQueueWorker = await waitForRegisteredWorker(client);
      expect(defaultQueueWorker).toMatchObject({
        concurrency: 3,
        activeSlots: 0,
        activeTasks: 0,
        paused: false,
        draining: false,
      });
      // Generated identities, not names the application chose.
      expect(defaultQueueWorker.id).toMatch(/^\S+-\d+-[\da-f]{8}$/);
    } finally {
      await workhorse.stop();
    }
  });

  it("opens the same task every time the operator repeats the idempotent scenario", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const first = await client.dashboard.enqueueTest({
      kind: "idempotent",
      audit: { actor: "operator", reason: "show deduplication", requestId: "audit-idempotent-1" },
    });
    const second = await client.dashboard.enqueueTest({
      kind: "idempotent",
      audit: { actor: "operator", reason: "show deduplication", requestId: "audit-idempotent-2" },
    });
    expect(first).toMatchObject({ outcome: "accepted" });
    expect(second).toMatchObject({ taskId: first.taskId, outcome: "replayed" });
    expect(
      (await pool.query(`SELECT count(*)::integer AS count FROM workhorse.task`)).rows[0],
    ).toEqual({ count: 1 });

    const detail = await client.dashboard.taskDetail({ id: first.taskId });
    const enqueued = detail.events.find((event) => event.type === "enqueued");
    expect(
      readDashboardIdempotencyEvidence({ type: enqueued!.type, details: enqueued!.details }),
    ).toMatchObject({ scope: DEMO_OPERATOR_IDEMPOTENCY_SCOPE });
    expect(JSON.stringify(detail)).not.toContain(DEMO_OPERATOR_IDEMPOTENCY_KEY);

    // Both attempts are audited even though only one task identity exists.
    expect(
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM public.workhorse_demo_audit WHERE action = 'enqueueTest'`,
        )
      ).rows[0],
    ).toEqual({ count: 2 });
  });
});
