import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Json, Worker } from "../src/index.js";
import { hasUnstorableEscape, mayHoldUnstorableEscape } from "../src/queue/enqueue-contracts.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

const unstorableResultMessage =
  "result.unstorable result contains a NUL character or an unpaired surrogate," +
  " which PostgreSQL jsonb cannot store";

// Handler results whose JSON jsonb refuses. JSON.stringify writes NUL as \u0000 and a lone
// surrogate as its escape.
const unstorableResults: Json[] = [
  "\u0000",
  { items: ["ok", { note: "a\u0000b" }] },
  { "k\u0000": 1 },
  { s: "\ud800" },
  "\udc00",
  ["x\ud83d"],
];

// Each document is valid JSON. The worker's escape scan must agree with PostgreSQL's cast on it.
const castDocuments = [
  String.raw`"\u0000"`,
  String.raw`{"items":["ok",{"note":"a\u0000b"}]}`,
  String.raw`{"k\u0000":1}`,
  String.raw`"\ud800"`,
  String.raw`"\udc00"`,
  String.raw`[1,["\ud83dx"]]`,
  String.raw`{"\udfff":true}`,
  String.raw`"\ude00\ud83d"`,
  String.raw`"\ud83d\\ude00"`,
  String.raw`"\ud83d\n"`,
  String.raw`["\ud83d","\ude00"]`,
  String.raw`{"\ud83d":"\ude00"}`,
  String.raw`"\ud83d\ude00"`,
  String.raw`"\uD83D\uDE00"`,
  String.raw`{"\ud83d\ude00":"\uD83D\uDE00"}`,
  String.raw`"😀"`,
  String.raw`"\uD800"`,
  String.raw`"\uDC00x"`,
  String.raw`"\u003c\u003e\u0026"`,
  String.raw`"\u00e9\u00E9"`,
  String.raw`"\\u0000"`,
  String.raw`{"\\ud800":"\\\\ud800"}`,
  String.raw`"\\\u0001"`,
  String.raw`"\u0001\u001f "`,
  String.raw`"é�"`,
  String.raw`"🙂"`,
  String.raw`"plain"`,
  String.raw`{"a":[1,true,null]}`,
];

type Statement = { text: string; values: readonly unknown[] };

function recordStatements(): Statement[] {
  const statements: Statement[] = [];
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
    const [first, second] = args;
    if (typeof first === "string") {
      statements.push({ text: first, values: Array.isArray(second) ? second : [] });
    } else if (typeof first === "object" && first !== null && "text" in first) {
      const config = first as { text: string; values?: unknown[] };
      statements.push({ text: config.text, values: config.values ?? [] });
    }
    return query(...args);
  }) as typeof pool.query);
  return statements;
}

function namesTask(statement: Statement, taskId: string): boolean {
  return statement.values.some(
    (value) => value === taskId || (Array.isArray(value) && value.includes(taskId)),
  );
}

type Outcome = { task_id: string; state: string; attempt: number; name: string; message: string };

async function outcomes(fast: boolean, ids: readonly string[]): Promise<Outcome[]> {
  const [table, attempt] = fast
    ? ["fast_task_outcome", "attempt"]
    : ["task_outcome", "current_attempt"];
  const result = await pool.query<Outcome>(
    `SELECT task_id::text, state, ${attempt} AS attempt,
            coalesce(error->>'name', '') AS name, coalesce(error->>'message', '') AS message
       FROM workhorse.${table} WHERE task_id = ANY($1::uuid[])`,
    [ids],
  );
  return result.rows;
}

