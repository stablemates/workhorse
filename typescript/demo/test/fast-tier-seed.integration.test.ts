/**
 * The fast-tier seed step: one fast-tier queue per demo language, its history switches, a seeded
 * batch, and a schedule.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import {
  DEMO_FAST_QUEUE,
  DEMO_FAST_TIER_QUEUES,
  DEMO_FAST_TIER_SCHEDULE_NAMESPACE,
  DEMO_RATE_LIMIT_SEED_NAME,
  FAST_TIER_SEED_NAME,
  HISTORICAL_SEED_NAME,
  LONG_RUNNING_SEED_NAME,
  REPRESENTATIVE_SEED_NAME,
  RUST_SEED_NAME,
  seedDemoData,
} from "../src/app.js";
import { DEMO_QUEUE_OPTIONS } from "../src/contracts.js";
import { DEMO_FEATURE_SHOWCASE_SEED_NAME } from "../src/feature-showcase.js";
import { createDemoWorkerDefinition } from "../src/worker-definition.js";
import { createDemoIntegrationSuite } from "./support/demo-integration.js";

const { createTestApplication, dashboardClient, database, pool, waitFor } =
  createDemoIntegrationSuite(import.meta.url);

/** Every marker a deployed demo carried before the fast-tier step existed. */
const EXISTING_SEED_MARKERS = [
  DEMO_RATE_LIMIT_SEED_NAME,
  LONG_RUNNING_SEED_NAME,
  DEMO_FEATURE_SHOWCASE_SEED_NAME,
  REPRESENTATIVE_SEED_NAME,
  HISTORICAL_SEED_NAME,
];

const FAST_QUEUE_NAMES = DEMO_FAST_TIER_QUEUES.map((entry) => entry.queue);

/**
 * Stand in for a deployed demo database: every earlier step already ran, so its marker exists. The
 * later Rust step is marked too, so this file observes the fast-tier step alone.
 */
async function markExistingSeedSteps() {
  await pool.query("INSERT INTO public.workhorse_demo_seed (name) SELECT unnest($1::text[])", [
    [...EXISTING_SEED_MARKERS, RUST_SEED_NAME],
  ]);
}

/** Row versions of everything the fast-tier step writes; any rewrite changes an `xmin`. */
async function seededRowVersions() {
  const result = await pool.query<{ source: string; key: string; version: string }>(
    `SELECT 'seed' AS source, name AS key, xmin::text AS version FROM public.workhorse_demo_seed
     UNION ALL
     SELECT 'task', id::text, xmin::text FROM workhorse.task
     UNION ALL
     SELECT 'fast-runtime', task_id::text, xmin::text FROM workhorse.fast_task_runtime
     UNION ALL
     SELECT 'queue', queue_name, xmin::text FROM workhorse.queue_control
     UNION ALL
     SELECT 'schedule', namespace || '/' || schedule_name, xmin::text
       FROM workhorse.schedule_definition
     ORDER BY 1, 2`,
  );
  return result.rows;
}

