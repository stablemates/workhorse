import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * JSON Schemas for every dashboard procedure response, derived from the router.
 *
 * The router declares no output schemas; its response types are the TypeScript wire model. This
 * module resolves `DashboardV1Responses` from `responses.ts` with the TypeScript checker and
 * walks the resolved types into JSON Schema, so the generated `dashboard/v1` artifacts follow the
 * router without a hand-maintained procedure-to-type map. The walker covers exactly the constructs
 * the wire model uses — JSON-safe primitives, literals, unions, arrays, tuples, records, and
 * object types — and throws on anything else so an unrepresentable wire change fails generation
 * instead of producing a silently wrong schema.
 */

type JsonSchema = Record<string, unknown>;

export interface ResponseSchemas {
  /** Procedure name to response schema. `null` marks a procedure that produces no result. */
  responses: Record<string, JsonSchema | null>;
  /** Named wire types referenced from the response schemas through `#/$defs/`. */
  definitions: Record<string, JsonSchema>;
}

const specDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = join(specDirectory, "..", "..", "..");

const excludedReferenceNames = new Set(["Array", "ReadonlyArray", "Record", "__type", "__object"]);

/** The prefix every `$defs` key carries. Exported so a test can pin the rule to the artifact. */
export const dashboardDefinitionPrefix = "Dashboard";

/** Apply the `$defs` naming rule to one TypeScript symbol name. */
function dashboardDefinitionName(symbolName: string): string {
  return symbolName.startsWith(dashboardDefinitionPrefix)
    ? symbolName
    : `${dashboardDefinitionPrefix}${symbolName}`;
}

/**
 * The earliest declaration of a property, as its file path and its offset in that file.
 *
 * The path is relative to the repository root, so the order does not depend on where the checkout
 * is. The checker gives each source file its real path, so a symbolic link does not change it.
 */
function declarationPosition(property: ts.Symbol): { file: string; offset: number } | undefined {
  let earliest: { file: string; offset: number } | undefined;
  for (const declaration of property.declarations ?? []) {
    const file = relative(repositoryDirectory, declaration.getSourceFile().fileName)
      .split(sep)
      .join("/");
    const position = { file, offset: declaration.pos };
    if (
      earliest === undefined ||
      position.file < earliest.file ||
      (position.file === earliest.file && position.offset < earliest.offset)
    ) {
      earliest = position;
    }
  }
  return earliest;
}

/**
 * Put the properties of an object type in the order of their declarations in the source.
 *
 * The checker lists the properties of an `Omit`, a `Pick`, or another mapped type in the order of
 * its key union, and it orders a union by the order in which it created the member types. A change
 * to an unrelated exported type can therefore move a key, which rewrites the generated artifacts
 * with no change to the wire contract. The emitted order is fixed instead:
 *
 * 1. A property with a declaration comes first. Properties sort by the file path of their earliest
 *    declaration, then by the offset of that declaration in the file. Thus the properties of one
 *    interface keep the order in which the source writes them. If a file declares a base type
 *    before an interface that extends it, the base members come first.
 * 2. A property with no declaration, such as a key of `Record<"a" | "b", T>`, comes last, in name
 *    order.
 */
function inDeclarationOrder(properties: readonly ts.Symbol[]): ts.Symbol[] {
  const keyed = properties.map((property) => ({
    property,
    position: declarationPosition(property),
  }));
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  keyed.sort((left, right) => {
    if (left.position && right.position) {
      if (left.position.file !== right.position.file) {
        return left.position.file < right.position.file ? -1 : 1;
      }
      if (left.position.offset !== right.position.offset) {
        return left.position.offset - right.position.offset;
      }
    } else if (left.position || right.position) {
      return left.position ? -1 : 1;
    }
    return left.property.name < right.property.name
      ? -1
      : left.property.name > right.property.name
        ? 1
        : 0;
  });
  return keyed.map(({ property }) => property);
}

