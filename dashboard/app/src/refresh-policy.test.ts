import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDashboardPollingClock,
  createDashboardRefreshResumePolicy,
  dashboardWindowIsActive,
  dashboardAutoRefreshPaused,
  dashboardPollingIntervalMs,
  dashboardRefreshIntervalMs,
  defaultDashboardRefreshInterval,
  discardBackgroundRefresh,
  startDashboardResumeCountdown,
  startDashboardPolling,
  subscribeDashboardWindowActivity,
} from "./refresh-policy.js";

afterEach(() => vi.useRealTimers());

describe("dashboard refresh policy", () => {
  it("allows auto refresh only while the dashboard window is focused and visible", () => {
    expect(dashboardWindowIsActive({ hasFocus: () => true, visibilityState: "visible" })).toBe(
      true,
    );
    expect(dashboardWindowIsActive({ hasFocus: () => false, visibilityState: "visible" })).toBe(
      false,
    );
    expect(dashboardWindowIsActive({ hasFocus: () => true, visibilityState: "hidden" })).toBe(
      false,
    );
  });

  it("tracks focus and visibility changes until the dashboard unmounts", () => {
    const browserWindow = new EventTarget();
    const browserDocument = new EventTarget();
    let focused = true;
    let visibilityState: DocumentVisibilityState = "visible";
    const windowState = {
      hasFocus: () => focused,
      get visibilityState() {
        return visibilityState;
      },
    };
    const activity: boolean[] = [];
    const changed = vi.fn<() => void>(() => {
      activity.push(dashboardWindowIsActive(windowState));
    });
    const unsubscribe = subscribeDashboardWindowActivity(changed, browserWindow, browserDocument);

    focused = false;
    browserWindow.dispatchEvent(new Event("blur"));
    focused = true;
    browserWindow.dispatchEvent(new Event("focus"));
    visibilityState = "hidden";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    expect(activity).toEqual([false, true, false, true]);
    expect(changed).toHaveBeenCalledTimes(4);

    unsubscribe();
    focused = false;
    browserWindow.dispatchEvent(new Event("blur"));
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    expect(activity).toEqual([false, true, false, true]);
  });

  it("resumes on every tab activation when focus updates after the visibility event", () => {
    vi.useFakeTimers();
    const browserWindow = new EventTarget();
    const browserDocument = new EventTarget();
    let focused = false;
    let visibilityState: DocumentVisibilityState = "hidden";
    const windowState = {
      hasFocus: () => focused,
      get visibilityState() {
        return visibilityState;
      },
    };
    const activity: boolean[] = [];
    const unsubscribe = subscribeDashboardWindowActivity(
      () => {
        activity.push(dashboardWindowIsActive(windowState));
      },
      browserWindow,
      browserDocument,
    );

    const activate = () => {
      visibilityState = "visible";
      browserDocument.dispatchEvent(new Event("visibilitychange"));
      focused = true;
      vi.runOnlyPendingTimers();
      expect(activity.at(-1)).toBe(true);
    };
    const deactivate = () => {
      focused = false;
      visibilityState = "hidden";
      browserDocument.dispatchEvent(new Event("visibilitychange"));
      expect(activity.at(-1)).toBe(false);
      vi.runOnlyPendingTimers();
    };

    activate();
    deactivate();
    activate();
    unsubscribe();
  });

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

  it("stays paused between the last blocker closing and the countdown starting", () => {
    expect(dashboardAutoRefreshPaused(false, true, null, true)).toBe(true);
    expect(dashboardAutoRefreshPaused(false, false, 3, true)).toBe(true);
    expect(dashboardAutoRefreshPaused(false, false, null, true)).toBe(false);
    expect(dashboardAutoRefreshPaused(false, true, null, false)).toBe(false);
  });

  it("continues a periodic refresh from the point where it was paused", () => {
    vi.useFakeTimers();
    const refresh = vi.fn<() => void>();
    const clock = createDashboardPollingClock(refresh);

    clock.reset(5_000, false);
    vi.advanceTimersByTime(3_000);
    clock.setPaused(true);
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();

    clock.setPaused(false);
    vi.advanceTimersByTime(1_999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    clock.stop();
  });

  it("counts down three seconds before auto refresh resumes", () => {
    vi.useFakeTimers();
    const countdown = vi.fn<(seconds: number) => void>();
    const resume = vi.fn<() => void>();
    const stop = startDashboardResumeCountdown(countdown, resume);

    expect(countdown).toHaveBeenLastCalledWith(3);
    vi.advanceTimersByTime(1_000);
    expect(countdown).toHaveBeenLastCalledWith(2);
    vi.advanceTimersByTime(1_000);
    expect(countdown).toHaveBeenLastCalledWith(1);
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(resume).toHaveBeenCalledTimes(1);

    stop();
    vi.advanceTimersByTime(3_000);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending resume when another refresh blocker opens", () => {
    vi.useFakeTimers();
    const countdown = vi.fn<(seconds: number | null) => void>();
    const policy = createDashboardRefreshResumePolicy(countdown);

    policy.update(true, true);
    policy.update(false, true);
    vi.advanceTimersByTime(1_000);
    policy.update(true, true);
    vi.advanceTimersByTime(3_000);

    expect(countdown.mock.calls.map(([seconds]) => seconds)).toEqual([null, 3, 2, null]);

    policy.stop();
  });

  it("discards only background page refreshes that meet an active blocker", () => {
    expect(discardBackgroundRefresh(true, true)).toBe(true);
    expect(discardBackgroundRefresh(false, true)).toBe(false);
    expect(discardBackgroundRefresh(true, false)).toBe(false);
  });
});
