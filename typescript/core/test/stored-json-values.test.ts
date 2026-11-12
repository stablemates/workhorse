import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { createHandlerContext } from "../src/handler-context.js";
import { Queue } from "../src/queue.js";
import { TaskContractValidationError } from "../src/queue/enqueue-contracts.js";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";
import { checkedCopy, encodeStoredJson } from "../src/queue/stored-json.js";
import type { TaskAttempt } from "../src/task-attempt.js";
import type {
  ChildTaskOptions,
  ClaimedTask,
  EnqueueOptions,
  EnqueueRequest,
  Json,
  Queryable,
} from "../src/types.js";
import type { HandlerContext, WorkerQueueApi } from "../src/worker.js";
import { workerQueueTierRead } from "../src/worker-internal.js";
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

// SM-2011: each entry point that stores a JSON value checks the value before any statement, also
// before the compatibility query of a new Queue and a contract read. Before this rule, a new
// Queue sent the compatibility query first, so a caller got a database error and not the TypeError.
function unansweredQueue(): { queue: Queue; statements: string[] } {
  const statements: string[] = [];
  const queryable: Queryable = {
    query: async <R extends QueryResultRow>(text: string): Promise<QueryResult<R>> => {
      statements.push(text);
      throw new Error("The database does not answer");
    },
  };
  return { queue: new Queue(queryable), statements };
}

