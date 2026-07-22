import type { Pool, PoolClient } from "pg";
import type { Json, Queryable } from "./types.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAINTENANCE_NAME = "$maintenance";

export interface CronJobDefinition<TPayload extends Json = Json> {
  type: string;
  payload: TPayload;
  queue?: string;
  maxAttempts?: number;
}

export interface CronScheduleDefinition<TPayload extends Json = Json> {
  /** Stable deploy-time identity within one scheduler namespace. */
  name: string;
  /** Standard pg_cron expression or a supported interval such as `5 seconds`. */
  schedule: string;
  job: CronJobDefinition<TPayload>;
  /** Disabled definitions remain visible but pg_cron will not execute them. */
  enabled?: boolean;
}

export interface PgCronSchedulerOptions {
  /** Isolates schedule ownership between applications or deployment environments. */
  namespace: string;
}

export interface PgCronMaintenanceOptions {
  /** pg_cron schedule for due-job promotion and expired-lease recovery. */
  schedule?: string;
  /** Maximum rows promoted and recovered by one maintenance execution. */
  batchSize?: number;
  /** Days to retain occurrence-deduplication rows. Defaults to 30. */
  occurrenceRetentionDays?: number;
  /** Maximum old occurrence rows deleted by one maintenance execution. Defaults to 10,000. */
  occurrencePruneLimit?: number;
}

export interface PgCronSyncOptions {
  /** Deactivate and unschedule owned definitions omitted from this deployment. Defaults to true. */
  prune?: boolean;
  /** Install centralized maintenance, or false when another coordinator owns it. Defaults to 1s. */
  maintenance?: PgCronMaintenanceOptions | false;
}

export interface PgCronScheduleStatus {
  name: string;
  revision: string;
  schedule: string;
  enabled: boolean;
  cronJobId: string | null;
  cronActive: boolean;
  lastOccurrenceAt: Date | null;
  lastJobId: string | null;
  lastRun: PgCronRunStatus | null;
}

export interface PgCronMaintenanceStatus {
  cronJobId: string;
  active: boolean;
  schedule: string;
  batchSize: number;
  occurrenceRetentionDays: number;
  occurrencePruneLimit: number;
  lastRun: PgCronRunStatus | null;
}

export interface PgCronRunStatus {
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  message: string | null;
}

export interface PgCronSyncResult {
  extensionVersion: string;
  namespace: string;
  targetDatabase: string;
  targetUser: string;
  maintenance: PgCronMaintenanceStatus | null;
  schedules: PgCronScheduleStatus[];
}

export interface PgCronRequirements {
  ready: boolean;
  extensionVersion: string | null;
  supportedVersion: boolean;
  metadataDatabase: string;
  deploymentRole: string;
  schemaUsage: boolean;
  canReadJobs: boolean;
  canReadRuns: boolean;
  canScheduleInDatabase: boolean;
  canUnschedule: boolean;
}

type TargetContext = { database_name: string; database_user: string };
type CronJobRow = {
  jobid: string;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  run_status: string | null;
  run_started_at: Date | null;
  run_ended_at: Date | null;
  run_message: string | null;
};
type ExistingCronJobRow = { jobid: string; jobname: string; active: boolean };
type DefinitionRow = {
  schedule_name: string;
  revision: string;
  cron_expression: string;
  enabled: boolean;
  last_occurrence_at: Date | null;
  last_job_id: string | null;
};

type DesiredCronJob = {
  jobName: string;
  schedule: string;
  command: string;
  active: boolean;
};

function validateName(value: string, field: string): void {
  if (!NAME_PATTERN.test(value)) {
    throw new Error(`${field} must match ${NAME_PATTERN.source}`);
  }
}

