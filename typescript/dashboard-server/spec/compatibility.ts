/**
 * Classify a `dashboard/v1` change as additive or breaking.
 *
 * `procedures.json` is regenerated from the router, so a diff against it says only that the wire
 * contract moved. `governed-surface.json` is the promise instead: every procedure, request field,
 * and response field `dashboard/v1` has ever served. The generator may add to it and may never drop
 * from it, so removing a procedure from the router fails the check by name however faithfully the
 * regenerated artifacts follow.
 */

/** A validation keyword that sets a lower limit. A larger value accepts fewer requests. */
const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems"] as const;
/** A validation keyword that sets an upper limit. A smaller value accepts fewer requests. */
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems"] as const;
/** A validation keyword whose value has no order. Each change can refuse a request. */
const TEXT_BOUNDS = ["pattern", "format"] as const;
/** A numeric keyword whose change can refuse a request in a way that no order describes. */
const EXACT_BOUNDS = ["multipleOf"] as const;

type LowerBound = (typeof LOWER_BOUNDS)[number];
type UpperBound = (typeof UPPER_BOUNDS)[number];
type TextBound = (typeof TEXT_BOUNDS)[number];
type ExactBound = (typeof EXACT_BOUNDS)[number];

/** The validation bounds of one field. ADR 0054 calls a tighter bound on a request a break. */
type Bounds = Partial<
  Record<LowerBound | UpperBound | ExactBound, number> & Record<TextBound, string>
>;

/** One branch of a field that accepts several schemas, with the bounds of that branch. */
interface Branch extends Bounds {
  type: string;
  /** The values that the branch accepts, when it accepts a set. */
  enum?: string[];
}

interface FieldShape extends Bounds {
  /** The JSON type, or a `|`-joined union when a field accepts several. */
  type: string;
  /** The accepted literal values, when validation restricts the field to a set. */
  enum?: string[];
  /**
   * Each branch of a field that accepts several schemas, when a branch has a bound. A value is
   * valid when one branch accepts it, so the bounds stay with their branch.
   */
  branches?: Branch[];
}

interface RequestField extends FieldShape {
  required: boolean;
}

/** The label that `customValidation` gives the request itself, for a check of the whole input. */
export const requestPath = "(request)";

interface ProcedureSurface {
  mutation: boolean;
  /**
   * The request checks that JSON Schema cannot state, such as a Zod refinement, by the field that
   * each one validates. `custom-validation.ts` reads them from the router.
   */
  customValidation?: Record<string, string[]>;
  request: Record<string, RequestField>;
  response: Record<string, FieldShape>;
}

export interface DashboardSurface {
  formatVersion: 1;
  /**
   * Set when each request field records its validation bounds and its checks that JSON Schema
   * cannot state. A promise without it predates both, so a bound or a check that it lacks was not
   * recorded rather than absent.
   */
  recordsValidationBounds?: true;
  procedures: Record<string, ProcedureSurface>;
}

export interface SurfaceFinding {
  /**
   * `breaking` when the change refuses a request or a reader that the promise allowed.
   * `unproven` when the check cannot prove that the change keeps each request valid, such as a
   * changed refinement. A maintainer reviews it and takes it with `--accept-breaking` if it only
   * accepts more.
   */
  classification: "breaking" | "unproven";
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
  minimum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  minItems?: number;
  maximum?: number;
  exclusiveMaximum?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  multipleOf?: number;
}

interface ProceduresDocument {
  procedures: Record<string, { mutation: boolean; input: JsonSchema | null; output: JsonSchema }>;
  $defs?: Record<string, JsonSchema>;
}

type Collected = Map<string, { shape: FieldShape; required: boolean }>;

