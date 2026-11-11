import { describe, expect, it } from "vitest";
import { type Json, Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);

// SM-1930: JSON.stringify wrote NaN and the infinities as null. A payload { amount: NaN } was
// stored as { "amount": null }, and a result { ratio: Infinity } completed its task as
// { "ratio": null }.
describe("non-finite numbers in stored values", () => {
  it("refuses a payload with NaN and stores no task", async () => {
    const enqueue = queue.enqueue("invoice.send", { amount: Number.NaN }, { queue: "ts-nan" });
    await expect(enqueue).rejects.toThrow(
      new TypeError(
        "Payload of task type invoice.send must contain only finite numbers, but $.amount is NaN",
      ),
    );
    const tasks = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workhorse.task WHERE queue_name = 'ts-nan'",
    );
    expect(tasks.rows[0]!.count).toBe("0");
  });

  it("fails the attempt of a result with Infinity and keeps the task retryable", async () => {
    const id = await queue.enqueue(
      "invoice.ratio",
      {},
      { queue: "ts-infinity", maxAttempts: 2, retryPolicy: { type: "fixed", delayMs: 60_000 } },
    );
    const worker = new Worker(queue, {
      workerId: "ts-infinity",
      queue: "ts-infinity",
      registryIntervalMs: 0,
    }).handle("invoice.ratio", () => ({ ratio: Infinity }) as Json);

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(admin.getTask(id)).resolves.toMatchObject({
      // The retry policy schedules the next attempt of the task.
      state: "scheduled",
      currentAttempt: 2,
      error: {
        name: "TypeError",
        message:
          "Result of task type invoice.ratio must contain only finite numbers, but $.ratio is Infinity",
      },
    });
    const attempts = await pool.query<{ outcome: string }>(
      "SELECT outcome FROM workhorse.attempt_history WHERE task_id = $1 ORDER BY attempt",
      [id],
    );
    expect(attempts.rows).toEqual([{ outcome: "retry" }]);
  });
});
