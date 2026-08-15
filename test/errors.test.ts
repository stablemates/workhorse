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
  ChildConflictError,
  JobValueSizeLimitError,
  SignalIdempotencyConflictError,
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
    ["CheckpointConflictError", new CheckpointConflictError("job", "checkpoint")],
    ["ChildConflictError", new ChildConflictError("job", "child")],
    ["SignalIdempotencyConflictError", new SignalIdempotencyConflictError("job", "signal")],
    ["SignalWaitLeaseLostError", new SignalWaitLeaseLostError("job", "signal")],
    ["SignalWaitLimitExceededError", new SignalWaitLimitExceededError("job")],
    ["WaitLimitExceededError", new WaitLimitExceededError("job")],
    ["JobValueSizeLimitError", new JobValueSizeLimitError("type", "payload", 2, 1)],
    ["CancellationRequestedError", new CancellationRequestedError("job")],
    ["ExecutionTimeoutError", new ExecutionTimeoutError("job", 1)],
    ["MissingRowError", new MissingRowError("workhorse.promote_v1")],
  ])("%s shares the common base", (name, error) => {
    expect(error).toBeInstanceOf(WorkhorseError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
  });

  it("does not claim errors Workhorse did not raise", () => {
    expect(new TypeError("unrelated")).not.toBeInstanceOf(WorkhorseError);
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
