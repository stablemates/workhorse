/**
 * Derive the schema version a client must refuse to run below.
 *
 * A client that calls a function the installed schema does not carry fails with SQLSTATE 42883
 * once the call is made, which is after the process has started and taken work. The compatibility
 * gate exists to turn that into a refusal at startup, and it can only do so when its floor is at
 * least the version that introduced the newest object the client calls.
 *
 * The floor is derived here rather than maintained by hand: the ordered `sql/` tree says when each
 * object appeared, and the caller's own SQL says which ones it calls.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseSqlSchema } from "./sql-surface.js";
import { readSignatureSources, type SignatureSource } from "./sql-released-signatures.js";

export type { SignatureSource };
export { readSignatureSources };

/** The schema version that first carried each `workhorse.` function, table, and view. */
export function introducedVersions(sources: readonly SignatureSource[]): Map<string, number> {
  const introduced = new Map<string, number>();
  const ordered = sources.toSorted((left, right) => left.version - right.version);
  for (const source of ordered) {
    const schema = parseSqlSchema(source.source);
    for (const name of [...schema.functions.keys(), ...schema.relations.keys()]) {
      const first = introduced.get(name);
      if (first === undefined || source.version < first) introduced.set(name, source.version);
    }
  }
  return introduced;
}

/**
 * Every `workhorse.` object a caller's own source names.
 *
 * A statement catalogue and a dashboard read model both reach the schema by writing the qualified
 * name into SQL text, so one reader serves both.
 */
export function referencedObjects(source: string): Set<string> {
  return new Set(
    Array.from(source.matchAll(/workhorse\.([a-z][a-z0-9_]*)/g), (match) => match[1]!),
  );
}

/** Read every `.ts`, `.go`, `.py`, and `.sql` file under one directory, recursively. */
export async function readCallerSources(directory: string): Promise<string[]> {
  const sources: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      sources.push(...(await readCallerSources(filename)));
      continue;
    }
    if (/\.(?:ts|go|py|sql)$/.test(entry.name)) sources.push(await readFile(filename, "utf8"));
  }
  return sources;
}

/** The floor one caller needs, and the objects that set it. */
export interface RequiredFloor {
  /** The schema version the caller must refuse to run below. */
  readonly version: number;
  /** The objects introduced at that version, named so a failure says what moved the floor. */
  readonly introducedBy: string[];
}

/**
 * The floor a caller needs: the newest introduction among the objects it names.
 *
 * An object the `sql/` tree does not define is ignored rather than reported. The generated
 * catalogues and the dashboard both interpolate names the schema never carries — a column alias, a
 * partition built at runtime — and the governed-surface check is what holds the callable surface
 * honest.
 */
export function requiredFloor(
  introduced: ReadonlyMap<string, number>,
  references: Iterable<string>,
): RequiredFloor {
  let version = 1;
  let introducedBy: string[] = [];
  for (const name of references) {
    const at = introduced.get(name);
    if (at === undefined || at < version) continue;
    if (at > version) {
      version = at;
      introducedBy = [];
    }
    introducedBy.push(name);
  }
  return { version, introducedBy: introducedBy.toSorted() };
}
