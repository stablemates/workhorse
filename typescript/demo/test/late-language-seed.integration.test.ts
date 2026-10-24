/**
 * The late language seed steps: the Rust worker's queues, then the Ruby worker's, then the JVM and
 * .NET workers' queues together, join a demo database that already ran every earlier seed step.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import {
  DEMO_DOTNET_FAST_TIER_QUEUE,
  DEMO_DOTNET_QUEUE,
  DEMO_FAST_TIER_QUEUES,
  DEMO_FAST_TIER_SCHEDULE_NAMESPACE,
  DEMO_RATE_LIMIT_SEED_NAME,
  DEMO_RUBY_FAST_TIER_QUEUE,
  DEMO_RUBY_QUEUE,
  DEMO_RUST_FAST_TIER_QUEUE,
  DEMO_RUST_QUEUE,
  FAST_TIER_SEED_NAME,
  DEMO_JVM_FAST_TIER_QUEUE,
  DEMO_JVM_QUEUE,
  HISTORICAL_SEED_NAME,
  JVM_DOTNET_SEED_NAME,
  LONG_RUNNING_SEED_NAME,
  REPRESENTATIVE_SEED_NAME,
  RUBY_SEED_NAME,
  RUST_SEED_NAME,
  seedDemoData,
  TASK_GROUP_SEED_NAME,
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

/** Row versions of everything a late language step writes; any rewrite changes an `xmin`. */
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

describe("Workhorse demo late language seeds", () => {
  it.each([
    {
      step: "Rust",
      seedName: RUST_SEED_NAME,
      // The later steps are marked too, so this case observes the Rust step alone.
      otherMarkers: [RUBY_SEED_NAME, JVM_DOTNET_SEED_NAME, TASK_GROUP_SEED_NAME],
      languages: [{ queue: DEMO_RUST_QUEUE, fastTier: DEMO_RUST_FAST_TIER_QUEUE }],
      // The Rust step must not name Ruby's schedule: it would fire into `demo-ruby-fast` before the
      // Ruby step moves that queue to the fast tier.
      schedules: [...DEMO_FAST_TIER_QUEUES, DEMO_RUST_FAST_TIER_QUEUE],
    },
    {
      step: "Ruby",
      seedName: RUBY_SEED_NAME,
      otherMarkers: [RUST_SEED_NAME, JVM_DOTNET_SEED_NAME, TASK_GROUP_SEED_NAME],
      languages: [{ queue: DEMO_RUBY_QUEUE, fastTier: DEMO_RUBY_FAST_TIER_QUEUE }],
      schedules: [...DEMO_FAST_TIER_QUEUES, DEMO_RUST_FAST_TIER_QUEUE, DEMO_RUBY_FAST_TIER_QUEUE],
    },
    {
      step: "JVM and .NET",
      seedName: JVM_DOTNET_SEED_NAME,
      // A deployed demo already ran the task group step when this step arrived.
      otherMarkers: [RUST_SEED_NAME, RUBY_SEED_NAME, TASK_GROUP_SEED_NAME],
      languages: [
        { queue: DEMO_JVM_QUEUE, fastTier: DEMO_JVM_FAST_TIER_QUEUE },
        { queue: DEMO_DOTNET_QUEUE, fastTier: DEMO_DOTNET_FAST_TIER_QUEUE },
      ],
      schedules: [
        ...DEMO_FAST_TIER_QUEUES,
        DEMO_RUST_FAST_TIER_QUEUE,
        DEMO_RUBY_FAST_TIER_QUEUE,
        DEMO_JVM_FAST_TIER_QUEUE,
        DEMO_DOTNET_FAST_TIER_QUEUE,
      ],
    },
  ])(
    "adds the $step queues to a database that already carries every other seed marker",
    async ({ seedName, otherMarkers, languages, schedules }) => {
      const { app } = createTestApplication({ workers: false });
      await pool.query("INSERT INTO public.workhorse_demo_seed (name) SELECT unnest($1::text[])", [
        [...EXISTING_SEED_MARKERS, ...otherMarkers],
      ]);

      const seeded = await seedDemoData(database);
      expect(seeded).toMatchObject({ seeded: true, historicalTaskCount: 0 });
      expect(seeded.taskIds).toHaveLength(5 * languages.length);

      // No other step ran: the run inserted one full-tier task on each language's queue and a batch
      // on its fast-tier queue, and only the fast-tier batch lives in the fast-tier runtime table.
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
        languages
          .flatMap(({ queue, fastTier }) => [
            { queue, count: 1, fast: 0 },
            { queue: fastTier.queue, count: 4, fast: 4 },
          ])
          .toSorted((left, right) => left.queue.localeCompare(right.queue)),
      );
      const payloads = await pool.query<{ queue: string; payload: unknown }>(
        "SELECT DISTINCT queue_name AS queue, payload FROM workhorse.task ORDER BY queue_name",
      );
      expect(payloads.rows).toEqual(
        languages
          .flatMap(({ queue, fastTier }) => [
            { queue, payload: { language: fastTier.language } },
            { queue: fastTier.queue, payload: { language: fastTier.language } },
          ])
          .toSorted((left, right) => left.queue.localeCompare(right.queue)),
      );
      const markers = await pool.query<{ name: string }>(
        "SELECT name FROM public.workhorse_demo_seed ORDER BY name",
      );
      expect(markers.rows.map((row) => row.name)).toEqual(
        [...EXISTING_SEED_MARKERS, ...otherMarkers, seedName].toSorted(),
      );

      // The sync replaces the namespace, so the earlier fast-tier schedules survive beside this one.
      const scheduleRows = await pool.query<{ name: string; queue: string; cron: string }>(
        `SELECT schedule_name AS name, queue_name AS queue, cron_expression AS cron
           FROM workhorse.schedule_definition
          WHERE namespace = $1
          ORDER BY queue_name`,
        [DEMO_FAST_TIER_SCHEDULE_NAMESPACE],
      );
      expect(scheduleRows.rows).toEqual(
        schedules
          .toSorted((left, right) => left.queue.localeCompare(right.queue))
          .map((entry) => ({ name: entry.scheduleName, queue: entry.queue, cron: entry.schedule })),
      );

      const queuesPage = await dashboardClient(app).dashboard.queues();
      for (const { queue, fastTier } of languages) {
        expect(queuesPage.queues.find((row) => row.queue === fastTier.queue)).toMatchObject({
          tier: "fast",
          ...fastTier.history,
        });
        expect(queuesPage.queues.find((row) => row.queue === queue)).toMatchObject({
          tier: "full",
        });
      }

      const before = await seededRowVersions();
      expect(await seedDemoData(database)).toEqual({
        seeded: false,
        taskIds: [],
        historicalTaskCount: 0,
      });
      expect(await seededRowVersions()).toEqual(before);
    },
  );
});