function validateDefinitions(definitions: readonly CronScheduleDefinition[]): void {
  const names = new Set<string>();
  for (const definition of definitions) {
    validateName(definition.name, "schedule name");
    if (definition.name === MAINTENANCE_NAME) throw new Error(`${MAINTENANCE_NAME} is reserved`);
    if (!definition.schedule.trim()) throw new Error("schedule must not be empty");
    if (!definition.job.type.trim()) throw new Error("scheduled job type must not be empty");
    if (!(definition.job.queue ?? "default").trim()) {
      throw new Error("scheduled job queue must not be empty");
    }
    const maxAttempts = definition.job.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new RangeError("scheduled job maxAttempts must be an integer between 1 and 100");
    }
    if (names.has(definition.name)) {
      throw new Error(`duplicate schedule name ${JSON.stringify(definition.name)}`);
    }
    names.add(definition.name);
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function maintenanceConfig(option: PgCronSyncOptions["maintenance"]): {
  schedule: string;
  batchSize: number;
  occurrenceRetentionDays: number;
  occurrencePruneLimit: number;
} | null {
  if (option === false) return null;
  const schedule = option?.schedule ?? "1 second";
  const batchSize = option?.batchSize ?? 1_000;
  const occurrenceRetentionDays = option?.occurrenceRetentionDays ?? 30;
  const occurrencePruneLimit = option?.occurrencePruneLimit ?? 10_000;
  if (!schedule.trim()) throw new Error("maintenance schedule must not be empty");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError("maintenance batchSize must be an integer between 1 and 10000");
  }
  if (
    !Number.isInteger(occurrenceRetentionDays) ||
    occurrenceRetentionDays < 1 ||
    occurrenceRetentionDays > 3_650
  ) {
    throw new RangeError("maintenance occurrenceRetentionDays must be between 1 and 3650");
  }
  if (
    !Number.isInteger(occurrencePruneLimit) ||
    occurrencePruneLimit < 1 ||
    occurrencePruneLimit > 100_000
  ) {
    throw new RangeError("maintenance occurrencePruneLimit must be between 1 and 100000");
  }
  return { schedule, batchSize, occurrenceRetentionDays, occurrencePruneLimit };
}

function lastRun(job: CronJobRow | undefined): PgCronRunStatus | null {
  if (!job?.run_status) return null;
  return {
    status: job.run_status,
    startedAt: job.run_started_at,
    endedAt: job.run_ended_at,
    message: job.run_message,
  };
}

/** Inspect the exact metadata-database capabilities required by PgCronScheduler. */
export async function inspectPgCronRequirements(cronDatabase: Pool): Promise<PgCronRequirements> {
  const identity = await cronDatabase.query<{
    extension_version: string | null;
    metadata_database: string;
    deployment_role: string;
  }>(`SELECT (SELECT extversion FROM pg_extension WHERE extname = 'pg_cron') AS extension_version,
             current_database() AS metadata_database, current_user AS deployment_role`);
  const row = identity.rows[0]!;
  if (!row.extension_version) {
    return {
      ready: false,
      extensionVersion: null,
      supportedVersion: false,
      metadataDatabase: row.metadata_database,
      deploymentRole: row.deployment_role,
      schemaUsage: false,
      canReadJobs: false,
      canReadRuns: false,
      canScheduleInDatabase: false,
      canUnschedule: false,
    };
  }
  const privileges = await cronDatabase.query<{
    schema_usage: boolean;
    can_read_jobs: boolean;
    can_read_runs: boolean;
    can_schedule: boolean;
    can_unschedule: boolean;
  }>(`
    SELECT has_schema_privilege(current_user, 'cron', 'USAGE') AS schema_usage,
           has_table_privilege(current_user, 'cron.job', 'SELECT') AS can_read_jobs,
           has_table_privilege(current_user, 'cron.job_run_details', 'SELECT') AS can_read_runs,
           has_function_privilege(current_user,
             'cron.schedule_in_database(text,text,text,text,text,boolean)', 'EXECUTE') AS can_schedule,
           has_function_privilege(current_user, 'cron.unschedule(bigint)', 'EXECUTE')
              AS can_unschedule`);
  const access = privileges.rows[0]!;
  const [major = 0, minor = 0] = row.extension_version
    .split(".")
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10));
  const supportedVersion = major > 1 || (major === 1 && minor >= 6);
  const ready =
    supportedVersion &&
    access.schema_usage &&
    access.can_read_jobs &&
    access.can_read_runs &&
    access.can_schedule &&
    access.can_unschedule;
  return {
    ready,
    extensionVersion: row.extension_version,
    supportedVersion,
    metadataDatabase: row.metadata_database,
    deploymentRole: row.deployment_role,
    schemaUsage: access.schema_usage,
    canReadJobs: access.can_read_jobs,
    canReadRuns: access.can_read_runs,
    canScheduleInDatabase: access.can_schedule,
    canUnschedule: access.can_unschedule,
  };
}

