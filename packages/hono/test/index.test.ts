import { Hono } from "hono";
import type { IronshiftAdapter, Queryable, Worker } from "ironshift";
import { Queue as IronshiftQueue } from "ironshift";
import { describe, expect, it, vi } from "vitest";
import { HonoIronshift, serveWithIronshift } from "../src/index.js";

function adapter(overrides: Partial<IronshiftAdapter<{ transaction: true }>> = {}) {
  const queue = new IronshiftQueue({
    query: vi.fn<Queryable["query"]>(),
  } as unknown as Queryable);
  return {
    queue,
    forTransaction: vi.fn<IronshiftAdapter<{ transaction: true }>["forTransaction"]>(() => queue),
    createWorker: vi.fn<IronshiftAdapter<{ transaction: true }>["createWorker"]>(),
    close: vi.fn<() => Promise<void>>(async () => undefined),
    ...overrides,
  } as unknown as IronshiftAdapter<{ transaction: true }>;
}

describe("HonoIronshift", () => {
  it("provides the adapter queue and transaction bridge through typed middleware", async () => {
    const runtimeAdapter = adapter();
    const integration = new HonoIronshift(runtimeAdapter);
    const app = new Hono().use(integration.middleware()).get("/", (context) => {
      const transactional = context.var.ironshift.forTransaction({ transaction: true });
      return context.json({ sameQueue: transactional === context.var.ironshift.queue });
    });

    const response = await app.request("/");

    expect(await response.json()).toEqual({ sameQueue: true });
    expect(runtimeAdapter.forTransaction).toHaveBeenCalledWith({ transaction: true });
  });

  it("starts workers once, stops new claims, drains runs, and closes resources once", async () => {
    let finishRun!: () => void;
    const run = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );
    const stop = vi.fn<() => void>();
    const worker = { run, stop, handle: vi.fn<() => void>() } as unknown as Worker;
    const runtimeAdapter = adapter({ createWorker: vi.fn<() => Worker>(() => worker) });
    const configure = vi.fn<(worker: Worker) => void>();
    const integration = new HonoIronshift(runtimeAdapter, { workers: [{ configure }] });

    integration.start();
    integration.start();
    const stopping = integration.stop();

    expect(configure).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(runtimeAdapter.close).not.toHaveBeenCalled();

    finishRun();
    await Promise.all([stopping, integration.stop()]);
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });

  it("starts an ephemeral Hono server and shuts it down idempotently", async () => {
    const runtimeAdapter = adapter();
    const integration = new HonoIronshift(runtimeAdapter);
    const app = new Hono().get("/health", (context) => context.text("ok"));
    const listening = new Promise<number>((resolve) => {
      void serveWithIronshift({
        fetch: app.fetch,
        ironshift: integration,
        port: 0,
        onListen: (info) => resolve(info.port),
      }).then(async (running) => {
        const port = await listening;
        expect(
          await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.text()),
        ).toBe("ok");
        await Promise.all([running.shutdown(), running.shutdown()]);
      });
    });

    await listening;
    await vi.waitFor(() => expect(runtimeAdapter.close).toHaveBeenCalledTimes(1));
  });

  it("stops already-created workers and closes resources when startup configuration fails", async () => {
    let finishRun!: () => void;
    const worker = {
      run: vi.fn<() => Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            finishRun = resolve;
          }),
      ),
      stop: vi.fn<() => void>(() => finishRun()),
      handle: vi.fn<() => void>(),
    } as unknown as Worker;
    const runtimeAdapter = adapter({ createWorker: vi.fn<() => Worker>(() => worker) });
    const integration = new HonoIronshift(runtimeAdapter, {
      workers: [
        { configure: vi.fn<(worker: Worker) => void>() },
        {
          configure() {
            throw new Error("invalid worker configuration");
          },
        },
      ],
    });
    const app = new Hono();

    await expect(
      serveWithIronshift({ fetch: app.fetch, ironshift: integration, port: 0 }),
    ).rejects.toThrow("invalid worker configuration");

    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(runtimeAdapter.close).toHaveBeenCalledTimes(1);
  });
});
