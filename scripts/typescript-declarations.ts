import ts from "typescript";

import { repositoryRoot } from "./packages.js";

/**
 * Print TypeScript declarations for a committed snapshot, and close over what they reach.
 *
 * Two snapshots need the same rendering. `api/typescript.txt` prints every declaration a published
 * `exports` subpath reaches, and `api/cli.txt` prints every declaration a `--json` payload type
 * reaches. Both promise the same thing about a printed shape — that removing a field, renaming one,
 * or narrowing its type is breaking — so both print it the same way and share this module.
 *
 * A declaration a dependency owns is named and not printed. `Pool` comes from `pg`, and its members
 * move with a dependency range rather than with this repository's release; "Moving a dependency
 * range" in `docs/compatibility.md` governs that move instead.
 */

/** Compare by UTF-16 code unit so the ordering does not depend on the machine's locale. */
export function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The npm package a `node_modules` declaration belongs to, for example `@types/pg`. */
function externalPackage(fileName: string): string {
  const segments = fileName.split("/node_modules/").at(-1)!.split("/");
  return segments[0]!.startsWith("@") ? `${segments[0]!}/${segments[1]!}` : segments[0]!;
}

/**
 * Whether a declaration lives outside this repository's sources.
 *
 * pnpm links workspace packages into `node_modules` and TypeScript resolves those links, so a
 * sibling package's declarations arrive as a real path under the repository root. Only a
 * third-party or standard-library declaration stays inside a `node_modules` directory.
 */
function isExternal(declaration: ts.Declaration): boolean {
  const fileName = declaration.getSourceFile().fileName;
  return fileName.includes("/node_modules/") || !fileName.startsWith(`${repositoryRoot}/`);
}

function kindOf(symbol: ts.Symbol): string {
  const flags = symbol.flags;
  if (flags & ts.SymbolFlags.Class) return "class";
  if (flags & ts.SymbolFlags.Interface) return "interface";
  if (flags & ts.SymbolFlags.TypeAlias) return "type";
  if (flags & ts.SymbolFlags.Enum) return "enum";
  if (flags & ts.SymbolFlags.Function) return "function";
  if (flags & ts.SymbolFlags.Module) return "namespace";
  if (flags & ts.SymbolFlags.Variable) return "const";
  return "value";
}

/** Declaration kinds worth printing. A parameter or an import is reached, never rendered. */
function isRenderable(declaration: ts.Declaration): boolean {
  return (
    ts.isClassDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration) ||
    ts.isModuleDeclaration(declaration) ||
    ts.isVariableDeclaration(declaration)
  );
}

/** The name a declaration declares, when it has one. A default export declares none. */
function declaredNameOf(declaration: ts.Declaration): string | undefined {
  return (declaration as { name?: ts.Node }).name?.getText();
}

/**
 * Source text of one declaration, without the modifiers that only say where it came from.
 *
 * `export` and `declare` describe the file the declaration sits in, and this snapshot states that
 * in its own headings, so keeping them would only add a word to every line. A `private` member is
 * not on the surface at all: it appears in the emitted `.d.ts` to reserve the name, and a caller
 * cannot reach it, so removing one is not a break and must not read as a diff.
 */
function declarationText(declaration: ts.Declaration): string {
  // A `const` in a `.d.ts` is one declarator of a statement, and the statement carries `declare`.
  const node: ts.Node = ts.isVariableDeclaration(declaration)
    ? declaration.parent.parent
    : declaration;
  const text = node
    .getText()
    .replace(/^export\s+/, "")
    .replace(/^declare\s+/, "");
  const lines = text.split("\n").filter((line) => !/^\s*private\s/.test(line));
  // tsc emits four-space indentation; two keeps a deeply nested member inside a readable width.
  return lines
    .map((line) => line.replace(/^ +/, (spaces) => " ".repeat(spaces.length / 2)))
    .join("\n");
}

/** One rendered declaration and the sort key it is filed under. */
export interface Block {
  readonly name: string;
  readonly text: string;
}

/**
 * The whole surface, gathered across every entry point.
 *
 * A name and its shape are recorded apart because the two break differently. Which names an
 * `exports` subpath reaches is a property of that subpath, and dropping one there is breaking even
 * when a sibling subpath still exports it. A shape is a property of the declaration, and four
 * adapters re-exporting the same core type do not make it four promises, so each declaration is
 * printed once.
 */
export class DeclarationCollector {
  private readonly printed = new Set<ts.Declaration>();
  private readonly pending: ts.Symbol[] = [];
  /** Every repository declaration any entry point reached. */
  readonly declarations: Block[] = [];

