import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { createDrizzleAdapter, DrizzleQueryError } from "@workhorse-js/drizzle";
import { createKyselyAdapter, KyselyQueryError } from "@workhorse-js/kysely";
import { createPrismaAdapter, PrismaQueryError, type PrismaExecutor } from "@workhorse-js/prisma";
import { createTypeOrmAdapter, TypeOrmQueryError } from "@workhorse-js/typeorm";
import type { Queue, WorkhorseAdapter } from "@workhorse-js/core";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Kysely, PostgresDialect, sql as kyselySql } from "kysely";
import { Pool } from "pg";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client") as {
  PrismaClient: new (options: unknown) => {
    $disconnect(): Promise<void>;
    $transaction<T>(
      run: (
        transaction: PrismaExecutor & {
          $executeRawUnsafe(statement: string, ...values: unknown[]): Promise<unknown>;
        },
      ) => Promise<T>,
    ): Promise<T>;
  } & PrismaExecutor;
};

const database = createDatabaseTestHarness(import.meta.url, {
  max: 4,
  extraSchemas: ["public"],
});
const { databaseUrl, pool } = database;

/**
 * Provider resources whose lifecycle a test controls: a real ORM instance over a deliberately
 * small connection pool, the adapter built on it, and the ORM's own transaction entry point.
 */
interface LifecycleResources {
  adapter: WorkhorseAdapter<unknown>;
  /** An adapter over the same caller-owned database with no `close` configured. */
  bareAdapter(): WorkhorseAdapter<unknown>;
  initialize(): Promise<void>;
  /**
   * Open the ORM's own transaction, insert a probe row, then hand the transaction-bound queue to
   * the test together with `abort`, which runs one failing statement and swallows its rejection so
   * the session enters the aborted-transaction state while the callback keeps running.
   */
  transaction(
    value: string,
    run: (queue: Queue, abort: () => Promise<void>) => Promise<void>,
  ): Promise<void>;
}

interface LifecycleProvider {
  name: string;
  errorType: new (...arguments_: never[]) => Error;
  create(): LifecycleResources;
  shared?: LifecycleResources;
}

const missingRelation = "SELECT * FROM public.lifecycle_probe_missing";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function createDrizzleResources(max: number): LifecycleResources {
  const drizzlePool = new Pool({ connectionString: databaseUrl, max });
  const drizzleDatabase = drizzle({ client: drizzlePool });
  const adapter = createDrizzleAdapter(drizzleDatabase, {
    close: () => drizzlePool.end(),
  }) as WorkhorseAdapter<unknown>;
  return {
    adapter,
    bareAdapter: () => createDrizzleAdapter(drizzleDatabase) as WorkhorseAdapter<unknown>,
    initialize: async () => undefined,
    transaction: (value, run) =>
      drizzleDatabase.transaction(async (transaction) => {
        await transaction.execute(
          drizzleSql`INSERT INTO public.lifecycle_probe (provider, value) VALUES (${"Drizzle"}, ${value})`,
        );
        await run(adapter.forTransaction(transaction), () =>
          transaction.execute(drizzleSql.raw(missingRelation)).then(
            () => {
              throw new Error("the aborting statement unexpectedly succeeded");
            },
            () => undefined,
          ),
        );
      }),
  };
}

function createPrismaResources(): LifecycleResources {
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", "1");
  const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const adapter = createPrismaAdapter(prisma, {
    close: () => prisma.$disconnect(),
  }) as WorkhorseAdapter<unknown>;
  return {
    adapter,
    bareAdapter: () => createPrismaAdapter(prisma) as WorkhorseAdapter<unknown>,
    initialize: async () => undefined,
    transaction: (value, run) =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          "INSERT INTO public.lifecycle_probe (provider, value) VALUES ($1, $2)",
          "Prisma",
          value,
        );
        await run(adapter.forTransaction(transaction), () =>
          transaction.$queryRawUnsafe(missingRelation).then(
            () => {
              throw new Error("the aborting statement unexpectedly succeeded");
            },
            () => undefined,
          ),
        );
      }),
  };
}

function createTypeOrmResources(): LifecycleResources {
  const dataSource = new DataSource({
    type: "postgres",
    url: databaseUrl,
    entities: [],
    synchronize: false,
    extra: { max: 1 },
  });
  const adapter = createTypeOrmAdapter(dataSource, {
    close: () => dataSource.destroy(),
  }) as WorkhorseAdapter<unknown>;
  return {
    adapter,
    bareAdapter: () => createTypeOrmAdapter(dataSource) as WorkhorseAdapter<unknown>,
    initialize: async () => {
      await dataSource.initialize();
    },
    transaction: (value, run) =>
      dataSource.transaction(async (transaction) => {
        await transaction.query(
          "INSERT INTO public.lifecycle_probe (provider, value) VALUES ($1, $2)",
          ["TypeORM", value],
        );
        await run(adapter.forTransaction(transaction), () =>
          transaction.query(missingRelation).then(
            () => {
              throw new Error("the aborting statement unexpectedly succeeded");
            },
            () => undefined,
          ),
        );
      }),
  };
}

function createKyselyResources(): LifecycleResources {
  const kyselyPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const kyselyDatabase = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool: kyselyPool }),
  });
  const adapter = createKyselyAdapter(kyselyDatabase, {
    close: () => kyselyDatabase.destroy(),
  }) as WorkhorseAdapter<unknown>;
  return {
    adapter,
    bareAdapter: () => createKyselyAdapter(kyselyDatabase) as WorkhorseAdapter<unknown>,
    initialize: async () => undefined,
    transaction: (value, run) =>
      kyselyDatabase.transaction().execute(async (transaction) => {
        await kyselySql`INSERT INTO public.lifecycle_probe (provider, value) VALUES (${"Kysely"}, ${value})`.execute(
          transaction,
        );
        await run(adapter.forTransaction(transaction), () =>
          kyselySql
            .raw(missingRelation)
            .execute(transaction)
            .then(
              () => {
                throw new Error("the aborting statement unexpectedly succeeded");
              },
              () => undefined,
            ),
        );
      }),
  };
}