class ResponseSchemaBuilder {
  private readonly definitions = new Map<string, JsonSchema>();
  private readonly nameByType = new Map<ts.Type, string>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly location: ts.Node,
  ) {}

  build(responsesType: ts.Type): ResponseSchemas {
    const responses: Record<string, JsonSchema | null> = {};
    for (const procedure of this.checker.getPropertiesOfType(responsesType)) {
      const type = this.checker.getTypeOfSymbolAtLocation(procedure, this.location);
      responses[procedure.name] =
        type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)
          ? null
          : this.schemaFor(type, procedure.name);
    }
    const definitions: Record<string, JsonSchema> = {};
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    for (const name of [...this.definitions.keys()].sort()) {
      definitions[name] = this.definitions.get(name)!;
    }
    return { responses, definitions };
  }

  /** Resolve one type, registering named wire types as shared `$defs` entries. */
  private schemaFor(type: ts.Type, path: string): JsonSchema {
    const name = this.referenceName(type);
    if (name === undefined) return this.structuralSchema(type, path);
    const known = this.nameByType.get(type);
    if (known !== undefined) return { $ref: `#/$defs/${known}` };
    let unique = name;
    for (let suffix = 2; this.definitions.has(unique); suffix += 1) unique = `${name}_${suffix}`;
    this.nameByType.set(type, unique);
    // Register before descending so a recursive type resolves to its own reference.
    this.definitions.set(unique, {});
    const schema = this.structuralSchema(type, unique);
    this.definitions.set(unique, schema);
    return { $ref: `#/$defs/${unique}` };
  }

  /**
   * The `$defs` name for a named alias or interface, or undefined for structural emission.
   *
   * Every name carries the `Dashboard` prefix, whether or not the TypeScript symbol does. A core
   * type that reaches a response — `CancelStatus`, `Json` — would otherwise put a second
   * dashboard-shaped copy of that name in the generated Go and Python bindings, beside the core
   * one the same SDK already exports. The prefix is a naming rule of the `dashboard/v1` contract
   * rather than a claim about the TypeScript symbol, so a core type stays the single source of
   * the shape it describes.
   */
  private referenceName(type: ts.Type): string | undefined {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
      return undefined;
    }
    const alias = type.aliasSymbol;
    const symbol = alias ?? ((type.flags & ts.TypeFlags.Object) === 0 ? undefined : type.symbol);
    if (!symbol || (alias && type.aliasTypeArguments?.length)) return undefined;
    if (excludedReferenceNames.has(symbol.name) || !/^[A-Za-z][A-Za-z0-9]*$/.test(symbol.name)) {
      return undefined;
    }
    if (!alias) {
      const reference = type as ts.TypeReference;
      if (this.checker.getTypeArguments(reference).length > 0) return undefined;
    }
    const declaration = symbol.declarations?.[0];
    if (!declaration) return undefined;
    const file = declaration.getSourceFile();
    if (file.hasNoDefaultLib || file.fileName.includes("/typescript/lib/")) return undefined;
    return dashboardDefinitionName(symbol.name);
  }

  private structuralSchema(type: ts.Type, path: string): JsonSchema {
    const flags = type.flags;
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (flags & ts.TypeFlags.Null) return { type: "null" };
    if (flags & ts.TypeFlags.BooleanLiteral) {
      return { const: (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true" };
    }
    if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (flags & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
    if (flags & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value };
    if (flags & ts.TypeFlags.String) return { type: "string" };
    if (flags & ts.TypeFlags.Number) return { type: "number" };
    if (flags & ts.TypeFlags.TemplateLiteral) return { type: "string" };
    if (type.isUnion()) return this.unionSchema(type, path);
    if (flags & ts.TypeFlags.Object || type.isIntersection()) return this.objectSchema(type, path);
    throw new Error(`Unsupported wire type at ${path}: ${this.checker.typeToString(type)}`);
  }

  private unionSchema(type: ts.UnionType, path: string): JsonSchema {
    const members = type.types.filter(
      (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0,
    );
    // `boolean` reaches a union as its two literals; fold them back before emitting members.
    const booleans = members.filter((member) => member.flags & ts.TypeFlags.BooleanLiteral);
    const folded: ts.Type[] =
      booleans.length === 2
        ? [booleans[0]!, ...members.filter((m) => (m.flags & ts.TypeFlags.BooleanLiteral) === 0)]
        : members;
    const schemas: JsonSchema[] = [];
    const seen = new Set<string>();
    for (const member of folded) {
      const schema =
        booleans.length === 2 && member === booleans[0]
          ? { type: "boolean" }
          : this.schemaFor(member, path);
      const key = JSON.stringify(schema);
      if (seen.has(key)) continue;
      seen.add(key);
      schemas.push(schema);
    }
    if (schemas.length === 0) throw new Error(`Empty union at ${path}`);
    if (schemas.length === 1) return schemas[0]!;
    // The checker interns union members in creation order, not source order; sort for stable diffs.
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    const sorted = [...schemas].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (sorted.every((schema) => "const" in schema)) {
      return { enum: sorted.map((schema) => schema["const"]) };
    }
    return { anyOf: sorted };
  }

  private objectSchema(type: ts.Type, path: string): JsonSchema {
    if (this.checker.isTupleType(type)) {
      const elements = this.checker.getTypeArguments(type as ts.TypeReference);
      return {
        type: "array",
        prefixItems: elements.map((element, index) => this.schemaFor(element, `${path}[${index}]`)),
        items: false,
      };
    }
    if (this.checker.isArrayLikeType(type)) {
      const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (element) return { type: "array", items: this.schemaFor(element, `${path}[]`) };
    }
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const property of inDeclarationOrder(this.checker.getPropertiesOfType(type))) {
      const declared = this.checker.getTypeOfSymbolAtLocation(property, this.location);
      const optional =
        (property.flags & ts.SymbolFlags.Optional) !== 0 ||
        (declared.isUnion() &&
          declared.types.some((member) => member.flags & ts.TypeFlags.Undefined));
      properties[property.name] = this.schemaFor(declared, `${path}.${property.name}`);
      if (!optional) required.push(property.name);
    }
    const schema: JsonSchema = { type: "object" };
    if (Object.keys(properties).length > 0) schema["properties"] = properties;
    if (required.length > 0) schema["required"] = required;
    const stringIndex = this.checker.getIndexInfoOfType(type, ts.IndexKind.String);
    if (stringIndex) {
      schema["additionalProperties"] = this.schemaFor(stringIndex.type, `${path}[string]`);
    }
    return schema;
  }
}

/** Resolve `DashboardV1Responses` with the TypeScript checker and emit its JSON Schemas. */
export function generateResponseSchemas(): ResponseSchemas {
  const configPath = join(specDirectory, "..", "tsconfig.typecheck.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed) throw new Error(`Unreadable TypeScript configuration: ${configPath}`);
  const entry = join(specDirectory, "responses.ts");
  const program = ts.createProgram([entry], {
    ...parsed.options,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
  });
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const messages = errors
      .slice(0, 5)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    throw new Error(`The spec type program does not compile:\n${messages.join("\n")}`);
  }
  return responseSchemasOf(program, entry, "DashboardV1Responses");
}

/**
 * Emit the JSON Schemas of one type alias in a compiled program.
 *
 * `generateResponseSchemas` uses this for `DashboardV1Responses`. A test uses it for a small
 * fixture program, so it can show that the emitted order does not follow the checker's type
 * creation order.
 */
export function responseSchemasOf(
  program: ts.Program,
  entry: string,
  aliasName: string,
): ResponseSchemas {
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`Missing spec entry point: ${entry}`);
  const checker = program.getTypeChecker();
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === aliasName) {
      const type = checker.getTypeAtLocation(statement.name);
      return new ResponseSchemaBuilder(checker, statement.name).build(type);
    }
  }
  throw new Error(`${entry} no longer declares ${aliasName}`);
}