  constructor(private readonly checker: ts.TypeChecker) {}

  /** Resolve export and import aliases to the declaration that carries the shape. */
  private resolve(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  /**
   * Record one exported name and return the line the entry point lists it under.
   *
   * A renamed re-export names the declaration it resolves to, because the name a caller writes is
   * the name the promise is about and the shape is filed under the other one.
   */
  exportLine(exportedName: string, exported: ts.Symbol): string {
    const symbol = this.resolve(exported);
    const kind = kindOf(symbol);
    const declarations = (symbol.declarations ?? []).filter(isRenderable);
    if (declarations.length === 0) return `${kind} ${exportedName}`;
    const first = declarations[0]!;
    if (isExternal(first)) {
      return `${kind} ${exportedName} (external: ${externalPackage(first.getSourceFile().fileName)})`;
    }
    this.collect(symbol, declarations);
    const declaredName = declaredNameOf(first);
    return declaredName === undefined || declaredName === exportedName
      ? `${kind} ${exportedName}`
      : `${kind} ${exportedName} = ${declaredName}`;
  }

  /**
   * Record one type a table points at directly, and answer the name to print for it.
   *
   * {@link exportLine} answers about a name an `exports` subpath reaches, so it leads with the
   * declaration's kind. This answers about a type a caller has its own label for — the payload one
   * `--json` command emits — where the kind would only repeat what the surrounding table says.
   */
  typeName(symbol: ts.Symbol): string {
    const resolved = this.resolve(symbol);
    const declarations = (resolved.declarations ?? []).filter(isRenderable);
    const first = declarations[0];
    if (first === undefined) return resolved.getName();
    if (isExternal(first)) {
      return `${resolved.getName()} (external: ${externalPackage(first.getSourceFile().fileName)})`;
    }
    this.collect(resolved, declarations);
    return declaredNameOf(first) ?? resolved.getName();
  }

  /** Print every repository declaration the recorded names reached, transitively. */
  closeOver(): void {
    while (this.pending.length > 0) {
      const symbol = this.pending.shift()!;
      this.collect(symbol, (symbol.declarations ?? []).filter(isRenderable));
    }
  }

  private collect(symbol: ts.Symbol, declarations: readonly ts.Declaration[]): void {
    const fresh = declarations.filter((declaration) => !this.printed.has(declaration));
    if (fresh.length === 0) return;
    for (const declaration of fresh) {
      this.printed.add(declaration);
      this.recordReferences(declaration);
    }
    this.declarations.push({
      name: declaredNameOf(declarations[0]!) ?? symbol.getName(),
      text: fresh.map((declaration) => declarationText(declaration)).join("\n"),
    });
  }

  /**
   * Queue every repository type a node names, so each one's shape is printed too.
   *
   * A declaration reaches its own references this way. So does a caller holding a type expression
   * rather than a name: a `--json` payload may be an array or a union of two shapes, and each shape
   * it reaches has to be printed for the field list to be complete.
   */
  recordReferences(node: ts.Node): void {
    const reference = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isExpressionWithTypeArguments(node)
        ? node.expression
        : ts.isTypeQueryNode(node)
          ? node.exprName
          : undefined;
    if (reference) {
      const symbol = this.checker.getSymbolAtLocation(reference);
      if (symbol) this.enqueue(this.resolve(symbol));
    }
    ts.forEachChild(node, (child) => this.recordReferences(child));
  }

  private enqueue(symbol: ts.Symbol): void {
    if (symbol.flags & ts.SymbolFlags.TypeParameter) return;
    const declarations = (symbol.declarations ?? []).filter(isRenderable);
    if (declarations.length === 0 || isExternal(declarations[0]!)) return;
    if (declarations.every((declaration) => this.printed.has(declaration))) return;
    this.pending.push(symbol);
  }
}

export function renderBlocks(blocks: readonly Block[]): string {
  return blocks
    .toSorted((left, right) => compare(left.name, right.name) || compare(left.text, right.text))
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * A program over already-emitted declaration files.
 *
 * Nothing is compiled or checked: the snapshots read shapes the build already produced, so a
 * generator run must never fail on a diagnostic the build itself accepted.
 */
export function declarationProgram(rootNames: readonly string[]): ts.Program {
  return ts.createProgram({
    rootNames: [...rootNames],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
  });
}

/** The source file at `fileName`, or a failure naming the build step that writes it. */
export function requireSourceFile(program: ts.Program, fileName: string): ts.SourceFile {
  const source = program.getSourceFile(fileName);
  if (!source) {
    throw new Error(`Missing declarations at ${fileName}; run pnpm build:runtime:dev first`);
  }
  return source;
}
