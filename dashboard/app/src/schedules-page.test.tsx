import { MantineProvider } from "@mantine/core";
import type { DashboardCronPage } from "@stablemates/workhorse-dashboard-server/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

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
    },
  ],
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
  it("explains that a maintenance destination is not a queue", async () => {
    const { CronPage, MaintenanceRunHistory, resumeScheduleWarnings } =
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
          taskTypeHref: (taskType: string) => `/tasks?type=${encodeURIComponent(taskType)}`,
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
    expect(html).toContain('href="/tasks?type=invoice.generate"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain(">system<");
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
