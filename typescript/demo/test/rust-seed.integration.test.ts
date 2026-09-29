/**
 * The Rust seed step: the Rust worker's full-tier and fast-tier queues join a demo database that
 * already ran every earlier seed step.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import {
  DEMO_FAST_TIER_QUEUES,
  DEMO_FAST_TIER_SCHEDULE_NAMESPACE,
  DEMO_RATE_LIMIT_SEED_NAME,
  DEMO_RUST_FAST_QUEUE,
  DEMO_RUST_FAST_TIER_QUEUE,
  DEMO_RUST_QUEUE,
  FAST_TIER_SEED_NAME,
  HISTORICAL_SEED_NAME,
  LONG_RUNNING_SEED_NAME,
  REPRESENTATIVE_SEED_NAME,
  RUST_SEED_NAME,
  seedDemoData,
} from "../src/app.js";
import { DEMO_FEATURE_SHOWCASE_SEED_NAME } from "../src/feature-showcase.js";
import { createDemoIntegrationSuite } from "./support/demo-integration.js";

const { createTestApplication, dashboardClient, database, pool } = createDemoIntegrationSuite(
  import.meta.url,
);

/** Every marker a deployed demo carried before the Rust step existed. */
const EXISTING_SEED_MARKERS = [
  DEMO_RATE_LIMIT_SEED_NAME,
  LONG_RUNNING_SEED_NAME,
  DEMO_FEATURE_SHOWCASE_SEED_NAME,
  REPRESENTATIVE_SEED_NAME,
  HISTORICAL_SEED_NAME,
  FAST_TIER_SEED_NAME,
];

/** Row versions of everything the Rust step writes; any rewrite changes an `xmin`. */
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

describe("Workhorse demo Rust seed", () => {
  it("adds the Rust queues to a database that already carries every other seed marker", async () => {
    const { app } = createTestApplication({ workers: false });
    await pool.query("INSERT INTO public.workhorse_demo_seed (name) SELECT unnest($1::text[])", [
      EXISTING_SEED_MARKERS,
    ]);

    const seeded = await seedDemoData(database);
    expect(seeded).toMatchObject({ seeded: true, historicalTaskCount: 0 });
    expect(seeded.taskIds).toHaveLength(5);

    // No earlier step ran again: the run inserted one full-tier task on `demo-rust` and a batch on
    // `demo-rust-fast`, and only the fast-tier batch lives in the fast-tier runtime table.
    const tasks = await pool.query<{ queue: string; count: number; fast: number }>(
      `SELECT task.queue_name AS queue,
              count(*)::integer AS count,
              count(runtime.task_id)::integer AS fast
         FROM workhorse.task
         LEFT JOIN workhorse.fast_task_runtime runtime ON runtime.task_id = task.id
        GROUP BY task.queue_name
        ORDER BY task.queue_name`,
    );
    expect(tasks.rows).toEqual([
      { queue: DEMO_RUST_QUEUE, count: 1, fast: 0 },
      { queue: DEMO_RUST_FAST_QUEUE, count: 4, fast: 4 },
    ]);
    const payloads = await pool.query<{ payload: unknown }>(
      "SELECT DISTINCT payload FROM workhorse.task",
    );
    expect(payloads.rows).toEqual([{ payload: { language: "rust" } }]);
    const markers = await pool.query<{ name: string }>(
      "SELECT name FROM public.workhorse_demo_seed ORDER BY name",
    );
    expect(markers.rows.map((row) => row.name)).toEqual(
      [...EXISTING_SEED_MARKERS, RUST_SEED_NAME].toSorted(),
    );

    // The sync replaces the namespace, so the earlier fast-tier schedules survive beside Rust's.
    const schedules = await pool.query<{ name: string; queue: string; cron: string }>(
      `SELECT schedule_name AS name, queue_name AS queue, cron_expression AS cron
         FROM workhorse.schedule_definition
        WHERE namespace = $1
        ORDER BY queue_name`,
      [DEMO_FAST_TIER_SCHEDULE_NAMESPACE],
    );
    expect(schedules.rows).toEqual(
      [...DEMO_FAST_TIER_QUEUES, DEMO_RUST_FAST_TIER_QUEUE]
        .toSorted((left, right) => left.queue.localeCompare(right.queue))
        .map((entry) => ({ name: entry.scheduleName, queue: entry.queue, cron: entry.schedule })),
    );

    const queuesPage = await dashboardClient(app).dashboard.queues();
    expect(queuesPage.queues.find((row) => row.queue === DEMO_RUST_FAST_QUEUE)).toMatchObject({
      tier: "fast",
      recordAttempts: true,
      recordClaims: false,
    });
    expect(queuesPage.queues.find((row) => row.queue === DEMO_RUST_QUEUE)).toMatchObject({
      tier: "full",
    });

    const before = await seededRowVersions();
    expect(await seedDemoData(database)).toEqual({
      seeded: false,
      taskIds: [],
      historicalTaskCount: 0,
    });
    expect(await seededRowVersions()).toEqual(before);
  });
});
