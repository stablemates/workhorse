import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import type { Queue } from "@stablemates/workhorse";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";

// Drizzle gives the adapter no signal when a transaction ends, so a kept `forTransaction` queue is
// not invalidated. These cases pin the lifetime rule the package README documents. Knex rejects a
// completed handle instead; knex-integration.test.ts covers that.

const database = createDatabaseTestHarness(import.meta.url, { max: 2 });
const { pool, databaseUrl } = database;
// One connection, so the next transaction borrows the connection the kept queue still names.
const drizzlePool = new Pool({ connectionString: databaseUrl, max: 1 });
const db = drizzle({ client: drizzlePool });
const adapter = createDrizzleAdapter(db);

async function taskTypes(): Promise<string[]> {
  const result = await pool.query<{ task_type: string }>(
    "SELECT task_type FROM workhorse.task ORDER BY created_at, id",
  );
  return result.rows.map((row) => row.task_type);
}

beforeAll(async () => {
  await database.setup();
});
beforeEach(() => database.reset());
afterAll(async () => {
  await drizzlePool.end();
  await database.teardown();
});

describe("a Drizzle transaction queue kept after its transaction", () => {
  it.each(["commit", "rollback"])(
    "commits an enqueue on its own once a %s releases the connection",
    async (completion) => {
      let kept!: Queue;
      const ended = await db
        .transaction(async (tx) => {
          kept = adapter.forTransaction(tx);
          await kept.enqueue("inside.transaction", null);
          if (completion === "rollback") throw new Error("rollback");
        })
        .then(
          () => "commit",
          () => "rollback",
        );
      expect(ended).toBe(completion);

      await kept.enqueue("after.transaction", null);

      expect(await taskTypes()).toEqual(
        completion === "commit"
          ? ["inside.transaction", "after.transaction"]
          : ["after.transaction"],
      );
    },
  );

  it("joins whichever transaction borrowed the released connection next", async () => {
    let kept!: Queue;
    await db.transaction(async (tx) => {
      kept = adapter.forTransaction(tx);
      await kept.enqueue("first.transaction", null);
    });

    await expect(
      db.transaction(async (tx) => {
        await kept.enqueue("kept.queue", null);
        await adapter.forTransaction(tx).enqueue("second.transaction", null);
        throw new Error("second transaction rolls back");
      }),
    ).rejects.toThrow("second transaction rolls back");

    expect(await taskTypes()).toEqual(["first.transaction"]);
  });
});
