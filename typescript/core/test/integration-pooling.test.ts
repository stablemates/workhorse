import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Admin,
  installSchema,
  migrateSchema,
  Queue,
  readSchemaVersion,
  Worker,
  WORKHORSE_SCHEMA_VERSION,
} from "../src/index.js";
import { databaseName } from "../src/local-database.js";
import {
  createDatabaseTestHarness,
  dropTestDatabase,
  ensureTestDatabase,
  poolingScratchName,
} from "./support/db.js";

/**
 * Pooling-mode conformance: direct connections and both pool modes of each supported pooler.
 *
 * The pooled lanes point at the PgBouncer or PgCat fixtures rather than at PostgreSQL. Every
 * pooled lane's environment variable carries a URL template whose database name this file
 * rewrites to its fixed pooling database: PgBouncer's wildcard `[databases]` entry forwards any
 * name, while PgCat routes on the pool name configured in its `pgcat.toml`, so the fixtures and
 * this file must agree on the name up front. Without a lane's variable the lane reports itself
 * skipped, which keeps `pnpm test:database` green on a checkout with no pooler;
 * `pnpm test:pooling` starts every fixture and runs every lane.
 */
const SESSION_POOL_URL = process.env.WORKHORSE_TEST_SESSION_POOL_URL;
const TRANSACTION_POOL_URL = process.env.WORKHORSE_TEST_TRANSACTION_POOL_URL;
const PGCAT_SESSION_POOL_URL = process.env.WORKHORSE_TEST_PGCAT_SESSION_POOL_URL;
const PGCAT_TRANSACTION_POOL_URL = process.env.WORKHORSE_TEST_PGCAT_TRANSACTION_POOL_URL;

interface PoolingLane {
  readonly name: string;
  /** URL template carrying pooler host, port, and credentials; the database name is rewritten. */
  readonly template: string | undefined;
  /** The environment variable a lane needs, for its skip label. */
  readonly envVar?: string;
  /** Whether a LISTEN on a dedicated connection receives a later NOTIFY. */
  readonly notifyDelivers: boolean;
  /** Whether a session advisory lock one client holds excludes another client's try. */
  readonly sessionLocksExclude: boolean;
}

const lanes: readonly PoolingLane[] = [
  { name: "direct", template: undefined, notifyDelivers: true, sessionLocksExclude: true },
  {
    name: "pgbouncer-session",
    template: SESSION_POOL_URL,
    envVar: "WORKHORSE_TEST_SESSION_POOL_URL",
    notifyDelivers: true,
    sessionLocksExclude: true,
  },
  {
    name: "pgbouncer-transaction",
    template: TRANSACTION_POOL_URL,
    envVar: "WORKHORSE_TEST_TRANSACTION_POOL_URL",
    // PgBouncer accepts LISTEN in transaction mode but detaches the client from the server
    // connection after the statement, so a notification can never be delivered.
    notifyDelivers: false,
    // A session advisory lock binds to whichever server session ran it and outlives the client,
    // so another client can acquire the same key.
    sessionLocksExclude: false,
  },
  {
    name: "pgcat-session",
    template: PGCAT_SESSION_POOL_URL,
    envVar: "WORKHORSE_TEST_PGCAT_SESSION_POOL_URL",
    // PgCat relays a notification only with the client's next query, so an idle LISTENing client
    // hears nothing in either pool mode — the wake hint is dead on PgCat outright.
    notifyDelivers: false,
    sessionLocksExclude: true,
  },
  {
    name: "pgcat-transaction",
    template: PGCAT_TRANSACTION_POOL_URL,
    envVar: "WORKHORSE_TEST_PGCAT_TRANSACTION_POOL_URL",
    notifyDelivers: false,
    sessionLocksExclude: false,
  },
];

// A fixed name, not the per-process digest: PgCat routes on a pool name written into its
// configuration before the run, so the pooled lanes cannot use a pid-derived database.
const database = createDatabaseTestHarness(import.meta.url, {
  max: 8,
  extraSchemas: ["public"],
  nameSuffix: "pooling",
});
const isolatedName = databaseName(database.databaseUrl);

