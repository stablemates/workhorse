import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import type { ClaimedTask, Queryable } from "../src/types.js";

const task: ClaimedTask = {
  id: "00000000-0000-0000-0000-000000000001",
  queue: "fast",
  type: "noop",
  priority: 0,
  payload: null,
  contractVersion: null,
  resultMaxBytes: 1_048_576,
  redactErrorDetails: false,
  traceContext: null,
  attempt: 1,
  maxAttempts: 1,
  retryPolicy: null,
  deadlineAt: null,
  executionTimeoutMs: null,
  attemptTimeoutAt: null,
  fenceToken: 1n,
  leaseExpiresAt: new Date(0),
};

function deadlock(): Error {
  return Object.assign(new Error("deadlock detected"), { code: "40P01" });
}

// Answers complete_many_and_claim_v1 with the given failures first, then accepts the task.
function database(failures: Error[]): { queryable: Queryable; calls: () => number } {
  let calls = 0;
  const queryable: Queryable = {
    query: async <R extends QueryResultRow>(): Promise<QueryResult<R>> => {
      const failure = failures[calls++];
      if (failure) throw failure;
      const rows = [{ accepted: [task.id], task_id: null }] as unknown as R[];
      return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
    },
  };
  return { queryable, calls: () => calls };
}

describe("fused completion deadlock retry", () => {
  it("sends the statement again after PostgreSQL chooses it as a deadlock victim", async () => {
    const { queryable, calls } = database([deadlock(), deadlock()]);
    const result = await new Queue(queryable).completeAndClaim(task, "worker", "null", {
      queue: "fast",
      limit: 0,
    });

    expect(result).toEqual({ accepted: true, claimed: [] });
    expect(calls()).toBe(3);
  });

  it("rejects after three deadlocks", async () => {
    const { queryable, calls } = database([deadlock(), deadlock(), deadlock()]);
    const completion = new Queue(queryable).completeAndClaim(task, "worker", "null", {
      queue: "fast",
      limit: 0,
    });

    await expect(completion).rejects.toMatchObject({ code: "40P01" });
    expect(calls()).toBe(3);
  });

  it("does not send the statement again after another error", async () => {
    const failure = Object.assign(new Error("serialization failure"), { code: "40001" });
    const { queryable, calls } = database([failure]);
    const completion = new Queue(queryable).completeAndClaim(task, "worker", "null", {
      queue: "fast",
      limit: 0,
    });

    await expect(completion).rejects.toBe(failure);
    expect(calls()).toBe(1);
  });
});
