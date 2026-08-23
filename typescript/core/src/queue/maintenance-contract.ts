/** Stable SQL protocol call shared by the worker and conformance manifest. */
export const RUN_MAINTENANCE_SQL = "SELECT * FROM workhorse.run_maintenance_v1($1::timestamptz)";
