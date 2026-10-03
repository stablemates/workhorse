import assert from "node:assert/strict";
import knex from "knex";
import { createKnexAdapter, KnexQueryError, knexQueryable } from "@stablemates/workhorse-knex";
import { Pool } from "@stablemates/workhorse";
import { createAccount } from "./objection.ts";

const connectionString = process.env.DATABASE_URL_TEST;
const database = knex({ client: "pg", connection: connectionString, pool: { min: 0, max: 1 } });
const observer = new Pool({ connectionString });
const adapter = createKnexAdapter(database);
try {
  await observer.query(
    "CREATE TABLE public.knex_account (id serial PRIMARY KEY, email text NOT NULL UNIQUE)",
  );
  const statement =
    "SELECT $2::text AS second, $1::text AS first, $2::text AS repeated, '$9 ?' AS literal, $$ $8 ? $$ AS body, '{\"key\":1}'::jsonb ? 'key' AS present /* $7 ? */";
  await database.transaction(async (transaction) => {
    const queryable = knexQueryable(transaction);
    assert.deepEqual((await queryable.query(statement, ["first", "second"])).rows, [
      {
        second: "second",
        first: "first",
        repeated: "second",
        literal: "$9 ?",
        body: " $8 ? ",
        present: true,
      },
    ]);
    const identity = "SELECT pg_backend_pid() AS pid, txid_current() AS txid";
    assert.deepEqual(
      (await queryable.query(identity)).rows,
      (await transaction.raw(identity)).rows,
    );
    const created = await createAccount(transaction, "packed@example.test");
    assert.equal((await observer.query("SELECT * FROM public.knex_account")).rowCount, 0);
    assert.equal(
      (await adapter.adminForTransaction(transaction).getTask(created.taskId)).payload.accountId,
      created.account.id,
    );
  });
  assert.equal((await observer.query("SELECT * FROM public.knex_account")).rowCount, 1);
  await assert.rejects(
    database.transaction(async (transaction) => {
      await createAccount(transaction, "rollback@example.test");
      throw new Error("packed rollback");
    }),
    /packed rollback/,
  );
  assert.equal((await observer.query("SELECT * FROM public.knex_account")).rowCount, 1);
  await assert.rejects(
    adapter.database.query("SELECT * FROM public.packed_knex_missing"),
    (error) => error instanceof KnexQueryError && error.code === "42P01",
  );
  await adapter.close();
  assert.equal((await database.raw("SELECT 1 AS value")).rows[0].value, 1);
} finally {
  await database.destroy();
  await observer.query("DROP TABLE IF EXISTS public.knex_account");
  await observer.end();
}