/**
 * Reconciles declarative Ironshift schedules into pg_cron.
 *
 * The target database owns payloads, occurrence deduplication, and queue semantics. The pg_cron
 * metadata database stores only generated calls to stable Ironshift SQL functions. Synchronization
 * is convergent across the two databases: revision-fenced target definitions commit first, then
 * namespaced cron jobs are transactionally updated and pruned under target-wide and namespace locks.
 */
export class PgCronScheduler {
  readonly namespace: string;

  constructor(
    private readonly database: Pool,
    private readonly cronDatabase: Pool,
    options: PgCronSchedulerOptions,
  ) {
    validateName(options.namespace, "scheduler namespace");
    this.namespace = options.namespace;
  }

  async sync(
    definitions: readonly CronScheduleDefinition[],
    options: PgCronSyncOptions = {},
  ): Promise<PgCronSyncResult> {
    validateDefinitions(definitions);
    const maintenance = maintenanceConfig(options.maintenance);
    const prune = options.prune ?? true;
    await this.assertCronRequirements();
    const targetClient = await this.database.connect();
    let cronClient: PoolClient | undefined;
    const namespaceLockKey = `ironshift:schedules:${this.namespace}`;
    let targetLockKey: string | undefined;
    try {
      cronClient = await this.cronDatabase.connect();
      // A session lock spans both database transactions. Without it, two concurrent deploys could
      // commit target definitions in one order and cron metadata in the opposite order.
      const contextResult = await targetClient.query<TargetContext>(
        "SELECT current_database() AS database_name, current_user AS database_user",
      );
      const context = contextResult.rows[0]!;
      const cronIdentity = await cronClient.query<{ database_user: string }>(
        "SELECT current_user AS database_user",
      );
      if (cronIdentity.rows[0]?.database_user !== context.database_user) {
        throw new Error(
          "the target and pg_cron metadata connections must use the same deployment role",
        );
      }
      targetLockKey = `ironshift:pg_cron-target:${context.database_name}`;
      await cronClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [targetLockKey]);
      await targetClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        namespaceLockKey,
      ]);
      const serialized = definitions.map((definition) => ({
        name: definition.name,
        schedule: definition.schedule,
        queue: definition.job.queue ?? "default",
        type: definition.job.type,
        payload: definition.job.payload,
        maxAttempts: definition.job.maxAttempts ?? 3,
        enabled: definition.enabled ?? true,
      }));

      await targetClient.query("SELECT ironshift.sync_schedule_definitions_v1($1, $2::jsonb, $3)", [
        this.namespace,
        JSON.stringify(serialized),
        prune,
      ]);

      const revisions = await targetClient.query<{ schedule_name: string; revision: string }>(
        `SELECT schedule_name, revision::text
           FROM ironshift.schedule_definition
          WHERE namespace = $1 AND schedule_name = ANY($2::text[])`,
        [this.namespace, definitions.map((definition) => definition.name)],
      );
      const revisionByName = new Map(
        revisions.rows.map(
          (definition) => [definition.schedule_name, definition.revision] as const,
        ),
      );

      const prefix = this.jobPrefix(context.database_name);
      const desired: DesiredCronJob[] = definitions.map((definition) => {
        const revision = revisionByName.get(definition.name);
        if (!revision) throw new Error(`missing synchronized revision for ${definition.name}`);
        return {
          jobName: `${prefix}${definition.name}`,
          schedule: definition.schedule,
          command: `SELECT ironshift.fire_schedule_v1(${sqlLiteral(this.namespace)}, ${sqlLiteral(definition.name)}, ${revision})`,
          active: definition.enabled ?? true,
        };
      });
      if (maintenance) {
        desired.push({
          jobName: `${prefix}${MAINTENANCE_NAME}`,
          schedule: maintenance.schedule,
          command: `SELECT * FROM ironshift.maintain_v1(${maintenance.batchSize}, ${maintenance.batchSize}, ${maintenance.occurrenceRetentionDays}, ${maintenance.occurrencePruneLimit})`,
          active: true,
        });
      }

      const extensionVersion = await this.syncCronJobs(cronClient, context, prefix, desired, prune);
      return await this.readStatus(
        context,
        extensionVersion,
        maintenance,
        targetClient,
        cronClient,
      );
    } finally {
      await targetClient
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [namespaceLockKey])
        .catch(() => undefined);
      if (targetLockKey && cronClient) {
        await cronClient
          .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [targetLockKey])
          .catch(() => undefined);
      }
      cronClient?.release();
      targetClient.release();
    }
  }

  /** Manually fire one occurrence through the same deduplicating SQL boundary used by pg_cron. */
  async trigger(name: string, occurrenceAt = new Date()): Promise<string | null> {
    validateName(name, "schedule name");
    const result = await this.database.query<{ job_id: string | null }>(
      `SELECT ironshift.fire_schedule_v1($1, $2, definition.revision, $3) AS job_id
         FROM ironshift.schedule_definition definition
        WHERE definition.namespace = $1 AND definition.schedule_name = $2`,
      [this.namespace, name, occurrenceAt.toISOString()],
    );
    return result.rows[0]?.job_id ?? null;
  }

  /** Read target definitions and their current namespaced pg_cron registrations. */
  async status(): Promise<PgCronSyncResult> {
    await this.assertCronRequirements();
    const [context, extension] = await Promise.all([
      this.targetContext(),
      this.cronDatabase.query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'pg_cron'",
      ),
    ]);
    return this.readStatus(context, extension.rows[0]!.extversion);
  }

  private async targetContext(): Promise<TargetContext> {
    const result = await this.database.query<TargetContext>(
      "SELECT current_database() AS database_name, current_user AS database_user",
    );
    return result.rows[0]!;
  }

  private async assertCronRequirements(): Promise<void> {
    const requirements = await inspectPgCronRequirements(this.cronDatabase);
    if (!requirements.extensionVersion) {
      throw new Error("pg_cron must be installed in the configured cron metadata database");
    }
    if (!requirements.supportedVersion) {
      throw new Error(`pg_cron 1.6 or newer is required; found ${requirements.extensionVersion}`);
    }
    if (!requirements.schemaUsage) {
      throw new Error("the deployment role requires USAGE on the cron schema");
    }
    if (!requirements.canReadJobs || !requirements.canReadRuns) {
      throw new Error("the deployment role requires SELECT on cron.job and cron.job_run_details");
    }
    if (!requirements.canScheduleInDatabase || !requirements.canUnschedule) {
      const missing = [
        !requirements.canScheduleInDatabase
          ? "cron.schedule_in_database(text,text,text,text,text,boolean)"
          : null,
        !requirements.canUnschedule ? "cron.unschedule(bigint)" : null,
      ].filter((name): name is string => name !== null);
      throw new Error(`the deployment role requires EXECUTE on ${missing.join(" and ")}`);
    }
  }

  private jobPrefix(targetDatabase: string): string {
    return `ironshift/${targetDatabase}/${this.namespace}/`;
  }

  private async syncCronJobs(
    client: PoolClient,
    context: TargetContext,
    prefix: string,
    desired: readonly DesiredCronJob[],
    prune: boolean,
  ): Promise<string> {
    try {
      await client.query("BEGIN");
      const extension = await client.query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'pg_cron'",
      );
      const extensionVersion = extension.rows[0]?.extversion;
      if (!extensionVersion) {
        throw new Error("pg_cron must be installed in the configured cron metadata database");
      }
      const privilege = await client.query<{ allowed: boolean }>(
        "SELECT has_schema_privilege(current_user, 'cron', 'USAGE') AS allowed",
      );
      if (!privilege.rows[0]?.allowed) {
        throw new Error("the deployment role requires USAGE on the cron schema");
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `ironshift:pg_cron:${context.database_name}:${this.namespace}`,
      ]);

      const before = await client.query<ExistingCronJobRow>(
        `SELECT jobid::text, jobname, active
           FROM cron.job
          WHERE database = $1 AND username = current_user`,
        [context.database_name],
      );
      const beforeByName = new Map(before.rows.map((job) => [job.jobname, job] as const));

      for (const job of desired) {
        const current = beforeByName.get(job.jobName);
        // pg_cron 1.6's named-job conflict path updates schedule and command, but not active.
        // Recreate only on an active-state transition so disable and re-enable are authoritative.
        if (current && current.active !== job.active) {
          await client.query("SELECT cron.unschedule($1::bigint)", [current.jobid]);
        }
        await client.query("SELECT cron.schedule_in_database($1, $2, $3, $4, $5, $6) AS job_id", [
          job.jobName,
          job.schedule,
          job.command,
          context.database_name,
          null,
          job.active,
        ]);
      }

      const wanted = new Set(desired.map((job) => job.jobName));
      const existing = await client.query<{ jobid: string; jobname: string }>(
        "SELECT jobid::text, jobname FROM cron.job WHERE database = $1 AND username = current_user",
        [context.database_name],
      );
      for (const job of existing.rows) {
        const ownedMissing = job.jobname.startsWith(prefix) && !wanted.has(job.jobname);
        const maintenanceDisabled = job.jobname === `${prefix}${MAINTENANCE_NAME}`;
        if (ownedMissing && (prune || maintenanceDisabled)) {
          await client.query("SELECT cron.unschedule($1::bigint)", [job.jobid]);
        }
      }

      await client.query("COMMIT");
      return extensionVersion;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  private async readStatus(
    context: TargetContext,
    extensionVersion: string,
    maintenance?: {
      schedule: string;
      batchSize: number;
      occurrenceRetentionDays: number;
      occurrencePruneLimit: number;
    } | null,
    targetDatabase: Queryable = this.database,
    cronDatabase: Queryable = this.cronDatabase,
  ): Promise<PgCronSyncResult> {
    const prefix = this.jobPrefix(context.database_name);
    const [definitions, cronJobs] = await Promise.all([
      targetDatabase.query<DefinitionRow>(
        `SELECT definition.schedule_name, definition.revision::text,
                definition.cron_expression, definition.enabled,
                latest.occurrence_at AS last_occurrence_at, latest.job_id AS last_job_id
           FROM ironshift.schedule_definition definition
           LEFT JOIN LATERAL (
             SELECT occurrence.occurrence_at, occurrence.job_id
               FROM ironshift.schedule_occurrence occurrence
              WHERE occurrence.namespace = definition.namespace
                AND occurrence.schedule_name = definition.schedule_name
              ORDER BY occurrence.occurrence_at DESC LIMIT 1
           ) latest ON true
          WHERE definition.namespace = $1
          ORDER BY definition.schedule_name`,
        [this.namespace],
      ),
      cronDatabase.query<CronJobRow>(
        `WITH owned_jobs AS MATERIALIZED (
           SELECT jobid, jobname, schedule, command, active
             FROM cron.job
            WHERE database = $1 AND username = current_user
              AND left(jobname, length($2)) = $2
         ), latest_runs AS (
           SELECT DISTINCT ON (details.jobid) details.jobid, details.status,
                  details.start_time, details.end_time, details.return_message
             FROM cron.job_run_details details
             JOIN owned_jobs job ON job.jobid = details.jobid
            ORDER BY details.jobid, details.runid DESC
         )
         SELECT job.jobid::text, job.jobname, job.schedule, job.command, job.active,
                run.status AS run_status, run.start_time AS run_started_at,
                run.end_time AS run_ended_at, run.return_message AS run_message
           FROM owned_jobs job
           LEFT JOIN latest_runs run ON run.jobid = job.jobid
          ORDER BY job.jobname`,
        [context.database_name, prefix],
      ),
    ]);
    const owned = new Map(
      cronJobs.rows
        .filter((job) => job.jobname.startsWith(prefix))
        .map((job) => [job.jobname, job] as const),
    );
    const maintenanceJob = owned.get(`${prefix}${MAINTENANCE_NAME}`);
    const recordedMaintenance = maintenanceJob?.command.match(
      /maintain_v1\((\d+),\s*\d+,\s*(\d+),\s*(\d+)\)/,
    );

    return {
      extensionVersion,
      namespace: this.namespace,
      targetDatabase: context.database_name,
      targetUser: context.database_user,
      maintenance: maintenanceJob
        ? {
            cronJobId: maintenanceJob.jobid,
            active: maintenanceJob.active,
            schedule: maintenanceJob.schedule,
            batchSize: maintenance?.batchSize ?? Number(recordedMaintenance?.[1] ?? 0),
            occurrenceRetentionDays:
              maintenance?.occurrenceRetentionDays ?? Number(recordedMaintenance?.[2] ?? 0),
            occurrencePruneLimit:
              maintenance?.occurrencePruneLimit ?? Number(recordedMaintenance?.[3] ?? 0),
            lastRun: lastRun(maintenanceJob),
          }
        : null,
      schedules: definitions.rows.map((definition) => {
        const cron = owned.get(`${prefix}${definition.schedule_name}`);
        return {
          name: definition.schedule_name,
          revision: definition.revision,
          schedule: definition.cron_expression,
          enabled: definition.enabled,
          cronJobId: cron?.jobid ?? null,
          cronActive: cron?.active ?? false,
          lastOccurrenceAt: definition.last_occurrence_at,
          lastJobId: definition.last_job_id,
          lastRun: lastRun(cron),
        };
      }),
    };
  }
}

