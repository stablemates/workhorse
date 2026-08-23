/** Language-neutral queue-health call pinned by protocol/v1/manifest.json. */
export const QUEUE_HEALTH_SQL = "SELECT workhorse.queue_health_v1($1::timestamptz) AS snapshot";