function literal(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The bounds that one schema sets on its own value. */
function ownBounds(schema: JsonSchema): Bounds {
  const bounds: Bounds = {};
  for (const key of [...LOWER_BOUNDS, ...UPPER_BOUNDS, ...EXACT_BOUNDS]) {
    const value = schema[key];
    if (value !== undefined) bounds[key] = value;
  }
  for (const key of TEXT_BOUNDS) {
    const value = schema[key];
    if (value !== undefined) bounds[key] = value;
  }
  return bounds;
}

/** The bounds of a collected shape, without its type, enum, and branches. */
function boundsOf(shape: FieldShape): Bounds {
  const { type: _type, enum: _enum, branches: _branches, ...bounds } = shape;
  return bounds;
}

/**
 * A branch with the bounds that a schema beside it also sets. A value must satisfy both, so each
 * limit is the tighter one. Two different patterns or formats both apply, joined with ` & `.
 */
function intersect(branch: Branch, shared: Bounds): Branch {
  const result: Branch = { ...branch };
  for (const key of LOWER_BOUNDS) {
    const value = shared[key];
    if (value !== undefined) result[key] = Math.max(result[key] ?? value, value);
  }
  for (const key of UPPER_BOUNDS) {
    const value = shared[key];
    if (value !== undefined) result[key] = Math.min(result[key] ?? value, value);
  }
  for (const key of TEXT_BOUNDS) {
    const value = shared[key];
    if (value === undefined) continue;
    const values = new Set([...(result[key]?.split(" & ") ?? []), value]);
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    result[key] = [...values].sort().join(" & ");
  }
  for (const key of EXACT_BOUNDS) {
    const value = shared[key];
    // Two divisors both apply. The record keeps one, so a second one is recorded as unknown.
    if (value !== undefined) result[key] = result[key] === undefined ? value : Number.NaN;
  }
  return result;
}

function hasBounds(bounds: Bounds): boolean {
  return Object.keys(bounds).length > 0;
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
    // A bound beside `$ref` applies to the value as well as the referenced schema.
    const shared = ownBounds(schema);
    const resolved = into.get(path);
    if (resolved !== undefined && hasBounds(shared)) {
      const { shape } = resolved;
      const merged: FieldShape =
        shape.branches === undefined
          ? { ...shape, ...boundsOf(intersect({ type: shape.type, ...boundsOf(shape) }, shared)) }
          : { ...shape, branches: shape.branches.map((branch) => intersect(branch, shared)) };
      into.set(path, { shape: merged, required: resolved.required });
    }
    return;
  }

  const branches = schema.anyOf ?? schema.oneOf;
  if (branches !== undefined) {
    const types = new Set<string>();
    const constants: string[] = [];
    const branchShapes: Branch[] = [];
    for (const branch of branches) {
      const resolved = resolve(branch, definitions);
      if (resolved.const !== undefined) constants.push(literal(resolved.const));
      if (resolved.properties !== undefined || resolved.items !== undefined) {
        collect(branch, definitions, path, required, seen, into);
        const nested = into.get(path);
        if (nested !== undefined) {
          types.add(nested.shape.type);
          branchShapes.push({ type: nested.shape.type, ...boundsOf(nested.shape) });
        }
        continue;
      }
      const type = typeof resolved.type === "string" ? resolved.type : "unknown";
      types.add(type);
      const values =
        resolved.enum !== undefined
          ? resolved.enum.map(literal)
          : resolved.const !== undefined
            ? [literal(resolved.const)]
            : undefined;
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      const accepted = values === undefined ? {} : { enum: values.sort() };
      branchShapes.push({ type, ...accepted, ...ownBounds(resolved) });
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    const shape: FieldShape = { type: [...types].sort().join("|") };
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    if (constants.length === branches.length && constants.length > 0) shape.enum = constants.sort();
    // A bound beside `anyOf` applies to each branch as well.
    const shared = ownBounds(schema);
    const bounded = branchShapes.map((branch) => intersect(branch, shared));
    // A branch that accepts a set restricts the field as a bound does, unless the field is a set of
    // constants that `enum` already lists.
    const restricted = (branch: Branch): boolean =>
      hasBounds(boundsOf(branch)) || (shape.enum === undefined && branch.enum !== undefined);
    if (bounded.some(restricted)) {
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      shape.branches = bounded.sort((left, right) =>
        JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
      );
    }
    into.set(path, { shape, required });
    return;
  }

  if (schema.enum !== undefined) {
    into.set(path, {
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      shape: { type: "enum", enum: schema.enum.map(literal).sort(), ...ownBounds(schema) },
      required,
    });
    return;
  }
  if (schema.const !== undefined) {
    into.set(path, {
      shape: { type: "enum", enum: [literal(schema.const)], ...ownBounds(schema) },
      required,
    });
    return;
  }

  const type = typeof schema.type === "string" ? schema.type : "unknown";
  into.set(path, { shape: { type, ...ownBounds(schema) }, required });
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
export function describeDashboardSurface(
  document: ProceduresDocument,
  customValidation: Readonly<Record<string, Record<string, string[]>>> = {},
): DashboardSurface {
  const definitions = document.$defs ?? {};
  const procedures = new Map<string, ProcedureSurface>();
  for (const [name, procedure] of Object.entries(document.procedures)) {
    const request = flatten(procedure.input, definitions);
    const response = flatten(procedure.output, definitions);
    const custom = customValidation[name] ?? {};
    procedures.set(name, {
      mutation: procedure.mutation,
      // Each new key sits before `request`, so a promise that predates it gains whole lines.
      ...(Object.keys(custom).length > 0 ? { customValidation: custom } : {}),
      // The bounds sit between the type and `required`, so a promise that predates them gains
      // whole lines and changes none.
      request: sortedRecord(
        [...request].map(([path, field]) => [path, { ...field.shape, required: field.required }]),
      ),
      // ADR 0054 governs the type of a response field, not the range of its values.
      response: sortedRecord(
        [...response].map(([path, field]) => [path, withoutBounds(field.shape)]),
      ),
    });
  }
  return {
    formatVersion: 1,
    recordsValidationBounds: true,
    procedures: sortedRecord(procedures),
  };
}

function withoutBounds(shape: FieldShape): FieldShape {
  return shape.enum === undefined ? { type: shape.type } : { type: shape.type, enum: shape.enum };
}

/**
 * What a finding that the checker cannot prove says after the change: what the checker does not
 * read, that the stop is a limit of the checker, and where to read next.
 */
const unprovenGuidance =
  "The checker does not evaluate a pattern, a format, the function of a check, or several " +
  "branches together, so it cannot prove that this change refuses no request. This is a limit " +
  'of the checker, not a judged break of dashboard/v1. See "Known limits" in api/README.md: ' +
  "if a review shows that the change refuses no request that the promise accepted, record it " +
  "with --accept-breaking";

/** One change that the classifier reports, and whether the check can prove that it breaks. */
interface Change {
  readonly change: string;
  readonly unproven: boolean;
}

/** Each bound that accepts fewer values now than the promise did, keyword by keyword. */
function tightenedBounds(promised: Bounds, current: Bounds): string[] {
  const changes: string[] = [];
  const describe = (key: string, was: unknown, now: unknown): void => {
    changes.push(
      was === undefined
        ? `gained ${key} ${String(now)}`
        : `${key} changed from ${String(was)} to ${String(now)}`,
    );
  };
  for (const key of LOWER_BOUNDS) {
    const was = promised[key];
    const now = current[key];
    if (now !== undefined && (was === undefined || now > was)) describe(key, was, now);
  }
  for (const key of UPPER_BOUNDS) {
    const was = promised[key];
    const now = current[key];
    if (now !== undefined && (was === undefined || now < was)) describe(key, was, now);
  }
  for (const key of [...TEXT_BOUNDS, ...EXACT_BOUNDS]) {
    const was = promised[key];
    const now = current[key];
    if (now !== undefined && !Object.is(was, now)) describe(key, was, now);
  }
  return changes;
}

/** Whether a check can prove that the current rule accepts each value that the promise accepted. */
type Coverage = "covered" | "tightened" | "unknown";

/** The lowest value that bounds allow, as a number and whether the number itself is allowed. */
interface Limit {
  readonly value: number;
  readonly inclusive: boolean;
}

/**
 * The effective lower or upper limit of a number. `minimum` and `exclusiveMinimum` both set one, so
 * the tighter one applies. For an integer, an exclusive limit is the next integer inside it.
 */
function numericLimit(bounds: Bounds, side: "lower" | "upper", integer: boolean): Limit | null {
  const inclusive = side === "lower" ? bounds.minimum : bounds.maximum;
  const exclusive = side === "lower" ? bounds.exclusiveMinimum : bounds.exclusiveMaximum;
  const candidates: Limit[] = [];
  if (inclusive !== undefined) {
    // For an integer, `minimum: 1.1` allows the same values as `minimum: 2`.
    const value = !integer
      ? inclusive
      : side === "lower"
        ? Math.ceil(inclusive)
        : Math.floor(inclusive);
    candidates.push({ value, inclusive: true });
  }
  if (exclusive !== undefined) {
    candidates.push(
      integer
        ? {
            value: side === "lower" ? Math.floor(exclusive) + 1 : Math.ceil(exclusive) - 1,
            inclusive: true,
          }
        : { value: exclusive, inclusive: false },
    );
  }
  const tighter = (left: Limit, right: Limit): Limit => {
    if (left.value !== right.value) {
      return (side === "lower" ? left.value > right.value : left.value < right.value)
        ? left
        : right;
    }
    return left.inclusive ? right : left;
  };
  return candidates.reduce<Limit | null>(
    (best, candidate) => (best === null ? candidate : tighter(best, candidate)),
    null,
  );
}

/** Whether limit `now` allows each value that limit `was` allows, on one side. */
function limitKeeps(was: Limit | null, now: Limit | null, side: "lower" | "upper"): boolean {
  if (now === null) return true;
  if (was === null) return false;
  if (was.value !== now.value)
    return side === "lower" ? now.value < was.value : now.value > was.value;
  return now.inclusive || !was.inclusive;
}

/**
 * Whether `divisor` divides each value that the promise accepted: each integer when it is 1, and
 * each multiple of the promised divisor when it divides that divisor.
 */
function dividesEach(promised: Bounds, divisor: number, integer: boolean): boolean {
  if (integer && divisor === 1) return true;
  const was = promised.multipleOf;
  return was !== undefined && Number.isInteger(was / divisor);
}

/** Whether one value of a field satisfies the bounds of a branch. */
function satisfies(value: string, branch: Branch): boolean {
  const text = value;
  const number = Number(value);
  if (branch.minLength !== undefined && [...text].length < branch.minLength) return false;
  if (branch.maxLength !== undefined && [...text].length > branch.maxLength) return false;
  if (branch.pattern !== undefined && !new RegExp(branch.pattern, "u").test(text)) return false;
  if (branch.minimum !== undefined && !(number >= branch.minimum)) return false;
  if (branch.maximum !== undefined && !(number <= branch.maximum)) return false;
  if (branch.exclusiveMinimum !== undefined && !(number > branch.exclusiveMinimum)) return false;
  if (branch.exclusiveMaximum !== undefined && !(number < branch.exclusiveMaximum)) return false;
  if (branch.multipleOf !== undefined && !Number.isInteger(number / branch.multipleOf)) {
    return false;
  }
  return true;
}

/**
 * Whether the current branch accepts each value that the promised branch accepted.
 *
 * A branch that accepts a set is compared value by value. Otherwise the effective limits are
 * compared, so `minimum: 1` and `exclusiveMinimum: 0` read as the same limit for an integer. A
 * change of `pattern`, `format`, or `multipleOf` cannot be proved, and a new one is a tightening.
 */
function coverage(promised: Branch, current: Branch): Coverage {
  if (promised.enum !== undefined) {
    if (promised.format !== undefined || current.format !== undefined) {
      if (promised.format !== current.format && current.format !== undefined) return "unknown";
    }
    const kept = promised.enum
      .filter((value) => satisfies(value, promised))
      .every(
        (value) =>
          (current.enum === undefined || current.enum.includes(value)) && satisfies(value, current),
      );
    return kept ? "covered" : "tightened";
  }
  if (current.enum !== undefined) return "tightened";
  const integer = promised.type === "integer" && current.type === "integer";
  for (const side of ["lower", "upper"] as const) {
    if (
      !limitKeeps(numericLimit(promised, side, integer), numericLimit(current, side, integer), side)
    ) {
      return "tightened";
    }
  }
  for (const [lower, upper] of [
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ] as const) {
    if ((current[lower] ?? 0) > (promised[lower] ?? 0)) return "tightened";
    if ((current[upper] ?? Infinity) < (promised[upper] ?? Infinity)) return "tightened";
  }
  let result: Coverage = "covered";
  for (const key of TEXT_BOUNDS) {
    const was = promised[key];
    const now = current[key];
    if (now === undefined || Object.is(was, now)) continue;
    // A new pattern or format usually refuses values, but the checker does not evaluate it.
    result = "unknown";
  }
  const divisor = current.multipleOf;
  if (divisor !== undefined && !dividesEach(promised, divisor, integer)) {
    if (promised.multipleOf === undefined) return "tightened";
    result = "unknown";
  }
  return result;
}

/** The branches of a field: its own one, or one for each type of a union. */
function branchesOf(field: FieldShape): Branch[] {
  if (field.branches !== undefined) return field.branches;
  const types = field.type.split("|");
  if (types.length > 1) return types.map((type) => ({ type }));
  const own: Branch = { type: field.type, ...boundsOf(field) };
  return field.enum === undefined ? [own] : [{ ...own, enum: field.enum }];
}

/**
 * Each change that can make the field accept fewer values than the promise did.
 *
 * A value has one JSON type, so the branches of each type are compared on their own. Each promised
 * branch must have one current branch that accepts each value that it accepted. If one branch of
 * the type is left and it does not, the change is breaking. If several are left and no one covers
 * it, they can still cover it together, so the check cannot prove the change and reports it as
 * unproven.
 */
function tightenedValidation(promised: FieldShape, current: FieldShape): Change[] {
  const was = branchesOf(promised);
  // `lostMembers` reports a value that a plain enum field lost, so here the field keeps its
  // promised values and only its bounds are compared.
  const plainEnum =
    promised.branches === undefined &&
    current.branches === undefined &&
    promised.enum !== undefined;
  // A plain field gets a new branch object from `branchesOf`, so the change stays here.
  const now = branchesOf(current);
  if (plainEnum) {
    for (const branch of now) if (branch.enum !== undefined) branch.enum = promised.enum;
  }
  const changes: Change[] = [];
  for (const type of new Set(was.map((branch) => branch.type))) {
    const before = was.filter((branch) => branch.type === type);
    const after = now.filter((branch) => branch.type === type);
    if (after.length === 0) continue;
    const results = before.map((branch) => {
      const each = after.map((candidate) => coverage(branch, candidate));
      if (each.includes("covered")) return "covered";
      return after.length === 1 && each[0] === "tightened" ? "tightened" : "unknown";
    });
    if (results.every((result) => result === "covered")) continue;
    const unproven = !results.includes("tightened");
    const [single] = before;
    const [replacement] = after;
    const detail =
      before.length === 1 && after.length === 1 && single && replacement
        ? tightenedBounds(single, replacement)
        : [];
    if (detail.length > 0) {
      for (const change of detail) changes.push({ change, unproven });
      continue;
    }
    const key = (branches: Branch[]): string => {
      const texts = branches.map((branch) => JSON.stringify(branch));
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      return texts.sort().join(" | ");
    };
    changes.push({
      change: `${type} values changed from ${key(before)} to ${key(after)}${unproven ? ", so the check cannot prove that each value is still accepted" : ""}`,
      unproven,
    });
  }
  return changes;
}

/**
 * Whether the current checks of a field accept each request that the promised ones accepted.
 *
 * Zod runs the checks of a field in order, and a normalization such as `trim` changes the value
 * that the later checks see. So the current list must be the promised list in the same order, with
 * only validation checks left out or made looser in place. A check that went away accepts more. A normalization that went
 * away, a new check, and a new order can each refuse a request.
 */
function keepsCustomChecks(promised: readonly string[], current: readonly string[]): boolean {
  let index = 0;
  for (const check of promised) {
    const now = current[index];
    if (now !== undefined && (now === check || loosens(check, now))) index += 1;
    else if (check.startsWith("overwrite ")) return false;
  }
  return index === current.length;
}

/** The kind and parameters of a stated check, as `custom-validation.ts` writes it. */
function statedCheck(text: string): { kind: string; parameters: Record<string, unknown> } | null {
  const match = /^([a-z_]+) (\{.*\})$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const parameters: unknown = JSON.parse(match[2]);
  if (typeof parameters !== "object" || parameters === null) return null;
  return { kind: match[1], parameters: { ...parameters } };
}

/** A numeric parameter of a stated check, or undefined. */
function numericParameter(parameters: Record<string, unknown>, key: string): number | undefined {
  const value = parameters[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Whether a stated check at the same position accepts each value that the promised one accepted:
 * a lower minimum length or bound, or a higher maximum.
 */
function loosens(promised: string, current: string): boolean {
  const was = statedCheck(promised);
  const now = statedCheck(current);
  if (was === null || now === null || was.kind !== now.kind) return false;
  const compare = (key: string, wider: (before: number, after: number) => boolean): boolean => {
    const before = numericParameter(was.parameters, key);
    const after = numericParameter(now.parameters, key);
    return before !== undefined && after !== undefined && wider(before, after);
  };
  const sameOtherwise = (key: string): boolean => {
    const { [key]: _was, ...restWas } = was.parameters;
    const { [key]: _now, ...restNow } = now.parameters;
    return JSON.stringify(restWas) === JSON.stringify(restNow);
  };
  switch (was.kind) {
    case "min_length":
      return sameOtherwise("minimum") && compare("minimum", (before, after) => after <= before);
    case "max_length":
      return sameOtherwise("maximum") && compare("maximum", (before, after) => after >= before);
    case "greater_than":
      return (
        compare("value", (before, after) => after < before) ||
        (compare("value", (before, after) => after === before) && now.parameters.inclusive === true)
      );
    case "less_than":
      return (
        compare("value", (before, after) => after > before) ||
        (compare("value", (before, after) => after === before) && now.parameters.inclusive === true)
      );
    default:
      return false;
  }
}

/**
 * Each field, or the request itself, whose checks that JSON Schema cannot state changed in a way
 * that can refuse a request. A field that the promise did not have is new, so its checks change no
 * request that a caller sent before.
 */
function changedCustomChecks(was: ProcedureSurface, now: ProcedureSurface): string[] {
  const changed: string[] = [];
  const paths = new Set([
    ...Object.keys(was.customValidation ?? {}),
    ...Object.keys(now.customValidation ?? {}),
  ]);
  for (const path of paths) {
    if (path !== requestPath && was.request[path] === undefined) continue;
    const before = was.customValidation?.[path] ?? [];
    // A field without an entry has only checks that JSON Schema states, and `compatibility.ts`
    // compares those through the bounds. So the custom list is empty.
    const after = now.customValidation?.[path] ?? [];
    if (!keepsCustomChecks(before, after)) changed.push(path);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  return changed.sort();
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
  const report = (subject: string, { change, unproven }: Change): void => {
    findings.push({
      classification: unproven ? "unproven" : "breaking",
      subject,
      change: unproven ? `${change}. ${unprovenGuidance}` : change,
    });
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
      if (promised.recordsValidationBounds === true) {
        for (const tightened of tightenedValidation(field, accepting)) {
          report(`request field ${name}.${path}`, tightened);
        }
      }
    }
    if (promised.recordsValidationBounds === true) {
      for (const path of changedCustomChecks(was, now)) {
        const before = was.customValidation?.[path] ?? [];
        const after = now.customValidation?.[path] ?? [];
        report(path === requestPath ? `request of ${name}` : `request field ${name}.${path}`, {
          change: `checks that JSON Schema cannot state changed from [${before.join("; ")}] to [${after.join("; ")}], so the check cannot prove that each request is still accepted`,
          unproven: true,
        });
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
      ...(now.customValidation === undefined ? {} : { customValidation: now.customValidation }),
      request: sortedRecord([...Object.entries(was.request), ...Object.entries(now.request)]),
      response: sortedRecord([...Object.entries(was.response), ...Object.entries(now.response)]),
    });
  }
  return {
    formatVersion: 1,
    ...(current.recordsValidationBounds === true ? { recordsValidationBounds: true as const } : {}),
    procedures: sortedRecord(procedures),
  };
}
