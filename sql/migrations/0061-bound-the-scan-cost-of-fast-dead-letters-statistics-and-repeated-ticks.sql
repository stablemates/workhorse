-- workhorse-migration: {"kind":"additive"}

-- Bound the scan cost of fast-tier dead letters, fast-tier statistics, and repeated lease scans
-- (SM-1167).

-- list_dead_letters_v1 had no index that selects failed fast outcomes, so its first page read every
-- fast outcome. A partial index on failed fast outcomes now orders them as the full tier's
-- task_outcome_failed_finished_idx does. Building it reads fast_task_outcome once and blocks fast
-- outcome writes until the migration commits.
--
-- aggregate_stats_v1 materialized every live fast row, and every fast outcome closed since the
-- window opened, before filtering by time. It now leaves out rows that can hold no fact inside the
-- window, so a backlog enqueued earlier is never materialized.
--
-- Every worker ticks once per interval, and each tick's expired-lease scan read every active lease.
-- An index on expires_at would cost every heartbeat its HOT update. tick_v1 now records when it
-- last ran that scan in maintenance_state.lease_recovery_started_at. It skips the scan when another
-- tick ran it within half the shortest maintenance interval of the live registered workers.
-- Promotion and the deadline and timeout scans still run on every tick.

ALTER TABLE workhorse.maintenance_state
  ADD COLUMN IF NOT EXISTS lease_recovery_started_at timestamptz;

-- The dead-letter listing pages failed outcomes newest first, as task_outcome_failed_finished_idx
-- does for the full tier. Without it the listing reads every fast outcome to find the failures.
CREATE INDEX IF NOT EXISTS fast_task_outcome_failed_finished_idx
  ON workhorse.fast_task_outcome (finished_at DESC, task_id DESC) WHERE state = 'failed';

