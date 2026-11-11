import { describe, expect, it } from "vitest";
import { Worker } from "../src/index.js";
import { abortWorkerHandlers } from "../src/worker-failure.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);

// SM-1970 (ADR 0120): run() forgot a stop() that came before the call, and ran until a later
// stop(). runOnce() kept that stop for each later call until a run() cleared it.

function reportWorker(name: string): { worker: Worker; handled: string[] } {
  const handled: string[] = [];
  const worker = new Worker(queue, {
    workerId: name,
    queue: name,
    registryIntervalMs: 0,
  }).handle("report.render", (payload) => {
    handled.push((payload as { report: string }).report);
    // The run() test stops the worker from its handler, so the run ends after this task.
    if (stopFromHandler.has(worker)) worker.stop();
    return { rendered: true };
  });
  return { worker, handled };
}

const stopFromHandler = new WeakSet<Worker>();

async function attempts(taskId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM workhorse.attempt_history WHERE task_id = $1",
    [taskId],
  );
  return Number(result.rows[0]!.count);
}

describe("a stop() before a worker call", () => {
  it("ends the next run() at once with no claim, and the run after it starts normally", async () => {
    const { worker, handled } = reportWorker("ts-stop-before-run");
    const id = await queue.enqueue(
      "report.render",
      { report: "march" },
      {
        queue: "ts-stop-before-run",
      },
    );

    worker.stop();
    await expect(worker.run()).resolves.toBeUndefined();
    expect(handled).toEqual([]);
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "ready" });
    await expect(attempts(id)).resolves.toBe(0);

    stopFromHandler.add(worker);
    await expect(worker.run()).resolves.toBeUndefined();
    expect(handled).toEqual(["march"]);
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("ends the next runOnce() at once with no claim, and the call after it starts normally", async () => {
    const { worker, handled } = reportWorker("ts-stop-before-run-once");
    const id = await queue.enqueue(
      "report.render",
      { report: "april" },
      {
        queue: "ts-stop-before-run-once",
      },
    );

    worker.stop();
    await expect(worker.runOnce()).resolves.toBe(false);
    expect(handled).toEqual([]);
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "ready" });
    await expect(attempts(id)).resolves.toBe(0);

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(handled).toEqual(["april"]);
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("ends a run() that the stop() follows before its loop starts, and only that run", async () => {
    const { worker, handled } = reportWorker("ts-stop-after-run-call");
    const id = await queue.enqueue(
      "report.render",
      { report: "may" },
      {
        queue: "ts-stop-after-run-call",
      },
    );

    const run = worker.run();
    worker.stop();
    await expect(run).resolves.toBeUndefined();
    expect(handled).toEqual([]);
    await expect(attempts(id)).resolves.toBe(0);

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(handled).toEqual(["may"]);
  });

  it("ends a runOnce() that the stop() follows before its claim, and only that call", async () => {
    const { worker, handled } = reportWorker("ts-stop-after-run-once-call");
    await queue.enqueue(
      "report.render",
      { report: "june" },
      {
        queue: "ts-stop-after-run-once-call",
      },
    );

    const pass = worker.runOnce();
    worker.stop();
    await expect(pass).resolves.toBe(false);
    expect(handled).toEqual([]);

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(handled).toEqual(["june"]);
  });

  // A runOnce() after a stopped run starts normally, so it must not keep the shutdown abort of that
  // run. Before, it claimed the task and released it without a handler run.
  it("runs the handler in a runOnce() after a run that a shutdown abort ended", async () => {
    const handled: string[] = [];
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = new Worker(queue, {
      workerId: "ts-run-once-after-shutdown",
      queue: "ts-run-once-after-shutdown",
      registryIntervalMs: 0,
    }).handle("report.render", async (payload, context) => {
      const { report } = payload as { report: string };
      if (report === "june") {
        // The first task waits for the shutdown abort of the run.
        started();
        await new Promise((resolve) => {
          context.signal.addEventListener("abort", resolve);
        });
        throw new Error("aborted");
      }
      handled.push(report);
      return { rendered: true };
    });
    await queue.enqueue(
      "report.render",
      { report: "june" },
      { queue: "ts-run-once-after-shutdown" },
    );
    const run = worker.run();
    await handlerStarted;
    worker.stop();
    abortWorkerHandlers(worker);
    await expect(run).resolves.toBeUndefined();
    const id = await queue.enqueue(
      "report.render",
      { report: "july" },
      {
        queue: "ts-run-once-after-shutdown",
        priority: 10,
      },
    );

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(handled).toEqual(["july"]);
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "succeeded" });
  });
});
