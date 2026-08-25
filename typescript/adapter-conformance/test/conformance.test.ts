import { createRequire } from "node:module";
import {
  createDrizzleAdapter,
  DrizzleQueryError,
  drizzleQueryable,
  type DrizzleExecutor,
} from "@workhorse-js/drizzle";
import {
  createKyselyAdapter,
  KyselyQueryError,
  kyselyQueryable,
  type KyselyExecutor,
} from "@workhorse-js/kysely";
import {
  createPrismaAdapter,
  PrismaQueryError,
  prismaQueryable,
  type PrismaExecutor,
} from "@workhorse-js/prisma";
import {
  createTypeOrmAdapter,
  TypeOrmQueryError,
  typeOrmQueryable,
  type TypeOrmExecutor,
} from "@workhorse-js/typeorm";
import {
  type AdapterNotificationPool,
  EnqueueIdempotencyConflictError,
  QueryError,
  RedriveIdempotencyConflictError,
  type Queryable,
  type Queue,
  type WorkhorseAdapter,
} from "@stablemates/workhorse";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Kysely, PostgresDialect, sql as kyselySql } from "kysely";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
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

const statement = "SELECT $1::text AS job_id, $2::int AS attempt";
const values = ["job-1", 2] as const;

type Execute = (text: string, parameters: readonly unknown[]) => Promise<QueryResultRow[]>;

interface QueryableProvider {
  name: string;
  QueryError: new (...arguments_: never[]) => Error;
  error: Error;
  expectedCode: string;
  queryable(execute: Execute, notificationPool?: AdapterNotificationPool): Queryable;
  adapter(
    execute: Execute,
    close: () => Promise<void>,
  ): { adapter: WorkhorseAdapter<unknown>; transaction: unknown };
}