CREATE OR REPLACE FUNCTION workhorse.aggregate_stats_v1(
  p_from timestamptz, p_to timestamptz, p_group_limit integer DEFAULT 200
) RETURNS TABLE (
  bucket_start timestamptz, queue_name text, task_type text, enqueued integer,
  task_succeeded integer, task_failed integer, task_canceled integer,
  attempt_succeeded integer, attempt_failed integer, attempt_retry integer,
  attempt_lease_expired integer, attempt_canceled integer, attempt_other integer,
  attempt_duration_ms bigint,
  wait_sketch jsonb,
  last_attempt_at timestamptz, last_error text, last_error_at timestamptz
)
LANGUAGE sql STABLE
AS $$
  -- A fast-tier task writes no events and, by default, no attempt rows. Its live row and its
  -- outcome row carry the same facts: the enqueue time, one errors entry per closed attempt, and
  -- the final attempt. Every such fact happened before the outcome row closed, so outcome rows that
  -- closed before p_from cannot contribute to the window.
  --
  -- Every fact also happened at or after enqueued_at, so a row enqueued at or after p_to cannot
  -- contribute. A live row's earlier attempts closed at or before its run_at, because a retry sets
  -- run_at to the close time plus the delay and every other write sets it to the current time. A
  -- live row whose enqueue, current claim, and retry all precede p_from therefore has no fact in
  -- the window, so a backlog enqueued earlier is never materialized.
  WITH fast_row AS MATERIALIZED (
    SELECT runtime.task_id, runtime.queue_name, runtime.task_type, runtime.enqueued_at,
           runtime.attempt, runtime.claimed_at, runtime.errors,
           NULL::text AS state, NULL::text AS closed_as, NULL::jsonb AS error,
           NULL::timestamptz AS finished_at
      FROM workhorse.fast_task_runtime runtime
     WHERE runtime.enqueued_at < p_to
       AND (
         runtime.enqueued_at >= p_from
         OR runtime.claimed_at >= p_from
         OR (runtime.attempt > 1 AND runtime.run_at >= p_from)
       )
     UNION ALL
    SELECT outcome.task_id, outcome.queue_name, outcome.task_type, outcome.enqueued_at,
           outcome.attempt, outcome.claimed_at, outcome.errors,
           outcome.state, outcome.closed_as, outcome.error, outcome.finished_at
      FROM workhorse.fast_task_outcome outcome
     WHERE outcome.finished_at >= p_from AND outcome.enqueued_at < p_to
  ), fast_attempt AS (
    SELECT fast_row.task_id, fast_row.queue_name, fast_row.task_type, entry.attempt,
           entry.outcome, entry.claimed_at, entry.finished_at, entry.error
      FROM fast_row
     CROSS JOIN LATERAL jsonb_to_recordset(fast_row.errors) AS entry(
       attempt integer, claimed_at timestamptz, finished_at timestamptz, outcome text, error jsonb
     )
     UNION ALL
    -- A queue that records attempts already wrote the final attempt to attempt_history.
    SELECT fast_row.task_id, fast_row.queue_name, fast_row.task_type, fast_row.attempt,
           COALESCE(fast_row.closed_as, fast_row.state), fast_row.claimed_at, fast_row.finished_at,
           CASE WHEN fast_row.state <> 'succeeded' THEN fast_row.error END
      FROM fast_row
     WHERE fast_row.state IS NOT NULL AND fast_row.claimed_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM workhorse.attempt_history recorded
          WHERE recorded.task_id = fast_row.task_id AND recorded.attempt = fast_row.attempt
       )
  ), enqueue_source AS (
    SELECT date_bin('1 minute', enqueue.occurred_at,
                    timestamp '2000-01-01' AT TIME ZONE 'UTC') AS bucket,
           enqueue.queue, enqueue.type,
           count(*)::integer AS enqueued
      FROM (
        SELECT event.occurred_at, task.queue_name AS queue, task.task_type AS type
          FROM workhorse.task_event event
          JOIN workhorse.task task ON task.id = event.task_id
         WHERE event.event_type = 'enqueued'
         UNION ALL
        SELECT fast_row.enqueued_at, fast_row.queue_name, fast_row.task_type
          FROM fast_row
      ) enqueue
     WHERE enqueue.occurred_at >= p_from AND enqueue.occurred_at < p_to
     GROUP BY 1, 2, 3
  ), attempt_source AS (
    SELECT date_bin('1 minute', history.occurred_at,
                    timestamp '2000-01-01' AT TIME ZONE 'UTC') AS bucket,
           history.queue_name AS queue, history.task_type AS type,
           count(*) FILTER (WHERE history.outcome = 'succeeded')::integer AS attempt_succeeded,
           count(*) FILTER (WHERE history.outcome = 'failed')::integer AS attempt_failed,
           count(*) FILTER (WHERE history.outcome = 'retry')::integer AS attempt_retry,
           count(*) FILTER (WHERE history.outcome = 'lease_expired')::integer AS attempt_lease_expired,
           count(*) FILTER (WHERE history.outcome = 'canceled')::integer AS attempt_canceled,
           count(*) FILTER (
             WHERE history.outcome IN ('deadline_exceeded', 'timeout')
           )::integer AS attempt_other,
           COALESCE(sum(GREATEST(
             0, round(extract(epoch FROM history.finished_at - history.started_at) * 1000)
           )), 0)::bigint AS attempt_duration_ms,
           max(history.finished_at) AS last_attempt_at,
           (array_agg(
              left(COALESCE(
                history.error->>'message', history.error->>'code', history.error::text
              ), 500)
              ORDER BY history.finished_at DESC, history.attempt_id DESC
            ) FILTER (WHERE history.error IS NOT NULL))[1] AS last_error,
           max(history.finished_at) FILTER (WHERE history.error IS NOT NULL) AS last_error_at
      FROM (
        SELECT recorded.attempt_id, task.queue_name, task.task_type, recorded.outcome,
               recorded.started_at, recorded.finished_at, recorded.error, recorded.occurred_at
          FROM workhorse.attempt_history recorded
          JOIN workhorse.task task ON task.id = recorded.task_id
         WHERE recorded.occurred_at >= p_from AND recorded.occurred_at < p_to
         UNION ALL
        SELECT md5(fast_attempt.task_id::text || ':' || fast_attempt.attempt || ':attempt')::uuid,
               fast_attempt.queue_name, fast_attempt.task_type, fast_attempt.outcome,
               fast_attempt.claimed_at, fast_attempt.finished_at, fast_attempt.error,
               fast_attempt.finished_at
          FROM fast_attempt
         WHERE fast_attempt.finished_at >= p_from AND fast_attempt.finished_at < p_to
      ) history
     GROUP BY 1, 2, 3
  ), wait_bin_source AS (
    SELECT date_bin('1 minute', first_claim.claimed_at,
                    timestamp '2000-01-01' AT TIME ZONE 'UTC') AS bucket,
           first_claim.queue, first_claim.type,
           workhorse.stat_sketch_index_v1(
             extract(epoch FROM first_claim.claimed_at - first_claim.enqueued_at) * 1000
           ) AS bin,
           count(*)::bigint AS samples
      FROM (
        SELECT claimed.occurred_at AS claimed_at, enqueued.occurred_at AS enqueued_at,
               task.queue_name AS queue, task.task_type AS type
          FROM workhorse.task_event claimed
          JOIN workhorse.task_event enqueued ON enqueued.task_id = claimed.task_id
           AND enqueued.event_type = 'enqueued'
           AND enqueued.occurred_at <= claimed.occurred_at
          JOIN workhorse.task task ON task.id = claimed.task_id
         WHERE claimed.event_type = 'claimed' AND claimed.attempt = 1
           AND claimed.occurred_at >= p_from AND claimed.occurred_at < p_to
         UNION ALL
        -- A fast-tier task has no enqueued event, so the join above never counts it twice. Its
        -- first claim is on the row itself, in an errors entry, or in a recorded attempt.
        SELECT fast_claim.claimed_at, fast_claim.enqueued_at,
               fast_claim.queue_name, fast_claim.task_type
          FROM (
            SELECT fast_row.enqueued_at, fast_row.queue_name, fast_row.task_type,
                   CASE
                     WHEN fast_row.attempt = 1 THEN fast_row.claimed_at
                     ELSE COALESCE(
                       (SELECT (entry->>'claimed_at')::timestamptz
                          FROM jsonb_array_elements(fast_row.errors) entry
                         WHERE (entry->>'attempt')::integer = 1),
                       (SELECT recorded.claimed_at FROM workhorse.attempt_history recorded
                         WHERE recorded.task_id = fast_row.task_id AND recorded.attempt = 1)
                     )
                   END AS claimed_at
              FROM fast_row
          ) fast_claim
         WHERE fast_claim.claimed_at >= p_from AND fast_claim.claimed_at < p_to
      ) first_claim
     GROUP BY 1, 2, 3, 4
  ), wait_source AS (
    SELECT bucket, queue, type,
           jsonb_object_agg(bin::text, samples ORDER BY bin) AS wait_sketch
      FROM wait_bin_source
     GROUP BY 1, 2, 3
  ), outcome_source AS (
    SELECT date_bin('1 minute', outcome.finished_at,
                    timestamp '2000-01-01' AT TIME ZONE 'UTC') AS bucket,
           outcome.queue_name AS queue, outcome.task_type AS type,
           count(*) FILTER (WHERE outcome.state = 'succeeded')::integer AS task_succeeded,
           count(*) FILTER (WHERE outcome.state = 'failed')::integer AS task_failed,
           count(*) FILTER (WHERE outcome.state = 'canceled')::integer AS task_canceled
      FROM (
        SELECT full_outcome.state, full_outcome.finished_at,
               task.queue_name, task.task_type
          FROM workhorse.task_outcome full_outcome
          JOIN workhorse.task task ON task.id = full_outcome.task_id
         WHERE full_outcome.finished_at >= p_from AND full_outcome.finished_at < p_to
         UNION ALL
        SELECT fast_row.state, fast_row.finished_at, fast_row.queue_name, fast_row.task_type
          FROM fast_row
         WHERE fast_row.state IS NOT NULL AND fast_row.finished_at < p_to
      ) outcome
     GROUP BY 1, 2, 3
  ), measure AS (
    SELECT source.bucket, source.queue, source.type, source.enqueued,
           0 AS task_succeeded, 0 AS task_failed, 0 AS task_canceled,
           0 AS attempt_succeeded, 0 AS attempt_failed, 0 AS attempt_retry,
           0 AS attempt_lease_expired, 0 AS attempt_canceled, 0 AS attempt_other,
           0::bigint AS attempt_duration_ms,
           '{}'::jsonb AS wait_sketch,
           NULL::timestamptz AS last_attempt_at, NULL::text AS last_error,
           NULL::timestamptz AS last_error_at
      FROM enqueue_source source
     UNION ALL
    SELECT source.bucket, source.queue, source.type, 0,
           0, 0, 0,
           source.attempt_succeeded, source.attempt_failed, source.attempt_retry,
           source.attempt_lease_expired, source.attempt_canceled, source.attempt_other,
           source.attempt_duration_ms,
           '{}'::jsonb,
           source.last_attempt_at, source.last_error, source.last_error_at
      FROM attempt_source source
     UNION ALL
    SELECT source.bucket, source.queue, source.type, 0,
           0, 0, 0,
           0, 0, 0,
           0, 0, 0,
           0::bigint,
           source.wait_sketch,
           NULL::timestamptz, NULL::text, NULL::timestamptz
      FROM wait_source source
     UNION ALL
    SELECT source.bucket, source.queue, source.type, 0,
           source.task_succeeded, source.task_failed, source.task_canceled,
           0, 0, 0,
           0, 0, 0,
           0::bigint,
           '{}'::jsonb,
           NULL::timestamptz, NULL::text, NULL::timestamptz
      FROM outcome_source source
  ), total AS (
    SELECT measure.bucket, measure.queue, measure.type,
           sum(measure.enqueued)::integer AS enqueued,
           sum(measure.task_succeeded)::integer AS task_succeeded,
           sum(measure.task_failed)::integer AS task_failed,
           sum(measure.task_canceled)::integer AS task_canceled,
           sum(measure.attempt_succeeded)::integer AS attempt_succeeded,
           sum(measure.attempt_failed)::integer AS attempt_failed,
           sum(measure.attempt_retry)::integer AS attempt_retry,
           sum(measure.attempt_lease_expired)::integer AS attempt_lease_expired,
           sum(measure.attempt_canceled)::integer AS attempt_canceled,
           sum(measure.attempt_other)::integer AS attempt_other,
           sum(measure.attempt_duration_ms)::bigint AS attempt_duration_ms,
           workhorse.stat_sketch_merge_v1(array_agg(measure.wait_sketch)) AS wait_sketch,
           max(measure.last_attempt_at) AS last_attempt_at,
           (array_agg(measure.last_error ORDER BY measure.last_error_at DESC NULLS LAST)
             FILTER (WHERE measure.last_error IS NOT NULL))[1] AS last_error,
           max(measure.last_error_at) AS last_error_at
      FROM measure
     GROUP BY 1, 2, 3
  ), fold AS (
    SELECT total.bucket, total.queue, total.type,
           CASE
             WHEN row_number() OVER (
               PARTITION BY total.bucket
               ORDER BY total.enqueued + total.attempt_succeeded + total.attempt_failed
                        + total.attempt_retry + total.attempt_lease_expired
                        + total.attempt_canceled + total.attempt_other DESC,
                        total.queue, total.type
             ) <= p_group_limit
             THEN total.type
             ELSE workhorse.stat_overflow_type_v1()
           END AS fold_type
      FROM total
  ), folded AS (
    SELECT total.bucket, total.queue, fold.fold_type,
           sum(total.enqueued)::integer AS enqueued,
           sum(total.task_succeeded)::integer AS task_succeeded,
           sum(total.task_failed)::integer AS task_failed,
           sum(total.task_canceled)::integer AS task_canceled,
           sum(total.attempt_succeeded)::integer AS attempt_succeeded,
           sum(total.attempt_failed)::integer AS attempt_failed,
           sum(total.attempt_retry)::integer AS attempt_retry,
           sum(total.attempt_lease_expired)::integer AS attempt_lease_expired,
           sum(total.attempt_canceled)::integer AS attempt_canceled,
           sum(total.attempt_other)::integer AS attempt_other,
           sum(total.attempt_duration_ms)::bigint AS attempt_duration_ms,
           workhorse.stat_sketch_merge_v1(array_agg(total.wait_sketch)) AS wait_sketch,
           max(total.last_attempt_at) AS last_attempt_at,
           (array_agg(total.last_error ORDER BY total.last_error_at DESC NULLS LAST)
             FILTER (WHERE total.last_error IS NOT NULL))[1] AS last_error,
           max(total.last_error_at) AS last_error_at
      FROM total
      JOIN fold ON fold.bucket = total.bucket AND fold.queue = total.queue
                AND fold.type = total.type
     GROUP BY 1, 2, 3
  )
  SELECT folded.bucket, folded.queue, folded.fold_type, folded.enqueued,
         folded.task_succeeded, folded.task_failed, folded.task_canceled,
         folded.attempt_succeeded, folded.attempt_failed, folded.attempt_retry,
         folded.attempt_lease_expired, folded.attempt_canceled, folded.attempt_other,
         folded.attempt_duration_ms,
         folded.wait_sketch,
         folded.last_attempt_at, folded.last_error, folded.last_error_at
    FROM folded
