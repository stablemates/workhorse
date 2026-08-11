import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import type { DashboardSettingsPage } from "./model.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

const maintenanceProvenance = {
  timezone: { source: "operator" as const, applicationDefault: "UTC" },
  partitionPreparationIntervalMs: {
    source: "operator" as const,
    applicationDefault: 21_600_000,
  },
  terminalCleanupIntervalMs: { source: "application" as const, applicationDefault: 300_000 },
  historyRetentionLocalTime: { source: "operator" as const, applicationDefault: "03:00" },
};
const retentionProvenance = {
  jobIdentityRetentionDays: { source: "application" as const, applicationDefault: 14 },
  terminalOutcomeRetentionDays: { source: "application" as const, applicationDefault: 14 },
  jobEventRetentionDays: { source: "operator" as const, applicationDefault: 14 },
  attemptHistoryRetentionDays: { source: "application" as const, applicationDefault: 14 },
  scheduleOccurrenceRetentionDays: { source: "application" as const, applicationDefault: 14 },
  statisticsRetentionDays: { source: "application" as const, applicationDefault: 14 },
  terminalJobPruneLimit: { source: "application" as const, applicationDefault: 1_000 },
  historyPartitionsPerPass: { source: "application" as const, applicationDefault: 4 },
  defaultPartitionRowsPerPass: { source: "application" as const, applicationDefault: 10_000 },
  occurrenceRowsPerPass: { source: "application" as const, applicationDefault: 10_000 },
  statisticsRowsPerPass: { source: "application" as const, applicationDefault: 10_000 },
};

const data: DashboardSettingsPage = {
  capturedAt: "2026-08-10T12:00:00.000Z",
  editable: true,
  maintenance: {
    timezone: "America/New_York",
    partitionPreparationIntervalMs: 18_000_000,
    terminalCleanupIntervalMs: 300_000,
    historyRetentionLocalTime: "01:30",
    provenance: maintenanceProvenance,
    updatedAt: "2026-08-10T12:00:00.000Z",
  },
  retention: {
    jobIdentityRetentionDays: 14,
    terminalOutcomeRetentionDays: 14,
    jobEventRetentionDays: 7,
    attemptHistoryRetentionDays: 14,
    scheduleOccurrenceRetentionDays: 14,
    statisticsRetentionDays: 14,
    terminalJobPruneLimit: 1_000,
    historyPartitionsPerPass: 4,
    defaultPartitionRowsPerPass: 10_000,
    occurrenceRowsPerPass: 10_000,
    statisticsRowsPerPass: 10_000,
    provenance: retentionProvenance,
    updatedAt: "2026-08-10T12:00:00.000Z",
  },
  workers: [
    {
      id: "worker-1",
      queue: "default",
      concurrency: 4,
      leaseMs: 30_000,
      heartbeatMs: 10_000,
      pollMs: 250,
      maintenanceIntervalMs: 1_000,
      maintenanceTaskPollMs: 60_000,
      registryIntervalMs: 5_000,
      lastSeenAt: "2026-08-10T12:00:00.000Z",
    },
  ],
};

describe("settings page", () => {
  it("separates editable policy from deployment settings and shows destructive impact", async () => {
    const { SettingsPage } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(SettingsPage, {
          data,
          retentionImpact: {
            eligible: {
              terminalJobs: 12,
              jobEvents: 40,
              attemptHistory: 7,
              scheduleOccurrences: 0,
              statistics: 0,
            },
            capped: {
              terminalJobs: false,
              jobEvents: false,
              attemptHistory: false,
              scheduleOccurrences: false,
              statistics: false,
            },
          },
          saving: false,
          onSaveMaintenance: async () => undefined,
          onPreviewRetention: async () => ({
            eligible: {
              terminalJobs: 12,
              jobEvents: 40,
              attemptHistory: 7,
              scheduleOccurrences: 0,
              statistics: 0,
            },
            capped: {
              terminalJobs: false,
              jobEvents: false,
              attemptHistory: false,
              scheduleOccurrences: false,
              statistics: false,
            },
          }),
          onSaveRetention: async () => undefined,
          onRevertMaintenance: async () => undefined,
          onRevertRetention: async () => undefined,
          onDirtyChange: () => undefined,
        }),
      ),
    );

    expect(html).toContain("Database-owned policy");
    expect(html).toContain("Maintenance schedule");
    expect(html).toContain("Choose when database-wide cleanup runs");
    expect(html).toMatch(/mantine-Select-label[^>]*>Maintenance timezone/);
    expect(html).toContain("Advanced maintenance");
    expect(html).toContain("How often Workhorse checks that upcoming history partitions exist");
    expect(html).toMatch(/mantine-Select-label[^>]*>Partition preparation interval/);
    expect(html).toContain("Enter any cadence from one minute through seven days");
    expect(html).toContain("Retention windows");
    expect(html).toContain("Control how long Workhorse keeps each kind of stored history");
    expect(html).toContain("Cleanup limits");
    expect(html).toContain("Limit how much work each cleanup pass can perform");
    expect(html).toContain("Operator override");
    expect(html).not.toContain("Application default");
    expect(html).toContain("Default: UTC");
    expect(html).toContain("Default: 6 hours");
    expect(html).toContain("Default: 14 days");
    expect(html).toContain("12 finished tasks, 40 events, and 7 attempts");
    expect(html).toContain("Set at deploy");
    expect(html).toContain("worker-1");
    expect(html).toContain("30.0 s lease");
  });
});