describe("the value check of a new queue whose database does not answer", () => {
  const nan = { amount: Number.NaN };
  const member = { type: "invoice.send", payload: nan };
  const request = { idempotencyKey: "delivery-1", requestedBy: "operator" };
  const calls: Array<[string, (queue: Queue) => Promise<unknown>]> = [
    ["enqueue", (queue) => queue.enqueue("invoice.send", nan)],
    ["enqueueWithResult", (queue) => queue.enqueueWithResult("invoice.send", nan)],
    ["enqueueMany", (queue) => queue.enqueueMany([{ type: "invoice.send", payload: 1 }, member])],
    ["enqueueManyWithResults", (queue) => queue.enqueueManyWithResults([member])],
    ["createTaskGroup", (queue) => queue.createTaskGroup({ onSuccess: member })],
    ["a taskGroup member", (queue) => queue.taskGroup({}, (group) => group.add([member]))],
    ["a taskGroup callback", (queue) => queue.taskGroup({ onFinish: member }, () => {})],
    ["addToTaskGroup", (queue) => queue.addToTaskGroup("group-1", [member])],
    ["addToTaskGroupAsMember", (queue) => queue.addToTaskGroupAsMember(parent, "worker", [member])],
    [
      "syncSchedules",
      (queue) =>
        queue.syncSchedules("billing", [{ name: "monthly", schedule: "0 0 1 * *", task: member }]),
    ],
    [
      "createChild",
      (queue) => queue.createChild(parent, "worker", "receipt", "receipt.render", nan),
    ],
    [
      "createChildren",
      (queue) =>
        queue.createChildren(parent, "worker", [
          { name: "receipt", type: "receipt.render", payload: nan },
        ]),
    ],
    [
      "createChildrenAll",
      (queue) =>
        queue.createChildrenAll(parent, "worker", [
          { name: "receipt", type: "receipt.render", payload: nan },
        ]),
    ],
    ["complete", (queue) => queue.complete(parent, "worker", nan)],
    [
      "completeAndClaim",
      (queue) => queue.completeAndClaim(parent, "worker", nan, { queue: "default", limit: 1 }),
    ],
    ["sendSignal", (queue) => queue.sendSignal(parent.id, "approved", nan, request)],
    ["waitForHuman", (queue) => queue.waitForHuman(parent, "worker", "approval", nan)],
    ["completeHumanWait", (queue) => queue.completeHumanWait(parent.id, "approval", nan, request)],
    ["saveCheckpoint", (queue) => queue.saveCheckpoint(parent, "worker", "totals", nan)],
    ["updateProgress", (queue) => queue.updateProgress(parent, "worker", nan)],
  ];

  it.each(calls)("refuses %s with a TypeError and sends no statement", async (_, call) => {
    const { queue, statements } = unansweredQueue();
    const refusal = await call(queue).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TypeError);
    expect(refusal).toMatchObject({ message: expect.stringContaining("$.amount is NaN") });
    expect(statements).toEqual([]);
  });

  // A retry policy and a contract schema are stored as JSON too.
  const retryPolicy = { type: "fixed", delayMs: Number.NaN } as const;
  const otherValues: Array<[string, (queue: Queue) => Promise<unknown>, string]> = [
    [
      "a retry policy of enqueue",
      (queue) => queue.enqueue("invoice.send", null, { retryPolicy }),
      "Retry policy must contain only finite numbers, but $.delayMs is NaN",
    ],
    [
      "a retry policy of syncSchedules",
      (queue) =>
        queue.syncSchedules("billing", [
          {
            name: "monthly",
            schedule: "0 0 1 * *",
            task: { type: "invoice.send", payload: null, retryPolicy },
          },
        ]),
      "Retry policy must contain only finite numbers, but $.delayMs is NaN",
    ],
    [
      "a retry policy of createChild",
      (queue) =>
        queue.createChild(parent, "worker", "receipt", "receipt.render", null, { retryPolicy }),
      "Retry policy must contain only finite numbers, but $.delayMs is NaN",
    ],
  ];

  otherValues.push(
    [
      "a concurrency policy",
      (queue) =>
        queue.syncConcurrencyPolicies("billing", [{ queue: "invoices", maxActive: Number.NaN }]),
      "Concurrency policies must contain only finite numbers, but $[0].maxActive is NaN",
    ],
    [
      "a rate limit policy",
      (queue) =>
        queue.syncRateLimitPolicies("billing", [
          { queue: "invoices", rate: { limit: Infinity, intervalMs: 1_000, burst: 1 } },
        ]),
      "Rate limit policies must contain only finite numbers, but $[0].rate.limit is Infinity",
    ],
    [
      "a budget",
      (queue) => queue.syncBudgets("billing", [{ name: "email", maxActive: Number.NaN }]),
      "Budgets must contain only finite numbers, but $[0].maxActive is NaN",
    ],
    [
      "an execution timeout of enqueue",
      (queue) => queue.enqueue("invoice.send", null, { executionTimeoutMs: Number.NaN }),
      "Enqueue options of task type invoice.send must contain only finite numbers, but $.executionTimeoutMs is NaN",
    ],
    [
      "an execution timeout of createChild",
      (queue) =>
        queue.createChild(parent, "worker", "receipt", "receipt.render", null, {
          executionTimeoutMs: Infinity,
        }),
      "Child options of task type receipt.render must contain only finite numbers, but $.executionTimeoutMs is Infinity",
    ],
    [
      "a debounce window",
      (queue) =>
        queue.enqueue("invoice.send", null, {
          debounce: { key: "k", windowMs: Number.NaN, schedule: "reset" },
        }),
      "Enqueue options of task type invoice.send must contain only finite numbers, but $.debounce.windowMs is NaN",
    ],
    [
      "a tag of an enqueueMany request",
      (queue) =>
        queue.enqueueMany([{ type: "invoice.send", payload: null, tags: [Number.NaN] as never }]),
      "Tags of task type invoice.send must contain only finite numbers, but $[0] is NaN",
    ],
    [
      "a retention preview",
      (queue) => queue.previewRetentionPolicy({ taskEventRetentionDays: Number.NaN }),
      "Retention policy preview must contain only finite numbers, but $.definition.taskEventRetentionDays is NaN",
    ],
    [
      "a retention override",
      (queue) => queue.overrideRetentionPolicy({ taskEventRetentionDays: Number.NaN }),
      "Retention policy overrides must contain only finite numbers, but $.task_event_retention_days is NaN",
    ],
  );

  it.each(otherValues)("refuses %s and sends no statement", async (_, call, message) => {
    const { queue, statements } = unansweredQueue();
    await expect(call(queue)).rejects.toThrow(new TypeError(message));
    expect(statements).toEqual([]);
  });

  it.each([
    ["NaN", Number.NaN, '$[0].versions["1"].payloadSchema.default is NaN'],
    ["a Map", new Map(), '$[0].versions["1"].payloadSchema.default is a Map'],
  ])("refuses a contract schema with %s in syncContracts", async (_, value, detail) => {
    const statements: string[] = [];
    const queue = new Queue(
      {
        query: async <R extends QueryResultRow>(text: string): Promise<QueryResult<R>> => {
          statements.push(text);
          throw new Error("The database does not answer");
        },
      },
      "default",
      {
        contracts: {
          "invoice.send": {
            currentVersion: "1",
            versions: { "1": { payloadSchema: { type: "object", default: value as never } } },
          },
        },
      },
    );
    const refusal = await queue.syncContracts().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TypeError);
    expect(refusal).toMatchObject({ message: expect.stringContaining(detail) });
    expect(statements).toEqual([]);
  });
});