$$;

CREATE OR REPLACE FUNCTION workhorse.recover_expired_v1(
  p_limit integer DEFAULT 100, p_retry_delay_ms integer DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_task workhorse.task%ROWTYPE;
  v_state text;
  v_run_at timestamptz;
  v_error jsonb := jsonb_build_object('name', 'LeaseExpired', 'message', 'worker lease expired');
  v_count integer := 0;
  v_retry record;
  v_retry_delay_ms bigint;
  v_retry_source text;
  v_envelope jsonb;
  v_expired_leases integer := 0;
  v_retried integer := 0;
  v_retry_dimensions jsonb := '[]'::jsonb;
  v_notify_queues text[] := '{}';
  v_notify_queue text;
  -- The three scans compare against one stable time so the deadline and timeout comparisons
  -- seek their partial indexes, and the three scans agree on which work is due.
  v_now timestamptz := clock_timestamp();
  v_limit integer := GREATEST(1, LEAST(p_limit, 10000));
  v_fast record;
  -- tick_v1 sets this when another tick ran the expired-lease scan within half an interval.
  v_skip_expired_leases boolean := COALESCE(
    NULLIF(current_setting('workhorse.recovery_skip_expired_leases', true), ''), 'false'
  )::boolean;
BEGIN
  PERFORM set_config('workhorse.recovery_scanned_expired_leases', 'false', true);
  PERFORM set_config('workhorse.recovery_expired_leases', '0', true);
  PERFORM set_config('workhorse.recovery_retried', '0', true);
  PERFORM set_config('workhorse.recovery_retry_dimensions', '[]', true);
  -- Fast-tier rows share this call's limit and counters, so one recovery pass covers both tiers.
  SELECT * INTO STRICT v_fast
    FROM workhorse.fast_recover_expired_v1(v_limit, p_retry_delay_ms, v_now);
  v_count := v_fast.recovered;
  v_expired_leases := v_fast.expired_leases;
  v_retried := v_fast.retried;
  v_retry_dimensions := v_fast.retry_dimensions;
  v_notify_queues := v_fast.queues;
  FOR v_runtime IN
    SELECT runtime.* FROM workhorse.task_runtime runtime
     WHERE runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= v_now
       AND (
         runtime.state <> 'active'
         OR runtime.attempt_timeout_at IS NULL
         OR runtime.attempt_timeout_at > v_now
         OR runtime.deadline_at <= runtime.attempt_timeout_at
       )
     ORDER BY runtime.deadline_at, runtime.task_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(0, v_limit - v_count)
  LOOP
    IF workhorse.terminalize_deadline_v1(v_runtime.task_id) THEN
      v_count := v_count + 1;
      v_notify_queues := array_append(v_notify_queues, v_runtime.queue_name);
    END IF;
  END LOOP;

  IF v_count < v_limit THEN
    FOR v_runtime IN
      SELECT runtime.* FROM workhorse.task_runtime runtime
       WHERE runtime.state = 'active' AND runtime.attempt_timeout_at IS NOT NULL
         AND runtime.attempt_timeout_at <= v_now
         AND (
           runtime.deadline_at IS NULL
           OR runtime.deadline_at > v_now
           OR runtime.attempt_timeout_at < runtime.deadline_at
         )
       ORDER BY runtime.attempt_timeout_at, runtime.task_id FOR UPDATE SKIP LOCKED
       LIMIT GREATEST(0, v_limit - v_count)
    LOOP
      SELECT * INTO STRICT v_task FROM workhorse.task task WHERE task.id = v_runtime.task_id;
      IF workhorse.timeout_owned_v1(
        v_runtime.task_id, v_runtime.worker_id, v_runtime.fence_token
      ) THEN
        v_count := v_count + 1;
        v_notify_queues := array_append(v_notify_queues, v_task.queue_name);
        IF v_runtime.current_attempt < v_task.max_attempts THEN
          v_retried := v_retried + 1;
          v_retry_dimensions := v_retry_dimensions || jsonb_build_array(jsonb_build_object(
            'queue', v_task.queue_name, 'type', v_task.task_type
          ));
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF v_count >= v_limit THEN
    PERFORM set_config('workhorse.recovery_expired_leases', v_expired_leases::text, true);
    PERFORM set_config('workhorse.recovery_retried', v_retried::text, true);
    PERFORM set_config('workhorse.recovery_retry_dimensions', v_retry_dimensions::text, true);
    FOR v_notify_queue IN
      SELECT DISTINCT affected.queue_name
        FROM unnest(v_notify_queues) AS affected(queue_name)
       ORDER BY affected.queue_name
    LOOP
      PERFORM pg_notify('workhorse_tasks', v_notify_queue);
    END LOOP;
    RETURN v_count;
  END IF;

  -- Reaching this scan is what tick_v1 records, so an early return above never spaces the next one.
  PERFORM set_config(
    'workhorse.recovery_scanned_expired_leases', (NOT v_skip_expired_leases)::text, true
  );
  FOR v_runtime IN
    SELECT r.* FROM workhorse.task_runtime r
     WHERE NOT v_skip_expired_leases
       AND r.state = 'active' AND r.expires_at <= v_now
       AND (
         r.cancel_requested_at IS NOT NULL
         OR r.deadline_at IS NULL OR r.deadline_at > v_now
       )
       AND (
         r.cancel_requested_at IS NOT NULL
         OR r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now
       )
     ORDER BY r.expires_at, r.task_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(0, v_limit - v_count)
  LOOP
    SELECT * INTO STRICT v_task FROM workhorse.task j WHERE j.id = v_runtime.task_id;
    IF v_runtime.cancel_requested_at IS NOT NULL THEN
      v_envelope := workhorse.cancellation_envelope_v1(
        v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
      );
      DELETE FROM workhorse.task_runtime r
       WHERE r.task_id = v_runtime.task_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp()
         AND r.cancel_requested_at IS NOT NULL;
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.task_outcome(
        task_id, state, current_attempt, fence_token, run_at, error, history_through_at
      )
        VALUES (
          v_runtime.task_id, 'canceled', v_runtime.current_attempt, v_runtime.fence_token,
          v_runtime.run_at, v_envelope, clock_timestamp()
        );
      INSERT INTO workhorse.attempt_history(
        task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
      ) VALUES (
        v_runtime.task_id, v_runtime.current_attempt, v_runtime.fence_token,
        v_runtime.worker_id, 'canceled', v_runtime.attempt_started_at,
        v_runtime.acquired_at, v_envelope
      );
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
        VALUES (
          v_runtime.task_id,
          v_runtime.current_attempt,
          'canceled',
          jsonb_build_object(
            'requested_at', v_runtime.cancel_requested_at,
            'requested_by', v_runtime.cancel_requested_by,
            'reason', v_runtime.cancel_reason,
            'fence_token', v_runtime.fence_token::text,
            'source', 'recovered'
          )
        );
      v_count := v_count + 1;
      v_expired_leases := v_expired_leases + 1;
      v_notify_queues := array_append(v_notify_queues, v_task.queue_name);
      CONTINUE;
    END IF;
    IF v_runtime.current_attempt < v_task.max_attempts THEN
      SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
        v_runtime.task_id, v_runtime.current_attempt, v_task.retry_policy,
        v_runtime.previous_retry_delay_ms, p_retry_delay_ms, 'lease-recovery-immediate'
      );
      v_retry_delay_ms := v_retry.delay_ms;
      v_retry_source := v_retry.source;
      v_run_at := clock_timestamp() + make_interval(secs => v_retry_delay_ms::double precision / 1000.0);
      v_state := CASE WHEN v_retry_delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
      UPDATE workhorse.task_runtime r
         SET state = v_state, current_attempt = r.current_attempt + 1, fence_token = 0,
             run_at = v_run_at,
             ready_at = CASE WHEN v_state = 'ready' THEN clock_timestamp() END,
             sequence = CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
             worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
             wait_name = NULL, attempt_started_at = NULL, execution_used_ms = 0,
             attempt_timeout_at = NULL,
             previous_retry_delay_ms = v_retry.next_previous_retry_delay_ms,
             error = v_error, updated_at = clock_timestamp()
       WHERE r.task_id = v_runtime.task_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
      v_retried := v_retried + 1;
      v_retry_dimensions := v_retry_dimensions || jsonb_build_array(jsonb_build_object(
        'queue', v_task.queue_name, 'type', v_task.task_type
      ));
    ELSE
      v_state := 'failed';
      v_retry_delay_ms := NULL;
      v_retry_source := 'terminal';
      DELETE FROM workhorse.task_runtime r
       WHERE r.task_id = v_runtime.task_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.task_outcome(
        task_id, state, current_attempt, fence_token, run_at, error, history_through_at
      ) VALUES (
        v_runtime.task_id, 'failed', v_runtime.current_attempt, v_runtime.fence_token,
        v_runtime.run_at, v_error, clock_timestamp()
      );
    END IF;
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    )
      VALUES (v_runtime.task_id, v_runtime.current_attempt, v_runtime.fence_token, v_runtime.worker_id,
        'lease_expired', v_runtime.attempt_started_at, v_runtime.acquired_at, v_error);
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (v_runtime.task_id, v_runtime.current_attempt, 'lease_expired',
        jsonb_build_object('fence_token', v_runtime.fence_token::text, 'next_state', v_state,
          'retry_policy', v_task.retry_policy, 'retry_delay_ms', v_retry_delay_ms,
          'retry_delay_source', v_retry_source));
    v_count := v_count + 1;
    v_expired_leases := v_expired_leases + 1;
    v_notify_queues := array_append(v_notify_queues, v_task.queue_name);
  END LOOP;
  PERFORM set_config('workhorse.recovery_expired_leases', v_expired_leases::text, true);
  PERFORM set_config('workhorse.recovery_retried', v_retried::text, true);
  PERFORM set_config('workhorse.recovery_retry_dimensions', v_retry_dimensions::text, true);
  FOR v_notify_queue IN
    SELECT DISTINCT affected.queue_name
      FROM unnest(v_notify_queues) AS affected(queue_name)
     ORDER BY affected.queue_name
  LOOP
    PERFORM pg_notify('workhorse_tasks', v_notify_queue);
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.tick_v1(
  p_promote_limit integer DEFAULT 1000, p_recover_limit integer DEFAULT 1000
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb,
  expired_leases integer, retried integer, retry_dimensions jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_started_at timestamptz;
  v_tick_started_at timestamptz;
  v_tick_completed_at timestamptz;
  v_had_error boolean := false;
  v_rows_affected integer := 0;
  v_phases jsonb := '[]'::jsonb;
  v_gate_ms integer;
  v_lease_recovery_started_at timestamptz;
  v_scan_leases boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:tick', 0)) THEN
    RETURN QUERY VALUES
      ('promote'::text, 0, 0, true, NULL::jsonb, 0, 0, '[]'::jsonb),
      ('recover'::text, 0, 0, true, NULL::jsonb, 0, 0, '[]'::jsonb);
    RETURN;
  END IF;

  v_tick_started_at := clock_timestamp();
  -- Every worker ticks once per interval, and the lock stops only overlapping ticks. Promotion and
  -- the deadline and timeout scans seek indexes, so a tick that finds nothing due costs little. The
  -- expired-lease scan reads every active lease, because an index on expires_at would cost every
  -- heartbeat its HOT update. That scan therefore runs only when no tick ran it within half the
  -- shortest maintenance interval of the live registered workers. The scan still runs at least
  -- once per interval of the worker that ticks most often. A worker is live while its last
  -- heartbeat is within its own lease, as in worker_client_protocols_v1. With no live
  -- registration, as for a direct caller, every tick runs the scan.
  SELECT min(registry.maintenance_interval_ms) INTO v_gate_ms
    FROM workhorse.worker_registry registry
   WHERE registry.last_heartbeat_at
         >= clock_timestamp() - make_interval(secs => registry.lease_ms / 1000.0);
  SELECT state.lease_recovery_started_at INTO v_lease_recovery_started_at
    FROM workhorse.maintenance_state state
   WHERE state.routine_name = 'tick';
  v_scan_leases := NOT COALESCE(
    v_lease_recovery_started_at <= v_tick_started_at
      AND v_lease_recovery_started_at
        > v_tick_started_at - make_interval(secs => v_gate_ms / 2000.0),
    false
  );
  UPDATE workhorse.maintenance_state
     SET last_started_at = v_tick_started_at, updated_at = v_tick_started_at
   WHERE routine_name = 'tick';

  phase := 'promote';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  expired_leases := 0;
  retried := 0;
  retry_dimensions := '[]'::jsonb;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.promote_v1(p_promote_limit);
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_had_error := true;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  v_rows_affected := v_rows_affected + rows_affected;
  v_phases := v_phases || jsonb_build_array(jsonb_build_object(
    'phase', phase, 'rowsAffected', rows_affected, 'durationMs', duration_ms,
    'error', error
  ));
  RETURN NEXT;

  phase := 'recover';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  PERFORM set_config('workhorse.recovery_skip_expired_leases', (NOT v_scan_leases)::text, true);
  BEGIN
    SELECT recovery.rows_affected, recovery.expired_leases, recovery.retried,
           recovery.retry_dimensions
      INTO rows_affected, expired_leases, retried, retry_dimensions
      FROM workhorse.recover_expired_telemetry_v1(p_recover_limit) recovery;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_had_error := true;
  END;
  PERFORM set_config('workhorse.recovery_skip_expired_leases', 'false', true);
  -- Only a scan that ran spaces the next one. Recovery skips the scan when deadline, timeout, or
  -- fast-tier work fills its limit, and a failed phase rolls the scan back with this setting.
  IF error IS NULL
     AND current_setting('workhorse.recovery_scanned_expired_leases', true) = 'true' THEN
    UPDATE workhorse.maintenance_state
       SET lease_recovery_started_at = v_tick_started_at
     WHERE routine_name = 'tick';
  END IF;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  v_rows_affected := v_rows_affected + rows_affected;
  v_phases := v_phases || jsonb_build_array(jsonb_build_object(
    'phase', phase, 'rowsAffected', rows_affected, 'durationMs', duration_ms,
    'error', error, 'expiredLeases', expired_leases, 'retried', retried
  ));
  RETURN NEXT;

  v_tick_completed_at := clock_timestamp();
  IF NOT v_had_error THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_at = v_tick_completed_at, updated_at = v_tick_completed_at
     WHERE routine_name = 'tick';
  END IF;
  IF v_had_error OR (
    v_rows_affected > 0
    AND NOT EXISTS (
      SELECT 1
        FROM workhorse.maintenance_run recent
       WHERE recent.routine_name = 'tick'
         AND recent.outcome = 'succeeded'
         AND recent.started_at > v_tick_started_at - interval '1 minute'
    )
  ) THEN
    PERFORM workhorse.record_maintenance_run_internal_v1(
      'tick', v_tick_started_at, v_tick_completed_at,
      CASE WHEN v_had_error THEN 'failed' ELSE 'succeeded' END,
      v_rows_affected, v_phases
    );
  END IF;
END;
$$;
