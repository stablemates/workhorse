import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createKnexAdapter,
  KnexQueryError,
  knexQueryable,
  type KnexExecutor,
} from "@stablemates/workhorse-knex";
import { Pool, Queue, Worker, type Queryable } from "@stablemates/workhorse";
import knex, { type Knex } from "knex";
import type { QueryContext } from "objection";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Account, createAccount } from "../../examples/objection.js";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";

const require = createRequire(import.meta.url);
const database = createDatabaseTestHarness(import.meta.url, { max: 4, extraSchemas: ["public"] });
const { pool, databaseUrl } = database;
const connection = knex({ client: "pg", connection: databaseUrl, pool: { min: 0, max: 2 } });
const adapter = createKnexAdapter(connection);
const lexicalStatement = [
  "SELECT $2::text AS second, $1::text AS first, $2::text AS repeated, '$9 ? ??' AS literal,",
  "E'\\\'$8 ?' AS escaped, 1 AS \"$7 ?\", $tag$ $6 ? $$ $tag$ AS tagged, $$ $5 ? $$ AS body,",
  "'{\"key\":1}'::jsonb ? 'key' AS exists, '{\"key\":1}'::jsonb ?| ARRAY['key'] AS any_key,",
  "'{\"key\":1}'::jsonb ?& ARRAY['key'] AS all_keys -- $4 ?",
  "/* $3 ? /* $2 ?? */ ? */",
].join("\n");

async function pairs() {
  const accounts = (await pool.query("SELECT email FROM public.knex_account ORDER BY id")).rows;
  const tasks = (
    await pool.query("SELECT task_type, payload FROM workhorse.task ORDER BY created_at, id")
  ).rows;
  return { accounts, tasks };
}

beforeAll(async () => {
  await database.setup();
  await pool.query(
    "CREATE TABLE public.knex_account (id serial PRIMARY KEY, email text NOT NULL UNIQUE)",
  );
});
beforeEach(() => database.reset());
afterAll(async () => {
  await connection.destroy();
  await database.teardown();
});

