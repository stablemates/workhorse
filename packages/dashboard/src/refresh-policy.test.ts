import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardRefreshIntervalMs,
  defaultDashboardRefreshInterval,
  startDashboardPolling,
} from "./refresh-policy.js";

afterEach(() => vi.useRealTimers());

describe("dashboard refresh policy", () => {
  it("defaults to one bounded refresh every 30 seconds", () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => void>();
    const stop = startDashboardPolling(
      dashboardRefreshIntervalMs(defaultDashboardRefreshInterval),
      refresh,
    );

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
