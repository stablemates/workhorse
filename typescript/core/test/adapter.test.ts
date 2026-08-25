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

  it("shares synchronized contract state with transaction-bound queues", async () => {
    const database: Queryable = {
      query: vi.fn<(statement: string) => Promise<never>>(async (statement: string) => {
        if (statement.includes("get_contract_definition_v1")) {
          return {
            rows: [
              {
                version: "current",
                schema: { payload: true, result: true },
                payload_max_bytes: 1_048_576,
                result_max_bytes: 1_048_576,
                payload_redact_keys: [],
                result_redact_keys: [],
              },
            ],
          } as never;
        }
        return { rows: [] } as never;
      }) as Queryable["query"],
    };
    const transactionDatabase: Queryable = {
      query: vi.fn<() => Promise<never>>(
        async () =>
          ({
            rows: [
              {
                ordinal: 1,
                job_id: "123e4567-e89b-42d3-a456-426614174000",
                outcome: "accepted",
                reason: null,
                contract_mismatch: null,
              },
            ],
          }) as never,
      ) as unknown as Queryable["query"],
    };
    const adapter = createWorkhorseAdapter<object>({
      database,
      adaptTransaction: () => transactionDatabase,
      queueOptions: {
        contracts: {
          send: { currentVersion: "current", versions: { current: {} } },
        },
      },
    });
    await adapter.queue.syncContracts();

    await adapter.forTransaction({}).enqueue("send", {});

    expect(transactionDatabase.query).toHaveBeenCalledOnce();
    expect(transactionDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining("enqueue_many_v1"),
      expect.any(Array),
    );
  });

  it("uses a database contract discovered after an enqueue version mismatch", async () => {
    const database: Queryable = {
      // oxlint-disable-next-line vitest/require-mock-type-parameters -- Queryable.query is generic and the cast supplies its contract.
      query: vi.fn(async () => ({ rows: [] })) as unknown as Queryable["query"],
    };
    let enqueueAttempts = 0;
    const transactionDatabase: Queryable = {
      // oxlint-disable-next-line vitest/require-mock-type-parameters -- Queryable.query is generic and the cast supplies its contract.
      query: vi.fn(async (statement: string) => {
        if (statement.includes("get_contract_definition_v1")) {
          return {
            rows: [
              {
                version: "database-current",
                schema: { payload: true, result: true },
                payload_max_bytes: 1_048_576,
                result_max_bytes: 1_048_576,
                payload_redact_keys: [],
                result_redact_keys: [],
              },
            ],
          };
        }
        enqueueAttempts += 1;
        return enqueueAttempts === 1
          ? {
              rows: [
                {
                  ordinal: 0,
                  job_id: null,
                  outcome: "contract_mismatch",
                  reason: JSON.stringify({ jobTypes: ["send"] }),
                },
              ],
            }
          : {
              rows: [
                {
                  ordinal: 1,
                  job_id: "123e4567-e89b-42d3-a456-426614174000",
                  outcome: "accepted",
                  reason: null,
                },
              ],
            };
      }) as unknown as Queryable["query"],
    };
    const adapter = createWorkhorseAdapter<object>({
      database,
      adaptTransaction: () => transactionDatabase,
    });
    await adapter.queue.syncContracts();

    await adapter.forTransaction({}).enqueue("send", {});

    expect(enqueueAttempts).toBe(2);
    expect(transactionDatabase.query).toHaveBeenCalledTimes(3);
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
