import { DEPENDENCY_OPERATIONS_SCAN_LIMIT } from "../types.js";

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

/** Build the bounded child-orchestration samples shared by global health and per-queue metrics. */
export function childPressureSamplesSql(queueNameExpression?: string): string {
  const parentJoin = queueNameExpression
    ? "JOIN workhorse.job_query parent ON parent.job_id = edge.parent_job_id"
    : "";
  const outcomeParentJoin = queueNameExpression
    ? "JOIN workhorse.job_query parent ON parent.job_id = outcome.job_id"
    : "";
  const runtimeQueue = queueNameExpression
    ? `runtime.queue_name = ${queueNameExpression} AND `
    : "";
  const parentQueue = queueNameExpression ? `parent.queue_name = ${queueNameExpression} AND ` : "";
  return `
    SELECT
      (SELECT count(*) FROM (
        SELECT 1 FROM workhorse.job_runtime runtime
         WHERE ${runtimeQueue}runtime.state = 'blocked'
           AND EXISTS (
             SELECT 1 FROM workhorse.job_child edge WHERE edge.parent_job_id = runtime.job_id
           )
         LIMIT ${DEPENDENCY_OPERATIONS_SCAN_LIMIT + 1}
      ) sampled_waiting) AS waiting_parents,
      (SELECT count(*) FROM (
        SELECT 1 FROM workhorse.job_child edge
        ${parentJoin}
         WHERE ${parentQueue}edge.joined_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM workhorse.job_outcome outcome WHERE outcome.job_id = edge.child_job_id
           )
         LIMIT ${DEPENDENCY_OPERATIONS_SCAN_LIMIT + 1}
      ) sampled_pending) AS pending_children,
      (SELECT count(*) FROM (
        SELECT 1 FROM workhorse.job_child edge
        ${parentJoin}
         JOIN workhorse.job_outcome outcome ON outcome.job_id = edge.child_job_id
        WHERE ${parentQueue}edge.joined_at IS NULL AND outcome.state = 'succeeded'
         LIMIT ${DEPENDENCY_OPERATIONS_SCAN_LIMIT + 1}
      ) sampled_unjoined) AS unjoined_results,
      (SELECT count(*) FROM (
        SELECT 1 FROM workhorse.job_outcome outcome
        ${outcomeParentJoin}
         WHERE ${parentQueue}outcome.state = 'failed'
           AND outcome.error->>'name' = 'DependencyFailed'
           AND EXISTS (
             SELECT 1 FROM workhorse.job_child edge WHERE edge.parent_job_id = outcome.job_id
           )
         LIMIT ${DEPENDENCY_OPERATIONS_SCAN_LIMIT + 1}
      ) sampled_failed) AS failed_parents,
      (SELECT count(*) FROM (
        SELECT 1 FROM workhorse.job_outcome outcome
        ${outcomeParentJoin}
         WHERE ${parentQueue}outcome.state = 'canceled'
           AND outcome.error->>'name' = 'DependencyCanceled'
           AND EXISTS (
             SELECT 1 FROM workhorse.job_child edge WHERE edge.parent_job_id = outcome.job_id
           )
         LIMIT ${DEPENDENCY_OPERATIONS_SCAN_LIMIT + 1}
      ) sampled_canceled) AS canceled_parents`;
}

/** Project capped child-orchestration samples into the shared health and metric columns. */
export function childPressureProjectionSql(sourceAlias: string): string {
  return `LEAST(${sourceAlias}.waiting_parents, ${DEPENDENCY_OPERATIONS_SCAN_LIMIT})::text
             AS child_waiting_parents,
           LEAST(${sourceAlias}.pending_children, ${DEPENDENCY_OPERATIONS_SCAN_LIMIT})::text
             AS child_pending_children,
           LEAST(${sourceAlias}.unjoined_results, ${DEPENDENCY_OPERATIONS_SCAN_LIMIT})::text
             AS child_unjoined_results,
           LEAST(${sourceAlias}.failed_parents, ${DEPENDENCY_OPERATIONS_SCAN_LIMIT})::text
             AS child_failed_parents,
           LEAST(${sourceAlias}.canceled_parents, ${DEPENDENCY_OPERATIONS_SCAN_LIMIT})::text
             AS child_canceled_parents,
           ${sourceAlias}.waiting_parents > ${DEPENDENCY_OPERATIONS_SCAN_LIMIT}
             OR ${sourceAlias}.pending_children > ${DEPENDENCY_OPERATIONS_SCAN_LIMIT}
             OR ${sourceAlias}.unjoined_results > ${DEPENDENCY_OPERATIONS_SCAN_LIMIT}
             OR ${sourceAlias}.failed_parents > ${DEPENDENCY_OPERATIONS_SCAN_LIMIT}
             OR ${sourceAlias}.canceled_parents > ${DEPENDENCY_OPERATIONS_SCAN_LIMIT}
             AS child_counts_capped`;
}
