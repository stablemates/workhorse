/**
 * Classify a `dashboard/v1` change as additive or breaking.
 *
 * `procedures.json` is regenerated from the router, so a diff against it says only that the wire
 * contract moved. `governed-surface.json` is the promise instead: every procedure, request field,
 * and response field `dashboard/v1` has ever served. The generator may add to it and may never drop
 * from it, so removing a procedure from the router fails the check by name however faithfully the
 * regenerated artifacts follow.
 */

interface FieldShape {
  /** The JSON type, or a `|`-joined union when a field accepts several. */
  type: string;
  /** The accepted literal values, when validation restricts the field to a set. */
  enum?: string[];
}

interface RequestField extends FieldShape {
  required: boolean;
}

interface ProcedureSurface {
  mutation: boolean;
  request: Record<string, RequestField>;
  response: Record<string, FieldShape>;
}

export interface DashboardSurface {
  formatVersion: 1;
  procedures: Record<string, ProcedureSurface>;
}

export interface SurfaceFinding {
  classification: "breaking";
  subject: string;
  change: string;
}

interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

interface ProceduresDocument {
  procedures: Record<string, { mutation: boolean; input: JsonSchema | null; output: JsonSchema }>;
  $defs?: Record<string, JsonSchema>;
}

type Collected = Map<string, { shape: FieldShape; required: boolean }>;

