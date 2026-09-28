-- workhorse-migration: {"kind":"additive"}

-- Shard the admission counters so policy claims on one queue stop serializing (SM-932).

-- A claim on a queue with a concurrency or rate-limit policy locked the policy rows and the one
-- queue rate bucket for its whole transaction. Every claim on that queue waited for the one before
-- it, so a policy queue could not start tasks faster than one claim transaction at a time.
--
-- This step splits the queue-wide counters into admission shards (ADR 0082). A queue with a
-- queue-wide rule and no per-key rule gets up to 8 shards. Each shard owns an equal share of
-- max_active and of the queue rate bucket, and one advisory lock per shard serializes the claims
-- that write it. A claim holds the policy locks in share mode, takes the shards it can get without
-- waiting, and admits only against their room. When the held shards cannot fill the batch, it may
-- borrow room from shards it does not hold, but only as far as the whole queue's count allows, so
-- max_active and the rate cap still hold exactly across shards. A synchronization that changes a
-- policy rebalances the queue's shards under every shard lock and conserves its tokens.
--
-- task_runtime gains admission_shard, the shard an active lease counts against. A lease taken before
-- this step has none and counts against shard 0. Each queue rate bucket is copied into shard 0 of its
-- queue and then spread over the queue's shards. No function reads the old queue bucket row after
-- this step, and it stays in rate_limit_bucket until its policy is deleted. Per-key buckets stay in
-- rate_limit_bucket.
--
-- claim_policy_batch_v1 is new. claim_many_v1 and claim_one_v1 claim a full-tier queue through it.
-- The concurrency capacity notification, both policy synchronizations and queue_health_v1 read the
-- shards. Every signature, result shape and event is unchanged, and fence issuance is unchanged.
-- Replacing claim_many_v1 restates its plan_cache_mode setting.

ALTER TABLE workhorse.task_runtime ADD COLUMN IF NOT EXISTS admission_shard smallint;


-- The queue-wide admission counters, split into shards so policy claims on one queue stop
-- serializing on one row (ADR 0082). A queue with a concurrency or rate-limit policy has one row per
-- shard, numbered from zero. Each shard owns an equal share of max_active and of the queue rate
-- bucket, and a claim that holds a shard's advisory lock is the only writer of that shard's
-- capacity. Null tokens mean the shard's bucket is full. rebalance_admission_shards_v1 sets the
-- shard count and conserves the queue's tokens when a policy changes.
CREATE TABLE IF NOT EXISTS workhorse.admission_shard (
  queue_name text NOT NULL,
  shard smallint NOT NULL CHECK (shard >= 0),
  tokens numeric CHECK (tokens >= 0),
  refilled_at timestamptz NOT NULL,
  PRIMARY KEY (queue_name, shard)
);

-- One shard's share of a queue-wide total. The shares of shards 0 to p_shards - 1 sum to p_total,
-- and the lower shards take the remainder.
CREATE OR REPLACE FUNCTION workhorse.admission_share_v1(
  p_total integer,
  p_shards integer,
  p_shard integer
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_total / p_shards + (p_shard < p_total % p_shards)::integer
$$;

-- The number of admission shards a queue's policies allow. A queue with no queue-wide rule has
-- none. A per-key rule counts across the whole queue, so a queue with one keeps a single shard. Any
-- other queue has at most 8 shards, and never more than max_active or the rate burst, so every
-- shard's share is at least one.
CREATE OR REPLACE FUNCTION workhorse.admission_shard_count_v1(
  p_max_active integer,
  p_max_active_per_key integer,
  p_rate_burst integer,
  p_per_key_limit integer
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_max_active IS NULL AND p_rate_burst IS NULL THEN 0
    WHEN p_max_active_per_key IS NOT NULL OR p_per_key_limit IS NOT NULL THEN 1
    ELSE LEAST(8, p_max_active, p_rate_burst)
  END
$$;

-- Give a queue the shard rows its current policies allow. The function takes the queue's
-- rebalance lock and then every shard lock in shard order, waiting for each, so no claim holds a
-- shard while the rows change. It refills the stored shards to p_now, sums their tokens, and spreads
-- that sum over the new shards by share. A queue whose stored rows are missing or hold a full shard
-- starts full. The sum never exceeds the burst, so a rebalance never creates capacity. It keeps the
-- latest refill time, so refill never runs from a clock ahead of an earlier charge.
CREATE OR REPLACE FUNCTION workhorse.rebalance_admission_shards_v1(
  p_queue_name text,
  p_now timestamptz
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_shards integer;
  v_stored integer;
  v_refilled_at timestamptz;
  v_any_full boolean;
  v_total numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:admission-shards:' || p_queue_name, 0));
  FOR v_shard IN 0..7 LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_shard, 0)
    );
  END LOOP;
  SELECT policy.* INTO v_policy
    FROM workhorse.concurrency_policy policy WHERE policy.queue_name = p_queue_name;
  SELECT policy.* INTO v_rate_policy
    FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = p_queue_name;
  v_shards := workhorse.admission_shard_count_v1(
    v_policy.max_active, v_policy.max_active_per_key, v_rate_policy.rate_burst,
    v_rate_policy.per_key_limit
  );
  SELECT count(*)::integer, max(stored.refilled_at), COALESCE(bool_or(stored.tokens IS NULL), false)
    INTO v_stored, v_refilled_at, v_any_full
    FROM workhorse.admission_shard stored
   WHERE stored.queue_name = p_queue_name;
  IF v_rate_policy.queue_name IS NULL THEN
    v_total := NULL;
  ELSIF v_stored = 0 OR v_any_full THEN
    v_total := v_rate_policy.rate_burst;
  ELSE
    SELECT LEAST(v_rate_policy.rate_burst::numeric, sum(LEAST(
             refilled.share::numeric,
             refilled.tokens + GREATEST(
               0::numeric,
               extract(epoch FROM p_now - refilled.refilled_at) * 1000
             ) * v_rate_policy.rate_limit::numeric * refilled.share
               / (v_rate_policy.rate_interval_ms::numeric * v_rate_policy.rate_burst)
           )))
      INTO v_total
      FROM (
        SELECT stored.tokens, stored.refilled_at,
               workhorse.admission_share_v1(
                 v_rate_policy.rate_burst, v_stored,
                 (row_number() OVER (ORDER BY stored.shard))::integer - 1
               ) AS share
          FROM workhorse.admission_shard stored
         WHERE stored.queue_name = p_queue_name
      ) refilled;
  END IF;
  DELETE FROM workhorse.admission_shard stored WHERE stored.queue_name = p_queue_name;
  IF v_shards > 0 THEN
    INSERT INTO workhorse.admission_shard(queue_name, shard, tokens, refilled_at)
    SELECT p_queue_name, slot.shard,
           v_total * workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)
             / v_rate_policy.rate_burst,
           GREATEST(p_now, COALESCE(v_refilled_at, p_now))
      FROM generate_series(0, v_shards - 1) AS slot(shard);
  END IF;
END;
$$;

-- Copy each queue rate bucket into shard 0 of its queue, then give every policy queue the shards
-- its policies allow. The rebalance refills the moved bucket to now and spreads its tokens.
INSERT INTO workhorse.admission_shard(queue_name, shard, tokens, refilled_at)
SELECT bucket.queue_name, 0, bucket.tokens, bucket.refilled_at
  FROM workhorse.rate_limit_bucket bucket
 WHERE bucket.bucket_scope = 'queue'
ON CONFLICT (queue_name, shard) DO NOTHING;

SELECT workhorse.rebalance_admission_shards_v1(policy.queue_name, clock_timestamp())
  FROM (
    SELECT concurrency.queue_name FROM workhorse.concurrency_policy concurrency
    UNION
    SELECT rate.queue_name FROM workhorse.rate_limit_policy rate
  ) policy
 ORDER BY policy.queue_name;

-- Wake a worker when a release can unblock a claim that a concurrency cap held back. A claim
-- admits only against the admission shards it holds (ADR 0082), so a release frees room in the
-- shard its lease counted against.
CREATE OR REPLACE FUNCTION workhorse.notify_concurrency_capacity_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_shards integer;
  v_shard integer;
  v_share integer;
