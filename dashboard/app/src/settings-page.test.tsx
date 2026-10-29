import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { GraphicalProvider, theme } from "./ui.js";
import type { DashboardSettingsPage } from "@stablemates/workhorse-dashboard-server/wire";

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
  statisticsRollupIntervalMs: { source: "operator" as const, applicationDefault: 60_000 },
  statisticsGroupLimit: { source: "application" as const, applicationDefault: 200 },
  statisticsRecomputeBuckets: { source: "application" as const, applicationDefault: 2 },
};
const retentionProvenance = {
  taskIdentityRetentionDays: { source: "application" as const, applicationDefault: 14 },
  terminalOutcomeRetentionDays: { source: "application" as const, applicationDefault: 14 },
  taskEventRetentionDays: { source: "operator" as const, applicationDefault: 14 },
  attemptHistoryRetentionDays: { source: "application" as const, applicationDefault: 14 },
  scheduleOccurrenceRetentionDays: { source: "application" as const, applicationDefault: 14 },
  statisticsRetentionDays: { source: "application" as const, applicationDefault: 14 },
  terminalTaskPruneLimit: { source: "application" as const, applicationDefault: 1_000 },
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
    statisticsRollupIntervalMs: 0,
    statisticsGroupLimit: 200,
    statisticsRecomputeBuckets: 2,
    provenance: maintenanceProvenance,
    updatedAt: "2026-08-10T12:00:00.000Z",
  },
  retention: {
    taskIdentityRetentionDays: 14,
    terminalOutcomeRetentionDays: 14,
    taskEventRetentionDays: 7,
    attemptHistoryRetentionDays: 14,
    scheduleOccurrenceRetentionDays: 14,
    statisticsRetentionDays: 14,
    terminalTaskPruneLimit: 1_000,
    historyPartitionsPerPass: 4,
    defaultPartitionRowsPerPass: 10_000,
    occurrenceRowsPerPass: 10_000,
    statisticsRowsPerPass: 10_000,
    provenance: retentionProvenance,
    updatedAt: "2026-08-10T12:00:00.000Z",
  },
  recommendationInputs: {
    reasons: [],
    statistics: {
      rolledUpThrough: "2026-08-10T11:59:00.000Z",
      lagMs: 60_000,
      lastRunAt: null,
    },
    defaultHistoryRows: { taskEvents: 0, attemptHistory: 0 },
    defaultHistoryRowsCapped: { taskEvents: false, attemptHistory: false },
    enqueueRate: { tasks: 0, windowMs: 3_600_000 },
  },
  workers: [
    {
      id: "worker-1",
      queues: ["default", "mail"],
      concurrency: 4,
      leaseMs: 30_000,
      heartbeatMs: 10_000,
      pollMs: 250,
      maintenanceIntervalMs: 1_000,
      maintenanceRoutinePollMs: 60_000,
      registryIntervalMs: 5_000,
      lastSeenAt: "2026-08-10T12:00:00.000Z",
    },
  ],
};

