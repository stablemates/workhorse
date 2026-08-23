import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createDrizzleAdapter, DrizzleQueryError, drizzleQueryable } from "@workhorse-js/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { installSchema, startWorkerProcess, Worker } from "@workhorse-js/core";
import { Pool } from "pg";

const databaseUrl =
  process.env.WORKHORSE_TEST_DATABASE_URL ??
  "postgres://workhorse:workhorse@localhost:5432/workhorse_test";
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const db = drizzle({ client: pool });
let closeCount = 0;
const adapter = createDrizzleAdapter(db, {
  close: async () => {
    closeCount += 1;
  },
});

await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
await installSchema(pool);
await pool.query("DROP TABLE IF EXISTS public.workhorse_packed_test");
await pool.query("CREATE TABLE public.workhorse_packed_test (value text PRIMARY KEY)");

await db.transaction(async (transaction) => {
  await transaction.execute(
    sql`INSERT INTO public.workhorse_packed_test (value) VALUES (${"committed"})`,
  );
  await adapter.forTransaction(transaction).enqueue("packed.commit", { committed: true });
});
assert.equal(
  (await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_packed_test")).rows[0]
    .count,
  1,
);

await assert.rejects(
  db.transaction(async (transaction) => {
    await transaction.execute(
      sql`INSERT INTO public.workhorse_packed_test (value) VALUES (${"rolled-back"})`,
    );
    await adapter.forTransaction(transaction).enqueue("packed.rollback", { committed: false });
    throw new Error("rollback packed transaction");
  }),
  /rollback packed transaction/,
);
assert.equal(
  (await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_packed_test")).rows[0]
    .count,
  1,
);

const pooledIds = await Promise.all(
  Array.from({ length: 4 }, (_, index) => adapter.queue.enqueue("packed.pool", { index })),
);
assert.equal(new Set(pooledIds).size, 4);

const translated = await drizzleQueryable(db)
  .query("SELECT * FROM workhorse.packed_missing_relation")
  .catch((error) => error);
assert.ok(translated instanceof DrizzleQueryError);
assert.equal(translated.code, "42P01");
assert.ok(translated.cause);

const humanWaitJob = await adapter.queue.enqueue("packed.human-wait", {}, { queue: "human-wait" });
const humanWaitWorker = new Worker(adapter.queue, {
  workerId: "packed-human-wait",
  queue: "human-wait",
}).handle("packed.human-wait", async (_payload, context) =>
  context.waitForHuman("review", { prompt: "Approve the packed contract?" }),
);
assert.equal(await humanWaitWorker.runOnce(), true);
assert.equal((await adapter.admin.getJob(humanWaitJob)).state, "scheduled");
const packedCompletion = await adapter.queue.completeHumanWait(
  humanWaitJob,
  "review",
  { approved: true },
  { idempotencyKey: "packed-completion", requestedBy: "packed-operator" },
);
assert.equal(packedCompletion.status, "completed");
assert.equal(packedCompletion.completedBy, "packed-operator");
assert.equal(await humanWaitWorker.runOnce(), true);
assert.deepEqual((await adapter.admin.getJob(humanWaitJob)).result, { approved: true });

let handlerStartedResolve;
const handlerStarted = new Promise((resolve) => {
  handlerStartedResolve = resolve;
});
let releaseHandler;
const handlerRelease = new Promise((resolve) => {
  releaseHandler = resolve;
});
const running = await startWorkerProcess({
  adapter: () => adapter,
  workers: [
    {
      options: { pollMs: 10, queue: "shutdown", workerId: "packed-consumer" },
      configure(worker) {
        worker.handle("packed.shutdown", async () => {
          handlerStartedResolve();
          await handlerRelease;
          return { complete: true };
        });
      },
    },
  ],
});
const shutdownJob = await adapter.queue.enqueue(
  "packed.shutdown",
  { value: true },
  {
    queue: "shutdown",
  },
);
const unclaimedJob = await adapter.queue.enqueue(
  "packed.after-shutdown",
  { value: true },
  {
    queue: "shutdown",
  },
);
await handlerStarted;
const shutdown = running.shutdown();
await sleep(30);
assert.equal(closeCount, 0, "shutdown must drain the active handler before closing resources");
releaseHandler();
await Promise.all([shutdown, running.shutdown()]);
assert.equal(closeCount, 1);
assert.equal((await adapter.admin.getJob(shutdownJob)).state, "succeeded");
assert.equal((await adapter.admin.getJob(unclaimedJob)).state, "ready");

await pool.query("DROP TABLE IF EXISTS public.workhorse_packed_test");
await pool.end();