function pgResult(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function compileDrizzle(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: undefined as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`,
    invokeSource: "indexes",
  });
}

const queryableProviders: QueryableProvider[] = [
  {
    name: "Drizzle",
    QueryError: DrizzleQueryError,
    error: Object.assign(new Error("duplicate secret@example.com"), { code: "23505" }),
    expectedCode: "23505",
    queryable(execute, notificationPool) {
      return drizzleQueryable(
        {
          execute: async (query) => {
            const compiled = compileDrizzle(query);
            return pgResult(await execute(compiled.sql, compiled.params));
          },
        } as DrizzleExecutor,
        notificationPool,
      );
    },
    adapter(execute, close) {
      const executor = {
        execute: async (query: SQL) => {
          const compiled = compileDrizzle(query);
          return pgResult(await execute(compiled.sql, compiled.params));
        },
      } as DrizzleExecutor;
      const adapter = createDrizzleAdapter(executor, { close }) as WorkhorseAdapter<unknown>;
      return { adapter, transaction: executor };
    },
  },
  {
    name: "Prisma",
    QueryError: PrismaQueryError,
    error: Object.assign(new Error("raw query failed for secret@example.com"), {
      code: "P2010",
      meta: { code: "P1001" },
    }),
    expectedCode: "P1001",
    queryable(execute, notificationPool) {
      const executor: PrismaExecutor = {
        $queryRawUnsafe: async <T = unknown>(text: string, ...parameters: unknown[]) =>
          (await execute(text, parameters)) as T,
      };
      return prismaQueryable(executor, notificationPool);
    },
    adapter(execute, close) {
      const executor: PrismaExecutor = {
        $queryRawUnsafe: async <T = unknown>(text: string, ...parameters: unknown[]) =>
          (await execute(text, parameters)) as T,
      };
      const adapter = createPrismaAdapter(executor, { close }) as WorkhorseAdapter<unknown>;
      return { adapter, transaction: executor };
    },
  },
  {
    name: "TypeORM",
    QueryError: TypeOrmQueryError,
    error: Object.assign(new Error("query failed"), {
      driverError: Object.assign(new Error("duplicate secret@example.com"), { code: "23505" }),
    }),
    expectedCode: "23505",
    queryable(execute, notificationPool) {
      return typeOrmQueryable(
        {
          query: async <T = unknown>(text: string, parameters: unknown[] = []) =>
            (await execute(text, parameters)) as T,
        },
        notificationPool,
      );
    },
    adapter(execute, close) {
      const executor: TypeOrmExecutor = {
        query: async <T = unknown>(text: string, parameters: unknown[] = []) =>
          (await execute(text, parameters)) as T,
      };
      const adapter = createTypeOrmAdapter(executor, { close }) as WorkhorseAdapter<unknown>;
      return { adapter, transaction: executor };
    },
  },
  {
    name: "Kysely",
    QueryError: KyselyQueryError,
    error: Object.assign(new Error("query failed for secret@example.com"), {
      cause: Object.assign(new Error("database rejected query"), { code: "23505" }),
    }),
    expectedCode: "23505",
    queryable(execute, notificationPool) {
      return kyselyQueryable(
        {
          executeQuery: async (query) => ({ rows: await execute(query.sql, query.parameters) }),
        } as KyselyExecutor,
        notificationPool,
      );
    },
    adapter(execute, close) {
      const executor = {
        executeQuery: async <R>(query: { sql: string; parameters: readonly unknown[] }) => ({
          rows: (await execute(query.sql, query.parameters)) as R[],
        }),
      } as KyselyExecutor;
      const adapter = createKyselyAdapter(executor, { close }) as WorkhorseAdapter<unknown>;
      return { adapter, transaction: executor };
    },
  },
];

describe.each(queryableProviders)("$name queryable contract", (provider) => {
  it("preserves statements, positional values, row order, and result metadata", async () => {
    const execute = vi.fn<Execute>(async () => [{ job_id: "job-1" }, { job_id: "job-2" }]);

    const result = await provider.queryable(execute).query(statement, values);

    expect(execute).toHaveBeenCalledWith(statement, values);
    expect(result).toMatchObject({
      command: "",
      rowCount: 2,
      oid: 0,
      fields: [],
      rows: [{ job_id: "job-1" }, { job_id: "job-2" }],
    });
  });

  it("retains the driver error shape and does not expose parameter values", async () => {
    const execute = vi.fn<Execute>(async () => {
      throw provider.error;
    });

    const failure = await provider
      .queryable(execute)
      .query("SELECT $1::text", ["secret@example.com"])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(provider.QueryError);
    expect(failure).toMatchObject({
      cause: provider.error,
      code: provider.expectedCode,
      statement: "SELECT $1::text",
    });
    expect((failure as Error).message).not.toContain("secret@example.com");
  });

  it("passes translated and caller errors through without wrapping them again", async () => {
    const failures = [
      new QueryError("conformance", statement, new Error("driver failure")),
      new RangeError("placeholder failure"),
    ];

    for (const expected of failures) {
      const execute = vi.fn<Execute>(async () => {
        throw expected;
      });

      await expect(provider.queryable(execute).query(statement, values)).rejects.toBe(expected);
    }
  });

  it("exposes an optional notification pool with its capacity and sharing identity", async () => {
    const connect = vi.fn<() => Promise<void>>(async () => undefined);
    const notificationPool: AdapterNotificationPool = {
      connect,
      options: { max: 4 },
      query: async <R extends QueryResultRow = QueryResultRow>() => pgResult([]) as QueryResult<R>,
    };
    const queryable = provider.queryable(
      vi.fn<Execute>(async () => []),
      notificationPool,
    ) as Queryable & {
      connect(): Promise<unknown>;
      notificationConnectionCapacity?: number;
      notificationConnectionIdentity?: object;
    };

    await queryable.connect();

    expect(connect).toHaveBeenCalledOnce();
    expect(queryable.notificationConnectionCapacity).toBe(4);
    expect(queryable.notificationConnectionIdentity).toBe(notificationPool);
  });

  it("adapts transactions and closes configured resources once", async () => {
    const execute = vi.fn<Execute>(async () => [
      {
        ordinal: 1,
        job_id: "00000000-0000-4000-8000-000000000001",
        outcome: "accepted",
      },
    ]);
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const { adapter, transaction } = provider.adapter(execute, close);

    await adapter.forTransaction(transaction).enqueue("test", { value: true });
    await Promise.all([adapter.close(), adapter.close()]);

    expect(execute).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

const database = createDatabaseTestHarness(import.meta.url, {
  max: 8,
  extraSchemas: ["public"],
});
const { databaseUrl, pool } = database;
const drizzlePool = new Pool({ connectionString: databaseUrl, max: 2 });
const drizzleDatabase = drizzle({ client: drizzlePool });
const drizzleAdapter = createDrizzleAdapter(drizzleDatabase, { close: () => drizzlePool.end() });
const kyselyPool = new Pool({ connectionString: databaseUrl, max: 2 });
const kyselyDatabase = new Kysely<Record<string, never>>({
  dialect: new PostgresDialect({ pool: kyselyPool }),
});
const kyselyAdapter = createKyselyAdapter(kyselyDatabase, {
  notificationPool: pool,
  close: () => kyselyDatabase.destroy(),
});
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const prismaAdapter = createPrismaAdapter(prisma, {
  notificationPool: pool,
  close: () => prisma.$disconnect(),
});
const typeOrmDatabase = new DataSource({
  type: "postgres",
  url: databaseUrl,
  entities: [],
  synchronize: false,
  extra: { max: 2 },
});
const typeOrmAdapter = createTypeOrmAdapter(typeOrmDatabase, {
  notificationPool: pool,
  close: () => typeOrmDatabase.destroy(),
});

interface IntegrationProvider {
  name: string;
  errorType: new (...arguments_: never[]) => Error;
  adapter: WorkhorseAdapter<unknown>;
  transaction(value: string, run: (queue: Queue) => Promise<void>): Promise<void>;
}

const integrationProviders: IntegrationProvider[] = [
  {
    name: "Drizzle",
    errorType: DrizzleQueryError,
    adapter: drizzleAdapter as WorkhorseAdapter<unknown>,
    transaction: (value, run) =>
      drizzleDatabase.transaction(async (transaction) => {
        await transaction.execute(
          drizzleSql`INSERT INTO public.adapter_conformance (provider, value) VALUES (${"Drizzle"}, ${value})`,
        );
        await run(drizzleAdapter.forTransaction(transaction));
      }),
  },
  {
    name: "Prisma",
    errorType: PrismaQueryError,
    adapter: prismaAdapter as WorkhorseAdapter<unknown>,
    transaction: (value, run) =>
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          "INSERT INTO public.adapter_conformance (provider, value) VALUES ($1, $2)",
          "Prisma",
          value,
        );
        await run(prismaAdapter.forTransaction(transaction));
      }),
  },
  {
    name: "TypeORM",
    errorType: TypeOrmQueryError,
    adapter: typeOrmAdapter as WorkhorseAdapter<unknown>,
    transaction: (value, run) =>
      typeOrmDatabase.transaction(async (transaction) => {
        await transaction.query(
          "INSERT INTO public.adapter_conformance (provider, value) VALUES ($1, $2)",
          ["TypeORM", value],
        );
        await run(typeOrmAdapter.forTransaction(transaction));
      }),
  },
  {
    name: "Kysely",
    errorType: KyselyQueryError,
    adapter: kyselyAdapter as WorkhorseAdapter<unknown>,
    transaction: (value, run) =>
      kyselyDatabase.transaction().execute(async (transaction) => {
        await kyselySql`INSERT INTO public.adapter_conformance (provider, value) VALUES (${"Kysely"}, ${value})`.execute(
          transaction,
        );
        await run(kyselyAdapter.forTransaction(transaction));
      }),
  },
];

beforeAll(async () => {
  await database.setup();
  await typeOrmDatabase.initialize();
  await pool.query(
    "CREATE TABLE public.adapter_conformance (provider text NOT NULL, value text NOT NULL, PRIMARY KEY (provider, value))",
  );
});

beforeEach(async () => {
  await database.reset();
});

afterAll(async () => {
  await Promise.all(integrationProviders.map(({ adapter }) => adapter.close()));
  await database.teardown();
});

describe.each(integrationProviders)("$name built-package conformance", (provider) => {
  it("commits and rolls back queue writes with the caller-owned transaction", async () => {
    await provider.transaction("committed", (queue) =>
      queue
        .enqueue(`${provider.name}.transaction.commit`, { committed: true })
        .then(() => undefined),
    );
    await expect(
      provider.transaction("rolled-back", async (queue) => {
        await queue.enqueue(`${provider.name}.transaction.rollback`, { committed: false });
        throw new Error("rollback requested");
      }),
    ).rejects.toThrow("rollback requested");

    expect(
      (await pool.query("SELECT provider, value FROM public.adapter_conformance")).rows,
    ).toEqual([{ provider: provider.name, value: "committed" }]);
    expect((await pool.query("SELECT job_type FROM workhorse.job")).rows).toEqual([
      { job_type: `${provider.name}.transaction.commit` },
    ]);
  });

  it("uses the provider pool for concurrent queue operations", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        provider.adapter.queue.enqueue(`${provider.name}.pooled`, { index }),
      ),
    );

    expect(new Set(ids).size).toBe(6);
  });

  it("returns Date instances for every job snapshot timestamp", async () => {
    const workerId = `${provider.name}-snapshot-worker`;
    const jobId = await provider.adapter.queue.enqueue(
      `${provider.name}.snapshot`,
      { provider: provider.name },
      { deadline: new Date(Date.now() + 60_000) },
    );
    const claimed = await provider.adapter.queue.claim(workerId);
    expect(claimed?.id).toBe(jobId);
    await provider.adapter.queue.updateProgress(claimed!, workerId, { completed: 1 });
    await provider.adapter.queue.cancel(jobId, {
      requestedBy: `${provider.name}-operator`,
      reason: "timestamp conformance",
    });

    const snapshot = await provider.adapter.admin.getJob(jobId);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.deadlineAt).toBeInstanceOf(Date);
    expect(snapshot!.runAt).toBeInstanceOf(Date);
    expect(snapshot!.cancelRequestedAt).toBeInstanceOf(Date);
    expect(snapshot!.progress?.createdAt).toBeInstanceOf(Date);
    expect(snapshot!.progress?.updatedAt).toBeInstanceOf(Date);
    expect(snapshot!.createdAt).toBeInstanceOf(Date);
    expect(snapshot!.updatedAt).toBeInstanceOf(Date);
  });

  it("uses the configured notification capability to wake a worker", async () => {
    const handled: string[] = [];
    const claim = vi.spyOn(provider.adapter.queue, "claimMany");
    const worker = provider.adapter
      .createWorker({
        workerId: `${provider.name}-notification-worker`,
        pollMs: 15_000,
        registryIntervalMs: 0,
      })
      .handle<{ message: string }>(`${provider.name}.notification`, ({ message }) => {
        handled.push(message);
        return null;
      });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(claim).toHaveBeenCalled());
      await provider.adapter.queue.enqueue(`${provider.name}.notification`, { message: "prompt" });
      await vi.waitFor(() => expect(handled).toEqual(["prompt"]), { timeout: 1_000 });
    } finally {
      worker.stop();
      await running;
      claim.mockRestore();
    }
  });

  it("translates the real driver error shape and retains PostgreSQL's SQLSTATE", async () => {
    const failure = await provider.adapter.database
      .query("SELECT * FROM public.adapter_conformance_missing")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(provider.errorType);
    expect(failure).toMatchObject({ code: "42P01" });
  });

  it("preserves Workhorse's typed conflicts through the provider wrapper", async () => {
    const idempotency = { key: `${provider.name}-provider-conflict` };
    await provider.adapter.queue.enqueue(
      `${provider.name}.conflict`,
      { version: 1 },
      { idempotency },
    );

    await expect(
      provider.adapter.queue.enqueue(`${provider.name}.conflict`, { version: 2 }, { idempotency }),
    ).rejects.toBeInstanceOf(EnqueueIdempotencyConflictError);
  });

  it("preserves typed redrive replay conflicts through the provider wrapper", async () => {
    const type = `${provider.name}.redrive`;
    const sourceJobId = await provider.adapter.queue.enqueue(
      type,
      { provider: provider.name },
      { maxAttempts: 1 },
    );
    const claimed = await provider.adapter.queue.claim(`${provider.name}-redrive-worker`);
    expect(claimed?.id).toBe(sourceJobId);
    expect(
      await provider.adapter.queue.fail(
        claimed!,
        `${provider.name}-redrive-worker`,
        new Error("redrive me"),
      ),
    ).toBe("failed");
    const request = {
      actor: `${provider.name}-operator`,
      reason: "conformance",
      requestId: `${provider.name}-redrive-request`,
    };

    await provider.adapter.admin.redrive(sourceJobId, request);

    await expect(
      provider.adapter.admin.redrive(sourceJobId, { ...request, reason: "different" }),
    ).rejects.toBeInstanceOf(RedriveIdempotencyConflictError);
  });
});
