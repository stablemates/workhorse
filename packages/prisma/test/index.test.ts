import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "pg";
import {
  createPrismaAdapter,
  PrismaQueryError,
  prismaQueryable,
  type PrismaExecutor,
} from "../src/index.js";

type Execute = (statement: string, ...values: unknown[]) => Promise<unknown>;

describe("prismaQueryable", () => {
  it("binds pg-style placeholders through Prisma's unsafe parameter API", async () => {
    const execute = vi.fn<Execute>(async () => [{ job_id: "job-1" }]);
    const queryable = prismaQueryable({ $queryRawUnsafe: execute } as PrismaExecutor);

    const result = await queryable.query<{ job_id: string }>(
      "SELECT $1::text AS job_id, $2::int AS attempt",
      ["job-1", 2],
    );

    expect(result.rows).toEqual([{ job_id: "job-1" }]);
    expect(execute).toHaveBeenCalledWith(
      "SELECT $1::text AS job_id, $2::int AS attempt",
      "job-1",
      2,
    );
  });

  it("preserves a nested PostgreSQL code without exposing parameter values", async () => {
    const cause = Object.assign(new Error("raw query failed for secret@example.com"), {
      code: "P2010",
      meta: { code: "P1001" },
    });
    const queryable = prismaQueryable({
      $queryRawUnsafe: vi.fn<Execute>(async () => {
        throw cause;
      }),
    });

    const failure = await queryable
      .query("SELECT $1::text", ["secret@example.com"])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PrismaQueryError);
    expect(failure).toMatchObject({ cause, code: "P1001", statement: "SELECT $1::text" });
    expect((failure as Error).message).not.toContain("secret@example.com");
  });

  it("delegates notification connections to an explicitly supplied pool", async () => {
    const connect = vi.fn<() => Promise<void>>(async () => undefined);
    const notificationPool = {
      connect,
      options: { max: 4 },
      query: (async () => ({
        command: "",
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: [],
      })) as PrismaAdapterPool["query"],
    };
    const queryable = prismaQueryable(
      { $queryRawUnsafe: vi.fn<Execute>(async () => []) },
      notificationPool,
    ) as typeof notificationPool & {
      notificationConnectionCapacity?: number;
      notificationConnectionIdentity?: object;
    };

    await queryable.connect();
    expect(queryable.notificationConnectionCapacity).toBe(4);
    expect(queryable.notificationConnectionIdentity).toBe(notificationPool);
    expect(connect).toHaveBeenCalledOnce();
  });
});

type PrismaAdapterPool = {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<QueryResult<R>>;
};

describe("createPrismaAdapter", () => {
  it("adapts caller-owned transactions and closes configured resources once", async () => {
    const execute = vi.fn<Execute>(async () => [
      { job_id: "00000000-0000-4000-8000-000000000001" },
    ]);
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const adapter = createPrismaAdapter({ $queryRawUnsafe: execute }, { close });

    await adapter.forTransaction({ $queryRawUnsafe: execute }).enqueue("test", { value: true });
    await Promise.all([adapter.close(), adapter.close()]);

    expect(execute).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