BEGIN
  IF OLD.state <> 'active' OR (TG_OP <> 'DELETE' AND NEW.state = 'active') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT * INTO v_policy FROM workhorse.concurrency_policy policy
   WHERE policy.queue_name = OLD.queue_name;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT * INTO v_rate_policy FROM workhorse.rate_limit_policy policy
   WHERE policy.queue_name = OLD.queue_name;
  v_shards := workhorse.admission_shard_count_v1(
    v_policy.max_active, v_policy.max_active_per_key, v_rate_policy.rate_burst,
    v_rate_policy.per_key_limit
  );
  v_shard := COALESCE(OLD.admission_shard, 0) % v_shards;
  v_share := workhorse.admission_share_v1(v_policy.max_active, v_shards, v_shard);
  -- A claim holds its shard's lock until it commits. A claim that is still open may have filled
  -- this shard, and the count below cannot see its leases. This release therefore notifies unless
  -- it can hold the shard in share mode at once. It never waits, and a claim that wants the shard
  -- after this point waits for this release to commit and then sees it.
  IF NOT pg_try_advisory_xact_lock_shared(
    hashtextextended('workhorse:admission-shard:' || OLD.queue_name || ':' || v_shard, 0)
  ) THEN
    PERFORM pg_notify('workhorse_tasks', OLD.queue_name);
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- A synchronization can change the shard count between the first read and the lock. The shard
  -- this release computed may then not be the one a claim counts it in, so the release notifies.
  SELECT * INTO v_policy FROM workhorse.concurrency_policy policy
   WHERE policy.queue_name = OLD.queue_name;
  SELECT * INTO v_rate_policy FROM workhorse.rate_limit_policy policy
   WHERE policy.queue_name = OLD.queue_name;
  IF v_policy.queue_name IS NULL OR workhorse.admission_shard_count_v1(
       v_policy.max_active, v_policy.max_active_per_key, v_rate_policy.rate_burst,
       v_rate_policy.per_key_limit
     ) <> v_shards THEN
    PERFORM pg_notify('workhorse_tasks', OLD.queue_name);
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- Only a release from a full shard, queue, or key can unblock a waiting claim. Every other release
  -- would wake a worker that no cap held back, and a woken worker delays its claim. This runs before
  -- the row changes, so the first row a statement releases from a full shard still counts itself. A
  -- concurrent release that has not committed still counts as active, so it cannot hide the cap.
  -- A claim counts only unexpired leases, but this count includes expired ones. It therefore counts
  -- every lease a claim may have counted when it found the shard full: a lease that expired after
  -- that claim must not hide the cap from this release.
  IF (SELECT count(*) FROM (
        SELECT 1 FROM workhorse.task_runtime active
         WHERE active.queue_name = OLD.queue_name AND active.state = 'active'
           AND COALESCE(active.admission_shard, 0) % v_shards = v_shard
         LIMIT v_share
      ) capped) = v_share
     OR (SELECT count(*) FROM (
           SELECT 1 FROM workhorse.task_runtime active
            WHERE active.queue_name = OLD.queue_name AND active.state = 'active'
            LIMIT v_policy.max_active
         ) capped) = v_policy.max_active
     OR (
       v_policy.max_active_per_key IS NOT NULL AND OLD.concurrency_key IS NOT NULL
       AND (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_runtime active
               WHERE active.queue_name = OLD.queue_name
                 AND active.concurrency_key = OLD.concurrency_key
                 AND active.state = 'active'
               LIMIT v_policy.max_active_per_key
            ) capped) = v_policy.max_active_per_key
     ) THEN
    PERFORM pg_notify('workhorse_tasks', OLD.queue_name);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.queue_health_v1(
  p_rejected_since timestamptz DEFAULT clock_timestamp() - interval '1 day'
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET jit = off
AS $$
DECLARE
  v_document jsonb;
  v_observations jsonb;
BEGIN
  SELECT to_jsonb(snapshot) || jsonb_build_object(
           'status', workhorse.evaluate_queue_health_v1(to_jsonb(snapshot), to_jsonb(policy)),
           'budgets', jsonb_build_object(
             'promotionLagMs', policy.promotion_lag_ms,
             'rollupStalledLagMs', policy.rollup_stalled_lag_ms,
             'rowRetentionLagMs', policy.row_retention_lag_ms,
             'partitionRetentionLagMs', policy.partition_retention_lag_ms,
             'eligibleHistoryPartitions', policy.eligible_history_partitions
           )
         )
    INTO v_document
    FROM (
      WITH installed AS (
          SELECT CASE
                   WHEN count(*) = 1
                    AND min(version) = max(version)
                    AND NOT EXISTS (
                      SELECT 1
                        FROM unnest(ARRAY['task_current', 'ready_task', 'scheduled_task', 'lease'])
                          AS legacy(relation_name)
                       WHERE to_regclass(format('workhorse.%I', relation_name)) IS NOT NULL
                    )
                   THEN min(version)::integer
                   ELSE NULL
                 END AS schema_version
            FROM workhorse.schema_version
        ), depth AS (
          SELECT count(runtime.task_id) FILTER (WHERE runtime.state = 'blocked')::text AS blocked,
               count(runtime.task_id) FILTER (WHERE runtime.state = 'ready')::text AS ready,
               count(runtime.task_id) FILTER (WHERE runtime.state = 'scheduled')::text AS scheduled,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.wait_name IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM workhorse.task_wait timer
                  WHERE timer.task_id = runtime.task_id AND timer.wait_name = runtime.wait_name
               )
           )::text AS sleeping,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.wait_name IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM workhorse.task_wait timer
                  WHERE timer.task_id = runtime.task_id AND timer.wait_name = runtime.wait_name
               )
               AND runtime.run_at <= clock_timestamp()
           )::text AS overdue_waits,
               min(runtime.run_at) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.wait_name IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM workhorse.task_wait timer
                  WHERE timer.task_id = runtime.task_id AND timer.wait_name = runtime.wait_name
               )
           ) AS next_wake_at,
               count(runtime.task_id) FILTER (WHERE runtime.state = 'active')::text AS active,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'active' AND runtime.expires_at <= clock_timestamp()
           )::text AS expired,
               extract(epoch FROM clock_timestamp() - min(runtime.ready_at) FILTER (
             WHERE runtime.state = 'ready'
           )) * 1000 AS oldest_ready_age_ms,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.run_at <= clock_timestamp()
           )::text AS overdue_scheduled,
               extract(epoch FROM clock_timestamp() - min(runtime.run_at) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.run_at <= clock_timestamp()
           )) * 1000 AS oldest_overdue_scheduled_age_ms,
               count(runtime.task_id) FILTER (WHERE runtime.deadline_at IS NOT NULL)::text AS pending_deadlines,
               count(runtime.task_id) FILTER (
             WHERE runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= clock_timestamp()
           )::text AS overdue_deadlines,
               count(runtime.task_id) FILTER (
             WHERE runtime.deadline_at > clock_timestamp()
               AND runtime.deadline_at <= clock_timestamp() + interval '1 minute'
           )::text AS deadlines_due_within_minute,
               min(runtime.deadline_at) AS earliest_deadline_at,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'active' AND runtime.attempt_timeout_at IS NOT NULL
           )::text AS active_execution_timeouts,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'active' AND runtime.attempt_timeout_at <= clock_timestamp()
           )::text AS overdue_execution_timeouts
            FROM (
              SELECT task_id, state, run_at, ready_at, wait_name, expires_at, deadline_at,
                     attempt_timeout_at
                FROM workhorse.task_runtime
              UNION ALL
              -- A fast-tier row has no scheduled state; a ready row with a future run time is one.
              SELECT task_id,
                     CASE WHEN state = 'ready' AND run_at > clock_timestamp() THEN 'scheduled'
                          ELSE state END,
                     run_at, CASE WHEN state = 'ready' THEN run_at END, NULL::text, expires_at,
                     deadline_at, attempt_timeout_at
                FROM workhorse.fast_task_runtime
            ) runtime
        ), terminal AS (
          -- Terminal history is unbounded, so its counts stop scanning at the cap. Live-state counts
          -- come from depth and stay exact; claim-shaped work never pays for lifetime history here.
          SELECT count(*) FILTER (WHERE state = 'succeeded')::text AS succeeded_count,
                 count(*) FILTER (WHERE state = 'failed')::text AS failed_count,
                 count(*) FILTER (WHERE state = 'canceled')::text AS canceled_count,
                 count(*) > 100000 AS terminal_counts_capped
            FROM (
              SELECT state FROM workhorse.task_outcome
              UNION ALL
              SELECT state FROM workhorse.fast_task_outcome
              LIMIT 100001
            ) sampled_outcomes
        ), retention AS (
          -- The LIMIT 1 clauses on the singleton CTEs here and below are planner facts, not semantics:
          -- without them each CTE gets a default multi-hundred-row estimate, the cross joins multiply
          -- into a cost that trips JIT compilation, and compiling this statement costs a full second.
          WITH policy AS (
            SELECT * FROM workhorse.retention_policy WHERE singleton LIMIT 1
          ), terminal_outcome AS NOT MATERIALIZED (
            -- A fast-tier outcome has no history boundary of its own. Its history rows, if the queue
            -- recorded any, end when it finished.
            SELECT task_id, finished_at, history_through_at FROM workhorse.task_outcome
            UNION ALL
            SELECT task_id, finished_at, finished_at FROM workhorse.fast_task_outcome
          ), boundaries AS (
            SELECT
              (SELECT task.created_at
                 FROM workhorse.task task
                 JOIN terminal_outcome outcome ON outcome.task_id = task.id
                ORDER BY task.created_at, task.id LIMIT 1)
                AS oldest_task_identity_at,
              (SELECT finished_at FROM terminal_outcome ORDER BY finished_at, task_id LIMIT 1)
                AS oldest_terminal_outcome_at,
              -- A row counts as eligible only once workhorse.prune_terminal_tasks_v1 could delete it.
              -- That prune also waits until daily history retention has passed the row's history, so
              -- a row held only by that gate is waiting on history retention, not lagging here.
              (SELECT task.created_at
                 FROM workhorse.task task
                 JOIN terminal_outcome outcome ON outcome.task_id = task.id
                WHERE policy.task_identity_retention_days IS NOT NULL
                  AND policy.terminal_outcome_retention_days IS NOT NULL
                  AND task.created_at < clock_timestamp()
                    - make_interval(days => policy.task_identity_retention_days)
                  AND outcome.finished_at < clock_timestamp()
                    - make_interval(days => policy.terminal_outcome_retention_days)
                  AND outcome.history_through_at < (
                    SELECT history_retained_before FROM workhorse.maintenance_state
                     WHERE routine_name = 'history_retention'
                  )
                ORDER BY task.created_at, task.id LIMIT 1)
                AS eligible_task_identity_at,
              (SELECT outcome.finished_at
                 FROM workhorse.task task
                 JOIN terminal_outcome outcome ON outcome.task_id = task.id
                WHERE policy.task_identity_retention_days IS NOT NULL
                  AND policy.terminal_outcome_retention_days IS NOT NULL
                  AND task.created_at < clock_timestamp()
                    - make_interval(days => policy.task_identity_retention_days)
                  AND outcome.finished_at < clock_timestamp()
                    - make_interval(days => policy.terminal_outcome_retention_days)
                  AND outcome.history_through_at < (
                    SELECT history_retained_before FROM workhorse.maintenance_state
                     WHERE routine_name = 'history_retention'
                  )
                ORDER BY outcome.finished_at, outcome.task_id LIMIT 1)
                AS eligible_terminal_outcome_at,
              (SELECT occurred_at FROM workhorse.task_event ORDER BY occurred_at, event_id LIMIT 1)
                AS oldest_task_event_at,
              (SELECT occurred_at FROM workhorse.task_event
                WHERE tableoid <> 'workhorse.task_event_default'::regclass
                ORDER BY occurred_at, event_id LIMIT 1) AS oldest_partitioned_task_event_at,
              (SELECT occurred_at FROM workhorse.task_event_default
                ORDER BY occurred_at, event_id LIMIT 1) AS oldest_default_task_event_at,
              (SELECT occurred_at FROM workhorse.attempt_history ORDER BY occurred_at, attempt_id LIMIT 1)
                AS oldest_attempt_history_at,
              (SELECT occurred_at FROM workhorse.attempt_history
                WHERE tableoid <> 'workhorse.attempt_history_default'::regclass
                ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_partitioned_attempt_history_at,
              (SELECT occurred_at FROM workhorse.attempt_history_default
                ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_default_attempt_history_at,
              (SELECT occurrence_at FROM workhorse.schedule_occurrence ORDER BY occurrence_at LIMIT 1)
                AS oldest_schedule_occurrence_at,
              (SELECT min(bucket_start) FROM (
                 SELECT bucket_start FROM workhorse.task_stat_bucket
                 UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_hour
                 UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_day
               ) statistic_tiers) AS oldest_statistics_at
            FROM policy
          ), partitions AS (
            SELECT parent.relname AS parent_name,
                   ((regexp_match(
                     pg_get_expr(child.relpartbound, child.oid),
                     'TO \(''([^'']+)''\)'
                   ))[1])::timestamptz AS upper_bound
              FROM pg_inherits inheritance
              JOIN pg_class parent ON parent.oid = inheritance.inhparent
              JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
              JOIN pg_class child ON child.oid = inheritance.inhrelid
             WHERE namespace.nspname = 'workhorse'
               AND parent.relname IN ('task_event', 'attempt_history')
               AND child.relname <> parent.relname || '_default'
          ), eligible AS (
            SELECT
              count(*) FILTER (
                WHERE parent_name = 'task_event'
                  AND policy.task_event_retention_days IS NOT NULL
                  AND upper_bound <= clock_timestamp()
                    - make_interval(days => policy.task_event_retention_days)
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
                    SELECT 1 FROM workhorse.task_event_default LIMIT 10001
                  ) sampled_events) AS event_rows,
                  (SELECT count(*) FROM (
                    SELECT 1 FROM workhorse.attempt_history_default LIMIT 10001
                  ) sampled_attempts) AS attempt_rows
              ) sampled
          )
          SELECT policy.*, boundaries.*,
                 CASE WHEN policy.task_identity_retention_days IS NULL
                             OR boundaries.eligible_task_identity_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp() - make_interval(days => policy.task_identity_retention_days)
                        - boundaries.eligible_task_identity_at) * 1000) END AS task_identity_lag_ms,
                 CASE WHEN policy.terminal_outcome_retention_days IS NULL
                             OR boundaries.eligible_terminal_outcome_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp() - make_interval(days => policy.terminal_outcome_retention_days)
                        - boundaries.eligible_terminal_outcome_at) * 1000) END AS terminal_outcome_lag_ms,
                 CASE WHEN policy.task_event_retention_days IS NULL
                             OR boundaries.oldest_task_event_at IS NULL THEN NULL
                      ELSE GREATEST(
                        0,
                        COALESCE(extract(epoch FROM
                          date_trunc(
                            'day',
                            (clock_timestamp() - make_interval(
                              days => policy.task_event_retention_days
                            )) AT TIME ZONE 'UTC'
                          ) AT TIME ZONE 'UTC'
                          - boundaries.oldest_partitioned_task_event_at) * 1000, 0),
                        COALESCE(extract(epoch FROM
                          clock_timestamp() - make_interval(days => policy.task_event_retention_days)
                          - boundaries.oldest_default_task_event_at) * 1000, 0)
                      ) END AS task_event_lag_ms,
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
        ), dependencies AS (
          SELECT LEAST(blocked_tasks, 10000)::text
                   AS dependency_blocked_tasks,
                 LEAST(pending_edges, 10000)::text
                   AS dependency_pending_edges,
                 LEAST(failed_resolutions, 10000)::text
                   AS dependency_failed_resolutions,
                 (SELECT terminal_prune_dependency_starved
                    FROM workhorse.maintenance_state
                   WHERE routine_name = 'terminal_storage') AS dependency_retention_prune_starved,
                 blocked_tasks > 10000
                   OR pending_edges > 10000
                   OR failed_resolutions > 10000
                   AS dependency_counts_capped
            FROM (
              SELECT
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.task_runtime WHERE state = 'blocked'
                   LIMIT 10001
                ) sampled_blocked) AS blocked_tasks,
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.task_dependency WHERE released_at IS NULL
                   LIMIT 10001
                ) sampled_pending) AS pending_edges,
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.task_outcome
                   WHERE state = 'failed' AND error->>'name' = 'DependencyFailed'
                   LIMIT 10001
                ) sampled_failed) AS failed_resolutions
            ) samples
        ), children AS (
          SELECT LEAST(samples.waiting_parents, 10000)::text
                   AS child_waiting_parents,
                 LEAST(samples.pending_children, 10000)::text
                   AS child_pending_children,
                 LEAST(samples.unjoined_results, 10000)::text
                   AS child_unjoined_results,
                 LEAST(samples.failed_parents, 10000)::text
                   AS child_failed_parents,
                 LEAST(samples.canceled_parents, 10000)::text
                   AS child_canceled_parents,
                 samples.waiting_parents > 10000
                   OR samples.pending_children > 10000
                   OR samples.unjoined_results > 10000
                   OR samples.failed_parents > 10000
                   OR samples.canceled_parents > 10000
                   AS child_counts_capped
            FROM (
          SELECT
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_runtime runtime
               WHERE runtime.state = 'blocked'
                 AND EXISTS (
                   SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = runtime.task_id
                 )
               LIMIT 10001
            ) sampled_waiting) AS waiting_parents,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_child edge

               WHERE edge.joined_at IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM workhorse.task_outcome outcome WHERE outcome.task_id = edge.child_task_id
                 )
               LIMIT 10001
            ) sampled_pending) AS pending_children,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_child edge

               JOIN workhorse.task_outcome outcome ON outcome.task_id = edge.child_task_id
              WHERE edge.joined_at IS NULL AND outcome.state = 'succeeded'
               LIMIT 10001
            ) sampled_unjoined) AS unjoined_results,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_outcome outcome

               WHERE outcome.state = 'failed'
                 AND outcome.error->>'name' = 'DependencyFailed'
                 AND EXISTS (
                   SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = outcome.task_id
                 )
               LIMIT 10001
            ) sampled_failed) AS failed_parents,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_outcome outcome

               WHERE outcome.state = 'canceled'
                 AND outcome.error->>'name' = 'DependencyCanceled'
                 AND EXISTS (
                   SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = outcome.task_id
                 )
               LIMIT 10001
            ) sampled_canceled) AS canceled_parents) samples
        ), external_waits AS (
          WITH pending AS (
            SELECT 'signal'::text AS kind, signal.created_at, runtime.deadline_at
              FROM workhorse.task_signal_wait signal
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = signal.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = signal.signal_name
               AND runtime.current_attempt = signal.attempt
             WHERE signal.delivered_at IS NULL
             ORDER BY signal.created_at, signal.task_id, signal.signal_name
             LIMIT 10001
          ), pending_human AS (
            SELECT 'human'::text AS kind, human_wait.created_at, runtime.deadline_at
              FROM workhorse.task_human_wait human_wait
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = human_wait.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = human_wait.token_name
               AND runtime.current_attempt = human_wait.attempt
             WHERE human_wait.completed_at IS NULL
             ORDER BY human_wait.created_at, human_wait.task_id, human_wait.token_name
             LIMIT 10001
          ), combined AS (
            SELECT * FROM pending UNION ALL SELECT * FROM pending_human
          ), overdue_signals AS (
            SELECT 1
              FROM workhorse.task_signal_wait signal
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = signal.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = signal.signal_name
               AND runtime.current_attempt = signal.attempt
             WHERE signal.delivered_at IS NULL AND runtime.deadline_at <= clock_timestamp()
             ORDER BY runtime.deadline_at, signal.task_id, signal.signal_name
             LIMIT 10001
          ), overdue_humans AS (
            SELECT 1
              FROM workhorse.task_human_wait human_wait
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = human_wait.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = human_wait.token_name
               AND runtime.current_attempt = human_wait.attempt
             WHERE human_wait.completed_at IS NULL AND runtime.deadline_at <= clock_timestamp()
             ORDER BY runtime.deadline_at, human_wait.task_id, human_wait.token_name
             LIMIT 10001
          ), rejected AS (
            SELECT 1
              FROM workhorse.task_event
             WHERE event_type IN ('signal_rejected', 'human_wait_rejected')
               AND occurred_at >= p_rejected_since
             ORDER BY occurred_at DESC, event_id DESC
             LIMIT 10001
          )
          SELECT LEAST(count(*) FILTER (WHERE kind = 'signal'), 10000)::text
                   AS pending_signal_waits,
                 LEAST(count(*) FILTER (WHERE kind = 'human'), 10000)::text
                   AS pending_human_waits,
                 LEAST(
                   (SELECT count(*) FROM overdue_signals) + (SELECT count(*) FROM overdue_humans),
                   10000
                 )::text AS overdue_external_waits,
                 extract(epoch FROM clock_timestamp() - min(created_at)) * 1000
                   AS oldest_external_wait_age_ms,
                 LEAST((SELECT count(*) FROM rejected), 10000)::text
                   AS rejected_wait_deliveries,
                 count(*) FILTER (WHERE kind = 'signal') > 10000
                   OR count(*) FILTER (WHERE kind = 'human') > 10000
                   OR (SELECT count(*) FROM overdue_signals)
                        + (SELECT count(*) FROM overdue_humans) > 10000
                   OR (SELECT count(*) FROM rejected) > 10000
                   AS external_wait_counts_capped
            FROM combined
        ), rollup AS (
          SELECT state.rolled_up_through,
                 GREATEST(0, extract(epoch FROM clock_timestamp() - state.rolled_up_through) * 1000)
                   AS rollup_lag_ms,
                 state.last_run_at,
                 bucket_sample.buckets::text AS buckets,
                 bucket_sample.buckets_capped,
                 (SELECT max(bucket_start) FROM (
                    SELECT bucket_start FROM workhorse.task_stat_bucket
                    UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_hour
                    UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_day
                  ) statistic_tiers) AS newest_bucket_at
            FROM workhorse.task_stat_state state
            CROSS JOIN LATERAL (
              SELECT count(*) AS buckets, count(*) > 100000 AS buckets_capped
                FROM (
                  SELECT 1 FROM workhorse.task_stat_bucket
                  UNION ALL SELECT 1 FROM workhorse.task_stat_bucket_hour
                  UNION ALL SELECT 1 FROM workhorse.task_stat_bucket_day
                  LIMIT 100001
                ) sampled_buckets
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
                    FROM workhorse.task_runtime active
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
                            FROM workhorse.task_runtime active
                           WHERE active.state = 'active'
                             AND active.queue_name = policy.queue_name
                             AND active.concurrency_key = ready.concurrency_key
                             AND active.expires_at > clock_timestamp()) AS key_active
                    FROM workhorse.task_runtime ready
                   WHERE ready.state = 'ready' AND ready.queue_name = policy.queue_name
                   ORDER BY ready.sequence, ready.task_id
                   LIMIT 101
                ) sample
            ) blocked
           ORDER BY policy.queue_name
           LIMIT 100
        ), rate_limits AS (
        WITH observed AS (
          SELECT clock_timestamp() AS now
        ), policies AS MATERIALIZED (
          SELECT policy.* FROM workhorse.rate_limit_policy policy
           WHERE cardinality(ARRAY[]::text[]) = 0 OR policy.queue_name = ANY(ARRAY[]::text[])
           ORDER BY policy.queue_name LIMIT 101
        ), queue_status AS (
          SELECT policy.*, observed.now,
                 GREATEST(observed.now, COALESCE(bucket.refilled_at, observed.now))
                   AS refill_baseline,
                 LEAST(policy.rate_burst::numeric, COALESCE(bucket.tokens, policy.rate_burst::numeric))
                   AS available_tokens
            FROM policies policy CROSS JOIN observed
            CROSS JOIN LATERAL (
              SELECT max(shard_row.refilled_at) AS refilled_at,
                     sum(LEAST(shard_row.share::numeric, COALESCE(
                       shard_row.tokens + GREATEST(
                         0::numeric,
                         extract(epoch FROM observed.now - shard_row.refilled_at) * 1000
                       ) * policy.rate_limit::numeric * shard_row.share
                         / (policy.rate_interval_ms::numeric * policy.rate_burst),
                       shard_row.share::numeric
                     ))) AS tokens
                FROM (
                  SELECT stored.tokens, stored.refilled_at,
                         policy.rate_burst / count(*) OVER ()
                           + ((row_number() OVER (ORDER BY stored.shard) - 1)
                              < policy.rate_burst % count(*) OVER ())::integer AS share
                    FROM workhorse.admission_shard stored
                   WHERE stored.queue_name = policy.queue_name
                ) shard_row
            ) bucket
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
                      FROM workhorse.task_runtime runtime
                     WHERE runtime.state = 'ready' AND runtime.queue_name = policy.queue_name
                     ORDER BY runtime.sequence, runtime.task_id LIMIT 101
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
         ORDER BY policy.queue_name LIMIT 100
        ), budget_policies AS (
          SELECT * FROM workhorse.budget_status_v1(ARRAY[]::text[])
        ), partition_days AS (
          -- Workhorse demands prepared storage for today and the three days after it. Preparation
          -- covers a longer horizon so this window can never outrun it; see
          -- history_partition_horizon_days_v1 before changing the three days here.
          SELECT to_char(day_start, 'YYYYMMDD') AS day, day_start AS starts_at,
                 to_regclass(format('workhorse.%I', 'task_event_' || to_char(day_start, 'YYYYMMDD')))
                   IS NOT NULL AS has_task_events,
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
               depth.*, terminal.*, dependencies.*, children.*, external_waits.*, retention.*, rollup.*,
               (SELECT COALESCE(jsonb_agg(to_jsonb(c.*) ORDER BY c.queue_name), '[]'::jsonb)
                  FROM concurrency c) AS concurrency_policies,
               (SELECT COALESCE(jsonb_agg(to_jsonb(r.*) ORDER BY r.queue_name), '[]'::jsonb)
                  FROM rate_limits r) AS rate_limit_policies,
               (SELECT COALESCE(jsonb_agg(to_jsonb(b.*) ORDER BY b.budget_name), '[]'::jsonb)
                  FROM budget_policies b) AS budget_policies,
               (SELECT jsonb_agg(to_jsonb(p.*) ORDER BY p.starts_at)
                  FROM partition_days p) AS history_partition_days
          FROM installed
          CROSS JOIN depth
          CROSS JOIN terminal
          CROSS JOIN dependencies
          CROSS JOIN children
          CROSS JOIN external_waits
          CROSS JOIN retention
          CROSS JOIN rollup
    ) snapshot
    CROSS JOIN workhorse.queue_health_policy policy
   WHERE policy.singleton;

  SELECT jsonb_build_object(
           'relations', COALESCE((
             SELECT jsonb_agg(to_jsonb(relation_row) ORDER BY relation_row.relation)
               FROM (
                 SELECT parent.relname AS relation,
                        sum(pg_total_relation_size(COALESCE(tree.relid, parent.oid)))::text
                          AS total_bytes,
                        sum(pg_relation_size(COALESCE(tree.relid, parent.oid)))::text AS table_bytes,
                        sum(pg_indexes_size(COALESCE(tree.relid, parent.oid)))::text AS index_bytes,
                        sum(COALESCE(statistics.n_live_tup, 0))::text AS live_tuples,
                        sum(COALESCE(statistics.n_dead_tup, 0))::text AS dead_tuples,
                        sum(COALESCE(statistics.n_mod_since_analyze, 0))::text
                          AS modifications_since_analyze,
                        CASE WHEN sum(COALESCE(statistics.n_tup_upd, 0)) = 0 THEN NULL
                             ELSE sum(statistics.n_tup_hot_upd)::double precision
                               / sum(statistics.n_tup_upd) END AS hot_update_ratio,
                        max(statistics.last_vacuum) AS last_vacuum,
                        max(statistics.last_autovacuum) AS last_autovacuum,
                        count(*) FILTER (
                          WHERE tree.relid IS NOT NULL AND tree.relid <> parent.oid
                        )::text AS partitions
                   FROM pg_class parent
                   JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
                   LEFT JOIN LATERAL pg_partition_tree(parent.oid) tree ON true
                   LEFT JOIN pg_stat_user_tables statistics
                     ON statistics.relid = COALESCE(tree.relid, parent.oid)
                  WHERE namespace.nspname = 'workhorse'
                    AND parent.relkind IN ('r', 'p')
                    AND parent.relispartition = false
                  GROUP BY parent.relname, parent.oid
               ) relation_row
           ), '[]'::jsonb),
           'oldest_transaction_age_ms', activity.age_ms,
           'lock_wait_count', activity.lock_wait_count,
           'notification_queue_usage', pg_notification_queue_usage()
         )
    INTO v_observations
    FROM (
      SELECT extract(epoch FROM clock_timestamp() - min(xact_start)) * 1000 AS age_ms,
             count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS lock_wait_count
        FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
    ) activity;

  RETURN v_document || jsonb_build_object('observations', v_observations);
END;
$$;

-- Synchronize queue concurrency policies as deployment-owned desired state. Omitted rows are pruned
-- by default, so one deployment cannot leave stale admission budgets behind indefinitely. Each
-- affected queue then gets the admission shards its new policies allow (ADR 0082).
CREATE OR REPLACE FUNCTION workhorse.sync_concurrency_policies_v1(
  p_namespace text,
  p_definitions jsonb,
  p_prune boolean DEFAULT true
) RETURNS TABLE (
  namespace text,
  queue_name text,
  max_active integer,
  max_active_per_key integer,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition jsonb;
  v_queue_name text;
  v_max_active numeric;
  v_max_active_per_key numeric;
  v_seen text[] := '{}';
  v_notify_queues text[] := '{}';
BEGIN
  IF p_namespace IS NULL OR p_namespace = '' OR octet_length(p_namespace) > 256 THEN
    RAISE EXCEPTION 'concurrency policy namespace must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'concurrency policy definitions must be a JSON array';
  END IF;
  IF jsonb_array_length(p_definitions) > 10000 THEN
    RAISE EXCEPTION 'concurrency policy definitions exceed maximum size of 10000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:concurrency-policies', 0));

  FOR v_definition IN SELECT value FROM jsonb_array_elements(p_definitions)
  LOOP
    IF jsonb_typeof(v_definition) <> 'object'
       OR v_definition - ARRAY['queue', 'maxActive', 'maxActivePerKey'] <> '{}'::jsonb
       OR NOT (v_definition ? 'queue')
       OR NOT (v_definition ? 'maxActive')
       OR jsonb_typeof(v_definition->'queue') <> 'string'
       OR jsonb_typeof(v_definition->'maxActive') <> 'number'
       OR (v_definition ? 'maxActivePerKey'
         AND v_definition->'maxActivePerKey' <> 'null'::jsonb
         AND jsonb_typeof(v_definition->'maxActivePerKey') <> 'number') THEN
      RAISE EXCEPTION 'each concurrency policy requires queue and maxActive, with optional maxActivePerKey';
    END IF;
    v_queue_name := v_definition->>'queue';
    v_max_active := (v_definition->>'maxActive')::numeric;
    v_max_active_per_key := (v_definition->>'maxActivePerKey')::numeric;
    IF v_queue_name = '' OR octet_length(v_queue_name) > 256 THEN
      RAISE EXCEPTION 'concurrency policy queue must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_queue_name = ANY(v_seen) THEN
      RAISE EXCEPTION 'concurrency policy queue names must be unique';
    END IF;
    IF v_max_active <> trunc(v_max_active) OR v_max_active NOT BETWEEN 1 AND 1000000 THEN
      RAISE EXCEPTION 'max_active must be an integer between 1 and 1000000';
    END IF;
    IF v_max_active_per_key IS NOT NULL AND (
      v_max_active_per_key <> trunc(v_max_active_per_key)
      OR v_max_active_per_key NOT BETWEEN 1 AND v_max_active
    ) THEN
      RAISE EXCEPTION 'max_active_per_key must be an integer between 1 and max_active';
    END IF;
    v_seen := array_append(v_seen, v_queue_name);
    v_notify_queues := array_append(v_notify_queues, v_queue_name);
    PERFORM pg_advisory_xact_lock(
      hashtextextended('workhorse:concurrency-policy:' || v_queue_name, 0)
    );
    IF cardinality(workhorse.lock_queue_tiers_v1(ARRAY[v_queue_name])) > 0 THEN
      PERFORM workhorse.reject_fast_feature_v1(v_queue_name, 'concurrency policies');
    END IF;
    IF EXISTS (
      SELECT 1 FROM workhorse.concurrency_policy policy
       WHERE policy.queue_name = v_queue_name AND policy.namespace <> p_namespace
    ) THEN
      RAISE EXCEPTION 'concurrency policy queue is owned by another namespace';
    END IF;
    INSERT INTO workhorse.concurrency_policy AS policy(
      queue_name, namespace, max_active, max_active_per_key, updated_at
    ) VALUES (
      v_queue_name, p_namespace, v_max_active::integer, v_max_active_per_key::integer,
      clock_timestamp()
    )
    ON CONFLICT ON CONSTRAINT concurrency_policy_pkey DO UPDATE SET
      max_active = EXCLUDED.max_active,
      max_active_per_key = EXCLUDED.max_active_per_key,
      updated_at = CASE
        WHEN policy.max_active IS DISTINCT FROM EXCLUDED.max_active
          OR policy.max_active_per_key IS DISTINCT FROM EXCLUDED.max_active_per_key
        THEN EXCLUDED.updated_at ELSE policy.updated_at
      END;
  END LOOP;

  IF p_prune THEN
    FOR v_queue_name IN
      SELECT policy.queue_name
        FROM workhorse.concurrency_policy policy
       WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen))
       ORDER BY policy.queue_name
    LOOP
      v_notify_queues := array_append(v_notify_queues, v_queue_name);
      PERFORM pg_advisory_xact_lock(
        hashtextextended('workhorse:concurrency-policy:' || v_queue_name, 0)
      );
    END LOOP;
    DELETE FROM workhorse.concurrency_policy policy
     WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen));
  END IF;

  FOR v_queue_name IN
    SELECT DISTINCT affected.queue_name
      FROM unnest(v_notify_queues) AS affected(queue_name)
     ORDER BY affected.queue_name
  LOOP
    PERFORM workhorse.rebalance_admission_shards_v1(v_queue_name, clock_timestamp());
    PERFORM pg_notify('workhorse_tasks', v_queue_name);
  END LOOP;

  RETURN QUERY
    SELECT policy.namespace, policy.queue_name, policy.max_active, policy.max_active_per_key,
           policy.updated_at
      FROM workhorse.concurrency_policy policy
     WHERE policy.namespace = p_namespace
     ORDER BY policy.queue_name;
