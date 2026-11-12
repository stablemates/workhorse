import {
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_MIGRATIONS,
  schemaCompatibilityRefusal,
  WORKHORSE_SCHEMA_VERSION,
  type WorkerClientProtocol,
} from "../schema.js";
import {
  pendingContractSteps,
  splitSqlStatements,
  type SchemaMigrationStep,
} from "../schema-migrations.js";
import { MINIMUM_POSTGRES_MAJOR, type PostgresSupport } from "../support.js";
import type { SchemaCompatibilityCode } from "../errors.js";
import type { Queryable } from "../types.js";

/**
 * Why the worker protocol counts are evidence and not an inventory.
 *
 * Reported verbatim in the payload so a script that gates on `workers` carries the caveat with it
 * rather than depending on someone having read the documentation.
 */
export const FLEET_EVIDENCE_NOTE =
  "Only workers register. Producers do not, so these counts show the workers this database can " +
  "see and are not an inventory of every process using it.";

export interface SchemaStatusReport {
  readonly schema: {
    readonly installedVersion: number | null;
    readonly expectedVersion: number;
    readonly minimumVersion: number;
    readonly clientProtocolVersion: number;
    readonly installedProtocolVersions: readonly number[] | null;
    /**
     * Contract steps still ahead of the installed version.
     *
     * Distinct from `state` on purpose: "behind" on a contract step is the operator's own
     * schedule, not a pending pipeline migration, so a deployment gate must never read one as
     * the other. Each entry names the step and the client protocols it retires.
     */
    readonly pendingContractSteps: readonly {
      readonly file: string;
      readonly fromVersion: number;
      readonly toVersion: number;
      readonly retiresProtocolVersions: readonly number[];
    }[];
    /** Where the installed version sits relative to this build. Says nothing about acceptance. */
    readonly state: "not-installed" | "behind" | "current" | "ahead";
    /** Whether this build would start against the installed schema. */
    readonly compatible: boolean;
    /** Why it would refuse, in the words the runtime itself uses. `null` when compatible. */
    readonly refusal: string | null;
    /** The same refusal as the code `SchemaCompatibilityError` carries. `null` when compatible. */
    readonly refusalCode: SchemaCompatibilityCode | null;
    /**
     * Each index in the `workhorse` schema that PostgreSQL marks not valid or not ready.
     *
     * A failed `CREATE INDEX CONCURRENTLY` leaves such an index. It serves no query. When `ready` is
     * true, each write still updates it. `IF NOT EXISTS` skips the build of the step that runs
     * again. Empty on a healthy database. An entry does not change `compatible` or the exit code.
     * A concurrent build that still runs also shows here until it ends.
     */
    readonly invalidIndexes: readonly InvalidSchemaIndex[];
  };
  readonly postgres: PostgresSupport & {
    readonly minimumMajor: number;
    readonly level: "unsupported" | "supported-untested" | "supported-tested";
  };
  /**
   * Worker evidence for a protocol retirement.
   *
   * `null` when this database cannot answer at all: no schema is installed, or the installed
   * schema predates the columns. `schema.installedVersion` says which.
   */
  readonly fleet: {
    /**
     * Distinct client protocol versions whose workers heartbeated inside their own lease, with
     * `null` covering workers whose SDK is old enough not to report one.
     */
    readonly clientProtocolVersions: readonly WorkerClientProtocol[];
    readonly note: string;
  } | null;
}

/** One index in the `workhorse` schema that PostgreSQL marks not valid or not ready. */
export interface InvalidSchemaIndex {
  /** The schema-qualified index name, quoted where PostgreSQL requires it. */
  readonly name: string;
  /** The schema-qualified table of the index. */
  readonly table: string;
  /** `pg_index.indisvalid`: whether a query can use the index. */
  readonly valid: boolean;
  /** `pg_index.indisready`: whether each write updates the index. */
  readonly ready: boolean;
  /**
   * The statement that removes the index. It is `DROP INDEX CONCURRENTLY`, apart from a
   * partitioned index, where PostgreSQL refuses `CONCURRENTLY`.
   */
  readonly dropStatement: string;
  /**
   * The last migration step that builds an index of this name, or `null` when no step does.
   * `applied` is true when the installed schema is past that step: then `workhorse schema migrate`
   * does not run it again, and the operator runs its `CREATE INDEX` statement.
   */
  readonly buildStep: {
    readonly file: string;
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly applied: boolean;
  } | null;
}

