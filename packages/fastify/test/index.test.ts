import Fastify, { type FastifyRequest } from "fastify";
import type { Queryable, Worker, WorkhorseAdapter } from "@workhorse/core";
import { Queue as WorkhorseQueue } from "@workhorse/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { FastifyWorkhorse, registerWorkhorse } from "../src/index.js";

function adapter(overrides: Partial<WorkhorseAdapter<{ transaction: true }>> = {}) {
  const database = { query: vi.fn<Queryable["query"]>() } as unknown as Queryable;
  const queue = new WorkhorseQueue(database);
  return {
    database,
    queue,
    forTransaction: vi.fn<WorkhorseAdapter<{ transaction: true }>["forTransaction"]>(() => queue),
    createWorker: vi.fn<WorkhorseAdapter<{ transaction: true }>["createWorker"]>(),
    close: vi.fn<() => Promise<void>>(async () => undefined),
    ...overrides,
  } as unknown as WorkhorseAdapter<{ transaction: true }>;
}

describe("FastifyWorkhorse", () => {
  it("provides the adapter queue and transaction bridge through request context", async () => {
    const runtimeAdapter = adapter();
    const integration = new FastifyWorkhorse(runtimeAdapter);
    expectTypeOf(integration.contextFor({} as FastifyRequest).forTransaction)
      .parameter(0)
      .toEqualTypeOf<{ transaction: true }>();
    const app = Fastify();
    await registerWorkhorse(app, integration);
    app.get("/", (request) => ({
      sameQueue:
        integration.contextFor(request).forTransaction({ transaction: true }) ===
        request.workhorse.queue,
    }));

    expect((await app.inject("/")).json()).toEqual({ sameQueue: true });
    expect(runtimeAdapter.forTransaction).toHaveBeenCalledWith({ transaction: true });
    await app.close();
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });

  it("starts workers when Fastify becomes ready and drains them before close", async () => {
    let finishRun!: () => void;
    const worker = {
      run: vi.fn<() => Promise<void>>(() => new Promise<void>((resolve) => (finishRun = resolve))),
      stop: vi.fn<() => void>(() => finishRun()),
      handle: vi.fn<() => void>(),
    } as unknown as Worker;
    const runtimeAdapter = adapter({ createWorker: vi.fn<() => Worker>(() => worker) });
    const integration = new FastifyWorkhorse(runtimeAdapter, {
      workers: [{ configure: vi.fn<(worker: Worker) => void>() }],
    });
    const app = Fastify();
    await registerWorkhorse(app, integration);

    await app.ready();
    expect(worker.run).toHaveBeenCalledTimes(1);
    await Promise.all([app.close(), app.close()]);
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up workers and resources when startup configuration fails", async () => {
    const worker = {
      run: vi.fn<() => Promise<void>>(async () => undefined),
      stop: vi.fn<() => void>(),
      handle: vi.fn<() => void>(),
    } as unknown as Worker;
    const runtimeAdapter = adapter({ createWorker: vi.fn<() => Worker>(() => worker) });
    const integration = new FastifyWorkhorse(runtimeAdapter, {
      workers: [
        { configure: vi.fn<(worker: Worker) => void>() },
        {
          configure: () => {
            throw new Error("invalid worker configuration");
          },
        },
      ],
    });
    const app = Fastify();
    await registerWorkhorse(app, integration);

    await expect(app.ready()).rejects.toThrow("invalid worker configuration");
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });
});
