import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createDrizzleAdapter, DrizzleQueryError, drizzleQueryable } from "@workhorse/drizzle";
import { HonoWorkhorse, serveWithWorkhorse } from "@workhorse/hono";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { installSchema } from "@workhorse/core";
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

let handlerStartedResolve;
const handlerStarted = new Promise((resolve) => {
  handlerStartedResolve = resolve;
});
let releaseHandler;
const handlerRelease = new Promise((resolve) => {
  releaseHandler = resolve;
});
const workhorse = new HonoWorkhorse(adapter, {
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
const app = new Hono()
  .use(workhorse.middleware())
  .get("/health", (context) => context.json({ ready: Boolean(context.var.workhorse.queue) }));
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
let port;
let resolveListening;
const listeningPort = new Promise((resolve) => {
  resolveListening = resolve;
});
const running = await serveWithWorkhorse({
  fetch: app.fetch,
  workhorse,
  port: 0,
  onListen: (info) => {
    port = info.port;
    resolveListening();
  },
});
await listeningPort;
assert.deepEqual(
  await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()),
  {
    ready: true,
  },
);
await handlerStarted;
const shutdown = running.shutdown();
await sleep(30);
assert.equal(closeCount, 0, "shutdown must drain the active handler before closing resources");
releaseHandler();
await Promise.all([shutdown, running.shutdown()]);
assert.equal(closeCount, 1);
assert.equal((await adapter.queue.getJob(shutdownJob)).state, "succeeded");
assert.equal((await adapter.queue.getJob(unclaimedJob)).state, "ready");

await pool.query("DROP TABLE IF EXISTS public.workhorse_packed_test");
await pool.end();