END;
$$;

-- Synchronize queue rate limits as deployment-owned desired state. A policy update keeps the tokens
-- a queue has accrued. The synchronization refills the queue's admission shards, clamps their sum to
-- the new burst, and spreads it over the new shards, so it never manufactures starts (ADR 0082).
CREATE OR REPLACE FUNCTION workhorse.sync_rate_limit_policies_v1(
  p_namespace text,
  p_definitions jsonb,
  p_prune boolean DEFAULT true
) RETURNS TABLE (
  namespace text,
  queue_name text,
  rate_limit integer,
  rate_interval_ms integer,
  rate_burst integer,
  per_key_limit integer,
  per_key_interval_ms integer,
  per_key_burst integer,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition jsonb;
  v_rate jsonb;
  v_per_key jsonb;
  v_queue_name text;
  v_rate_limit numeric;
  v_rate_interval_ms numeric;
  v_rate_burst numeric;
  v_per_key_limit numeric;
  v_per_key_interval_ms numeric;
  v_per_key_burst numeric;
  v_seen text[] := '{}';
  v_notify_queues text[] := '{}';
BEGIN
  IF p_namespace IS NULL OR p_namespace = '' OR octet_length(p_namespace) > 256 THEN
    RAISE EXCEPTION 'rate-limit policy namespace must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'rate-limit policy definitions must be a JSON array';
  END IF;
  IF jsonb_array_length(p_definitions) > 10000 THEN
    RAISE EXCEPTION 'rate-limit policy definitions exceed maximum size of 10000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:rate-limit-policies', 0));

  FOR v_definition IN SELECT value FROM jsonb_array_elements(p_definitions)
  LOOP
    IF jsonb_typeof(v_definition) <> 'object'
       OR v_definition - ARRAY['queue', 'rate', 'perKey'] <> '{}'::jsonb
       OR NOT (v_definition ? 'queue') OR NOT (v_definition ? 'rate')
       OR jsonb_typeof(v_definition->'queue') <> 'string'
       OR jsonb_typeof(v_definition->'rate') <> 'object'
       OR (v_definition ? 'perKey' AND v_definition->'perKey' <> 'null'::jsonb
         AND jsonb_typeof(v_definition->'perKey') <> 'object') THEN
      RAISE EXCEPTION 'each rate-limit policy requires queue and rate, with optional perKey';
    END IF;
    v_queue_name := v_definition->>'queue';
    v_rate := v_definition->'rate';
    v_per_key := v_definition->'perKey';
    IF v_queue_name = '' OR octet_length(v_queue_name) > 256 THEN
      RAISE EXCEPTION 'rate-limit policy queue must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_queue_name = ANY(v_seen) THEN
      RAISE EXCEPTION 'rate-limit policy queue names must be unique';
    END IF;
    IF v_rate - ARRAY['limit', 'intervalMs', 'burst'] <> '{}'::jsonb
       OR NOT (v_rate ?& ARRAY['limit', 'intervalMs', 'burst'])
       OR jsonb_typeof(v_rate->'limit') <> 'number'
       OR jsonb_typeof(v_rate->'intervalMs') <> 'number'
       OR jsonb_typeof(v_rate->'burst') <> 'number' THEN
      RAISE EXCEPTION 'rate requires numeric limit, intervalMs, and burst';
    END IF;
    IF v_per_key IS NOT NULL AND v_per_key <> 'null'::jsonb AND (
      v_per_key - ARRAY['limit', 'intervalMs', 'burst'] <> '{}'::jsonb
      OR NOT (v_per_key ?& ARRAY['limit', 'intervalMs', 'burst'])
      OR jsonb_typeof(v_per_key->'limit') <> 'number'
      OR jsonb_typeof(v_per_key->'intervalMs') <> 'number'
      OR jsonb_typeof(v_per_key->'burst') <> 'number'
    ) THEN
      RAISE EXCEPTION 'perKey requires numeric limit, intervalMs, and burst';
    END IF;
    v_rate_limit := (v_rate->>'limit')::numeric;
    v_rate_interval_ms := (v_rate->>'intervalMs')::numeric;
    v_rate_burst := (v_rate->>'burst')::numeric;
    v_per_key_limit := (v_per_key->>'limit')::numeric;
    v_per_key_interval_ms := (v_per_key->>'intervalMs')::numeric;
    v_per_key_burst := (v_per_key->>'burst')::numeric;
    IF v_rate_limit <> trunc(v_rate_limit) OR v_rate_limit NOT BETWEEN 1 AND 1000000
       OR v_rate_interval_ms <> trunc(v_rate_interval_ms)
       OR v_rate_interval_ms NOT BETWEEN 1 AND 86400000
       OR v_rate_burst <> trunc(v_rate_burst) OR v_rate_burst NOT BETWEEN 1 AND 1000000 THEN
      RAISE EXCEPTION 'rate values must be bounded positive integers';
    END IF;
    IF v_per_key_limit IS NOT NULL AND (
      v_per_key_limit <> trunc(v_per_key_limit) OR v_per_key_limit NOT BETWEEN 1 AND 1000000
      OR v_per_key_interval_ms <> trunc(v_per_key_interval_ms)
      OR v_per_key_interval_ms NOT BETWEEN 1 AND 86400000
      OR v_per_key_burst <> trunc(v_per_key_burst)
      OR v_per_key_burst NOT BETWEEN 1 AND 1000000
    ) THEN
      RAISE EXCEPTION 'perKey values must be bounded positive integers';
    END IF;
    v_seen := array_append(v_seen, v_queue_name);
    v_notify_queues := array_append(v_notify_queues, v_queue_name);
    PERFORM pg_advisory_xact_lock(
      hashtextextended('workhorse:rate-limit-policy:' || v_queue_name, 0)
    );
    IF cardinality(workhorse.lock_queue_tiers_v1(ARRAY[v_queue_name])) > 0 THEN
      PERFORM workhorse.reject_fast_feature_v1(v_queue_name, 'rate-limit policies');
    END IF;
    IF EXISTS (
      SELECT 1 FROM workhorse.rate_limit_policy policy
       WHERE policy.queue_name = v_queue_name AND policy.namespace <> p_namespace
    ) THEN
      RAISE EXCEPTION 'rate-limit policy queue is owned by another namespace';
    END IF;
    INSERT INTO workhorse.rate_limit_policy AS policy(
      queue_name, namespace, rate_limit, rate_interval_ms, rate_burst,
      per_key_limit, per_key_interval_ms, per_key_burst, updated_at
    ) VALUES (
      v_queue_name, p_namespace, v_rate_limit::integer, v_rate_interval_ms::integer,
      v_rate_burst::integer, v_per_key_limit::integer, v_per_key_interval_ms::integer,
      v_per_key_burst::integer, clock_timestamp()
    )
    ON CONFLICT ON CONSTRAINT rate_limit_policy_pkey DO UPDATE SET
      rate_limit = EXCLUDED.rate_limit,
      rate_interval_ms = EXCLUDED.rate_interval_ms,
      rate_burst = EXCLUDED.rate_burst,
      per_key_limit = EXCLUDED.per_key_limit,
      per_key_interval_ms = EXCLUDED.per_key_interval_ms,
      per_key_burst = EXCLUDED.per_key_burst,
      updated_at = CASE WHEN
        (policy.rate_limit, policy.rate_interval_ms, policy.rate_burst,
         policy.per_key_limit, policy.per_key_interval_ms, policy.per_key_burst)
        IS DISTINCT FROM
        (EXCLUDED.rate_limit, EXCLUDED.rate_interval_ms, EXCLUDED.rate_burst,
         EXCLUDED.per_key_limit, EXCLUDED.per_key_interval_ms, EXCLUDED.per_key_burst)
        THEN EXCLUDED.updated_at ELSE policy.updated_at END;
  END LOOP;

  IF p_prune THEN
    FOR v_queue_name IN
      SELECT policy.queue_name FROM workhorse.rate_limit_policy policy
       WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen))
       ORDER BY policy.queue_name
    LOOP
      v_notify_queues := array_append(v_notify_queues, v_queue_name);
      PERFORM pg_advisory_xact_lock(
        hashtextextended('workhorse:rate-limit-policy:' || v_queue_name, 0)
      );
    END LOOP;
    DELETE FROM workhorse.rate_limit_policy policy
     WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen));
  END IF;

  FOR v_queue_name IN
    SELECT DISTINCT affected.queue_name
      FROM unnest(v_notify_queues) AS affected(queue_name)
     ORDER BY affected.queue_name
  LOOP
    PERFORM workhorse.rebalance_admission_shards_v1(v_queue_name, clock_timestamp());
    PERFORM pg_notify('workhorse_tasks', v_queue_name);
  END LOOP;
  RETURN QUERY
    SELECT policy.namespace, policy.queue_name, policy.rate_limit, policy.rate_interval_ms,
           policy.rate_burst, policy.per_key_limit, policy.per_key_interval_ms,
           policy.per_key_burst, policy.updated_at
      FROM workhorse.rate_limit_policy policy
     WHERE policy.namespace = p_namespace ORDER BY policy.queue_name;