// The operations under test read only the lease check of an attempt.
const attempt = { requireLease: () => {} } as unknown as TaskAttempt;

// The operations under test call only the Queue methods that WorkerQueueApi shares with Queue.
function workerQueue(queue: Queue): WorkerQueueApi {
  return queue as unknown as WorkerQueueApi;
}

// A handler context on a queue of an unknown tier reads the tier before an operation that a fast
// tier refuses. That read is a statement, so each value is checked before it.
describe("the value check of a handler context before its tier read", () => {
  const nan = { n: Number.NaN };
  const operations: Array<[string, (context: HandlerContext) => Promise<unknown>]> = [
    ["setProgress", (context) => context.setProgress(nan)],
    ["runChild", (context) => context.runChild("receipt", "receipt.render", nan)],
    [
      "runChildren",
      (context) => context.runChildren([{ name: "receipt", type: "receipt.render", payload: nan }]),
    ],
    [
      "runChildrenAll",
      (context) =>
        context.runChildrenAll([{ name: "receipt", type: "receipt.render", payload: nan }]),
    ],
    ["waitForHuman", (context) => context.waitForHuman("approval", nan)],
  ];
  const retryPolicy = { type: "fixed", delayMs: Number.NaN } as const;
  const child = {
    name: "receipt",
    type: "receipt.render",
    payload: null,
    options: { retryPolicy },
  };
  const retryOperations: Array<[string, (context: HandlerContext) => Promise<unknown>]> = [
    ["runChild", (context) => context.runChild("receipt", "receipt.render", null, { retryPolicy })],
    ["runChildren", (context) => context.runChildren([child])],
    ["runChildrenAll", (context) => context.runChildrenAll([child])],
  ];

  it.each(retryOperations)(
    "refuses the retry policy of %s and sends no statement",
    async (_, call) => {
      const { queue, statements } = unansweredQueue();
      const context = createHandlerContext(workerQueue(queue), "worker", parent, attempt, () =>
        queue[workerQueueTierRead]("default"),
      );
      await expect(call(context)).rejects.toThrow(
        new TypeError("Retry policy must contain only finite numbers, but $.delayMs is NaN"),
      );
      expect(statements).toEqual([]);
    },
  );

  it.each(operations)("refuses %s with a TypeError and sends no statement", async (_, call) => {
    const { queue, statements } = unansweredQueue();
    const context = createHandlerContext(workerQueue(queue), "worker", parent, attempt, () =>
      queue[workerQueueTierRead]("default"),
    );
    const refusal = await call(context).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TypeError);
    expect(refusal).toMatchObject({ message: expect.stringContaining("$.n is NaN") });
    expect(statements).toEqual([]);
  });

  it("sends the text of the check, so a toJSON method runs one time", async () => {
    const sent: unknown[][] = [];
    const queue = new Queue(
      answerSchemaCheck({
        query: async <R extends QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<QueryResult<R>> => {
          sent.push([text, ...(values ?? [])]);
          const rows = [{ status: "completed", result: null }] as QueryResultRow[] as R[];
          return { command: "SELECT", rowCount: 1, oid: 0, fields: [], rows };
        },
      }),
    );
    const context = createHandlerContext(
      workerQueue(queue),
      "worker",
      parent,
      attempt,
      async () => false,
    );
    let calls = 0;
    const humanContext = { toJSON: () => ({ step: ++calls }) };
    await expect(context.waitForHuman("approval", humanContext as never)).resolves.toBeNull();
    expect(calls).toBe(1);
    const write = sent.find(([text]) => text === SQL_STATEMENTS["wait_for_human_v1"]);
    expect(write).toContain('{"step":1}');
  });
});

