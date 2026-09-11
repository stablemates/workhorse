import { SQL_STATEMENTS } from "./queue/sql-catalogue.generated.js";
import { databaseErrorCode } from "./errors.js";
import type { Queryable } from "./types.js";

/**
 * Whether a step grows the schema or removes from it.
 *
 * An `additive` step is pipeline work: `workhorse schema migrate` applies it ahead of a rollout.
 * A `contract` step drops superseded functions and narrows `workhorse.protocol_version`, so it is
 * an operator's deliberate act: `workhorse schema migrate` stops before it and only
 * `workhorse schema contract` applies it
 * ([ADR 0057](../../../docs/decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)).
 */
type SchemaMigrationKind = "additive" | "contract";

export interface SchemaMigrationStep {
  fromVersion: number;
  toVersion: number;
  file: string;
  description: string;
  readonly kind: SchemaMigrationKind;
  /**
   * The client protocol versions a contract step stops serving.
   *
   * Required and non-empty on a contract step, because the refusal gate needs to know which
   * workers the step would stop. Forbidden on an additive step, which narrows nothing.
   */
  readonly retiresProtocolVersions?: readonly number[];
}

export interface SchemaMigrationPlan {
  baselineVersion: number;
  currentVersion: number;
  steps: readonly SchemaMigrationStep[];
  readStep(file: string): Promise<string>;
  /** Milliseconds a migration body waits for a table lock. Defaults to SCHEMA_MIGRATION_LOCK_TIMEOUT_MS. */
  lockTimeoutMs?: number;
}

/** Advisory lock name serializing concurrent schema migrations, hashed with hashtext. */
const SCHEMA_MIGRATION_LOCK = "workhorse:schema-migration";

/**
 * How long a migration body waits for a table lock before it gives up.
 *
 * An `ALTER TABLE` takes `ACCESS EXCLUSIVE`, and PostgreSQL queues every later statement on that
 * table behind the waiting acquisition. A worker holds long transactions by design, so an
 * unbounded wait turns one slow transaction into a stalled queue. Failing is recoverable: the step
 * rolls back atomically and the deployment reruns it.
 */
export const SCHEMA_MIGRATION_LOCK_TIMEOUT_MS = 5_000;

/** PostgreSQL raises this when lock_timeout expires. */
const LOCK_NOT_AVAILABLE = "55P03";

/** Whether PostgreSQL reports a missing schema or a missing relation within that schema. */
export function isMissingDatabaseRelationError(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return code === "3F000" || code === "42P01";
}

/**
 * Whether PostgreSQL reports that the called function does not exist.
 *
 * A schema behind this build is the normal first half of a rolling upgrade, so a read that a later
 * migration introduced has to be able to say "this database cannot answer yet" instead of failing
 * the command that an operator runs to find that out.
 */
export function isMissingDatabaseFunctionError(error: unknown): boolean {
  return databaseErrorCode(error) === "42883";
}

const transactionControl = /^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im;

/**
 * The declaration every migration file carries as its first line.
 *
 * A step's kind is declared twice: in `SCHEMA_MIGRATIONS` and here, in the file itself, so the
 * released record cannot disagree with the runner that applies it. `migrationScript` passes the
 * line through as the comment it is.
 */
const MIGRATION_METADATA = /^--\s*workhorse-migration:\s*(\{.*\})\s*$/;

interface SchemaMigrationFileMetadata {
  readonly kind: SchemaMigrationKind;
  readonly retiresProtocolVersions?: readonly number[];
}

function isMetadataJson(
  value: unknown,
): value is { kind?: unknown; retiresProtocolVersions?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersionList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => Number.isSafeInteger(entry) && entry >= 1);
}

