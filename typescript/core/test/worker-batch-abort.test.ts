import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "../src/types.js";
import {
  Worker,
  type BatchHandler,
  type Handler,
  type HandlerContext,
  type WorkerQueueApi,
} from "../src/worker.js";

// SM-1669 TS-12: a batch member whose signal aborted while it waited stayed in the batch. The
// callback then got a task that this worker no longer owned, and the member settled only after the
// linger timer.

const queue = { defaultQueue: "default" } as unknown as WorkerQueueApi;

function batchAdapter(handler: BatchHandler, lingerMs = 1_000, workerQueue = queue) {
  const worker = new Worker(workerQueue, { concurrency: 4, registryIntervalMs: 0 }).handleBatch(
    "batch",
    { maxSize: 4, lingerMs },
    handler,
  );
  return (worker as unknown as { handlers: Map<string, Handler> }).handlers.get("batch")!;
}

function member(id: string, priority = 0) {
  const controller = new AbortController();
  const context = {
    task: { id, queue: "default", priority },
    signal: controller.signal,
  } as unknown as HandlerContext<Json>;
  return { controller, context, signal: controller.signal };
}

const succeedAll: BatchHandler = (items) =>
  items.map(({ context }) => ({ status: "succeeded" as const, result: context.task.id }));

describe("batch members whose signal aborts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes an aborted member at once and keeps the order of its peers", async () => {
    const handler = vi.fn<BatchHandler>(succeedAll);
    const adapter = batchAdapter(handler);
    const first = member("first");
    const aborted = member("aborted");
    const last = member("last");
    const firstResult = adapter("first", first.context);
    const abortedResult = adapter("aborted", aborted.context);
    const lastResult = adapter("last", last.context);

    const reason = new Error("lease lost");
    aborted.controller.abort(reason);

    // The member settles before the linger timer fires, and its listener is gone.
    await expect(abortedResult).rejects.toBe(reason);
    expect(getEventListeners(aborted.signal, "abort")).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(handler).toHaveBeenCalledTimes(1);
    const ids = handler.mock.calls[0]![0].map(({ context }) => context.task.id);
    expect(ids).toEqual(["first", "last"]);
    await expect(firstResult).resolves.toBe("first");
    await expect(lastResult).resolves.toBe("last");
  });

  it("clears the linger timer when the last waiting member aborts", async () => {
    const handler = vi.fn<BatchHandler>(succeedAll);
    const adapter = batchAdapter(handler);
    const only = member("only");
    const result = adapter("only", only.context);
    expect(vi.getTimerCount()).toBe(1);

    only.controller.abort(new Error("cancel requested"));

    await expect(result).rejects.toThrow("cancel requested");
    expect(vi.getTimerCount()).toBe(0);

    // A later member starts a new linger window and dispatches alone.
    const next = member("next");
    const nextResult = adapter("next", next.context);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toHaveLength(1);
    await expect(nextResult).resolves.toBe("next");
  });

  it("never admits a member whose signal aborted before it arrived", async () => {
    const handler = vi.fn<BatchHandler>(succeedAll);
    const adapter = batchAdapter(handler, 0);
    const late = member("late");
    late.controller.abort(new Error("cancel requested"));

    await expect(adapter("late", late.context)).rejects.toThrow("cancel requested");

    expect(handler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives the callback a member that aborts after selection, during the evidence write", async () => {
    let finishEvidence!: () => void;
    const evidence = new Promise<void>((resolve) => {
      finishEvidence = resolve;
    });
    const evidenceQueue = {
      defaultQueue: "default",
      recordBatchDispatch: () => evidence,
    } as unknown as WorkerQueueApi;
    const handler = vi.fn<BatchHandler>(succeedAll);
    const adapter = batchAdapter(handler, 0, evidenceQueue);
    const selected = member("selected");
    const result = adapter("selected", selected.context);

    // The coordinator selected the member and waits for the evidence write.
    expect(getEventListeners(selected.signal, "abort")).toHaveLength(0);
    selected.controller.abort(new Error("lease lost"));
    finishEvidence();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0][0]!.context.signal.aborted).toBe(true);
    await expect(result).resolves.toBe("selected");
  });

  it("leaves a dispatched member to the callback when its signal aborts later", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn<BatchHandler>(async (items) => {
      await released;
      return succeedAll(items);
    });
    const adapter = batchAdapter(handler, 0);
    const dispatched = member("dispatched");
    const result = adapter("dispatched", dispatched.context);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getEventListeners(dispatched.signal, "abort")).toHaveLength(0);

    dispatched.controller.abort(new Error("lease lost"));
    release();

    // The callback owns the outcome after dispatch, and the worker's lease path reads the signal.
    await expect(result).resolves.toBe("dispatched");
  });
});