/** Point a lane template at a database name, preserving the pooler's host, port, and user. */
function laneUrl(template: string, name: string): string {
  const url = new URL(template);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A short unique advisory-lock scope per run, so leaked grants can never collide across runs. */
const lockScope = `workhorse:pooling:${randomUUID().slice(0, 8)}`;

async function waitForPool(pool: Pool): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      failure = error;
      await sleep(100);
    }
  }
  throw failure;
}

beforeAll(async () => {
  await database.setup();
  await database.pool.query(
    "CREATE TABLE public.pooling_conformance (lane text NOT NULL, marker text NOT NULL, PRIMARY KEY (lane, marker))",
  );
});

beforeEach(async () => {
  await database.reset();
});

afterAll(async () => {
  await dropTestDatabase(database.databaseUrl, poolingScratchName(isolatedName));
  await database.teardown();
});

for (const lane of lanes) {
  const url =
    lane.name === "direct"
      ? database.databaseUrl
      : lane.template === undefined
        ? undefined
        : laneUrl(lane.template, isolatedName);

  describe.skipIf(url === undefined)(
    `${lane.name} connection lane${url === undefined ? ` (requires ${lane.envVar})` : ""}`,
    () => {
      const lanePool = new Pool({ connectionString: url!, max: 4 });
      const queue = new Queue(lanePool);
      const admin = new Admin(lanePool);

      beforeAll(async () => {
        await waitForPool(lanePool);
      });

      afterAll(async () => {
        await lanePool.end();
      });

      it("installs the schema and reports a no-op migration through the lane", async () => {
        // One fixed scratch database for every lane: PgCat routes on the pool name and holds
        // server connections to it, so the lane cannot drop or rename the database — resetting
        // drops the schema itself through the lane.
        const schemaName = poolingScratchName(isolatedName);
        await ensureTestDatabase(database.databaseUrl, schemaName);
        const schemaPool = new Pool({ connectionString: laneUrl(url!, schemaName), max: 2 });
        try {
          await schemaPool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
          await installSchema(schemaPool);

          expect(await readSchemaVersion(schemaPool)).toBe(WORKHORSE_SCHEMA_VERSION);
          await expect(migrateSchema(schemaPool)).resolves.toEqual({
            finishedVersion: WORKHORSE_SCHEMA_VERSION,
            contractStop: null,
          });
        } finally {
          await schemaPool.end();
        }
      });

      it("commits and rolls back queue writes with the caller's transaction", async () => {
        const type = `pooling.${lane.name}.transaction`;

        const rolledBack = await lanePool.connect();
        try {
          await rolledBack.query("BEGIN");
          await rolledBack.query(
            "INSERT INTO public.pooling_conformance (lane, marker) VALUES ($1, $2)",
            [lane.name, "rolled-back"],
          );
          await queue.enqueue(`${type}.rollback`, { committed: false }, {}, rolledBack);
          await rolledBack.query("ROLLBACK");
        } finally {
          rolledBack.release();
        }

        const committed = await lanePool.connect();
        try {
          await committed.query("BEGIN");
          await committed.query(
            "INSERT INTO public.pooling_conformance (lane, marker) VALUES ($1, $2)",
            [lane.name, "committed"],
          );
          await queue.enqueue(`${type}.commit`, { committed: true }, {}, committed);
          await committed.query("COMMIT");
        } finally {
          committed.release();
        }

        expect(
          (
            await lanePool.query("SELECT marker FROM public.pooling_conformance WHERE lane = $1", [
              lane.name,
            ])
          ).rows,
        ).toEqual([{ marker: "committed" }]);
        expect(
          (
            await lanePool.query("SELECT task_type FROM workhorse.task WHERE task_type LIKE $1", [
              `${type}.%`,
            ])
          ).rows,
        ).toEqual([{ task_type: `${type}.commit` }]);
      });

      it("claims and completes a task through the lane", async () => {
        const type = `pooling.${lane.name}.round-trip`;
        const workerId = `pooling-${lane.name}-round-trip`;

        const taskId = await queue.enqueue(type, { lane: lane.name });
        const claimed = await queue.claim(workerId);
        expect(claimed?.id).toBe(taskId);
        await queue.complete(claimed!, workerId, { done: true });

        expect((await admin.getTask(taskId))?.state).toBe("succeeded");
      });

      it("coordinates the maintenance tick through a transaction-scoped advisory lock", async () => {
        const phases = await queue.tick();

        // tick_v1 gates its phases behind pg_try_advisory_xact_lock('workhorse:tick'), the
        // advisory-lock shape that survives a transaction-pooled connection.
        expect(phases).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ phase: "promote", skippedLock: false, error: null }),
            expect.objectContaining({ phase: "recover", skippedLock: false, error: null }),
          ]),
        );
      });

      it("dispatches a task to a worker through the lane", async () => {
        const type = `pooling.${lane.name}.dispatch`;
        const handled: string[] = [];
        const worker = new Worker(queue, {
          workerId: `pooling-${lane.name}-dispatch`,
          pollMs: 250,
          registryIntervalMs: 0,
        }).handle<{ token: string }>(type, ({ token }) => {
          handled.push(token);
          return null;
        });

        const running = worker.run();
        try {
          await queue.enqueue(type, { token: "dispatched" });
          await vi.waitFor(() => expect(handled).toEqual(["dispatched"]), { timeout: 10_000 });
        } finally {
          worker.stop();
          await running;
        }
      });

      it("exercises the LISTEN/NOTIFY wake-hint boundary for the lane", async () => {
        const listener = new Client({ connectionString: url! });
        const notified = new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 1_000);
          listener.once("notification", (notification) => {
            clearTimeout(timer);
            resolve(notification.payload ?? null);
          });
        });

        await listener.connect();
        try {
          // Transaction mode may refuse LISTEN or accept it silently; either way no
          // notification arrives, and `notified` resolving null is the assertion.
          await listener.query("LISTEN pooling_conformance").catch(() => undefined);
          await lanePool.query("SELECT pg_notify('pooling_conformance', $1)", [lane.name]);

          await expect(notified).resolves.toBe(lane.notifyDelivers ? lane.name : null);
        } finally {
          await listener.end().catch(() => undefined);
        }
      });

      it("exercises the session advisory lock boundary for the lane", async () => {
        const key = `${lockScope}:${lane.name}`;
        const holder = await lanePool.connect();
        const contender = await lanePool.connect();
        try {
          await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);

          // Each try may reach a different server session in transaction mode; one success
          // anywhere proves the lock no longer excludes a second client.
          const attempts: boolean[] = [];
          for (let attempt = 0; attempt < 6; attempt += 1) {
            const result = await contender.query<{ got: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS got",
              [key],
            );
            attempts.push(result.rows[0]!.got);
          }

          expect(attempts.some((got) => got)).toBe(!lane.sessionLocksExclude);
        } finally {
          // Session grants persist on whichever server session took them, so cleanup is best
          // effort: each unlocked session clears only its own grants, and any the contender
          // reached stay pinned to those pooled backends until they close.
          await holder.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
          await contender.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
          holder.release();
          contender.release();
        }
      });
    },
  );
}

describe("notification capability", () => {
  it("keeps a queryable without a dedicated connection on polling alone", async () => {
    const queryOnly = { query: database.pool.query.bind(database.pool) };
    const queue = new Queue(queryOnly);
    expect(queue.supportsTaskNotifications()).toBe(false);

    const handled: string[] = [];
    const worker = new Worker(queue, {
      workerId: "pooling-query-only-dispatch",
      registryIntervalMs: 0,
    }).handle<{ token: string }>("pooling.query-only", ({ token }) => {
      handled.push(token);
      return null;
    });

    const running = worker.run();
    try {
      await queue.enqueue("pooling.query-only", { token: "polled" });
      await vi.waitFor(() => expect(handled).toEqual(["polled"]), { timeout: 10_000 });
    } finally {
      worker.stop();
      await running;
    }
  });
});
