import { describe, expect, it } from "vitest";
import { Worker } from "../src/index.js";
import { UNCONVERTIBLE_THROWN_VALUE_TEXT } from "../src/queue/claim-lease-fence.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { queue, admin } = createIntegrationTestContext(import.meta.url);

// SM-1940: the worker converted a thrown value that is not an Error with String(). If its toString
// threw, the conversion error left the settlement, the worker stopped, and run() rejected. The
// attempt got no fail_v1 write.
describe("a thrown value whose conversion to text throws", () => {
  it("fails the attempt with NonErrorThrown and the worker runs the next task", async () => {
    const options = { queue: "ts-thrown-values", maxAttempts: 1 };
    const failing = await queue.enqueue(
      "report.render",
      { kind: "failing" },
      {
        ...options,
        priority: 10,
      },
    );
    const next = await queue.enqueue("report.render", { kind: "next" }, options);
    let nextHandled!: () => void;
    const handledNext = new Promise<void>((resolve) => {
      nextHandled = resolve;
    });
    const worker = new Worker(queue, {
      workerId: "ts-thrown-values",
      queue: "ts-thrown-values",
      concurrency: 1,
      registryIntervalMs: 0,
    }).handle("report.render", (payload) => {
      if ((payload as { kind: string }).kind === "failing") {
        // Concurrency 1 and the higher priority make this task settle before the next claim.
        throw {
          toString() {
            throw new Error("conversion exploded");
          },
        };
      }
      nextHandled();
      return { rendered: true };
    });

    const run = worker.run();
    // If the worker stops, run() settles first and the race reports it.
    await Promise.race([handledNext, run.then(() => Promise.reject(new Error("run() ended")))]);
    worker.stop();
    await expect(run).resolves.toBeUndefined();

    await expect(admin.getTask(failing)).resolves.toMatchObject({
      state: "failed",
      error: { name: "NonErrorThrown", message: UNCONVERTIBLE_THROWN_VALUE_TEXT, stack: null },
    });
    await expect(admin.getTask(next)).resolves.toMatchObject({
      state: "succeeded",
      result: { rendered: true },
    });
  });

  // A revoked proxy threw on the instanceof checks of the settlement, before the formatters ran.
  it("fails the attempt of a thrown revoked proxy and the worker runs the next task", async () => {
    const options = { queue: "ts-thrown-proxy", maxAttempts: 1 };
    const failing = await queue.enqueue(
      "report.render",
      { kind: "failing" },
      {
        ...options,
        priority: 10,
      },
    );
    const next = await queue.enqueue("report.render", { kind: "next" }, options);
    let nextHandled!: () => void;
    const handledNext = new Promise<void>((resolve) => {
      nextHandled = resolve;
    });
    const worker = new Worker(queue, {
      workerId: "ts-thrown-proxy",
      queue: "ts-thrown-proxy",
      concurrency: 1,
      registryIntervalMs: 0,
    }).handle("report.render", (payload) => {
      if ((payload as { kind: string }).kind === "failing") {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        throw proxy;
      }
      nextHandled();
      return { rendered: true };
    });

    const run = worker.run();
    await Promise.race([handledNext, run.then(() => Promise.reject(new Error("run() ended")))]);
    worker.stop();
    await expect(run).resolves.toBeUndefined();

    await expect(admin.getTask(failing)).resolves.toMatchObject({
      state: "failed",
      error: { name: "NonErrorThrown", message: UNCONVERTIBLE_THROWN_VALUE_TEXT, stack: null },
    });
    await expect(admin.getTask(next)).resolves.toMatchObject({ state: "succeeded" });
  });
});
