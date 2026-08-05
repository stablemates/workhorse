import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardRefreshIntervalMs,
  dashboardRefreshIsLive,
  defaultDashboardRefreshInterval,
  startDashboardPolling,
} from "./refresh-policy.js";

afterEach(() => vi.useRealTimers());

describe("dashboard refresh policy", () => {
  it("defaults to streaming rather than to a timer", () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => void>();
    // The default refreshes from the host's event stream, so it must schedule no polling of its
    // own: a timer running underneath a live subscription would double every page query.
    expect(dashboardRefreshIsLive(defaultDashboardRefreshInterval)).toBe(true);
    const stop = startDashboardPolling(
      dashboardRefreshIntervalMs(defaultDashboardRefreshInterval),
      refresh,
    );

    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("polls on a bounded interval when an operator chooses one", () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => void>();
    const stop = startDashboardPolling(dashboardRefreshIntervalMs("30s"), refresh);

    vi.advanceTimersByTime(29_999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("does not schedule background work in manual-only mode", () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => void>();
    const stop = startDashboardPolling(dashboardRefreshIntervalMs("off"), refresh);

    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });
});
