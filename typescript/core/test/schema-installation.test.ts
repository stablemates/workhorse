import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKHORSE_SCHEMA_VERSION } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("schema installation", () => {
  it("installs the versioned dashboard read surface", async () => {
    const views = await pool.query<{ table_name: string; columns: string[] }>(`
      SELECT table_name, json_agg(column_name ORDER BY ordinal_position) AS columns
        FROM information_schema.views
        JOIN information_schema.columns USING (table_catalog, table_schema, table_name)
       WHERE table_schema = 'workhorse'
         AND table_name LIKE 'dashboard\\_%\\_v1' ESCAPE '\\'
       GROUP BY table_name
       ORDER BY table_name
    `);

    expect(Object.fromEntries(views.rows.map((row) => [row.table_name, row.columns]))).toEqual({
      dashboard_attempt_history_v1: [
        "attempt_id",
        "job_id",
        "attempt",
        "fence_token",
        "worker_id",
        "outcome",
        "started_at",
        "claimed_at",
        "finished_at",
        "error",
        "occurred_at",
      ],
      dashboard_concurrency_policy_v1: [
        "namespace",
        "queue_name",
        "max_active",
        "max_active_per_key",
        "updated_at",
      ],
      dashboard_human_wait_v1: [
        "job_id",
        "queue_name",
        "job_type",
        "token_name",
        "context",
        "attempt",
        "created_at",
        "completed_at",
        "completed_by",
        "deadline_at",
      ],
      dashboard_signal_wait_v1: [
        "job_id",
        "queue_name",
        "job_type",
        "signal_name",
        "attempt",
        "created_at",
        "deadline_at",
      ],
      dashboard_job_checkpoint_v1: [
        "job_id",
        "checkpoint_name",
        "checkpoint_value",
        "attempt",
        "fence_token",
        "worker_id",
        "created_at",
      ],
      dashboard_job_child_v1: [
        "parent_job_id",
        "child_job_id",
        "child_name",
        "created_at",
        "joined_at",
      ],
      dashboard_job_dependency_v1: [
        "dependent_job_id",
        "prerequisite_job_id",
        "on_success",
        "on_failure",
        "on_cancellation",
        "created_at",
        "released_at",
        "resolution",
      ],
      dashboard_job_event_v1: [
        "event_id",
        "job_id",
        "attempt",
        "event_type",
        "details",
        "occurred_at",
      ],
      // `result` is deliberately absent: it is served by dashboard_job_result_v1 so that readers
      // which never want a result do not join workhorse.job for its redaction keys (ADR 0035).
      dashboard_job_outcome_v1: [
        "job_id",
        "state",
        "current_attempt",
        "run_at",
        "error",
        "finished_at",
        "updated_at",
      ],
      dashboard_job_redrive_v1: [
        "source_job_id",
        "target_job_id",
        "request_id_preview",
        "request_id_digest",
        "request_id_length",
        "requested_by",
        "reason",
        "source_state",
        "target_initial_state",
        "requested_at",
      ],
      dashboard_job_progress_v1: [
        "job_id",
        "progress_value",
        "revision",
        "attempt",
        "fence_token",
        "worker_id",
        "created_at",
        "updated_at",
      ],
      dashboard_job_runtime_v1: [
        "job_id",
        "queue_name",
        "state",
        "current_attempt",
        "fence_token",
        "run_at",
        "ready_at",
        "worker_id",
        "acquired_at",
        "heartbeat_at",
        "expires_at",
        "attempt_timeout_at",
        "wait_name",
        "attempt_started_at",
        "cancel_requested_at",
        "cancel_requested_by",
        "cancel_reason",
        "error",
        "updated_at",
      ],
      dashboard_job_v1: [
        "id",
        "queue_name",
        "job_type",
        "concurrency_key",
        "payload",
        "payload_redact_keys",
        "result_redact_keys",
        "tags",
        "max_attempts",
        "retry_policy",
        "deadline_at",
        "execution_timeout_ms",
        "created_at",
        "priority",
      ],
      dashboard_job_wait_v1: [
        "job_id",
        "wait_name",
        "mode",
        "duration_ms",
        "requested_wake_at",
        "wake_at",
        "attempt",
        "fence_token",
        "worker_id",
        "created_at",
      ],
      dashboard_maintenance_policy_v1: [
        "singleton",
        "timezone",
        "partition_preparation_interval_ms",
        "terminal_cleanup_interval_ms",
        "history_retention_local_time",
        "statistics_rollup_interval_ms",
        "statistics_group_limit",
        "statistics_recompute_buckets",
        "updated_at",
      ],
      dashboard_maintenance_state_v1: [
        "task_name",
        "last_started_at",
        "last_completed_at",
        "last_completed_local_date",
      ],
      dashboard_queue_control_v1: ["queue_name", "paused"],
      dashboard_rate_limit_policy_v1: ["queue_name"],
      dashboard_retention_policy_v1: [
        "singleton",
        "job_event_retention_days",
        "attempt_history_retention_days",
      ],
      dashboard_schedule_definition_v1: [
        "namespace",
        "schedule_name",
        "cron_expression",
        "timezone",
        "queue_name",
        "job_type",
        "enabled",
        "revision",
        "updated_at",
        "priority",
      ],
      dashboard_schedule_occurrence_v1: ["namespace", "schedule_name", "occurrence_at", "fired_at"],
      dashboard_worker_registry_v1: [
        "worker_id",
        "hostname",
        "pid",
        "queue_name",
        "concurrency",
        "lease_ms",
        "heartbeat_ms",
        "poll_ms",
        "maintenance_interval_ms",
        "maintenance_task_poll_ms",
        "registry_interval_ms",
        "active_slots",
        "draining",
        "paused",
        "started_at",
        "last_heartbeat_at",
        "queue_names",
      ],
    });

    const estimate = await pool.query<{ estimate: string }>(
      "SELECT estimate::text FROM workhorse.dashboard_job_estimate_v1()",
    );
    expect(Number(estimate.rows[0]?.estimate)).toBeGreaterThanOrEqual(-1);
  });

  it("ships a clean-install artifact without upgrade residue", async () => {
    const schema = await readFile(path.join(repository, "sql", "schema.sql"), "utf8");

    expect(schema).not.toMatch(/^ALTER TABLE /m);
    expect(schema).not.toMatch(/^ALTER FUNCTION /m);
    expect(schema).not.toMatch(/^DROP (?:FUNCTION|TRIGGER) IF EXISTS /m);
    expect(schema).not.toMatch(/^DO \$migration\$/m);
  });

  it("carries no function or view version above v1", async () => {
    // The baseline reset left one version of everything. A `_v2` in a clean install would mean a
    // compatibility window nobody can be inside, because version 1 is the only version there has
    // ever been.
    const versioned = await pool.query<{ name: string }>(
      `SELECT proname AS name
         FROM pg_proc
         JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
        WHERE nspname = 'workhorse' AND proname ~ '_v[0-9]+$' AND proname !~ '_v1$'
        UNION ALL
       SELECT relname AS name
         FROM pg_class
         JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE nspname = 'workhorse' AND relkind = 'v'
          AND relname ~ '_v[0-9]+$' AND relname !~ '_v1$'
        ORDER BY name`,
    );
    expect(versioned.rows).toEqual([]);
  });

  it("installs schema v1 with database-owned settings, job contracts, and fenced progress", async () => {
    const version = await pool.query<{ version: number }>(
      "SELECT max(version)::integer AS version FROM workhorse.schema_version",
    );
    expect(version.rows[0]?.version).toBe(WORKHORSE_SCHEMA_VERSION);

    const migrations = await pool.query<{ version: number; description: string }>(
      "SELECT version, description FROM workhorse.schema_migration ORDER BY version",
    );
    expect(migrations.rows).toEqual([{ version: 1, description: "baseline" }]);

    const protocols = await pool.query<{ version: number }>(
      "SELECT version FROM workhorse.protocol_version ORDER BY version",
    );
    expect(protocols.rows).toEqual([{ version: 1 }]);

    const maintenanceFunctions = await pool.query<{
      maintain: string | null;
      tick: string | null;
      housekeep: string | null;
      partitions: string | null;
      retention: string | null;
      releasedDependencies: string | null;
      terminal: string | null;
    }>(`SELECT
        to_regprocedure('workhorse.maintain_v1(integer,integer,integer,integer)')::text AS maintain,
        to_regprocedure('workhorse.tick_v1(integer,integer)')::text AS tick,
        to_regprocedure('workhorse.housekeep_v1(integer,integer)')::text AS housekeep,
        to_regprocedure('workhorse.prepare_history_partitions_v1(boolean,timestamp with time zone)')::text AS partitions,
        to_regprocedure('workhorse.retain_history_v1(boolean,timestamp with time zone)')::text AS retention,
        to_regprocedure('workhorse.prune_released_dependencies_v1(integer)')::text AS "releasedDependencies",
        to_regprocedure('workhorse.prune_terminal_storage_v1(boolean,timestamp with time zone)')::text AS terminal`);
    expect(maintenanceFunctions.rows[0]).toEqual({
      maintain: null,
      tick: "tick_v1(integer,integer)",
      housekeep: null,
      partitions: "prepare_history_partitions_v1(boolean,timestamp with time zone)",
      retention: "retain_history_v1(boolean,timestamp with time zone)",
      releasedDependencies: "prune_released_dependencies_v1(integer)",
      terminal: "prune_terminal_storage_v1(boolean,timestamp with time zone)",
    });

    const maintenancePolicy = await queue.getMaintenancePolicy();
    expect(maintenancePolicy).toMatchObject({
      timezone: "UTC",
      partitionPreparationIntervalMs: 21_600_000,
      terminalCleanupIntervalMs: 300_000,
      historyRetentionLocalTime: "03:00",
      updatedAt: expect.any(Date),
    });

    const healthPolicy = await pool.query<{
      promotion_lag_ms: number;
      rollup_stalled_lag_ms: number;
      row_retention_lag_ms: number;
      partition_retention_lag_ms: number;
      eligible_history_partitions: number;
      operator_overrides: string[];
    }>("SELECT * FROM workhorse.get_queue_health_policy_v1()");
    expect(healthPolicy.rows[0]).toMatchObject({
      promotion_lag_ms: 10_000,
      rollup_stalled_lag_ms: 1_800_000,
      row_retention_lag_ms: 21_600_000,
      partition_retention_lag_ms: 172_800_000,
      eligible_history_partitions: 2,
      operator_overrides: [],
    });
    await expect(queue.health()).resolves.toMatchObject({
      schemaVersion: WORKHORSE_SCHEMA_VERSION,
      budgets: {
        promotionLagMs: 10_000,
        rollupStalledLagMs: 1_800_000,
        rowRetentionLagMs: 21_600_000,
        partitionRetentionLagMs: 172_800_000,
        eligibleHistoryPartitions: 2,
      },
    });

    const historyPartitions = await pool.query<{ parent: string; partitions: number }>(`
        SELECT parent.relname AS parent, count(*)::integer AS partitions
          FROM pg_inherits inheritance
          JOIN pg_class parent ON parent.oid = inheritance.inhparent
          JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
         WHERE namespace.nspname = 'workhorse'
           AND parent.relname IN ('job_event', 'attempt_history')
         GROUP BY parent.relname
         ORDER BY parent.relname`);
    expect(historyPartitions.rows).toEqual([
      { parent: "attempt_history", partitions: 5 },
      { parent: "job_event", partitions: 5 },
    ]);

    const historyIntegrity = await pool.query<{ foreign_keys: number; triggers: string[] }>(`
        SELECT
          (SELECT count(*)::integer FROM pg_constraint
            WHERE conrelid IN ('workhorse.job_event'::regclass, 'workhorse.attempt_history'::regclass)
              AND contype = 'f') AS foreign_keys,
          (SELECT json_agg(trigger_name ORDER BY trigger_name) FROM (
            SELECT tgname AS trigger_name FROM pg_trigger
             WHERE tgrelid IN ('workhorse.job_event'::regclass, 'workhorse.attempt_history'::regclass)
               AND NOT tgisinternal
          ) triggers) AS triggers`);
    expect(historyIntegrity.rows[0]).toEqual({
      foreign_keys: 0,
      triggers: ["attempt_history_job_exists", "job_event_job_exists"],
    });

    const relations = await pool.query<{ relname: string }>(
      `
        SELECT c.relname
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'workhorse'
           AND c.relname = ANY($1::text[])
           AND c.relkind IN ('r', 'p', 'v', 'm')`,
      [["job_current", "ready_job", "scheduled_job", "lease"]],
    );
    expect(relations.rows).toEqual([]);

    const indexes = await pool.query<{ indexname: string }>(
      `
        SELECT indexname FROM pg_indexes
         WHERE schemaname = 'workhorse'
           AND indexname = ANY($1::text[])
         ORDER BY indexname`,
      [
        [
          "job_runtime_expired_active_idx",
          "job_runtime_blocked_queue_idx",
          "job_runtime_ready_idx",
          "job_runtime_scheduled_idx",
          "job_dependency_dependent_pending_idx",
          "job_dependency_prerequisite_idx",
          "job_dependency_released_retention_idx",
          "job_tags_gin_idx",
          "enqueue_idempotency_expiry_idx",
        ],
      ],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "enqueue_idempotency_expiry_idx",
      "job_dependency_dependent_pending_idx",
      "job_dependency_prerequisite_idx",
      "job_dependency_released_retention_idx",
      "job_runtime_blocked_queue_idx",
      "job_runtime_expired_active_idx",
      "job_runtime_ready_idx",
      "job_runtime_scheduled_idx",
      "job_tags_gin_idx",
    ]);

    const idempotencyConstraint = await pool.query<{
      deferrable: boolean;
      initially_deferred: boolean;
    }>(`
        SELECT condeferrable AS deferrable, condeferred AS initially_deferred
          FROM pg_constraint
         WHERE conrelid = 'workhorse.enqueue_idempotency'::regclass
           AND contype = 'f'`);
    expect(idempotencyConstraint.rows).toEqual([{ deferrable: true, initially_deferred: true }]);
    const idempotencyColumns = await pool.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'workhorse' AND table_name = 'enqueue_idempotency'
         ORDER BY column_name`);
    expect(idempotencyColumns.rows.map((row) => row.column_name)).toContain("idempotency_key_hash");
    expect(idempotencyColumns.rows.map((row) => row.column_name)).not.toContain("idempotency_key");
  });
});