describe("Workhorse demo fast-tier seed", () => {
  it("adds the fast-tier queues to a database that already carries every other seed marker", async () => {
    const { app } = createTestApplication({ workers: false });
    await markExistingSeedSteps();

    const seeded = await seedDemoData(database);
    expect(seeded).toMatchObject({ seeded: true, historicalTaskCount: 0 });
    expect(seeded.taskIds).toHaveLength(FAST_QUEUE_NAMES.length * 4);

    // No earlier step ran again: every task the run inserted sits on a fast-tier queue, and each
    // one lives in the fast-tier runtime table.
    const tasks = await pool.query<{ queue: string; count: number; fast: number }>(
      `SELECT task.queue_name AS queue,
              count(*)::integer AS count,
              count(runtime.task_id)::integer AS fast
         FROM workhorse.task
         LEFT JOIN workhorse.fast_task_runtime runtime ON runtime.task_id = task.id
        GROUP BY task.queue_name
        ORDER BY task.queue_name`,
    );
    expect(tasks.rows).toEqual(
      FAST_QUEUE_NAMES.toSorted().map((queue) => ({ queue, count: 4, fast: 4 })),
    );
    const markers = await pool.query<{ name: string }>(
      "SELECT name FROM public.workhorse_demo_seed ORDER BY name",
    );
    expect(markers.rows.map((row) => row.name)).toEqual(
      [...EXISTING_SEED_MARKERS, RUST_SEED_NAME, FAST_TIER_SEED_NAME].toSorted(),
    );

    const schedules = await pool.query<{ name: string; queue: string; cron: string }>(
      `SELECT schedule_name AS name, queue_name AS queue, cron_expression AS cron
         FROM workhorse.schedule_definition
        WHERE namespace = $1
        ORDER BY queue_name`,
      [DEMO_FAST_TIER_SCHEDULE_NAMESPACE],
    );
    expect(schedules.rows).toEqual(
      DEMO_FAST_TIER_QUEUES.toSorted((left, right) => left.queue.localeCompare(right.queue)).map(
        (entry) => ({ name: entry.scheduleName, queue: entry.queue, cron: entry.schedule }),
      ),
    );

    const queuesPage = await dashboardClient(app).dashboard.queues();
    for (const entry of DEMO_FAST_TIER_QUEUES) {
      expect(queuesPage.queues.find((row) => row.queue === entry.queue)).toMatchObject({
        tier: "fast",
        recordAttempts: entry.history.recordAttempts,
        recordClaims: entry.history.recordClaims,
      });
    }
    expect(
      Object.fromEntries(DEMO_FAST_TIER_QUEUES.map((entry) => [entry.language, entry.history])),
    ).toEqual({
      typescript: { recordAttempts: true, recordClaims: true },
      python: { recordAttempts: false, recordClaims: true },
      go: { recordAttempts: false, recordClaims: false },
    });

    const before = await seededRowVersions();
    expect(await seedDemoData(database)).toEqual({
      seeded: false,
      taskIds: [],
      historicalTaskCount: 0,
    });
    expect(await seededRowVersions()).toEqual(before);
  });

  it("lets the TypeScript worker complete its seeded fast-tier tasks", async () => {
    const { app } = createTestApplication({ workers: false });
    await markExistingSeedSteps();
    const seeded = await seedDemoData(database);

    const typescriptTasks = await pool.query<{ id: string; delayed: boolean }>(
      `SELECT id::text, 'delayed' = ANY(tags) AS delayed
         FROM workhorse.task
        WHERE id = ANY($1::uuid[]) AND queue_name = $2`,
      [seeded.taskIds, DEMO_FAST_QUEUE],
    );
    expect(typescriptTasks.rows).toHaveLength(4);
    const delayed = typescriptTasks.rows.find((row) => row.delayed);
    const taskIds = typescriptTasks.rows.map((row) => row.id);

    const adapter = createDrizzleAdapter(database, {
      defaultQueue: DEMO_FAST_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    const definition = createDemoWorkerDefinition(database, adapter.queue, {
      queues: [DEMO_FAST_QUEUE],
      scheduleNamespaces: [DEMO_FAST_TIER_SCHEDULE_NAMESPACE],
      concurrency: 3,
      pollMs: 15,
    });
    // An operator can bring the delayed task forward, so the worker drains the whole queue.
    await expect(
      adapter.admin.runTaskNow(delayed!.id, {
        actor: "integration-test",
        reason: "drain the fast-tier queue",
        requestId: "fast-tier-run-now",
      }),
    ).resolves.toMatchObject({ status: "released" });
    const worker = adapter.createWorker(definition.options);
    definition.configure(worker);
    const run = worker.run();
    try {
      const outcomes = await waitFor(
        async () =>
          (
            await pool.query<{ state: string; result: unknown }>(
              `SELECT state, result FROM workhorse.fast_task_outcome
                WHERE task_id = ANY($1::uuid[])`,
              [taskIds],
            )
          ).rows,
        (rows) => rows.length === taskIds.length,
        5_000,
      );
      expect(outcomes).toEqual(
        taskIds.map(() => ({
          state: "succeeded",
          result: { language: "typescript", runtime: "node", attempt: 1 },
        })),
      );
    } finally {
      worker.stop();
      await run;
    }

    // The worker claims only its own language's queue, so the other two keep their batches.
    const live = await pool.query<{ queue: string; count: number }>(
      `SELECT queue_name AS queue, count(*)::integer AS count
         FROM workhorse.fast_task_runtime
        GROUP BY queue_name
        ORDER BY queue_name`,
    );
    expect(live.rows).toEqual(
      FAST_QUEUE_NAMES.filter((queue) => queue !== DEMO_FAST_QUEUE)
        .toSorted()
        .map((queue) => ({ queue, count: 4 })),
    );

    // The Queues page still lists a fast-tier queue that has no live tasks.
    const queuesPage = await dashboardClient(app).dashboard.queues();
    expect(queuesPage.queues.find((row) => row.queue === DEMO_FAST_QUEUE)).toMatchObject({
      tier: "fast",
      recordAttempts: true,
      recordClaims: true,
    });
  });
});