END;
$$;

-- Claim up to p_limit tasks from a full-tier queue. claim_many_v1 claims every full-tier batch
-- through it (SM-948), and claim_one_v1 claims through it for a queue with a concurrency or
-- rate-limit policy, so a single claim and a batch share one admission path.
--
-- Queue-wide capacity lives in admission shards (ADR 0082). Each shard owns an equal share of
-- max_active and of the queue rate bucket, and a claim may spend a shard's capacity only while it
-- holds that shard's advisory lock. A claim first tries the shards in turn from a home shard that
-- its backend chooses, and keeps the first it gets. When no shard is free it waits for its home
-- shard, unless it may not wait. When its shards cannot fill the batch, it borrows further shards
-- with a lock it can take at once. Claims on different shards therefore admit in parallel, and the
-- shared policy advisory locks still hold every deployment synchronization back until they commit.
--
-- The queue-wide caps hold exactly. A claim counts the unexpired active leases of each shard, and a
-- lease counts against its admission_shard modulo the shard count. A claim admits at most the room
-- of the shards it holds. It also subtracts the overdraft of every shard it does not hold, so leases
-- a shard took under an earlier shard count cannot push the queue past max_active. A shard's tokens
-- refill at its share of the queue rate, and a claim charges only the shards it holds. A claim that
-- stops short while another claim held a shard it wanted notifies the queue, so the capacity it
-- could not reach wakes a worker. A queue whose shard rows do not match its policies is rebalanced
-- first, under every shard lock. A queue with no concurrency or rate-limit policy has no shards,
-- because no queue-wide rule limits its claims.
--
-- A queue with a per-key rule has one shard, so every claim on it serializes as before. Within the
-- shards it holds, a claim admits the batch as a set (SM-915). It locks the window's budgets once
-- per round, reads the clock once, and derives from one read of the 100-row window how many rows
-- each concurrency key and each budget can still start: the room left under max_active_per_key and
-- the whole tokens left in the per-key and budget buckets. A row whose key or budget has no room is
-- dropped, and the rest are ranked within their key and within their budget in claim order. A row
-- is admitted when both ranks fit, and the batch takes at most as many rows as the held shards
-- allow. It then locks only the admitted rows, activates them, appends their claim events, and
-- charges every bucket once with the number of starts it admitted. A row that has both a limited
-- key and a limited budget can use a key rank and then miss its budget rank, so a round can admit
-- fewer rows than one-at-a-time claims would. A short round is repeated from a fresh window, with
-- budget locks it can take without waiting, until the limit, an empty round, exhausted capacity, or
-- a window that no further round can change. A round on a queue with no per-key rule and no locked
-- budget skips the window. It locks the first ready rows up to the room directly, stops at a row
-- that names a budget, and ends the batch.
--
-- Only the first round may wait for a budget lock, and only before the claim holds a shard. A claim
-- that holds a shard never waits for another lock, so claims that hold shards cannot deadlock. The
-- function plans every statement generically. Statements over the batch arrays otherwise keep a
-- custom plan, because the generic estimate for an array parameter is pessimistic, and replanning
-- them on every call doubled the latency of a claim.
CREATE OR REPLACE FUNCTION workhorse.claim_policy_batch_v1(
  p_queue_name text,
  p_worker_id text,
  p_limit integer,
  p_lease_ms integer,
  p_wait_for_budgets boolean
) RETURNS TABLE (
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_claimed integer;
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_budget_name text;
  v_budget_names text[] := '{}';
  v_first_round boolean := true;
  v_now timestamptz;
  v_expires timestamptz;
  v_room integer;
  v_take integer;
  v_queue_capped boolean;
  v_window integer;
  v_mixed boolean;
  v_fit integer;
  v_picked uuid[];
  v_fences bigint[];
  v_ids uuid[];
  v_keys text[];
  v_budgets text[];
  v_total integer := 0;
  v_direct boolean;
  v_index integer;
  v_shards integer;
  v_home integer;
  v_shard integer;
  v_held integer[] := '{}';
  v_rebalanced boolean := false;
  v_skipped boolean := false;
  v_short boolean := false;
  v_capped_out boolean := false;
  v_shard_room integer[];
  v_shard_tokens numeric[];
  v_conc_room integer;
  v_rate_room integer;
  v_all_room integer;
  v_all_tokens integer;
  v_want integer;
  v_gain_room integer;
  v_gain_tokens numeric;
  v_slots integer[];
  v_left integer;
  v_part integer;
  v_rest numeric;
  v_charge numeric;
  v_charged integer[];
  v_charges numeric[];
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
  END IF;
  -- Shared queue locks allow claims to overlap while holding every deployment synchronization of
  -- this queue's policies, and the rebalance it performs, back until this claim commits.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || p_queue_name, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:rate-limit-policy:' || p_queue_name, 0)
  );
  SELECT policy.* INTO v_policy
    FROM workhorse.concurrency_policy policy WHERE policy.queue_name = p_queue_name;
  SELECT policy.* INTO v_rate_policy
    FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = p_queue_name;
  v_shards := workhorse.admission_shard_count_v1(
    v_policy.max_active, v_policy.max_active_per_key, v_rate_policy.rate_burst,
    v_rate_policy.per_key_limit
  );
  v_home := CASE WHEN v_shards > 0 THEN pg_backend_pid() % v_shards END;
  -- A queue whose shard rows do not match its policies has not been rebalanced since a policy
  -- changed outside deployment synchronization. The rebalance leaves this claim holding every shard.
  -- A queue with no policy has no shards, and its stored rows are left alone.
  IF v_shards > 0 AND NOT EXISTS (
    SELECT 1 FROM workhorse.admission_shard stored
     WHERE stored.queue_name = p_queue_name
    HAVING count(*) = v_shards AND max(stored.shard) = v_shards - 1
  ) THEN
    PERFORM workhorse.rebalance_admission_shards_v1(p_queue_name, clock_timestamp());
    v_rebalanced := true;
    v_held := ARRAY(SELECT generate_series(0, v_shards - 1));
  END IF;

  LOOP
    -- Lock each budget the window can name, in name order, before reading the clock. Only a first
    -- round that holds no shard may wait; any other round takes only the locks it can get at once.
    -- A queue with no ready row that names a budget skips the sample.
    IF EXISTS (
      SELECT 1 FROM workhorse.task_runtime runtime
       WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
         AND runtime.budget_name IS NOT NULL
    ) THEN
      FOR v_budget_name IN
        SELECT DISTINCT sample.budget_name
          FROM (
            SELECT runtime.budget_name
              FROM workhorse.task_runtime runtime
             WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
             ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
             LIMIT 100
          ) sample
         WHERE sample.budget_name IS NOT NULL
         ORDER BY sample.budget_name
      LOOP
        CONTINUE WHEN v_budget_name = ANY(v_budget_names);
        IF v_first_round AND p_wait_for_budgets AND NOT v_rebalanced THEN
          PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budget:' || v_budget_name, 0));
        ELSIF NOT pg_try_advisory_xact_lock(
          hashtextextended('workhorse:budget:' || v_budget_name, 0)
        ) THEN
          CONTINUE;
        END IF;
        v_budget_names := v_budget_names || v_budget_name;
      END LOOP;
    END IF;

    IF v_first_round AND NOT v_rebalanced AND v_shards > 0 THEN
      -- Take the first shard that is free, starting at home. When every shard is busy, wait for the
      -- home shard, or give up when this claim may not wait.
      FOR v_index IN 0..v_shards - 1 LOOP
        v_shard := (v_home + v_index) % v_shards;
        IF pg_try_advisory_xact_lock(
          hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_shard, 0)
        ) THEN
          v_held := ARRAY[v_shard];
          EXIT;
        END IF;
      END LOOP;
      IF cardinality(v_held) = 0 THEN
        IF NOT p_wait_for_budgets THEN
          v_skipped := true;
          v_short := true;
          v_capped_out := true;
          EXIT;
        END IF;
        PERFORM pg_advisory_xact_lock(
          hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_home, 0)
        );
        v_held := ARRAY[v_home];
      END IF;
    END IF;
    v_now := clock_timestamp();
    v_expires := v_now + make_interval(secs => p_lease_ms::double precision / 1000.0);

    IF v_first_round THEN
      WITH oldest_key_buckets AS MATERIALIZED (
        SELECT bucket.bucket_key, bucket.tokens, bucket.refilled_at
          FROM workhorse.rate_limit_bucket bucket
         WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
         ORDER BY bucket.refilled_at, bucket.bucket_key
         FOR UPDATE SKIP LOCKED
         LIMIT 100
      ), full_key_buckets AS (
        SELECT oldest.bucket_key
          FROM oldest_key_buckets oldest
         WHERE v_rate_policy.per_key_limit IS NULL OR LEAST(
           v_rate_policy.per_key_burst::numeric,
           oldest.tokens + GREATEST(
             0::numeric,
             extract(epoch FROM v_now - oldest.refilled_at) * 1000
           ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric
         ) >= v_rate_policy.per_key_burst
      )
      DELETE FROM workhorse.rate_limit_bucket bucket
       USING full_key_buckets refilled
       WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
         AND bucket.bucket_key = refilled.bucket_key;
    END IF;
    v_first_round := false;

    -- Read every shard's room and refilled tokens. A shard's room is its share of max_active less
    -- its unexpired active leases, and a null value means no rule limits it. The held room adds the
    -- overdraft of every shard this claim does not hold. When the held shards cannot cover what the
    -- whole queue could start, borrow the shards that have capacity and are free now, then read again.
    -- A queue with no shards has no queue-wide rule, so its room stays null.
    v_room := NULL;
    v_short := false;
    FOR v_index IN 1..2 LOOP
      EXIT WHEN v_shards = 0;
      WITH shard AS (
        SELECT slot.shard,
               CASE WHEN v_policy.queue_name IS NOT NULL THEN
                 workhorse.admission_share_v1(v_policy.max_active, v_shards, slot.shard)
                   - COALESCE(active.leases, 0)
               END AS room,
               CASE WHEN v_rate_policy.queue_name IS NOT NULL THEN LEAST(
                 workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)::numeric,
                 COALESCE(
                   stored.tokens + GREATEST(
                     0::numeric,
                     extract(epoch FROM v_now - stored.refilled_at) * 1000
                   ) * v_rate_policy.rate_limit::numeric
                     * workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)
                     / (v_rate_policy.rate_interval_ms::numeric * v_rate_policy.rate_burst),
                   workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)::numeric
                 )
               ) END AS tokens,
               slot.shard = ANY(v_held) AS held
          FROM generate_series(0, v_shards - 1) AS slot(shard)
          LEFT JOIN (
            SELECT COALESCE(active.admission_shard, 0) % v_shards AS shard,
                   count(*)::integer AS leases
              FROM workhorse.task_runtime active
             WHERE active.state = 'active' AND active.queue_name = p_queue_name
               AND active.expires_at > v_now
             GROUP BY 1
          ) active ON active.shard = slot.shard
          LEFT JOIN workhorse.admission_shard stored
            ON stored.queue_name = p_queue_name AND stored.shard = slot.shard
      )
      SELECT array_agg(shard.room ORDER BY shard.shard),
             array_agg(shard.tokens ORDER BY shard.shard),
             -- GREATEST and LEAST skip a null, so a queue with no concurrency policy tests for it.
             CASE WHEN v_policy.queue_name IS NOT NULL THEN LEAST(
               sum(GREATEST(shard.room, 0)) FILTER (WHERE shard.held),
               sum(shard.room) FILTER (WHERE shard.held)
                 + COALESCE(sum(LEAST(shard.room, 0)) FILTER (WHERE NOT shard.held), 0)
             ) END::integer,
             floor(sum(shard.tokens) FILTER (WHERE shard.held))::integer,
             sum(shard.room)::integer,
             floor(sum(shard.tokens))::integer
        INTO v_shard_room, v_shard_tokens, v_conc_room, v_rate_room, v_all_room, v_all_tokens
        FROM shard;
      v_room := LEAST(v_conc_room, v_rate_room);
      v_want := LEAST(p_limit - v_total, v_all_room, v_all_tokens);
      v_short := v_room < v_want;
      EXIT WHEN v_index = 2 OR NOT v_short OR cardinality(v_held) = v_shards;
      v_gain_room := 0;
      v_gain_tokens := 0;
      FOR v_offset IN 0..v_shards - 1 LOOP
        v_shard := (v_home + v_offset) % v_shards;
        CONTINUE WHEN v_shard = ANY(v_held)
          OR COALESCE(v_shard_room[v_shard + 1], 1) <= 0
          OR COALESCE(v_shard_tokens[v_shard + 1], 1) <= 0;
        IF pg_try_advisory_xact_lock(
          hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_shard, 0)
        ) THEN
          v_held := v_held || v_shard;
          v_gain_room := v_gain_room + COALESCE(v_shard_room[v_shard + 1], 0);
          v_gain_tokens := v_gain_tokens + COALESCE(v_shard_tokens[v_shard + 1], 0);
          EXIT WHEN (v_conc_room IS NULL OR v_conc_room + v_gain_room >= v_want)
            AND (v_rate_room IS NULL OR v_rate_room + v_gain_tokens >= v_want);
        ELSE
          v_skipped := true;
        END IF;
      END LOOP;
    END LOOP;

    v_take := p_limit - v_total;
    v_queue_capped := false;
    IF v_room <= v_take THEN v_take := v_room; v_queue_capped := true; END IF;
    IF v_take <= 0 THEN
      v_capped_out := true;
      EXIT;
    END IF;

    v_direct := v_policy.max_active_per_key IS NULL AND v_rate_policy.per_key_limit IS NULL
      AND cardinality(v_budget_names) = 0;
    IF v_direct THEN
      -- No per-key rule and no budget lock, so no rule passes over a row, and the first ready rows
      -- this claim can lock are the rows it takes. As in claim_one_v1, a row that names a budget
      -- holds the line, and the rows after it stay ready.
      SELECT array_agg(line.task_id ORDER BY line.priority DESC, line.sequence, line.task_id)
        INTO v_picked
        FROM (
          SELECT locked.task_id, locked.priority, locked.sequence,
                 bool_or(locked.budget_name IS NOT NULL) OVER (
                   ORDER BY locked.priority DESC, locked.sequence, locked.task_id
                 ) AS reached_budget
            FROM (
              SELECT runtime.task_id, runtime.budget_name, runtime.priority, runtime.sequence
                FROM workhorse.task_runtime runtime
                JOIN workhorse.task task ON task.id = runtime.task_id
               WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
                 AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
                 AND (task.execution_timeout_ms IS NULL
                   OR runtime.execution_used_ms < task.execution_timeout_ms)
                 AND NOT EXISTS (
                   SELECT 1 FROM workhorse.queue_control control
                    WHERE control.queue_name = p_queue_name AND control.paused
                 )
               ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
               FOR NO KEY UPDATE OF runtime SKIP LOCKED
               LIMIT v_take
            ) locked
        ) line
       WHERE NOT line.reached_budget;
    ELSE
      -- The window reads without locking, and only the admitted rows are locked (SM-801). A null
      -- room means no rule limits that key or budget.
      WITH ready_window AS MATERIALIZED (
        SELECT runtime.task_id, runtime.concurrency_key, runtime.budget_name, runtime.priority,
               runtime.sequence
          FROM workhorse.task_runtime runtime
          JOIN workhorse.task task ON task.id = runtime.task_id
         WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
           AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
           AND (task.execution_timeout_ms IS NULL
             OR runtime.execution_used_ms < task.execution_timeout_ms)
           AND NOT EXISTS (
             SELECT 1 FROM workhorse.queue_control control
              WHERE control.queue_name = p_queue_name AND control.paused
           )
         ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
         LIMIT 100
      ), key_room AS (
        SELECT keys.concurrency_key, LEAST(
          CASE WHEN v_policy.max_active_per_key IS NOT NULL THEN
            v_policy.max_active_per_key - (
              SELECT count(*)::integer
                FROM workhorse.task_runtime active
               WHERE active.state = 'active'
                 AND active.queue_name = p_queue_name
                 AND active.concurrency_key = keys.concurrency_key
                 AND active.expires_at > v_now
            )
          END,
          CASE WHEN v_rate_policy.per_key_limit IS NOT NULL THEN floor(LEAST(
            v_rate_policy.per_key_burst::numeric,
            COALESCE(
              bucket.tokens + GREATEST(
                0::numeric,
                extract(epoch FROM v_now - bucket.refilled_at) * 1000
              ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric,
              v_rate_policy.per_key_burst::numeric
            )
          ))::integer END
        ) AS room
          FROM (
            SELECT DISTINCT ready.concurrency_key FROM ready_window ready
             WHERE ready.concurrency_key IS NOT NULL
          ) keys
          LEFT JOIN workhorse.rate_limit_bucket bucket
            ON bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
           AND bucket.bucket_key = keys.concurrency_key
      ), budget_room AS (
        -- A budget this claim never locked has no room, whether or not it exists.
        SELECT names.budget_name, CASE
          WHEN NOT (names.budget_name = ANY(v_budget_names)) THEN 0
          WHEN budget.budget_name IS NULL THEN NULL
          ELSE LEAST(
            budget.max_active - (
              SELECT count(*)::integer
                FROM workhorse.task_runtime active
               WHERE active.state = 'active'
                 AND active.budget_name = names.budget_name
                 AND active.expires_at > v_now
            ),
            CASE WHEN budget.rate_limit IS NOT NULL THEN floor(LEAST(
              budget.rate_burst::numeric,
              COALESCE(
                bucket.tokens + GREATEST(
                  0::numeric,
                  extract(epoch FROM v_now - bucket.refilled_at) * 1000
                ) * budget.rate_limit::numeric / budget.rate_interval_ms::numeric,
                budget.rate_burst::numeric
              )
            ))::integer END
          )
        END AS room
          FROM (
            SELECT DISTINCT ready.budget_name FROM ready_window ready
             WHERE ready.budget_name IS NOT NULL
          ) names
          LEFT JOIN workhorse.budget budget ON budget.budget_name = names.budget_name
          LEFT JOIN workhorse.budget_bucket bucket ON bucket.budget_name = names.budget_name
      ), eligible AS (
        SELECT ready.task_id, ready.concurrency_key, ready.budget_name, ready.priority,
               ready.sequence, key_room.room AS key_room, budget_room.room AS budget_room
          FROM ready_window ready
          LEFT JOIN key_room ON key_room.concurrency_key = ready.concurrency_key
          LEFT JOIN budget_room ON budget_room.budget_name = ready.budget_name
         WHERE COALESCE(key_room.room, 1) >= 1 AND COALESCE(budget_room.room, 1) >= 1
      ), ranked AS (
        SELECT eligible.*,
               row_number() OVER (
                 PARTITION BY eligible.concurrency_key
                 ORDER BY eligible.priority DESC, eligible.sequence, eligible.task_id
               ) AS key_rank,
               row_number() OVER (
                 PARTITION BY eligible.budget_name
                 ORDER BY eligible.priority DESC, eligible.sequence, eligible.task_id
               ) AS budget_rank
          FROM eligible
      ), picked AS (
        SELECT runtime.task_id, ranked.priority, ranked.sequence
          FROM ranked
          JOIN workhorse.task_runtime runtime ON runtime.task_id = ranked.task_id
         WHERE runtime.state = 'ready'
           AND (ranked.key_room IS NULL OR ranked.key_rank <= ranked.key_room)
           AND (ranked.budget_room IS NULL OR ranked.budget_rank <= ranked.budget_room)
         ORDER BY ranked.priority DESC, ranked.sequence, ranked.task_id
         FOR NO KEY UPDATE OF runtime SKIP LOCKED
         LIMIT v_take
      )
      SELECT (SELECT array_agg(picked.task_id ORDER BY picked.priority DESC, picked.sequence,
                               picked.task_id)
                FROM picked),
             (SELECT count(*)::integer FROM ready_window),
             (SELECT COALESCE(bool_or(eligible.key_room IS NOT NULL
                                      AND eligible.budget_room IS NOT NULL), false)
                FROM eligible),
             (SELECT count(*)::integer FROM ranked
               WHERE (ranked.key_room IS NULL OR ranked.key_rank <= ranked.key_room)
                 AND (ranked.budget_room IS NULL OR ranked.budget_rank <= ranked.budget_room))
        INTO v_picked, v_window, v_mixed, v_fit;
    END IF;
    v_claimed := COALESCE(cardinality(v_picked), 0);
    EXIT WHEN v_claimed = 0;

    -- Spread the picked rows over the held shards' room. A queue with no concurrency policy puts
    -- them all on the first held shard, because only the rate bucket limits it.
    v_slots := '{}';
    v_left := v_claimed;
    FOREACH v_shard IN ARRAY v_held LOOP
      EXIT WHEN v_left = 0;
      v_part := CASE WHEN v_policy.queue_name IS NULL THEN v_left
        ELSE LEAST(v_left, GREATEST(v_shard_room[v_shard + 1], 0)) END;
      CONTINUE WHEN v_part = 0;
      v_slots := v_slots || array_fill(v_shard, ARRAY[v_part]);
      v_left := v_left - v_part;
    END LOOP;

    SELECT array_agg(fence ORDER BY fence) INTO v_fences
      FROM (
        SELECT nextval('workhorse.fence_token_seq') AS fence
          FROM generate_series(1, v_claimed)
      ) allocated;
    WITH activated AS (
      UPDATE workhorse.task_runtime runtime
         SET state = 'active', fence_token = v_fences[array_position(v_picked, runtime.task_id)],
             worker_id = p_worker_id,
             acquired_at = v_now, heartbeat_at = v_now, expires_at = v_expires,
             ready_at = NULL, sequence = NULL, wait_name = NULL,
             attempt_started_at = COALESCE(runtime.attempt_started_at, v_now),
             attempt_timeout_at = CASE
               WHEN task.execution_timeout_ms IS NULL THEN NULL
               ELSE v_now + make_interval(secs =>
                 (task.execution_timeout_ms - runtime.execution_used_ms)::double precision / 1000.0)
             END,
             error = NULL, updated_at = v_now,
             admission_shard = v_slots[array_position(v_picked, runtime.task_id)]
        FROM workhorse.task task
       WHERE runtime.task_id = ANY(v_picked) AND runtime.state = 'ready'
         AND task.id = runtime.task_id
         AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
      RETURNING runtime.task_id, runtime.current_attempt, runtime.fence_token,
                runtime.concurrency_key, runtime.budget_name
    ), events AS (
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      SELECT activated.task_id, activated.current_attempt, 'claimed',
             jsonb_build_object(
               'worker_id', p_worker_id, 'fence_token', activated.fence_token::text,
               'expires_at', v_expires
             )
        FROM activated
       ORDER BY activated.fence_token
    )
    SELECT array_agg(activated.task_id ORDER BY activated.fence_token),
           array_agg(activated.concurrency_key ORDER BY activated.fence_token),
           array_agg(activated.budget_name ORDER BY activated.fence_token)
      INTO v_ids, v_keys, v_budgets
      FROM activated;
    v_claimed := COALESCE(cardinality(v_ids), 0);

    -- Charge each bucket once for the starts this round admitted. The queue charge falls on the
    -- held shards in order, and each shard gives at most the tokens it holds. A missing bucket
    -- starts full, as in rate_limit_bucket_v1 and budget_bucket_v1, and refill never runs from a
    -- clock ahead of this claim.
    IF v_claimed > 0 AND v_rate_policy.queue_name IS NOT NULL THEN
      v_rest := v_claimed;
      v_charged := '{}';
      v_charges := '{}';
      FOREACH v_shard IN ARRAY v_held LOOP
        EXIT WHEN v_rest <= 0;
        v_charge := LEAST(v_shard_tokens[v_shard + 1], v_rest);
        CONTINUE WHEN v_charge <= 0;
        v_charged := v_charged || v_shard;
        v_charges := v_charges || (v_shard_tokens[v_shard + 1] - v_charge);
        v_rest := v_rest - v_charge;
      END LOOP;
      INSERT INTO workhorse.admission_shard AS shard_row(queue_name, shard, tokens, refilled_at)
      SELECT p_queue_name, charged.shard, charged.tokens, v_now
        FROM unnest(v_charged, v_charges) AS charged(shard, tokens)
      ON CONFLICT (queue_name, shard) DO UPDATE
         SET tokens = EXCLUDED.tokens,
             refilled_at = GREATEST(v_now, shard_row.refilled_at);
    END IF;
    IF v_claimed > 0 AND v_rate_policy.per_key_limit IS NOT NULL THEN
      INSERT INTO workhorse.rate_limit_bucket(
        queue_name, bucket_scope, bucket_key, tokens, refilled_at
      )
      SELECT DISTINCT p_queue_name, 'key', claimed.bucket_key, v_rate_policy.per_key_burst, v_now
        FROM unnest(v_keys) AS claimed(bucket_key)
       WHERE claimed.bucket_key IS NOT NULL
      ON CONFLICT DO NOTHING;
      UPDATE workhorse.rate_limit_bucket bucket
         SET tokens = LEAST(
               v_rate_policy.per_key_burst::numeric,
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM v_now - bucket.refilled_at) * 1000
               ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric
             ) - started.starts,
             refilled_at = GREATEST(v_now, bucket.refilled_at)
        FROM (
          SELECT claimed.bucket_key, count(*)::integer AS starts
            FROM unnest(v_keys) AS claimed(bucket_key)
           WHERE claimed.bucket_key IS NOT NULL
           GROUP BY claimed.bucket_key
        ) started
       WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
         AND bucket.bucket_key = started.bucket_key;
    END IF;
    IF v_claimed > 0 AND EXISTS (
      SELECT 1 FROM unnest(v_budgets) AS claimed(budget_name) WHERE claimed.budget_name IS NOT NULL
    ) THEN
      INSERT INTO workhorse.budget_bucket(budget_name, tokens, refilled_at)
      SELECT budget.budget_name, budget.rate_burst, v_now
        FROM workhorse.budget budget
       WHERE budget.rate_limit IS NOT NULL AND budget.budget_name = ANY(v_budgets)
      ON CONFLICT DO NOTHING;
      UPDATE workhorse.budget_bucket bucket
         SET tokens = LEAST(
               budget.rate_burst::numeric,
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM v_now - bucket.refilled_at) * 1000
               ) * budget.rate_limit::numeric / budget.rate_interval_ms::numeric
             ) - started.starts,
             refilled_at = GREATEST(v_now, bucket.refilled_at)
        FROM workhorse.budget budget, (
          SELECT claimed.budget_name, count(*)::integer AS starts
            FROM unnest(v_budgets) AS claimed(budget_name)
           WHERE claimed.budget_name IS NOT NULL
           GROUP BY claimed.budget_name
        ) started
       WHERE budget.budget_name = started.budget_name AND budget.rate_limit IS NOT NULL
         AND bucket.budget_name = started.budget_name;
    END IF;

    RETURN QUERY
      SELECT task.id, task.task_type, task.priority, task.payload, task.contract_version,
             task.result_max_bytes,
             cardinality(task.payload_redact_keys) > 0 OR cardinality(task.result_redact_keys) > 0,
             task.trace_context,
             runtime.current_attempt, task.max_attempts,
             task.retry_policy, task.deadline_at, task.execution_timeout_ms,
             runtime.attempt_timeout_at, runtime.fence_token, runtime.expires_at
        FROM unnest(v_ids) WITH ORDINALITY AS claimed(task_id, ordinality)
        JOIN workhorse.task task ON task.id = claimed.task_id
        JOIN workhorse.task_runtime runtime ON runtime.task_id = claimed.task_id
       ORDER BY claimed.ordinality;
    v_total := v_total + v_claimed;
    v_capped_out := v_queue_capped AND v_claimed >= v_take;
    -- A round stops the batch when it fills the limit or the held room. A direct round always stops
    -- it, because a short one found no further row it could take. A window round also stops the
    -- batch when its window held every ready row, no row had both a limited key and a limited
    -- budget, and it activated every row that fit.
    EXIT WHEN v_direct OR v_total >= p_limit OR v_capped_out
      OR (v_window < 100 AND NOT v_mixed AND v_claimed >= v_fit);
  END LOOP;
  -- Capacity this claim could not reach sat in a shard another claim held. Wake a worker for it,
  -- so a queue never waits with room for longer than one claim round.
  IF v_skipped AND v_short AND v_capped_out THEN
    PERFORM pg_notify('workhorse_tasks', p_queue_name);
  END IF;
