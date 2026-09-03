import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FunctionDefinition, SqlSchema } from "./sql-surface.js";

/**
 * Decide which of the schema's functions, views, and columns Workhorse promises, and classify a
 * change to one of them as additive or breaking.
 *
 * The governed set is what a supported release reads, not what `protocol/v1/manifest.json`
 * declares: WH-577 found the SDKs call 33 functions and 25 tables beyond the manifest's 26, because
 * the manifest names the protocol statements while the dashboard backends build their own SQL. So
 * the set is derived from every reader instead — the manifest catalogue, which is the SQL all three
 * SDKs send, plus the three dashboard backends. Everything else in `workhorse.` is an internal
 * helper and may change in any release.
 *
 * `protocol/v1/governed-surface.json` records the result and accumulates it: the generator may add
 * to it and may never drop from it. That is what a regenerate-and-diff check cannot do on its own,
 * because a migration that drops a function drops it from `sql/schema/current.sql` too and the two
 * stay identical.
 */

export interface GovernedFunction {
  /** Positional argument types. A trailing `?` marks an argument that has a default. */
  arguments: string[];
  returns: string;
  /** The output columns, when the function returns a table. */
  returnsColumns?: Record<string, string>;
}

export interface GovernedRelation {
  kind: "table" | "view";
  columns: Record<string, string>;
}

export interface GovernedSurface {
  formatVersion: 1;
  functions: Record<string, GovernedFunction>;
  relations: Record<string, GovernedRelation>;
  /** Everything the schema installs that no supported release reads. Recorded, never promised. */
  internalHelpers: { functions: string[]; relations: string[] };
}

export interface SurfaceFinding {
  classification: "breaking";
  subject: string;
  change: string;
}

/** One file a supported release reads the schema from. */
export interface ReadSurfaceSource {
  filename: string;
  text: string;
}

/**
 * The directories a supported release reads the schema from, beside `protocol/v1/manifest.json`.
 *
 * The manifest carries the SQL all three SDKs send, because `assertNoInlineTypeScriptSql` and the
 * Python binding check keep it the only source of SDK statements. Each dashboard backend builds its
 * own SQL against the read surface, so each is a reader in its own right. Add a directory here when
 * a new backend starts reading the schema.
 */
const readSurfaceDirectories = [
  { directory: "typescript/dashboard-server/src/server", suffix: ".ts", skip: ".test.ts" },
  { directory: "go/dashboard", suffix: ".go", skip: "_test.go" },
  { directory: "python/src/workhorse/dashboard", suffix: ".py", skip: "_test.py" },
];

/** Read every file the governed set is derived from. */
export async function readSurfaceSources(repository: string): Promise<ReadSurfaceSource[]> {
  const sources: ReadSurfaceSource[] = [
    {
      filename: "protocol/v1/manifest.json",
      text: await readFile(path.join(repository, "protocol/v1/manifest.json"), "utf8"),
    },
  ];
  for (const { directory, suffix, skip } of readSurfaceDirectories) {
    async function inspect(current: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const filename = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await inspect(filename);
          continue;
        }
        if (!entry.name.endsWith(suffix) || entry.name.endsWith(skip)) continue;
        sources.push({
          filename: path.relative(repository, filename),
          text: await readFile(filename, "utf8"),
        });
      }
    }
    await inspect(path.join(repository, directory));
  }
  return sources;
}

const IDENTIFIER = /[a-z_][a-z0-9_]*/g;
const QUALIFIED = /workhorse\.([a-z_][a-z0-9_]*)/g;

/**
 * The `dashboard_*_v1` views, whose exact columns `docs/architecture.md` publishes under **Dashboard
 * package boundary** as core's relational read contract.
 *
 * They are governed whether or not this repository's own backends still read them. ADR 0039 moved
 * the dashboard's reads into SQL procedures, which left the views read only from inside the schema,
 * but it did not withdraw the published contract a backend in any language builds against.
 * `dashboard_job_result_v1` belongs to the same list and is a function rather than a view column
 * only because ADR 0027 keeps the redaction keys off the projection.
 */
function publishedReadSurface(name: string, kind: "table" | "view" | "function"): boolean {
  if (name === "dashboard_job_result_v1") return kind === "function";
  return kind === "view" && name.startsWith("dashboard_") && name.endsWith("_v1");
}

function sortedRecord<Value>(entries: Iterable<[string, Value]>): Record<string, Value> {
  return Object.fromEntries([...entries].toSorted(([left], [right]) => (left < right ? -1 : 1)));
}

function describeFunction(definition: FunctionDefinition): GovernedFunction {
  const args = definition.arguments.map((item) => `${item.type}${item.optional ? "?" : ""}`);
  const table = /^table\((.*)\)$/s.exec(definition.returns);
  if (table === null) return { arguments: args, returns: definition.returns };
  const columns = new Map<string, string>();
  for (const field of (table[1] ?? "").split(", ")) {
    const separator = field.indexOf(" ");
    if (separator > 0) columns.set(field.slice(0, separator), field.slice(separator + 1));
  }
  return { arguments: args, returns: "table", returnsColumns: sortedRecord(columns) };
}

/**
 * Derive the governed set from the schema and its readers.
 *
 * A function or relation is governed when a reader names it. A view's columns are governed whole,
 * because a `dashboard_*_v1` view exists to be a read contract and ADR 0027 puts the projection
 * itself in the promise. A table's columns are governed one by one, by the names the reader that
 * touches the table mentions. That over-approximates when two relations in one statement share a
 * column name, which over-governs an internal column rather than under-governing a read one.
 */
