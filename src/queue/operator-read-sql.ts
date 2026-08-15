import { totalDepthSelect } from "../queue-depth.js";
import { HEALTH_HISTORY_SCAN_LIMIT } from "../types.js";

// The rate-limit status projection is shared verbatim between rateLimitStatuses() and the health
// snapshot statement so the two surfaces can never disagree about throttle semantics. $1 is the
// optional queue-name filter; the health snapshot passes an empty array.
export const RATE_LIMIT_STATUS_SQL = `
  WITH observed AS (
    SELECT clock_timestamp() AS now
  ), policies AS MATERIALIZED (
    SELECT policy.* FROM workhorse.rate_limit_policy policy
     WHERE cardinality($1::text[]) = 0 OR policy.queue_name = ANY($1::text[])
     ORDER BY policy.queue_name LIMIT 101
  ), queue_status AS (
    SELECT policy.*, observed.now,
           GREATEST(observed.now, COALESCE(bucket.refilled_at, observed.now))
             AS refill_baseline,
           LEAST(policy.rate_burst::numeric, COALESCE(
             bucket.tokens + GREATEST(
               0::numeric,
               extract(epoch FROM observed.now - bucket.refilled_at) * 1000
             ) * policy.rate_limit::numeric / policy.rate_interval_ms::numeric,
             policy.rate_burst::numeric
           )) AS available_tokens
      FROM policies policy CROSS JOIN observed
      LEFT JOIN workhorse.rate_limit_bucket bucket
        ON bucket.queue_name = policy.queue_name
       AND bucket.bucket_scope = 'queue' AND bucket.bucket_key = ''
  )
  SELECT policy.namespace, policy.queue_name, policy.rate_limit,
         policy.rate_interval_ms, policy.rate_burst, policy.per_key_limit,
         policy.per_key_interval_ms, policy.per_key_burst, policy.updated_at,
         policy.available_tokens::text,
         pressure.throttled_ready::text, pressure.throttled_keys::text,
         pressure.next_eligible_at, pressure.sample_capped
         , (SELECT count(*) FROM policies) > 100 AS policy_set_capped
    FROM queue_status policy
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE sample.throttled)::integer AS throttled_ready,
             count(DISTINCT sample.concurrency_key) FILTER (
               WHERE sample.key_throttled
             )::integer AS throttled_keys,
             min(sample.eligible_at) FILTER (WHERE sample.throttled) AS next_eligible_at,
             count(*) > 100 AS sample_capped
        FROM (
          SELECT ready.concurrency_key,
                 policy.available_tokens < 1 OR keyed.available_tokens < 1 AS throttled,
                 keyed.available_tokens < 1 AS key_throttled,
                 CASE WHEN policy.available_tokens < 1 OR keyed.available_tokens < 1 THEN
                   GREATEST(
                     CASE WHEN policy.available_tokens < 1 THEN
                       policy.refill_baseline + make_interval(
                       secs => CEIL(
                         (1 - policy.available_tokens) * policy.rate_interval_ms::numeric
                         / policy.rate_limit::numeric
                       )::double precision / 1000
                     ) END,
                     CASE WHEN keyed.available_tokens < 1 THEN
                       keyed.refill_baseline + make_interval(
                       secs => CEIL(
                         (1 - keyed.available_tokens) * policy.per_key_interval_ms::numeric
                         / policy.per_key_limit::numeric
                       )::double precision / 1000
                     ) END
                   )
                 END AS eligible_at
            FROM (
              SELECT runtime.concurrency_key
                FROM workhorse.job_runtime runtime
               WHERE runtime.state = 'ready' AND runtime.queue_name = policy.queue_name
               ORDER BY runtime.sequence, runtime.job_id LIMIT 101
            ) ready
            CROSS JOIN LATERAL (
              SELECT CASE
                WHEN policy.per_key_limit IS NULL OR ready.concurrency_key IS NULL THEN 1
                ELSE LEAST(policy.per_key_burst::numeric, COALESCE(
                  bucket.tokens + GREATEST(
                    0::numeric,
                    extract(epoch FROM policy.now - bucket.refilled_at) * 1000
                  ) * policy.per_key_limit::numeric / policy.per_key_interval_ms::numeric,
                  policy.per_key_burst::numeric
                ))
              END AS available_tokens,
              CASE
                WHEN policy.per_key_limit IS NULL OR ready.concurrency_key IS NULL
                  THEN policy.now
                ELSE GREATEST(policy.now, COALESCE(bucket.refilled_at, policy.now))
              END AS refill_baseline
              FROM (SELECT true) present
              LEFT JOIN workhorse.rate_limit_bucket bucket
                ON bucket.queue_name = policy.queue_name
               AND bucket.bucket_scope = 'key'
               AND bucket.bucket_key = ready.concurrency_key
            ) keyed
        ) sample
    ) pressure
   ORDER BY policy.queue_name LIMIT 100`;