describe("released Knex native route and Objection recipe", () => {
  it("pins the released fixture and the pg driver actually resolved by Knex", () => {
    expect(require("knex/package.json").version).toBe("3.3.0");
    expect(require("objection/package.json").version).toBe("3.1.5");
    expect(require("pg/package.json").version).toBe("8.23.1");
    expect(createRequire(require.resolve("knex"))("pg/package.json").version).toBe("8.23.1");
  });

  it("executes original native text and values despite Knex question-mark rewriting", async () => {
    await connection.transaction(async (transaction) => {
      const parameters = Object.freeze(["first", "second"]);
      const native = transaction
        .raw(lexicalStatement)
        .options({ text: lexicalStatement, values: [...parameters] });
      expect(native.toSQL().toNative().sql).not.toBe(lexicalStatement);
      const result = await knexQueryable(transaction).query(lexicalStatement, parameters);
      expect(result).toEqual({
        command: "",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [
          {
            second: "second",
            first: "first",
            repeated: "second",
            literal: "$9 ? ??",
            escaped: "'$8 ?",
            "$7 ?": 1,
            tagged: " $6 ? $$ ",
            body: " $5 ? ",
            exists: true,
            any_key: true,
            all_keys: true,
          },
        ],
      });
    });
  });

  it("preserves native array, JSON, date, null, bytea and empty result values", async () => {
    const instant = new Date("2026-10-02T12:00:00.000Z");
    const result = await adapter.database.query(
      "SELECT $1::int[] AS numbers, $2::jsonb AS document, $3::timestamptz AS instant, $4::text AS empty, $5::bytea AS bytes",
      [[2, 1], { key: "? $1" }, instant, null, Buffer.from("native")],
    );
    expect(result.rows).toEqual([
      {
        numbers: [2, 1],
        document: { key: "? $1" },
        instant,
        empty: null,
        bytes: Buffer.from("native"),
      },
    ]);
    expect(await adapter.database.query("SELECT 1 WHERE false")).toMatchObject({
      rowCount: 0,
      rows: [],
    });
  });

  it("proves physical identity, independent invisibility and joint commit of the recipe", async () => {
    await connection.transaction(async (transaction) => {
      const identity =
        "SELECT pg_backend_pid() AS pid, txid_current() AS txid, current_database() AS database";
      const original = (await transaction.raw(identity)).rows;
      expect((await knexQueryable(transaction).query(identity)).rows).toEqual(original);
      const observer = (await pool.query(identity)).rows;
      expect(observer[0].database).toBe(original[0].database);
      expect(observer[0].pid).not.toBe(original[0].pid);
      expect(observer[0].txid).not.toBe(original[0].txid);
      const created = await createAccount(transaction, "committed@example.test");
      expect(await pairs()).toEqual({ accounts: [], tasks: [] });
      expect((await knexQueryable(transaction).query(identity)).rows).toEqual(original);
      expect(
        (await adapter.adminForTransaction(transaction).getTask(created.taskId))?.payload,
      ).toEqual({ accountId: created.account.id });
    });
    expect(await pairs()).toEqual({
      accounts: [{ email: "committed@example.test" }],
      tasks: [{ task_type: "account.created", payload: { accountId: 1 } }],
    });
  });

  it("rolls the recipe pair back when the caller throws", async () => {
    await expect(
      connection.transaction(async (transaction) => {
        await createAccount(transaction, "rolled-back@example.test");
        throw new Error("caller rollback");
      }),
    ).rejects.toThrow("caller rollback");
    expect(await pairs()).toEqual({ accounts: [], tasks: [] });
  });

  it("runs the disposable example CLI and observes the committed pair after Knex shutdown", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--conditions=workhorse-source", "typescript/examples/objection.ts"],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
      },
    );
    const result = JSON.parse(stdout) as { accountId: number; taskId: string };
    expect(result).toEqual({ accountId: 1, taskId: expect.any(String) });
    expect(await pairs()).toEqual({
      accounts: [{ email: "cli@example.test" }],
      tasks: [{ task_type: "account.created", payload: { accountId: result.accountId } }],
    });
  });

  it("rolls back an inner savepoint while committing the outer pair", async () => {
    await connection.transaction(async (outer) => {
      await createAccount(outer, "outer@example.test");
      await expect(
        outer.transaction(async (inner) => {
          await createAccount(inner, "inner@example.test");
          throw new Error("inner rollback");
        }),
      ).rejects.toThrow("inner rollback");
      expect(await pairs()).toEqual({ accounts: [], tasks: [] });
    });
    expect((await pairs()).accounts).toEqual([{ email: "outer@example.test" }]);
    expect((await pairs()).tasks).toHaveLength(1);
  });

  it("rolls a released savepoint back with its outer transaction", async () => {
    await expect(
      connection.transaction(async (outer) => {
        await outer.transaction((inner) => createAccount(inner, "released@example.test"));
        throw new Error("outer rollback");
      }),
    ).rejects.toThrow("outer rollback");
    expect(await pairs()).toEqual({ accounts: [], tasks: [] });
  });

  it("preserves SQLSTATE and rolls back a later Objection write failure", async () => {
    const failure: unknown = await connection
      .transaction(async (transaction) => {
        await createAccount(transaction, "duplicate@example.test");
        await Account.query(transaction).insert({ email: "duplicate@example.test" });
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ nativeError: { code: "23505" } });
    expect(await pairs()).toEqual({ accounts: [], tasks: [] });
    await expect(
      adapter.database.query("SELECT * FROM public.knex_missing", ["secret"]),
    ).rejects.toMatchObject({ name: "KnexQueryError", code: "42P01", cause: { code: "42P01" } });
  });

  it.each(["commit", "rollback"])(
    "rejects a completed %s handle rather than reusing its connection",
    async (completion) => {
      let borrowed!: Queryable;
      const run = connection.transaction(async (transaction) => {
        borrowed = knexQueryable(transaction);
        await borrowed.query("SELECT 1");
        if (completion === "rollback") throw new Error("rollback");
      });
      const result = await run.then(
        () => "commit",
        () => "rollback",
      );
      expect(result).toBe(completion);
      const failure: unknown = await borrowed
        .query("SELECT $1::int", [1])
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KnexQueryError);
      expect(failure).toMatchObject({
        cause: { message: expect.stringContaining("Transaction query already complete") },
      });
      expect((await adapter.database.query("SELECT 2 AS value")).rows).toEqual([{ value: 2 }]);
    },
  );

  it("keeps borrowed resource ownership and accepts caller-managed manual completion", async () => {
    const transaction = await connection.transaction();
    const destroy = vi.spyOn(connection, "destroy");
    const commit = vi.spyOn(transaction, "commit");
    const rollback = vi.spyOn(transaction, "rollback");
    try {
      const borrowed = createKnexAdapter(transaction);
      await createAccount(transaction, "manual@example.test");
      await Promise.all([borrowed.close(), adapter.close(), adapter.close()]);
      expect(destroy).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(rollback).not.toHaveBeenCalled();
      expect(await pairs()).toEqual({ accounts: [], tasks: [] });
      await transaction.commit();
      expect((await pairs()).tasks).toHaveLength(1);
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback();
      destroy.mockRestore();
      commit.mockRestore();
      rollback.mockRestore();
    }
  });

  it("preserves ordered batch IDs and transaction-local queue configuration", async () => {
    const configured = createKnexAdapter(connection, { defaultQueue: "knex-batch" });
    await connection.transaction(async (transaction) => {
      const ids = await configured.forTransaction(transaction).enqueueMany([
        { type: "batch.first", payload: { index: 1 } },
        { type: "batch.second", payload: { index: 2 } },
      ]);
      const result = await transaction("workhorse.task")
        .select("id", "task_type", "queue_name")
        .whereIn("id", ids);
      expect(ids.map((id) => result.find((row) => row.id === id)?.task_type)).toEqual([
        "batch.first",
        "batch.second",
      ]);
      expect(result.every((row) => row.queue_name === "knex-batch")).toBe(true);
      expect((await pairs()).tasks).toEqual([]);
    });
    expect((await pairs()).tasks).toHaveLength(2);
  });

  it("uses the transaction in an Objection model hook and rolls back its enqueue on failure", async () => {
    class HookAccount extends Account {
      override async $afterInsert(context: QueryContext) {
        await createKnexAdapter(connection)
          .forTransaction(context.transaction as Knex.Transaction)
          .enqueue("hook.created", { accountId: this.id });
        throw new Error("hook failure");
      }
    }
    await expect(
      connection.transaction(
        async (transaction) =>
          await HookAccount.query(transaction).insert({ email: "hook@example.test" }),
      ),
    ).rejects.toThrow("hook failure");
    expect(await pairs()).toEqual({ accounts: [], tasks: [] });
  });

  it("borrows a transaction from another caller-owned Knex instance without closing it", async () => {
    const foreign = knex({ client: "pg", connection: databaseUrl, pool: { min: 0, max: 1 } });
    const destroy = vi.spyOn(foreign, "destroy");
    try {
      await foreign.transaction(async (transaction) => {
        await adapter.forTransaction(transaction).enqueue("foreign.transaction", {});
        expect(await pairs()).toEqual({ accounts: [], tasks: [] });
        expect(
          (await knexQueryable(transaction).query("SELECT pg_backend_pid() AS pid")).rows,
        ).toEqual((await transaction.raw("SELECT pg_backend_pid() AS pid")).rows);
        await adapter.close();
        expect(destroy).not.toHaveBeenCalled();
      });
      expect((await pairs()).tasks).toHaveLength(1);
    } finally {
      destroy.mockRestore();
      await foreign.destroy();
    }
  });

  it("runs a worker on a separately owned pg pool only after the application commits", async () => {
    const workerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    const handled = vi.fn<(payload: { accountId: number }) => Promise<{ accountId: number }>>(
      async (payload) => ({
        accountId: payload.accountId,
      }),
    );
    const worker = new Worker(new Queue(workerPool), {
      workerId: "separate-knex-worker",
      pollMs: 0,
    }).handle("account.created", handled);
    try {
      const created = await connection.transaction(async (transaction) => {
        const result = await createAccount(transaction, "worker@example.test");
        expect(await worker.runOnce()).toBe(false);
        expect(handled).not.toHaveBeenCalled();
        return result;
      });
      expect(await worker.runOnce()).toBe(true);
      expect(handled).toHaveBeenCalledWith({ accountId: created.account.id }, expect.anything());
      expect((await adapter.admin.getTask(created.taskId))?.state).toBe("succeeded");
    } finally {
      await workerPool.end();
    }
    expect((await adapter.database.query("SELECT 1 AS value")).rows).toEqual([{ value: 1 }]);
  });

  it("rejects response hooks and foreign dialects before execution, including later config mutation", async () => {
    const transformed = knex({
      client: "pg",
      connection: databaseUrl,
      postProcessResponse: (result) => result.rows,
    });
    try {
      expect(() => knexQueryable(transformed)).toThrow(/without postProcessResponse/);
    } finally {
      await transformed.destroy();
    }
    expect(() =>
      knexQueryable({ client: { config: { client: "mysql2" } } } as unknown as KnexExecutor),
    ).toThrow(/client: pg/);
    const queryable = knexQueryable(connection);
    connection.client.config.postProcessResponse = (result: unknown) => result;
    try {
      await expect(queryable.query("SELECT 1")).rejects.toMatchObject({
        cause: { message: expect.stringContaining("postProcessResponse") },
      });
    } finally {
      delete connection.client.config.postProcessResponse;
    }
  });

  it.each([null, [], { rows: null }, { rows: [[1]] }, { rows: [null] }])(
    "rejects malformed native results: %j",
    async (result) => {
      const executor = {
        client: { config: { client: "pg" } },
        raw: () => ({ options: async () => result }),
      } as unknown as KnexExecutor;
      await expect(knexQueryable(executor).query("SELECT 1")).rejects.toMatchObject({
        name: "KnexQueryError",
        cause: { message: expect.stringContaining("object rows") },
      });
    },
  );

  it("rejects multi-statement result arrays rather than reporting an empty success", async () => {
    await expect(adapter.database.query("SELECT 1; SELECT 2")).rejects.toBeInstanceOf(
      KnexQueryError,
    );
  });

  it("demonstrates why the pool queue must not escape into an application transaction", async () => {
    await expect(
      connection.transaction(async (transaction) => {
        await Account.query(transaction).insert({ email: "escape@example.test" });
        await adapter.queue.enqueue("escaped.task", {});
        expect((await pairs()).tasks).toHaveLength(1);
        throw new Error("caller rollback");
      }),
    ).rejects.toThrow("caller rollback");
    expect((await pairs()).accounts).toEqual([]);
    expect((await pairs()).tasks).toHaveLength(1);
  });
});