const providers: LifecycleProvider[] = [
  // The Drizzle adapter discovers the pool through `$client` and may reserve a LISTEN connection
  // for a running worker, so its pool holds one more connection than the strictly single-session
  // providers below.
  { name: "Drizzle", errorType: DrizzleQueryError, create: () => createDrizzleResources(2) },
  { name: "Prisma", errorType: PrismaQueryError, create: createPrismaResources },
  { name: "TypeORM", errorType: TypeOrmQueryError, create: createTypeOrmResources },
  { name: "Kysely", errorType: KyselyQueryError, create: createKyselyResources },
];

async function backendPid(adapter: WorkhorseAdapter<unknown>): Promise<number> {
  const result = await adapter.database.query<{ pid: number | string }>(
    "SELECT pg_backend_pid() AS pid",
  );
  return Number(result.rows[0]!.pid);
}

async function foreignConnectionCount(): Promise<number> {
  const result = await pool.query<{ count: number | string }>(
    `SELECT count(*) AS count
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()`,
  );
  return Number(result.rows[0]!.count);
}

beforeAll(async () => {
  await database.setup();
  await pool.query(
    "CREATE TABLE public.lifecycle_probe (provider text NOT NULL, value text NOT NULL)",
  );
  for (const provider of providers) {
    provider.shared = provider.create();
    await provider.shared.initialize();
  }
});

beforeEach(async () => {
  await database.reset();
});

afterAll(async () => {
  for (const provider of providers) await provider.shared?.adapter.close();
  await database.teardown();
});

describe.each(providers)("$name provider lifecycle", (provider) => {
  it("enqueues on the caller's transaction connection when the pool has no other to give", async () => {
    // The provider pool holds a single query session and the open transaction occupies it, so the
    // enqueue below can only succeed by riding the transaction's own connection.
    await provider.shared!.transaction("owned", (queue) =>
      queue.enqueue(`${provider.name}.lifecycle.owned`, { committed: true }).then(() => undefined),
    );

    expect((await pool.query("SELECT provider, value FROM public.lifecycle_probe")).rows).toEqual([
      { provider: provider.name, value: "owned" },
    ]);
    expect((await pool.query("SELECT job_type FROM workhorse.job")).rows).toEqual([
      { job_type: `${provider.name}.lifecycle.owned` },
    ]);
  });

  it("translates the aborted-transaction state and rolls the application write back", async () => {
    const failure = await provider
      .shared!.transaction("aborted", async (queue, abort) => {
        await abort();
        const error: unknown = await queue
          .enqueue(`${provider.name}.lifecycle.aborted`, { committed: false })
          .then(() => {
            throw new Error("enqueue unexpectedly succeeded in an aborted transaction");
          })
          .catch((caught: unknown) => caught);
        throw error;
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(provider.errorType);
    expect(failure).toMatchObject({ code: "25P02" });
    expect((await pool.query("SELECT provider FROM public.lifecycle_probe")).rows).toEqual([]);
    expect((await pool.query("SELECT job_type FROM workhorse.job")).rows).toEqual([]);
  });

  it("reuses its pooled connection across successive queue operations", async () => {
    const adapter = provider.shared!.adapter;
    const first = await backendPid(adapter);
    await adapter.queue.enqueue(`${provider.name}.lifecycle.pooled`, { index: 1 });
    await adapter.queue.enqueue(`${provider.name}.lifecycle.pooled`, { index: 2 });

    expect(await backendPid(adapter)).toBe(first);
  });

  it("leaves the caller-owned database open when no close is configured", async () => {
    const bare = provider.shared!.bareAdapter();
    await bare.close();

    await provider.shared!.adapter.queue.enqueue(`${provider.name}.lifecycle.survivor`, {});

    expect((await pool.query("SELECT job_type FROM workhorse.job")).rows).toEqual([
      { job_type: `${provider.name}.lifecycle.survivor` },
    ]);
  });

  it("drains the in-flight handler on stop and releases every connection on close", async () => {
    const baseline = await foreignConnectionCount();
    const resources = provider.create();
    await resources.initialize();

    const gate = deferred();
    const started = deferred();
    let handlerFinished = false;

    const worker = resources.adapter
      .createWorker({
        workerId: `${provider.name}-lifecycle-worker`,
        pollMs: 25,
        registryIntervalMs: 0,
      })
      .handle(`${provider.name}.lifecycle.drain`, async () => {
        started.resolve();
        await gate.promise;
        handlerFinished = true;
        return null;
      });

    await resources.adapter.queue.enqueue(`${provider.name}.lifecycle.drain`, {});
    const running = worker.run();
    try {
      await started.promise;
      worker.stop();
      let settled = false;
      void running.then(() => {
        settled = true;
      });
      await sleep(100);
      expect(settled).toBe(false);
    } finally {
      gate.resolve();
      await running;
    }
    expect(handlerFinished).toBe(true);

    await Promise.all([resources.adapter.close(), resources.adapter.close()]);
    await resources.adapter.close();

    await vi.waitFor(async () => {
      expect(await foreignConnectionCount()).toBeLessThanOrEqual(baseline);
    }, 10_000);
  });
});
