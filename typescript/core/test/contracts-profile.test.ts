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

  it("still rejects a keyword value that the Draft 2020-12 meta-schema forbids", () => {
    expect(() => compileContractSchema({ type: "string", minLength: -1 })).toThrow(/minLength/);
  });

  it("names the pattern that uses a backreference", () => {
    expect(() =>
      compileContractSchema({ properties: { a: { type: "string", pattern: "^(a)\\1$" } } }),
    ).toThrow("$.properties.a.pattern uses a backreference, which is outside the Workhorse");
    expect(() => compileContractSchema({ patternProperties: { "^(?<x>a)\\k<x>$": true } })).toThrow(
      "$.patternProperties.^(?<x>a)\\k<x>$ uses a backreference",
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-finite number %s, which JSON would store as null",
    (value) => {
      const number = compileContractSchema({ type: "number" });
      const nested = compileContractSchema({
        type: "object",
        properties: { count: { type: "number" } },
      });
      expect(number(value as Json)).toBe(false);
      expect(nested({ count: value } as Json)).toBe(false);
      expect(nested({ count: 1 })).toBe(true);
    },
  );

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
