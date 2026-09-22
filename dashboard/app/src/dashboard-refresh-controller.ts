import {
  dashboardAutoRefreshPaused,
  discardBackgroundRefresh,
  type DashboardRefreshIntervalValue,
} from "./refresh-policy.js";

export interface DashboardRefreshController {
  shouldDiscardBackground(background: boolean): boolean;
  autoRefreshPaused(
    wasBlocked: boolean,
    countdown: number | null,
    interval: DashboardRefreshIntervalValue,
  ): boolean;
  pauseDescription(description: string | null, countdown: number | null): string;
}

/** Centralizes the refresh policy decisions made by the dashboard shell. */
export function createDashboardRefreshController(
  isBlocked: () => boolean,
): DashboardRefreshController {
  return {
    shouldDiscardBackground: (background) => discardBackgroundRefresh(background, isBlocked()),
    autoRefreshPaused: (wasBlocked, countdown, interval) =>
      dashboardAutoRefreshPaused(isBlocked(), wasBlocked, countdown, interval !== "off"),
    pauseDescription: (description, countdown) =>
      description ??
      (countdown !== null
        ? `Auto refresh resumes in ${countdown} seconds`
        : "Auto refresh interval"),
  };
}
