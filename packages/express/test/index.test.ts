import express, { type Request } from "express";
import type { Queryable, Worker, WorkhorseAdapter } from "@workhorse/core";
import { Queue as WorkhorseQueue } from "@workhorse/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { ExpressWorkhorse, serveWithWorkhorse } from "../src/index.js";

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

describe("ExpressWorkhorse", () => {
  it("provides the adapter queue and transaction bridge through middleware", async () => {
    const runtimeAdapter = adapter();
    const integration = new ExpressWorkhorse(runtimeAdapter);
    expectTypeOf(integration.contextFor({} as Request).forTransaction)
      .parameter(0)
      .toEqualTypeOf<{ transaction: true }>();
    const app = express()
      .use(integration.middleware())
      .get("/", (request, response) => {
        const transactional = integration.contextFor(request).forTransaction({ transaction: true });
        response.json({ sameQueue: transactional === request.workhorse.queue });
      });

    const running = await serveWithWorkhorse({ app, workhorse: integration, port: 0 });
    const address = running.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
    expect(
      await fetch(`http://127.0.0.1:${address.port}`).then((response) => response.json()),
    ).toEqual({
      sameQueue: true,
    });
    expect(runtimeAdapter.forTransaction).toHaveBeenCalledWith({ transaction: true });
    await running.shutdown();
  });

  it("starts workers once, drains them, and closes resources once", async () => {
    let finishRun!: () => void;
    const worker = {
      run: vi.fn<() => Promise<void>>(() => new Promise<void>((resolve) => (finishRun = resolve))),
      stop: vi.fn<() => void>(),
      handle: vi.fn<() => void>(),
    } as unknown as Worker;
    const runtimeAdapter = adapter({ createWorker: vi.fn<() => Worker>(() => worker) });
    const integration = new ExpressWorkhorse(runtimeAdapter, {
      workers: [{ configure: vi.fn<(worker: Worker) => void>() }],
    });

    integration.start();
    integration.start();
    const stopping = integration.stop();
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(runtimeAdapter.close).not.toHaveBeenCalled();
    finishRun();
    await Promise.all([stopping, integration.stop()]);
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });

  it("shuts its server and runtime down idempotently", async () => {
    const runtimeAdapter = adapter();
    const integration = new ExpressWorkhorse(runtimeAdapter);
    const running = await serveWithWorkhorse({
      app: express().get("/health", (_request, response) => response.send("ok")),
      workhorse: integration,
      port: 0,
    });

    await Promise.all([running.shutdown(), running.shutdown()]);
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });

  it("closes adapter resources when HTTP server closure fails", async () => {
    const runtimeAdapter = adapter();
    const integration = new ExpressWorkhorse(runtimeAdapter);
    const running = await serveWithWorkhorse({ app: express(), workhorse: integration, port: 0 });
    await new Promise<void>((resolve, reject) => {
      running.server.close((error) => (error ? reject(error) : resolve()));
    });

    await expect(running.shutdown()).rejects.toThrow("Server is not running");
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });

  it("waits for HTTP drain before closing resources when worker drain fails", async () => {
    let failRun!: () => void;
    const worker = {
      run: vi.fn<() => Promise<void>>(
        () =>
          new Promise<void>(
            (_resolve, reject) => (failRun = () => reject(new Error("run failed"))),
          ),
      ),
      stop: vi.fn<() => void>(() => failRun()),
      handle: vi.fn<() => void>(),
    } as unknown as Worker;
    const runtimeAdapter = adapter({ createWorker: vi.fn<() => Worker>(() => worker) });
    const integration = new ExpressWorkhorse(runtimeAdapter, {
      workers: [{ configure: vi.fn<(worker: Worker) => void>() }],
      onWorkerError: () => {
        throw new Error("worker error observer failed");
      },
    });
    let finishRequest: (() => void) | undefined;
    const app = express().get("/", (_request, response) => {
      finishRequest = () => response.send("ok");
    });
    const running = await serveWithWorkhorse({ app, workhorse: integration, port: 0 });
    const address = running.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
    const request = fetch(`http://127.0.0.1:${address.port}`);
    await vi.waitFor(() => expect(finishRequest).toBeTypeOf("function"));

    const shutdown = running.shutdown();
    await vi.waitFor(() => expect(worker.stop).toHaveBeenCalledTimes(1));
    expect(runtimeAdapter.close).not.toHaveBeenCalled();
    finishRequest!();

    await expect(shutdown).rejects.toThrow("worker error observer failed");
    expect(await request.then((response) => response.text())).toBe("ok");
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up workers and resources when startup configuration fails", async () => {
    const worker = {
      run: vi.fn<() => Promise<void>>(async () => undefined),
      stop: vi.fn<() => void>(),
      handle: vi.fn<() => void>(),
    } as unknown as Worker;
    const runtimeAdapter = adapter({ createWorker: vi.fn<() => Worker>(() => worker) });
    const integration = new ExpressWorkhorse(runtimeAdapter, {
      workers: [
        { configure: vi.fn<(worker: Worker) => void>() },
        {
          configure: () => {
            throw new Error("invalid worker configuration");
          },
        },
      ],
    });

    await expect(
      serveWithWorkhorse({ app: express(), workhorse: integration, port: 0 }),
    ).rejects.toThrow("invalid worker configuration");
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });
});
