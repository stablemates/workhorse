import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pythonDeclarations } from "../spec/generate-bindings.js";

type Schema = Record<string, unknown>;

const proceduresPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dashboard",
  "v1",
  "procedures.json",
);

async function taskRow(): Promise<Schema> {
  const contract = JSON.parse(await readFile(proceduresPath, "utf8")) as {
    $defs: Record<string, Schema>;
  };
  const row = contract.$defs.DashboardTaskRow;
  if (row === undefined) throw new Error("procedures.json has no DashboardTaskRow");
  return row;
}

function retryPolicyBranches(row: Schema): Schema[] {
  const properties = row.properties as Record<string, Schema>;
  return properties.retryPolicy!.anyOf as Schema[];
}

function withRetryPolicyBranches(row: Schema, branches: Schema[]): Schema {
  const properties = row.properties as Record<string, Schema>;
  return {
    ...row,
    properties: { ...properties, retryPolicy: { ...properties.retryPolicy, anyOf: branches } },
  };
}

function declarations(row: Schema): Map<string, string> {
  return new Map(pythonDeclarations([["DashboardTaskRow", row]]));
}

const kind = (value: string): Schema => ({ type: "string", const: value });

const objectBranch = (properties: Record<string, Schema>, required: string[]): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

// SM-2040: a Python name of a union branch comes from its discriminator, not from its position.
describe("Python names of the dashboard/v1 union branches", () => {
  it("names each retry policy branch from its type", async () => {
    const names = [...declarations(await taskRow()).keys()].filter((name) =>
      name.startsWith("DashboardTaskRowRetryPolicy"),
    );
    expect(new Set(names)).toEqual(
      new Set([
        "DashboardTaskRowRetryPolicyDecorrelatedJitter",
        "DashboardTaskRowRetryPolicyExponential",
        "DashboardTaskRowRetryPolicyFixed",
      ]),
    );
  });

  it("keeps each existing name and its shape when a branch is added before the others", async () => {
    const row = await taskRow();
    const before = declarations(row);
    const added = objectBranch(
      { type: { type: "string", const: "linear" }, stepMs: { type: "integer" } },
      ["type", "stepMs"],
    );
    const after = declarations(withRetryPolicyBranches(row, [added, ...retryPolicyBranches(row)]));

    expect(after.get("DashboardTaskRowRetryPolicyLinear")).toContain("stepMs: Required[int]");
    const kept = [...before].filter(([name]) => name !== "DashboardTaskRow");
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.map(([name]) => [name, after.get(name)])).toEqual(kept);
  });

  it("stops on object branches that have no discriminator", async () => {
    const row = await taskRow();
    const loose = [
      objectBranch({ delayMs: { type: "integer" } }, ["delayMs"]),
      objectBranch({ baseMs: { type: "integer" } }, ["baseMs"]),
      { type: "null" },
    ];
    expect(() => declarations(withRetryPolicyBranches(row, loose))).toThrow(
      /DashboardTaskRowRetryPolicy: a union branch that declares a type needs a discriminator/,
    );
  });

  it("stops on a discriminator that two branches share or that one branch leaves optional", async () => {
    const row = await taskRow();
    const shared = [
      objectBranch({ type: kind("fixed"), delayMs: { type: "integer" } }, ["type"]),
      objectBranch({ type: kind("fixed"), baseMs: { type: "integer" } }, ["type"]),
    ];
    const optional = [
      objectBranch({ type: kind("fixed") }, ["type"]),
      objectBranch({ type: kind("exponential") }, []),
    ];
    expect(() => declarations(withRetryPolicyBranches(row, shared))).toThrow(
      /needs a discriminator/,
    );
    expect(() => declarations(withRetryPolicyBranches(row, optional))).toThrow(
      /needs a discriminator/,
    );
  });

  it("names a branch from an enum of one string, as z.enum writes it", async () => {
    const row = await taskRow();
    const added = objectBranch({ type: { type: "string", enum: ["linear"] } }, ["type"]);
    const names = [
      ...declarations(withRetryPolicyBranches(row, [added, ...retryPolicyBranches(row)])).keys(),
    ];
    expect(names).toContain("DashboardTaskRowRetryPolicyLinear");
    expect(names).toContain("DashboardTaskRowRetryPolicyExponential");
  });

  it("stops on a discriminator that is a number or an enum of two values", async () => {
    const row = await taskRow();
    const numeric = [
      objectBranch({ type: { type: "integer", const: 1 } }, ["type"]),
      objectBranch({ type: { type: "integer", const: 2 } }, ["type"]),
    ];
    const wide = [
      objectBranch({ type: { type: "string", enum: ["a", "b"] } }, ["type"]),
      objectBranch({ type: kind("c") }, ["type"]),
    ];
    expect(() => declarations(withRetryPolicyBranches(row, numeric))).toThrow(
      /needs a discriminator/,
    );
    expect(() => declarations(withRetryPolicyBranches(row, wide))).toThrow(/needs a discriminator/);
  });

  it("stops on a branch that declares a type inside an array", async () => {
    const row = await taskRow();
    const branches = [
      { type: "array", items: objectBranch({ delayMs: { type: "integer" } }, ["delayMs"]) },
      { type: "string" },
    ];
    expect(() => declarations(withRetryPolicyBranches(row, branches))).toThrow(
      /needs a discriminator/,
    );
  });

  it("names no type for a union of scalar branches", async () => {
    const row = await taskRow();
    const scalar = [
      { type: "string", const: "a" },
      { type: "string", const: "b" },
      { type: "null" },
    ];
    const names = [...declarations(withRetryPolicyBranches(row, scalar)).keys()];
    expect(names.filter((name) => name.startsWith("DashboardTaskRowRetryPolicy"))).toEqual([]);
  });
});
