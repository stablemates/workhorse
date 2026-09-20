import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";
import { propertiesInDeclarationOrder } from "../spec/response-schemas.js";

/**
 * The spec generator must emit properties in an order unrelated types cannot move.
 *
 * `DashboardTasksCursorPage` extends `Omit<DashboardTasksPage, "total" | "hasMore">`. A mapped
 * type iterates its key union, and the checker interns a string literal union in type-id order,
 * so whichever module first creates `"tasks"` decides where that key lands. SM-810 hit this: a
 * private `{ tasks: ClaimedTask[] }` in core reordered `dashboard/v1` and rewrote the Go and
 * Python bindings. These programs reproduce that instability in miniature.
 */

const libDirectory = dirname(ts.getDefaultLibFilePath({}));

/** A program over in-memory sources, with the real TypeScript lib files behind them. */
function createProgram(sources: Record<string, string>, roots: string[]): ts.Program {
  const files = new Map<string, ts.SourceFile>();
  const load = (name: string): ts.SourceFile | undefined => {
    const cached = files.get(name);
    if (cached) return cached;
    const text = sources[name] ?? (name.startsWith("/lib.") ? readLib(name) : undefined);
    if (text === undefined) return undefined;
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
    files.set(name, file);
    return file;
  };
  const readLib = (name: string): string | undefined => {
    try {
      return readFileSync(join(libDirectory, name.slice(1)), "utf8");
    } catch {
      return undefined;
    }
  };
  const host: ts.CompilerHost = {
    getSourceFile: load,
    writeFile: () => undefined,
    getDefaultLibFileName: () => "/lib.es2022.full.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    fileExists: (name) => load(name) !== undefined,
    readFile: (name) => load(name)?.text,
  };
  return ts.createProgram(roots, { target: ts.ScriptTarget.ES2022, strict: true }, host);
}

/** The type of one exported alias, which must exist. */
function aliasType(program: ts.Program, file: string, name: string): ts.Type {
  const source = program.getSourceFile(file)!;
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
      return program.getTypeChecker().getTypeAtLocation(statement.name);
    }
  }
  throw new Error(`The test program no longer declares ${name} in ${file}`);
}

const wire = `
export interface Page {
  capturedAt: string;
  tasks: string[];
  total: number;
  hasMore: boolean;
}
export interface CursorPage extends Omit<Page, "total" | "hasMore"> {
  nextCursor: string | null;
}
`;

/**
 * Resolve `CursorPage` in a program that first creates the key literals in the given order.
 *
 * Resolving the unrelated aliases before the subject is what a core module does when it declares
 * a type carrying one of these keys: it interns those literals, and every later union of them
 * takes their type ids.
 */
function resolveCursorPage(keys: readonly string[]): Resolved {
  const unrelated = keys
    .map((key, index) => `export type Key${index} = ${JSON.stringify(key)};`)
    .join("\n");
  const program = createProgram({ "/wire.ts": wire, "/unrelated.ts": unrelated }, [
    "/unrelated.ts",
    "/wire.ts",
  ]);
  for (let index = 0; index < keys.length; index += 1) {
    aliasType(program, "/unrelated.ts", `Key${index}`);
  }
  const checker = program.getTypeChecker();
  const source = program.getSourceFile("/wire.ts")!;
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "CursorPage",
  )!;
  return { checker, type: checker.getTypeAtLocation(declaration.name) };
}

type Resolved = { checker: ts.TypeChecker; type: ts.Type };

/** The property order the checker itself reports, which an unrelated type can move. */
function checkerOrder({ checker, type }: Resolved): string[] {
  return checker.getPropertiesOfType(type).map((symbol) => symbol.name);
}

/** The property order the generator emits. */
function emittedOrder({ checker, type }: Resolved): string[] {
  return propertiesInDeclarationOrder(checker, type).map((symbol) => symbol.name);
}

const forward = ["capturedAt", "tasks", "total", "hasMore"];
const reversed = ["hasMore", "total", "tasks", "capturedAt"];

it("orders properties by declaration site, not by checker type-creation order", () => {
  const first = resolveCursorPage(forward);
  const second = resolveCursorPage(reversed);

  // The bug this pins is real: the checker itself orders the two programs differently.
  expect(
    checkerOrder(second),
    "the checker no longer reorders; this test proves nothing",
  ).not.toEqual(checkerOrder(first));

  // The generator's order does not move with it, and follows the source.
  expect(emittedOrder(first)).toEqual(["capturedAt", "tasks", "nextCursor"]);
  expect(emittedOrder(second)).toEqual(["capturedAt", "tasks", "nextCursor"]);
});

it("orders properties the checker synthesized without a declaration by name", () => {
  const program = createProgram(
    {
      "/entry.ts": `
export type Filter = "queued" | "all" | "running";
export type Subject = Record<Filter, number>;
`,
    },
    ["/entry.ts"],
  );
  const type = aliasType(program, "/entry.ts", "Subject");
  const names = propertiesInDeclarationOrder(program.getTypeChecker(), type).map(
    (symbol) => symbol.name,
  );
  expect(names).toEqual(["all", "queued", "running"]);
});
