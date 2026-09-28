import { randomUUID } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { Queue } from "../src/index.js";
import type { Queryable } from "../src/types.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

type SentSync = { code: string | undefined };

/**
 * Replace the first `forced` sync statements with one that PostgreSQL rejects with `code`.
 *
 * The replacement really fails in PostgreSQL, so inside a transaction it aborts that transaction
 * exactly as a deadlock would.
 */
function forceSyncFailures(
  database: Queryable,
  code: string,
  forced: number,
): { queryable: Queryable; sent: SentSync[] } {
  const sent: SentSync[] = [];
  const queryable: Queryable = {
    query: async <R extends QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> => {
      if (!text.includes("workhorse.sync_concurrency_policies_v1(")) {
        return database.query<R>(text, values);
      }
      const record: SentSync = { code: undefined };
      sent.push(record);
      try {
        return sent.length <= forced
          ? await database.query<R>(
              `DO $$ BEGIN RAISE EXCEPTION 'forced sync failure' USING ERRCODE = '${code}'; END $$`,
            )
          : await database.query<R>(text, values);
      } catch (error) {
        record.code = (error as { code?: string }).code;
        throw error;
      }
    },
  };
  return { queryable, sent };
}

describe("concurrency policy sync deadlock retry", () => {
  it("sends the sync again after PostgreSQL chose it as a deadlock victim", async () => {
    const queueName = `sync-deadlock-${randomUUID()}`;
    const { queryable, sent } = forceSyncFailures(pool, "40P01", 1);

    const policies = await new Queue(queryable).syncConcurrencyPolicies("sync-deadlock-test", [
      { queue: queueName, maxActive: 2 },
    ]);

    expect(policies).toMatchObject([{ queue: queueName, maxActive: 2 }]);
    expect(sent.map((record) => record.code)).toEqual(["40P01", undefined]);
    expect(await queue.listConcurrencyPolicies([queueName])).toMatchObject([
      { queue: queueName, maxActive: 2 },
    ]);
  });

  it("raises the last deadlock after three attempts", async () => {
    const { queryable, sent } = forceSyncFailures(pool, "40P01", 3);

    await expect(
      new Queue(queryable).syncConcurrencyPolicies("sync-deadlock-test", [
        { queue: `sync-deadlock-${randomUUID()}`, maxActive: 1 },
      ]),
    ).rejects.toMatchObject({ code: "40P01" });
    expect(sent).toHaveLength(3);
  });

  it("sends the sync once when it fails with another error", async () => {
    const { queryable, sent } = forceSyncFailures(pool, "40001", 1);

    await expect(
      new Queue(queryable).syncConcurrencyPolicies("sync-deadlock-test", [
        { queue: `sync-deadlock-${randomUUID()}`, maxActive: 1 },
      ]),
    ).rejects.toMatchObject({ code: "40001" });
    expect(sent).toHaveLength(1);
  });

  it("raises the original deadlock inside a caller's transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { queryable, sent } = forceSyncFailures(client, "40P01", 1);
      const failure = new Queue(queryable).syncConcurrencyPolicies("sync-deadlock-test", [
        { queue: `sync-deadlock-${randomUUID()}`, maxActive: 1 },
      ]);

      await expect(failure).rejects.toMatchObject({
        code: "40P01",
        message: "forced sync failure",
      });
      expect(sent.map((record) => record.code)).toEqual(["40P01", "25P02"]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
