import { EnqueueIdempotencyConflictError, installSchema } from "@workhorse/core";
import { Pool } from "pg";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLocalDatabasePurpose, localDatabaseUrl } from "../../../src/local-database.js";
import { createTypeOrmAdapter, TypeOrmQueryError } from "../src/index.js";

const databaseUrl = localDatabaseUrl("test");
assertLocalDatabasePurpose(databaseUrl, "test");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const dataSource = new DataSource({
  type: "postgres",
  url: databaseUrl,
  entities: [],
  synchronize: false,
  extra: { max: 2 },
});
const adapter = createTypeOrmAdapter(dataSource, {
  notificationPool: pool,
  close: async () => {
    await dataSource.destroy();
    await pool.end();
  },
});

beforeAll(async () => {
  await dataSource.initialize();
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);
  await pool.query("DROP TABLE IF EXISTS public.workhorse_typeorm_test");
  await pool.query("CREATE TABLE public.workhorse_typeorm_test (value text PRIMARY KEY)");
});

beforeEach(async () => {
  await pool.query(`TRUNCATE public.workhorse_typeorm_test, workhorse.job_event,
    workhorse.attempt_history, workhorse.schedule_occurrence, workhorse.schedule_definition,
    workhorse.job_outcome, workhorse.job_runtime, workhorse.job RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS public.workhorse_typeorm_test");
  await adapter.close();
});

describe("TypeORM provider integration", () => {
  it("commits application writes and enqueue in the caller-owned transaction", async () => {
    await dataSource.transaction(async (manager) => {
      await manager.query("INSERT INTO public.workhorse_typeorm_test (value) VALUES ($1)", [
        "committed",
      ]);
      await adapter.forTransaction(manager).enqueue("transaction.commit", { committed: true });
    });

    expect((await pool.query("SELECT value FROM public.workhorse_typeorm_test")).rows).toEqual([
      { value: "committed" },
    ]);
    expect((await pool.query("SELECT job_type FROM workhorse.job")).rows).toEqual([
      { job_type: "transaction.commit" },
    ]);
  });

  it("rolls back enqueue when the caller rolls back its TypeORM transaction", async () => {
    await expect(
      dataSource.transaction(async (manager) => {
        await manager.query("INSERT INTO public.workhorse_typeorm_test (value) VALUES ($1)", [
          "rolled-back",
        ]);
        await adapter.forTransaction(manager).enqueue("transaction.rollback", { committed: false });
        throw new Error("rollback requested");
      }),
    ).rejects.toThrow("rollback requested");

    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_typeorm_test"))
        .rows,
    ).toEqual([{ count: 0 }]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows).toEqual(
      [{ count: 0 }],
    );
  });

  it("uses TypeORM's connection pool for concurrent queue operations", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, index) => adapter.queue.enqueue("pooled", { index })),
    );

    expect(new Set(ids).size).toBe(6);
  });

  it("uses the optional notification pool to wake a worker", async () => {
    const handled: string[] = [];
    const claim = vi.spyOn(adapter.queue, "claim");
    const worker = adapter
      .createWorker({
        workerId: "typeorm-notification-worker",
        pollMs: 15_000,
        registryIntervalMs: 0,
      })
      .handle<{ message: string }>("typeorm-notification", ({ message }) => {
        handled.push(message);
        return null;
      });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(claim).toHaveBeenCalled());
      await adapter.queue.enqueue("typeorm-notification", { message: "prompt" });
      await vi.waitFor(() => expect(handled).toEqual(["prompt"]), { timeout: 1_000 });
    } finally {
      worker.stop();
      await running;
      claim.mockRestore();
    }
  });

  it("translates TypeORM query failures and retains the PostgreSQL code", async () => {
    const failure = await adapter.database
      .query("SELECT * FROM public.workhorse_typeorm_missing")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeOrmQueryError);
    expect(failure).toMatchObject({ code: "42P01" });
  });

  it("preserves Workhorse's typed idempotency conflicts through TypeORM", async () => {
    const idempotency = { key: "typeorm-provider-conflict" };
    await adapter.queue.enqueue("typeorm-conflict", { version: 1 }, { idempotency });

    await expect(
      adapter.queue.enqueue("typeorm-conflict", { version: 2 }, { idempotency }),
    ).rejects.toBeInstanceOf(EnqueueIdempotencyConflictError);
  });
});
