import type { Pool } from "pg";

/**
 * Data for the checks of the maintenance_state part of the shared test resets (SM-1717). A test
 * changes every column, runs a reset, and expects the install state of each routine.
 */

export const installMaintenanceState = [
  "history_partitions",
  "history_retention",
  "terminal_storage",
  "tick",
].map((routine_name) => ({
  routine_name,
  last_started_at: null,
  last_completed_at: null,
  last_completed_local_date: null,
  history_retained_before_is_default: true,
  terminal_prune_dependency_starved: false,
  terminal_prune_fast_first: false,
  terminal_cleanup_backlog_since: null,
  lease_recovery_started_at: null,
  updated_at_is_reset: true,
}));

export async function readMaintenanceState(pool: Pool) {
  const state = await pool.query(
    `SELECT routine_name, last_started_at, last_completed_at,
            last_completed_local_date::text AS last_completed_local_date,
            -- The reset ran before this query, so a UTC midnight between them moves the boundary
            -- by one day.
            CASE WHEN routine_name = 'history_retention'
              THEN history_retained_before IN (
                date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  - interval '14 days',
                date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  - interval '15 days')
              ELSE history_retained_before IS NULL
            END AS history_retained_before_is_default,
            terminal_prune_dependency_starved, terminal_prune_fast_first,
            terminal_cleanup_backlog_since, lease_recovery_started_at,
            updated_at > timestamptz '2001-01-01 00:00:00+00' AS updated_at_is_reset
       FROM workhorse.maintenance_state ORDER BY routine_name`,
  );
  return state.rows;
}

/** Give every maintenance_state column a value that differs from its install value. */
export async function changeEveryMaintenanceColumn(pool: Pool): Promise<void> {
  await pool.query(`UPDATE workhorse.maintenance_state SET
    last_started_at = clock_timestamp(),
    last_completed_at = clock_timestamp(),
    last_completed_local_date = CASE WHEN routine_name = 'history_retention'
      THEN current_date END,
    history_retained_before = CASE WHEN routine_name = 'history_retention'
      THEN clock_timestamp() END,
    terminal_prune_dependency_starved = routine_name = 'terminal_storage',
    terminal_prune_fast_first = true,
    terminal_cleanup_backlog_since = clock_timestamp(),
    lease_recovery_started_at = clock_timestamp(),
    updated_at = timestamptz '2000-01-01 00:00:00+00'`);
}

/** The columns of maintenance_state that maintenanceStateReset in db.ts and these checks know. */
export const knownMaintenanceColumns = [
  "history_retained_before",
  "last_completed_at",
  "last_completed_local_date",
  "last_started_at",
  "lease_recovery_started_at",
  "routine_name",
  "terminal_cleanup_backlog_since",
  "terminal_prune_dependency_starved",
  "terminal_prune_fast_first",
  "updated_at",
];

export async function readMaintenanceColumns(pool: Pool): Promise<string[]> {
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'workhorse' AND table_name = 'maintenance_state'
      ORDER BY column_name`,
  );
  return columns.rows.map((row) => row.column_name);
}
