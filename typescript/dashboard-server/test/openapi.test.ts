import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  composeDashboardOpenApi,
  procedureDocs,
  type DashboardConformance,
  type DashboardManifest,
  type DashboardProcedures,
} from "../spec/openapi.js";

const artifactDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dashboard",
  "v1",
);

function readArtifact<T>(name: string): T {
  return JSON.parse(readFileSync(join(artifactDirectory, name), "utf8")) as T;
}

type Json = Record<string, unknown>;

interface Operation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  "x-workhorse-mutation": boolean;
  requestBody: { content: Record<string, { schema: Json; examples: Record<string, Json> }> };
  responses: Record<string, Json>;
}

interface OpenApiDocument {
  openapi: string;
  jsonSchemaDialect: string;
  servers: { url: string; variables: Record<string, { default: string }> }[];
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Json>; responses: Record<string, Json> };
}

const document = readArtifact<OpenApiDocument>("openapi.json");
const manifest = readArtifact<DashboardManifest>("manifest.json");
const procedures = readArtifact<DashboardProcedures>("procedures.json");
const conformance = readArtifact<DashboardConformance>("conformance.json");
const procedureNames = Object.keys(manifest.procedures);
const operations = procedureNames.map((name) => {
  const item = document.paths[procedures.procedures[name]!.path]!;
  return { name, item, operation: item.post! };
});
const handWrittenSchemas = ["ErrorEnvelope", "HostError", "ValidationIssue"];

function collect(value: unknown, key: string, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, key, found);
  } else if (value && typeof value === "object") {
    for (const [entryKey, entry] of Object.entries(value)) {
      if (entryKey === key) found.push(typeof entry === "string" ? entry : JSON.stringify(entry));
      collect(entry, key, found);
    }
  }
  return found;
}

function resolves(reference: string): boolean {
  let cursor: unknown = document;
  for (const segment of reference.replace(/^#\//, "").split("/")) {
    if (!cursor || typeof cursor !== "object") return false;
    cursor = (cursor as Json)[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return cursor !== undefined;
}

describe("dashboard/v1/openapi.json", () => {
  it("is an OpenAPI 3.1 document in the 2020-12 dialect", () => {
    expect(document.openapi).toMatch(/^3\.1\.\d+$/);
    expect(document.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(document.servers[0]!.url).toBe("{origin}{basePath}");
    expect(document.servers[0]!.variables.basePath!.default).toBe("/workhorse");
  });

  it("describes exactly the manifest's procedures at their contract paths", () => {
    expect(Object.keys(document.paths)).toEqual(
      procedureNames.map((name) => procedures.procedures[name]!.path),
    );
    for (const { item } of operations) expect(Object.keys(item)).toEqual(["post"]);
  });

  it("gives every operation a unique, valid operationId and prose", () => {
    const ids = operations.map(({ operation }) => operation.operationId);
    expect(ids).toEqual(procedureNames.map((name) => `dashboard_${name}`));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    for (const { operation } of operations) {
      expect(operation.summary.length).toBeGreaterThan(0);
      expect(operation.description.length).toBeGreaterThan(0);
    }
  });

  it("tags each operation by the manifest's mutation flag", () => {
    for (const { name, operation } of operations) {
      const { mutation } = manifest.procedures[name]!;
      expect(operation["x-workhorse-mutation"]).toBe(mutation);
      expect(operation.tags).toEqual([mutation ? "mutations" : "reads"]);
    }
  });

  it("types the request and the 200 response of every operation", () => {
    for (const { operation } of operations) {
      expect(operation.requestBody.content["application/json"]!.schema).toBeDefined();
      const success = operation.responses["200"] as { content: Record<string, { schema: Json }> };
      expect(success.content["application/json"]!.schema).toBeDefined();
    }
  });

  it("lists every host and envelope error on every operation", () => {
    for (const { name, operation } of operations) {
      expect(Object.keys(operation.responses)).toEqual([
        "200",
        "400",
        "401",
        "403",
        "404",
        "405",
        "500",
        "503",
      ]);
      const forbidden = operation.responses["403"] as { $ref: string };
      expect(forbidden.$ref).toBe(
        `#/components/responses/${manifest.procedures[name]!.mutation ? "MutationForbidden" : "Forbidden"}`,
      );
      const notFound = operation.responses["404"] as { $ref: string };
      expect(notFound.$ref).toBe(
        `#/components/responses/${procedureDocs[name as keyof typeof procedureDocs].notFound ? "NotFound" : "UnknownWorkspace"}`,
      );
    }
  });

  it("resolves every reference under components and leaves no JSON Schema document keywords", () => {
    const references = collect(document, "$ref");
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((reference) => !reference.startsWith("#/components/"))).toEqual([]);
    expect(references.filter((reference) => !resolves(reference))).toEqual([]);
    expect(collect(document, "$defs")).toEqual([]);
    expect(collect(document, "$schema")).toEqual([]);
    expect(collect(document, "$type")).toEqual([]);
  });

  it("carries every shared wire type and the three hand-written schemas, all referenced", () => {
    const names = Object.keys(document.components.schemas);
    expect(names).toEqual([...Object.keys(procedures.$defs), ...handWrittenSchemas]);
    const referenced = new Set(
      collect(document, "$ref")
        .filter((reference) => reference.startsWith("#/components/schemas/"))
        .map((reference) => reference.slice("#/components/schemas/".length)),
    );
    expect(names.filter((name) => !referenced.has(name))).toEqual([]);
  });

  it("gives every operation a concrete request and response example", () => {
    for (const { operation } of operations) {
      const request = operation.requestBody.content["application/json"]!.examples;
      const success = operation.responses["200"] as {
        content: Record<string, { examples: Record<string, Json> }>;
      };
      const response = success.content["application/json"]!.examples;
      for (const examples of [request, response]) {
        const values = Object.values(examples);
        expect(values.length).toBeGreaterThan(0);
        for (const example of values) {
          expect(example.value).toBeDefined();
          expect(collect(example.value, "$ref")).toEqual([]);
          expect(collect(example.value, "$type")).toEqual([]);
        }
      }
    }
  });

  it("documents NOT_FOUND on exactly the procedures the fixtures prove throw it", () => {
    const exchanges = conformance.scenarios.flatMap((scenario) => scenario.exchanges ?? []);
    const notFoundProcedures = new Set(
      exchanges.filter((exchange) => exchange.expect.status === 404).map((e) => e.procedure),
    );
    expect(notFoundProcedures.size).toBeGreaterThan(0);
    const undocumented = [...notFoundProcedures].filter(
      (name) => procedureDocs[name as keyof typeof procedureDocs].notFound === undefined,
    );
    expect(undocumented).toEqual([]);
  });
});

describe("composeDashboardOpenApi", () => {
  const input = { manifest, procedures, conformance };

  it("reproduces the committed document", () => {
    expect(composeDashboardOpenApi(input)).toBe(
      readFileSync(join(artifactDirectory, "openapi.json"), "utf8"),
    );
  });

  it("refuses a docs table that misses a procedure", () => {
    const { meta: _meta, ...docs } = procedureDocs;
    expect(() => composeDashboardOpenApi({ ...input, docs })).toThrow(/missing meta/);
  });

  it("refuses a docs table with an orphaned entry", () => {
    const docs = { ...procedureDocs, retired: { summary: "Gone", description: "Gone." } };
    expect(() => composeDashboardOpenApi({ ...input, docs })).toThrow(/orphaned retired/);
  });
});