// One statement means one MVCC snapshot: every correctness-sensitive health value is read at the
// same instant, so counts, depths, watermarks, and policy pressure can never contradict each
// other. PostgreSQL planner/collector estimates deliberately stay out of this statement; they are
// observations rather than transactional facts and are gathered separately.
export const HEALTH_SNAPSHOT_SQL = `
  WITH installed AS (
    SELECT CASE
             WHEN count(*) = 1
              AND min(version) = max(version)
              AND NOT EXISTS (
                SELECT 1
                  FROM unnest(ARRAY['job_current', 'ready_job', 'scheduled_job', 'lease'])
                    AS legacy(relation_name)
                 WHERE to_regclass(format('workhorse.%I', relation_name)) IS NOT NULL
              )
             THEN min(version)::integer
             ELSE NULL
           END AS schema_version
      FROM workhorse.schema_version
  ), depth AS (
    ${totalDepthSelect([
      "blocked",
      "ready",
      "scheduled",
      "sleeping",
      "overdue_waits",
      "next_wake_at",
      "active",
      "expired",
      "oldest_ready_age_ms",
      "overdue_scheduled",
      "oldest_overdue_scheduled_age_ms",
      "pending_deadlines",
      "overdue_deadlines",
      "deadlines_due_within_minute",
      "earliest_deadline_at",
      "active_execution_timeouts",
      "overdue_execution_timeouts",
    ])}
  ), terminal AS (
    -- Terminal history is unbounded, so its counts stop scanning at the cap. Live-state counts
    -- come from depth and stay exact; claim-shaped work never pays for lifetime history here.
    SELECT count(*) FILTER (WHERE state = 'succeeded')::text AS succeeded_count,
           count(*) FILTER (WHERE state = 'failed')::text AS failed_count,
           count(*) FILTER (WHERE state = 'canceled')::text AS canceled_count,
           count(*) > ${HEALTH_HISTORY_SCAN_LIMIT} AS terminal_counts_capped
      FROM (SELECT state FROM workhorse.job_outcome LIMIT ${HEALTH_HISTORY_SCAN_LIMIT + 1})
        sampled_outcomes
  ), retention AS (
    -- The LIMIT 1 clauses on the singleton CTEs here and below are planner facts, not semantics:
    -- without them each CTE gets a default multi-hundred-row estimate, the cross joins multiply
    -- into a cost that trips JIT compilation, and compiling this statement costs a full second.
    WITH policy AS (
      SELECT * FROM workhorse.retention_policy WHERE singleton LIMIT 1
    ), boundaries AS (
      SELECT
        (SELECT job.created_at
           FROM workhorse.job job
           JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
          ORDER BY job.created_at, job.id LIMIT 1)
          AS oldest_job_identity_at,
        (SELECT finished_at FROM workhorse.job_outcome ORDER BY finished_at, job_id LIMIT 1)
          AS oldest_terminal_outcome_at,
        (SELECT job.created_at
           FROM workhorse.job job
           JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
          WHERE policy.job_identity_retention_days IS NOT NULL
            AND policy.terminal_outcome_retention_days IS NOT NULL
            AND job.created_at < clock_timestamp()
              - make_interval(days => policy.job_identity_retention_days)
            AND outcome.finished_at < clock_timestamp()
              - make_interval(days => policy.terminal_outcome_retention_days)
          ORDER BY job.created_at, job.id LIMIT 1)
          AS eligible_job_identity_at,
        (SELECT outcome.finished_at
           FROM workhorse.job job
           JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
          WHERE policy.job_identity_retention_days IS NOT NULL
            AND policy.terminal_outcome_retention_days IS NOT NULL
            AND job.created_at < clock_timestamp()
              - make_interval(days => policy.job_identity_retention_days)
            AND outcome.finished_at < clock_timestamp()
              - make_interval(days => policy.terminal_outcome_retention_days)
          ORDER BY outcome.finished_at, outcome.job_id LIMIT 1)
          AS eligible_terminal_outcome_at,
        (SELECT occurred_at FROM workhorse.job_event ORDER BY occurred_at, event_id LIMIT 1)
          AS oldest_job_event_at,
        (SELECT occurred_at FROM workhorse.job_event
          WHERE tableoid <> 'workhorse.job_event_default'::regclass
          ORDER BY occurred_at, event_id LIMIT 1) AS oldest_partitioned_job_event_at,
        (SELECT occurred_at FROM workhorse.job_event_default
          ORDER BY occurred_at, event_id LIMIT 1) AS oldest_default_job_event_at,
        (SELECT occurred_at FROM workhorse.attempt_history ORDER BY occurred_at, attempt_id LIMIT 1)
          AS oldest_attempt_history_at,
        (SELECT occurred_at FROM workhorse.attempt_history
          WHERE tableoid <> 'workhorse.attempt_history_default'::regclass
          ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_partitioned_attempt_history_at,
        (SELECT occurred_at FROM workhorse.attempt_history_default
          ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_default_attempt_history_at,
        (SELECT occurrence_at FROM workhorse.schedule_occurrence ORDER BY occurrence_at LIMIT 1)
          AS oldest_schedule_occurrence_at,
        (SELECT bucket_start FROM workhorse.job_stat_bucket ORDER BY bucket_start LIMIT 1)
          AS oldest_statistics_at
      FROM policy
    ), partitions AS (
      SELECT parent.relname AS parent_name,
             ((regexp_match(
               pg_get_expr(child.relpartbound, child.oid),
               'TO \\(''([^'']+)''\\)'
             ))[1])::timestamptz AS upper_bound
        FROM pg_inherits inheritance
        JOIN pg_class parent ON parent.oid = inheritance.inhparent
        JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
        JOIN pg_class child ON child.oid = inheritance.inhrelid
       WHERE namespace.nspname = 'workhorse'
         AND parent.relname IN ('job_event', 'attempt_history')
         AND child.relname <> parent.relname || '_default'
    ), eligible AS (
      SELECT
        count(*) FILTER (
          WHERE parent_name = 'job_event'
            AND policy.job_event_retention_days IS NOT NULL
            AND upper_bound <= clock_timestamp()
              - make_interval(days => policy.job_event_retention_days)
            AND upper_bound <= (
              date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            )
        )::text AS eligible_event_partitions,
        count(*) FILTER (
          WHERE parent_name = 'attempt_history'
            AND policy.attempt_history_retention_days IS NOT NULL
            AND upper_bound <= clock_timestamp()
              - make_interval(days => policy.attempt_history_retention_days)
            AND upper_bound <= (
              date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            )
        )::text AS eligible_attempt_partitions
      FROM partitions CROSS JOIN policy
    ), default_rows AS (
      SELECT event_rows::text AS default_event_rows,
             attempt_rows::text AS default_attempt_rows,
             event_rows > 10000 AS default_event_rows_capped,
             attempt_rows > 10000 AS default_attempt_rows_capped
        FROM (
          SELECT
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.job_event_default LIMIT 10001
            ) sampled_events) AS event_rows,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.attempt_history_default LIMIT 10001
            ) sampled_attempts) AS attempt_rows
        ) sampled
    )
    SELECT policy.*, boundaries.*,
           CASE WHEN policy.job_identity_retention_days IS NULL
                       OR boundaries.eligible_job_identity_at IS NULL THEN NULL
                ELSE GREATEST(0, extract(epoch FROM
                  clock_timestamp() - make_interval(days => policy.job_identity_retention_days)
                  - boundaries.eligible_job_identity_at) * 1000) END AS job_identity_lag_ms,
           CASE WHEN policy.terminal_outcome_retention_days IS NULL
                       OR boundaries.eligible_terminal_outcome_at IS NULL THEN NULL
                ELSE GREATEST(0, extract(epoch FROM
                  clock_timestamp() - make_interval(days => policy.terminal_outcome_retention_days)
                  - boundaries.eligible_terminal_outcome_at) * 1000) END AS terminal_outcome_lag_ms,
           CASE WHEN policy.job_event_retention_days IS NULL
                       OR boundaries.oldest_job_event_at IS NULL THEN NULL
                ELSE GREATEST(
                  0,
                  COALESCE(extract(epoch FROM
                    date_trunc(
                      'day',
                      (clock_timestamp() - make_interval(
                        days => policy.job_event_retention_days
                      )) AT TIME ZONE 'UTC'
                    ) AT TIME ZONE 'UTC'
                    - boundaries.oldest_partitioned_job_event_at) * 1000, 0),
                  COALESCE(extract(epoch FROM
                    clock_timestamp() - make_interval(days => policy.job_event_retention_days)
                    - boundaries.oldest_default_job_event_at) * 1000, 0)
                ) END AS job_event_lag_ms,
           CASE WHEN policy.attempt_history_retention_days IS NULL
                       OR boundaries.oldest_attempt_history_at IS NULL THEN NULL
                ELSE GREATEST(
                  0,
                  COALESCE(extract(epoch FROM
                    date_trunc(
                      'day',
                      (clock_timestamp() - make_interval(
                        days => policy.attempt_history_retention_days
                      )) AT TIME ZONE 'UTC'
                    ) AT TIME ZONE 'UTC'
                    - boundaries.oldest_partitioned_attempt_history_at) * 1000, 0),
                  COALESCE(extract(epoch FROM
                    clock_timestamp()
                    - make_interval(days => policy.attempt_history_retention_days)
                    - boundaries.oldest_default_attempt_history_at) * 1000, 0)
                ) END AS attempt_history_lag_ms,
           CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                       OR boundaries.oldest_schedule_occurrence_at IS NULL THEN NULL
                ELSE GREATEST(0, extract(epoch FROM
                  clock_timestamp()
                  - make_interval(days => policy.schedule_occurrence_retention_days)
                  - boundaries.oldest_schedule_occurrence_at) * 1000) END
             AS schedule_occurrence_lag_ms,
           CASE WHEN policy.statistics_retention_days IS NULL
                  OR boundaries.oldest_statistics_at IS NULL THEN NULL
                ELSE GREATEST(0, extract(epoch FROM
                  clock_timestamp()
                  - make_interval(days => policy.statistics_retention_days)
                  - boundaries.oldest_statistics_at) * 1000) END
             AS statistics_lag_ms,
           eligible.*, default_rows.*
      FROM policy CROSS JOIN boundaries CROSS JOIN eligible CROSS JOIN default_rows
  ), rollup AS (
    SELECT state.rolled_up_through,
           GREATEST(0, extract(epoch FROM clock_timestamp() - state.rolled_up_through) * 1000)
             AS rollup_lag_ms,
           state.last_run_at,
           bucket_sample.buckets::text AS buckets,
           bucket_sample.buckets_capped,
           (SELECT max(bucket_start) FROM workhorse.job_stat_bucket) AS newest_bucket_at
      FROM workhorse.job_stat_state state
      CROSS JOIN LATERAL (
        SELECT count(*) AS buckets, count(*) > ${HEALTH_HISTORY_SCAN_LIMIT} AS buckets_capped
          FROM (SELECT 1 FROM workhorse.job_stat_bucket LIMIT ${HEALTH_HISTORY_SCAN_LIMIT + 1})
            sampled_buckets
      ) bucket_sample
     WHERE state.singleton
     LIMIT 1
  ), concurrency AS (
    WITH policies AS MATERIALIZED (
      SELECT policy.*
        FROM workhorse.concurrency_policy policy
       ORDER BY policy.queue_name
       LIMIT 101
    )
    SELECT policy.namespace, policy.queue_name, policy.max_active,
           policy.max_active_per_key,
           usage.active::text,
           blocked.blocked_ready::text,
           usage.saturated_keys::text,
           usage.highest_key_active::text,
           (SELECT count(*) FROM policies) > 100 OR blocked.sample_capped AS capped
      FROM policies policy
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(keyed.key_active), 0)::integer AS active,
               count(*) FILTER (
                 WHERE policy.max_active_per_key IS NOT NULL
                   AND keyed.concurrency_key IS NOT NULL
                   AND keyed.key_active >= policy.max_active_per_key
               )::integer AS saturated_keys,
               COALESCE(max(keyed.key_active) FILTER (
                 WHERE keyed.concurrency_key IS NOT NULL
               ), 0)::integer AS highest_key_active
          FROM (
            SELECT active.concurrency_key, count(*)::integer AS key_active
              FROM workhorse.job_runtime active
             WHERE active.state = 'active'
               AND active.queue_name = policy.queue_name
               AND active.expires_at > clock_timestamp()
             GROUP BY active.concurrency_key
          ) keyed
      ) usage
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (
                 WHERE usage.active >= policy.max_active
                    OR (
                      policy.max_active_per_key IS NOT NULL
                      AND sample.concurrency_key IS NOT NULL
                      AND COALESCE(sample.key_active, 0) >= policy.max_active_per_key
                    )
               )::integer AS blocked_ready,
               count(*) > 100 AS sample_capped
          FROM (
            SELECT ready.concurrency_key,
                   (SELECT count(*)::integer
                      FROM workhorse.job_runtime active
                     WHERE active.state = 'active'
                       AND active.queue_name = policy.queue_name
                       AND active.concurrency_key = ready.concurrency_key
                       AND active.expires_at > clock_timestamp()) AS key_active
              FROM workhorse.job_runtime ready
             WHERE ready.state = 'ready' AND ready.queue_name = policy.queue_name
             ORDER BY ready.sequence, ready.job_id
             LIMIT 101
          ) sample
      ) blocked
     ORDER BY policy.queue_name
     LIMIT 100
  ), rate_limits AS (${RATE_LIMIT_STATUS_SQL}
  ), partition_days AS (
    SELECT to_char(day_start, 'YYYYMMDD') AS day, day_start AS starts_at,
           to_regclass(format('workhorse.%I', 'job_event_' || to_char(day_start, 'YYYYMMDD')))
             IS NOT NULL AS has_job_events,
           to_regclass(format('workhorse.%I', 'attempt_history_' || to_char(day_start, 'YYYYMMDD')))
             IS NOT NULL AS has_attempt_history
      FROM generate_series(
        date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC'),
        date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') + interval '3 days',
        interval '1 day'
      ) day_start
  )
  SELECT now() AS captured_at,
         installed.schema_version,
         depth.*, terminal.*, retention.*, rollup.*,
         (SELECT COALESCE(jsonb_agg(to_jsonb(c.*) ORDER BY c.queue_name), '[]'::jsonb)
            FROM concurrency c) AS concurrency_policies,
         (SELECT COALESCE(jsonb_agg(to_jsonb(r.*) ORDER BY r.queue_name), '[]'::jsonb)
            FROM rate_limits r) AS rate_limit_policies,
         (SELECT jsonb_agg(to_jsonb(p.*) ORDER BY p.starts_at)
            FROM partition_days p) AS history_partition_days
    FROM installed
    CROSS JOIN depth
    CROSS JOIN terminal
    CROSS JOIN retention
    CROSS JOIN rollup`;
