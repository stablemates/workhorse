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
  "required",
  "type",
  "uniqueItems",
]);
// Ajv strict mode adds Ajv-only lint rules, such as union types, tuple bounds, and `then` without
// `if`. Those rules narrow the shared profile, so they stay off. The whitelist above still rejects
// unknown keywords, and Ajv still validates each schema against the Draft 2020-12 meta-schema.
// `strictNumbers` is an instance rule, not a lint rule: it keeps NaN and the infinities out of a
// number, since JSON.stringify would store them as a contract-invalid null.
const ajv = new Ajv2020({ strict: false, strictNumbers: true, validateFormats: false });
const objectValidators = new WeakMap<object, ValidateFunction<Json>>();
const booleanValidators = new Map<boolean, ValidateFunction<Json>>();

interface SchemaWalk {
  readonly anchors: Set<string>;
  readonly references: { path: string; reference: string }[];
}

// Every reference must name a schema position the profile walk checked. A reference into `default`
// or `examples` would otherwise apply a schema the walk never saw.
function assertContractSchema(schema: Json): void {
  const walk: SchemaWalk = { anchors: new Set(), references: [] };
  visitSchema(schema, "$", walk);
  for (const { path, reference } of walk.references) {
    if (!referencesSubschema(schema, reference, walk.anchors)) {
      throw new TypeError(`${path} must point at a subschema of the contract`);
    }
  }
}

function referencesSubschema(root: Json, reference: string, anchors: Set<string>): boolean {
  const fragment = reference.slice(1);
  if (fragment === "") return true;
  if (!fragment.startsWith("/")) return anchors.has(fragment);
  let tokens: string[];
  try {
    tokens = fragment
      .split("/")
      .slice(1)
      .map((token) => decodeURIComponent(token));
  } catch {
    return false;
  }
  // Libraries disagree on whether `%2F` separates tokens, so the walk could check a different schema.
  if (tokens.some((token) => token.includes("/"))) return false;
  tokens = tokens.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  let node: Json | undefined = root;
  for (let index = 0; index < tokens.length; index += 1) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
    const keyword = tokens[index] as string;
    const value: Json | undefined = Object.hasOwn(node, keyword) ? node[keyword] : undefined;
    if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
      node = value;
    } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
      index += 1;
      const entry = tokens[index];
      if (entry === undefined || !/^(0|[1-9][0-9]*)$/.test(entry)) return false;
      node = value[Number(entry)];
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && value !== null && typeof value === "object") {
      index += 1;
      const name = tokens[index];
      if (name === undefined || Array.isArray(value) || !Object.hasOwn(value, name)) return false;
      node = value[name];
    } else {
      return false;
    }
    if (node === undefined) return false;
  }
  return true;
}

function visitSchema(schema: Json, path: string, walk: SchemaWalk): void {
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
      walk.references.push({ path: keywordPath, reference: value });
    } else if (keyword === "$anchor") {
      if (typeof value === "string") walk.anchors.add(value);
    } else if (keyword === "$schema") {
      if (value !== DIALECT) throw new TypeError(`${keywordPath} must select Draft 2020-12`);
    } else if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
      visitSchema(value, keywordPath, walk);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) {
      if (!Array.isArray(value)) throw new TypeError(`${keywordPath} must be an array`);
      value.forEach((entry, index) => visitSchema(entry, `${keywordPath}[${index}]`, walk));
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
      if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${keywordPath} must be an object`);
      }
      for (const [name, child] of Object.entries(value)) {
        visitSchema(child, `${keywordPath}.${name}`, walk);
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
