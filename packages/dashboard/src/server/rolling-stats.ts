import { sql } from "./sql.js";

/**
 * Reading the rolling statistics that `workhorse.rollup_stats_v1` maintains.
 *
 * Every operator time window on the system page is answered from per-minute aggregates rather than
 * from a scan over retained history, so its cost tracks the window length and the number of active
 * (queue, task type) pairs instead of throughput. `workhorse.stat_buckets_v1` stitches materialized
 * buckets to a live tail for the minutes the rollup has not closed yet, so a window is correct even
 * immediately after a job runs and stays correct if the rollup pass is behind.
 */

/**
 * Start of the `multiple`-th window back, aligned to the minute grid the buckets use.
 *
 * Alignment is not cosmetic. `workhorse.stat_buckets_v1` selects materialized buckets by
 * `bucket_start`, so an unaligned lower bound would drop a whole minute of history that the live
 * tail would have included, and the two halves of a stitched window would disagree.
 */
export function statWindowStart(windowSeconds: number, multiple = 1) {
  return sql`(
    date_bin('1 minute', clock_timestamp(), timestamp with time zone '2000-01-01')
    - make_interval(secs => ${windowSeconds * multiple})
    + interval '1 minute'
  )`;
}

/** Per-minute statistics for a trailing window, expressed as a relation named `stat`. */
export function statWindow(windowSeconds: number, multiple = 1) {
  const from = statWindowStart(windowSeconds, multiple);
  const to = multiple === 1 ? sql`clock_timestamp()` : statWindowStart(windowSeconds, multiple - 1);
  return sql`workhorse.stat_buckets_v1(${from}, ${to}) stat`;
}

/** Attempts closed in a bucket, whatever the outcome. */
export const statAttempts = sql`(
  stat.attempt_succeeded + stat.attempt_failed + stat.attempt_retry
  + stat.attempt_lease_expired + stat.attempt_canceled + stat.attempt_other
)`;

/**
 * Attempts that did not end the job successfully or by operator cancellation.
 *
 * Cancellation is an operator decision rather than an error, and a retry is an error the system
 * absorbed, which is exactly why it belongs here: an error rate that ignored retries would read as
 * healthy while a queue burned its attempt budget.
 */
export const statAttemptErrors = sql`(
  stat.attempt_failed + stat.attempt_retry + stat.attempt_lease_expired + stat.attempt_other
)`;

/** Attempts that closed their job, which is what "completed" means on a drain rate. */
export const statCompleted = sql`(
  stat.attempt_succeeded + stat.attempt_failed + stat.attempt_canceled
)`;
