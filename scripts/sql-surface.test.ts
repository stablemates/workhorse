import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSqlSchema } from "./sql-surface.js";
import {
  classifyGovernedSurface,
  deriveGovernedSurface,
  mergeGovernedSurface,
  readSurfaceSources,
  type GovernedSurface,
} from "./sql-governed-surface.js";

const repository = path.resolve(import.meta.dirname, "..");

const schemaText = await readFile(path.join(repository, "sql/schema/current.sql"), "utf8");
const schema = parseSqlSchema(schemaText);

function surface(overrides: Partial<GovernedSurface> = {}): GovernedSurface {
  return {
    formatVersion: 1,
    functions: {},
    relations: {},
    internalHelpers: { functions: [], relations: [] },
    ...overrides,
  };
}

describe("parsing the installed schema", () => {
  it("reads a function's argument types, defaults, and table result", () => {
    expect(schema.functions.get("claim_v1")?.[0]).toMatchObject({
      arguments: [
        { name: "p_queue_name", type: "text", optional: false },
        { name: "p_worker_id", type: "text", optional: false },
        { name: "p_lease_ms", type: "integer", optional: true },
      ],
    });
    expect(schema.functions.get("claim_v1")?.[0]?.returns).toContain("fence_token bigint");
  });

  it("reads a view's projected columns and resolves their types through the table", () => {
    expect([...(schema.relations.get("dashboard_queue_control_v1")?.columns ?? [])]).toEqual([
      ["queue_name", "text"],
      ["paused", "boolean"],
    ]);
  });

  it("resolves a projected function call to the function's return type", () => {
    expect(schema.relations.get("dashboard_job_v1")?.columns.get("payload")).toBe("jsonb");
  });

  it("copies the column list a LIKE clause inherits", () => {
    expect(schema.relations.get("job_stat_bucket_day")?.columns).toEqual(
      schema.relations.get("job_stat_bucket_hour")?.columns,
    );
  });

  it("ignores the CREATE TABLE statements that only run inside a function body", () => {
    expect(schemaText).toContain("CREATE TABLE workhorse.%I PARTITION OF workhorse.job_event");
    expect([...schema.relations.keys()].filter((name) => name.includes("%"))).toEqual([]);
  });

  it("resolves every governed view column to a declared type", () => {
    const unresolved = [...schema.relations.values()]
      .filter((relation) => relation.kind === "view")
      .flatMap((relation) =>
        [...relation.columns]
          .filter(([, type]) => type === "unknown")
          .map(([column]) => `${relation.name}.${column}`),
      );
    expect(unresolved).toEqual([]);
  });
});

describe("deriving the governed set", () => {
  const derived = deriveGovernedSurface(schema, [
    { filename: "reader.sql", text: "SELECT paused FROM workhorse.queue_control" },
  ]);

  it("governs a relation a reader names, and only the columns that reader mentions", () => {
    expect(derived.relations.queue_control).toEqual({
      kind: "table",
      columns: { paused: "boolean" },
    });
  });

  it("governs every column of a published dashboard view without any reader", () => {
    expect(derived.relations.dashboard_queue_control_v1?.columns).toEqual({
      paused: "boolean",
      queue_name: "text",
    });
  });

  it("records what no supported release reads as an internal helper", () => {
    expect(derived.internalHelpers.functions).toContain("uuid_v7_v1");
    expect(derived.internalHelpers.relations).toContain("schema_migration");
    expect(derived.internalHelpers.functions).not.toContain("dashboard_job_result_v1");
  });
});

describe("classifying a governed SQL change", () => {
  const promised = surface({
    functions: {
      purge_queue_v1: { arguments: ["text", "integer?"], returns: "integer" },
      list_jobs_v1: {
        arguments: ["jsonb"],
        returns: "table",
        returnsColumns: { job_id: "uuid", state: "text" },
      },
    },
    relations: { dashboard_queue_control_v1: { kind: "view", columns: { paused: "boolean" } } },
  });

  it("passes an addition", () => {
    const current = mergeGovernedSurface(
      promised,
      surface({
        functions: {
          ...promised.functions,
          redrive_v2: { arguments: ["uuid"], returns: "boolean" },
          purge_queue_v1: { arguments: ["text", "integer?", "boolean?"], returns: "integer" },
        },
        relations: {
          dashboard_queue_control_v1: {
            kind: "view",
            columns: { paused: "boolean", queue_name: "text" },
          },
        },
      }),
    );
    expect(classifyGovernedSurface(promised, current)).toEqual([]);
  });

  it("names a removed function", () => {
    const current = surface({ functions: {}, relations: promised.relations });
    expect(classifyGovernedSurface(promised, current)).toContainEqual({
      classification: "breaking",
      subject: "function workhorse.purge_queue_v1",
      change: "removed",
    });
  });

  it("names a retyped argument and an argument that lost its default", () => {
    const current = surface({
      functions: {
        ...promised.functions,
        purge_queue_v1: { arguments: ["uuid", "integer"], returns: "integer" },
      },
    });
    const findings = classifyGovernedSurface(promised, current).map((finding) => finding.change);
    expect(findings).toContain("argument 1 changed from text to uuid");
  });

  it("names an argument that stops accepting the shorter call", () => {
    const current = surface({
      functions: {
        ...promised.functions,
        purge_queue_v1: { arguments: ["text", "integer"], returns: "integer" },
      },
    });
    expect(classifyGovernedSurface(promised, current)).toContainEqual({
      classification: "breaking",
      subject: "function workhorse.purge_queue_v1",
      change: "argument 2 (integer) lost its default",
    });
  });

  it("names a removed or retyped result column", () => {
    const current = surface({
      functions: {
        ...promised.functions,
        list_jobs_v1: {
          arguments: ["jsonb"],
          returns: "table",
          returnsColumns: { job_id: "text" },
        },
      },
    });
    const changes = classifyGovernedSurface(promised, current).map((finding) => finding.change);
    expect(changes).toContain("output column job_id changed from uuid to text");
    expect(changes).toContain("output column state was removed");
  });

  it("names a removed view column", () => {
    const current = surface({
      functions: promised.functions,
      relations: { dashboard_queue_control_v1: { kind: "view", columns: {} } },
    });
    expect(classifyGovernedSurface(promised, current)).toContainEqual({
      classification: "breaking",
      subject: "view workhorse.dashboard_queue_control_v1",
      change: "column paused was removed",
    });
  });

  it("keeps a promise the current schema dropped, so the next check still reports it", () => {
    const merged = mergeGovernedSurface(promised, surface({ relations: promised.relations }));
    expect(merged.functions.purge_queue_v1).toEqual(promised.functions.purge_queue_v1);
  });
});

it("promises every governed function and column the installed schema still provides", async () => {
  const promised = JSON.parse(
    await readFile(path.join(repository, "protocol/v1/governed-surface.json"), "utf8"),
  ) as GovernedSurface;
  const current = deriveGovernedSurface(schema, await readSurfaceSources(repository));
  expect(classifyGovernedSurface(promised, current)).toEqual([]);
  expect(
    mergeGovernedSurface(promised, current),
    "protocol/v1/governed-surface.json is stale; run pnpm sql-catalogues:generate",
  ).toEqual(promised);
});
