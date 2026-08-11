import type { QueryResult as KyselyQueryResult } from "kysely";
import { describe, expect, it, vi } from "vitest";
import {
  createKyselyAdapter,
  KyselyQueryError,
  kyselyQueryable,
  type KyselyExecutor,
} from "../src/index.js";

type Execute = (query: {
  sql: string;
  parameters: readonly unknown[];
}) => Promise<KyselyQueryResult<Record<string, unknown>>>;

describe("kyselyQueryable", () => {
  it("compiles pg-style SQL and parameters for Kysely's executor", async () => {
    const execute = vi.fn<Execute>(async () => ({ rows: [{ job_id: "job-1" }] }));
    const queryable = kyselyQueryable({ executeQuery: execute } as KyselyExecutor);

    const result = await queryable.query<{ job_id: string }>(
      "SELECT $1::text AS job_id, $2::int AS attempt",
      ["job-1", 2],
    );

    expect(result.rows).toEqual([{ job_id: "job-1" }]);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      sql: "SELECT $1::text AS job_id, $2::int AS attempt",
      parameters: ["job-1", 2],
    });
  });

  it("preserves PostgreSQL codes without exposing parameter values", async () => {
    const cause = Object.assign(new Error("duplicate secret@example.com"), { code: "23505" });
    const execute = vi.fn<Execute>(async () => {
      throw cause;
    });
    const queryable = kyselyQueryable({ executeQuery: execute } as KyselyExecutor);

    const failure = await queryable
      .query("SELECT $1::text", ["secret@example.com"])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(KyselyQueryError);
    expect(failure).toMatchObject({ cause, code: "23505", statement: "SELECT $1::text" });
    expect((failure as Error).message).not.toContain("secret@example.com");
  });
});

describe("createKyselyAdapter", () => {
  it("adapts caller-owned transactions and closes configured resources once", async () => {
    const execute = vi.fn<Execute>(async () => ({
      rows: [{ job_id: "00000000-0000-4000-8000-000000000001" }],
    }));
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const executor = { executeQuery: execute } as KyselyExecutor;
    const adapter = createKyselyAdapter(executor, { close });

    await adapter.forTransaction(executor).enqueue("test", { value: true });
    await Promise.all([adapter.close(), adapter.close()]);

    expect(execute).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
