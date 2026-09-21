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

/**
 * Whether the runner supplies the step's transaction, or the step runs outside one.
 *
 * A `transactional` step is the default and the rule: the runner wraps the body so the schema is
 * either at the starting version or at the target version, never between. A `nontransactional`
 * step exists for the statements PostgreSQL refuses to run inside a transaction block, of which
 * `CREATE INDEX CONCURRENTLY` is the one this project needs: it builds an index without blocking
 * writes, and it cannot be undone by a rollback. Such a step buys availability with atomicity, so
 * its body must be idempotent and safe to rerun after a failure.
 */
type SchemaMigrationExecution = "transactional" | "nontransactional";

export interface SchemaMigrationStep {
  fromVersion: number;
  toVersion: number;
  file: string;
  description: string;
  readonly kind: SchemaMigrationKind;
  /**
   * How the step runs. Absent means `transactional`, so every step that predates the class reads
   * and behaves exactly as it did.
   */
  readonly execution?: SchemaMigrationExecution;
  /**
   * The client protocol versions a contract step stops serving.
   *
   * Required and non-empty on a contract step, because the refusal gate needs to know which
   * workers the step would stop. Forbidden on an additive step, which narrows nothing.
   */
  readonly retiresProtocolVersions?: readonly number[];
}

/** The execution a step declares, with the default the class was added around. */
function stepExecution(step: {
  readonly execution?: SchemaMigrationExecution;
}): SchemaMigrationExecution {
  return step.execution ?? "transactional";
}