/** Read the first-line declaration out of a migration file, or throw when it is absent or malformed. */
export function parseSchemaMigrationMetadata(
  file: string,
  body: string,
): SchemaMigrationFileMetadata {
  const match = MIGRATION_METADATA.exec(body.split("\n", 1)[0] ?? "");
  if (match === null) {
    throw new Error(
      `Workhorse migration ${file} must open with a '-- workhorse-migration: {"kind":...}' declaration`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    throw new Error(`Workhorse migration ${file} carries malformed declaration JSON`);
  }
  if (!isMetadataJson(parsed) || (parsed.kind !== "additive" && parsed.kind !== "contract")) {
    throw new Error(`Workhorse migration ${file} must declare "kind" as "additive" or "contract"`);
  }
  if (
    parsed.retiresProtocolVersions !== undefined &&
    !isVersionList(parsed.retiresProtocolVersions)
  ) {
    throw new Error(
      `Workhorse migration ${file} declares retiresProtocolVersions that are not a list of protocol versions`,
    );
  }
  return {
    kind: parsed.kind,
    retiresProtocolVersions: parsed.retiresProtocolVersions,
  };
}

/**
 * Refuse a step whose file disagrees with its `SCHEMA_MIGRATIONS` entry.
 *
 * Runs before the step body is read into a transaction: a contract step mislabeled additive would
 * reach `workhorse schema migrate` and stop the fleet it exists to spare.
 */
function assertStepMatchesFile(step: SchemaMigrationStep, body: string): void {
  const metadata = parseSchemaMigrationMetadata(step.file, body);
  if (metadata.kind !== step.kind) {
    throw new Error(
      `Workhorse migration ${step.file} declares "${metadata.kind}" but SCHEMA_MIGRATIONS says "${step.kind}"`,
    );
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  const declared = [...(metadata.retiresProtocolVersions ?? [])].sort((a, b) => a - b);
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  const recorded = [...(step.retiresProtocolVersions ?? [])].sort((a, b) => a - b);
  if (declared.length !== recorded.length || declared.some((v, i) => v !== recorded[i])) {
    throw new Error(
      `Workhorse migration ${step.file} retires protocols [${declared.join(", ")}] but SCHEMA_MIGRATIONS records [${recorded.join(", ")}]`,
    );
  }
}

/** A step declaration that cannot be applied as written fails before any database sees it. */
function assertWellFormedStep(step: SchemaMigrationStep): void {
  if (step.kind === "contract") {
    if (step.retiresProtocolVersions === undefined || step.retiresProtocolVersions.length === 0) {
      throw new Error(
        `Workhorse contract step ${step.file} must name the protocol versions it retires`,
      );
    }
  } else if (step.retiresProtocolVersions !== undefined) {
    throw new Error(
      `Workhorse additive step ${step.file} narrows nothing, so it cannot retire protocols`,
    );
  }
}

export async function readSchemaVersion(database: Queryable): Promise<number | null> {
  const result = await database.query<{ version: number }>(SQL_STATEMENTS["schema_version"]);
  return result.rows.length === 1 ? (result.rows[0]?.version ?? null) : null;
}

export interface CompatibilityState {
  /** The single `workhorse.schema_version` row, or null when absent or ambiguous. */
  schemaVersion: number | null;
  /** SQL protocol versions the installed schema declares it serves. */
  servedProtocolVersions: readonly number[];
}

/**
 * Read both version facts in one round trip.
 *
 * The schema version says how far the migration chain has run. The served protocol versions say
 * which clients the installed schema still answers, which is the only authority on the upper
 * bound: a client cannot know at build time which release will stop serving it.
 */
export async function readCompatibilityState(database: Queryable): Promise<CompatibilityState> {
  const result = await database.query<{ kind: string; version: number }>(
    SQL_STATEMENTS["compatibility_state"],
  );
  const schema = result.rows.filter((row) => row.kind === "schema");
  return {
    schemaVersion: schema.length === 1 ? (schema[0]?.version ?? null) : null,
    servedProtocolVersions: result.rows
      .filter((row) => row.kind === "protocol")
      .map((row) => row.version),
  };
}

/** SQL protocol versions the installed schema serves, or null when the relation is absent. */
export async function readProtocolVersions(database: Queryable): Promise<number[] | null> {
  try {
    const result = await database.query<{ version: number }>(SQL_STATEMENTS["protocol_version"]);
    return result.rows.map((row) => row.version);
  } catch (error) {
    if (isMissingDatabaseRelationError(error)) return null;
    throw error;
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * One transactional script per step: take the advisory lock, revalidate the starting version
 * behind it, run the migration body, and record the version step, atomically. The body itself
 * must not manage transactions.
 */
function migrationScript(step: SchemaMigrationStep, body: string, lockTimeoutMs: number): string {
  // Dollar-quoted bodies are data, not statements: a migration that redefines a plpgsql
  // function legitimately contains BEGIN lines inside $$…$$, and only statements outside
  // those quotes can manage the transaction.
  const statements = body.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''");
  if (transactionControl.test(statements)) {
    throw new Error(
      `Workhorse migration ${step.file} must not contain transaction control statements`,
    );
  }
  return `BEGIN;
-- Waiting for a peer migrator is expected and unbounded; waiting for a table is not.
SET LOCAL lock_timeout = 0;
SELECT pg_advisory_xact_lock(hashtext(${quoteLiteral(SCHEMA_MIGRATION_LOCK)}));
DO $workhorse_migration$
BEGIN
  IF (SELECT count(*) FROM workhorse.schema_version) <> 1
     OR NOT EXISTS (SELECT 1 FROM workhorse.schema_version WHERE version = ${step.fromVersion}) THEN
    RAISE EXCEPTION 'workhorse schema migration to version ${step.toVersion} requires exactly version ${step.fromVersion}';
  END IF;
END
$workhorse_migration$;
SET LOCAL lock_timeout = ${String(lockTimeoutMs)};
${body}
SET LOCAL lock_timeout = 0;
UPDATE workhorse.schema_version SET version = ${step.toVersion}, installed_at = clock_timestamp() WHERE version = ${step.fromVersion};
INSERT INTO workhorse.schema_migration(version, description) VALUES (${step.toVersion}, ${quoteLiteral(step.description)});
COMMIT;`;
}

/**
 * Run one step behind the advisory lock: validate the file's declaration against its
 * `SCHEMA_MIGRATIONS` entry, apply the body, and record the version step, atomically.
 *
 * Returns the schema version the database finished at.
 */
async function applyMigrationStep(
  database: Queryable,
  plan: SchemaMigrationPlan,
  migration: SchemaMigrationStep,
): Promise<number> {
  assertWellFormedStep(migration);
  const body = await plan.readStep(migration.file);
  assertStepMatchesFile(migration, body);
  const script = migrationScript(
    migration,
    body,
    plan.lockTimeoutMs ?? SCHEMA_MIGRATION_LOCK_TIMEOUT_MS,
  );
  try {
    await database.query(script);
  } catch (error) {
    // A concurrent migrator that held the advisory lock first may have committed this exact
    // step; its result is indistinguishable from ours, so only that outcome is accepted.
    const concurrent = await readSchemaVersion(database).catch(() => null);
    if (concurrent === null || concurrent < migration.toVersion) {
      // A lock timeout is the one failure an operator can act on directly, so it says so.
      const reason =
        databaseErrorCode(error) === LOCK_NOT_AVAILABLE
          ? ` because it waited longer than ${String(plan.lockTimeoutMs ?? SCHEMA_MIGRATION_LOCK_TIMEOUT_MS)}ms for a lock. Another transaction holds the table; end it and rerun the migration`
          : "";
      throw new Error(`Workhorse migration ${migration.file} failed and was rolled back${reason}`, {
        cause: error,
      });
    }
  }
  const migratedVersion = await readSchemaVersion(database);
  if (migratedVersion === null || migratedVersion < migration.toVersion) {
    throw new Error(
      `Workhorse migration ${migration.file} finished at version ${String(migratedVersion)} instead of ${migration.toVersion}`,
    );
  }
  return migratedVersion;
}

/** Where a contiguous forward-only run finished. */
export interface SchemaMigrationPlanResult {
  /** The installed schema version after the run. */
  readonly finishedVersion: number;
  /**
   * The contract step the run stopped before, when one was next in the chain.
   *
   * Stopping is a report, not a failure: the schema behind the step still serves every protocol
   * it served before, so the deployment that ran the migration proceeds.
   */
  readonly contractStop: SchemaMigrationStep | null;
}

/**
 * Run a contiguous forward-only migration plan, stopping before the first contract step.
 *
 * A contract step narrows `workhorse.protocol_version`; applying one under `schema migrate` would
 * stop every process still on the retiring protocol, which is the outage the step class exists to
 * prevent. The run reports the step it stopped before so the pipeline log names what is left.
 */
export async function applySchemaMigrationPlan(
  database: Queryable,
  plan: SchemaMigrationPlan,
  installedVersion?: number | null,
): Promise<SchemaMigrationPlanResult> {
  let version =
    installedVersion === undefined ? await readSchemaVersion(database) : installedVersion;

  if (version === null) {
    throw new Error("Workhorse schema_version must contain exactly one version before migration");
  }
  if (version < plan.baselineVersion) {
    throw new Error(
      `Workhorse schema version ${version} predates the supported migration baseline ${plan.baselineVersion}`,
    );
  }
  if (version > plan.currentVersion) {
    throw new Error(
      `Workhorse schema version ${version} is newer than runtime version ${plan.currentVersion}`,
    );
  }

  let contractStop: SchemaMigrationStep | null = null;
  while (version < plan.currentVersion) {
    const migration = plan.steps.find((candidate) => candidate.fromVersion === version);
    if (!migration) {
      throw new Error(`No Workhorse schema migration starts at version ${version}`);
    }
    if (migration.kind === "contract") {
      contractStop = migration;
      break;
    }
    version = await applyMigrationStep(database, plan, migration);
  }
  return { finishedVersion: version, contractStop };
}

/**
 * The contract steps still ahead of an installed version.
 *
 * A deployment gate reads this rather than `schema.state`: "behind" on an unapplied contract step
 * is the operator's own schedule, not a pending pipeline migration.
 */
export function pendingContractSteps(
  steps: readonly SchemaMigrationStep[],
  installedVersion: number | null,
): readonly SchemaMigrationStep[] {
  if (installedVersion === null) return [];
  return steps.filter((step) => step.kind === "contract" && step.toVersion > installedVersion);
}

/** What waits at an installed version, in the vocabulary the CLI prints. */
type PendingSchemaStep =
  | { readonly kind: "none" }
  | { readonly kind: "additive"; readonly step: SchemaMigrationStep }
  | { readonly kind: "contract"; readonly step: SchemaMigrationStep };

/**
 * The step waiting at an installed version, or `"none"` when the chain is exhausted.
 *
 * `none` covers both a current schema and one ahead of this build: in neither case is there a step
 * this runtime could apply.
 */
function pendingSchemaStep(
  steps: readonly SchemaMigrationStep[],
  installedVersion: number,
  currentVersion: number,
): PendingSchemaStep {
  const step = steps.find((candidate) => candidate.fromVersion === installedVersion);
  if (step === undefined) {
    if (installedVersion < currentVersion) {
      throw new Error(`No Workhorse schema migration starts at version ${installedVersion}`);
    }
    return { kind: "none" };
  }
  assertWellFormedStep(step);
  return step.kind === "contract" ? { kind: "contract", step } : { kind: "additive", step };
}

/**
 * A worker whose heartbeat is inside its own lease and whose reported client protocol cannot
 * prove it survives the step: it names a retiring version, or it names none at all, which means
 * its SDK predates the column and the safest reading is that it speaks the oldest one.
 */
interface LiveProtocolWorker {
  readonly workerId: string;
  readonly hostname: string | null;
  readonly clientProtocolVersion: number | null;
  readonly sdkLanguage: string | null;
  readonly sdkVersion: string | null;
  readonly lastHeartbeatAt: Date;
}

/**
 * The workers a contract step would stop, as far as the database can see them.
 *
 * This is the gate evidence `worker_client_protocols_v1` summarizes; the step needs the workers
 * themselves so a refusal can name them. The same lease window decides liveness.
 */
async function readLiveWorkersOnProtocols(
  database: Queryable,
  retiringProtocolVersions: readonly number[],
): Promise<LiveProtocolWorker[]> {
  const result = await database.query<{
    worker_id: string;
    hostname: string | null;
    client_protocol_version: number | null;
    sdk_language: string | null;
    sdk_version: string | null;
    last_heartbeat_at: Date;
  }>(SQL_STATEMENTS["live_workers_on_protocols"], [retiringProtocolVersions]);
  return result.rows.map((row) => ({
    workerId: row.worker_id,
    hostname: row.hostname,
    clientProtocolVersion: row.client_protocol_version,
    sdkLanguage: row.sdk_language,
    sdkVersion: row.sdk_version,
    lastHeartbeatAt: row.last_heartbeat_at,
  }));
}

/** What a contract-step evaluation found and did, in the vocabulary the CLI prints. */
export type SchemaContractOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "additive-pending"; readonly step: SchemaMigrationStep }
  | {
      readonly kind: "unconfirmed";
      readonly step: SchemaMigrationStep;
      readonly workers: readonly LiveProtocolWorker[];
    }
  | {
      readonly kind: "applied";
      readonly step: SchemaMigrationStep;
      readonly workers: readonly LiveProtocolWorker[];
    };

export interface PlanSchemaContractOptions {
  /**
   * The explicit confirmation the step requires. Without it the outcome is `unconfirmed` and
   * nothing is applied; with it the step applies even while the gate still sees workers on a
   * retiring protocol, because the registry is evidence and never proof.
   */
  readonly confirmed?: boolean;
  /** The installed version, when the caller already holds it. */
  readonly installedVersion?: number | null;
}

/**
 * Evaluate the contract step pending at the installed version and apply it when confirmed.
 *
 * The gate is the registry: the outcome names every worker on a retiring protocol that
 * heartbeated inside its lease. Producers never register, so the evidence can never prove no
 * caller remains — confirmation is required either way. One call applies exactly one step: a
 * chain holding two contract steps takes two deliberate acts.
 */
export async function planSchemaContract(
  database: Queryable,
  plan: SchemaMigrationPlan,
  options: PlanSchemaContractOptions = {},
): Promise<SchemaContractOutcome> {
  const version =
    options.installedVersion === undefined
      ? await readSchemaVersion(database)
      : options.installedVersion;
  if (version === null) {
    throw new Error("Workhorse schema_version must contain exactly one version before migration");
  }
  const pending = pendingSchemaStep(plan.steps, version, plan.currentVersion);
  if (pending.kind === "none") return { kind: "none" };
  if (pending.kind === "additive") {
    return { kind: "additive-pending", step: pending.step };
  }
  const workers = await readLiveWorkersOnProtocols(
    database,
    pending.step.retiresProtocolVersions ?? [],
  );
  if (options.confirmed !== true) {
    return { kind: "unconfirmed", step: pending.step, workers };
  }
  await applyMigrationStep(database, plan, pending.step);
  return { kind: "applied", step: pending.step, workers };
}
