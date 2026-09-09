import {
  MAXIMUM_PROTOCOL_VERSION,
  MAXIMUM_SCHEMA_VERSION,
  MINIMUM_PROTOCOL_VERSION,
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  SQL_STATEMENTS,
  WORKHORSE_SCHEMA_BASELINE_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "./queue/sql-catalogue.generated.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expectOneRow, SchemaCompatibilityError, type SchemaCompatibilityCode } from "./errors.js";
import {
  applySchemaMigrationPlan,
  SCHEMA_MIGRATION_LOCK_TIMEOUT_MS,
  isMissingDatabaseFunctionError,
  isMissingDatabaseRelationError,
  readCompatibilityState,
  readProtocolVersions,
  readSchemaVersion,
  type CompatibilityState,
  type SchemaMigrationStep,
} from "./schema-migrations.js";
import { assertSupportedPostgres } from "./support.js";
import type { Queryable } from "./types.js";

export {
  MAXIMUM_PROTOCOL_VERSION,
  MAXIMUM_SCHEMA_VERSION,
  MINIMUM_PROTOCOL_VERSION,
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  WORKHORSE_SCHEMA_BASELINE_VERSION,
  WORKHORSE_SCHEMA_VERSION,
};

// Version 1 is the permanent baseline, installed whole from sql/schema.sql; every later version
// arrives as one ordered, immutable step here. 0.1.0 publishes the baseline and no step, so the
// first entry lands with the first schema change after it.
const SCHEMA_MIGRATIONS: readonly SchemaMigrationStep[] = [];

function sqlAsset(relativePath: string): URL {
  const packaged = new URL(`../sql/${relativePath}`, import.meta.url);
  if (existsSync(fileURLToPath(packaged))) return packaged;
  const repositoryPath = relativePath === "schema.sql" ? "schema/current.sql" : relativePath;
  return new URL(`../../../sql/${repositoryPath}`, import.meta.url);
}

/** One client protocol version and how many live workers reported it. */
export interface WorkerClientProtocol {
  /** The protocol version, or `null` for workers whose SDK predates the column. */
  readonly version: number | null;
  readonly workers: number;
}

/**
 * Which client protocol versions the visible fleet is still speaking, or `null` when the installed
 * schema is too old to record them.
 *
 * `workhorse schema contract` removes superseded functions and narrows
 * `workhorse.protocol_version`, which stops every process that speaks a removed protocol
 * ([ADR 0057](../../../docs/decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)).
 * This is the evidence that step is gated on. It is evidence and not proof: producers never
 * register, so a protocol absent here may still have callers.
 *
 * A schema below version 2 has no such function, which is the normal first half of a rolling
 * upgrade. That returns `null` rather than throwing, because the command an operator runs to
 * discover the schema is behind must not fail on the schema being behind.
 */
export async function readWorkerClientProtocols(
  database: Queryable,
): Promise<WorkerClientProtocol[] | null> {
  try {
    const result = await database.query<{
      client_protocol_version: number | null;
      workers: number;
    }>(SQL_STATEMENTS["worker_client_protocols_v1"]);
    return result.rows.map((row) => ({
      version: row.client_protocol_version,
      workers: row.workers,
    }));
  } catch (error) {
    if (isMissingDatabaseFunctionError(error) || isMissingDatabaseRelationError(error)) return null;
    throw error;
  }
}

export {
  isMissingDatabaseRelationError,
  readProtocolVersions,
  readSchemaVersion,
  SCHEMA_MIGRATION_LOCK_TIMEOUT_MS,
};

/**
 * Check compatibility without creating or changing database objects.
 *
 * The runtime declares a floor and no ceiling. Inside a major line a migration only adds
 * ([ADR 0053](../../../docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)),
 * so a schema newer than the one this build was compiled against still carries every function it
 * calls, and refusing it would turn every rolling deployment into an outage. The ceiling comes
 * from the database instead: `workhorse.protocol_version` lists the client protocols the installed
 * schema still answers, and a major release drops the ones it stops serving.
 *
 * A refusal throws {@link SchemaCompatibilityError}, whose `code` names it in the vocabulary
 * Python and Go share. A database this cannot read at all throws a plain `Error`, because an
 * unreachable database is not a verdict about versions.
 */
export async function assertSchemaCompatible(database: Queryable): Promise<void> {
  let state: CompatibilityState;
  try {
    state = await readCompatibilityState(database);
  } catch (error) {
    // A missing relation is a version disagreement an operator can act on, so it carries a code.
    // Any other query failure is the database being unreachable or unreadable, which is not a
    // compatibility verdict and must not be catchable as one.
    if (isMissingDatabaseRelationError(error)) {
      throw new SchemaCompatibilityError(
        "schema-not-installed",
        "Workhorse schema is not installed. Run the application's explicit Workhorse schema installation step before mounting the dashboard.",
        { installedVersion: null, expectedVersion: WORKHORSE_SCHEMA_VERSION },
        { cause: error },
      );
    }
    throw new Error(
      "Unable to verify Workhorse schema compatibility because the database query failed.",
      { cause: error },
    );
  }
  const refusal = schemaCompatibilityRefusal(state);
  if (refusal !== null) {
    throw new SchemaCompatibilityError(refusal.code, refusal.message, {
      installedVersion: state.schemaVersion,
      expectedVersion: WORKHORSE_SCHEMA_VERSION,
    });
  }
}

/** A refusal in both vocabularies: the code a caller branches on, the sentence a person reads. */
export interface SchemaCompatibilityRefusal {
  /** The code Python and Go spell identically. See {@link SchemaCompatibilityCode}. */
  readonly code: SchemaCompatibilityCode;
  /** The sentence `assertSchemaCompatible` throws and `workhorse schema status` prints. */
  readonly message: string;
}

/**
 * Say why this runtime refuses an installed schema, or `null` when it accepts one.
 *
 * `assertSchemaCompatible` throws this refusal and `workhorse schema status` reports it, so the
 * deployment gate and the process that starts after it cannot reach opposite verdicts. The order
 * of the tests is the order in `protocol/v1/compatibility.json`, which Python's
 * `compatibility_refusal` and Go's `CheckCompatibility` also follow.
 *
 * `clientProtocolVersion` defaults to the protocol this build speaks. A caller passes another
 * version only to ask what a different client would meet.
 */
export function schemaCompatibilityRefusal(
  state: CompatibilityState,
  clientProtocolVersion: number = PROTOCOL_VERSION,
): SchemaCompatibilityRefusal | null {
  if (state.schemaVersion === null) {
    return {
      code: "schema-not-installed",
      message:
        "Workhorse schema version is missing or ambiguous. Reinstall the schema before starting.",
    };
  }
  if (state.schemaVersion < MINIMUM_SCHEMA_VERSION) {
    return {
      code: "schema-too-old",
      message: `Workhorse schema version ${state.schemaVersion} is below the minimum ${MINIMUM_SCHEMA_VERSION} this runtime requires. Migrate the database before starting this release.`,
    };
  }
  if (clientProtocolVersion < MINIMUM_PROTOCOL_VERSION) {
    return {
      code: "client-protocol-too-old",
      message: `SQL protocol ${clientProtocolVersion} is below the minimum ${MINIMUM_PROTOCOL_VERSION} this runtime supports. Use a client build that speaks a supported protocol.`,
    };
  }
  if (clientProtocolVersion > MAXIMUM_PROTOCOL_VERSION) {
    return {
      code: "client-protocol-too-new",
      message: `SQL protocol ${clientProtocolVersion} is above the maximum ${MAXIMUM_PROTOCOL_VERSION} this runtime supports. Use a client build that speaks a supported protocol.`,
    };
  }
  const served = state.servedProtocolVersions;
  if (served.length > 0 && !served.includes(clientProtocolVersion)) {
    const oldest = Math.min(...served);
    return clientProtocolVersion < oldest
      ? {
          code: "schema-too-new",
          message: `Workhorse schema serves SQL protocol ${served.join(", ")} and no longer serves protocol ${clientProtocolVersion} this runtime speaks. Upgrade this release.`,
        }
      : {
          code: "schema-too-old",
          message: `Workhorse schema serves SQL protocol ${served.join(", ")} and does not yet serve protocol ${clientProtocolVersion} this runtime speaks. Migrate the database before starting this release.`,
        };
  }
  return null;
}

export interface MigrateSchemaOptions {
  /**
   * Milliseconds a migration body waits for a table lock before it gives up. Defaults to
   * `SCHEMA_MIGRATION_LOCK_TIMEOUT_MS`. Waiting for another migrator is separate and unbounded.
   */
  lockTimeoutMs?: number;
}

/** Apply the immutable forward-only steps from the supported baseline to the current schema. */
export async function migrateSchema(
  database: Queryable,
  options: MigrateSchemaOptions = {},
): Promise<void> {
  await assertSupportedPostgres(database);

  let version: number | null;
  try {
    version = await readSchemaVersion(database);
  } catch (error) {
    throw new Error(
      isMissingDatabaseRelationError(error)
        ? "Workhorse schema is not installed. Run installSchema for a fresh database."
        : "Unable to read the Workhorse schema version before migration.",
      { cause: error },
    );
  }

  await applySchemaMigrationPlan(
    database,
    {
      baselineVersion: WORKHORSE_SCHEMA_BASELINE_VERSION,
      currentVersion: WORKHORSE_SCHEMA_VERSION,
      steps: SCHEMA_MIGRATIONS,
      readStep: async (file) => readFile(sqlAsset(`migrations/${file}`), "utf8"),
      lockTimeoutMs: options.lockTimeoutMs,
    },
    version,
  );
}

export async function installSchema(database: Queryable): Promise<void> {
  // An unsupported server must fail here, with its own version in the message, rather than part
  // way through executing schema.sql.
  await assertSupportedPostgres(database);
  // Validation uses a canonical clean-database schema rather than incremental migrations.
  // Production callers must not treat this as a safe upgrade mechanism for an existing schema.
  const existing = await database.query<{
    schema_exists: boolean;
    version_table_exists: boolean;
    legacy_relation_exists: boolean;
  }>(SQL_STATEMENTS["schema_installation_probe"]);
  const state = expectOneRow(existing, "the schema installation probe");
  if (state.schema_exists) {
    if (!state.version_table_exists)
      throw new Error("refusing to install into an unversioned existing workhorse schema");
    const versions = await database.query<{ version: number }>(SQL_STATEMENTS["schema_version"]);
    if (
      versions.rows.length !== 1 ||
      versions.rows[0]?.version !== WORKHORSE_SCHEMA_VERSION ||
      state.legacy_relation_exists
    )
      throw new Error(
        `refusing to treat an existing non-v${WORKHORSE_SCHEMA_VERSION} or mixed workhorse schema as a clean installation`,
      );
  }
  const schemaUrl = sqlAsset("schema.sql");
  const sql = await readFile(schemaUrl, "utf8");
  await database.query(sql);
}
