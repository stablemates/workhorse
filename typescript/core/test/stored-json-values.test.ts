import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";
import { encodeStoredJson } from "../src/queue/stored-json.js";
import type { ClaimedTask, Json, Queryable } from "../src/types.js";
import { answerSchemaCheck } from "./support/schema-check.js";

// SM-1930 and SM-1989: JSON.stringify writes NaN and the infinities as null, and a Map or a Set as
// {}. Thus a stored value differed from the value of the caller, with no error.

const parent: ClaimedTask = {
  id: "00000000-0000-0000-0000-000000000001",
  queue: "default",
  type: "invoice.send",
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
  leaseExpiresAt: new Date(8_640_000_000_000_000),
};

function recordingQueue(): { queue: Queue; statements: string[] } {
  const statements: string[] = [];
  const queryable: Queryable = {
    query: async <R extends QueryResultRow>(text: string): Promise<QueryResult<R>> => {
      statements.push(text);
      return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
    },
  };
  return { queue: new Queue(answerSchemaCheck(queryable)), statements };
}

// Each value that JSON cannot store as given, with the path and the text that the message names.
const unstorable: Array<[string, unknown, string]> = [
  ["NaN", { amount: Number.NaN }, "$.amount is NaN"],
  ["Infinity", { ratio: Infinity }, "$.ratio is Infinity"],
  ["-Infinity at the top level", -Infinity, "$ is -Infinity"],
  ["a nested array member", { lines: [1, [2, Number.NaN]] }, "$.lines[1][1] is NaN"],
  ["a key that is not an identifier", { "unit price": Infinity }, '$["unit price"] is Infinity'],
  // A boxed number reaches the replacer as an object, and JSON.stringify writes its value.
  ["a boxed NaN", { amount: Object(Number.NaN) }, "$.amount is NaN"],
  ["a Map", { tags: new Map([["a", 1]]) }, "$.tags is a Map"],
  ["a nested Set", { items: [{ ids: new Set([1]) }] }, "$.items[0].ids is a Set"],
];