/**
 * The query that finds each index of the `workhorse` schema that is not valid or not ready.
 *
 * It reads only `pg_catalog`, so it works on each schema version and on a database with no
 * Workhorse schema. Only this CLI runs it, so it is not a statement of the protocol catalogue.
 */
const INVALID_INDEX_QUERY = `SELECT format('%I.%I', index_namespace.nspname, index_class.relname) AS name,
       index_class.relname AS index_name,
       format('%I.%I', table_namespace.nspname, table_class.relname) AS table_name,
       entry.indisvalid AS valid,
       entry.indisready AS ready,
       index_class.relkind = 'I' AS partitioned
  FROM pg_catalog.pg_index entry
  JOIN pg_catalog.pg_class index_class ON index_class.oid = entry.indexrelid
  JOIN pg_catalog.pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
  JOIN pg_catalog.pg_class table_class ON table_class.oid = entry.indrelid
  JOIN pg_catalog.pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
 WHERE index_namespace.nspname = 'workhorse'
   AND NOT (entry.indisvalid AND entry.indisready)
 ORDER BY index_class.relname`;

interface InvalidIndexRow {
  readonly name: string;
  readonly index_name: string;
  readonly table_name: string;
  readonly valid: boolean;
  readonly ready: boolean;
  readonly partitioned: boolean;
}

