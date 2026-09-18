import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToTaskNotifications } from "../src/notifications.js";
import type { Queryable } from "../src/types.js";

// Reconnect backoff sleeps grow to seconds; run them immediately while keeping abort handling.
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setTimeout: (_delay: number, value?: unknown, options?: { signal?: AbortSignal }) =>
      actual.setTimeout(0, value, options),
  };
});

class FakeClient extends EventEmitter {
  readonly released: (Error | boolean | undefined)[] = [];
  constructor(private readonly onQuery: (client: FakeClient, text: string) => Promise<unknown>) {
    super();
  }
  query(text: string): Promise<unknown> {
    return this.onQuery(this, text);
  }
  release(error?: Error | boolean): void {
    this.released.push(error);
  }
}

function fakeDatabase(connect: () => Promise<FakeClient>): Queryable {
  return { query: async () => ({ rows: [] }), connect } as unknown as Queryable;
}

function hubSignals(): { signals: Set<AbortSignal>; restore: () => void } {
  const signals = new Set<AbortSignal>();
  const add = AbortSignal.prototype.addEventListener;
  const spy = vi.spyOn(AbortSignal.prototype, "addEventListener").mockImplementation(function (
    this: AbortSignal,
    ...args: Parameters<typeof add>
  ) {
    signals.add(this);
    return add.apply(this, args);
  });
  return { signals, restore: () => spy.mockRestore() };
}

describe("task notification hub", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the abort signal's listener count constant across ten reconnects", async () => {
    const { signals } = hubSignals();
    const listenerCounts: number[] = [];
    let connects = 0;
    const database = fakeDatabase(async () => {
      listenerCounts.push(
        [...signals].reduce(
          (total, signal) => total + getEventListeners(signal, "abort").length,
          0,
        ),
      );
      connects += 1;
      // Alternate between an outage and a connection that drops after LISTEN.
      if (connects % 2 === 1) throw new Error("connection refused");
      return new FakeClient(async (client, text) => {
        if (text.startsWith("LISTEN")) {
          // A released client belongs to the pool, which owns its later errors.
          setImmediate(() => {
            if (client.released.length === 0) client.emit("error", new Error("socket reset"));
          });
        }
        return { rows: [] };
      });
    });
    const errors: unknown[] = [];
    const subscription = await subscribeToTaskNotifications(database, {
      queueName: "default",
      wake: () => undefined,
      error: (error) => errors.push(error),
    });

    await vi.waitFor(() => expect(connects).toBeGreaterThanOrEqual(11));
    await subscription!.close();

    expect(listenerCounts.slice(0, 11)).toEqual(Array(11).fill(listenerCounts[0]));
    expect(errors.length).toBeGreaterThanOrEqual(10);
  });

  it("reports a socket error during UNLISTEN instead of throwing it", async () => {
    const socketError = new Error("socket reset during UNLISTEN");
    let emitThrew = false;
    const client = new FakeClient(async (self, text) => {
      if (!text.startsWith("UNLISTEN")) return { rows: [] };
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      try {
        self.emit("error", socketError);
      } catch {
        emitThrew = true;
      }
      throw socketError;
    });
    const database = fakeDatabase(async () => client);
    const errors: unknown[] = [];
    const subscription = await subscribeToTaskNotifications(database, {
      queueName: "default",
      wake: () => undefined,
      error: (error) => errors.push(error),
    });
    await vi.waitFor(() => expect(subscription!.isListening?.()).toBe(true));

    await subscription!.close();

    expect(emitThrew).toBe(false);
    expect(errors).toEqual([socketError]);
    expect(client.released).toEqual([socketError]);
  });

  it("keeps running when a subscriber's error callback throws", async () => {
    let connects = 0;
    const database = fakeDatabase(async () => {
      connects += 1;
      if (connects === 1) throw new Error("connection refused");
      return new FakeClient(async () => ({ rows: [] }));
    });
    const subscription = await subscribeToTaskNotifications(database, {
      queueName: "default",
      wake: () => undefined,
      error: () => {
        throw new Error("onNotificationError failed");
      },
    });

    await vi.waitFor(() => expect(subscription!.isListening?.()).toBe(true));
    expect(connects).toBe(2);
    await expect(subscription!.close()).resolves.toBeUndefined();
  });
});
