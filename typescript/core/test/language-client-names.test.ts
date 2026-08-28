import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../../..");
const languages = ["typescript", "python", "go"] as const;

type Language = (typeof languages)[number];

interface DocumentedName {
  concern: string;
  language: Language;
  member?: string;
  owner: string;
}

interface PublicSurface {
  exports: Set<string>;
  members: Map<string, Set<string>>;
}

function publicNames(
  concern: string,
  identifiers: Record<Language, readonly string[]>,
): DocumentedName[] {
  return languages.flatMap((language) =>
    identifiers[language].map((identifier) => {
      const parts = identifier.split(".");
      if (parts.length > 2) throw new Error(`Invalid public identifier: ${identifier}`);
      return { concern, language, member: parts[1], owner: parts[0]! };
    }),
  );
}

// This code-owned map checks the shared client vocabulary without publishing it as an invitation
// to implement more runtimes. Capability support remains owned by parity-capabilities.ts.
const names: readonly DocumentedName[] = [
  ...publicNames("Application client", {
    typescript: ["Queue"],
    python: ["Queue", "AsyncQueue"],
    go: ["Queue"],
  }),
  ...publicNames("Operator client", {
    typescript: ["Admin"],
    python: ["Admin", "AsyncAdmin"],
    go: ["Admin"],
  }),
  ...publicNames("Single enqueue", {
    typescript: ["Queue.enqueue"],
    python: ["Queue.enqueue"],
    go: ["Queue.Enqueue"],
  }),
  ...publicNames("Batch enqueue", {
    typescript: ["Queue.enqueueMany"],
    python: ["Queue.enqueue_many"],
    go: ["Queue.EnqueueMany"],
  }),
  ...publicNames("Schedule sync", {
    typescript: ["Queue.syncSchedules"],
    python: ["Queue.sync_schedules"],
    go: ["Queue.SyncSchedules"],
  }),
  ...publicNames("Cancellation", {
    typescript: ["Queue.cancel"],
    python: ["Queue.cancel"],
    go: ["Queue.Cancel"],
  }),
  ...publicNames("Worker runtime", {
    typescript: ["Worker"],
    python: ["Worker", "AsyncWorker"],
    go: ["Worker"],
  }),
  ...publicNames("Handler registration", {
    typescript: ["Worker.handle"],
    python: ["Worker.handle"],
    go: ["Worker.Handle"],
  }),
  ...publicNames("Batch registration", {
    typescript: ["Worker.handleBatch"],
    python: ["Worker.handle_batch"],
    go: ["Worker.HandleBatch"],
  }),
  ...publicNames("Run loop", {
    typescript: ["Worker.run"],
    python: ["Worker.run"],
    go: ["Worker.Run"],
  }),
  ...publicNames("One dispatch pass", {
    typescript: ["Worker.runOnce"],
    python: ["Worker.run_once"],
    go: ["Worker.RunOnce"],
  }),
];

async function filesInDirectory(root: string, extension: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(extension)) files.push(path.join(root, entry.name));
  }
  return files.toSorted();
}

function typescriptSurface(): PublicSurface {
  const configPath = path.join(repository, "typescript", "core", "tsconfig.typecheck.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const index = program.getSourceFile(
    path.join(repository, "typescript", "core", "src", "index.ts"),
  );
  if (!index) throw new Error("TypeScript public entrypoint is missing from the typecheck program");
  const module = checker.getSymbolAtLocation(index);
  if (!module) throw new Error("TypeScript public entrypoint has no module symbol");

  const exports = new Set<string>();
  const members = new Map<string, Set<string>>();
  for (const exported of checker.getExportsOfModule(module)) {
    exports.add(exported.name);
    const declaration =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (!(declaration.flags & ts.SymbolFlags.Class)) continue;
    const classMembers = new Set<string>();
    const instance = checker.getDeclaredTypeOfSymbol(declaration);
    for (const member of checker.getPropertiesOfType(instance)) {
      const hasPublicMethod = member.declarations?.some((method) => {
        if (!ts.isMethodDeclaration(method) || !method.name || !ts.isIdentifier(method.name)) {
          return false;
        }
        const modifiers = ts.canHaveModifiers(method) ? ts.getModifiers(method) : undefined;
        return !modifiers?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword,
        );
      });
      if (hasPublicMethod) classMembers.add(member.name);
    }
    members.set(exported.name, classMembers);
  }
  return { exports, members };
}

interface PythonClass {
  bases: string[];
  members: Set<string>;
}

