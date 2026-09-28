import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import type { ClaimedTask, Queryable } from "../src/types.js";

const task: ClaimedTask = {
  id: "00000000-0000-0000-0000-000000000001",
  queue: "full",
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

function databaseError(code: string): Error {
  return Object.assign(new Error(`SQLSTATE ${code}`), { code });
}

// Answers every statement with the given failures first, then with the given row.
function database(
  failures: Error[],
  row: QueryResultRow,
): { queryable: Queryable; statements: string[] } {
  const statements: string[] = [];
  const queryable: Queryable = {
    query: async <R extends QueryResultRow>(text: string): Promise<QueryResult<R>> => {
      const failure = failures[statements.length];
      statements.push(text);
      if (failure) throw failure;
      const rows = [row] as R[];
      return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
    },
  };
  return { queryable, statements };
}

// Each full-tier write fenced by the lease, and the row that accepts it.
const fencedWrites: Array<[string, QueryResultRow, (queue: Queue) => Promise<unknown>]> = [
  ["complete_v1", { accepted: true }, (queue) => queue.complete(task, "worker", null)],
  ["fail_v1", { state: "failed" }, (queue) => queue.fail(task, "worker", new Error("failed"))],
  ["heartbeat_v1", { status: "accepted" }, (queue) => queue.heartbeat(task, "worker")],
  ["acknowledge_cancel_v1", { accepted: true }, (queue) => queue.acknowledgeCancel(task, "worker")],
  [
    "update_progress_v1",
    {
      status: "updated",
      progress_value: { done: 1 },
      revision: "1",
      attempt: 1,
      fence_token: "1",
      worker_id: "worker",
      created_at: new Date(0),
      updated_at: new Date(0),
      retry_after_ms: null,
    },
    (queue) => queue.updateProgress(task, "worker", { done: 1 }),
  ],
];

describe("fenced write deadlock retry", () => {
  it.each(fencedWrites)(
    "sends %s again after PostgreSQL chooses it as a deadlock victim",
    async (statement, row, write) => {
      const { queryable, statements } = database(
        [databaseError("40P01"), databaseError("40P01")],
        row,
      );

      await write(new Queue(queryable));
      expect(statements).toHaveLength(3);
      for (const text of statements) expect(text).toContain(`workhorse.${statement}(`);
    },
  );

  it("rejects after three deadlocks", async () => {
    const deadlocks = [databaseError("40P01"), databaseError("40P01"), databaseError("40P01")];
    const { queryable, statements } = database(deadlocks, { state: "failed" });

    await expect(new Queue(queryable).fail(task, "worker", new Error("failed"))).rejects.toBe(
      deadlocks[2],
    );
    expect(statements).toHaveLength(3);
  });

  it("reports the deadlock when a caller-owned transaction cannot run the resend", async () => {
    const deadlock = databaseError("40P01");
    const { queryable, statements } = database([deadlock, databaseError("25P02")], {
      accepted: true,
    });

    await expect(new Queue(queryable).complete(task, "worker", null)).rejects.toBe(deadlock);
    expect(statements).toHaveLength(2);
  });

  it("does not send the statement again after another error", async () => {
    const failure = databaseError("40001");
    const { queryable, statements } = database([failure], { accepted: true });

    await expect(new Queue(queryable).complete(task, "worker", null)).rejects.toBe(failure);
    expect(statements).toHaveLength(1);
  });

  it("does not resend a write that the lease does not fence", async () => {
    const deadlock = databaseError("40P01");
    const { queryable, statements } = database([deadlock], {});

    await expect(new Queue(queryable).cancel(task.id)).rejects.toBe(deadlock);
    expect(statements).toHaveLength(1);
  });
});
