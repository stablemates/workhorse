#!/usr/bin/env node
/**
 * Take one soak observation from a live Workhorse installation.
 *
 * Usage: pnpm soak:observe -- --output DIRECTORY [--database-url URL] [options]
 *
 * The soak this feeds is Gate 4 of ADR 0056: one database runs 30 consecutive days under
 * continuous work, is never reinstalled, and is carried across releases by migration. The public
 * demo host is the subject. Run this on a schedule against that host, at least once a day, and
 * keep every observation; `soak:report` derives the report from the series.
 *
 * Once a day is the floor rather than a preference. A daily partition is retired after its
 * retention window, and the daily statistics tier is pruned on the same clock, so nothing older
 * than that window is readable at the end. Sampling more often than a day costs one short
 * read-only transaction and buys overlap.
 *
 * Every read runs inside one repeatable-read, read-only transaction. The collector therefore
 * reports a single consistent instant, and it cannot write to the installation it inspects.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  HISTORY_PARENTS,
  type HistoryParent,
  type KillRecovery,
  OBSERVATION_FORMAT,
  type SoakObservation,
  type ThroughputDay,
} from "./observation.js";

const help = `Workhorse soak observation collector

Usage:
  pnpm soak:observe -- --output DIRECTORY [options]

Options:
  --output DIRECTORY     Directory the observation file is written into
  --database-url URL     Installation to read (default: WORKHORSE_DATABASE_URL, then DATABASE_URL)
  --kill-worker ID       Also reconcile an ungraceful kill of this worker
  --kill-at TIMESTAMP    When that worker was killed, as an ISO 8601 instant
  --kill-window-hours N  How long after the kill recovery is reconciled (default: 6)
  --print                Also write the observation to stdout
  --help                 Show this help

The collector only reads. It opens one read-only transaction and writes nothing to the
installation. Run it at least once a day for the whole soak window and keep every file.`;

/**
 * How long after a kill its recovery is reconciled.
 *
 * Long enough that every held lease has expired and been recovered under any lease setting the
 * demo uses, and short enough that ordinary later work is not counted as part of the kill.
 */
const DEFAULT_KILL_WINDOW_HOURS = 6;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/** Precedence matches the `workhorse` CLI, so the collector reads what the CLI would read. */
function resolveDatabaseUrl(): string {
  const url =
    argument("--database-url") ??
    process.env["WORKHORSE_DATABASE_URL"] ??
    process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "No installation named. Pass --database-url, or set WORKHORSE_DATABASE_URL or DATABASE_URL.",
    );
  }
  return url;
}