/** Remove the comments in front of a statement, so its first keyword starts the text. */
function withoutLeadingComments(statement: string): string {
  let text = statement.trimStart();
  for (;;) {
    if (text.startsWith("--")) {
      const end = text.indexOf("\n");
      text = end === -1 ? "" : text.slice(end + 1).trimStart();
    } else if (text.startsWith("/*")) {
      // PostgreSQL block comments nest, so the scan counts them.
      let depth = 0;
      let index = 0;
      while (index < text.length) {
        if (text.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (text.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
          if (depth === 0) break;
        } else index += 1;
      }
      text = depth === 0 ? text.slice(index).trimStart() : "";
    } else return text;
  }
}

const CREATE_INDEX =
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/i;

/** The name of the index that a `CREATE INDEX` statement builds, as `pg_class.relname` holds it. */
function builtIndexName(statement: string): string | undefined {
  const match = CREATE_INDEX.exec(withoutLeadingComments(statement));
  const name = match?.[1];
  if (name === undefined) return undefined;
  // `CREATE INDEX ON t (...)` has no name, and PostgreSQL chooses one.
  if (name.toLowerCase() === "on") return undefined;
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();
}

/**
 * Find each index of the `workhorse` schema that is not valid or not ready, and the migration step
 * that builds it.
 *
 * On a healthy database the query returns no row, and no migration file is read. Otherwise the
 * steps are read from the newest down, until each name has a step or no step is left.
 */
export async function readInvalidSchemaIndexes(
  database: Queryable,
  options: {
    readonly installedVersion: number | null;
    readonly migrations: readonly SchemaMigrationStep[];
    readonly readStep: (file: string) => Promise<string>;
  },
): Promise<InvalidSchemaIndex[]> {
  const { rows } = await database.query<InvalidIndexRow>(INVALID_INDEX_QUERY);
  if (rows.length === 0) return [];
  const wanted = new Set(rows.map((row) => row.index_name));
  const builders = new Map<string, SchemaMigrationStep>();
  const newestFirst = options.migrations.toSorted(
    (left, right) => right.toVersion - left.toVersion,
  );
  for (const step of newestFirst) {
    if (builders.size === wanted.size) break;
    for (const statement of splitSqlStatements(await options.readStep(step.file))) {
      const name = builtIndexName(statement);
      if (name !== undefined && wanted.has(name) && !builders.has(name)) builders.set(name, step);
    }
  }
  return rows.map((row) => {
    const step = builders.get(row.index_name);
    return {
      name: row.name,
      table: row.table_name,
      valid: row.valid,
      ready: row.ready,
      dropStatement: `DROP INDEX ${row.partitioned ? "" : "CONCURRENTLY "}IF EXISTS ${row.name};`,
      buildStep:
        step === undefined
          ? null
          : {
              file: step.file,
              fromVersion: step.fromVersion,
              toVersion: step.toVersion,
              applied:
                options.installedVersion !== null && options.installedVersion >= step.toVersion,
            },
    };
  });
}

/** The text lines of `workhorse schema status` for the indexes that are not valid or not ready. */
export function describeInvalidSchemaIndexes(indexes: readonly InvalidSchemaIndex[]): string {
  if (indexes.length === 0) return "";
  const lines = indexes.flatMap((index) => {
    const state = index.valid ? "not ready" : "not valid";
    const rebuild =
      index.buildStep === null
        ? "No migration step builds an index of this name."
        : index.buildStep.applied
          ? `Then run the CREATE INDEX statement of migration ${index.buildStep.file} again, because the schema is past that step.`
          : `Then run "workhorse schema migrate". Migration ${index.buildStep.file} builds the index again.`;
    return [
      `Index ${index.name} on ${index.table} is ${state}. Drop it with: ${index.dropStatement}`,
      `  ${rebuild}`,
    ];
  });
  lines.push(
    "A CREATE INDEX CONCURRENTLY that still runs also shows as not valid. Drop an index only when no build of it runs.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Report the installed schema as two independent facts: where it sits, and whether this build
 * accepts it.
 *
 * Those were one field until 0.1.0, when a migration became something a running deployment applies
 * rather than a reason to recreate the database. A schema ahead of this build is now the normal
 * middle of a rolling upgrade, because inside a major line a migration only adds
 * ([ADR 0053](../../../../docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)).
 * A deployment gate reads `compatible`; an operator asking what happened reads `state`.
 */
export function createSchemaStatusReport(
  installedVersion: number | null,
  installedProtocolVersions: readonly number[] | null,
  support: PostgresSupport,
  workerClientProtocols: readonly WorkerClientProtocol[] | null,
  migrations: readonly SchemaMigrationStep[] = SCHEMA_MIGRATIONS,
  invalidIndexes: readonly InvalidSchemaIndex[] = [],
): SchemaStatusReport {
  // A missing schema reaches the CLI as a missing relation rather than an ambiguous row, so it
  // gets the sentence that names the step an operator has not run yet.
  const refusal =
    installedVersion === null
      ? {
          code: "schema-not-installed" as const,
          message:
            "No Workhorse schema is installed. Run the schema installation step before starting this release.",
        }
      : schemaCompatibilityRefusal({
          schemaVersion: installedVersion,
          servedProtocolVersions: installedProtocolVersions ?? [],
        });
  return {
    schema: {
      installedVersion,
      expectedVersion: WORKHORSE_SCHEMA_VERSION,
      minimumVersion: MINIMUM_SCHEMA_VERSION,
      clientProtocolVersion: PROTOCOL_VERSION,
      installedProtocolVersions,
      pendingContractSteps: pendingContractSteps(migrations, installedVersion).map((step) => ({
        file: step.file,
        fromVersion: step.fromVersion,
        toVersion: step.toVersion,
        retiresProtocolVersions: step.retiresProtocolVersions ?? [],
      })),
      state:
        installedVersion === null
          ? "not-installed"
          : installedVersion < WORKHORSE_SCHEMA_VERSION
            ? "behind"
            : installedVersion > WORKHORSE_SCHEMA_VERSION
              ? "ahead"
              : "current",
      compatible: refusal === null,
      refusal: refusal === null ? null : refusal.message,
      refusalCode: refusal === null ? null : refusal.code,
      invalidIndexes,
    },
    fleet:
      workerClientProtocols === null
        ? null
        : { clientProtocolVersions: workerClientProtocols, note: FLEET_EVIDENCE_NOTE },
    postgres: {
      ...support,
      minimumMajor: MINIMUM_POSTGRES_MAJOR,
      level: !support.supported
        ? "unsupported"
        : support.tested
          ? "supported-tested"
          : "supported-untested",
    },
  };
}