function pythonImports(source: string): Map<string, { module: string; name: string }> {
  const imports = new Map<string, { module: string; name: string }>();
  let module: string | undefined;
  for (const line of source.split("\n")) {
    const multiline = line.match(/^from \.(\w+) import \($/);
    if (multiline) {
      module = multiline[1]!;
      continue;
    }
    if (module !== undefined) {
      if (line === ")") {
        module = undefined;
        continue;
      }
      const name = line.trim().replace(/,$/, "");
      if (name.length > 0) imports.set(name, { module, name });
      continue;
    }
    const singleLine = line.match(/^from \.(\w+) import (.+)$/);
    if (!singleLine) continue;
    for (const name of singleLine[2]!.split(",").map((part) => part.trim())) {
      imports.set(name, { module: singleLine[1]!, name });
    }
  }
  return imports;
}

function pythonClasses(source: string): Map<string, PythonClass> {
  const result = new Map<string, PythonClass>();
  const classes = [...source.matchAll(/^class\s+(\w+)(?:\(([^)]*)\))?[^:]*:\s*$/gm)];
  for (const declaration of classes) {
    const start = declaration.index! + declaration[0].length;
    const nextTopLevel = source.slice(start).search(/^\S/gm);
    const end = nextTopLevel === -1 ? source.length : start + nextTopLevel;
    const body = source.slice(start, end);
    result.set(declaration[1]!, {
      bases: (declaration[2] ?? "")
        .split(",")
        .map((base) => base.trim())
        .filter(Boolean),
      members: new Set(
        [...body.matchAll(/^ {4}(?:async\s+)?def\s+(\w+)\s*\(/gm)]
          .map((match) => match[1]!)
          .filter((member) => !member.startsWith("_")),
      ),
    });
  }
  return result;
}

function pythonClassMembers(
  name: string,
  classes: Map<string, PythonClass>,
  visited = new Set<string>(),
): Set<string> {
  if (visited.has(name)) return new Set();
  visited.add(name);
  const declaration = classes.get(name);
  if (!declaration) return new Set();
  const members = new Set(declaration.members);
  for (const base of declaration.bases) {
    for (const member of pythonClassMembers(base, classes, visited)) members.add(member);
  }
  return members;
}

async function pythonSurface(): Promise<PublicSurface> {
  const root = path.join(repository, "python", "src", "workhorse");
  const packageSource = await readFile(path.join(root, "__init__.py"), "utf8");
  const allBlock = packageSource.match(/__all__\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  const exports = new Set([...allBlock.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!));
  const bindings = pythonImports(packageSource);
  const members = new Map<string, Set<string>>();
  const moduleClasses = new Map<string, Map<string, PythonClass>>();

  for (const exportedName of exports) {
    const binding = bindings.get(exportedName);
    if (!binding) continue;
    let classes = moduleClasses.get(binding.module);
    if (!classes) {
      classes = pythonClasses(await readFile(path.join(root, `${binding.module}.py`), "utf8"));
      moduleClasses.set(binding.module, classes);
    }
    if (classes.has(binding.name)) {
      members.set(exportedName, pythonClassMembers(binding.name, classes));
    }
  }
  return { exports, members };
}

async function goSurface(): Promise<PublicSurface> {
  const root = path.join(repository, "go");
  const exports = new Set<string>();
  const members = new Map<string, Set<string>>();

  for (const file of (await filesInDirectory(root, ".go")).filter(
    (filename) => !filename.endsWith("_test.go"),
  )) {
    const source = await readFile(file, "utf8");
    if (!/^package workhorse$/m.test(source)) continue;
    for (const match of source.matchAll(/^type\s+([A-Z]\w*)\s+/gm)) exports.add(match[1]!);
    for (const match of source.matchAll(
      /^func\s+\(\s*\w+\s+\*?([A-Z]\w*)\s*\)\s+([A-Z]\w*)\s*\(/gm,
    )) {
      const classMembers = members.get(match[1]!) ?? new Set<string>();
      classMembers.add(match[2]!);
      members.set(match[1]!, classMembers);
    }
  }
  return { exports, members };
}

const surfaces: Record<Language, PublicSurface> = {
  typescript: typescriptSurface(),
  python: await pythonSurface(),
  go: await goSurface(),
};

describe("language-client public-name parity", () => {
  it("contains identifiers for every language", () => {
    expect(new Set(names.map((name) => name.language))).toEqual(new Set(languages));
  });

  it.each(names.map((name) => [name.concern, name.language, name] as const))(
    "%s names an exported %s identifier",
    (unusedConcern, unusedLanguage, documented) => {
      const surface = surfaces[documented.language];
      const exists =
        surface.exports.has(documented.owner) &&
        (documented.member === undefined ||
          surface.members.get(documented.owner)?.has(documented.member) === true);
      expect(exists).toBe(true);
    },
  );
});
