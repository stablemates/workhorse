/**
 * One owner for every aggregate read of `workhorse.job_runtime`.
 *
 * Three callers ask the same questions of live runtime rows: the health snapshot asks them
 * database-wide, `Queue.queueMetricSnapshot()` and `WorkhorseMetricsObserver` ask them per queue.
 * Each used to carry its own copy of the aggregate expressions, so a state name or a lease-expiry
 * rule could be corrected in one copy and stay wrong in the other two. The expressions live here
 * instead, and callers name the ones they need.
 *
 * Every count aggregates `job_id` rather than rows. `job_id` is the primary key of
 * `workhorse.job_runtime`, so a database-wide count is unchanged, and a per-queue count over the
 * outer join below reports zero for a queue with no runtime rows instead of one.
 */

/** A named aggregate over live runtime rows. Names are the SQL result column names. */
export type DepthMetric = keyof typeof DEPTH_METRICS;

const DEPTH_METRICS = {
  blocked: (r: string) => `count(${r}.job_id) FILTER (WHERE ${r}.state = 'blocked')::text`,
  ready: (r: string) => `count(${r}.job_id) FILTER (WHERE ${r}.state = 'ready')::text`,
  scheduled: (r: string) => `count(${r}.job_id) FILTER (WHERE ${r}.state = 'scheduled')::text`,
  active: (r: string) => `count(${r}.job_id) FILTER (WHERE ${r}.state = 'active')::text`,
  /** Active rows whose lease has run out. Recovery owes these jobs another attempt. */
  expired: (r: string) =>
    `count(${r}.job_id) FILTER (
       WHERE ${r}.state = 'active' AND ${r}.expires_at <= clock_timestamp()
     )::text`,
  /** Active rows whose lease still holds, which is what concurrency admission counts. */
  concurrency_active: (r: string) =>
    `count(${r}.job_id) FILTER (
       WHERE ${r}.state = 'active' AND ${r}.expires_at > clock_timestamp()
     )::text`,
  /** Scheduled rows parked by a durable wait rather than by a retry or a delayed enqueue. */
  sleeping: (r: string) =>
    `count(${r}.job_id) FILTER (
       WHERE ${r}.state = 'scheduled' AND ${r}.wait_name IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM workhorse.job_wait timer
            WHERE timer.job_id = ${r}.job_id AND timer.wait_name = ${r}.wait_name
         )
     )::text`,
  overdue_waits: (r: string) =>
    `count(${r}.job_id) FILTER (
       WHERE ${r}.state = 'scheduled' AND ${r}.wait_name IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM workhorse.job_wait timer
            WHERE timer.job_id = ${r}.job_id AND timer.wait_name = ${r}.wait_name
         )
         AND ${r}.run_at <= clock_timestamp()
     )::text`,
  next_wake_at: (r: string) =>
    `min(${r}.run_at) FILTER (
       WHERE ${r}.state = 'scheduled' AND ${r}.wait_name IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM workhorse.job_wait timer
            WHERE timer.job_id = ${r}.job_id AND timer.wait_name = ${r}.wait_name
         )
     )`,
  oldest_ready_age_ms: (r: string) =>
    `extract(epoch FROM clock_timestamp() - min(${r}.ready_at) FILTER (
       WHERE ${r}.state = 'ready'
     )) * 1000`,
  overdue_scheduled: (r: string) =>
    `count(${r}.job_id) FILTER (
       WHERE ${r}.state = 'scheduled' AND ${r}.run_at <= clock_timestamp()
     )::text`,
  oldest_overdue_scheduled_age_ms: (r: string) =>
    `extract(epoch FROM clock_timestamp() - min(${r}.run_at) FILTER (
       WHERE ${r}.state = 'scheduled' AND ${r}.run_at <= clock_timestamp()
     )) * 1000`,
  pending_deadlines: (r: string) =>
    `count(${r}.job_id) FILTER (WHERE ${r}.deadline_at IS NOT NULL)::text`,
  overdue_deadlines: (r: string) =>
    `count(${r}.job_id) FILTER (
       WHERE ${r}.deadline_at IS NOT NULL AND ${r}.deadline_at <= clock_timestamp()
     )::text`,
  deadlines_due_within_minute: (r: string) =>
    `count(${r}.job_id) FILTER (
       WHERE ${r}.deadline_at > clock_timestamp()
         AND ${r}.deadline_at <= clock_timestamp() + interval '1 minute'
     )::text`,
  earliest_deadline_at: (r: string) => `min(${r}.deadline_at)`,
  active_execution_timeouts: (r: string) =>
    `count(${r}.job_id) FILTER (
       WHERE ${r}.state = 'active' AND ${r}.attempt_timeout_at IS NOT NULL
     )::text`,
  overdue_execution_timeouts: (r: string) =>
    `count(${r}.job_id) FILTER (
       WHERE ${r}.state = 'active' AND ${r}.attempt_timeout_at <= clock_timestamp()
     )::text`,
} as const;

const RUNTIME_ALIAS = "runtime";

/** Render the named aggregates as a select list, aliased to their metric names. */
export function depthColumns(metrics: readonly DepthMetric[], alias = RUNTIME_ALIAS): string {
  return metrics
    .map((metric) => `${DEPTH_METRICS[metric](alias)} AS ${metric}`)
    .join(",\n         ");
}

/**
 * Render the database-wide depth read: one row of aggregates over every live runtime row.
 */
export function totalDepthSelect(metrics: readonly DepthMetric[]): string {
  return `SELECT ${depthColumns(metrics)}
      FROM workhorse.job_runtime ${RUNTIME_ALIAS}`;
}

/**
 * Render the per-queue depth read: one row per name produced by `queueNamesCte`.
 *
 * The join is outer so a queue that is configured but currently empty still reports a row of
 * zeroes. Callers supply the name source because they disagree about which queues deserve a row:
 * the observer reports queues that hold work or carry a pause, the metric snapshot also reports
 * queues that only carry a policy or a registered worker.
 */
export function perQueueDepthSelect(
  metrics: readonly DepthMetric[],
  queueNamesCte: string,
): string {
  return `SELECT names.queue_name,
         ${depthColumns(metrics)}
      FROM ${queueNamesCte} names
      LEFT JOIN workhorse.job_runtime ${RUNTIME_ALIAS}
        ON ${RUNTIME_ALIAS}.queue_name = names.queue_name
     GROUP BY names.queue_name`;
}
