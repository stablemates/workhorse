import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProvisionedDashboards } from "../scripts/signoz-dashboard-manifest.js";

const dashboardUrl = new URL("../docs/signoz/workhorse-business-metrics-v1.json", import.meta.url);
const dashboardDirectory = new URL("../ops/signoz/dashboards/", import.meta.url);

describe("SigNoz business dashboard", () => {
  it("uses stacked lifecycle charts instead of number widgets", async () => {
    const dashboard = JSON.parse(await readFile(dashboardUrl, "utf8")) as {
      spec: {
        panels: Record<
          string,
          {
            spec: {
              display: { name: string };
              plugin: { kind: string; spec: { visualization?: { stackedBarChart?: boolean } } };
            };
          }
        >;
        layouts: Array<{
          spec: { items: Array<{ width: number; height: number; content: { $ref: string } }> };
        }>;
      };
    };
    const panels = Object.values(dashboard.spec.panels);

    expect(panels.some((panel) => panel.spec.plugin.kind === "signoz/NumberPanel")).toBe(false);
    for (const [title, metric] of [
      ["Enqueued tasks", "workhorse.job.enqueued"],
      ["Started tasks", "workhorse.job.claimed"],
      ["Running and waiting tasks", "workhorse.job.count"],
      ["Completed tasks", "workhorse.job.execution"],
    ] as const) {
      const panel = panels.find((candidate) => candidate.spec.display.name === title);
      expect(panel?.spec.plugin.kind).toBe("signoz/BarChartPanel");
      expect(panel?.spec.plugin.spec.visualization?.stackedBarChart).toBe(true);
      expect(JSON.stringify(panel)).toContain(`"metricName":"${metric}"`);
      const panelId = Object.entries(dashboard.spec.panels).find(
        ([, candidate]) => candidate.spec.display.name === title,
      )?.[0];
      const layoutItem = dashboard.spec.layouts[0]?.spec.items.find((item) =>
        item.content.$ref.endsWith(`/${panelId}`),
      );
      expect(layoutItem?.width).toBeGreaterThanOrEqual(6);
      expect(layoutItem?.height).toBeGreaterThanOrEqual(5);
    }
    const completedTasks = panels.find(
      (candidate) => candidate.spec.display.name === "Completed tasks",
    );
    expect(JSON.stringify(completedTasks)).toContain(
      "workhorse.job.outcome IN ['canceled', 'deadline_exceeded', 'failed', 'succeeded', 'timeout']",
    );
  });

  it("uses observer-backed metrics for operational charts", async () => {
    const dashboard = JSON.parse(await readFile(dashboardUrl, "utf8")) as {
      spec: {
        panels: Record<string, { spec: { display: { name: string }; plugin: { kind: string } } }>;
      };
    };
    const panels = Object.values(dashboard.spec.panels);
    const metricNames = (title: string): Set<string> => {
      const panel = panels.find((candidate) => candidate.spec.display.name === title);
      expect(panel, `missing panel ${title}`).toBeDefined();
      const encoded = JSON.stringify(panel ?? {});
      return new Set(
        [...encoded.matchAll(/"metricName":"([^"]+)"/g)].flatMap((match) =>
          match[1] ? [match[1]] : [],
        ),
      );
    };

    expect(metricNames("Execution outcomes")).toEqual(new Set(["workhorse.job.execution"]));
    expect(metricNames("Handler runtime percentiles")).toEqual(
      new Set(["workhorse.job.execution.duration.bucket"]),
    );
    expect(metricNames("Worker slots")).toEqual(
      new Set(["workhorse.worker.active", "workhorse.worker.capacity"]),
    );
    expect(metricNames("Queue depth")).toEqual(new Set(["workhorse.job.count"]));
    expect(metricNames("Oldest ready job")).toEqual(new Set(["workhorse.queue.oldest_ready.age"]));
    expect(metricNames("Estimated queue drain time")).toEqual(
      new Set(["workhorse.job.count", "workhorse.job.execution"]),
    );
    expect(metricNames("Terminal success rate")).toEqual(new Set(["workhorse.job.execution"]));
  });

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
      "workhorse.job.enqueued",
      "workhorse.job.claimed",
      "workhorse.job.count",
      "workhorse.job.execution",
      "workhorse.job.execution.duration.bucket",
      "workhorse.queue.oldest_ready.age",
      "workhorse.worker.active",
      "workhorse.worker.capacity",
    ]) {
      expect(encoded).toContain(`"metricName":"${metric}"`);
    }
    for (const legacyMetric of [
      "workhorse.jobs.claimed",
      "workhorse.jobs.completed",
      "workhorse.jobs.failed",
      "workhorse.handler.duration",
      "workhorse.handler.runtime",
      "workhorse.queue.depth",
      "workhorse.queue.oldest_ready_age",
    ]) {
      expect(encoded).not.toContain(`"metricName":"${legacyMetric}"`);
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