describe("values that Workhorse stores as JSON", () => {
  it.each(unstorable)(
    "refuses a payload with %s before the write statement",
    async (_, payload, detail) => {
      const { queue, statements } = recordingQueue();
      const enqueue = queue.enqueue("invoice.send", payload as Json);
      await expect(enqueue).rejects.toThrow(TypeError);
      await expect(enqueue).rejects.toThrow(`Payload of task type invoice.send must contain only`);
      await expect(enqueue).rejects.toThrow(detail);
      expect(statements).toEqual([]);
    },
  );

  it.each(unstorable)("refuses a handler result with %s", async (_, result, detail) => {
    const { queue, statements } = recordingQueue();
    const complete = queue.complete(parent, "worker", result as Json);
    await expect(complete).rejects.toThrow(TypeError);
    await expect(complete).rejects.toThrow(`Result of task type invoice.send must contain only`);
    await expect(complete).rejects.toThrow(detail);
    expect(statements).toEqual([]);
  });

  it("refuses an unstorable value in each enqueue of a batch before the write statement", async () => {
    const { queue, statements } = recordingQueue();
    await expect(
      queue.enqueueMany([
        { type: "invoice.send", payload: { amount: 1 } },
        { type: "invoice.send", payload: { amount: Number.NaN } },
      ]),
    ).rejects.toThrow("$.amount is NaN");
    expect(statements).toEqual([]);
  });

  it("refuses a child payload before the write statement", async () => {
    const { queue, statements } = recordingQueue();
    await expect(
      queue.createChild(parent, "worker", "receipt", "receipt.render", {
        total: Infinity,
      } as Json),
    ).rejects.toThrow(
      new TypeError(
        "Payload of task type receipt.render must contain only finite numbers, but $.total is Infinity",
      ),
    );
    await expect(
      queue.createChildren(parent, "worker", [
        { name: "receipt", type: "receipt.render", payload: { ids: new Set([1]) } as never },
      ]),
    ).rejects.toThrow("$.ids is a Set");
    expect(statements).toEqual([]);
  });

  // The child request encoded the payload a second time, so a toJSON method that changed its
  // answer reached the statement with a value that no check read.
  it("sends the child payload text that passed the checks", async () => {
    const sent: unknown[][] = [];
    const queryable: Queryable = {
      query: async <R extends QueryResultRow>(
        _text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<R>> => {
        sent.push([...(values ?? [])]);
        return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
      },
    };
    let calls = 0;
    const payload = { toJSON: () => ({ total: ++calls === 1 ? 1 : Number.NaN }) };
    const queue = new Queue(answerSchemaCheck(queryable));
    await expect(
      queue.createChild(parent, "worker", "receipt", "receipt.render", payload as never),
    ).rejects.toThrow("workhorse.create_child_v2");
    expect(calls).toBe(1);
    const request = sent
      .flat()
      .find((value) => typeof value === "string" && value.includes("total"));
    expect(JSON.parse(request as string)).toMatchObject({ payload: { total: 1 } });
  });

  it("sends the schedule payload text that passed the checks", async () => {
    const sent: unknown[] = [];
    const queryable: Queryable = {
      query: async <R extends QueryResultRow>(
        _text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<R>> => {
        sent.push(...(values ?? []));
        return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
      },
    };
    let calls = 0;
    const payload = { toJSON: () => ({ amount: ++calls === 1 ? 1 : Number.NaN }) };
    await new Queue(answerSchemaCheck(queryable)).syncSchedules("billing", [
      {
        name: "monthly",
        schedule: "0 0 1 * *",
        task: { type: "invoice.send", payload: payload as never },
      },
    ]);
    expect(calls).toBe(1);
    const inputs = sent.find((value) => typeof value === "string" && value.includes("monthly"));
    expect(JSON.parse(inputs as string)).toMatchObject([{ payload: { amount: 1 } }]);
  });

  it("refuses a signal payload and a human-wait value before the write statement", async () => {
    const { queue, statements } = recordingQueue();
    const request = { idempotencyKey: "delivery-1", requestedBy: "operator" };
    await expect(
      queue.sendSignal(parent.id, "approved", { amount: Number.NaN }, request),
    ).rejects.toThrow(
      new TypeError(
        `Signal payload of task ${parent.id} must contain only finite numbers, but $.amount is NaN`,
      ),
    );
    await expect(
      queue.waitForHuman(parent, "worker", "approval", { limits: new Map() } as never),
    ).rejects.toThrow(
      new TypeError(
        "Human wait context of task type invoice.send must contain only JSON values, but $.limits is a Map, which JSON writes as {}",
      ),
    );
    await expect(
      queue.completeHumanWait(parent.id, "approval", { score: -Infinity }, request),
    ).rejects.toThrow(`Human wait result of task ${parent.id} must contain only finite numbers`);
    expect(statements).toEqual([]);
  });

  it("refuses a checkpoint and a progress value before the write statement", async () => {
    const { queue, statements } = recordingQueue();
    await expect(
      queue.saveCheckpoint(parent, "worker", "totals", { sum: Number.NaN }),
    ).rejects.toThrow(
      new TypeError(
        "Checkpoint totals of task type invoice.send must contain only finite numbers, but $.sum is NaN",
      ),
    );
    await expect(
      queue.updateProgress(parent, "worker", { seen: new Set([1]) } as never),
    ).rejects.toThrow("Progress of task type invoice.send must contain only JSON values");
    expect(statements).toEqual([]);
  });
});

// SM-1989: on a new Queue, the compatibility query runs before the value check. It reads and
// writes nothing, and the enqueue statement does not follow. A follow-up issue owns the strict
// order.
it("sends only the compatibility query of a new queue before it refuses a payload", async () => {
  const statements: string[] = [];
  const queryable: Queryable = {
    query: async <R extends QueryResultRow>(text: string): Promise<QueryResult<R>> => {
      statements.push(text);
      return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
    },
  };
  const queue = new Queue(answerSchemaCheck(queryable));
  const compatibilityQueries: string[] = [];
  const answer = queryable.query;
  queryable.query = ((text: string, values?: readonly unknown[]) => {
    compatibilityQueries.push(text);
    return answer.call(queryable, text, values);
  }) as Queryable["query"];
  await expect(queue.enqueue("invoice.send", { amount: Number.NaN })).rejects.toThrow(TypeError);
  expect(compatibilityQueries).toEqual([SQL_STATEMENTS["compatibility_state"]]);
  expect(statements).toEqual([]);
});

describe("encodeStoredJson", () => {
  // JSON.stringify converted a boxed number again after the check, so the stored number could
  // differ from the checked one.
  it("converts a boxed number one time and stores the number that it checked", () => {
    let conversions = 0;
    const counted = Object.assign(Object(0) as object, { valueOf: () => ++conversions });
    expect(encodeStoredJson({ amount: counted }, "Value")).toBe('{"amount":1}');
    expect(conversions).toBe(1);
    // JSON.stringify refuses a bigint that valueOf returns, so the encoder refuses it too.
    const big = Object.assign(Object(0) as object, { valueOf: () => 9_007_199_254_740_993n });
    expect(() => encodeStoredJson({ amount: big }, "Value")).toThrow(TypeError);
    expect(() => JSON.stringify({ amount: big })).toThrow(TypeError);
    const infinite = Object.assign(Object(0) as object, {
      [Symbol.toPrimitive]: () => Infinity,
    });
    expect(() => encodeStoredJson({ amount: infinite }, "Value")).toThrow(
      new TypeError("Value must contain only finite numbers, but $.amount is Infinity"),
    );
  });

  it("keeps the other JSON rules", () => {
    const value = {
      dropped: undefined,
      list: [undefined, 1],
      date: new Date(0),
      custom: { toJSON: () => ({ ok: true }) },
    };
    expect(encodeStoredJson(value, "Value")).toBe(JSON.stringify(value));
  });

  it("checks the value that toJSON returns", () => {
    expect(() => encodeStoredJson({ custom: { toJSON: () => Number.NaN } }, "Value")).toThrow(
      new TypeError("Value must contain only finite numbers, but $.custom is NaN"),
    );
  });

  it("refuses a value with no JSON text at the top level", () => {
    expect(() => encodeStoredJson(undefined, "Value")).toThrow(
      new TypeError("Value must be JSON serializable"),
    );
  });

  it("names the path of a value that a parent shares with another parent", () => {
    const shared = { rate: 1 };
    const broken = { rate: Number.NaN };
    expect(() => encodeStoredJson({ a: shared, b: shared, c: [broken] }, "Value")).toThrow(
      "$.c[0].rate is NaN",
    );
  });
});
