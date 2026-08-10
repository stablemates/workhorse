import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProvisionedDashboards } from "../scripts/signoz-dashboard-manifest.js";

const dashboardUrl = new URL("../docs/signoz/workhorse-business-metrics-v1.json", import.meta.url);
const dashboardDirectory = new URL("../ops/signoz/dashboards/", import.meta.url);

describe("SigNoz business dashboard", () => {
  it("loads every dashboard reconciled by the demo telemetry command", async () => {
    const dashboards = await loadProvisionedDashboards(fileURLToPath(dashboardDirectory), [
      dashboardUrl,
    ]);

    expect(new Set(dashboards.map((dashboard) => dashboard.name))).toEqual(
      new Set(["workhorse-jobs", "workhorse-operations", "workhorse-reliability"]),
    );
    expect(
      dashboards.every((dashboard) =>
        dashboard.tags.some((tag) => tag.key === "managed-by" && tag.value === "workhorse"),
      ),
    ).toBe(true);
  });

  it("keeps every business metric, filter, panel, and layout reference in the import artifact", async () => {
    const dashboard = JSON.parse(await readFile(dashboardUrl, "utf8")) as {
      schemaVersion: string;
      spec: {
        variables: Array<{ spec: { plugin?: { spec?: { name?: string } } } }>;
        panels: Record<string, unknown>;
        layouts: Array<{ spec: { items: Array<{ content: { $ref: string } }> } }>;
      };
    };
    const encoded = JSON.stringify(dashboard);

    expect(dashboard.schemaVersion).toBe("v6");
    expect(dashboard.spec.variables.map((variable) => variable.spec.plugin?.spec?.name)).toEqual([
      "deployment.environment.name",
      "service.name",
      "workhorse.queue.name",
      "workhorse.job.type",
    ]);
    for (const metric of [
      "workhorse.jobs.claimed",
      "workhorse.jobs.completed",
      "workhorse.jobs.failed",
      "workhorse.jobs.retried",
      "workhorse.handler.duration",
      "workhorse.handler.runtime",
      "workhorse.queue.depth",
      "workhorse.queue.oldest_ready_age",
    ]) {
      expect(encoded).toContain(`"metricName":"${metric}"`);
    }
    expect(encoded).not.toContain('"temporality":"cumulative"');
    expect(encoded).toContain('"temporality":""');

    const slowestTaskTypes = dashboard.spec.panels["77777777-7777-4777-8777-777777777777"] as {
      spec: {
        plugin: { spec: { formatting: { columnUnits: Record<string, string> } } };
        queries: Array<{
          spec: {
            plugin: {
              spec: { aggregations: Array<{ alias?: string }> };
            };
          };
        }>;
      };
    };
    expect(slowestTaskTypes.spec.plugin.spec.formatting.columnUnits).toEqual({ A: "ns" });
    expect(slowestTaskTypes.spec.queries[0]?.spec.plugin.spec.aggregations[0]?.alias).toBe(
      "P95 handler duration",
    );

    const panelIds = new Set(Object.keys(dashboard.spec.panels));
    const referencedIds = new Set(
      dashboard.spec.layouts.flatMap((layout) =>
        layout.spec.items.map((item) => item.content.$ref.replace("#/spec/panels/", "")),
      ),
    );
    expect(referencedIds).toEqual(panelIds);
  });
});
