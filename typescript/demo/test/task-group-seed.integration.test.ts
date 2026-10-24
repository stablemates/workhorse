/**
 * The task group seed step and the task group driver of the daily load (ADR 0095).
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import type { Json } from "@stablemates/workhorse";
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import {
  DEMO_QUEUE,
  DEMO_RATE_LIMIT_SEED_NAME,
  DEMO_SHARED_QUEUE,
  DEMO_TASK_GROUP_LANGUAGES,
  FAST_TIER_SEED_NAME,
  HISTORICAL_SEED_NAME,
  LANGUAGE_WORKER_TASK_TYPE,
  LONG_RUNNING_SEED_NAME,
  REPRESENTATIVE_SEED_NAME,
  JVM_DOTNET_SEED_NAME,
  RUBY_SEED_NAME,
  RUST_SEED_NAME,
  SHARED_WORKER_TASK_TYPE,
  TASK_GROUP_DRIVER_TASK_TYPE,
  TASK_GROUP_SEED_NAME,
  seedDemoData,
} from "../src/app.js";
import { DEMO_QUEUE_OPTIONS } from "../src/contracts.js";
import { DEMO_FEATURE_SHOWCASE_SEED_NAME } from "../src/feature-showcase.js";
import { createDemoWorkerDefinition } from "../src/worker-definition.js";
import { createDemoIntegrationSuite } from "./support/demo-integration.js";

const { createTestApplication, dashboardClient, database, pool, waitFor } =
  createDemoIntegrationSuite(import.meta.url);

/**
 * Every marker a deployed demo carried before the task group step existed. The later JVM and .NET
 * step is marked too, so this file observes the task group step alone.
 */
const EXISTING_SEED_MARKERS = [
  DEMO_RATE_LIMIT_SEED_NAME,
  LONG_RUNNING_SEED_NAME,
  DEMO_FEATURE_SHOWCASE_SEED_NAME,
  REPRESENTATIVE_SEED_NAME,
  HISTORICAL_SEED_NAME,
  FAST_TIER_SEED_NAME,
  RUST_SEED_NAME,
  RUBY_SEED_NAME,
  JVM_DOTNET_SEED_NAME,
];

const LANGUAGE_QUEUES = DEMO_TASK_GROUP_LANGUAGES.map((entry) => entry.queue);

function adapter() {
  return createDrizzleAdapter(database, {
    defaultQueue: DEMO_QUEUE,
    queueOptions: DEMO_QUEUE_OPTIONS,
  });
}

/** Row versions of everything the task group step writes; any rewrite changes an `xmin`. */
async function seededRowVersions() {
  const result = await pool.query<{ source: string; key: string; version: string }>(
    `SELECT 'seed' AS source, name AS key, xmin::text AS version FROM public.workhorse_demo_seed
     UNION ALL
     SELECT 'task', id::text, xmin::text FROM workhorse.task
     UNION ALL
     SELECT 'group', id::text, xmin::text FROM workhorse.task_group
     ORDER BY 1, 2`,
  );
  return result.rows;
}

/**
 * Do what the Python, Go, Rust, and Ruby workers do with the ready member tasks: complete a task
 * whose language matches its queue, and fail a misrouted one. The integration suite runs only the
 * TypeScript worker, and that worker does not serve these queues.
 */
async function runLanguageMembers() {
  const { queue } = adapter();
  for (const { language, queue: queueName } of DEMO_TASK_GROUP_LANGUAGES) {
    const workerId = `test-${language}`;
    for (;;) {
      const claimed = await queue.claim<{ [key: string]: Json; language: string }>(workerId, {
        queue: queueName,
      });
      if (!claimed) break;
      if (claimed.payload.language === language) {
        await queue.complete(claimed, workerId, { language, runtime: language });
      } else {
        await queue.fail(claimed, workerId, new Error(`${language} worker received another task`));
      }
    }
  }
}

