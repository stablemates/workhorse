import { MantineProvider } from "@mantine/core";
import type { DashboardCronPage } from "@stablemates/workhorse-dashboard-server/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

afterEach(() => vi.useRealTimers());

const page: DashboardCronPage = {
  capturedAt: "2026-08-26T12:00:00.000Z",
  schedules: [
    {
      kind: "user",
      identity: { kind: "user", namespace: "billing", name: "invoices" },
      namespace: "billing",
      name: "invoices",
      cron: "0 2 * * *",
      queue: "billing",
      type: "invoice.generate",
      priority: 0,
      catchupPolicy: "skip",
      configuredEnabled: true,
      paused: false,
      pausedBy: null,
      pausedReason: null,
      pausedAt: null,
      active: true,
      revision: "1",
      updatedAt: "2026-08-26T12:00:00.000Z",
      occurrenceCount: 1,
      lastFiredAt: "2026-08-26T02:00:00.000Z",
      evaluatorCount: 2,
      lastSkippedAt: null,
      lastSkippedCount: null,
      lastSkippedThrough: null,
    },
  ],
  scheduleCount: 1,
  maintenance: {
    cadences: { tickIntervalMs: 1_000 },
    policy: {
      timezone: "UTC",
      partitionPreparationIntervalMs: 60_000,
      terminalCleanupIntervalMs: 300_000,
      historyRetentionLocalTime: "03:00",
      updatedAt: "2026-08-26T12:00:00.000Z",
    },
    routines: [
      {
        routine: "tick",
        lastStartedAt: "2026-08-26T11:59:59.000Z",
        lastCompletedAt: "2026-08-26T11:59:59.010Z",
        due: false,
        incomplete: false,
        recordedRunCount: 23,
        runs: [
          {
            id: "0198eb3d-72a0-7b43-8c1c-8829a85664c3",
            startedAt: "2026-08-26T11:59:59.000Z",
            completedAt: "2026-08-26T11:59:59.010Z",
            durationMs: 10,
            outcome: "succeeded",
            rowsAffected: 2,
            phases: [
              {
                phase: "promote",
                rowsAffected: 2,
                durationMs: 8,
                error: null,
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("schedules page", () => {
  it("says how many schedules the listing left out", async () => {
    const { CronPage } = await import("./pages/schedules.js");
    const render = (scheduleCount: number) =>
      renderToStaticMarkup(
        createElement(
          MantineProvider,
          null,
          createElement(CronPage, {
            data: { ...page, scheduleCount },
            togglingSchedule: null,
            setSchedulePaused: () => undefined,
            scheduleTasksHref: () => "/tasks",
          }),
        ),
      );
    expect(render(1)).not.toContain("Showing");
    expect(render(1_200)).toContain("Showing 1 of 1,200 schedules");
  });

  it("shows the last skip of a schedule, and nothing before the first skip", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(page.capturedAt));
    const { CronPage, scheduleSkipSummary } = await import("./pages/schedules.js");
    const { formatExact } = await import("./preferences.js");
    const [invoices] = page.schedules;
    const render = (schedule: DashboardCronPage["schedules"][number]) =>
      renderToStaticMarkup(
        createElement(
          MantineProvider,
          null,
          createElement(CronPage, {
            data: { ...page, schedules: [schedule] },
            togglingSchedule: null,
            setSchedulePaused: () => undefined,
            scheduleTasksHref: () => "/tasks",
          }),
        ),
      );

    const unskipped = render(invoices!);
    expect(unskipped).not.toContain("Skipped");
    expect(unskipped).not.toContain("Last skip");

    const skipped = render({
      ...invoices!,
      lastSkippedAt: "2026-08-26T02:10:00.000Z",
      lastSkippedCount: 4,
      lastSkippedThrough: "2026-08-25T02:00:00.000Z",
    });
    expect(skipped).toContain("Skipped 4 · 9h ago");
    expect(skipped).toContain(
      `aria-label="Last skip: At ${formatExact("2026-08-26T02:10:00.000Z")}, Workhorse skipped 4 missed occurrences older than the supported delay. The newest skipped occurrence is ${formatExact("2026-08-25T02:00:00.000Z")}."`,
    );
    expect(skipped).toContain("--badge-bg:var(--mantine-color-yellow-light)");

    expect(
      scheduleSkipSummary({
        lastSkippedAt: "2026-08-26T02:10:00.000Z",
        lastSkippedCount: 1,
        lastSkippedThrough: "2026-08-25T02:00:00.000Z",
      })?.detail,
    ).toContain("skipped 1 missed occurrence older");
    const capped = scheduleSkipSummary({
      lastSkippedAt: "2026-08-26T02:10:00.000Z",
      lastSkippedCount: 10_000,
      lastSkippedThrough: "2026-08-25T02:00:00.000Z",
    });
    expect(capped?.label).toMatch(/^Skipped 10,000\+ · /);
    expect(capped?.detail).toContain("skipped 10,000 or more missed occurrences");
    // A database below schema 86 returns no skip keys.
    expect(scheduleSkipSummary({})).toBeNull();
  });

  it("hides the skip badge once the last skip is 24 hours old", async () => {
    const { CronPage, scheduleSkipSummary } = await import("./pages/schedules.js");
    const [invoices] = page.schedules;
    const skip = {
      lastSkippedAt: "2026-08-26T02:10:00.000Z",
      lastSkippedCount: 4,
      lastSkippedThrough: "2026-08-25T02:00:00.000Z",
    };
    const skippedAt = Date.parse(skip.lastSkippedAt);
    const hour = 3_600_000;

    expect(scheduleSkipSummary(skip, skippedAt + 23 * hour)?.label).toBe("Skipped 4 · 23h ago");
    expect(scheduleSkipSummary(skip, skippedAt + 24 * hour - 1)).not.toBeNull();
    expect(scheduleSkipSummary(skip, skippedAt + 24 * hour)).toBeNull();
    expect(scheduleSkipSummary(skip, skippedAt + 3 * 24 * hour)).toBeNull();

    // The page reads the same clock as its relative times.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(skippedAt + 24 * hour);
    const markup = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(CronPage, {
          data: { ...page, schedules: [{ ...invoices!, ...skip }] },
          togglingSchedule: null,
          setSchedulePaused: () => undefined,
          scheduleTasksHref: () => "/tasks",
        }),
      ),
    );
    expect(markup).not.toContain("Skipped");
    expect(markup).not.toContain("Last skip");
  });

  it("explains that a maintenance destination is not a queue", async () => {
    const { CronPage, MaintenanceRunHistory, pauseScheduleWarning, resumeScheduleWarnings } =
      await import("./pages/schedules.js");
    const { presentSchedules } = await import("./presentation-policy.js");
    const { formatExact } = await import("./preferences.js");
    expect(presentSchedules(page)[0]?.lastFiredAt).toBe("2026-08-26T11:59:59.010Z");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(CronPage, {
          data: page,
          togglingSchedule: null,
          setSchedulePaused: () => undefined,
          scheduleTasksHref: (queue: string | null, taskType: string) =>
            `/tasks?${new URLSearchParams({ queue: queue ?? "", type: taskType })}`,
        }),
      ),
    );

    expect(html).toContain("Maintenance");
    expect(html).toContain(
      "Maintenance: Workers offer this maintenance directly to PostgreSQL. It is not sent to a queue and does not need a handler.",
    );
    expect(html).toContain("Destination: billing, priority 0, task type invoice.generate");
    expect(html).toContain("2 workers");
    expect(html).toContain(">All<");
    expect(html).toContain("--badge-bg:var(--mantine-color-green-light)");
    expect(html).not.toContain(">Enabled<");
    expect(html).toContain(formatExact("2026-08-26T11:59:59.010Z"));
    expect(html).toContain("23 retained");
    expect(html).toContain('href="/tasks?queue=billing&amp;type=invoice.generate"');
    expect(html).toContain(
      'aria-label="View tasks of type invoice.generate in the billing queue in a new window"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain(">system<");
    expect(pauseScheduleWarning).toContain("stop enqueuing occurrences");
    expect(resumeScheduleWarnings.skip).toContain("skip occurrences missed");
    expect(resumeScheduleWarnings.latest).toContain("most recent missed occurrence");
    expect(resumeScheduleWarnings.all).toContain("continue until the schedule catches up");

    const runHtml = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(MaintenanceRunHistory, { runs: page.maintenance.routines[0]!.runs }),
      ),
    );
    expect(runHtml).toContain("succeeded");
    expect(runHtml).toContain("2 rows affected");
    expect(runHtml).toContain("promote · 2 rows");
  });
});
