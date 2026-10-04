// Commits an Objection model write and a Workhorse task in one Knex transaction through the Knex
// adapter.
//
// Documentation: https://workhorse.run/docs/objection

import { createKnexAdapter } from "@stablemates/workhorse-knex";
import { pathToFileURL } from "node:url";
import knex, { type Knex } from "knex";
import { Model } from "objection";

export class Account extends Model {
  static override tableName = "public.knex_account";
  declare id: number;
  declare email: string;
}

export async function createAccount(transaction: Knex.Transaction, email: string) {
  const account = await Account.query(transaction).insert({ email }).returning("*");
  const workhorse = createKnexAdapter(transaction);
  const taskId = await workhorse.forTransaction(transaction).enqueue("account.created", {
    accountId: account.id,
  });
  return { account, taskId };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "DATABASE_URL must name a disposable database with the Workhorse schema installed",
    );
  const database = knex({ client: "pg", connection: connectionString });
  try {
    if (!(await database.schema.withSchema("public").hasTable("knex_account"))) {
      await database.schema.withSchema("public").createTable("knex_account", (table) => {
        table.increments("id").primary();
        table.text("email").notNullable().unique();
      });
    }
    const created = await database.transaction((transaction) =>
      createAccount(transaction, "cli@example.test"),
    );
    console.log(JSON.stringify({ accountId: created.account.id, taskId: created.taskId }));
  } finally {
    await database.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