// SM-2011: the retry policy was checked, but the request encoded the object of the caller again, so a
// toJSON method ran four times and the statement could carry a value that no check read.
it("sends the retry policy text that passed the check, with one toJSON call", async () => {
  let encodings = 0;
  const retryPolicy = {
    toJSON: () => ({ type: "fixed", delayMs: ++encodings === 1 ? 1 : Number.NaN }),
  };
  const writes: string[] = [];
  const queue = new Queue(
    answerSchemaCheck({
      query: async <R extends QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<R>> => {
        if (text === SQL_STATEMENTS["enqueue_many_v1"]) writes.push(String(values?.[0]));
        const rows = [{ ordinal: 1, task_id: parent.id, outcome: "accepted", reason: null }];
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: rows as QueryResultRow[] as R[],
        };
      },
    }),
  );
  await queue.enqueue("invoice.send", null, { retryPolicy: retryPolicy as never });
  expect(encodings).toBe(1);
  expect(JSON.parse(writes[0]!)).toMatchObject([{ retryPolicy: { type: "fixed", delayMs: 1 } }]);
});

// SM-2011: with no retry policy, the queue kept the options object of the caller. A policy that the
// caller added during the compatibility query reached the statement with no check.
it("sends no option that the caller adds after the check", async () => {
  const sent: string[] = [];
  let answer!: () => void;
  const compatibility = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const database = answerSchemaCheck({
    query: async <R extends QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> => {
      sent.push(`${text}\n${String(values?.[0])}\n${String(values?.[4])}`);
      const rows = [{ ordinal: 1, task_id: parent.id, outcome: "accepted", status: "stale" }];
      return {
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: rows as QueryResultRow[] as R[],
      };
    },
  });
  const compatibilityQuery = database.query;
  database.query = (async (text: string, values?: readonly unknown[]) => {
    if (text === SQL_STATEMENTS["compatibility_state"]) await compatibility;
    return compatibilityQuery.call(database, text, values);
  }) as Queryable["query"];
  const queue = new Queue(database);
  const retryPolicy = { type: "fixed", delayMs: Number.NaN } as const;
  const options: EnqueueOptions = {};
  const request: EnqueueRequest = { type: "invoice.send", payload: null };
  const childOptions: ChildTaskOptions = {};
  const calls = Promise.allSettled([
    queue.enqueue("invoice.send", null, options),
    queue.enqueueMany([request]),
    queue.createChild(parent, "worker", "receipt", "receipt.render", null, childOptions),
  ]);
  options.retryPolicy = retryPolicy;
  request.options = { retryPolicy };
  childOptions.retryPolicy = retryPolicy;
  answer();
  await calls;
  expect(sent.filter((text) => text.includes("retryPolicy"))).not.toEqual([]);
  expect(sent.filter((text) => text.includes('"delayMs"'))).toEqual([]);
});

// SM-2011: the queue read a retry policy getter two times, so the statement could carry a policy
// that no check read. The first encode reads it one time.
it("reads a retry policy getter one time and sends the value that it checked", async () => {
  const sent: unknown[] = [];
  const queue = new Queue(
    answerSchemaCheck({
      query: async <R extends QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<R>> => {
        if (text === SQL_STATEMENTS["enqueue_many_v1"]) {
          sent.push((JSON.parse(String(values?.[0])) as [{ retryPolicy: unknown }])[0].retryPolicy);
        }
        const rows = [{ ordinal: 1, task_id: parent.id, outcome: "accepted", reason: null }];
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: rows as QueryResultRow[] as R[],
        };
      },
    }),
  );
  let reads = 0;
  const options = {
    get retryPolicy() {
      reads += 1;
      return reads === 1 ? undefined : { type: "fixed", delayMs: Number.NaN };
    },
  };
  await queue.enqueue("invoice.send", null, options as EnqueueOptions);
  expect({ reads, sent }).toEqual({ reads: 1, sent: [null] });
});

