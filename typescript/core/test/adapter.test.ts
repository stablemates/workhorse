import { describe, expect, it, vi } from "vitest";
import { createWorkhorseAdapter } from "../src/adapter.js";
import type { Queryable } from "../src/types.js";

function queryable(): Queryable {
  return { query: vi.fn<Queryable["query"]>() } as unknown as Queryable;
}

describe("createWorkhorseAdapter", () => {
  it("creates queues for provider-owned transactions without changing the default queue", async () => {
    const database = queryable();
    const transactionDatabase = queryable();
    const transaction = { id: "tx" };
    const adaptTransaction = vi.fn<(transaction: { id: string }) => Queryable>(
      () => transactionDatabase,
    );
    const adapter = createWorkhorseAdapter<{ id: string }>({
      database,
      adaptTransaction,
      defaultQueue: "mail",
      queueOptions: {
        contracts: {
          send: {
            currentVersion: "current",
            versions: { current: { payloadSchema: false } },
          },
        },
      },
    });

    const transactionalQueue = adapter.forTransaction(transaction);

    expect(adapter.queue.defaultQueue).toBe("mail");
    expect(transactionalQueue.defaultQueue).toBe("mail");
    expect(adaptTransaction).toHaveBeenCalledWith(transaction);
    await expect(transactionalQueue.enqueue("send", null)).rejects.toThrow(
      "send payload does not satisfy contract version current",
    );
    expect(transactionDatabase.query).not.toHaveBeenCalled();
  });

  it("creates workers from the shared queue and closes provider resources once", async () => {
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const adapter = createWorkhorseAdapter({
      database: queryable(),
      adaptTransaction: (transaction: Queryable) => transaction,
      close,
    });

    const worker = adapter.createWorker({ workerId: "adapter-test" });
    expect(worker).toBeDefined();

    await Promise.all([adapter.close(), adapter.close()]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("defaults worker concurrency to one and exposes synchronous runtime state", () => {
    const adapter = createWorkhorseAdapter({
      database: queryable(),
      adaptTransaction: (transaction: Queryable) => transaction,
    });

    const worker = adapter.createWorker();

    expect(worker.concurrency).toBe(1);
    expect(worker.runtimeState()).toEqual({
      concurrency: 1,
      activeSlots: 0,
      paused: false,
      locallyPaused: false,
      remotelyPaused: false,
      draining: false,
    });
    worker.pause();
    expect(worker.isPaused()).toBe(true);
    expect(worker.runtimeState()).toMatchObject({ paused: true, draining: false });
  });

  it.each([0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects invalid worker concurrency %s",
    (concurrency) => {
      const adapter = createWorkhorseAdapter({
        database: queryable(),
        adaptTransaction: (transaction: Queryable) => transaction,
      });

      expect(() => adapter.createWorker({ concurrency })).toThrow(
        "concurrency must be a safe integer between 1 and 100",
      );
    },
  );

  it.each([1, 100])("accepts worker concurrency boundary %s", (concurrency) => {
    const adapter = createWorkhorseAdapter({
      database: queryable(),
      adaptTransaction: (transaction: Queryable) => transaction,
    });

    expect(adapter.createWorker({ concurrency }).runtimeState()).toMatchObject({ concurrency });
  });
});
