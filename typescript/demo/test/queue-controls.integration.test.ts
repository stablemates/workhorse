/**
 * Queue mutations, policy reads, schedule reconciliation, and retention health.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import { Queue } from "@stablemates/workhorse";
import {
  createLocalOperator,
  createLocalOperatorControllers,
  createLocalScheduleController,
  DEMO_SCHEDULE_NAMESPACE,
  HEARTBEAT_SCHEDULE_NAME,
  syncDemoSchedules,
} from "../src/app.js";
import { createDemoIntegrationSuite } from "./support/demo-integration.js";

const { createTestApplication, dashboardClient, database, pool } = createDemoIntegrationSuite(
  import.meta.url,
);

describe("Workhorse demo", () => {
  it("reads queue stats and audits pause, resume, and safe purge mutations", async () => {
    const queueName = "managed-demo";
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      queueController: createLocalOperatorControllers(database).queueController,
    });
    const client = dashboardClient(app);
    await new Queue(pool).syncConcurrencyPolicies("dashboard-test", [
      { queue: queueName, maxActive: 1, maxActivePerKey: 1 },
      { queue: "policy-only-demo", maxActive: 3 },
      { queue: "terminal-demo", maxActive: 2, maxActivePerKey: 1 },
    ]);
    const activeId = await workhorse.context.queue.enqueue(
      "active",
      {},
      {
        queue: queueName,
        concurrencyKey: "tenant-secret",
      },
    );
    expect((await workhorse.context.queue.claim("demo-worker", { queue: queueName }))?.id).toBe(
      activeId,
    );
    const readyId = await workhorse.context.queue.enqueue(
      "ready",
      {},
      {
        queue: queueName,
        concurrencyKey: "tenant-secret",
      },
    );
    await workhorse.context.queue.enqueue(
      "scheduled",
      {},
      {
        queue: queueName,
        runAt: new Date(Date.now() + 60_000),
      },
    );

    const queuesPage = await client.dashboard.queues();
    expect(queuesPage).toMatchObject({
      queues: expect.arrayContaining([
        expect.objectContaining({
          queue: queueName,
          paused: false,
          scheduled: 1,
          ready: 1,
          active: 1,
          succeeded: 0,
          failed: 0,
          terminalCountsApproximate: false,
          concurrencyPolicy: {
            namespace: "dashboard-test",
            maxActive: 1,
            utilizationKnown: true,
            active: 1,
            available: 0,
            blockedReady: 1,
            maxActivePerKey: 1,
            saturatedKeys: 1,
            highestKeyActive: 1,
          },
        }),
      ]),
      concurrencyPoliciesCapped: false,
    });
    expect(queuesPage.queues.find((row) => row.queue === "policy-only-demo")).toMatchObject({
      paused: false,
      scheduled: 0,
      ready: 0,
      active: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
      concurrencyPolicy: {
        namespace: "dashboard-test",
        maxActive: 3,
        utilizationKnown: true,
        active: 0,
        available: 3,
        blockedReady: 0,
      },
    });
    const systemPage = await client.dashboard.system({ window: "1h" });
    expect(systemPage.queues.find((row) => row.queue === "policy-only-demo")).toMatchObject({
      paused: false,
      ready: 0,
      active: 0,
      concurrencyPolicy: {
        namespace: "dashboard-test",
        maxActive: 3,
        utilizationKnown: true,
        active: 0,
        available: 3,
        blockedReady: 0,
      },
    });
    await expect(client.dashboard.taskDetail({ id: readyId })).resolves.toMatchObject({
      identity: { concurrencyKey: "tenant-secret" },
      concurrencyPolicy: {
        namespace: "dashboard-test",
        maxActive: 1,
        utilizationKnown: true,
        active: 1,
        available: 0,
        blockedReady: 1,
        maxActivePerKey: 1,
      },
    });
    // A finished task keeps the key it was enqueued with, and still reports its queue's policy as
    // it stands now. Nothing snapshots the limits it ran under, so the drawer labels this current.
    const terminalId = await workhorse.context.queue.enqueue(
      "terminal",
      {},
      { queue: "terminal-demo", concurrencyKey: "tenant-finished" },
    );
    const terminalClaim = await workhorse.context.queue.claim("terminal-worker", {
      queue: "terminal-demo",
    });
    expect(terminalClaim?.id).toBe(terminalId);
    await workhorse.context.queue.complete(terminalClaim!, "terminal-worker", { done: true });
    await expect(client.dashboard.taskDetail({ id: terminalId })).resolves.toMatchObject({
      identity: { state: "succeeded", concurrencyKey: "tenant-finished" },
      current: { runtime: null },
      concurrencyPolicy: {
        namespace: "dashboard-test",
        maxActive: 2,
        maxActivePerKey: 1,
        utilizationKnown: false,
        active: 0,
      },
    });
    // The raw key still never leaves task detail.
    expect(
      JSON.stringify(
        await client.dashboard.tasks({
          filter: "all",
          page: 1,
          pageSize: 25,
          queue: "terminal-demo",
        }),
      ),
    ).not.toContain("tenant-finished");
    const taskList = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      queue: queueName,
    });
    const eventList = await client.dashboard.events({
      window: "1h",
      pageSize: 100,
      taskId: readyId,
    });
    expect(JSON.stringify(taskList)).not.toContain("tenant-secret");
    expect(JSON.stringify(eventList)).not.toContain("tenant-secret");
    const enqueuedEvent = eventList.events.find((event) => event.type === "enqueued");
    expect(enqueuedEvent).toBeDefined();
    expect(
      JSON.stringify(await client.dashboard.eventDetail({ id: enqueuedEvent!.id })),
    ).not.toContain("tenant-secret");
    const system = await client.dashboard.system({ window: "15m" });
    expect(system.status.reasons).toContainEqual(
      expect.objectContaining({
        code: "concurrency-blocked",
        severity: "degraded",
        queue: queueName,
      }),
    );
    expect(system.queues.find((row) => row.queue === queueName)?.concurrencyPolicy).toMatchObject({
      available: 0,
      blockedReady: 1,
    });
    expect(system.concurrencyPoliciesCapped).toBe(false);
    await expect(
      client.dashboard.setQueuePaused({
        queue: queueName,
        paused: true,
        audit: { actor: "operator", reason: "pause queue", requestId: "queue-pause" },
      }),
    ).resolves.toEqual({ paused: true });
    await expect(
      workhorse.context.queue.claim("paused-worker", { queue: queueName }),
    ).resolves.toBeNull();
    await expect(
      client.dashboard.setQueuePaused({
        queue: queueName,
        paused: false,
        audit: { actor: "operator", reason: "resume queue", requestId: "queue-resume" },
      }),
    ).resolves.toEqual({ paused: false });
    await expect(
      client.dashboard.purgeQueue({
        queue: queueName,
        audit: { actor: "operator", reason: "clear queue", requestId: "queue-purge" },
      }),
    ).resolves.toEqual({ deletedCount: 2 });
    await expect(workhorse.context.admin.getTask(activeId)).resolves.toMatchObject({
      state: "active",
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
        action: "setQueuePaused",
        target: `queue:${queueName}`,
        actor: "local-demo",
        reason: "pause queue",
        request_id: "queue-pause",
        before: { paused: false },
        after: { paused: true },
        status: "succeeded",
      },
      {
        action: "setQueuePaused",
        target: `queue:${queueName}`,
        actor: "local-demo",
        reason: "resume queue",
        request_id: "queue-resume",
        before: { paused: true },
        after: { paused: false },
        status: "succeeded",
      },
      {
        action: "purgeQueue",
        target: `queue:${queueName}`,
        actor: "local-demo",
        reason: "clear queue",
        request_id: "queue-purge",
        before: { purgeable_tasks: 2 },
        after: { deletedCount: 2 },
        status: "succeeded",
      },
    ]);
  });

  it("reads exact policy without inventing live utilization beyond the health summary cap", async () => {
    const { app, workhorse } = createTestApplication();
    const client = dashboardClient(app);
    const queue = workhorse.context.queue;
    const terminalQueue = "zz-terminal-policy";
    await queue.syncConcurrencyPolicies("dashboard-cap-test", [
      ...Array.from({ length: 101 }, (_, index) => ({
        queue: `policy-${String(index).padStart(3, "0")}`,
        maxActive: 1,
      })),
      { queue: terminalQueue, maxActive: 7, maxActivePerKey: 3 },
    ]);

    const health = await queue.health();
    expect(health.concurrencyPolicies.capped).toBe(true);
    expect(health.concurrencyPolicies.policies).toHaveLength(100);
    expect(health.concurrencyPolicies.policies.map((policy) => policy.queue)).not.toContain(
      terminalQueue,
    );

    const taskId = await queue.enqueue(
      "terminal-beyond-policy-cap",
      {},
      { queue: terminalQueue, concurrencyKey: "tenant-private" },
    );
    // The ceiling is read from this queue's own policy row, so it is exact even past the cap. The
    // counts beside it were never measured, and none of them may be defaulted into a claim: an
    // `available` of 7 here would tell an operator the whole budget is free.
    await expect(client.dashboard.taskDetail({ id: taskId })).resolves.toMatchObject({
      identity: {
        state: "ready",
        concurrencyKey: "tenant-private",
      },
      current: { runtime: { state: "ready" } },
      concurrencyPolicy: {
        namespace: "dashboard-cap-test",
        maxActive: 7,
        maxActivePerKey: 3,
        utilizationKnown: false,
        active: 0,
        available: 0,
        blockedReady: 0,
        saturatedKeys: 0,
        highestKeyActive: 0,
      },
    });

    // A finished task in the same queue keeps its exact ceiling and the same unmeasured signal.
    const claim = await queue.claim("terminal-policy-worker", { queue: terminalQueue });
    expect(claim?.id).toBe(taskId);
    await queue.complete(claim!, "terminal-policy-worker", { done: true });
    await expect(client.dashboard.taskDetail({ id: taskId })).resolves.toMatchObject({
      identity: { state: "succeeded", concurrencyKey: "tenant-private" },
      current: { runtime: null },
      concurrencyPolicy: {
        namespace: "dashboard-cap-test",
        maxActive: 7,
        maxActivePerKey: 3,
        utilizationKnown: false,
        available: 0,
      },
    });

    // A queue inside the health sample still reports measured utilization, so the flag marks the
    // capped read specifically rather than every task detail.
    const measuredId = await queue.enqueue("inside-policy-cap", {}, { queue: "policy-000" });
    await expect(client.dashboard.taskDetail({ id: measuredId })).resolves.toMatchObject({
      concurrencyPolicy: {
        namespace: "dashboard-cap-test",
        maxActive: 1,
        utilizationKnown: true,
        active: 0,
        available: 1,
      },
    });
    expect(
      JSON.stringify(
        await client.dashboard.tasks({
          filter: "all",
          page: 1,
          pageSize: 25,
          queue: terminalQueue,
        }),
      ),
    ).not.toContain("tenant-private");
  });

  it("reconciles local schedule toggles with worker-owned schedule definitions", async () => {
    await syncDemoSchedules(pool);
    const { app } = createTestApplication({
      operator: createLocalOperator(database),
      scheduleController: createLocalScheduleController(database),
    });
    const client = dashboardClient(app);

    const cron = await client.dashboard.cron();
    expect(cron.maintenance).toMatchObject({
      cadences: { tickIntervalMs: 1_000 },
      policy: {
        timezone: "UTC",
        partitionPreparationIntervalMs: 21_600_000,
        terminalCleanupIntervalMs: 300_000,
        historyRetentionLocalTime: "03:00",
      },
      routines: expect.arrayContaining([
        expect.objectContaining({ routine: "history_partitions" }),
        expect.objectContaining({ routine: "history_retention" }),
        expect.objectContaining({ routine: "terminal_storage" }),
      ]),
    });
    expect(cron.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "user",
          identity: {
            kind: "user",
            namespace: DEMO_SCHEDULE_NAMESPACE,
            name: HEARTBEAT_SCHEDULE_NAME,
          },
          name: HEARTBEAT_SCHEDULE_NAME,
          active: true,
        }),
      ]),
    );

    await client.dashboard.setSchedulePaused({
      kind: "user",
      namespace: DEMO_SCHEDULE_NAMESPACE,
      name: HEARTBEAT_SCHEDULE_NAME,
      paused: true,
      audit: { actor: "operator", reason: "pause schedule", requestId: "schedule-disable" },
    });
    expect((await client.dashboard.cron()).schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: HEARTBEAT_SCHEDULE_NAME,
          configuredEnabled: true,
          paused: true,
          active: false,
        }),
      ]),
    );

    await client.dashboard.setSchedulePaused({
      kind: "user",
      namespace: DEMO_SCHEDULE_NAMESPACE,
      name: HEARTBEAT_SCHEDULE_NAME,
      paused: false,
      audit: { actor: "operator", reason: "resume schedule", requestId: "schedule-enable" },
    });
    expect((await client.dashboard.cron()).schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: HEARTBEAT_SCHEDULE_NAME,
          configuredEnabled: true,
          paused: false,
          active: true,
        }),
      ]),
    );
  });

  it("reports history spill as degraded rather than critical", async () => {
    // A timestamp older than every daily partition lands in the catch-all partition, which is
    // exactly the condition operators need to see. No sleeping or seed data is involved.
    await pool.query(
      `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts, created_at)
       VALUES ($1, 'demo', 'retention-spill', '{}'::jsonb, 1, timestamptz '2000-01-01T00:00:00Z')`,
      ["00000000-0000-4000-8000-000000000001"],
    );
    await pool.query(
      `INSERT INTO workhorse.task_event (task_id, attempt, event_type, details, occurred_at)
       VALUES ($1, 1, 'enqueued', '{}'::jsonb, timestamptz '2000-01-01T00:00:00Z')`,
      ["00000000-0000-4000-8000-000000000001"],
    );

    const { app } = createTestApplication();
    const client = dashboardClient(app);
    const system = await client.dashboard.system({ window: "1h" });

    expect(system.status.level).toBe("degraded");
    expect(system.status.reasons).toEqual([
      expect.objectContaining({
        code: "default-history-rows",
        severity: "degraded",
        observed: 1,
      }),
    ]);
    expect(system.integrity.retention.defaultHistoryRows).toEqual({
      taskEvents: 1,
      attemptHistory: 0,
    });
    // The row predates every partition cutoff, so it is spill rather than an un-dropped day.
    expect(system.integrity.retention.eligibleHistoryPartitions).toEqual({
      taskEvents: 0,
      attemptHistory: 0,
    });
    expect(system.integrity.defaultEventRows).toBe(1);
    expect(system.integrity.retention.oldestRetainedAt).toBe("2000-01-01T00:00:00.000Z");
    expect(system.integrity.retention.oldestRetainedCategory).toBe("taskEvents");

    // Retention is disabled by default in the demo, so no category can report lag.
    expect(system.integrity.retention.maxLagMs).toBeNull();
    expect(system.integrity.retention.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "taskEvents",
          lagMs: null,
          prunedByPartition: true,
        }),
      ]),
    );
  });

  it("reports a row-level retention category that is past its cutoff as degraded", async () => {
    // Schedule runs are the one row-level category the shipped policy enables (30 days), so this
    // needs no policy mutation and cannot collide with the identity-dependency check constraint.
    await syncDemoSchedules(pool);
    // Relative interval arithmetic keeps this free of time-zone and ISO-week dependence.
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence
         (namespace, schedule_name, occurrence_at, task_id, fired_at)
       VALUES ($1, $2, clock_timestamp() - interval '60 days', NULL,
               clock_timestamp() - interval '60 days')`,
      [DEMO_SCHEDULE_NAMESPACE, HEARTBEAT_SCHEDULE_NAME],
    );

    const { app } = createTestApplication();
    const system = await dashboardClient(app).dashboard.system({ window: "1h" });

    expect(system.status.level).toBe("degraded");
    expect(system.status.reasons).toEqual([
      expect.objectContaining({
        code: "retention-lag",
        severity: "degraded",
        category: "scheduleOccurrences",
      }),
    ]);

    const scheduleRuns = system.integrity.retention.categories.find(
      (row) => row.category === "scheduleOccurrences",
    );
    expect(scheduleRuns).toMatchObject({
      retentionDays: 30,
      prunedByPartition: false,
      oldestRetainedAt: expect.any(String),
    });
    // Roughly 30 days past the cutoff; a wide band keeps clock skew from making this flaky.
    expect(scheduleRuns?.lagMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(scheduleRuns?.lagMs).toBeLessThan(31 * 24 * 60 * 60 * 1000);
    expect(system.integrity.retention.maxLagCategory).toBe("scheduleOccurrences");
    expect(system.integrity.retention.maxLagMs).toBe(scheduleRuns?.lagMs);
    expect(system.integrity.retention.oldestRetainedCategory).toBe("scheduleOccurrences");

    // Categories the policy leaves disabled report no window and no lag rather than a false zero.
    expect(
      system.integrity.retention.categories.find((row) => row.category === "taskEvents"),
    ).toMatchObject({ retentionDays: null, lagMs: null });
    // Retention never escalates past degraded, and nothing spilled outside daily storage.
    expect(system.integrity.retention.defaultHistoryRows).toEqual({
      taskEvents: 0,
      attemptHistory: 0,
    });
  });

  it("keeps the retention policy read model aligned with the queue read model", async () => {
    const queue = new Queue(pool, "demo");
    const [health, { app }] = [await queue.health(), createTestApplication()];
    const system = await dashboardClient(app).dashboard.system({ window: "1h" });

    expect(system.integrity.retention.policyUpdatedAt).toBe(
      health.retentionPolicy.updatedAt.toISOString(),
    );
    expect(system.integrity.retention.categories.map((row) => row.category)).toEqual([
      "taskIdentity",
      "terminalOutcome",
      "taskEvents",
      "attemptHistory",
      "scheduleOccurrences",
      "statistics",
    ]);
    expect(
      system.integrity.retention.categories.find((row) => row.category === "scheduleOccurrences")
        ?.retentionDays,
    ).toBe(health.retentionPolicy.scheduleOccurrenceRetentionDays);
  });
});
