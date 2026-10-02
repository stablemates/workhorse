import { TransactionPropagation } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createKyselyAdapter, KyselyQueryError } from "@stablemates/workhorse-kysely";
import { CompiledQuery } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";
import { acceptMikroOrder, createMikroOrm, MikroOrder } from "../examples/mikroorm.js";

const database = createDatabaseTestHarness(import.meta.url, {
  max: 2,
  extraSchemas: ["public"],
});
let orm: MikroORM;

beforeAll(async () => {
  await database.setup();
  orm = await createMikroOrm(database.databaseUrl);
  const ormDatabase = await orm.em
    .fork()
    .execute<{ database: string }[]>("SELECT current_database() AS database");
  const observerDatabase = await database.pool.query<{ database: string }>(
    "SELECT current_database() AS database",
  );
  if (ormDatabase[0]!.database !== observerDatabase.rows[0]!.database) {
    throw new Error("MikroORM and the observer must use the same scratch database");
  }
  await orm.schema.create();
});

beforeEach(async () => {
  await database.reset();
});

afterAll(async () => {
  await orm?.close();
  await database.teardown();
});

async function observed() {
  const orders = await database.pool.query<{ reference: string }>(
    "SELECT reference FROM public.mikro_order ORDER BY reference",
  );
  const tasks = await database.pool.query<{ id: string; payload: { orderId: number } }>(
    "SELECT id, payload FROM workhorse.task ORDER BY id",
  );
  return { orders: orders.rows, tasks: tasks.rows };
}

