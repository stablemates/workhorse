export const dashboardRefreshIntervals = [
  { value: "off", label: "Manual refresh only", ms: null },
  { value: "5s", label: "Every 5s", ms: 5_000 },
  { value: "15s", label: "Every 15s", ms: 15_000 },
  { value: "30s", label: "Every 30s", ms: 30_000 },
  { value: "1m", label: "Every minute", ms: 60_000 },
  { value: "5m", label: "Every 5 minutes", ms: 300_000 },
] as const;

export type DashboardRefreshIntervalValue = (typeof dashboardRefreshIntervals)[number]["value"];

export const defaultDashboardRefreshInterval: DashboardRefreshIntervalValue = "15s";

export function dashboardRefreshIntervalMs(value: DashboardRefreshIntervalValue): number | null {
  return dashboardRefreshIntervals.find((option) => option.value === value)?.ms ?? null;
}

export function dashboardPollingIntervalMs(
  value: DashboardRefreshIntervalValue,
  paused: boolean,
): number | null {
  if (paused) return null;
  return dashboardRefreshIntervalMs(value);
}

export function dashboardAutoRefreshPaused(
  blocked: boolean,
  wasBlocked: boolean,
  countdown: number | null,
  autoRefreshEnabled: boolean,
): boolean {
  return blocked || countdown !== null || (wasBlocked && autoRefreshEnabled);
}

export function discardBackgroundSettingsRefresh(
  background: boolean,
  settingsPage: boolean,
  settingsDirty: boolean,
): boolean {
  return background && settingsPage && settingsDirty;
}

export function startDashboardPolling(intervalMs: number | null, refresh: () => void): () => void {
  if (intervalMs === null) return () => undefined;
  const timer = setInterval(refresh, intervalMs);
  return () => clearInterval(timer);
}

export interface DashboardPollingClock {
  reset: (intervalMs: number | null, paused: boolean) => void;
  setPaused: (paused: boolean) => void;
  setRefresh: (refresh: () => void) => void;
  stop: () => void;
}

export function createDashboardPollingClock(initialRefresh: () => void): DashboardPollingClock {
  let refresh = initialRefresh;
  let intervalMs: number | null = null;
  let remainingMs: number | null = null;
  let startedAt: number | null = null;
  let paused = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (preserveRemaining: boolean) => {
    if (timer !== null) clearTimeout(timer);
    if (preserveRemaining && startedAt !== null && remainingMs !== null) {
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
    }
    timer = null;
    startedAt = null;
  };
  const schedule = () => {
    if (timer !== null || paused || intervalMs === null || remainingMs === null) return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = null;
      startedAt = null;
      remainingMs = intervalMs;
      refresh();
      schedule();
    }, remainingMs);
  };

  return {
    reset(nextIntervalMs, nextPaused) {
      clearTimer(false);
      intervalMs = nextIntervalMs;
      remainingMs = nextIntervalMs;
      paused = nextPaused;
      schedule();
    },
    setPaused(nextPaused) {
      if (paused === nextPaused) return;
      if (nextPaused) clearTimer(true);
      paused = nextPaused;
      schedule();
    },
    setRefresh(nextRefresh) {
      refresh = nextRefresh;
    },
    stop() {
      clearTimer(false);
      intervalMs = null;
      remainingMs = null;
      paused = true;
    },
  };
}

export function startDashboardResumeCountdown(
  countdown: (seconds: number) => void,
  resume: () => void,
): () => void {
  let seconds = 3;
  countdown(seconds);
  const timer = setInterval(() => {
    seconds -= 1;
    if (seconds === 0) {
      clearInterval(timer);
      resume();
      return;
    }
    countdown(seconds);
  }, 1_000);
  return () => clearInterval(timer);
}

export interface DashboardRefreshResumePolicy {
  update: (blocked: boolean, autoRefreshEnabled: boolean) => void;
  stop: () => void;
}

export function createDashboardRefreshResumePolicy(
  countdown: (seconds: number | null) => void,
): DashboardRefreshResumePolicy {
  let wasBlocked = false;
  let stopCountdown: (() => void) | null = null;
  const cancelCountdown = () => {
    stopCountdown?.();
    stopCountdown = null;
  };

  return {
    update(blocked, autoRefreshEnabled) {
      cancelCountdown();
      if (blocked) {
        wasBlocked = true;
        countdown(null);
        return;
      }
      if (!wasBlocked || !autoRefreshEnabled) {
        wasBlocked = false;
        countdown(null);
        return;
      }

      wasBlocked = false;
      stopCountdown = startDashboardResumeCountdown(countdown, () => {
        stopCountdown = null;
        countdown(null);
      });
    },
    stop: cancelCountdown,
  };
}
