/**
 * Refuse a migration that redefines a released function's signature.
 *
 * Inside a major line a migration only adds, so a process from an older release keeps calling the
 * functions it was built against ([ADR 0053](../docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
 * [ADR 0057](../docs/decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)).
 * A `CREATE OR REPLACE FUNCTION` is how a released defect is fixed, so replacing a body is allowed
 * and replacing a signature is not: a caller binds to the argument list and the returned columns,
 * and a rolling deployment has no moment at which both shapes are correct. A new shape ships as the
 * next `_vN` beside its predecessor.
 *
 * The check reads text rather than a database, because it runs wherever the migration lint runs.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseSqlSchema, type FunctionDefinition } from "./sql-surface.js";

/** One clean-install artifact or one migration step, named by the schema version it produces. */
export interface SignatureSource {
  /** `release` for `sql/releases/<NNNN>.sql`, `migration` for `sql/migrations/<NNNN>-*.sql`. */
  readonly kind: "release" | "migration";
  /** The schema version the file installs or migrates to. */
  readonly version: number;
  /** The file name, used to name an offender. */
  readonly file: string;
  /** The file's SQL text. */
  readonly source: string;
}

/** One migration that gave a released function a signature the release did not ship. */
export interface SignatureDrift {
  /** The migration file that redefined the function. */
  readonly file: string;
  /** The function's unqualified name. */
  readonly function: string;
  /** The signature the earlier release or migration shipped. */
  readonly released: string;
  /** The signature this migration writes. */
  readonly redefined: string;
  /** The file that shipped `released`. */
  readonly releasedBy: string;
}

/** The signature a caller binds to: the argument list it passes and the columns it reads back. */
function signatureOf(definition: FunctionDefinition): string {
  const args = definition.arguments
    .map((argument) => `${argument.name} ${argument.type}${argument.optional ? " DEFAULT" : ""}`)
    .join(", ");
  return `(${args}) RETURNS ${definition.returns}`;
}

/**
 * An overload is a separate function, so the argument count joins the name in the key. Two
 * overloads of one name may legitimately differ; the same overload may not change underneath a
 * caller.
 */
function keyOf(definition: FunctionDefinition): string {
  return `${definition.name}/${definition.arguments.length}`;
}

/**
 * Report every migration that redefines a function an earlier artifact or migration shipped with a
 * different signature.
 *
 * Sources are read in schema-version order. A release artifact and the migration of the same
 * version describe the same installation, and the artifact is what shipped, so it is read second
 * and its signatures win. Only a migration can offend: an artifact restates a shape rather than
 * changing one, and the released-artifact rehearsal already proves the two agree.
 */
export function findSignatureDrift(sources: readonly SignatureSource[]): SignatureDrift[] {
  const ordered = sources.toSorted(
    (left, right) =>
      left.version - right.version ||
      (left.kind === "migration" ? 0 : 1) - (right.kind === "migration" ? 0 : 1) ||
      left.file.localeCompare(right.file),
  );
  const shipped = new Map<string, { signature: string; file: string }>();
  const drift: SignatureDrift[] = [];
  for (const source of ordered) {
    for (const overloads of parseSqlSchema(source.source).functions.values()) {
      for (const definition of overloads) {
        const key = keyOf(definition);
        const signature = signatureOf(definition);
        const previous = shipped.get(key);
        if (previous !== undefined && previous.signature !== signature) {
          if (source.kind === "migration")
            drift.push({
              file: source.file,
              function: definition.name,
              released: previous.signature,
              redefined: signature,
              releasedBy: previous.file,
            });
        }
        shipped.set(key, { signature, file: source.file });
      }
    }
  }
  return drift;
}

/** Read every frozen artifact and every migration step out of the repository's `sql/` tree. */
export async function readSignatureSources(repository: string): Promise<SignatureSource[]> {
  const sources: SignatureSource[] = [];
  for (const kind of ["release", "migration"] as const) {
    const directory = path.join(repository, "sql", kind === "release" ? "releases" : "migrations");
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".sql")) continue;
      sources.push({
        kind,
        version: Number.parseInt(file, 10),
        file: `sql/${kind === "release" ? "releases" : "migrations"}/${file}`,
        source: await readFile(path.join(directory, file), "utf8"),
      });
    }
  }
  return sources;
}

/** The sentence an offender reads in the lint's failure. */
export function formatSignatureDrift(drift: SignatureDrift): string {
  return `${drift.file}: workhorse.${drift.function} redefines the signature ${drift.releasedBy} shipped. Add the next _vN beside it instead.\n  shipped:   ${drift.released}\n  redefined: ${drift.redefined}`;
}