function literal(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function resolve(schema: JsonSchema, definitions: Record<string, JsonSchema>): JsonSchema {
  const name = schema.$ref?.replace("#/$defs/", "");
  return name !== undefined ? (definitions[name] ?? schema) : schema;
}

/**
 * Flatten one JSON Schema into `path -> shape`, so a comparison names the field a reader lost
 * rather than the document that contains it. Object keys extend the path with `.key` and array
 * elements with `[]`, which is how a finding reads back to the caller.
 */
function collect(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
  path: string,
  required: boolean,
  seen: ReadonlySet<string>,
  into: Collected,
): void {
  const reference = schema.$ref;
  if (reference !== undefined) {
    if (seen.has(reference)) {
      into.set(path, { shape: { type: "recursive" }, required });
      return;
    }
    collect(
      resolve(schema, definitions),
      definitions,
      path,
      required,
      new Set(seen).add(reference),
      into,
    );
    return;
  }

  const branches = schema.anyOf ?? schema.oneOf;
  if (branches !== undefined) {
    const types = new Set<string>();
    const constants: string[] = [];
    for (const branch of branches) {
      const resolved = resolve(branch, definitions);
      if (resolved.const !== undefined) constants.push(literal(resolved.const));
      if (resolved.properties !== undefined || resolved.items !== undefined) {
        collect(branch, definitions, path, required, seen, into);
        const nested = into.get(path);
        if (nested !== undefined) types.add(nested.shape.type);
        continue;
      }
      types.add(typeof resolved.type === "string" ? resolved.type : "unknown");
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    const shape: FieldShape = { type: [...types].sort().join("|") };
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    if (constants.length === branches.length && constants.length > 0) shape.enum = constants.sort();
    into.set(path, { shape, required });
    return;
  }

  if (schema.enum !== undefined) {
    into.set(path, {
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      shape: { type: "enum", enum: schema.enum.map(literal).sort() },
      required,
    });
    return;
  }
  if (schema.const !== undefined) {
    into.set(path, { shape: { type: "enum", enum: [literal(schema.const)] }, required });
    return;
  }

  const type = typeof schema.type === "string" ? schema.type : "unknown";
  into.set(path, { shape: { type }, required });
  if (schema.properties !== undefined) {
    const mandatory = new Set(schema.required ?? []);
    for (const [key, property] of Object.entries(schema.properties)) {
      collect(
        property,
        definitions,
        `${path}${path === "" ? "" : "."}${key}`,
        required && mandatory.has(key),
        seen,
        into,
      );
    }
  }
  if (schema.items !== undefined) {
    collect(schema.items, definitions, `${path}[]`, required, seen, into);
  }
}

function flatten(schema: JsonSchema | null, definitions: Record<string, JsonSchema>): Collected {
  const into: Collected = new Map();
  if (schema !== null) collect(schema, definitions, "", true, new Set(), into);
  into.delete("");
  return into;
}

function sortedRecord<Value>(entries: Iterable<[string, Value]>): Record<string, Value> {
  const pairs = [...entries];
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  pairs.sort(([left], [right]) => (left < right ? -1 : 1));
  return Object.fromEntries(pairs);
}

/** Describe the wire surface the composed `procedures.json` serves. */
export function describeDashboardSurface(document: ProceduresDocument): DashboardSurface {
  const definitions = document.$defs ?? {};
  const procedures = new Map<string, ProcedureSurface>();
  for (const [name, procedure] of Object.entries(document.procedures)) {
    const request = flatten(procedure.input, definitions);
    const response = flatten(procedure.output, definitions);
    procedures.set(name, {
      mutation: procedure.mutation,
      request: sortedRecord(
        [...request].map(([path, field]) => [path, { ...field.shape, required: field.required }]),
      ),
      response: sortedRecord([...response].map(([path, field]) => [path, field.shape])),
    });
  }
  return { formatVersion: 1, procedures: sortedRecord(procedures) };
}

function retyped(promised: FieldShape, current: FieldShape): string | null {
  if (promised.type !== current.type) return `type ${promised.type} became ${current.type}`;
  return null;
}

/** Enum members a caller could send before and cannot send now. Losing one tightens validation. */
function lostMembers(promised: FieldShape, current: FieldShape): string[] {
  if (promised.enum === undefined) return [];
  const accepted = new Set(current.enum ?? []);
  return current.enum === undefined ? [] : promised.enum.filter((value) => !accepted.has(value));
}

/**
 * Report every promise the current surface no longer keeps. An addition produces no finding: a new
 * procedure, a new response field, and a new optional request field are all additive.
 */
export function classifyDashboardSurface(
  promised: DashboardSurface,
  current: DashboardSurface,
): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  const breaking = (subject: string, change: string): void => {
    findings.push({ classification: "breaking", subject, change });
  };

  for (const [name, was] of Object.entries(promised.procedures)) {
    const now = current.procedures[name];
    if (now === undefined) {
      breaking(`procedure ${name}`, "removed");
      continue;
    }
    if (!was.mutation && now.mutation) {
      breaking(`procedure ${name}`, "became a mutation, so a caller now needs a matching Origin");
    }
    for (const [path, field] of Object.entries(was.response)) {
      const serving = now.response[path];
      if (serving === undefined) {
        breaking(`response field ${name}.${path}`, "removed");
        continue;
      }
      const change = retyped(field, serving);
      if (change !== null) breaking(`response field ${name}.${path}`, change);
    }
    for (const [path, field] of Object.entries(was.request)) {
      const accepting = now.request[path];
      if (accepting === undefined) continue;
      const change = retyped(field, accepting);
      if (change !== null) breaking(`request field ${name}.${path}`, change);
      if (!field.required && accepting.required) {
        breaking(`request field ${name}.${path}`, "became required");
      }
      const lost = lostMembers(field, accepting);
      if (lost.length > 0) {
        breaking(`request field ${name}.${path}`, `no longer accepts ${lost.join(", ")}`);
      }
    }
    for (const [path, field] of Object.entries(now.request)) {
      if (field.required && was.request[path] === undefined) {
        breaking(`request field ${name}.${path}`, "is a new required field");
      }
    }
  }
  return findings;
}

/**
 * Merge additions into the promise. The caller classifies first and refuses to merge a breaking
 * change, so this only ever widens what `dashboard/v1` has promised.
 */
export function mergeDashboardSurface(
  promised: DashboardSurface,
  current: DashboardSurface,
): DashboardSurface {
  const procedures = new Map(Object.entries(current.procedures));
  for (const [name, was] of Object.entries(promised.procedures)) {
    const now = procedures.get(name);
    if (now === undefined) {
      procedures.set(name, was);
      continue;
    }
    procedures.set(name, {
      mutation: now.mutation,
      request: sortedRecord([...Object.entries(was.request), ...Object.entries(now.request)]),
      response: sortedRecord([...Object.entries(was.response), ...Object.entries(now.response)]),
    });
  }
  return { formatVersion: 1, procedures: sortedRecord(procedures) };
}
