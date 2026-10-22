import { describe, expect, it } from "vitest";
import {
  databaseErrorCode,
  databaseErrorDetails,
  expectOneRow,
  MissingRowError,
  WorkhorseError,
} from "../src/errors.js";
import {
  CheckpointConflictError,
  CheckpointInputConflictError,
  ChildConflictError,
  HumanWaitAlreadyWaitingError,
  HumanWaitConflictError,
  TaskValueSizeLimitError,
  SignalIdempotencyConflictError,
  SignalWaitConflictError,
  SignalWaitLeaseLostError,
  SignalWaitLimitExceededError,
  WaitLimitExceededError,
} from "../src/queue.js";
import { CancellationRequestedError, ExecutionTimeoutError } from "../src/worker.js";

/** One wrapper shaped like the error an ORM package raises around a driver failure. */
class AdapterError extends Error {
  constructor(
    cause: unknown,
    readonly code?: string,
  ) {
    super("adapter failed", { cause });
    this.name = "AdapterError";
  }
}

describe("WorkhorseError", () => {
  it.each([
    ["CheckpointConflictError", new CheckpointConflictError("task", "checkpoint")],
    [
      "CheckpointInputConflictError",
      new CheckpointInputConflictError("task", "checkpoint", "a".repeat(64), "b".repeat(64)),
    ],
    ["ChildConflictError", new ChildConflictError("task", "child")],
    ["HumanWaitAlreadyWaitingError", new HumanWaitAlreadyWaitingError("task", "decision")],
    ["HumanWaitConflictError", new HumanWaitConflictError("task", "decision")],
    ["SignalIdempotencyConflictError", new SignalIdempotencyConflictError("task", "signal")],
    ["SignalWaitConflictError", new SignalWaitConflictError("task", "signal")],
    ["SignalWaitLeaseLostError", new SignalWaitLeaseLostError("task", "signal")],
    ["SignalWaitLimitExceededError", new SignalWaitLimitExceededError("task")],
    ["WaitLimitExceededError", new WaitLimitExceededError("task")],
    ["TaskValueSizeLimitError", new TaskValueSizeLimitError("type", "payload", 2, 1)],
    ["CancellationRequestedError", new CancellationRequestedError("task")],
    ["ExecutionTimeoutError", new ExecutionTimeoutError("task", 1)],
    ["MissingRowError", new MissingRowError("workhorse.promote_v1")],
  ])("%s shares the common base", (name, error) => {
    expect(error).toBeInstanceOf(WorkhorseError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
  });

  it("does not claim errors Workhorse did not raise", () => {
    expect(new TypeError("unrelated")).not.toBeInstanceOf(WorkhorseError);
  });

  it("uses waitName for signal and human-wait error context", () => {
    expect(new SignalWaitLeaseLostError("task", "signal")).toMatchObject({
      waitName: "signal",
    });
    expect(new HumanWaitConflictError("task", "decision")).toMatchObject({
      waitName: "decision",
    });
  });
});

describe("databaseErrorCode", () => {
  it("reads a SQLSTATE off the error itself", () => {
    expect(databaseErrorCode(Object.assign(new Error("conflict"), { code: "P1001" }))).toBe(
      "P1001",
    );
  });

  it("reads a SQLSTATE through an adapter wrapper", () => {
    const driverError = Object.assign(new Error("conflict"), { code: "P1002" });
    expect(databaseErrorCode(new AdapterError(driverError))).toBe("P1002");
  });

  it("reads a SQLSTATE through a TypeORM driverError", () => {
    const wrapper = { driverError: { code: "23505" } };
    expect(databaseErrorCode(wrapper)).toBe("23505");
  });

  it("prefers a nested SQLSTATE over the Prisma code that wraps it", () => {
    const prismaError = { code: "P2010", meta: { code: "P1001" } };
    expect(databaseErrorCode(prismaError)).toBe("P1001");
  });

  it("falls back to the Prisma code when nothing nested supplies a SQLSTATE", () => {
    expect(databaseErrorCode({ code: "P2010", meta: { message: "boom" } })).toBe("P2010");
  });

  it("ignores values that are not SQLSTATE shaped", () => {
    expect(databaseErrorCode({ code: "ECONNREFUSED" })).toBeUndefined();
    expect(databaseErrorCode({ code: 23505 })).toBeUndefined();
    expect(databaseErrorCode("not an object")).toBeUndefined();
    expect(databaseErrorCode(null)).toBeUndefined();
  });

  it("terminates on a cyclic cause", () => {
    const error: { code: string; cause?: unknown } = { code: "not-a-state" };
    error.cause = error;
    expect(databaseErrorCode(error)).toBeUndefined();
  });

  it("stops before an unbounded wrapper chain", () => {
    let error: unknown = { code: "P1001" };
    for (let depth = 0; depth < 40; depth += 1) error = { cause: error };
    expect(databaseErrorCode(error)).toBeUndefined();
  });
});

describe("databaseErrorDetails", () => {
  it("returns every detail along the chain, nearest first", () => {
    const driverError = Object.assign(new Error("conflict"), { detail: '{"scope":"orders"}' });
    const wrapper = Object.assign(new AdapterError(driverError), { detail: "adapter noise" });
    expect(databaseErrorDetails(wrapper)).toEqual(["adapter noise", '{"scope":"orders"}']);
  });

  it("returns nothing when no wrapper carries a detail string", () => {
    expect(databaseErrorDetails(new AdapterError(new Error("conflict")))).toEqual([]);
  });
});

// A typed conflict reads only the SQLSTATE and the DETAIL payloads, so every ORM shape that
// carries one PostgreSQL error must give both walkers the same two values.
describe("ORM error shapes", () => {
  const detail = '{"conflictingFields":["payload"]}';
  const pgError = () => Object.assign(new Error("conflict"), { code: "P1001", detail });
  const shapes: Record<string, unknown> = {
    "node-postgres": pgError(),
    "TypeORM driverError": { message: "query failed", driverError: pgError() },
    "Prisma 6 meta": {
      code: "P2010",
      meta: { code: "P1001", message: "conflict" },
      cause: pgError(),
    },
    "Prisma 7 driver adapter": {
      code: "P2010",
      meta: {
        driverAdapterError: Object.assign(new Error("postgres"), {
          cause: {
            originalCode: "P1001",
            originalMessage: "conflict",
            kind: "postgres",
            code: "P1001",
            detail,
          },
        }),
      },
    },
  };

  it.each(Object.entries(shapes))("reads the SQLSTATE and DETAIL through %s", (_, error) => {
    expect(databaseErrorCode(new AdapterError(error))).toBe("P1001");
    expect(databaseErrorDetails(new AdapterError(error))).toContain(detail);
  });

  it("reads a Prisma 7 originalCode when the driver adapter gives no code", () => {
    const error = {
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "42P01", kind: "TableDoesNotExist", table: "missing" },
        },
      },
    };
    expect(databaseErrorCode(error)).toBe("42P01");
  });

  it("never lets originalCode override a present code", () => {
    expect(databaseErrorCode({ code: "23505", originalCode: "42P01" })).toBe("23505");
    expect(databaseErrorCode({ code: "N/A", originalCode: "42P01" })).toBeUndefined();
  });
});

describe("expectOneRow", () => {
  it("returns the single row", () => {
    expect(expectOneRow({ rows: [{ count: 3 }] }, "workhorse.promote_v1")).toEqual({ count: 3 });
  });

  it("names the statement when a row is missing", () => {
    expect(() => expectOneRow({ rows: [] }, "workhorse.promote_v1")).toThrow(MissingRowError);
    expect(() => expectOneRow({ rows: [] }, "workhorse.promote_v1")).toThrow(
      "workhorse.promote_v1 returned no rows",
    );
  });
});