// SM-2011: the copy of the options was shallow, so a nested option or the tags of the caller changed
// during the compatibility query reached the statement with no check.
it("sends no nested option that the caller changes after the check", async () => {
  const sent: string[] = [];
  let answer!: () => void;
  const compatibility = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const database = answerSchemaCheck({
    query: async <R extends QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> => {
      sent.push(String(values?.[0]));
      const rows = [{ ordinal: 1, task_id: parent.id, outcome: "accepted", reason: null }];
      return {
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: rows as QueryResultRow[] as R[],
      };
    },
  });
  const compatibilityQuery = database.query;
  database.query = (async (text: string, values?: readonly unknown[]) => {
    if (text === SQL_STATEMENTS["compatibility_state"]) await compatibility;
    return compatibilityQuery.call(database, text, values);
  }) as Queryable["query"];
  const queue = new Queue(database);
  const debounce = { key: "k", windowMs: 100, schedule: "reset" as const };
  const tags = ["a"];
  const call = queue.enqueueMany([
    { type: "invoice.send", payload: null, options: { debounce }, tags },
  ]);
  debounce.windowMs = Number.NaN;
  tags.push("b");
  answer();
  await call;
  expect(JSON.parse(sent.at(-1)!)).toMatchObject([
    { debounce: { key: "k", windowMs: 100 }, tags: ["a"] },
  ]);
});

// SM-2011: a handler context passed its checked text through a map keyed by the object, so an
// unrelated enqueue of the same object could take that text after the object changed.
it("keeps the checked progress value of a handler context to its own statement", async () => {
  const sent: { enqueue?: unknown; progress?: unknown } = {};
  const queue = new Queue(
    answerSchemaCheck({
      query: async <R extends QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<R>> => {
        if (text === SQL_STATEMENTS["enqueue_many_v1"]) {
          sent.enqueue = (JSON.parse(String(values?.[0])) as [{ payload: unknown }])[0].payload;
        }
        if (text === SQL_STATEMENTS["update_progress_v1"])
          sent.progress = JSON.parse(String(values?.[3]));
        const rows = [{ ordinal: 1, task_id: parent.id, outcome: "accepted", status: "stale" }];
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: rows as QueryResultRow[] as R[],
        };
      },
    }),
  );
  let releaseTier!: (fast: boolean) => void;
  const tier = new Promise<boolean>((resolve) => {
    releaseTier = resolve;
  });
  const context = createHandlerContext(workerQueue(queue), "worker", parent, attempt, () => tier);
  let calls = 0;
  const shared = {
    value: 1,
    toJSON() {
      calls += 1;
      return { value: this.value };
    },
  };
  const progress = context.setProgress(shared as never).catch(() => undefined);
  shared.value = 2;
  await queue.enqueue("other.task", shared as never);
  releaseTier(false);
  await progress;
  expect({ calls, ...sent }).toEqual({ calls: 2, enqueue: { value: 2 }, progress: { value: 1 } });
});

// The contract read the object of the caller after the compatibility query, but the statement sent
// the text of an earlier encoding. A change of the object in that time sent an invalid payload.
it("checks the payload contract against the text that the statement sends", async () => {
  const payload: { amount: string | number } = { amount: "invalid" };
  const statements: string[] = [];
  const database: Queryable = {
    query: async <R extends QueryResultRow>(text: string): Promise<QueryResult<R>> => {
      statements.push(text);
      return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
    },
  };
  const queue = new Queue(answerSchemaCheck(database), "default", {
    contracts: {
      "invoice.send": {
        currentVersion: "1",
        versions: {
          "1": {
            payloadSchema: {
              type: "object",
              properties: { amount: { type: "number" } },
              required: ["amount"],
            },
          },
        },
      },
    },
  });
  const enqueue = queue.enqueue("invoice.send", payload);
  payload.amount = 1;
  await expect(enqueue).rejects.toBeInstanceOf(TaskContractValidationError);
  expect(statements).not.toContain(SQL_STATEMENTS["enqueue_many_v1"]);
});

