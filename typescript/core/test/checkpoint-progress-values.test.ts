import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import type { ClaimedTask, Json, Queryable } from "../src/types.js";

// SM-1169: JSON.stringify writes NaN and the infinities as null, so checkpoint("ratio", () =>
// Infinity) stored null under a value typed as a number.

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

function recordingDatabase(): { queryable: Queryable; statements: string[] } {
  const statements: string[] = [];
  const queryable: Queryable = {
    query: async <R extends QueryResultRow>(text: string): Promise<QueryResult<R>> => {
      statements.push(text);
      return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
    },
  };
  return { queryable, statements };
}

// Numbers JSON cannot represent, at the top level and nested in arrays and objects.
const nonFinite: Array<[string, unknown]> = [
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["NaN", Number.NaN],
  ["a nested object member", { ratio: { value: Infinity } }],
  ["a nested array element", [1, [2, Number.NaN]]],
];

describe("checkpoint and progress values", () => {
  it.each(nonFinite)("rejects a checkpoint holding %s before any statement", async (_, value) => {
    const { queryable, statements } = recordingDatabase();
    await expect(
      new Queue(queryable).saveCheckpoint(task, "worker", "ratio", value as Json),
    ).rejects.toThrow(new TypeError("Checkpoint value must contain only finite numbers"));
    expect(statements).toEqual([]);
  });

  it.each(nonFinite)("rejects progress holding %s before any statement", async (_, value) => {
    const { queryable, statements } = recordingDatabase();
    await expect(
      new Queue(queryable).updateProgress(task, "worker", value as Json),
    ).rejects.toThrow(new TypeError("Progress value must contain only finite numbers"));
    expect(statements).toEqual([]);
  });
});