function instant(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** PostgreSQL returns bigint and numeric as text so no count silently loses precision. */
function count(value: string | number | null): number {
  if (value === null) return 0;
  return typeof value === "number" ? value : Number(value);
}

/** The UTC day a daily partition holds, taken from the `YYYYMMDD` suffix its creator writes. */
function partitionDay(parent: HistoryParent, child: string): string | null {
  const match = new RegExp(`^${parent}_(\\d{4})(\\d{2})(\\d{2})$`).exec(child);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function wholeDaysBetween(day: string, observedAt: string): number {
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = Date.parse(observedAt);
  return Math.floor((end - start) / 86_400_000);
}

async function readInstallation(client: PoolClient): Promise<SoakObservation["installation"]> {
  const versions = await client.query<{ version: number }>(
    "SELECT version FROM workhorse.schema_version ORDER BY version",
  );
  const protocols = await client.query<{ version: number }>(
    "SELECT version FROM workhorse.protocol_version ORDER BY version",
  );
  const migrations = await client.query<{
    version: number;
    description: string;
    applied_at: Date;
  }>("SELECT version, description, applied_at FROM workhorse.schema_migration ORDER BY version");
  return {
    // More than one row is not a version, it is a broken installation, and null says so.
    schemaVersion: versions.rows.length === 1 ? versions.rows[0]!.version : null,
    protocolVersions: protocols.rows.map((row) => row.version),
    migrations: migrations.rows.map((row) => ({
      version: row.version,
      description: row.description,
      appliedAt: instant(row.applied_at)!,
    })),
  };
}

async function readPartitions(
  client: PoolClient,
  observedAt: string,
): Promise<SoakObservation["partitions"]> {
  const children = await client.query<{ parent: HistoryParent; child: string }>(
    `SELECT parent.relname AS parent, child.relname AS child
       FROM pg_inherits inheritance
       JOIN pg_class parent ON parent.oid = inheritance.inhparent
       JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
       JOIN pg_class child ON child.oid = inheritance.inhrelid
      WHERE namespace.nspname = 'workhorse'
        AND parent.relname = ANY($1::text[])`,
    [HISTORY_PARENTS],
  );
  // Counting the default partition is capped the way queue_health_v1 caps it: the number only has
  // to separate "empty" from "retention is behind", and an uncapped scan is unbounded work.
  const defaults = await client.query<{ job_event: string; attempt_history: string }>(
    `SELECT
       (SELECT count(*) FROM (SELECT 1 FROM workhorse.job_event_default LIMIT 10001) probe)
         AS job_event,
       (SELECT count(*) FROM (SELECT 1 FROM workhorse.attempt_history_default LIMIT 10001) probe)
         AS attempt_history`,
  );

  const parents = HISTORY_PARENTS.map((parent) => ({
    parent,
    days: children.rows
      .filter((row) => row.parent === parent)
      .map((row) => partitionDay(parent, row.child))
      .filter((day): day is string => day !== null)
      .toSorted(),
    defaultRows: count(defaults.rows[0]![parent]),
  }));
  const oldestSurvivingDay =
    parents
      .flatMap((entry) => entry.days)
      .toSorted()
      .at(0) ?? null;
  return {
    parents,
    oldestSurvivingDay,
    oldestSurvivingAgeDays:
      oldestSurvivingDay === null ? null : wholeDaysBetween(oldestSurvivingDay, observedAt),
  };
}

async function readRetention(client: PoolClient): Promise<SoakObservation["retention"]> {
  const policy = await client.query<{
    job_event_retention_days: number | null;
    attempt_history_retention_days: number | null;
    statistics_retention_days: number | null;
    history_partitions_per_pass: number;
  }>(
    `SELECT job_event_retention_days, attempt_history_retention_days,
            statistics_retention_days, history_partitions_per_pass
       FROM workhorse.retention_policy WHERE singleton`,
  );
  const state = await client.query<{
    task_name: string;
    last_completed_at: Date | null;
    last_completed_local_date: string | null;
    history_retained_before: Date | null;
  }>(
    // The local date is read as text. A DATE arrives as local midnight, and reserializing that
    // through UTC moves the day for anyone west of Greenwich.
    `SELECT task_name, last_completed_at, history_retained_before,
            to_char(last_completed_local_date, 'YYYY-MM-DD') AS last_completed_local_date
       FROM workhorse.maintenance_state
      WHERE task_name IN ('history_retention', 'history_partitions')`,
  );
  const retention = state.rows.find((row) => row.task_name === "history_retention");
  const partitions = state.rows.find((row) => row.task_name === "history_partitions");
  const row = policy.rows[0]!;
  return {
    jobEventRetentionDays: row.job_event_retention_days,
    attemptHistoryRetentionDays: row.attempt_history_retention_days,
    statisticsRetentionDays: row.statistics_retention_days,
    historyPartitionsPerPass: row.history_partitions_per_pass,
    historyRetainedBefore: instant(retention?.history_retained_before ?? null),
    retentionLastCompletedAt: instant(retention?.last_completed_at ?? null),
    retentionLastCompletedLocalDate: retention?.last_completed_local_date ?? null,
    partitionsLastCompletedAt: instant(partitions?.last_completed_at ?? null),
  };
}

/**
 * Closed days of the daily statistics tier.
 *
 * Only days below `daily_rolled_up_through` are read. A closed day is immutable, so two
 * observations that both saw a day agree about it and the report can merge them without deciding
 * which one to believe.
 */
async function readThroughput(client: PoolClient): Promise<ThroughputDay[]> {
  const days = await client.query<{
    day: string;
    enqueued: string;
    job_succeeded: string;
    job_failed: string;
    job_canceled: string;
    attempt_succeeded: string;
    attempt_failed: string;
    attempt_retry: string;
    attempt_lease_expired: string;
    attempt_canceled: string;
    attempt_other: string;
  }>(
    `SELECT to_char(bucket.bucket_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            sum(bucket.enqueued)::text AS enqueued,
            sum(bucket.job_succeeded)::text AS job_succeeded,
            sum(bucket.job_failed)::text AS job_failed,
            sum(bucket.job_canceled)::text AS job_canceled,
            sum(bucket.attempt_succeeded)::text AS attempt_succeeded,
            sum(bucket.attempt_failed)::text AS attempt_failed,
            sum(bucket.attempt_retry)::text AS attempt_retry,
            sum(bucket.attempt_lease_expired)::text AS attempt_lease_expired,
            sum(bucket.attempt_canceled)::text AS attempt_canceled,
            sum(bucket.attempt_other)::text AS attempt_other
       FROM workhorse.job_stat_bucket_day bucket
      WHERE bucket.bucket_start < (
              SELECT state.daily_rolled_up_through FROM workhorse.job_stat_state state
               WHERE state.singleton
            )
      GROUP BY 1
      ORDER BY 1`,
  );
  return days.rows.map((row) => ({
    day: row.day,
    enqueued: count(row.enqueued),
    jobSucceeded: count(row.job_succeeded),
    jobFailed: count(row.job_failed),
    jobCanceled: count(row.job_canceled),
    attemptSucceeded: count(row.attempt_succeeded),
    attemptFailed: count(row.attempt_failed),
    attemptRetry: count(row.attempt_retry),
    attemptLeaseExpired: count(row.attempt_lease_expired),
    attemptCanceled: count(row.attempt_canceled),
    attemptOther: count(row.attempt_other),
  }));
}

/**
 * Reconcile one ungraceful kill.
 *
 * A `SIGKILL`ed worker acknowledges nothing. Its held attempts close as `lease_expired` when
 * recovery reaches them, and those attempts name the jobs the kill put at risk. Every such job must
 * be somewhere afterwards — terminal, or live and moving — and none may hold two succeeded
 * attempts. `jobsLost` and `jobsSucceededMoreThanOnce` are the two numbers that must read zero.
 */
async function readKillRecovery(
  client: PoolClient,
  workerId: string,
  killedAt: string,
  windowHours: number,
): Promise<KillRecovery> {
  const windowEnd = new Date(Date.parse(killedAt) + windowHours * 3_600_000).toISOString();
  const reconciliation = await client.query<{
    lease_expired_attempts: string;
    affected_jobs: string;
    jobs_settled: string;
    jobs_live: string;
    jobs_lost: string;
    jobs_succeeded_more_than_once: string;
  }>(
    `WITH lost AS (
       SELECT history.job_id, count(*) AS attempts
         FROM workhorse.attempt_history history
        WHERE history.worker_id = $1
          AND history.outcome = 'lease_expired'
          AND history.occurred_at >= $2::timestamptz
          AND history.occurred_at < $3::timestamptz
        GROUP BY history.job_id
     ), settled AS (
       SELECT lost.job_id,
              EXISTS (SELECT 1 FROM workhorse.job_outcome outcome WHERE outcome.job_id = lost.job_id)
                AS terminal,
              EXISTS (SELECT 1 FROM workhorse.job_runtime runtime WHERE runtime.job_id = lost.job_id)
                AS live,
              (SELECT count(*) FROM workhorse.attempt_history success
                WHERE success.job_id = lost.job_id AND success.outcome = 'succeeded')
                AS succeeded_attempts
         FROM lost
     )
     SELECT (SELECT coalesce(sum(attempts), 0) FROM lost)::text AS lease_expired_attempts,
            count(*)::text AS affected_jobs,
            count(*) FILTER (WHERE terminal)::text AS jobs_settled,
            count(*) FILTER (WHERE live AND NOT terminal)::text AS jobs_live,
            count(*) FILTER (WHERE NOT terminal AND NOT live)::text AS jobs_lost,
            count(*) FILTER (WHERE succeeded_attempts > 1)::text AS jobs_succeeded_more_than_once
       FROM settled`,
    [workerId, killedAt, windowEnd],
  );
  const row = reconciliation.rows[0]!;
  return {
    workerId,
    killedAt: new Date(killedAt).toISOString(),
    windowEnd,
    leaseExpiredAttempts: count(row.lease_expired_attempts),
    affectedJobs: count(row.affected_jobs),
    jobsSettled: count(row.jobs_settled),
    jobsLive: count(row.jobs_live),
    jobsLost: count(row.jobs_lost),
    jobsSucceededMoreThanOnce: count(row.jobs_succeeded_more_than_once),
  };
}

export interface ObserveOptions {
  killWorker?: string;
  killedAt?: string;
  killWindowHours?: number;
}

/** Read one complete observation from a live installation inside a single read-only snapshot. */
export async function collectSoakObservation(
  pool: Pool,
  options: ObserveOptions = {},
): Promise<SoakObservation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ");
    const identity = await client.query<{
      observed_at: Date;
      database_name: string;
      server_version: string;
    }>(
      `SELECT clock_timestamp() AS observed_at,
              current_database() AS database_name,
              current_setting('server_version') AS server_version`,
    );
    const observedAt = instant(identity.rows[0]!.observed_at)!;

    const backlog = await client.query<{ state: string; jobs: string }>(
      "SELECT state, count(*)::text AS jobs FROM workhorse.job_runtime GROUP BY state",
    );
    const workers = await client.query<{
      worker_id: string;
      hostname: string;
      queue_names: string[];
      active_slots: number;
      started_at: Date;
      last_heartbeat_at: Date;
    }>(
      `SELECT worker_id, hostname, queue_names, active_slots, started_at, last_heartbeat_at
         FROM workhorse.worker_registry ORDER BY worker_id`,
    );
    const health = await client.query<{ document: unknown }>(
      "SELECT workhorse.queue_health_v1() AS document",
    );

    const observation: SoakObservation = {
      format: OBSERVATION_FORMAT,
      observedAt,
      database: {
        name: identity.rows[0]!.database_name,
        serverVersion: identity.rows[0]!.server_version,
      },
      installation: await readInstallation(client),
      partitions: await readPartitions(client, observedAt),
      retention: await readRetention(client),
      throughput: await readThroughput(client),
      backlog: Object.fromEntries(backlog.rows.map((row) => [row.state, count(row.jobs)])),
      workers: workers.rows.map((row) => ({
        workerId: row.worker_id,
        hostname: row.hostname,
        queueNames: row.queue_names,
        activeSlots: row.active_slots,
        startedAt: instant(row.started_at)!,
        lastHeartbeatAt: instant(row.last_heartbeat_at)!,
      })),
      queueHealth: health.rows[0]!.document,
    };

    if (options.killWorker !== undefined && options.killedAt !== undefined) {
      observation.killRecovery = await readKillRecovery(
        client,
        options.killWorker,
        options.killedAt,
        options.killWindowHours ?? DEFAULT_KILL_WINDOW_HOURS,
      );
    }
    await client.query("COMMIT");
    return observation;
  } finally {
    client.release();
  }
}