export interface SchemaMigrationPlan {
  baselineVersion: number;
  currentVersion: number;
  /**
   * The last published release whose own chain still reaches `baselineVersion` from below.
   *
   * Pruning the chain strands every database under the baseline, and the only way forward is the
   * release that still carries the steps this one dropped. A refusal names it so an operator reads
   * what to install rather than only which version they are on. A synthetic plan omits it and the
   * refusal states the baseline alone.
   */
  lastReleaseBelowBaseline?: string;
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

/** Ends the aborted transaction a failed step leaves behind on a caller-supplied single Client. */
const ABORT_FAILED_STEP = "ROLLBACK";

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

/**
 * Every spelling of transaction control a migration body is refused for containing.
 *
 * `END` and `ABORT` are the aliases for `COMMIT` and `ROLLBACK`, and `PREPARE TRANSACTION` hands
 * the transaction to a two-phase commit the runner would never resolve. The two aliases are
 * matched only where they end a statement, because `END` also closes a `CASE` expression and a
 * plpgsql block, and a line may begin with either.
 */
const transactionControl =
  /^\s*(?:(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b|(?:END|ABORT)(?:\s+(?:TRANSACTION|WORK))?\s*;|PREPARE\s+TRANSACTION\b)/im;

/** Refuse a body that manages the transaction the runner is responsible for. */
function assertNoTransactionControl(file: string, body: string): void {
  // Dollar-quoted bodies are data, not statements: a migration that redefines a plpgsql
  // function legitimately contains BEGIN and END lines inside $$…$$, and only statements outside
  // those quotes can manage the transaction.
  const statements = body.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''");
  if (transactionControl.test(statements)) {
    throw new Error(`Workhorse migration ${file} must not contain transaction control statements`);
  }
}

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
  readonly execution?: SchemaMigrationExecution;
  readonly retiresProtocolVersions?: readonly number[];
}

function isMetadataJson(
  value: unknown,
): value is { kind?: unknown; execution?: unknown; retiresProtocolVersions?: unknown } {
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
    parsed.execution !== undefined &&
    parsed.execution !== "transactional" &&
    parsed.execution !== "nontransactional"
  ) {
    throw new Error(
      `Workhorse migration ${file} must declare "execution" as "transactional" or "nontransactional"`,
    );
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
    execution: parsed.execution,
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
  if (stepExecution(metadata) !== stepExecution(step)) {
    throw new Error(
      `Workhorse migration ${step.file} declares "${stepExecution(metadata)}" execution but SCHEMA_MIGRATIONS says "${stepExecution(step)}"`,
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

/** The starting-version check every step runs, as one statement. */
function versionGuard(step: SchemaMigrationStep): string {
  return `DO $workhorse_migration$
BEGIN
  IF (SELECT count(*) FROM workhorse.schema_version) <> 1
     OR NOT EXISTS (SELECT 1 FROM workhorse.schema_version WHERE version = ${step.fromVersion}) THEN
    RAISE EXCEPTION 'workhorse schema migration to version ${step.toVersion} requires exactly version ${step.fromVersion}';
  END IF;
END
$workhorse_migration$;`;
}

/** Advance `schema_version` and append the step's `schema_migration` row. */
function bookkeeping(step: SchemaMigrationStep): string {
  return `UPDATE workhorse.schema_version SET version = ${step.toVersion}, installed_at = clock_timestamp() WHERE version = ${step.fromVersion};
INSERT INTO workhorse.schema_migration(version, description) VALUES (${step.toVersion}, ${quoteLiteral(step.description)});`;
}

/**
 * One transactional script per step: take the advisory lock, revalidate the starting version
 * behind it, run the migration body, and record the version step, atomically. The body itself
 * must not manage transactions.
 */
function migrationScript(step: SchemaMigrationStep, body: string, lockTimeoutMs: number): string {
  assertNoTransactionControl(step.file, body);
  return `BEGIN;
-- Waiting for a peer migrator is expected and unbounded; waiting for a table is not.
SET LOCAL lock_timeout = 0;
SELECT pg_advisory_xact_lock(hashtext(${quoteLiteral(SCHEMA_MIGRATION_LOCK)}));
${versionGuard(step)}
SET LOCAL lock_timeout = ${String(lockTimeoutMs)};
${body}
SET LOCAL lock_timeout = 0;
${bookkeeping(step)}
COMMIT;`;
}

/**
 * The transactional script that records a non-transactional step once its body has run.
 *
 * It repeats the starting-version guard behind the advisory lock, so a peer migrator that reached
 * this point first wins the step and this one fails the guard rather than recording the version
 * twice. The body is absent because it already ran outside any transaction.
 */
function nonTransactionalBookkeepingScript(step: SchemaMigrationStep): string {
  return `BEGIN;
SET LOCAL lock_timeout = 0;
SELECT pg_advisory_xact_lock(hashtext(${quoteLiteral(SCHEMA_MIGRATION_LOCK)}));
${versionGuard(step)}
${bookkeeping(step)}
COMMIT;`;
}

/**
 * Split a migration body into the statements a non-transactional step sends one at a time.
 *
 * `CREATE INDEX CONCURRENTLY` refuses to run inside a transaction block, and PostgreSQL wraps a
 * multi-statement simple query in one. So the runner cannot hand the body over whole. Quoting
 * decides where a statement ends: a semicolon inside a string, a quoted identifier, a comment, or
 * a dollar-quoted body is data rather than a terminator.
 */
export function splitSqlStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      // PostgreSQL block comments nest, so the scan counts them rather than stopping at the first
      // close.
      let depth = 0;
      while (index < sql.length) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
          if (depth === 0) break;
        } else index += 1;
      }
      continue;
    }
    const character = sql[index]!;
    if (character === "'" || character === '"') {
      // An E'' string takes backslash escapes; a standard-conforming one doubles the quote.
      const escaping = character === "'" && /[Ee]$/.test(sql.slice(0, index));
      index += 1;
      while (index < sql.length) {
        if (escaping && sql[index] === "\\") {
          index += 2;
          continue;
        }
        if (sql[index] === character) {
          if (sql[index + 1] === character) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "$") {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(index));
      if (tag !== null) {
        const close = sql.indexOf(tag[0], index + tag[0].length);
        index = close === -1 ? sql.length : close + tag[0].length;
        continue;
      }
    }
    if (character === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement !== "") statements.push(statement);
      index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
  const trailing = sql.slice(start).trim();
  if (trailing !== "") statements.push(trailing);
  return statements;
}

/** What a validated step does to a database, once its body has been accepted. */
type PreparedStep = (database: Queryable) => Promise<unknown>;

/** Prepare the single script a transactional step is. */
function prepareTransactionalStep(
  step: SchemaMigrationStep,
  body: string,
  lockTimeoutMs: number,
): PreparedStep {
  const script = migrationScript(step, body, lockTimeoutMs);
  return (database) => database.query(script);
}

/**
 * Prepare a non-transactional step: guard the version, run each statement on its own outside any
 * transaction, then record the step transactionally.
 *
 * Nothing here is atomic, and that is the trade the step class makes. The guard runs first so a
 * database at the wrong version is never touched, but it cannot be held across the body, because
 * the body runs outside the transaction that would hold it. A failure part-way therefore leaves
 * the earlier statements applied at the starting version, and the rerun reapplies the body — which
 * is why a non-transactional body must be idempotent. `lock_timeout` is left alone: the statements
 * this class exists for take a lock that does not block writes, so there is nothing to bound.
 */
function prepareNonTransactionalStep(step: SchemaMigrationStep, body: string): PreparedStep {
  assertNoTransactionControl(step.file, body);
  const statements = splitSqlStatements(body);
  return async (database) => {
    await database.query(versionGuard(step));
    for (const statement of statements) {
      await database.query(statement);
    }
    await database.query(nonTransactionalBookkeepingScript(step));
  };
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
  const nonTransactional = stepExecution(migration) === "nontransactional";
  // Preparing outside the try refuses a body the runner will not accept before the database sees
  // any of it, so that error reaches the caller as itself rather than as a step that failed
  // against a database.
  const apply = nonTransactional
    ? prepareNonTransactionalStep(migration, body)
    : prepareTransactionalStep(
        migration,
        body,
        plan.lockTimeoutMs ?? SCHEMA_MIGRATION_LOCK_TIMEOUT_MS,
      );
  try {
    await apply(database);
  } catch (error) {
    // A caller may hand the runner a single Client rather than a Pool, and a failed step leaves
    // that one session in an aborted transaction where every later statement fails too. Ending it
    // is what lets the version read below mean anything. On a Pool this ends nothing and warns.
    await database.query(ABORT_FAILED_STEP).catch(() => undefined);
    // A concurrent migrator that held the advisory lock first may have committed this exact
    // step; its result is indistinguishable from ours, so only that outcome is accepted.
    const concurrent = await readSchemaVersion(database).catch(() => null);
    if (concurrent === null || concurrent < migration.toVersion) {
      // A lock timeout is the one failure an operator can act on directly, so it says so.
      const reason =
        databaseErrorCode(error) === LOCK_NOT_AVAILABLE
          ? ` because it waited longer than ${String(plan.lockTimeoutMs ?? SCHEMA_MIGRATION_LOCK_TIMEOUT_MS)}ms for a lock. Another transaction holds the table; end it and rerun the migration`
          : "";
      // A non-transactional step rolls nothing back, so saying it did would send an operator
      // looking for a database state that is not there.
      const outcome = nonTransactional
        ? "failed part-way and rolled nothing back; the schema is still at its starting version and the body reruns from the beginning"
        : "failed and was rolled back";
      throw new Error(`Workhorse migration ${migration.file} ${outcome}${reason}`, {
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
    // The steps that would carry this database up to the baseline are not in this release, so
    // there is nothing to suggest rerunning. Name the release that still has them instead.
    const route =
      plan.lastReleaseBelowBaseline === undefined
        ? ""
        : `. Workhorse ${plan.lastReleaseBelowBaseline} is the last release that migrates a schema this old: migrate to the baseline with it, then upgrade to this release`;
    throw new Error(
      `Workhorse schema version ${version} predates the supported migration baseline ${plan.baselineVersion}${route}`,
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
