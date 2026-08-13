import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("schema installation", () => {
  it("ships a clean-install artifact without upgrade residue", async () => {
    const schema = await readFile(path.join(repository, "sql", "schema.sql"), "utf8");

    expect(schema).not.toMatch(/^ALTER TABLE /m);
    expect(schema).not.toMatch(/^DROP (?:FUNCTION|TRIGGER) IF EXISTS /m);
  });

  it("does not install retired functions", async () => {
    const retiredFunctions = await pool.query<{ claim: string | null; heartbeat: string | null }>(
      `SELECT
         to_regprocedure('workhorse.claim_v1(text,text,integer)')::text AS claim,
         to_regprocedure('workhorse.heartbeat_v1(uuid,text,bigint,integer)')::text AS heartbeat`,
    );
    expect(retiredFunctions.rows[0]).toEqual({ claim: null, heartbeat: null });
  });

  it("installs schema v25 with database-owned settings, job contracts, and fenced progress", async () => {
    const version = await pool.query<{ version: number }>(
      "SELECT max(version)::integer AS version FROM workhorse.schema_version",
    );
    expect(version.rows[0]?.version).toBe(25);

    const migrations = await pool.query<{ version: number; description: string }>(
      "SELECT version, description FROM workhorse.schema_migration ORDER BY version",
    );
    expect(migrations.rows).toEqual([
      { version: 23, description: "forward migration baseline" },
      { version: 24, description: "add schema migration ledger" },
      { version: 25, description: "make schedule occurrence replay a no-op" },
    ]);

    const maintenanceFunctions = await pool.query<{
      maintain: string | null;
      tick: string | null;
      housekeep: string | null;
      partitions: string | null;
      retention: string | null;
      terminal: string | null;
    }>(`SELECT
        to_regprocedure('workhorse.maintain_v1(integer,integer,integer,integer)')::text AS maintain,
        to_regprocedure('workhorse.tick_v1(integer,integer)')::text AS tick,
        to_regprocedure('workhorse.housekeep_v1(integer,integer)')::text AS housekeep,
        to_regprocedure('workhorse.prepare_history_partitions_v1(boolean,timestamp with time zone)')::text AS partitions,
        to_regprocedure('workhorse.retain_history_v1(boolean,timestamp with time zone)')::text AS retention,
        to_regprocedure('workhorse.prune_terminal_storage_v1(boolean,timestamp with time zone)')::text AS terminal`);
    expect(maintenanceFunctions.rows[0]).toEqual({
      maintain: null,
      tick: "tick_v1(integer,integer)",
      housekeep: null,
      partitions: "prepare_history_partitions_v1(boolean,timestamp with time zone)",
      retention: "retain_history_v1(boolean,timestamp with time zone)",
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
          "job_runtime_ready_idx",
          "job_runtime_scheduled_idx",
          "job_tags_gin_idx",
          "enqueue_idempotency_expiry_idx",
        ],
      ],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "enqueue_idempotency_expiry_idx",
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