/**
 * A database that answers the compatibility query, answers the first write statement with a
 * contract mismatch of `invoice.send`, and accepts the second. A contract read finds no contract.
 * Each write sends the payload text again, so the test can count the encodings.
 */
function contractMismatchOnce(write: string, row: QueryResultRow = {}) {
  const writes: unknown[][] = [];
  const queryable: Queryable = {
    query: async <R extends QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> => {
      const rows: QueryResultRow[] = [];
      if (text === SQL_STATEMENTS[write as keyof typeof SQL_STATEMENTS]) {
        writes.push([...(values ?? [])]);
        rows.push(
          writes.length === 1
            ? {
                ...row,
                ordinal: 1,
                task_id: null,
                outcome: "contract_mismatch",
                reason: JSON.stringify({ taskTypes: ["invoice.send"] }),
              }
            : {
                ...row,
                ordinal: 1,
                task_id: "00000000-0000-0000-0000-000000000002",
                outcome: "accepted",
              },
        );
      } else if (text === SQL_STATEMENTS["get_task_group_v1"]) {
        rows.push(groupRow);
      }
      return {
        command: "SELECT",
        rowCount: rows.length,
        oid: 0,
        fields: [],
        rows: rows as QueryResultRow[] as R[],
      };
    },
  };
  return { queue: new Queue(answerSchemaCheck(queryable)), writes };
}

const groupRow = {
  group_id: "00000000-0000-0000-0000-000000000003",
  state: "sealed",
  result: null,
  total: 1,
  succeeded: 0,
  failed: 0,
  canceled: 0,
  pending: 1,
  created_at: new Date(0).toISOString(),
  sealed_at: new Date(0).toISOString(),
  finished_at: null,
  canceled_at: null,
  canceled_by: null,
  cancel_reason: null,
  callbacks: {},
};

function countedPayload(): { payload: Json; calls: () => number } {
  let calls = 0;
  const payload = { toJSON: () => ({ amount: ++calls === 1 ? 1 : Number.NaN }) };
  return { payload: payload as never, calls: () => calls };
}

// SM-2011: a retry after a contract mismatch encoded each payload again, so a toJSON method ran
// two times and could give the second statement a value that no check read.
describe("one encoding for each call", () => {
  it("runs the toJSON method of a payload one time for each enqueue", async () => {
    const { queue, writes } = contractMismatchOnce("enqueue_many_v1");
    const { payload, calls } = countedPayload();
    await expect(queue.enqueue("invoice.send", payload)).resolves.toBe(
      "00000000-0000-0000-0000-000000000002",
    );
    expect(calls()).toBe(1);
    expect(writes).toHaveLength(2);
    for (const [input] of writes) {
      expect(JSON.parse(input as string)).toMatchObject([{ payload: { amount: 1 } }]);
    }
  });

  it("runs the toJSON method of each payload one time for each enqueueMany", async () => {
    const { queue, writes } = contractMismatchOnce("enqueue_many_v1");
    const { payload, calls } = countedPayload();
    await queue.enqueueMany([{ type: "invoice.send", payload }]);
    expect(calls()).toBe(1);
    expect(writes).toHaveLength(2);
  });

  it("runs the toJSON method of a task group callback and a member one time", async () => {
    const { queue, writes } = contractMismatchOnce("create_task_group_v1", {
      group_id: groupRow.group_id,
    });
    const callback = countedPayload();
    const added = countedPayload();
    await queue.taskGroup(
      { onSuccess: { type: "receipt.render", payload: callback.payload } },
      (group) => group.add([{ type: "invoice.send", payload: added.payload }]),
    );
    expect(callback.calls()).toBe(1);
    expect(added.calls()).toBe(1);
    expect(writes).toHaveLength(2);
    for (const [callbacks, members] of writes) {
      expect(JSON.parse(callbacks as string)).toMatchObject({
        onSuccess: { payload: { amount: 1 } },
      });
      expect(JSON.parse(members as string)).toMatchObject([{ payload: { amount: 1 } }]);
    }
  });
});

