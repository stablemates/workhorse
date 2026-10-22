import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import type { Json } from "./types.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_MAP_KEYWORDS = new Set(["$defs", "dependentSchemas", "properties"]);
const ANNOTATION_KEYWORDS = new Set([
  "$comment",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "format",
  "readOnly",
  "title",
  "writeOnly",
]);
const VALIDATION_KEYWORDS = new Set([
  "const",
  "dependentRequired",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maxContains",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
  "required",
  "type",
  "uniqueItems",
]);
// Ajv strict mode adds Ajv-only lint rules, such as union types, tuple bounds, and `then` without
// `if`. Those rules narrow the shared profile, so they stay off. The whitelist above still rejects
// unknown keywords, and Ajv still validates each schema against the Draft 2020-12 meta-schema.
// `strictNumbers` is an instance rule, not a lint rule: it keeps NaN and the infinities out of a
// number, since JSON.stringify would store them as a contract-invalid null.
const DEFINITION_NAME = /^[A-Za-z_][-A-Za-z0-9._]*$/;
const DEFINITION_REFERENCE_PREFIX = "#/$defs/";
const ajv = new Ajv2020({ strict: false, strictNumbers: true, validateFormats: false });
// A contract compares the decimal of each number exactly. An instance number is the decimal that
// JSON.stringify writes to PostgreSQL. A schema number is its own decimal text, which a schema read
// from PostgreSQL keeps through parseStoredContractSchema. Ajv compares and divides doubles, so
// these keywords compare the decimals instead.
for (const [keyword, holds] of [
  ["minimum", (order: number) => order >= 0],
  ["maximum", (order: number) => order <= 0],
  ["exclusiveMinimum", (order: number) => order > 0],
  ["exclusiveMaximum", (order: number) => order < 0],
] as const) {
  ajv.removeKeyword(keyword);
  ajv.addKeyword({
    keyword,
    type: "number",
    schemaType: "number",
    errors: false,
    compile: (bound: number, parentSchema: object) => {
      const limit = exactNumber(parentSchema, keyword, bound);
      return (value: number) =>
        Number.isFinite(value) && holds(compareDecimals(decimal(value), limit));
    },
  });
}
ajv.removeKeyword("multipleOf");
ajv.addKeyword({
  keyword: "multipleOf",
  type: "number",
  schemaType: "number",
  errors: false,
  compile: (divisor: number, parentSchema: object) => {
    const unit = exactNumber(parentSchema, "multipleOf", divisor);
    return (value: number) => isDecimalMultiple(value, unit);
  },
});
ajv.removeKeyword("const");
ajv.addKeyword({
  keyword: "const",
  errors: false,
  compile: (_constant: Json, parentSchema: object) => {
    const expected = exactValue(parentSchema, "const");
    return (value: Json) => equalsExact(expected, value);
  },
});
ajv.removeKeyword("enum");
ajv.addKeyword({
  keyword: "enum",
  schemaType: "array",
  errors: false,
  compile: (_values: Json[], parentSchema: object) => {
    const candidates = exactValue(parentSchema, "enum") as ExactJson[];
    return (value: Json) => candidates.some((expected) => equalsExact(expected, value));
  },
});
const objectValidators = new WeakMap<object, ValidateFunction<Json>>();
const booleanValidators = new Map<boolean, ValidateFunction<Json>>();

// The decimal text of each number in a stored schema that a double cannot hold, by its container
// object or array and its key there.
const exactNumberTexts = new WeakMap<object, Map<string, string>>();

/**
 * Reads the JSON text of a schema that PostgreSQL stores, and keeps every number exact.
 *
 * jsonb keeps all the digits of a number that another SDK synchronized. The parsed schema holds the
 * nearest double, and the contract keywords compare the decimal text instead.
 */
export function parseStoredContractSchema(text: string): Json {
  return JSON.parse(text, function (this: object, key, value: unknown, context?: SourceContext) {
    const source = context?.source;
    if (typeof value !== "number" || source === undefined) return value;
    const exact = parseDecimal(source);
    // Ajv checks the schema against the meta-schema, so the double keeps the sign of the token
    // and stays finite and non-zero. The keywords read the exact text instead.
    const held = !Number.isFinite(value)
      ? Math.sign(value) * Number.MAX_VALUE
      : value === 0 && exact.digits !== 0n
        ? (exact.digits < 0n ? -1 : 1) * Number.MIN_VALUE
        : value;
    if (compareDecimals(decimal(held), exact) !== 0) {
      let texts = exactNumberTexts.get(this);
      if (texts === undefined) exactNumberTexts.set(this, (texts = new Map()));
      texts.set(key, source);
    }
    return held;
  } as Parameters<typeof JSON.parse>[1]) as Json;
}

interface SourceContext {
  readonly source?: string;
}

class Decimal {
  // The value is digits times ten to the power of exponent. Digits has no trailing zero.
  constructor(
    readonly digits: bigint,
    readonly exponent: number,
  ) {}
}

type ExactJson = null | boolean | string | Decimal | ExactJson[] | Map<string, ExactJson>;

function normalized(digits: bigint, exponent: number): Decimal {
  if (digits === 0n) return new Decimal(0n, 0);
  while (digits % 10n === 0n) {
    digits /= 10n;
    exponent += 1;
  }
  return new Decimal(digits, exponent);
}

const NUMBER_TEXT = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

// The exact value of a JSON number token.
function parseDecimal(text: string): Decimal {
  const match = NUMBER_TEXT.exec(text);
  if (match === null) throw new TypeError(`${text} is not a JSON number`);
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
  return normalized(BigInt(sign + whole + fraction), Number(exponent) - fraction.length);
}

// The shortest decimal that reads back as the double, which JSON.stringify writes.
function decimal(value: number): Decimal {
  return parseDecimal(String(value));
}

