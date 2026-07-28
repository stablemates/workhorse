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
    });

    const transactionalQueue = adapter.forTransaction(transaction);

    expect(adapter.queue.defaultQueue).toBe("mail");
    expect(transactionalQueue.defaultQueue).toBe("mail");
    expect(adaptTransaction).toHaveBeenCalledWith(transaction);
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
});
