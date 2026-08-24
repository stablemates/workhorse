import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { compileContractSchema } from "../src/contract-schema.js";
import type { Json } from "../src/types.js";

interface Fixture {
  id: string;
  schema: Json;
  schemaError?: boolean;
  instances?: { value: Json; valid: boolean }[];
}

const fixtures = JSON.parse(
  await readFile(new URL("../../../protocol/v1/contracts.json", import.meta.url), "utf8"),
) as Fixture[];

describe("contract schema profile", () => {
  it("reuses a compiled validator for the same schema object", () => {
    const schema = { type: "object" } as const;
    expect(compileContractSchema(schema)).toBe(compileContractSchema(schema));
  });

  it.each(fixtures)("matches the shared table for $id", (fixture) => {
    let validator: ReturnType<typeof compileContractSchema> | undefined;
    let schemaError: unknown;
    try {
      validator = compileContractSchema(fixture.schema);
    } catch (error) {
      schemaError = error;
    }
    expect(schemaError === undefined).toBe(!fixture.schemaError);
    if (validator === undefined) return;
    for (const instance of fixture.instances ?? []) {
      expect(validator(instance.value)).toBe(instance.valid);
    }
  });
});
