import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import type { QueryResult } from "pg";
import {
  createDrizzleAdapter,
  DrizzleQueryError,
  drizzleQueryable,
  type DrizzleExecutor,
} from "../src/index.js";

type Execute = (query: SQL) => Promise<QueryResult<Record<string, unknown>>>;

function result(rows: Record<string, unknown>[] = []): QueryResult<Record<string, unknown>> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

describe("drizzleQueryable", () => {
  it("binds pg-style placeholders as Drizzle parameters", async () => {
    const execute = vi.fn<Execute>(async () => result([{ job_id: "job-1" }]));
    const queryable = drizzleQueryable({ execute } as unknown as DrizzleExecutor);

    const queryResult = await queryable.query<{ job_id: string }>(
      "SELECT $1::text AS job_id, $2::int AS attempt",
      ["job-1", 2],
    );

    expect(queryResult.rows[0]?.job_id).toBe("job-1");
    const compiled = execute.mock.calls[0]![0].toQuery({
      casing: undefined,
      escapeName: (name) => `"${name}"`,
      escapeParam: (index) => `$${index + 1}`,
      escapeString: (value) => `'${value}'`,
      invokeSource: "indexes",
    });
    expect(compiled.sql).toBe("SELECT $1::text AS job_id, $2::int AS attempt");
    expect(compiled.params).toEqual(["job-1", 2]);
  });

  it("translates database failures without leaking parameter values into the message", async () => {
    const cause = Object.assign(new Error("duplicate secret@example.com"), { code: "23505" });
    const queryable = drizzleQueryable({
      execute: vi.fn<Execute>(async () => {
        throw cause;
      }),
    } as unknown as DrizzleExecutor);

    const failure = await queryable
      .query("SELECT $1::text", ["secret@example.com"])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DrizzleQueryError);
    expect(failure).toMatchObject({ cause, code: "23505", statement: "SELECT $1::text" });
    expect((failure as Error).message).not.toContain("secret@example.com");
  });
});

describe("createDrizzleAdapter", () => {
  it("adapts caller-owned transaction objects and only closes configured resources once", async () => {
    const execute = vi.fn<Execute>(async () => result([{ job_id: "job-1" }]));
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const adapter = createDrizzleAdapter({ execute } as unknown as DrizzleExecutor, { close });

    await adapter
      .forTransaction({ execute } as unknown as DrizzleExecutor)
      .enqueue("test", { value: true });
    await Promise.all([adapter.close(), adapter.close()]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
