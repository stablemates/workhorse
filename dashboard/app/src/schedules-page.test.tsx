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
      enabled: true,
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
    tasks: [
      {
        task: "tick",
        lastStartedAt: "2026-08-26T11:59:59.000Z",
        lastCompletedAt: "2026-08-26T11:59:59.010Z",
        due: false,
        incomplete: false,
      },
    ],
  },
};

describe("schedules page", () => {
  it("explains that a maintenance destination is not a queue", async () => {
    const { CronPage } = await import("./pages/schedules.js");
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
          setScheduleEnabled: () => undefined,
        }),
      ),
    );

    expect(html).toContain("Maintenance");
    expect(html).toContain(
      "Maintenance: Workers offer this maintenance directly to PostgreSQL. It is not sent to a queue and does not need a handler.",
    );
    expect(html).toContain("billing · Priority 0");
    expect(html).toContain("2 workers");
    expect(html).toContain(formatExact("2026-08-26T11:59:59.010Z"));
    expect(html).not.toContain(">system<");
  });
});
