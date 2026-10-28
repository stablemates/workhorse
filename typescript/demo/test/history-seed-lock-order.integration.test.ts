/**
 * The historical seed step against a worker tick that holds the history locks in the other order.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import { Queue } from "@stablemates/workhorse";
import {
  DEMO_RATE_LIMIT_SEED_NAME,
  FAST_TIER_SEED_NAME,
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

const { database, pool, waitFor } = createDemoIntegrationSuite(import.meta.url);

/** Every seed step except the historical one, so the seed reaches that step at once. */
const OTHER_SEED_MARKERS = [
  DEMO_RATE_LIMIT_SEED_NAME,
  LONG_RUNNING_SEED_NAME,
  DEMO_FEATURE_SHOWCASE_SEED_NAME,
  REPRESENTATIVE_SEED_NAME,
  FAST_TIER_SEED_NAME,
  RUST_SEED_NAME,
  RUBY_SEED_NAME,
  JVM_DOTNET_SEED_NAME,
  TASK_GROUP_SEED_NAME,
];

async function seedWaitsForTaskEventLock(): Promise<boolean> {
  const rows = await pool.query<{ waiting: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks
       WHERE locktype = 'relation' AND NOT granted AND mode = 'AccessExclusiveLock'
         AND relation = 'workhorse.task_event'::regclass
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    ) AS waiting
  `);
  return rows.rows[0]!.waiting;
}

describe("demo historical seed", () => {
  it("survives a worker tick that writes task_event before attempt_history (SM-1879)", async () => {
    await pool.query("INSERT INTO public.workhorse_demo_seed (name) SELECT unnest($1::text[])", [
      OTHER_SEED_MARKERS,
    ]);
    // Recovery writes attempt history only for an expired lease, so the tick has one to recover.
    const queue = new Queue(pool);
    await queue.enqueue("history-seed-probe", {}, { queue: "history-seed-probe" });
    const claimed = await queue.claim("history-seed-probe-worker", {
      queue: "history-seed-probe",
      leaseMs: 30_000,
    });
    await pool.query(
      "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 second' WHERE task_id = $1",
      [claimed!.id],
    );
    const tick = await pool.connect();
    try {
      // tick_v1 promotes before it recovers, so one worker transaction holds task_event and then
      // asks for attempt_history. Partition creation takes the two parents in the other order.
      await tick.query("BEGIN");
      await tick.query("SELECT workhorse.promote_v1(10)");
      const seed = seedDemoData(database);
      const seedSettled = seed.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await waitFor(seedWaitsForTaskEventLock, (waiting) => waiting, 2_000);
      await tick.query("SELECT * FROM workhorse.recover_expired_telemetry_v1(10)");
      await tick.query("COMMIT");

      const settled = await seedSettled;
      expect(settled.error).toBeUndefined();
      expect(settled.value).toMatchObject({ seeded: true, historicalTaskCount: 362 });
    } finally {
      await tick.query("ROLLBACK").catch(() => undefined);
      tick.release();
    }
  });
});