END;
$$;

-- Claim one task. A fast-tier queue branches to fast_claim_v1, and a queue with a concurrency or
-- rate-limit policy admits through claim_policy_batch_v1 with a limit of one (ADR 0082). This body
-- claims from a queue with no policy. Concurrency remains a dispatch budget rather than a guarantee
-- that expired handler code has stopped executing, and a claim inspects at most the
-- highest-priority 100 ready rows. Budget capacity is counted across queues (ADR 0067), so a claim
-- locks every budget named in its priority window, one advisory lock per budget name, before it
-- reads the clock. It takes those locks in name order so two claims that share budgets cannot
-- deadlock. A claim that already holds budget locks from an earlier claim in the same transaction
-- passes p_wait_for_budgets = false: it takes only the locks it can get without waiting and leaves
-- rows naming any other budget for a later claim.
-- A claim whose window names a locked budget reads the window without locking and locks only the
-- candidate it takes (SM-801), so a claim that admits nothing writes no row lock. The admission
-- decision cannot go stale between that read and the lock, because a budget holds its advisory lock
-- until this transaction ends. A claim with no budget lock keeps the one-row fast path, which locks
-- the first ready row it can take. That row holds the line when it names a budget this claim never
-- locked, because reading past it has no bound.
-- No claim path calls it since SM-948; it remains a protocol function that claims one task.
CREATE OR REPLACE FUNCTION workhorse.claim_one_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer,
  p_wait_for_budgets boolean
) RETURNS TABLE (
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_budget_name text;
  v_budget_names text[] := '{}';
  v_task_id uuid;
  v_candidate_budget text;
  v_fence bigint;
  v_now timestamptz;
  v_expires timestamptz;
  v_control workhorse.queue_control%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF FOUND AND v_control.tier = 'fast' THEN
    IF NOT v_control.paused THEN
      RETURN QUERY SELECT * FROM workhorse.fast_claim_v1(
        p_queue_name, p_worker_id, 1, p_lease_ms, v_control.record_claims
      );
    END IF;
    RETURN;
  END IF;
  -- Shared queue locks allow unrelated claims to overlap while serializing first policy creation
  -- and pruning against deployment synchronization for this queue. A queue with a policy admits
  -- through its admission shards.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || p_queue_name, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:rate-limit-policy:' || p_queue_name, 0)
  );
  IF EXISTS (
    SELECT 1 FROM workhorse.concurrency_policy policy WHERE policy.queue_name = p_queue_name
  ) OR EXISTS (
    SELECT 1 FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = p_queue_name
  ) THEN
    RETURN QUERY SELECT * FROM workhorse.claim_policy_batch_v1(
      p_queue_name, p_worker_id, 1, p_lease_ms, p_wait_for_budgets
    );
    RETURN;
  END IF;
  -- Budget admission counts across queues. Lock each budget the priority window can name, in name
  -- order, before reading the clock. The window may still reach a row whose budget committed after
  -- this sample; that row is not admitted, because its lock was never taken in order.
  FOR v_budget_name IN
    SELECT DISTINCT sample.budget_name
      FROM (
        SELECT runtime.budget_name
          FROM workhorse.task_runtime runtime
         WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
         ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
         LIMIT 100
      ) sample
     WHERE sample.budget_name IS NOT NULL
     ORDER BY sample.budget_name
  LOOP
    IF p_wait_for_budgets THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budget:' || v_budget_name, 0));
    ELSIF NOT pg_try_advisory_xact_lock(
      hashtextextended('workhorse:budget:' || v_budget_name, 0)
    ) THEN
      CONTINUE;
    END IF;
    v_budget_names := v_budget_names || v_budget_name;
  END LOOP;
  v_now := clock_timestamp();
  v_expires := v_now + make_interval(secs => p_lease_ms::double precision / 1000.0);
  v_fence := nextval('workhorse.fence_token_seq');
  IF cardinality(v_budget_names) = 0 THEN
    -- No admission rule passes over a row here, so the first ready row this claim can lock is the
    -- row it takes. SKIP LOCKED walks past rows other claims already hold. A row whose budget
    -- committed after this claim sampled its budget names holds the line rather than being passed
    -- over, because reading past it has no bound.
    SELECT runtime.task_id, runtime.budget_name INTO v_task_id, v_candidate_budget
      FROM workhorse.task_runtime runtime
      JOIN workhorse.task task ON task.id = runtime.task_id
     WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
       AND (task.execution_timeout_ms IS NULL
         OR runtime.execution_used_ms < task.execution_timeout_ms)
       AND NOT EXISTS (
         SELECT 1 FROM workhorse.queue_control control
          WHERE control.queue_name = p_queue_name AND control.paused
       )
     ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
     FOR NO KEY UPDATE OF runtime SKIP LOCKED
     LIMIT 1;
    IF v_candidate_budget IS NOT NULL THEN RETURN; END IF;
  ELSE
    -- A budget can pass over a row, so the window reads without locking and only the chosen
    -- candidate is locked. A claim that admits nothing leaves every sampled row unlocked.
    WITH ready_window AS MATERIALIZED (
      SELECT runtime.task_id, runtime.concurrency_key, runtime.budget_name, runtime.priority,
             runtime.sequence
        FROM workhorse.task_runtime runtime
        JOIN workhorse.task task ON task.id = runtime.task_id
       WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
         AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
         AND (task.execution_timeout_ms IS NULL
           OR runtime.execution_used_ms < task.execution_timeout_ms)
         AND NOT EXISTS (
           SELECT 1 FROM workhorse.queue_control control
            WHERE control.queue_name = p_queue_name AND control.paused
         )
       ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
       LIMIT 100
    ), admissible AS (
      SELECT ready.task_id, ready.priority, ready.sequence
        FROM ready_window ready
       WHERE CASE
           WHEN ready.budget_name IS NULL THEN true
           WHEN ready.budget_name = ANY(v_budget_names)
             THEN workhorse.budget_admission_v1(ready.budget_name, v_now)
           ELSE false
         END
    )
    SELECT runtime.task_id INTO v_task_id
      FROM admissible
      JOIN workhorse.task_runtime runtime ON runtime.task_id = admissible.task_id
     WHERE runtime.state = 'ready'
     ORDER BY admissible.priority DESC, admissible.sequence, admissible.task_id
     FOR NO KEY UPDATE OF runtime SKIP LOCKED
     LIMIT 1;
  END IF;
  IF v_task_id IS NULL THEN RETURN; END IF;

  UPDATE workhorse.task_runtime runtime
     SET state = 'active', fence_token = v_fence, worker_id = p_worker_id,
         acquired_at = v_now, heartbeat_at = v_now, expires_at = v_expires,
         ready_at = NULL, sequence = NULL, wait_name = NULL,
         attempt_started_at = COALESCE(runtime.attempt_started_at, v_now),
         attempt_timeout_at = CASE
           WHEN task.execution_timeout_ms IS NULL THEN NULL
           ELSE v_now + make_interval(secs =>
             (task.execution_timeout_ms - runtime.execution_used_ms)::double precision / 1000.0)
         END,
         error = NULL, updated_at = v_now
    FROM workhorse.task task
   WHERE runtime.task_id = v_task_id AND runtime.state = 'ready' AND task.id = runtime.task_id
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
  RETURNING runtime.* INTO v_runtime;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_runtime.budget_name IS NOT NULL THEN
    PERFORM * FROM workhorse.budget_bucket_v1(v_runtime.budget_name, v_now, true);
  END IF;

  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (v_runtime.task_id, v_runtime.current_attempt, 'claimed',
      jsonb_build_object('worker_id', p_worker_id, 'fence_token', v_fence::text, 'expires_at', v_expires));
  RETURN QUERY
    SELECT task.id, task.task_type, task.priority, task.payload, task.contract_version, task.result_max_bytes,
           cardinality(task.payload_redact_keys) > 0 OR cardinality(task.result_redact_keys) > 0,
           task.trace_context,
           v_runtime.current_attempt, task.max_attempts,
           task.retry_policy, task.deadline_at, task.execution_timeout_ms,
           v_runtime.attempt_timeout_at, v_fence, v_expires
      FROM workhorse.task task WHERE task.id = v_runtime.task_id;
