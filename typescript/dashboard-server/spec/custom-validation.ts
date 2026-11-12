// oxlint-disable no-underscore-dangle -- Zod 4 keeps the definition and the checks of a schema under
// `_zod`, and this module reads them there.
import ts from "typescript";
import { z } from "zod";

import { requestPath } from "./compatibility.js";

/**
 * Read the request validation that JSON Schema cannot state.
 *
 * `procedures.json` carries each bound that JSON Schema can express. A Zod refinement, such as the
 * byte limit of an audit request ID, or a normalization, such as `trim`, also decides whether a
 * host accepts a request, but no JSON Schema keyword shows it. ADR 0054 calls tighter request
 * validation a break, so `governed-surface.json` records the source of each such check by the field
 * that it validates. A changed source is a change that the check cannot prove compatible.
 *
 * A `refine` keeps its function on the check, and an `overwrite` such as `trim` keeps its
 * transform. A `superRefine` keeps its function only in a closure, so this module wraps
 * `superRefine` on the Zod classes before the router module builds its schemas, and keeps each
 * function by the check that it makes. `generate.ts` imports this module before the router for
 * that reason.
 */

const superRefineSources = new WeakMap<object, string>();

/** The structural part of a Zod 4 schema that this module reads. */
interface ZodInternals {
  readonly _zod: {
    readonly def: {
      readonly type: string;
      readonly checks?: readonly ZodCheck[];
      readonly shape?: Readonly<Record<string, unknown>>;
      readonly element?: unknown;
      readonly innerType?: unknown;
      readonly in?: unknown;
      readonly out?: unknown;
      readonly options?: readonly unknown[];
      readonly left?: unknown;
      readonly right?: unknown;
      readonly transform?: unknown;
    };
  };
}

interface ZodCheck {
  readonly _zod: {
    readonly def: Readonly<Record<string, unknown>> & {
      readonly check: string;
      readonly fn?: unknown;
      readonly tx?: unknown;
    };
  };
}

function isZodSchema(value: unknown): value is ZodInternals {
  return (
    typeof value === "object" &&
    value !== null &&
    "_zod" in value &&
    typeof value._zod === "object" &&
    value._zod !== null &&
    "def" in value._zod
  );
}

type SuperRefine = (this: unknown, ...args: unknown[]) => unknown;

/**
 * One instance of each Zod class that a request schema uses. Zod puts the methods of a class on its
 * prototype when it builds the first instance, so each class needs an instance before its
 * `superRefine` can be wrapped. A `superRefine` on another class stops the generator.
 */
const sampleSchemas: readonly unknown[] = [
  z.object({}),
  z.string(),
  z.number(),
  z.int(),
  z.boolean(),
  z.uuid(),
  z.iso.datetime(),
  z.array(z.string()),
  z.union([z.string(), z.number()]),
  z.enum(["sample"]),
  z.literal("sample"),
  z.null(),
  z.unknown(),
  z.record(z.string(), z.string()),
  z.string().optional(),
  z.string().nullable(),
  z.string().default(""),
  z.string().transform((value) => value),
];

const wrapped = new WeakSet<object>();
for (const sample of sampleSchemas) {
  for (
    let prototype: unknown = Object.getPrototypeOf(sample);
    typeof prototype === "object" && prototype !== null;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    if (wrapped.has(prototype) || !Object.hasOwn(prototype, "superRefine")) continue;
    // Zod installs a method as a getter that binds it to the instance on first read. The wrapper
    // keeps that getter and records the function that each call passes.
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "superRefine");
    const read = descriptor?.get;
    if (descriptor === undefined || read === undefined) continue;
    Object.defineProperty(prototype, "superRefine", {
      ...descriptor,
      get(this: object): unknown {
        const bound: unknown = read.call(this);
        if (typeof bound !== "function") return bound;
        const replacement: SuperRefine = (...args: unknown[]) => {
          const result: unknown = Reflect.apply(bound, this, args);
          const added = isZodSchema(result) ? result._zod.def.checks?.at(-1) : undefined;
          if (added !== undefined) superRefineSources.set(added, String(args[0]));
          return result;
        };
        Object.defineProperty(this, "superRefine", {
          configurable: true,
          writable: true,
          enumerable: false,
          value: replacement,
        });
        return replacement;
      },
    });
    wrapped.add(prototype);
  }
}