// SM-2011: the contract read a parsed copy of the text, which rounded a number that a double cannot
// hold. The statement still sent the exact number, so PostgreSQL stored a value that the contract
// refuses.
it("refuses a number that the contract cannot read exactly", async () => {
  const statements: string[] = [];
  const queue = new Queue(
    answerSchemaCheck({
      query: async <R extends QueryResultRow>(text: string): Promise<QueryResult<R>> => {
        statements.push(text);
        const rows = [{ ordinal: 1, task_id: parent.id, outcome: "accepted", reason: null }];
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: rows as QueryResultRow[] as R[],
        };
      },
    }),
    "default",
    {
      contracts: {
        exact: {
          currentVersion: "1",
          versions: {
            "1": {
              payloadSchema: {
                type: "object",
                properties: { n: { type: "number", maximum: 9_007_199_254_740_992 } },
              },
            },
          },
        },
      },
    },
  );
  const rawJson = Reflect.get(JSON, "rawJSON") as (text: string) => unknown;
  await expect(
    queue.enqueue("exact", { n: rawJson("9007199254740993") } as never),
  ).rejects.toBeInstanceOf(TaskContractValidationError);
  await expect(queue.enqueue("exact", { n: 9_007_199_254_740_992 })).resolves.toBe(parent.id);
  expect(statements.filter((text) => text === SQL_STATEMENTS["enqueue_many_v1"])).toHaveLength(1);
});

/** A queue that accepts each enqueue of task type `dated` that passes `payloadSchema`. */
function schemaQueue(payloadSchema: { [key: string]: Json }): Queue {
  return new Queue(
    answerSchemaCheck({
      query: async <R extends QueryResultRow>(): Promise<QueryResult<R>> => ({
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [
          { ordinal: 1, task_id: parent.id, outcome: "accepted", reason: null },
        ] as QueryResultRow[] as R[],
      }),
    }),
    "default",
    { contracts: { dated: { currentVersion: "1", versions: { "1": { payloadSchema } } } } },
  );
}

/** A schema queue whose payload requires the field `at` with the schema `field`. */
function requiredAt(field: { [key: string]: Json }): Queue {
  return schemaQueue({ type: "object", properties: { at: field }, required: ["at"] });
}

/** A queue with a contract on the field `at` of task type `dated`, which counts its enqueues. */
function contractQueue(field: { [key: string]: Json }): { queue: Queue; enqueued: () => number } {
  const statements: string[] = [];
  const queue = new Queue(
    answerSchemaCheck({
      query: async <R extends QueryResultRow>(text: string): Promise<QueryResult<R>> => {
        statements.push(text);
        const rows = [{ ordinal: 1, task_id: parent.id, outcome: "accepted", reason: null }];
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: rows as QueryResultRow[] as R[],
        };
      },
    }),
    "default",
    {
      contracts: {
        dated: {
          currentVersion: "1",
          versions: { "1": { payloadSchema: { type: "object", properties: { at: field } } } },
        },
      },
    },
  );
  const enqueued = () =>
    statements.filter((text) => text === SQL_STATEMENTS["enqueue_many_v1"]).length;
  return { queue, enqueued };
}