describe("settings page", () => {
  it("separates browser preferences from read-only Workhorse policy", async () => {
    const { SettingsPage } = await import("./dashboard.js");
    const { RefreshBlockerProvider } = await import("./refresh-blockers.js");
    const html = renderToStaticMarkup(
      createElement(
        RefreshBlockerProvider,
        null,
        createElement(
          GraphicalProvider,
          { document: theme, colorMode: "light" },
          createElement(
            MantineProvider,
            null,
            createElement(SettingsPage, {
              data,
              saving: false,
              onSaveMaintenance: async () => undefined,
              onRevertMaintenance: async () => undefined,
            }),
          ),
        ),
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
    expect(html).toContain("Statistics rollup interval");
    expect(html).toContain("Effective: Opted out");
    expect(html).toContain("Default: 1 minute");
    expect(html).toContain("Statistics group limit");
    expect(html).toContain("Effective: 200 groups");
    expect(html).toContain("Statistics recompute window");
    expect(html).toContain("Effective: 2 minutes");
    expect(html).toContain("Configuration note");
    expect(html).toContain("The statistics rollup is opted out while raw-history retention");
    expect(html).toContain("Retention windows");
    expect(html).toContain(
      "These effective values are read-only here because shortening them can permanently delete stored history",
    );
    expect(html).toContain("Cleanup limits");
    expect(html).toContain(
      "These read-only limits cap how much work each cleanup pass can perform",
    );
    expect(html).toContain("Operator override");
    // A default is stated only where an operator override makes it differ; rows still on the
    // application default carry a label instead of repeating the effective value.
    expect(html).toContain("Application default");
    expect(html).toContain("Default: UTC");
    expect(html).toContain("Default: 6 hours");
    expect(html).not.toContain("Default: 5 minutes");
    expect(html).not.toContain("Default: 200 groups");
    expect(html).toContain("Default: 14 days");
    expect(html).toMatch(/Effective: <\/span>7 days/);
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

describe("display time zone choices", () => {
  it("offers every zone the browser lists, after System and UTC", async () => {
    const { displayTimeZoneOptions, supportedTimeZones } =
      await import("./pages/settings/index.js");
    const zones = supportedTimeZones({
      supportedValuesOf: () => ["Africa/Abidjan", "Pacific/Auckland", "UTC"],
    });
    expect(zones).toEqual(["UTC", "Africa/Abidjan", "Pacific/Auckland"]);
    const values = displayTimeZoneOptions("system", zones).map(({ value }) => value);
    expect(values).toEqual(["system", "UTC", "Africa/Abidjan", "Pacific/Auckland"]);
  });

  it("offers more than the short list in this runtime", async () => {
    const { displayTimeZoneOptions } = await import("./pages/settings/index.js");
    const values = displayTimeZoneOptions("system").map(({ value }) => value);
    expect(values.slice(0, 2)).toEqual(["system", "UTC"]);
    expect(values.length).toBeGreaterThan(14);
    expect(values).toContain("Pacific/Auckland");
  });

  it("keeps the short list when the browser cannot list zones", async () => {
    const { supportedTimeZones } = await import("./pages/settings/index.js");
    for (const zones of [
      supportedTimeZones({}),
      supportedTimeZones({
        supportedValuesOf: () => {
          throw new RangeError("Invalid key");
        },
      }),
      supportedTimeZones({ supportedValuesOf: () => [] }),
    ]) {
      expect(zones).toHaveLength(13);
      expect(zones[0]).toBe("UTC");
      expect(zones).toContain("Europe/Kyiv");
    }
  });

  it("keeps a selected zone that the list does not contain", async () => {
    const { displayTimeZoneOptions } = await import("./pages/settings/index.js");
    const values = displayTimeZoneOptions("Asia/Calcutta", ["UTC", "Asia/Kolkata"]).map(
      ({ value }) => value,
    );
    expect(values).toEqual(["system", "UTC", "Asia/Kolkata", "Asia/Calcutta"]);
  });
});

describe("maintenance draft", () => {
  it("keeps an unsaved edit when a fresh settings answer arrives", async () => {
    const { followMaintenanceAnswer } = await import("./pages/settings/index.js");
    // 1. The operator opens Settings. The cached answer shows, and a new read starts.
    const cached = { timezone: "UTC", historyRetentionLocalTime: "03:00" };
    // 2. Before the read ends, the operator changes the daily retention time.
    const draft = { timezone: "UTC", historyRetentionLocalTime: "04:30" };
    // 3. The new answer arrives. Another operator changed the timezone meanwhile.
    const fresh = { timezone: "Europe/Berlin", historyRetentionLocalTime: "03:00" };
    // 4. The edit stays, and the field the operator did not touch follows the answer.
    expect(followMaintenanceAnswer({ draft, previous: cached, next: fresh })).toEqual({
      timezone: "Europe/Berlin",
      historyRetentionLocalTime: "04:30",
    });
  });

  it("follows the answer when the draft has no edits, and keeps the same draft otherwise", async () => {
    const { followMaintenanceAnswer } = await import("./pages/settings/index.js");
    const saved = { timezone: "UTC", historyRetentionLocalTime: "03:00" };
    const next = { timezone: "Asia/Tokyo", historyRetentionLocalTime: "05:00" };
    expect(followMaintenanceAnswer({ draft: saved, previous: saved, next })).toEqual(next);
    // A save writes the draft, so the answer after it equals the draft and nothing is unsaved.
    const draft = { timezone: "Asia/Tokyo", historyRetentionLocalTime: "05:00" };
    expect(followMaintenanceAnswer({ draft, previous: saved, next })).toBe(draft);
  });

  it("takes a value that another operator sets before the reload after a save", async () => {
    const { followMaintenanceAnswer, followMaintenanceSave } =
      await import("./pages/settings/index.js");
    // 1. The page shows the stored daily retention time 03:00.
    const answered = { timezone: "UTC", historyRetentionLocalTime: "03:00" };
    // 2. The operator changes it to 04:30 and saves. Workhorse accepts the save.
    const draft = { timezone: "UTC", historyRetentionLocalTime: "04:30" };
    const previous = followMaintenanceSave({
      answered,
      submitted: { historyRetentionLocalTime: "04:30" },
    });
    // 3. Another operator sets 05:00 before the reload ends.
    const next = { timezone: "UTC", historyRetentionLocalTime: "05:00" };
    // 4. The draft takes 05:00, so it equals the answer and has no unsaved change.
    expect(followMaintenanceAnswer({ draft, previous, next })).toEqual(next);
  });

  it("keeps an edit that the operator makes after the submit", async () => {
    const { followMaintenanceAnswer, followMaintenanceSave } =
      await import("./pages/settings/index.js");
    // 1. The operator saves 04:30 over 03:00 in UTC. Workhorse accepts the save.
    const answered = { timezone: "UTC", historyRetentionLocalTime: "03:00" };
    const previous = followMaintenanceSave({
      answered,
      submitted: { historyRetentionLocalTime: "04:30" },
    });
    // 2. Before the reload ends, the operator changes the time again and changes the timezone.
    const draft = { timezone: "Asia/Tokyo", historyRetentionLocalTime: "06:15" };
    // 3. The reload returns the saved value.
    const next = { timezone: "UTC", historyRetentionLocalTime: "04:30" };
    // 4. Both later edits stay.
    expect(followMaintenanceAnswer({ draft, previous, next })).toBe(draft);
  });

  it("keeps the draft dirty when the save fails", async () => {
    const { followMaintenanceAnswer } = await import("./pages/settings/index.js");
    // 1. The page shows 03:00. The operator changes it to 04:30 and saves.
    const answered = { timezone: "UTC", historyRetentionLocalTime: "03:00" };
    const draft = { timezone: "UTC", historyRetentionLocalTime: "04:30" };
    // 2. Workhorse rejects the save. The controller does not call `onSaved`, so the answer that
    //    the draft follows stays at 03:00.
    // 3. A later answer still holds 03:00, and the edit stays unsaved.
    expect(followMaintenanceAnswer({ draft, previous: answered, next: answered })).toBe(draft);
  });

  it("discards to the saved values when the reload after a save fails", async () => {
    const { maintenanceFormChanges, updateMaintenanceForm } =
      await import("./pages/settings/index.js");
    // 1. The page shows the stored daily retention time 03:00 in UTC.
    const stored = { timezone: "UTC", historyRetentionLocalTime: "03:00" };
    let form = { answered: stored, draft: stored };
    // 2. The operator changes it to 04:30 and saves. Workhorse accepts the save.
    form = updateMaintenanceForm(form, {
      kind: "edit",
      change: { historyRetentionLocalTime: "04:30" },
    });
    form = updateMaintenanceForm(form, {
      kind: "saved",
      submitted: maintenanceFormChanges(form),
    });
    expect(maintenanceFormChanges(form)).toEqual({});
    // 3. The reload fails, so the last answer still holds 03:00. The operator edits the timezone.
    form = updateMaintenanceForm(form, { kind: "edit", change: { timezone: "Asia/Tokyo" } });
    expect(maintenanceFormChanges(form)).toEqual({ timezone: "Asia/Tokyo" });
    // 4. Discard gives the saved values, with no unsaved change.
    form = updateMaintenanceForm(form, { kind: "discard" });
    const saved = { timezone: "UTC", historyRetentionLocalTime: "04:30" };
    expect(form.draft).toEqual(saved);
    expect(maintenanceFormChanges(form)).toEqual({});
    // 5. The next answer holds a value from another operator. The draft follows it.
    const next = { timezone: "Europe/Berlin", historyRetentionLocalTime: "04:30" };
    form = updateMaintenanceForm(form, { kind: "answer", answer: next });
    expect(form.draft).toEqual(next);
    expect(maintenanceFormChanges(form)).toEqual({});
  });

  it("moves focus to the retention time before Discard or Save leaves the keyboard operator", () => {
    const source = readFileSync(new URL("./pages/settings/index.tsx", import.meta.url), "utf8");
    // 1. The operator presses Enter on Discard changes. Focus moves, then the button leaves.
    expect(source).toMatch(
      /keepFocusOnRemoval\(\{\s*removed: event\.currentTarget,\s*active: document\.activeElement,\s*target: retentionTimeField\.current,\s*\}\);\s*updateMaintenance\(\{ kind: "discard" \}\);/,
    );
    // 2. The operator presses Enter on Save. Focus moves, then the button is disabled.
    expect(source).toMatch(
      /keepFocusOnRemoval\(\{\s*removed: event\.currentTarget,\s*active: document\.activeElement,\s*target: retentionTimeField\.current,\s*\}\);\s*saveMaintenance\(\);/,
    );
    // 3. The retention time field takes the ref. The timezone field opens its list on focus.
    expect(source).toMatch(
      /ref=\{retentionTimeField\}\s*value=\{maintenance\.historyRetentionLocalTime\}/,
    );
  });
});
