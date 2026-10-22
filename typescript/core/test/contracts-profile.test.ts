import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { compileContractSchema, parseStoredContractSchema } from "../src/contract-schema.js";
import type { Json } from "../src/types.js";

interface Fixture {
  id: string;
  schema?: Json;
  schemaJson?: string;
  schemaError?: boolean;
  instances?: { value?: Json; json?: string; needs?: NumberNeed; valid: boolean }[];
}

type NumberNeed = "exactFraction" | "exactInteger";

// A TypeScript value holds every number as a double, so it cannot hold a fraction or an integer
// that a double cannot hold. The shared table marks those instances.
const UNHELD_NUMBERS = new Set<NumberNeed>(["exactFraction", "exactInteger"]);

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

  it("names the pattern keyword it refuses at any depth", () => {
    expect(() =>
      compileContractSchema({ properties: { a: { type: "string", pattern: "^a$" } } }),
    ).toThrow("$.properties.a.pattern is outside the Workhorse contract profile");
    expect(() => compileContractSchema({ items: { patternProperties: { "^a": true } } })).toThrow(
      "$.items.patternProperties is outside the Workhorse contract profile",
    );
  });

  it("refuses a reference that leaves the profile-checked schema tree", () => {
    expect(() =>
      compileContractSchema({
        default: { pattern: "^a$" },
        properties: { a: { $ref: "#/default" } },
      }),
    ).toThrow("$.properties.a.$ref must point at a subschema of the contract");
  });

  it("refuses a reference to an inherited root definition the profile walk never checked", () => {
    const inherited = Object.create({
      $defs: { a: { type: "string", pattern: "^a$" } },
    }) as Record<string, Json>;
    inherited["$ref"] = "#/$defs/a";
    expect(() => compileContractSchema(inherited)).toThrow(
      "$.$ref must point at a subschema of the contract",
    );
  });

  it("names the anchor and definition forms outside the profile", () => {
    expect(() => compileContractSchema({ items: { $anchor: "a" } })).toThrow(
      "$.items.$anchor is outside the Workhorse contract profile",
    );
    expect(() => compileContractSchema({ items: { $defs: {} } })).toThrow(
      "$.items.$defs must appear only on the root schema",
    );
    expect(() => compileContractSchema({ $defs: { "a b": true } })).toThrow(
      "$.$defs.a b must be a definition name matching ^[A-Za-z_][-A-Za-z0-9._]*$",
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

  it("divides the decimals of numbers that JSON writes with an exponent", () => {
    const tiny = compileContractSchema({ multipleOf: 1e-8 });
    expect(tiny(3e-7)).toBe(true);
    expect(tiny(3.5e-8)).toBe(false);
    expect(compileContractSchema({ multipleOf: 0.1 })(1e21)).toBe(true);
    expect(compileContractSchema({ multipleOf: 3 })(-2.5)).toBe(false);
    expect(compileContractSchema({ multipleOf: 0.5 })(-2.5)).toBe(true);
  });

  it("keeps each stored schema number that a double cannot hold as its decimal", () => {
    const stored = parseStoredContractSchema(
      '{"$defs": {"limit": {"maximum": 9007199254740995}}, "$ref": "#/$defs/limit"}',
    );
    const validator = compileContractSchema(stored);
    expect(validator(9007199254740994)).toBe(true);
    expect(validator(9007199254740996)).toBe(false);
    expect(compileContractSchema(parseStoredContractSchema('{"maximum": 1.0}'))(1)).toBe(true);
    const exponent = compileContractSchema(parseStoredContractSchema('{"minimum": 1E-400}'));
    expect(exponent(0)).toBe(false);
    expect(exponent(5e-324)).toBe(true);
  });

  it("compares a stored constant inside an object or an array as its decimal", () => {
    const validator = compileContractSchema(
      parseStoredContractSchema('{"const": {"n": [9007199254740993, 0.10]}}'),
    );
    expect(validator({ n: [9007199254740992, 0.1] })).toBe(false);
    expect(compileContractSchema(parseStoredContractSchema('{"const": [0.10]}'))([0.1])).toBe(true);
  });

  it.each(fixtures)("matches the shared table for $id", (fixture) => {
    let validator: ReturnType<typeof compileContractSchema> | undefined;
    let schemaError: unknown;
    try {
      // A schema in JSON text reads the way a schema that PostgreSQL stores does.
      validator = compileContractSchema(
        fixture.schemaJson === undefined
          ? fixture.schema!
          : parseStoredContractSchema(fixture.schemaJson),
      );
    } catch (error) {
      schemaError = error;
    }
    expect(schemaError === undefined).toBe(!fixture.schemaError);
    if (validator === undefined) return;
    for (const instance of fixture.instances ?? []) {
      if (instance.needs !== undefined && UNHELD_NUMBERS.has(instance.needs)) continue;
      const value =
        instance.json === undefined ? instance.value : (JSON.parse(instance.json) as Json);
      expect({ instance, valid: validator(value as Json) }).toEqual({
        instance,
        valid: instance.valid,
      });
    }
  });
});
