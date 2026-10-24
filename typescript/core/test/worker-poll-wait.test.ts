import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_DELAY_MS } from "../src/timers.js";
import { Worker, type WorkerOptions, type WorkerQueueApi } from "../src/worker.js";

// SM-1668 PAR-09 (ADR 0112): the wait after an empty claim takes the base, doubles it toward the
// 5,000 ms cap while no subscription is live, and then applies ±10% jitter. With a live
// subscription, an explicit pollMs is the caller's fallback interval, so the cap does not apply,
// as in the other six SDKs. The timer maximum still bounds the jittered wait.

interface PollInternals {
  nextDispatchPollMs(): number;
  notificationSubscriptions: Array<{ isListening(): boolean; close(): Promise<void> }>;
  consecutiveEmptyClaims: number;
}

function worker(options: WorkerOptions, listening: boolean, emptyClaims = 1): PollInternals {
  const queue = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "defaultQueue") return "poll-wait";
        if (typeof property === "symbol") return undefined;
        return () => undefined;
      },
    },
  ) as WorkerQueueApi;
  const internals = new Worker(queue, options) as unknown as PollInternals;
  internals.notificationSubscriptions = [
    { isListening: () => listening, close: () => Promise.resolve() },
  ];
  internals.consecutiveEmptyClaims = emptyClaims;
  return internals;
}

// Math.random() of 0 gives the -10% end of the jitter, and a value near 1 gives the +10% end.
function waits(internals: PollInternals): [number, number] {
  const random = vi.spyOn(Math, "random");
  random.mockReturnValue(0);
  const low = internals.nextDispatchPollMs();
  random.mockReturnValue(0.999_999_999);
  const high = internals.nextDispatchPollMs();
  return [low, high];
}

describe("the wait after an empty claim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits an explicit pollMs above 5,000 ms while the subscription is live", () => {
    expect(waits(worker({ pollMs: 30_000 }, true, 4))).toEqual([27_000, 33_000]);
  });

  it("caps an explicit pollMs at 5,000 ms before the jitter while it polls", () => {
    expect(waits(worker({ pollMs: 30_000 }, false, 4))).toEqual([4_500, 5_500]);
  });

  it("keeps the 5,000 ms base while live and doubles 250 ms toward the cap while polling", () => {
    expect(waits(worker({}, true, 10))).toEqual([4_500, 5_500]);
    expect(waits(worker({}, false, 1))).toEqual([225, 275]);
    expect(waits(worker({}, false, 3))).toEqual([900, 1_100]);
    expect(waits(worker({}, false, 30))).toEqual([4_500, 5_500]);
  });

  it("bounds the jittered wait at the timer maximum and waits at least 1 ms", () => {
    expect(waits(worker({ pollMs: MAX_TIMER_DELAY_MS }, true))[1]).toBe(MAX_TIMER_DELAY_MS);
    expect(waits(worker({ pollMs: 0 }, true))).toEqual([1, 1]);
  });
});
