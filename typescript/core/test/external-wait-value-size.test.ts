import { describe, expect, it } from "vitest";
import { createHandlerContext } from "../src/handler-context.js";
import { jsonbTextBytes } from "../src/queue/enqueue-contracts.js";
import { Queue } from "../src/queue.js";
import type { TaskAttempt } from "../src/task-attempt.js";
import type { ClaimedTask, Json, Queryable } from "../src/types.js";
import type { WorkerQueueApi } from "../src/worker.js";
import { MAX_EXTERNAL_WAIT_VALUE_BYTES } from "../src/types.js";

// Compact JSON writes 30,000 zeros in 60,001 bytes. PostgreSQL's jsonb text puts a space after each
// comma, so it writes the same array in 90,000 bytes, which is above the limit.
const zeros = Array.from({ length: 30_000 }, () => 0);

function refusingQueue(): { queue: Queue; statements: string[] } {
  const statements: string[] = [];
  const database = {
    async query(sql: string) {
      statements.push(sql);
      throw new Error("the size check must refuse the value before a statement runs");
    },
  } as unknown as Queryable;
  return { queue: new Queue(database), statements };
}

describe("external wait value size", () => {
  it("measures the value as jsonb text, not as compact JSON", () => {
    expect(Buffer.byteLength(JSON.stringify(zeros))).toBeLessThan(MAX_EXTERNAL_WAIT_VALUE_BYTES);
  });

  it("refuses a signal payload whose jsonb text exceeds the limit before a statement runs", async () => {
    const { queue, statements } = refusingQueue();
    await expect(
      queue.sendSignal("00000000-0000-4000-8000-000000000001", "approval", zeros, {
        idempotencyKey: "oversized",
        requestedBy: "approval-service",
      }),
    ).rejects.toThrow(new RangeError("Signal payload must be at most 65536 bytes"));
    expect(statements).toEqual([]);
  });

  it("refuses a human wait context and result whose jsonb text exceeds the limit", async () => {
    const { queue, statements } = refusingQueue();
    const task = {
      id: "00000000-0000-4000-8000-000000000001",
      fenceToken: 1n,
    } as unknown as ClaimedTask;
    await expect(queue.waitForHuman(task, "worker", "review", zeros)).rejects.toThrow(
      new RangeError("Human wait context must be at most 65536 bytes"),
    );
    await expect(
      queue.completeHumanWait(task.id, "review", zeros, {
        idempotencyKey: "oversized-result",
        requestedBy: "operator",
      }),
    ).rejects.toThrow(new RangeError("Human wait result must be at most 65536 bytes"));
    expect(statements).toEqual([]);
  });

  it("measures a deeply nested value without a stack overflow", () => {
    // JSON.stringify overflows the stack at a depth that depends on the environment, so the test
    // gives the parsed value to the measure itself. PostgreSQL writes it in 200,001 bytes.
    let deep: Json = 0;
    for (let level = 0; level < 100_000; level += 1) deep = [deep];
    expect(jsonbTextBytes(deep)).toBe(200_001);
  });

  it("refuses a human wait context before the worker reads the queue tier", async () => {
    const task = {
      id: "00000000-0000-4000-8000-000000000001",
      queue: "default",
      fenceToken: 1n,
    } as unknown as ClaimedTask;
    // The tier read can query PostgreSQL, so the size check must run before it.
    const context = createHandlerContext(
      {} as WorkerQueueApi,
      "worker",
      task,
      {} as TaskAttempt,
      () => Promise.reject(new Error("the tier read must not run")),
    );
    await expect(context.waitForHuman("review", zeros)).rejects.toThrow(
      new RangeError("Human wait context must be at most 65536 bytes"),
    );
  });
});
