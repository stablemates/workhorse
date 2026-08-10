import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const dashboardUrl = new URL("../docs/signoz/workhorse-business-metrics-v1.json", import.meta.url);

describe("SigNoz business dashboard", () => {
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

    const panelIds = new Set(Object.keys(dashboard.spec.panels));
    const referencedIds = new Set(
      dashboard.spec.layouts.flatMap((layout) =>
        layout.spec.items.map((item) => item.content.$ref.replace("#/spec/panels/", "")),
      ),
    );
    expect(referencedIds).toEqual(panelIds);
  });
});
