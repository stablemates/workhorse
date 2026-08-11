import { describe, expect, it, vi } from "vitest";
import { createTypeOrmAdapter, TypeOrmQueryError, typeOrmQueryable } from "../src/index.js";

type Execute = (statement: string, values?: unknown[]) => Promise<unknown>;

describe("typeOrmQueryable", () => {
  it("passes positional parameters to TypeORM and normalizes its row array", async () => {
    const execute = vi.fn<Execute>(async () => [{ job_id: "job-1" }]);
    const queryable = typeOrmQueryable({ query: execute });

    const result = await queryable.query<{ job_id: string }>(
      "SELECT $1::text AS job_id, $2::int AS attempt",
      ["job-1", 2],
    );

    expect(result.rows).toEqual([{ job_id: "job-1" }]);
    expect(execute).toHaveBeenCalledWith("SELECT $1::text AS job_id, $2::int AS attempt", [
      "job-1",
      2,
    ]);
  });

  it("preserves the PostgreSQL driver code without exposing parameter values", async () => {
    const driverError = Object.assign(new Error("duplicate secret@example.com"), { code: "23505" });
    const cause = Object.assign(new Error("query failed"), { driverError });
    const queryable = typeOrmQueryable({
      query: vi.fn<Execute>(async () => {
        throw cause;
      }),
    });

    const failure = await queryable
      .query("SELECT $1::text", ["secret@example.com"])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeOrmQueryError);
    expect(failure).toMatchObject({ cause, code: "23505", statement: "SELECT $1::text" });
    expect((failure as Error).message).not.toContain("secret@example.com");
  });
});

describe("createTypeOrmAdapter", () => {
  it("adapts caller-owned managers and closes configured resources once", async () => {
    const execute = vi.fn<Execute>(async () => [
      { job_id: "00000000-0000-4000-8000-000000000001" },
    ]);
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const adapter = createTypeOrmAdapter({ query: execute }, { close });

    await adapter.forTransaction({ query: execute }).enqueue("test", { value: true });
    await Promise.all([adapter.close(), adapter.close()]);

    expect(execute).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