/** Observation files sort by name into observation order, so a directory listing is the series. */
export function observationFileName(observation: SoakObservation): string {
  return `observation-${observation.observedAt.replaceAll(/[:.]/g, "-")}.json`;
}

if (import.meta.filename === process.argv[1]) {
  if (process.argv.includes("--help")) {
    process.stdout.write(`${help}\n`);
  } else {
    const output = argument("--output");
    const killWorker = argument("--kill-worker");
    const killedAt = argument("--kill-at");
    if ((killWorker === undefined) !== (killedAt === undefined)) {
      throw new Error("--kill-worker and --kill-at are given together or not at all");
    }
    if (killedAt !== undefined && Number.isNaN(Date.parse(killedAt))) {
      throw new Error("--kill-at must be an ISO 8601 instant");
    }
    const killWindowHours = argument("--kill-window-hours");
    if (killWindowHours !== undefined && !(Number(killWindowHours) > 0)) {
      throw new Error("--kill-window-hours must be a positive number of hours");
    }
    const pool = new Pool({ connectionString: resolveDatabaseUrl(), max: 1 });
    try {
      const observation = await collectSoakObservation(pool, {
        ...(killWorker === undefined ? {} : { killWorker }),
        ...(killedAt === undefined ? {} : { killedAt }),
        ...(killWindowHours === undefined ? {} : { killWindowHours: Number(killWindowHours) }),
      });
      const document = `${JSON.stringify(observation, null, 2)}\n`;
      if (output !== undefined) {
        const file = path.join(path.resolve(output), observationFileName(observation));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, document);
        process.stderr.write(`Wrote ${file}\n`);
      }
      if (output === undefined || process.argv.includes("--print")) {
        process.stdout.write(document);
      }
    } finally {
      await pool.end();
    }
  }
}
