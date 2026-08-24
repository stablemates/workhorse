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
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const ANNOTATION_KEYWORDS = new Set([
  "$anchor",
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
  "pattern",
  "required",
  "type",
  "uniqueItems",
]);
const ajv = new Ajv2020({ strict: true, validateFormats: false });
const objectValidators = new WeakMap<object, ValidateFunction<Json>>();
const booleanValidators = new Map<boolean, ValidateFunction<Json>>();

export function assertContractSchema(schema: Json): void {
  visitSchema(schema, "$");
}

function visitSchema(schema: Json, path: string): void {
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
    } else if (keyword === "$schema") {
      if (value !== DIALECT) throw new TypeError(`${keywordPath} must select Draft 2020-12`);
    } else if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
      visitSchema(value, keywordPath);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
      if (!Array.isArray(value)) throw new TypeError(`${keywordPath} must be an array`);
      value.forEach((entry, index) => visitSchema(entry, `${keywordPath}[${index}]`));
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
      if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${keywordPath} must be an object`);
      }
      for (const [name, child] of Object.entries(value))
        visitSchema(child, `${keywordPath}.${name}`);
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