/**
 * The check kinds that JSON Schema states and that `compatibility.ts` compares as bounds. A field
 * that has only these needs no entry here, because their order does not change what they accept.
 */
const statedKinds = new Set([
  "less_than",
  "greater_than",
  "multiple_of",
  "number_format",
  "max_length",
  "min_length",
  "length_equals",
  "string_format",
]);

/** Each token of one function, in one canonical spelling. */
function canonicalTokens(file: ts.SourceFile): string[] {
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    // `void 0` and `undefined` are one value, and compilers write either.
    if (ts.isVoidExpression(node) && ts.isNumericLiteral(node.expression)) {
      tokens.push("undefined");
      return;
    }
    const children = node.getChildren(file);
    if (children.length === 0) {
      const token = leafToken(node, file);
      if (token !== null && token !== "") tokens.push(token);
      return;
    }
    const parameter = ts.isArrowFunction(node) ? onlySimpleParameter(node) : undefined;
    for (const [index, part] of children.entries()) {
      // `(value) => …` and `value => …` are one function, and compilers write either.
      if (
        parameter !== undefined &&
        (part.kind === ts.SyntaxKind.OpenParenToken || part.kind === ts.SyntaxKind.CloseParenToken)
      ) {
        continue;
      }
      // A trailing comma in a list is a choice of the printer.
      if (
        node.kind === ts.SyntaxKind.SyntaxList &&
        part.kind === ts.SyntaxKind.CommaToken &&
        index === children.length - 1
      ) {
        continue;
      }
      visit(part);
    }
    // A statement always ends with one `;`, whether or not the printer wrote it.
    if (endsStatement(node)) tokens.push(";");
  };
  visit(file);
  return tokens;
}

function onlySimpleParameter(arrow: ts.ArrowFunction): ts.ParameterDeclaration | undefined {
  const [parameter] = arrow.parameters;
  if (arrow.parameters.length !== 1 || parameter === undefined) return undefined;
  const simple =
    ts.isIdentifier(parameter.name) &&
    parameter.type === undefined &&
    parameter.initializer === undefined &&
    parameter.dotDotDotToken === undefined;
  return simple ? parameter : undefined;
}

/** Whether a node is a statement directly inside a block, a file, or a `case` clause. */
function endsStatement(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  const statements =
    ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isModuleBlock(parent)
      ? parent.statements
      : ts.isCaseClause(parent) || ts.isDefaultClause(parent)
        ? parent.statements
        : undefined;
  return statements !== undefined && statements.some((statement) => statement === node);
}

/** One token in its canonical spelling, or null for a token that a printer chooses. */
function leafToken(node: ts.Node, file: ts.SourceFile): string | null {
  if (node.kind === ts.SyntaxKind.EndOfFileToken) return null;
  // The `;` that ends a statement is written by `endsStatement`, so its own token is left out.
  if (node.kind === ts.SyntaxKind.SemicolonToken && node.parent && endsStatement(node.parent)) {
    return null;
  }
  if (ts.isNumericLiteral(node)) return String(Number(node.text.replaceAll("_", "")));
  // A tag reads the raw text of its template, so a tagged template keeps its spelling.
  if (ts.isNoSubstitutionTemplateLiteral(node) && ts.isTaggedTemplateExpression(node.parent)) {
    return node.getText(file);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return JSON.stringify(node.text);
  }
  return node.getText(file);
}

/**
 * One function as the promise records it.
 *
 * The router reaches this module compiled, and two compilers print one function in different
 * ways. So TypeScript parses the printed function, and the record is its tokens, joined with one
 * space. A token keeps its text, so a string or a regular expression keeps each character. Only
 * the choices of a printer are made one way: the spelling of a number and a string, `void 0`, the
 * parentheses around one arrow parameter, a trailing comma, and the `;` that ends a statement. So a
 * new compiler, or a change of layout, is not a change of the check.
 */
function sourceOf(fn: unknown): string {
  const file = ts.createSourceFile("check.ts", `(${String(fn)});`, ts.ScriptTarget.Latest, true);
  return canonicalTokens(file).join(" ");
}