// SM-2011: the contract validates the value of the stored text, which is the value that the handler
// gets. docs/upgrading.md names each case that changes.
describe("a contract on the stored value", () => {
  const at = new Date(0) as unknown as Json;

  it("refuses a Date for an object field", async () => {
    const { queue, enqueued } = contractQueue({ type: "object" });
    await expect(queue.enqueue("dated", { at })).rejects.toBeInstanceOf(
      TaskContractValidationError,
    );
    expect(enqueued()).toBe(0);
  });

  it("accepts a Date for a date-time string field", async () => {
    const { queue, enqueued } = contractQueue({ type: "string", format: "date-time" });
    await expect(queue.enqueue("dated", { at })).resolves.toBe(parent.id);
    expect(enqueued()).toBe(1);
  });

  it("refuses NaN with a TypeError before the contract", async () => {
    const { queue, enqueued } = contractQueue({ type: "number" });
    await expect(queue.enqueue("dated", { at: Number.NaN })).rejects.toThrow(
      new TypeError("Payload of task type dated must contain only finite numbers, but $.at is NaN"),
    );
    expect(enqueued()).toBe(0);
  });

  // Each row of the table in docs/upgrading.md, "Check TypeScript payload contracts against the
  // stored value". The contract reads the value that JSON.stringify gives.
  const rawJson = Reflect.get(JSON, "rawJSON") as (text: string) => unknown;
  const refusedRows: Array<[string, { [key: string]: Json }, unknown]> = [
    ["an inherited required field", { type: "string" }, Object.create({ at: "a" })],
    [
      "a field that is not enumerable",
      { type: "string" },
      Object.defineProperty({}, "at", { value: "a", enumerable: false }),
    ],
  ];
  const acceptedRows: Array<[string, { [key: string]: Json }, unknown]> = [
    ["a boxed number", { type: "number" }, { at: Object(1) }],
    ["a raw boolean", { type: "boolean" }, { at: rawJson("true") }],
    ["a sparse array", { type: "array", items: { type: "null" } }, { at: Array(1) }],
  ];

  it.each(refusedRows)("refuses %s, which JSON leaves out", async (_, field, payload) => {
    await expect(requiredAt(field).enqueue("dated", payload as Json)).rejects.toBeInstanceOf(
      TaskContractValidationError,
    );
  });

  it.each(acceptedRows)("accepts the JSON value of %s", async (_, field, payload) => {
    await expect(requiredAt(field).enqueue("dated", payload as Json)).resolves.toBe(parent.id);
  });

  // SM-2011: the contract read a raw token object for `1.0`, so an object schema accepted a stored
  // number. A token now reads as a number with the same decimal value.
  it("reads a raw number token as a number with the same decimal value", async () => {
    await expect(
      requiredAt({ type: "object" }).enqueue("dated", { at: rawJson("1.0") } as never),
    ).rejects.toBeInstanceOf(TaskContractValidationError);
    await expect(
      requiredAt({ type: "number", maximum: 1 }).enqueue("dated", { at: rawJson("1.0") } as never),
    ).resolves.toBe(parent.id);
  });

  it("refuses a number token that a double cannot hold, for any schema type", async () => {
    for (const field of [{ type: "object" }, { type: "number" }]) {
      await expect(
        requiredAt(field).enqueue("dated", { at: rawJson("9007199254740993") } as never),
      ).rejects.toBeInstanceOf(TaskContractValidationError);
    }
  });

  it("leaves out an undefined property under additionalProperties false", async () => {
    const queue = schemaQueue({ type: "object", properties: {}, additionalProperties: false });
    await expect(queue.enqueue("dated", { extra: undefined } as unknown as Json)).resolves.toBe(
      parent.id,
    );
  });

  it("accepts a raw number that a double reads back with the same text", async () => {
    const { queue, enqueued } = contractQueue({ type: "number" });
    await expect(queue.enqueue("dated", { at: rawJson("12") } as never)).resolves.toBe(parent.id);
    expect(enqueued()).toBe(1);
  });
});

describe("checkedCopy", () => {
  it("gives a plain copy that encodes to the checked text", () => {
    const original = { at: new Date(0), custom: { toJSON: () => ({ ok: true }) }, list: [1] };
    const copy = checkedCopy(original, "Value");
    expect(copy).toEqual({ at: "1970-01-01T00:00:00.000Z", custom: { ok: true }, list: [1] });
    original.list.push(2);
    expect(JSON.stringify(copy)).toBe(
      '{"at":"1970-01-01T00:00:00.000Z","custom":{"ok":true},"list":[1]}',
    );
  });

  it("keeps the text of a number that a double would change", () => {
    const rawJson = Reflect.get(JSON, "rawJSON") as (text: string) => unknown;
    const value = { big: rawJson("12345678901234567890"), scale: rawJson("1.50"), small: 2 };
    expect(encodeStoredJson(checkedCopy(value as never, "Value"), "Value")).toBe(
      '{"big":12345678901234567890,"scale":1.50,"small":2}',
    );
  });

  it("refuses a value that JSON would change", () => {
    expect(() => checkedCopy({ n: Number.NaN }, "Value")).toThrow(
      new TypeError("Value must contain only finite numbers, but $.n is NaN"),
    );
  });
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
