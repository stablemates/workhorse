import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installSchema } from "ironshift";
import { assertLocalDatabasePurpose, localDatabaseUrl } from "../../../src/local-database.js";
import { createDrizzleAdapter, DrizzleQueryError, drizzleQueryable } from "../src/index.js";

const databaseUrl = localDatabaseUrl("test");
assertLocalDatabasePurpose(databaseUrl, "test");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const db = drizzle({ client: pool });
const adapter = createDrizzleAdapter(db);

beforeAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS ironshift CASCADE");
  await installSchema(pool);
  await pool.query("DROP TABLE IF EXISTS public.ironshift_drizzle_test");
  await pool.query("CREATE TABLE public.ironshift_drizzle_test (value text PRIMARY KEY)");
});

beforeEach(async () => {
  await pool.query(`TRUNCATE public.ironshift_drizzle_test, ironshift.job_event,
    ironshift.attempt_history, ironshift.schedule_occurrence, ironshift.schedule_definition,
    ironshift.job_outcome, ironshift.job_runtime, ironshift.job RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS public.ironshift_drizzle_test");
  await pool.end();
});

describe("Drizzle provider integration", () => {
  it("commits application writes and enqueue in the caller-owned transaction", async () => {
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`INSERT INTO public.ironshift_drizzle_test (value) VALUES (${"committed"})`,
      );
      await adapter.forTransaction(transaction).enqueue("transaction.commit", { committed: true });
    });

    expect((await pool.query("SELECT value FROM public.ironshift_drizzle_test")).rows).toEqual([
      { value: "committed" },
    ]);
    expect((await pool.query("SELECT job_type FROM ironshift.job")).rows).toEqual([
      { job_type: "transaction.commit" },
    ]);
  });

  it("rolls back the enqueue when the caller rolls back its Drizzle transaction", async () => {
    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(
          sql`INSERT INTO public.ironshift_drizzle_test (value) VALUES (${"rolled-back"})`,
        );
        await adapter.forTransaction(transaction).enqueue("transaction.rollback", {
          committed: false,
        });
        throw new Error("rollback requested");
      }),
    ).rejects.toThrow("rollback requested");

    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM public.ironshift_drizzle_test"))
        .rows,
    ).toEqual([{ count: 0 }]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM ironshift.job")).rows).toEqual(
      [{ count: 0 }],
    );
  });

  it("uses the caller's bounded pool for concurrent operations", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, index) => adapter.queue.enqueue("pooled", { index })),
    );

    expect(new Set(ids).size).toBe(6);
    expect((await pool.query("SELECT count(*)::integer AS count FROM ironshift.job")).rows).toEqual(
      [{ count: 6 }],
    );
  });

  it("preserves PostgreSQL error codes through provider translation", async () => {
    const failure = await drizzleQueryable(db)
      .query("SELECT * FROM ironshift.relation_that_does_not_exist")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DrizzleQueryError);
    expect(failure).toMatchObject({ code: "42P01" });
  });
});