describe("MikroORM 7.2.1 through the shipped Kysely adapter", () => {
  it("runs the example and jointly commits the entity and task", async () => {
    const result = await acceptMikroOrder(orm, "committed");

    expect(result.orderId).toBeTypeOf("number");
    expect(result.taskId).toBeTypeOf("string");
    expect(await observed()).toEqual({
      orders: [{ reference: "committed" }],
      tasks: [{ id: result.taskId, payload: { orderId: result.orderId } }],
    });
  });

  it.each([false, true])(
    "uses the exact callback executor, with independent invisibility and rollback=%s",
    async (rollback) => {
      const pooled = orm.em.fork().getKysely();
      const workhorse = createKyselyAdapter(pooled);
      const abort = new Error("application rollback");
      let orderId!: number;
      let taskId!: string;
      const transaction = orm.em.fork().transactional(async (transactionalEm) => {
        const order = transactionalEm.create(MikroOrder, { reference: "identity" });
        await transactionalEm.flush();
        orderId = order.id;
        const executor = transactionalEm.getKysely();
        expect(executor).toBe(transactionalEm.getTransactionContext());
        expect(executor).not.toBe(pooled);
        const execute = vi.spyOn(executor, "executeQuery");
        try {
          const scoped = createKyselyAdapter(executor);
          const throughOrm = await transactionalEm.execute<{ pid: number; xid: string }[]>(
            "SELECT pg_backend_pid() AS pid, txid_current()::text AS xid",
          );
          const throughAdapter = await scoped.database.query<{ pid: number; xid: string }>(
            "SELECT pg_backend_pid() AS pid, txid_current()::text AS xid",
          );
          expect(throughAdapter.rows).toEqual(throughOrm);
          const observer = await database.pool.query<{ pid: number; xid: string }>(
            "SELECT pg_backend_pid() AS pid, txid_current()::text AS xid",
          );
          expect(observer.rows[0]!.pid).not.toBe(throughAdapter.rows[0]!.pid);
          expect(observer.rows[0]!.xid).not.toBe(throughAdapter.rows[0]!.xid);

          taskId = await workhorse.forTransaction(executor).enqueue("order.accepted", {
            orderId,
          });
          expect(
            execute.mock.calls.some(([query]) => "sql" in query && query.sql.includes("enqueue")),
          ).toBe(true);
          expect(await observed()).toEqual({ orders: [], tasks: [] });
          expect(
            (await scoped.database.query("SELECT id FROM workhorse.task WHERE id = $1", [taskId]))
              .rows,
          ).toEqual([{ id: taskId }]);
          if (rollback) throw abort;
        } finally {
          execute.mockRestore();
        }
      });

      const outcome = await transaction.catch((error: unknown) => error);
      expect(outcome).toBe(rollback ? abort : undefined);
      expect(await observed()).toEqual(
        rollback
          ? { orders: [], tasks: [] }
          : {
              orders: [{ reference: "identity" }],
              tasks: [{ id: taskId, payload: { orderId } }],
            },
      );
    },
  );

  it("maps raw result fields and PostgreSQL types without entity conversion", async () => {
    await orm.em.fork().transactional(async (transactionalEm) => {
      const adapter = createKyselyAdapter(transactionalEm.getKysely());
      const result = await adapter.database.query<{
        label: string;
        integer: number;
        wide: string;
        document: { accepted: boolean };
        occurred_at: string;
      }>(
        "SELECT $1::text AS label, 42::integer AS integer, 9007199254740993::bigint AS wide, $2::jsonb AS document, $3::timestamptz AS occurred_at",
        ["literal $2 and 'quote'", JSON.stringify({ accepted: true }), "2026-10-02T12:00:00Z"],
      );
      expect(result.rows).toEqual([
        {
          label: "literal $2 and 'quote'",
          integer: 42,
          wide: "9007199254740993",
          document: { accepted: true },
          occurred_at: expect.any(String),
        },
      ]);
      expect(result.rowCount).toBe(1);
      expect(new Date(result.rows[0]!.occurred_at).toISOString()).toBe("2026-10-02T12:00:00.000Z");
      expect(result.command).toBe("");
      expect(result.oid).toBe(0);
      expect(result.fields).toEqual([]);
      const empty = await adapter.database.query("SELECT 1 WHERE false");
      expect(empty.rows).toEqual([]);
      expect(empty.rowCount).toBe(0);
      const update = await adapter.database.query(
        "UPDATE public.mikro_order SET reference = reference",
      );
      expect(update.rows).toEqual([]);
      expect(update.rowCount).toBe(0);
    });
  });

  it("rolls back an inner savepoint while allowing the outer transaction to commit", async () => {
    const workhorse = createKyselyAdapter(orm.em.fork().getKysely());
    const abort = new Error("rollback inner savepoint");
    let outerTask!: string;
    await orm.em.fork().transactional(async (outerEm) => {
      const order = outerEm.create(MikroOrder, { reference: "outer" });
      await outerEm.flush();
      outerTask = await workhorse.forTransaction(outerEm.getKysely()).enqueue("order.accepted", {
        orderId: order.id,
      });
      await expect(
        outerEm.transactional(
          async (innerEm) => {
            expect(innerEm.getKysely()).toBe(innerEm.getTransactionContext());
            expect(innerEm.getKysely()).not.toBe(outerEm.getKysely());
            const identitySql = "SELECT pg_backend_pid() AS pid, txid_current()::text AS xid";
            expect(await innerEm.execute(identitySql)).toEqual(await outerEm.execute(identitySql));
            const innerOrder = innerEm.create(MikroOrder, { reference: "inner" });
            await innerEm.flush();
            await workhorse.forTransaction(innerEm.getKysely()).enqueue("order.accepted", {
              orderId: innerOrder.id,
            });
            throw abort;
          },
          { propagation: TransactionPropagation.NESTED },
        ),
      ).rejects.toBe(abort);
      expect(await observed()).toEqual({ orders: [], tasks: [] });
      expect(
        (
          await outerEm.execute<{ reference: string }[]>("SELECT reference FROM public.mikro_order")
        ).map((row) => row.reference),
      ).toEqual(["outer"]);
      expect(await outerEm.execute("SELECT id FROM workhorse.task")).toEqual([{ id: outerTask }]);
    });
    expect((await observed()).orders).toEqual([{ reference: "outer" }]);
    expect((await observed()).tasks.map((task) => task.id)).toEqual([outerTask]);
  });

  it("rolls back a released inner savepoint together with its outer transaction", async () => {
    const workhorse = createKyselyAdapter(orm.em.fork().getKysely());
    const abort = new Error("rollback outer after releasing savepoint");
    await expect(
      orm.em.fork().transactional(async (outerEm) => {
        await outerEm.transactional(
          async (innerEm) => {
            const order = innerEm.create(MikroOrder, { reference: "released-inner" });
            await innerEm.flush();
            await workhorse.forTransaction(innerEm.getKysely()).enqueue("order.accepted", {
              orderId: order.id,
            });
          },
          { propagation: TransactionPropagation.NESTED },
        );
        expect(await outerEm.execute("SELECT reference FROM public.mikro_order")).toEqual([
          { reference: "released-inner" },
        ]);
        expect(await outerEm.execute("SELECT id FROM workhorse.task")).toHaveLength(1);
        expect(await observed()).toEqual({ orders: [], tasks: [] });
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await observed()).toEqual({ orders: [], tasks: [] });
  });

  it("rolls back successful enqueue when the callback's final automatic flush fails", async () => {
    const workhorse = createKyselyAdapter(orm.em.fork().getKysely());
    let enqueued = false;
    const failure = await orm.em
      .fork()
      .transactional(async (transactionalEm) => {
        const first = transactionalEm.create(MikroOrder, { reference: "duplicate" });
        await transactionalEm.flush();
        await workhorse.forTransaction(transactionalEm.getKysely()).enqueue("order.accepted", {
          orderId: first.id,
        });
        enqueued = true;
        transactionalEm.create(MikroOrder, { reference: "duplicate" });
      })
      .catch((error: unknown) => error);
    expect(enqueued).toBe(true);
    expect(failure).toMatchObject({ code: "23505" });
    expect(await observed()).toEqual({ orders: [], tasks: [] });
  });

  it("preserves SQLSTATE and original cause, including an aborted enqueue", async () => {
    await expect(
      orm.em.fork().transactional(async (transactionalEm) => {
        const executor = transactionalEm.getKysely();
        const adapter = createKyselyAdapter(executor);
        const failure = await adapter.database
          .query("SELECT * FROM public.mikroorm_missing_relation")
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(KyselyQueryError);
        expect(failure).toMatchObject({
          code: "42P01",
          cause: { code: "42P01", table: undefined },
        });
        const cause = (failure as KyselyQueryError).cause;
        expect(cause).toBeInstanceOf(Error);
        expect((cause as Error).message).toContain("mikroorm_missing_relation");
        const aborted = await adapter.forTransaction(executor).enqueue("order.accepted", {});
        throw new Error(`unexpected enqueue ${aborted}`);
      }),
    ).rejects.toMatchObject({ name: "KyselyQueryError", code: "25P02", cause: { code: "25P02" } });
    expect(await observed()).toEqual({ orders: [], tasks: [] });
  });

  it("never destroys borrowed executors, flushes entities, or ends the application's transaction", async () => {
    const pooled = orm.em.fork().getKysely();
    const destroyPool = vi.spyOn(pooled, "destroy");
    const workhorse = createKyselyAdapter(pooled);
    try {
      await orm.em.fork().transactional(async (transactionalEm) => {
        const executor = transactionalEm.getKysely();
        const destroyTransaction = vi.spyOn(executor, "destroy");
        const flush = vi.spyOn(transactionalEm, "flush");
        try {
          const scoped = createKyselyAdapter(executor);
          transactionalEm.create(MikroOrder, { reference: "owned" });
          await workhorse.forTransaction(executor).enqueue("order.accepted", { orderId: 0 });
          expect(flush).not.toHaveBeenCalled();
          await scoped.close();
          await workhorse.close();
          expect(destroyTransaction).not.toHaveBeenCalled();
          expect(destroyPool).not.toHaveBeenCalled();
          expect(await observed()).toEqual({ orders: [], tasks: [] });
          expect(
            (await executor.executeQuery(CompiledQuery.raw("SELECT 1 AS alive"))).rows,
          ).toEqual([{ alive: 1 }]);
        } finally {
          destroyTransaction.mockRestore();
          flush.mockRestore();
        }
      });
      expect((await observed()).orders).toEqual([{ reference: "owned" }]);
      expect((await observed()).tasks).toHaveLength(1);
      expect(destroyPool).not.toHaveBeenCalled();
      expect((await pooled.executeQuery(CompiledQuery.raw("SELECT 1 AS alive"))).rows).toEqual([
        { alive: 1 },
      ]);
    } finally {
      destroyPool.mockRestore();
    }
  });

  it.each(["captured pool", "callback fork"])(
    "detects %s escaping rollback as a negative control",
    async (source) => {
      const capturedPoolExecutor = orm.em.fork().getKysely();
      const workhorse = createKyselyAdapter(capturedPoolExecutor);
      const abort = new Error("rollback the ORM only");
      let escapedTask!: string;
      await expect(
        orm.em.fork().transactional(async (transactionalEm) => {
          const escapedExecutor =
            source === "callback fork" ? transactionalEm.fork().getKysely() : capturedPoolExecutor;
          const order = transactionalEm.create(MikroOrder, { reference: "escaped" });
          await transactionalEm.flush();
          const ormPid = await transactionalEm.execute<{ pid: number }[]>(
            "SELECT pg_backend_pid() AS pid",
          );
          const poolPid = await createKyselyAdapter(escapedExecutor).database.query<{
            pid: number;
          }>("SELECT pg_backend_pid() AS pid");
          expect(poolPid.rows[0]!.pid).not.toBe(ormPid[0]!.pid);
          escapedTask = await workhorse.forTransaction(escapedExecutor).enqueue("order.accepted", {
            orderId: order.id,
          });
          expect((await observed()).orders).toEqual([]);
          expect((await observed()).tasks.map((task) => task.id)).toEqual([escapedTask]);
          throw abort;
        }),
      ).rejects.toBe(abort);
      expect((await observed()).orders).toEqual([]);
      expect((await observed()).tasks.map((task) => task.id)).toEqual([escapedTask]);
    },
  );

  it("runs the disposable example CLI and leaves the committed pair after ORM shutdown", async () => {
    await orm.schema.drop();
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=workhorse-source",
        "--import",
        "tsx",
        "typescript/adapter-conformance/examples/mikroorm.ts",
      ],
      {
        env: { ...process.env, DATABASE_URL: database.databaseUrl },
      },
    );
    const accepted = JSON.parse(result.stdout) as { orderId: number; taskId: string };
    expect(accepted.orderId).toBeTypeOf("number");
    expect(accepted.taskId).toBeTypeOf("string");
    expect(await observed()).toEqual({
      orders: [{ reference: "example-order" }],
      tasks: [{ id: accepted.taskId, payload: { orderId: accepted.orderId } }],
    });
  });
});
import { execFile } from "node:child_process";
import { promisify } from "node:util";