describe("Workhorse demo task group seed", () => {
  it("adds one group in each dashboard state to a database that carries every other marker", async () => {
    const { app } = createTestApplication({ workers: false });
    await pool.query("INSERT INTO public.workhorse_demo_seed (name) SELECT unnest($1::text[])", [
      EXISTING_SEED_MARKERS,
    ]);

    const seeded = await seedDemoData(database);
    expect(seeded).toMatchObject({ seeded: true, historicalTaskCount: 0 });
    // Four sealed groups of four members and an open group of two.
    expect(seeded.taskIds).toHaveLength(18);

    // No other step ran: the members are on the language queues, and the only other tasks are the
    // two callbacks that the canceled group enqueued on the shared queue.
    const tasks = await pool.query<{ queue: string; type: string; count: number }>(
      `SELECT queue_name AS queue, task_type AS type, count(*)::integer AS count
         FROM workhorse.task GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(tasks.rows).toEqual(
      [
        { queue: DEMO_SHARED_QUEUE, type: SHARED_WORKER_TASK_TYPE, count: 2 },
        ...DEMO_TASK_GROUP_LANGUAGES.map(({ queue }, index) => ({
          queue,
          type: LANGUAGE_WORKER_TASK_TYPE,
          // The open group holds the Python and Go members only.
          count: index < 2 ? 5 : 4,
        })),
      ].toSorted((left, right) => left.queue.localeCompare(right.queue)),
    );
    const markers = await pool.query<{ name: string }>(
      "SELECT name FROM public.workhorse_demo_seed ORDER BY name",
    );
    expect(markers.rows.map((row) => row.name)).toEqual(
      [...EXISTING_SEED_MARKERS, TASK_GROUP_SEED_NAME].toSorted(),
    );

    const { queue } = adapter();
    const groupOf = async (taskId: string) => (await queue.findTaskGroup(taskId))!.group.id;
    const [succeededId, failedId, pendingId, openId, canceledId] = await Promise.all(
      [0, 4, 8, 12, 14].map((index) => groupOf(seeded.taskIds[index]!)),
    );
    const client = dashboardClient(app);
    const groups = async () =>
      new Map(
        (await client.dashboard.taskGroups({ state: "all", page: 1, pageSize: 50 })).groups.map(
          (group) => [group.id, group],
        ),
      );

    const seededGroups = await groups();
    expect(seededGroups.size).toBe(5);
    for (const id of [succeededId!, failedId!, pendingId!]) {
      expect(seededGroups.get(id)).toMatchObject({
        state: "sealed",
        result: null,
        counts: { total: 4, pending: 4 },
      });
    }
    expect(seededGroups.get(openId!)).toMatchObject({
      state: "open",
      result: null,
      counts: { total: 2, pending: 2 },
    });
    expect(seededGroups.get(canceledId!)).toMatchObject({
      state: "finished",
      result: "failed",
      counts: { total: 4, succeeded: 0, failed: 0, canceled: 4, pending: 0 },
      canceledBy: "workhorse-demo-seed",
      callbacks: [
        { kind: "onFinish", taskId: expect.any(String) },
        { kind: "onSuccess", taskId: null },
        { kind: "onFailure", taskId: expect.any(String) },
      ],
    });

    // The language workers run the ready members. The held member keeps its group sealed.
    await runLanguageMembers();
    const finishedGroups = await groups();
    expect(finishedGroups.get(succeededId!)).toMatchObject({
      state: "finished",
      result: "succeeded",
      counts: { total: 4, succeeded: 4, pending: 0 },
      callbacks: [
        { kind: "onFinish", taskId: expect.any(String) },
        { kind: "onSuccess", taskId: expect.any(String) },
        { kind: "onFailure", taskId: null },
      ],
    });
    expect(finishedGroups.get(failedId!)).toMatchObject({
      state: "finished",
      result: "failed",
      counts: { total: 4, succeeded: 3, failed: 1, pending: 0 },
    });
    expect(finishedGroups.get(pendingId!)).toMatchObject({
      state: "sealed",
      counts: { total: 4, succeeded: 3, pending: 1 },
    });
    expect(finishedGroups.get(openId!)).toMatchObject({
      state: "open",
      counts: { total: 2, succeeded: 2, pending: 0 },
    });

    const before = await seededRowVersions();
    expect(await seedDemoData(database)).toEqual({
      seeded: false,
      taskIds: [],
      historicalTaskCount: 0,
    });
    expect(await seededRowVersions()).toEqual(before);
  });

  it("runs a driver that creates one sealed group on the language queues", async () => {
    const workhorse = adapter();
    const driverId = await workhorse.queue.enqueue(
      TASK_GROUP_DRIVER_TASK_TYPE,
      {},
      { maxAttempts: 1 },
    );
    const definition = createDemoWorkerDefinition(database, workhorse.queue, {
      concurrency: 1,
      workerId: "test-task-group-driver",
      pollMs: 20,
      registryIntervalMs: 100,
      maintenanceIntervalMs: 100,
      scheduleNamespaces: [],
    });
    const worker = workhorse.createWorker(definition.options);
    definition.configure(worker);
    const run = worker.run();
    try {
      const driver = await waitFor(
        () =>
          workhorse.admin.getTask<{
            groupId: string;
            expectedResult: "succeeded" | "failed";
            members: number;
          }>(driverId),
        (task) => task?.state === "succeeded",
        1000,
      );
      const { groupId, expectedResult, members } = driver!.result!;
      expect(members).toBe(DEMO_TASK_GROUP_LANGUAGES.length);
      expect(await workhorse.queue.getTaskGroup(groupId)).toMatchObject({
        state: "sealed",
        counts: { total: 4, pending: 4 },
      });
      const memberPage = await workhorse.queue.listTaskGroupMembers(groupId);
      expect(memberPage.members.map((member) => member.queue)).toEqual(LANGUAGE_QUEUES);

      await runLanguageMembers();
      const group = await workhorse.queue.getTaskGroup(groupId);
      expect(group).toMatchObject({ state: "finished", result: expectedResult });
      const callbacks = await pool.query<{ queue: string; type: string }>(
        `SELECT task.queue_name AS queue, task.task_type AS type
           FROM workhorse.task_group_callback callback
           JOIN workhorse.task task ON task.id = callback.task_id
          WHERE callback.group_id = $1`,
        [groupId],
      );
      expect(callbacks.rows).toEqual([
        { queue: DEMO_SHARED_QUEUE, type: SHARED_WORKER_TASK_TYPE },
        { queue: DEMO_SHARED_QUEUE, type: SHARED_WORKER_TASK_TYPE },
      ]);
    } finally {
      await worker.stop();
      await run;
    }
  });
});