END;
$$;

-- Claim several tasks through one client round trip. A fast-tier queue branches to fast_claim_v1.
-- Every other queue admits the batch as a set in claim_policy_batch_v1 (SM-915). A queue with no
-- concurrency or rate-limit policy once repeated claim_one_v1 per task, which repeated the policy
-- locks, the budget sample and the key-bucket cleanup for every start; it now takes the same set
-- path (SM-948). A queue with a policy admits through its admission shards (ADR 0082).
CREATE OR REPLACE FUNCTION workhorse.claim_many_v1(
  p_queue_name text,
  p_worker_id text,
  p_limit integer,
  p_lease_ms integer DEFAULT 30000
) RETURNS TABLE (
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_control workhorse.queue_control%ROWTYPE;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
  END IF;
  -- A fast-tier queue has no admission policy to apply row by row, so it claims the whole batch in
  -- one statement.
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF FOUND AND v_control.tier = 'fast' THEN
    IF p_worker_id IS NULL OR p_worker_id = '' THEN
      RAISE EXCEPTION 'worker_id must not be empty';
    END IF;
    IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
      RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
    END IF;
    IF NOT v_control.paused THEN
      RETURN QUERY SELECT * FROM workhorse.fast_claim_v1(
        p_queue_name, p_worker_id, p_limit, p_lease_ms, v_control.record_claims
      );
    END IF;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM workhorse.claim_policy_batch_v1(
    p_queue_name, p_worker_id, p_limit, p_lease_ms, true
  );
END;
$$;
