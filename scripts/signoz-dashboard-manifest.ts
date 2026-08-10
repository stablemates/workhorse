import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

type TimeAggregation = "avg" | "increase" | "latest" | "max" | "min" | "rate" | "sum";
type SpaceAggregation =
  | "avg"
  | "count"
  | "max"
  | "min"
  | "p50"
  | "p75"
  | "p90"
  | "p95"
  | "p99"
  | "sum";

type DashboardQuery = {
  metric: string;
  timeAggregation: TimeAggregation;
  spaceAggregation: SpaceAggregation;
  groupBy?: string[];
  legend?: string;
};

type DashboardPanel = {
  id: string;
  title: string;
  description: string;
  unit: string;
  queries: DashboardQuery[];
};

export type DashboardManifest = {
  name: string;
  title: string;
  description: string;
  tags: Record<string, string>;
  panels: DashboardPanel[];
};

export type SigNozDashboard = {
  id?: string;
  image: string;
  name: string;
  schemaVersion: "v6";
  spec: Record<string, unknown>;
  tags: { key: string; value: string }[];
};

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function requireUniqueDashboardNames(dashboards: readonly { name: string }[]): void {
  if (new Set(dashboards.map((dashboard) => dashboard.name)).size !== dashboards.length) {
    throw new Error("Dashboard names must be unique");
  }
}

function parseManifest(value: unknown, file: string): DashboardManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${file} must contain an object`);
  }
  const manifest = value as Partial<DashboardManifest>;
  requireString(manifest.name, `${file}.name`);
  requireString(manifest.title, `${file}.title`);
  requireString(manifest.description, `${file}.description`);
  if (!manifest.tags || typeof manifest.tags !== "object" || Array.isArray(manifest.tags)) {
    throw new Error(`${file}.tags must be an object`);
  }
  if (!Array.isArray(manifest.panels) || manifest.panels.length === 0) {
    throw new Error(`${file}.panels must be a non-empty array`);
  }
  const ids = new Set<string>();
  for (const [index, panelDefinition] of manifest.panels.entries()) {
    requireString(panelDefinition.id, `${file}.panels[${index}].id`);
    requireString(panelDefinition.title, `${file}.panels[${index}].title`);
    requireString(panelDefinition.description, `${file}.panels[${index}].description`);
    requireString(panelDefinition.unit, `${file}.panels[${index}].unit`);
    if (ids.has(panelDefinition.id)) {
      throw new Error(`${file} repeats panel id ${panelDefinition.id}`);
    }
    ids.add(panelDefinition.id);
    if (!Array.isArray(panelDefinition.queries) || panelDefinition.queries.length === 0) {
      throw new Error(`${file}.panels[${index}].queries must be a non-empty array`);
    }
    for (const [queryIndex, query] of panelDefinition.queries.entries()) {
      requireString(query.metric, `${file}.panels[${index}].queries[${queryIndex}].metric`);
      requireString(
        query.timeAggregation,
        `${file}.panels[${index}].queries[${queryIndex}].timeAggregation`,
      );
      requireString(
        query.spaceAggregation,
        `${file}.panels[${index}].queries[${queryIndex}].spaceAggregation`,
      );
    }
  }
  return manifest as DashboardManifest;
}

function builderQuery(query: DashboardQuery, index: number) {
  const name = String.fromCharCode("A".charCodeAt(0) + index);
  return {
    type: "builder_query",
    spec: {
      name,
      stepInterval: 0,
      signal: "metrics",
      source: "",
      aggregations: [
        {
          metricName: query.metric,
          temporality: "",
          timeAggregation: query.timeAggregation,
          spaceAggregation: query.spaceAggregation,
          reduceTo: "",
        },
      ],
      disabled: false,
      filter: { expression: "" },
      groupBy:
        query.groupBy?.map((attribute) => ({
          name: attribute,
          fieldContext: "attribute",
          fieldDataType: "string",
          signal: "metrics",
        })) ?? null,
      order: null,
      selectFields: null,
      secondaryAggregations: null,
      functions: null,
      legend: query.legend ?? "",
    },
  };
}

function panel(panelDefinition: DashboardPanel) {
  return {
    kind: "Panel",
    spec: {
      display: { name: panelDefinition.title, description: panelDefinition.description },
      plugin: {
        kind: "signoz/TimeSeriesPanel",
        spec: {
          visualization: { timePreference: "global_time", fillSpans: false },
          formatting: { unit: panelDefinition.unit, decimalPrecision: "2" },
          chartAppearance: {
            lineInterpolation: "spline",
            showPoints: false,
            lineStyle: "solid",
            fillMode: "none",
            spanGaps: { fillOnlyBelow: false, fillLessThan: "" },
          },
          axes: { softMin: null, softMax: null, isLogScale: false },
          legend: { position: "bottom", mode: "list", customColors: null },
          thresholds: null,
        },
      },
      queries: [
        {
          kind: "time_series",
          spec: {
            plugin: {
              kind: "signoz/CompositeQuery",
              spec: { queries: panelDefinition.queries.map(builderQuery) },
            },
          },
        },
      ],
      links: null,
    },
  };
}

export function compileDashboard(manifest: DashboardManifest): SigNozDashboard {
  return {
    name: manifest.name,
    image: "/assets/Icons/eight-ball",
    schemaVersion: "v6",
    tags: Object.entries({ ...manifest.tags, "managed-by": "workhorse" }).map(([key, value]) => ({
      key,
      value,
    })),
    spec: {
      display: { name: manifest.title, description: manifest.description },
      variables: [],
      panels: Object.fromEntries(
        manifest.panels.map((definition) => [definition.id, panel(definition)]),
      ),
      layouts: [
        {
          kind: "Grid",
          spec: {
            display: { title: "" },
            items: manifest.panels.map((definition, index) => ({
              x: (index % 2) * 6,
              y: Math.floor(index / 2) * 6,
              width: 6,
              height: 6,
              content: { $ref: `#/spec/panels/${definition.id}` },
            })),
          },
        },
      ],
      duration: "",
      refreshInterval: "1m",
      links: null,
    },
  };
}

export async function loadDashboardManifests(directory: string): Promise<DashboardManifest[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  const manifests = await Promise.all(
    files.map(async (file) =>
      parseManifest(JSON.parse(await readFile(resolve(directory, file), "utf8")), file),
    ),
  );
  requireUniqueDashboardNames(manifests);
  return manifests;
}

function parseDashboard(value: unknown, file: string): SigNozDashboard {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${file} must contain an object`);
  }
  const dashboard = value as Partial<SigNozDashboard>;
  requireString(dashboard.name, `${file}.name`);
  requireString(dashboard.image, `${file}.image`);
  if (dashboard.schemaVersion !== "v6") {
    throw new Error(`${file}.schemaVersion must be v6`);
  }
  if (!Array.isArray(dashboard.tags)) {
    throw new Error(`${file}.tags must be an array`);
  }
  if (typeof dashboard.spec !== "object" || dashboard.spec === null) {
    throw new Error(`${file}.spec must be an object`);
  }
  return dashboard as SigNozDashboard;
}

export async function loadProvisionedDashboards(
  manifestDirectory: string,
  dashboardFiles: readonly (string | URL)[],
): Promise<SigNozDashboard[]> {
  const manifests = await loadDashboardManifests(manifestDirectory);
  const imported = await Promise.all(
    dashboardFiles.map(async (file) =>
      parseDashboard(JSON.parse(await readFile(file, "utf8")), file.toString()),
    ),
  );
  const dashboards = [...manifests.map(compileDashboard), ...imported];
  requireUniqueDashboardNames(dashboards);
  return dashboards;
}