export function deriveGovernedSurface(
  schema: SqlSchema,
  sources: readonly ReadSurfaceSource[],
): GovernedSurface {
  const functions = new Map<string, GovernedFunction>();
  const relations = new Map<string, GovernedRelation>();

  for (const source of sources) {
    const named = new Set(Array.from(source.text.matchAll(QUALIFIED), (match) => match[1] ?? ""));
    const words = new Set(Array.from(source.text.matchAll(IDENTIFIER), (match) => match[0]));
    for (const name of named) {
      const overloads = schema.functions.get(name);
      if (overloads !== undefined) {
        const definition = overloads[0];
        if (definition !== undefined) functions.set(name, describeFunction(definition));
        continue;
      }
      const relation = schema.relations.get(name);
      if (relation === undefined) continue;
      const columns = new Map(Object.entries(relations.get(name)?.columns ?? {}));
      for (const [column, type] of relation.columns) {
        if (relation.kind === "view" || words.has(column)) columns.set(column, type);
      }
      relations.set(name, { kind: relation.kind, columns: sortedRecord(columns) });
    }
  }

  for (const [name, overloads] of schema.functions) {
    const definition = overloads[0];
    if (definition !== undefined && publishedReadSurface(name, "function")) {
      functions.set(name, describeFunction(definition));
    }
  }
  for (const [name, relation] of schema.relations) {
    if (!publishedReadSurface(name, relation.kind)) continue;
    relations.set(name, { kind: relation.kind, columns: sortedRecord(relation.columns) });
  }

  return {
    formatVersion: 1,
    functions: sortedRecord(functions),
    relations: sortedRecord(relations),
    internalHelpers: {
      functions: [...schema.functions.keys()].filter((name) => !functions.has(name)).toSorted(),
      relations: [...schema.relations.keys()].filter((name) => !relations.has(name)).toSorted(),
    },
  };
}

/** The call arities an argument list accepts, given that trailing arguments may have defaults. */
function arities(args: readonly string[]): { least: number; most: number } {
  const optional = args.filter((item) => item.endsWith("?")).length;
  return { least: args.length - optional, most: args.length };
}

function classifyArguments(promised: readonly string[], current: readonly string[]): string | null {
  for (const [index, type] of promised.entries()) {
    const now = current[index];
    if (now === undefined) return `argument ${index + 1} (${type}) was removed`;
    if (now.replace("?", "") !== type.replace("?", "")) {
      return `argument ${index + 1} changed from ${type.replace("?", "")} to ${now.replace("?", "")}`;
    }
    if (type.endsWith("?") && !now.endsWith("?")) {
      return `argument ${index + 1} (${type.replace("?", "")}) lost its default`;
    }
  }
  const was = arities(promised);
  const now = arities(current);
  if (now.least > was.least) return `a ${was.least}-argument call no longer resolves`;
  return null;
}

/** Report every promise the current schema no longer keeps. An addition produces no finding. */
export function classifyGovernedSurface(
  promised: GovernedSurface,
  current: GovernedSurface,
): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  const breaking = (subject: string, change: string): void => {
    findings.push({ classification: "breaking", subject, change });
  };

  for (const [name, was] of Object.entries(promised.functions)) {
    const now = current.functions[name];
    if (now === undefined) {
      breaking(`function workhorse.${name}`, "removed");
      continue;
    }
    const change = classifyArguments(was.arguments, now.arguments);
    if (change !== null) breaking(`function workhorse.${name}`, change);
    if (was.returns !== now.returns) {
      breaking(`function workhorse.${name}`, `returns ${was.returns} became ${now.returns}`);
      continue;
    }
    for (const [column, type] of Object.entries(was.returnsColumns ?? {})) {
      const serving = now.returnsColumns?.[column];
      if (serving === undefined)
        breaking(`function workhorse.${name}`, `output column ${column} was removed`);
      else if (serving !== type) {
        breaking(
          `function workhorse.${name}`,
          `output column ${column} changed from ${type} to ${serving}`,
        );
      }
    }
  }

  for (const [name, was] of Object.entries(promised.relations)) {
    const now = current.relations[name];
    if (now === undefined) {
      breaking(`${was.kind} workhorse.${name}`, "removed");
      continue;
    }
    for (const [column, type] of Object.entries(was.columns)) {
      const serving = now.columns[column];
      if (serving === undefined)
        breaking(`${was.kind} workhorse.${name}`, `column ${column} was removed`);
      else if (serving !== type) {
        breaking(
          `${was.kind} workhorse.${name}`,
          `column ${column} changed from ${type} to ${serving}`,
        );
      }
    }
  }
  return findings;
}

/**
 * Merge additions into the promise. The caller classifies first and refuses to merge a breaking
 * change, so this only ever widens what the schema has promised.
 */
export function mergeGovernedSurface(
  promised: GovernedSurface,
  current: GovernedSurface,
): GovernedSurface {
  const functions = new Map(Object.entries(current.functions));
  for (const [name, was] of Object.entries(promised.functions)) {
    if (!functions.has(name)) functions.set(name, was);
  }
  const relations = new Map(Object.entries(current.relations));
  for (const [name, was] of Object.entries(promised.relations)) {
    const now = relations.get(name);
    relations.set(
      name,
      now === undefined
        ? was
        : {
            kind: now.kind,
            columns: sortedRecord([...Object.entries(was.columns), ...Object.entries(now.columns)]),
          },
    );
  }
  return {
    formatVersion: 1,
    functions: sortedRecord(functions),
    relations: sortedRecord(relations),
    internalHelpers: {
      functions: current.internalHelpers.functions.filter((name) => !functions.has(name)),
      relations: current.internalHelpers.relations.filter((name) => !relations.has(name)),
    },
  };
}

export function formatFindings(findings: readonly SurfaceFinding[]): string {
  return findings.map((finding) => `  breaking: ${finding.subject} ${finding.change}`).join("\n");
}