async function unscheduleIronshiftTargetLocked(
  client: PoolClient,
  targetDatabase: string,
): Promise<number> {
  const extension = await client.query<{ installed: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS installed",
  );
  if (!extension.rows[0]?.installed) return 0;
  const jobs = await client.query<{ jobid: string; jobname: string }>(
    "SELECT jobid::text, jobname FROM cron.job WHERE database = $1 AND username = current_user",
    [targetDatabase],
  );
  const owned = jobs.rows.filter((job) => job.jobname.startsWith(`ironshift/${targetDatabase}/`));
  for (const job of owned) {
    await client.query("SELECT cron.unschedule($1::bigint)", [job.jobid]);
  }
  return owned.length;
}

/** Internal coordination seam used by reset tooling to keep the lock through DROP and CREATE. */
export async function withIronshiftTargetCronLock<T>(
  cronDatabase: Pool,
  targetDatabase: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await cronDatabase.connect();
  const lockKey = `ironshift:pg_cron-target:${targetDatabase}`;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    return await action(client);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
      .catch(() => undefined);
    client.release();
  }
}

/** Remove every pg_cron job owned by the current role for one target database. */
export async function unscheduleIronshiftTarget(
  cronDatabase: Pool,
  targetDatabase: string,
): Promise<number> {
  return withIronshiftTargetCronLock(cronDatabase, targetDatabase, (client) =>
    unscheduleIronshiftTargetLocked(client, targetDatabase),
  );
}

/** Reset-only helper that keeps cleanup and the caller's destructive action under one lock. */
export async function unscheduleIronshiftTargetWhileLocked(
  cronDatabase: Pool,
  targetDatabase: string,
  action: (client: PoolClient, unscheduled: number) => Promise<void>,
): Promise<number> {
  return withIronshiftTargetCronLock(cronDatabase, targetDatabase, async (client) => {
    const unscheduled = await unscheduleIronshiftTargetLocked(client, targetDatabase);
    await action(client, unscheduled);
    return unscheduled;
  });
}