/** The parameters of a check that decide what it accepts, without its message and functions. */
function parametersOf(def: Readonly<Record<string, unknown>>): string {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(def)) {
    if (["check", "error", "message", "abort", "when", "fn", "tx"].includes(key)) continue;
    if (typeof value === "function") continue;
    kept[key] = value instanceof RegExp ? String(value) : value;
  }
  return JSON.stringify(kept);
}

interface DescribedCheck {
  readonly text: string;
  /** Whether JSON Schema states the check, so `compatibility.ts` already compares it. */
  readonly stated: boolean;
}

function describeCheck(check: ZodCheck): DescribedCheck {
  const described = describeOwnCheck(check);
  // A `when` function decides whether the check runs, so it is part of what the check accepts. Zod
  // gives each length and size check a `when` of its own, so only the `when` of a refinement, which
  // has no such default, is recorded. A changed Zod default is then not a change of the surface.
  const condition = check._zod.def.when;
  if (check._zod.def.check !== "custom" || typeof condition !== "function") return described;
  return { text: `${described.text} when ${sourceOf(condition)}`, stated: false };
}

function describeOwnCheck(check: ZodCheck): DescribedCheck {
  const def = check._zod.def;
  const kind = def.check;
  if (kind === "custom") {
    const source = def.fn === undefined ? superRefineSources.get(check) : def.fn;
    if (source === undefined) {
      throw new Error(
        "A request schema has a superRefine on a Zod class that custom-validation.ts does not " +
          "wrap. Add an instance of that class to sampleSchemas.",
      );
    }
    return { text: `custom ${sourceOf(source)}`, stated: false };
  }
  if (kind === "overwrite") return { text: `overwrite ${sourceOf(def.tx)}`, stated: false };
  return { text: `${kind} ${parametersOf(def)}`, stated: statedKinds.has(kind) };
}

/** The path of a field as `compatibility.ts` writes it: `.key` for a property and `[]` for items. */
function child(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * Collect the checks of each field in the order that Zod runs them. A schema runs the checks of
 * the schema that it wraps first, and its own checks after them.
 */
function collect(schema: unknown, path: string, into: Map<string, DescribedCheck[]>): void {
  if (!isZodSchema(schema)) return;
  const def = schema._zod.def;
  switch (def.type) {
    case "object":
      for (const [key, value] of Object.entries(def.shape ?? {})) {
        collect(value, child(path, key), into);
      }
      break;
    case "array":
      collect(def.element, `${path}[]`, into);
      break;
    case "pipe":
      collect(def.in, path, into);
      collect(def.out, path, into);
      break;
    case "union":
      for (const option of def.options ?? []) collect(option, path, into);
      break;
    case "intersection":
      collect(def.left, path, into);
      collect(def.right, path, into);
      break;
    case "transform": {
      // A transform can refuse a value through `context.addIssue`, so its function is a check.
      const key = path === "" ? requestPath : path;
      into.set(key, [
        ...(into.get(key) ?? []),
        { text: `transform ${sourceOf(def.transform)}`, stated: false },
      ]);
      break;
    }
    default:
      if (def.innerType !== undefined) collect(def.innerType, path, into);
  }
  const key = path === "" ? requestPath : path;
  for (const check of def.checks ?? []) {
    into.set(key, [...(into.get(key) ?? []), describeCheck(check)]);
  }
}

/**
 * The checks of each field that has a check that JSON Schema cannot state, in the order that Zod
 * runs them.
 *
 * Such a field keeps every check, the stated ones too, because the order decides what the field
 * accepts: a `trim` before a length limit accepts more than one after it. A field with stated
 * checks only has no entry, because `compatibility.ts` compares those through JSON Schema.
 */
export function customValidation(schema: unknown): Record<string, string[]> {
  const into = new Map<string, DescribedCheck[]>();
  collect(schema, "", into);
  const entries = [...into]
    .filter(([, checks]) => checks.some((check) => !check.stated))
    .map(([path, checks]): [string, string[]] => [path, checks.map((check) => check.text)]);
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  entries.sort(([left], [right]) => (left < right ? -1 : 1));
  return Object.fromEntries(entries);
}
