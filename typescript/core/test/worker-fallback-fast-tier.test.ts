import type { QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { FastTierUnsupportedError, Queue, Worker, type Queryable } from "../src/index.js";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";
import type { HandlerContext } from "../src/worker.js";

// SM-993: a full-tier probe answer sends a worker to claim_many_v1 for the probe interval. If an
// operator moves the queue to the fast tier in that interval, claim_many_v1 returns fast-tier tasks
// with no tier marker. A durable context call must then reject before it runs any user code.

const QUEUE = "fallback";

function result(rows: readonly object[]): QueryResult {
  return { command: "", rowCount: rows.length, oid: 0, fields: [], rows: [...rows] };
}

function claimRow(id: string): object {
  return {
    task_id: id,
    task_type: "effect",
    priority: 0,
    payload: null,
    contract_version: null,
    result_max_bytes: 1_048_576,
    redact_error_details: false,
    trace_context: null,
    attempt: 1,
    max_attempts: 1,
    retry_policy: null,
    deadline_at: null,
    execution_timeout_ms: null,
    attempt_timeout_at: null,
    fence_token: "1",
    lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
  };
}

// PostgreSQL's answer when the fused fast-tier statement meets a full-tier queue.
function fullTierRejection(): Error {
  return Object.assign(new Error("queue is full-tier"), {
    code: "P1007",
    detail: JSON.stringify({ queue: QUEUE, feature: "fast claims" }),
  });
}

interface FakeDatabaseOptions {
  // Answers the tier read. A thrown error fails that read.
  tier: () => "fast" | "full";
  claimed?: readonly string[];
}

// Answers the fast probe as full tier, then returns `claimed` once from claim_many_v1.
function fakeDatabase(options: FakeDatabaseOptions) {
  const statements: string[] = [];
  let pending = [...(options.claimed ?? ["fast-task"])];
  const query = (async (text: string) => {
    statements.push(text);
    if (text === SQL_STATEMENTS.complete_many_and_claim_v1) {
      if (statements.filter((entry) => entry === text).length === 1) throw fullTierRejection();
      return result([{ accepted: [], task_id: null }]);
    }
    if (text === SQL_STATEMENTS.claim_many_v1) {
      const rows = pending.map(claimRow);
      pending = [];
      return result(rows);
    }
    if (text === SQL_STATEMENTS.queue_control) {
      return result([
        {
          queue_name: QUEUE,
          paused: false,
          tier: options.tier(),
          record_attempts: false,
          record_claims: false,
        },
      ]);
    }
    if (text === SQL_STATEMENTS.complete_v1) return result([{ accepted: true }]);
    if (text === SQL_STATEMENTS.fail_v1) return result([{ status: "failed" }]);
    return result([]);
  }) as Queryable["query"];
  const count = (statement: string): number =>
    statements.filter((entry) => entry === statement).length;
  return { database: { query } satisfies Queryable, statements, count };
}

function fallbackWorker(database: Queryable): Worker {
  return new Worker(new Queue(database, QUEUE), {
    queues: [QUEUE],
    sharedHeartbeats: true,
    registryIntervalMs: 0,
  });
}

async function runOnce(
  database: Queryable,
  handler: (payload: unknown, context: HandlerContext) => Promise<unknown>,
): Promise<Worker> {
  const worker = fallbackWorker(database).handle("effect", handler as never);
  await worker.runOnce();
  return worker;
}

// Runs one claimed task whose handler makes `call`, and returns what that call rejected with.
async function rejectionOf(
  fake: ReturnType<typeof fakeDatabase>,
  call: (context: HandlerContext) => Promise<unknown>,
): Promise<unknown> {
  let rejection: unknown;
  await runOnce(fake.database, async (_payload, context) => {
    await call(context).catch((error: unknown) => {
      rejection = error;
    });
    return null;
  });
  return rejection;
}

describe("worker fallback claims from a queue that became fast-tier", () => {
  it("rejects a checkpoint before its callback runs and before any checkpoint write", async () => {
    const fake = fakeDatabase({ tier: () => "fast" });
    let callbacks = 0;
    let rejection: unknown;

    await runOnce(fake.database, async (_payload, context) => {
      try {
        await context.checkpoint("effect", async () => {
          callbacks += 1;
          return "done";
        });
      } catch (error) {
        rejection = error;
        throw error;
      }
      return null;
    });

    expect(fake.count(SQL_STATEMENTS.claim_many_v1)).toBe(1);
    expect(rejection).toBeInstanceOf(FastTierUnsupportedError);
    expect(rejection).toMatchObject({ queue: QUEUE, feature: "checkpoints" });
    expect(callbacks).toBe(0);
    expect(fake.count(SQL_STATEMENTS.save_checkpoint_v1)).toBe(0);
    expect(fake.count(SQL_STATEMENTS.list_checkpoints)).toBe(0);
  });

  it.each([
    ["setProgress", "progress", (context: HandlerContext) => context.setProgress({ step: 1 })],
    ["sleep", "durable waits", (context: HandlerContext) => context.sleep("nap", 1_000)],
    [
      "sleepUntil",
      "durable waits",
      (context: HandlerContext) => context.sleepUntil("nap", new Date(Date.now() + 1_000)),
    ],
    ["waitForSignal", "signal waits", (context: HandlerContext) => context.waitForSignal("go")],
    ["waitForHuman", "human waits", (context: HandlerContext) => context.waitForHuman("ok", {})],
    ["runChild", "child tasks", (context: HandlerContext) => context.runChild("c", "effect", null)],
    [
      "runChildren",
      "child tasks",
      (context: HandlerContext) =>
        context.runChildren([{ name: "c", type: "effect", payload: null }]),
    ],
    [
      "runChildrenAll",
      "child tasks",
      (context: HandlerContext) =>
        context.runChildrenAll([{ name: "c", type: "effect", payload: null }]),
    ],
  ])("rejects %s with feature %s before any write", async (_name, feature, call) => {
    const fake = fakeDatabase({ tier: () => "fast" });

    const rejection = await rejectionOf(fake, call);

    expect(rejection).toBeInstanceOf(FastTierUnsupportedError);
    expect(rejection).toMatchObject({ queue: QUEUE, feature });
    const reads = new Set<string>([
      SQL_STATEMENTS.complete_many_and_claim_v1,
      SQL_STATEMENTS.claim_many_v1,
      SQL_STATEMENTS.queue_control,
      SQL_STATEMENTS.complete_v1,
      SQL_STATEMENTS.tick_v1,
      SQL_STATEMENTS.run_maintenance_v1,
    ]);
    expect(fake.statements.filter((statement) => !reads.has(statement))).toEqual([]);
  });

  it("rejects a batch member's durable calls", async () => {
    const fake = fakeDatabase({ tier: () => "fast" });
    const rejections: unknown[] = [];
    const worker = fallbackWorker(fake.database).handleBatch(
      "effect",
      { maxSize: 1, lingerMs: 0 },
      async (items) => {
        for (const { context } of items) {
          await context.setProgress({ step: 1 }).catch((error: unknown) => rejections.push(error));
          await context
            .checkpoint("effect", () => "done")
            .catch((error: unknown) => rejections.push(error));
        }
        return items.map(() => ({ status: "succeeded" as const, result: null }));
      },
    );

    await worker.runOnce();

    expect(rejections).toHaveLength(2);
    expect(rejections[0]).toMatchObject({ feature: "progress" });
    expect(rejections[1]).toMatchObject({ feature: "checkpoints" });
    expect(rejections.every((error) => error instanceof FastTierUnsupportedError)).toBe(true);
    expect(fake.count(SQL_STATEMENTS.update_progress_v1)).toBe(0);
    expect(fake.count(SQL_STATEMENTS.save_checkpoint_v1)).toBe(0);
  });

  it("shares one tier read across the tasks of a claim and concurrent calls", async () => {
    const fake = fakeDatabase({ tier: () => "fast", claimed: ["first", "second"] });
    let rejections = 0;

    await runOnce(fake.database, async (_payload, context) => {
      const calls = [context.setProgress({ step: 1 }), context.checkpoint("a", () => "done")];
      for (const outcome of await Promise.allSettled(calls)) {
        if (outcome.status === "rejected") rejections += 1;
      }
      return null;
    });

    expect(fake.count(SQL_STATEMENTS.claim_many_v1)).toBe(1);
    expect(rejections).toBe(4);
    expect(fake.count(SQL_STATEMENTS.queue_control)).toBe(1);
  });

  it("reads the tier again after a failed read, and writes nothing", async () => {
    let reads = 0;
    const fake = fakeDatabase({
      tier: () => {
        reads += 1;
        if (reads === 1) throw new Error("tier read failed");
        return "fast";
      },
    });
    const rejections: unknown[] = [];

    await runOnce(fake.database, async (_payload, context) => {
      for (let call = 0; call < 2; call += 1) {
        await context
          .checkpoint("effect", () => "done")
          .catch((error: unknown) => rejections.push(error));
      }
      return null;
    });

    expect(reads).toBe(2);
    expect(rejections[0]).toMatchObject({ message: "tier read failed" });
    expect(rejections[1]).toBeInstanceOf(FastTierUnsupportedError);
    expect(fake.count(SQL_STATEMENTS.save_checkpoint_v1)).toBe(0);
    expect(fake.count(SQL_STATEMENTS.list_checkpoints)).toBe(0);
  });

  it("reads no tier for a handler without a durable call", async () => {
    const fake = fakeDatabase({ tier: () => "fast" });

    await runOnce(fake.database, async () => "done");

    expect(fake.count(SQL_STATEMENTS.queue_control)).toBe(0);
    expect(fake.count(SQL_STATEMENTS.complete_v1)).toBe(1);
  });

  it("runs a checkpoint when the queue is still full-tier", async () => {
    const fake = fakeDatabase({ tier: () => "full" });
    let callbacks = 0;

    await runOnce(fake.database, async (_payload, context) => {
      await context.checkpoint("effect", () => {
        callbacks += 1;
        return "done";
      });
      return null;
    });

    expect(callbacks).toBe(1);
    expect(fake.count(SQL_STATEMENTS.list_checkpoints)).toBe(1);
    expect(fake.count(SQL_STATEMENTS.save_checkpoint_v1)).toBe(1);
  });

  it("ends the probe interval when the read answers fast", async () => {
    const fake = fakeDatabase({ tier: () => "fast" });
    const worker = await runOnce(fake.database, async (_payload, context) => {
      await context.setProgress({ step: 1 }).catch(() => undefined);
      return null;
    });

    await worker.runOnce();

    expect(fake.count(SQL_STATEMENTS.complete_many_and_claim_v1)).toBe(2);
    expect(fake.count(SQL_STATEMENTS.claim_many_v1)).toBe(1);
  });

  it("keeps claiming through claim_many_v1 when the read answers full", async () => {
    const fake = fakeDatabase({ tier: () => "full" });
    const worker = await runOnce(fake.database, async (_payload, context) => {
      await context.setProgress({ step: 1 });
      return null;
    });

    await worker.runOnce();

    expect(fake.count(SQL_STATEMENTS.complete_many_and_claim_v1)).toBe(1);
    expect(fake.count(SQL_STATEMENTS.claim_many_v1)).toBe(2);
  });
});
