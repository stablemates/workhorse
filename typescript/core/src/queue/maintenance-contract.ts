import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
/** Stable SQL protocol call shared by the worker and conformance manifest. */
export const RUN_MAINTENANCE_SQL = SQL_STATEMENTS["run_maintenance_v1"];
/**
 * The maintenance time when the caller gives none. PostgreSQL resolves this `timestamptz` input to
 * the start time of the statement's transaction, so a host clock cannot move shared due times or
 * retention cutoffs.
 */
export const DATABASE_NOW = "now";
