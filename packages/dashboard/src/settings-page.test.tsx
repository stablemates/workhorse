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
  it("separates browser preferences from read-only Workhorse policy", async () => {
    const { SettingsPage } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(SettingsPage, {
          data,
          saving: false,
          onSaveMaintenance: async () => undefined,
          onRevertMaintenance: async () => undefined,
          onDirtyChange: () => undefined,
        }),
      ),
    );

    expect(html).toContain("Your preferences");
    expect(html).toContain("Browser display timezone");
    expect(html).toContain("Workhorse settings");
    expect(html.indexOf("Your preferences")).toBeLessThan(html.indexOf("Workhorse settings"));
    expect(html).toContain("Database-wide settings");
    expect(html).toContain("Maintenance schedule");
    expect(html).toContain("Choose when database-wide cleanup runs");
    expect(html).toMatch(/mantine-Select-label[^>]*>Maintenance timezone/);
    expect(html).toContain("Advanced maintenance");
    expect(html).toContain("How often Workhorse checks that upcoming history partitions exist");
    expect(html).not.toMatch(/mantine-Select-label[^>]*>Partition preparation interval/);
    expect(html).toContain("Effective: 5 hours");
    expect(html).toContain("Effective: 5 minutes");
    expect(html).not.toContain("Custom partition preparation interval");
    expect(html).toContain("Retention windows");
    expect(html).toContain(
      "These effective values are read-only here because shortening them can permanently delete stored history",
    );
    expect(html).toContain("Cleanup limits");
    expect(html).toContain(
      "These read-only limits cap how much work each cleanup pass can perform",
    );
    expect(html).toContain("Operator override");
    expect(html).not.toContain("Application default");
    expect(html).toContain("Default: UTC");
    expect(html).toContain("Default: 6 hours");
    expect(html).toContain("Default: 14 days");
    expect(html).toContain("Effective: 7 days");
    expect(html).not.toContain('aria-label="Task events"');
    expect(html).not.toContain('aria-label="Finished tasks per cleanup pass"');
    expect(html).not.toContain("Preview impact");
    expect(html).not.toContain("Deletion impact");
    expect(html).not.toContain("Save cleanup limits");
    expect(html).toContain("Set at deploy");
    expect(html).toContain("worker-1");
    expect(html).toContain("30.0 s lease");
  });
});
