import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeDashboardRefresh, type DashboardLiveStatus } from "../src/live-refresh.js";

/**
 * Minimal stand-in for the browser's `EventSource`.
 *
 * The dashboard only ever observes `open`, `refresh`, and `error`, so the fake implements exactly
 * that surface and lets a test drive the stream frame by frame — including the reconnect state,
 * which a real server would be too slow and too nondeterministic to produce on demand.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CLOSED = FakeEventSource.CLOSED;
  readyState: number = FakeEventSource.CONNECTING;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  frame(reason: string): void {
    this.emit("refresh", { data: JSON.stringify({ reason, occurredAt: "2026-01-01T00:00:00Z" }) });
  }
}

describe("subscribeDashboardRefresh", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function subscribe(throttleMs?: number) {
    const refreshes = vi.fn<() => void>();
    const statuses: DashboardLiveStatus[] = [];
    const stop = subscribeDashboardRefresh({
      url: "/workhorse/events",
      onRefresh: refreshes,
      onStatus: (status) => statuses.push(status),
      ...(throttleMs === undefined ? {} : { throttleMs }),
    });
    return { refreshes, statuses, stop, source: FakeEventSource.instances.at(-1)! };
  }

  it("refreshes on a stream frame but not on the connection handshake", () => {
    const { refreshes, source, stop } = subscribe();

    source.emit("open");
    // `connected` arrives when the stream opens, at which point the caller has just loaded the
    // page it would otherwise reload.
    source.frame("connected");
    expect(refreshes).not.toHaveBeenCalled();

    source.frame("postgres");
    expect(refreshes).toHaveBeenCalledTimes(1);
    stop();
  });

  it("collapses a burst into one refresh and still delivers the last of it", () => {
    const { refreshes, source, stop } = subscribe(750);

    source.frame("worker");
    expect(refreshes).toHaveBeenCalledTimes(1);

    // A busy queue can produce frames faster than a page query completes. The extra frames must
    // neither each trigger a query nor be dropped outright.
    source.frame("worker");
    source.frame("postgres");
    source.frame("enqueue");
    expect(refreshes).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(750);
    expect(refreshes).toHaveBeenCalledTimes(2);

    // The throttle window is per burst, not a fixed schedule: a later quiet frame refreshes at once.
    vi.advanceTimersByTime(5_000);
    source.frame("postgres");
    expect(refreshes).toHaveBeenCalledTimes(3);
    stop();
  });

  it("refreshes on a frame it cannot parse rather than discarding the signal", () => {
    const { refreshes, source, stop } = subscribe();

    source.emit("refresh", { data: "{not json" });
    expect(refreshes).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reports reconnecting while the stream is down and offline once it is closed", () => {
    const { statuses, source, stop } = subscribe();

    expect(statuses).toEqual(["connecting"]);
    source.emit("open");
    expect(statuses.at(-1)).toBe("live");

    source.readyState = FakeEventSource.CONNECTING;
    source.emit("error");
    expect(statuses.at(-1)).toBe("connecting");

    source.readyState = FakeEventSource.CLOSED;
    source.emit("error");
    expect(statuses.at(-1)).toBe("offline");
    stop();
  });

  it("closes the stream and drops a pending refresh when the caller unsubscribes", () => {
    const { refreshes, statuses, source, stop } = subscribe(750);

    source.frame("postgres");
    source.frame("postgres");
    expect(refreshes).toHaveBeenCalledTimes(1);

    stop();
    vi.advanceTimersByTime(5_000);

    // The trailing refresh must not fire into a component that has already unmounted.
    expect(refreshes).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
    expect(statuses.at(-1)).toBe("offline");
  });

  it("reports offline without throwing where the browser has no EventSource", () => {
    vi.stubGlobal("EventSource", undefined);
    const statuses: DashboardLiveStatus[] = [];

    const stop = subscribeDashboardRefresh({
      url: "/workhorse/events",
      onRefresh: () => expect.unreachable("nothing can stream without an EventSource"),
      onStatus: (status) => statuses.push(status),
    });

    expect(statuses).toEqual(["offline"]);
    stop();
  });
});
