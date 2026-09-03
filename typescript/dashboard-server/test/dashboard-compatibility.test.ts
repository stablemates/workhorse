import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyDashboardSurface,
  describeDashboardSurface,
  mergeDashboardSurface,
  type DashboardSurface,
} from "../spec/compatibility.js";

const artifactDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dashboard",
  "v1",
);

function surface(procedures: DashboardSurface["procedures"]): DashboardSurface {
  return { formatVersion: 1, procedures };
}

describe("describing the dashboard/v1 wire surface", () => {
  const described = describeDashboardSurface({
    procedures: {
      tasks: {
        mutation: false,
        input: {
          type: "object",
          properties: {
            page: { type: "integer" },
            filter: { enum: ["all", "queued"] },
            queue: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["page"],
        },
        output: { $ref: "#/$defs/Page" },
      },
    },
    $defs: {
      Page: {
        type: "object",
        properties: { rows: { type: "array", items: { $ref: "#/$defs/Row" } } },
        required: ["rows"],
      },
      Row: {
        type: "object",
        properties: { id: { type: "string" }, next: { $ref: "#/$defs/Row" } },
        required: ["id"],
      },
    },
  });

  it("names a nested response field by its path through objects and arrays", () => {
    expect(described.procedures.tasks?.response["rows[].id"]).toEqual({ type: "string" });
  });

  it("records which request fields validation requires", () => {
    expect(described.procedures.tasks?.request.page).toEqual({ type: "integer", required: true });
    expect(described.procedures.tasks?.request.queue).toEqual({
      type: "null|string",
      required: false,
    });
  });

  it("records the values an enum accepts", () => {
    expect(described.procedures.tasks?.request.filter).toEqual({
      type: "enum",
      enum: ["all", "queued"],
      required: false,
    });
  });

  it("stops at a type that refers to itself", () => {
    expect(described.procedures.tasks?.response["rows[].next"]).toEqual({ type: "recursive" });
  });
});

describe("classifying a dashboard/v1 change", () => {
  const promised = surface({
    tasks: {
      mutation: false,
      request: {
        filter: { type: "enum", enum: ["all", "queued"], required: false },
        page: { type: "integer", required: false },
      },
      response: { capturedAt: { type: "string" }, "rows[].id": { type: "string" } },
    },
  });

  it("passes an addition", () => {
    const current = surface({
      ...promised.procedures,
      tasks: {
        mutation: false,
        request: {
          ...promised.procedures.tasks?.request,
          search: { type: "string", required: false },
        },
        response: {
          ...promised.procedures.tasks?.response,
          "rows[].priority": { type: "number" },
        },
      },
      workers: { mutation: false, request: {}, response: {} },
    });
    expect(classifyDashboardSurface(promised, current)).toEqual([]);
  });

  it("names a removed procedure", () => {
    expect(classifyDashboardSurface(promised, surface({}))).toEqual([
      { classification: "breaking", subject: "procedure tasks", change: "removed" },
    ]);
  });

  it("names a removed and a retyped response field", () => {
    const current = surface({
      tasks: {
        mutation: false,
        request: promised.procedures.tasks?.request ?? {},
        response: { "rows[].id": { type: "number" } },
      },
    });
    expect(classifyDashboardSurface(promised, current)).toEqual([
      { classification: "breaking", subject: "response field tasks.capturedAt", change: "removed" },
      {
        classification: "breaking",
        subject: "response field tasks.rows[].id",
        change: "type string became number",
      },
    ]);
  });

  it("names tightened request validation", () => {
    const current = surface({
      tasks: {
        mutation: false,
        request: {
          filter: { type: "enum", enum: ["all"], required: false },
          page: { type: "integer", required: true },
          queue: { type: "string", required: true },
        },
        response: promised.procedures.tasks?.response ?? {},
      },
    });
    expect(classifyDashboardSurface(promised, current).map((finding) => finding.change)).toEqual([
      "no longer accepts queued",
      "became required",
      "is a new required field",
    ]);
  });

  it("names a query that became a mutation, because a caller now needs a matching Origin", () => {
    const current = surface({
      tasks: { ...(promised.procedures.tasks ?? surface({}).procedures.tasks!), mutation: true },
    });
    expect(classifyDashboardSurface(promised, current)).toContainEqual({
      classification: "breaking",
      subject: "procedure tasks",
      change: "became a mutation, so a caller now needs a matching Origin",
    });
  });

  it("keeps a promise the router dropped, so the next check still reports it", () => {
    expect(mergeDashboardSurface(promised, surface({})).procedures.tasks).toEqual(
      promised.procedures.tasks,
    );
  });
});

it("promises every procedure the committed dashboard/v1 contract serves", async () => {
  const contract = JSON.parse(
    await readFile(join(artifactDirectory, "procedures.json"), "utf8"),
  ) as Parameters<typeof describeDashboardSurface>[0];
  const promised = JSON.parse(
    await readFile(join(artifactDirectory, "governed-surface.json"), "utf8"),
  ) as DashboardSurface;
  const current = describeDashboardSurface(contract);
  expect(classifyDashboardSurface(promised, current)).toEqual([]);
  expect(
    mergeDashboardSurface(promised, current),
    "dashboard/v1/governed-surface.json is stale; run pnpm dashboard-spec:generate",
  ).toEqual(promised);
});
