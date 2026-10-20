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
// A contract compares the decimal that JSON.stringify writes to PostgreSQL, not the binary double.
// Ajv divides doubles, so `multipleOf: 0.01` refuses 1.15. The replacement divides the decimals.
ajv.removeKeyword("multipleOf");
ajv.addKeyword({
  keyword: "multipleOf",
  type: "number",
  schemaType: "number",
  errors: false,
  validate: (divisor: number, value: number) => isDecimalMultiple(value, divisor),
});
const objectValidators = new WeakMap<object, ValidateFunction<Json>>();
const booleanValidators = new Map<boolean, ValidateFunction<Json>>();

interface Decimal {
  readonly digits: bigint;
  readonly exponent: number;
}

// The shortest decimal that reads back as the double, as digits times a power of ten.
function decimal(value: number): Decimal {
  const [mantissa = "", exponentText = "0"] = String(value).split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  return {
    digits: BigInt(whole + fraction),
    exponent: Number(exponentText) - fraction.length,
  };
}

function isDecimalMultiple(value: number, divisor: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) return false;
  const dividend = decimal(value);
  const unit = decimal(divisor);
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
