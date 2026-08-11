import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardPollingIntervalMs,
  dashboardRefreshIntervalMs,
  defaultDashboardRefreshInterval,
  discardBackgroundSettingsRefresh,
  startDashboardPolling,
} from "./refresh-policy.js";

afterEach(() => vi.useRealTimers());

describe("dashboard refresh policy", () => {
  it("defaults to one bounded refresh every 15 seconds", () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => void>();
    const stop = startDashboardPolling(
      dashboardRefreshIntervalMs(defaultDashboardRefreshInterval),
      refresh,
    );

    vi.advanceTimersByTime(14_999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(5);

    stop();
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  it("does not schedule background work in manual-only mode", () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => void>();
    const stop = startDashboardPolling(dashboardRefreshIntervalMs("off"), refresh);

    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("pauses a configured interval while a form has unsaved changes", () => {
    expect(dashboardPollingIntervalMs("15s", true)).toBeNull();
    expect(dashboardPollingIntervalMs("15s", false)).toBe(15_000);
  });

  it("discards only background settings refreshes that resolve against a dirty form", () => {
    expect(discardBackgroundSettingsRefresh(true, true, true)).toBe(true);
    expect(discardBackgroundSettingsRefresh(false, true, true)).toBe(false);
    expect(discardBackgroundSettingsRefresh(true, false, true)).toBe(false);
    expect(discardBackgroundSettingsRefresh(true, true, false)).toBe(false);
  });
});