describe("unstorable handler results", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses exactly the escapes PostgreSQL's jsonb cast refuses", async () => {
    for (const document of castDocuments) {
      JSON.parse(document);
      const castError = await pool
        .query("SELECT $1::text::jsonb", [document])
        .then(() => undefined)
        .catch((error: unknown) => error);
      expect([document, hasUnstorableEscape(document)]).toEqual([
        document,
        castError !== undefined,
      ]);
    }
  });

  // JSON.stringify writes non-ASCII text and < raw, so ordinary text has no escape for the quick
  // check to find. The full scan still accepts a valid surrogate pair.
  it("keeps ordinary text off the full scan", () => {
    for (const value of ["é<b>&amp;", { ключ: "値 <a href>" }, "\u{1F600}", "\u2028"]) {
      const serialized = JSON.stringify(value);
      expect([serialized, mayHoldUnstorableEscape(serialized)]).toEqual([serialized, false]);
    }
    for (const document of [String.raw`"\ud83d\ude00"`, String.raw`"\uD83D\uDE00"`]) {
      expect(mayHoldUnstorableEscape(document)).toBe(true);
      expect(hasUnstorableEscape(document)).toBe(false);
    }
    for (const document of [
      String.raw`"\u0000"`,
      String.raw`"\ud800"`,
      String.raw`"\uDC00"`,
      String.raw`"<\u003c\uD83D"`,
    ]) {
      expect([document, hasUnstorableEscape(document)]).toEqual([document, true]);
    }
  });

  // An unstorable result used to reach the completion statement, whose refusal stopped the worker
  // and left the task leased. The worker now fails the attempt itself under the task's retry
  // policy. On the fast tier the bad members never join a completion batch, and the good member
  // still completes.
  it.each([false, true])(
    "fails each unstorable result under its retry policy and keeps running (fast tier: %s)",
    async (fast) => {
      const queueName = `ts-unstorable-${fast ? "fast" : "full"}`;
      if (fast) await admin.setQueueTier(queueName, "fast", adminAudit("move to the fast tier"));
      const ids = await queue.enqueueMany(
        Array.from({ length: unstorableResults.length + 1 }, (_, sequence) => ({
          type: "result.unstorable",
          payload: { sequence },
          options: {
            queue: queueName,
            maxAttempts: 2,
            retryPolicy: { type: "fixed" as const, delayMs: 0 },
          },
        })),
      );
      const validId = ids.at(-1)!;
      const statements = recordStatements();
      const worker = new Worker(queue, {
        workerId: queueName,
        queue: queueName,
        concurrency: ids.length,
        pollMs: 5,
      }).handle<{ sequence: number }>(
        "result.unstorable",
        ({ sequence }) => unstorableResults[sequence] ?? { ok: true, pair: "\u{1F600}" },
      );

      const controller = new AbortController();
      const run = worker.run(controller.signal);
      let settled: Outcome[] = [];
      try {
        await vi.waitFor(
          async () => {
            settled = await outcomes(fast, ids);
            expect(settled).toHaveLength(ids.length);
          },
          { timeout: 20_000, interval: 20 },
        );
      } finally {
        controller.abort();
        worker.stop();
      }
      await expect(run).resolves.toBeUndefined();

      for (const outcome of settled) {
        expect(outcome).toEqual(
          outcome.task_id === validId
            ? { task_id: validId, state: "succeeded", attempt: 1, name: "", message: "" }
            : {
                task_id: outcome.task_id,
                state: "failed",
                attempt: 2,
                name: "TypeError",
                message: unstorableResultMessage,
              },
        );
      }
      const completion = fast ? "workhorse.complete_many_and_claim_v1(" : "workhorse.complete_v1(";
      const completed = statements
        .filter((statement) => statement.text.includes(completion))
        .flatMap((statement) => ids.filter((id) => namesTask(statement, id)));
      expect(completed).toEqual([validId]);
    },
  );

  // Only a value the worker refuses becomes a task failure. A database failure during completion
  // still stops the worker, and the worker sends no fail_v1 for it.
  it("still stops the worker on an operational completion error", async () => {
    const queueName = "ts-completion-outage";
    const id = await queue.enqueue("result.outage", {}, { queue: queueName });
    const statements = recordStatements();
    const query = vi.mocked(pool.query).getMockImplementation()!;
    const outage = new Error("connection lost during completion");
    vi.mocked(pool.query).mockImplementation(((...args: unknown[]) => {
      const [first] = args;
      if (typeof first === "string" && first.includes("workhorse.complete_v1(")) {
        statements.push({ text: first, values: [] });
        return Promise.reject(outage);
      }
      return (query as (...inner: unknown[]) => unknown)(...args);
    }) as typeof pool.query);
    const worker = new Worker(queue, { workerId: queueName, queue: queueName }).handle(
      "result.outage",
      () => ({ ok: true }),
    );

    await expect(worker.runOnce()).rejects.toBe(outage);
    expect(statements.some((statement) => statement.text.includes("workhorse.fail_v1("))).toBe(
      false,
    );
    await sleep(0);
    expect(await outcomes(false, [id])).toEqual([]);
  });
});