function compareDecimals(left: Decimal, right: Decimal): number {
  const shift = left.exponent - right.exponent;
  const a = shift > 0 ? left.digits * 10n ** BigInt(shift) : left.digits;
  const b = shift < 0 ? right.digits * 10n ** BigInt(-shift) : right.digits;
  return a < b ? -1 : a > b ? 1 : 0;
}

function exactNumber(container: object, key: string, value: number): Decimal {
  const text = exactNumberTexts.get(container)?.get(key);
  return text === undefined ? decimal(value) : parseDecimal(text);
}

// The keyword value of a schema, with each number as its exact decimal.
function exactValue(container: object, key: string): ExactJson {
  const value = (container as Record<string, Json>)[key]!;
  if (typeof value === "number") return exactNumber(container, key, value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((_item, index) => exactValue(value, String(index)));
  return new Map(Object.keys(value).map((name) => [name, exactValue(value, name)]));
}

// JSON equality: 1 equals 1.0, and two numbers are equal when their decimals are equal.
function equalsExact(expected: ExactJson, value: Json): boolean {
  if (expected instanceof Decimal) {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      compareDecimals(decimal(value), expected) === 0
    );
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(value) &&
      value.length === expected.length &&
      expected.every((item, index) => equalsExact(item, value[index]!))
    );
  }
  if (expected instanceof Map) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const names = Object.keys(value);
    return (
      names.length === expected.size &&
      names.every((name) => expected.has(name) && equalsExact(expected.get(name)!, value[name]!))
    );
  }
  return expected === value;
}

function isDecimalMultiple(value: number, unit: Decimal): boolean {
  if (!Number.isFinite(value) || unit.digits <= 0n) return false;
  const dividend = decimal(value);
  const shift = dividend.exponent - unit.exponent;
  return shift >= 0
    ? (dividend.digits * 10n ** BigInt(shift)) % unit.digits === 0n
    : dividend.digits % (unit.digits * 10n ** BigInt(-shift)) === 0n;
}

interface SchemaReference {
  readonly path: string;
  readonly reference: string;
}

// A reference names the root schema or one root definition. The validators behind the six SDKs
// resolve those two forms alike, and both name a schema position the profile walk checked.
function assertContractSchema(schema: Json): void {
  const references: SchemaReference[] = [];
  visitSchema(schema, "$", references);
  for (const { path, reference } of references) {
    if (!referencesSubschema(schema, reference)) {
      throw new TypeError(`${path} must point at a subschema of the contract`);
    }
  }
}

function referencesSubschema(root: Json, reference: string): boolean {
  if (reference === "#") return true;
  if (!reference.startsWith(DEFINITION_REFERENCE_PREFIX)) return false;
  if (root === null || typeof root !== "object" || Array.isArray(root)) return false;
  // The profile walk visits own keys only, so an inherited `$defs` was never checked.
  if (!Object.hasOwn(root, "$defs")) return false;
  const definitions = root["$defs"];
  if (definitions === null || typeof definitions !== "object" || Array.isArray(definitions)) {
    return false;
  }
  return Object.hasOwn(definitions, reference.slice(DEFINITION_REFERENCE_PREFIX.length));
}

function visitSchema(schema: Json, path: string, references: SchemaReference[]): void {
  if (typeof schema === "boolean") return;
  if (schema === null || Array.isArray(schema) || typeof schema !== "object") {
    throw new TypeError(`${path} must be an object or boolean JSON Schema`);
  }
  for (const [keyword, value] of Object.entries(schema)) {
    const keywordPath = `${path}.${keyword}`;
    if (keyword === "$ref") {
      if (typeof value !== "string" || !value.startsWith("#")) {
        throw new TypeError(`${keywordPath} must be a bundled local reference`);
      }
      references.push({ path: keywordPath, reference: value });
    } else if (keyword === "$schema") {
      if (value !== DIALECT) throw new TypeError(`${keywordPath} must select Draft 2020-12`);
    } else if (keyword === "$defs" && path !== "$") {
      throw new TypeError(`${keywordPath} must appear only on the root schema`);
    } else if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
      visitSchema(value, keywordPath, references);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
      if (!Array.isArray(value)) throw new TypeError(`${keywordPath} must be an array`);
      value.forEach((entry, index) => visitSchema(entry, `${keywordPath}[${index}]`, references));
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
      if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${keywordPath} must be an object`);
      }
      for (const [name, child] of Object.entries(value)) {
        if (keyword === "$defs" && !DEFINITION_NAME.test(name)) {
          throw new TypeError(
            `${keywordPath}.${name} must be a definition name matching ${DEFINITION_NAME.source}`,
          );
        }
        visitSchema(child, `${keywordPath}.${name}`, references);
      }
    } else if (!ANNOTATION_KEYWORDS.has(keyword) && !VALIDATION_KEYWORDS.has(keyword)) {
      throw new TypeError(`${keywordPath} is outside the Workhorse contract profile`);
    }
  }
}

export function compileContractSchema(schema: Json): ValidateFunction<Json> {
  if (typeof schema === "boolean") {
    const cached = booleanValidators.get(schema);
    if (cached !== undefined) return cached;
    assertContractSchema(schema);
    const validator = ajv.compile<Json>(schema);
    booleanValidators.set(schema, validator);
    return validator;
  }
  if (schema === null || Array.isArray(schema) || typeof schema !== "object") {
    assertContractSchema(schema);
  }
  const schemaObject = schema as object;
  const cached = objectValidators.get(schemaObject);
  if (cached !== undefined) return cached;
  assertContractSchema(schema);
  const validator = ajv.compile<Json>(schema as AnySchema);
  objectValidators.set(schemaObject, validator);
  return validator;
}
