-- workhorse-migration: {"kind":"contract","retiresProtocolVersions":[1,2,3,4]}

-- Add a fast task tier (SM-918, ADR 0077).

-- A queue now carries a tier. A full-tier queue keeps every feature and its current tables. A
-- fast-tier queue keeps each live task in fast_task_runtime and writes one fast_task_outcome row
-- when the task finishes, instead of task_outcome, attempt history, and task events. Every queue
-- starts at the full tier, so this step changes no behavior until an operator moves an empty queue.

-- This is a contract step. It narrows workhorse.protocol_version to exactly 5, so a worker that
-- speaks protocol 1 through 4 must stop before it runs. Protocol 2 replaced fire_due_schedules_v1
-- and sync_schedule_definitions_v1 with their _v2 versions, so both leave the protocol surface.
-- sync_schedule_definitions_v2 still reuses the old body, which stays as an internal helper.

ALTER TABLE workhorse.queue_control
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'full' CHECK (tier IN ('fast', 'full')),
  ADD COLUMN IF NOT EXISTS record_attempts boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS record_claims boolean NOT NULL DEFAULT false;

-- One row per live fast-tier task. It copies every field the claim returns from task, so a claim
-- reads and writes this table alone. A retry returns the row to ready; any close deletes it.
CREATE TABLE IF NOT EXISTS workhorse.fast_task_runtime (
  task_id uuid PRIMARY KEY REFERENCES workhorse.task(id) ON DELETE CASCADE,
  queue_name text NOT NULL CHECK (queue_name <> ''),
  task_type text NOT NULL CHECK (task_type <> ''),
  state text NOT NULL CHECK (state IN ('ready', 'active')),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  -- The time the row became runnable: its enqueue or release time, or the end of its retry delay.
  -- Ordering by it keeps a due retry behind older ready rows and ahead of newer ones.
  run_at timestamptz NOT NULL,
  sequence bigint NOT NULL,
  payload jsonb NOT NULL,
  contract_version text,
  result_max_bytes integer NOT NULL CHECK (result_max_bytes BETWEEN 1 AND 16777216),
  redact boolean NOT NULL,
  trace_context jsonb,
  retry_policy jsonb,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 100),
  fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  worker_id text,
  claimed_at timestamptz,
  expires_at timestamptz,
  deadline_at timestamptz CHECK (deadline_at IS NULL OR isfinite(deadline_at)),
  execution_timeout_ms bigint CHECK (execution_timeout_ms BETWEEN 1 AND 31536000000),
  attempt_timeout_at timestamptz,
  previous_retry_delay_ms bigint CHECK (previous_retry_delay_ms BETWEEN 0 AND 31536000000),
  cancel_requested_at timestamptz,
  cancel_requested_by text CHECK (
    cancel_requested_by IS NULL OR (cancel_requested_by <> '' AND char_length(cancel_requested_by) <= 200)
  ),
  cancel_reason text CHECK (
    cancel_reason IS NULL OR (cancel_reason <> '' AND char_length(cancel_reason) <= 2000)
  ),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),
  errors_dropped integer NOT NULL DEFAULT 0 CHECK (errors_dropped >= 0),
  enqueued_at timestamptz NOT NULL,
  CONSTRAINT fast_task_runtime_state_shape_check CHECK (
    (state = 'ready' AND worker_id IS NULL AND claimed_at IS NULL AND expires_at IS NULL
      AND attempt_timeout_at IS NULL AND cancel_requested_at IS NULL
      AND cancel_requested_by IS NULL AND cancel_reason IS NULL)
    OR
    (state = 'active' AND worker_id IS NOT NULL AND claimed_at IS NOT NULL
      AND expires_at IS NOT NULL AND fence_token > 0
      AND (cancel_requested_at IS NOT NULL
        OR (cancel_requested_by IS NULL AND cancel_reason IS NULL)))
  )
);
CREATE INDEX IF NOT EXISTS fast_task_runtime_ready_idx
  ON workhorse.fast_task_runtime (queue_name, priority DESC, run_at, sequence)
  WHERE state = 'ready';
-- Recovery asks which active rows crossed any of their three boundaries. One expression index
-- answers that with a single range scan instead of three.
CREATE INDEX IF NOT EXISTS fast_task_runtime_active_due_idx
  ON workhorse.fast_task_runtime ((least(expires_at, attempt_timeout_at, deadline_at)))
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS fast_task_runtime_ready_deadline_idx
  ON workhorse.fast_task_runtime (deadline_at)
  WHERE state = 'ready' AND deadline_at IS NOT NULL;
-- One row per finished fast-tier task. It replaces task_outcome, the attempt history, and the task
-- events for a fast-tier task, so it names the last claim and keeps a capped list of earlier
-- attempt errors.
CREATE TABLE IF NOT EXISTS workhorse.fast_task_outcome (
  task_id uuid PRIMARY KEY REFERENCES workhorse.task(id) ON DELETE CASCADE,
  queue_name text NOT NULL CHECK (queue_name <> ''),
  task_type text NOT NULL CHECK (task_type <> ''),
  state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'canceled')),
  attempt integer NOT NULL CHECK (attempt >= 1),
  result jsonb,
  error jsonb,
  fence_token bigint CHECK (fence_token > 0),
  worker_id text,
  claimed_at timestamptz,
  enqueued_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),
  errors_dropped integer NOT NULL DEFAULT 0 CHECK (errors_dropped >= 0),
  closed_as text CHECK (
    closed_as IS NULL OR closed_as IN ('canceled', 'deadline_exceeded', 'timeout', 'lease_expired')
  ),
  CONSTRAINT fast_task_outcome_claim_check CHECK (
    (fence_token IS NULL AND worker_id IS NULL AND claimed_at IS NULL)
    OR (fence_token IS NOT NULL AND worker_id IS NOT NULL AND claimed_at IS NOT NULL)
  ),
  CONSTRAINT fast_task_outcome_state_shape_check CHECK (
    (state = 'succeeded' AND error IS NULL AND fence_token IS NOT NULL AND closed_as IS NULL)
    OR (state = 'failed' AND error IS NOT NULL)
    OR (state = 'canceled' AND error IS NOT NULL AND closed_as = 'canceled')
  )
);
CREATE INDEX IF NOT EXISTS fast_task_outcome_finished_brin_idx
  ON workhorse.fast_task_outcome USING brin (finished_at);
CREATE INDEX IF NOT EXISTS fast_task_outcome_retention_idx
  ON workhorse.fast_task_outcome (finished_at, task_id);

-- An installation that never uses the fast tier leaves these tables empty, so autovacuum never
-- analyzes them. PostgreSQL then sizes a never-analyzed table at ten pages, and the dashboard's
-- tier-spanning views probe both tables once per full-tier row. Recorded empty statistics let the
-- planner skip those probes until the tables hold rows.
ANALYZE workhorse.fast_task_runtime;
ANALYZE workhorse.fast_task_outcome;

-- Cold export gains a third dataset, so retention can prune fast-tier outcomes it has exported.
ALTER TABLE workhorse.cold_export_dataset
  DROP CONSTRAINT cold_export_dataset_dataset_check,
  ADD CONSTRAINT cold_export_dataset_dataset_check
    CHECK (dataset IN ('task_event', 'attempt_history', 'fast_task_outcome'));
ALTER TABLE workhorse.cold_export_segment
  DROP CONSTRAINT cold_export_segment_dataset_check,
  ADD CONSTRAINT cold_export_segment_dataset_check
    CHECK (dataset IN ('task_event', 'attempt_history', 'fast_task_outcome'));

-- PostgreSQL 18 generates the same layout natively and faster. Swap the body in place so column
-- defaults that call uuid_v7_v1() keep one name on every supported version.
DO $uuid_v7$
BEGIN
  IF current_setting('server_version_num')::integer >= 180000 THEN
    EXECUTE $body$
      CREATE OR REPLACE FUNCTION workhorse.uuid_v7_v1()
      RETURNS uuid
      LANGUAGE sql
      VOLATILE
      AS 'SELECT uuidv7()'
    $body$;
  END IF;
END;
$uuid_v7$;

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

CREATE OR REPLACE FUNCTION workhorse.sync_schedule_definitions_internal_v1(
  p_namespace text, p_definitions jsonb, p_prune boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(p_namespace, '') = '' THEN RAISE EXCEPTION 'namespace must not be empty'; END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'schedule definitions must be a JSON array';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_definitions) definition
     WHERE COALESCE(definition->>'name', '') = ''
        OR COALESCE(definition->>'schedule', '') = ''
        OR COALESCE(definition->>'queue', '') = ''
        OR COALESCE(definition->>'type', '') = ''
        OR COALESCE((definition->>'maxAttempts')::integer, 25) NOT BETWEEN 1 AND 100
        OR COALESCE((definition->>'priority')::numeric, 0) <> trunc(COALESCE((definition->>'priority')::numeric, 0))
        OR COALESCE((definition->>'priority')::numeric, 0) NOT BETWEEN 0 AND 100
        OR (definition->>'concurrencyKey' IS NOT NULL AND (
          definition->>'concurrencyKey' = '' OR octet_length(definition->>'concurrencyKey') > 256
        ))
  ) THEN
    RAISE EXCEPTION 'each schedule requires non-empty name/schedule/queue/type and maxAttempts between 1 and 100';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_definitions) definition
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_timezone_names timezone
        WHERE timezone.name = COALESCE(definition->>'timezone', 'UTC')
     )
  ) THEN
    RAISE EXCEPTION 'each schedule timezone must be a valid IANA timezone name';
  END IF;
  PERFORM workhorse.cron_occurrences_v1(
    definition->>'schedule', NULL, date_trunc('second', clock_timestamp()), 1,
    COALESCE(definition->>'timezone', 'UTC')
  ) FROM jsonb_array_elements(p_definitions) definition;
  PERFORM workhorse.normalize_retry_policy_v1(definition->'retryPolicy')
    FROM jsonb_array_elements(p_definitions) definition WHERE definition ? 'retryPolicy';
  IF (
    SELECT count(*) FROM jsonb_array_elements(p_definitions)
  ) <> (
    SELECT count(DISTINCT definition->>'name') FROM jsonb_array_elements(p_definitions) definition
  ) THEN
    RAISE EXCEPTION 'schedule names must be unique within a namespace';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:schedules:' || p_namespace, 0));

  INSERT INTO workhorse.schedule_definition AS existing(
    namespace, schedule_name, cron_expression, timezone, queue_name, task_type, concurrency_key, priority, payload,
    contract_version, payload_max_bytes, result_max_bytes, payload_redact_keys, result_redact_keys,
    max_attempts, retry_policy, configured_enabled
  )
  SELECT p_namespace, definition->>'name', definition->>'schedule',
         COALESCE(definition->>'timezone', 'UTC'), definition->>'queue',
         definition->>'type', definition->>'concurrencyKey',
         COALESCE((definition->>'priority')::integer, 0),
         COALESCE(definition->'payload', 'null'::jsonb),
         definition->>'contractVersion',
         COALESCE((definition->>'payloadMaxBytes')::integer, 1048576),
         COALESCE((definition->>'resultMaxBytes')::integer, 1048576),
         ARRAY(SELECT redact_key FROM jsonb_array_elements_text(
           COALESCE(definition->'sensitivePayloadKeys', '[]'::jsonb)
         ) AS payload_keys(redact_key) ORDER BY redact_key COLLATE "C"),
         ARRAY(SELECT redact_key FROM jsonb_array_elements_text(
           COALESCE(definition->'sensitiveResultKeys', '[]'::jsonb)
         ) AS result_keys(redact_key) ORDER BY redact_key COLLATE "C"),
         COALESCE((definition->>'maxAttempts')::integer, 25),
         workhorse.normalize_retry_policy_v1(definition->'retryPolicy'),
         COALESCE((definition->>'enabled')::boolean, true)
    FROM jsonb_array_elements(p_definitions) definition
  ON CONFLICT (namespace, schedule_name) DO UPDATE
    SET revision = existing.revision + CASE WHEN ROW(
          existing.cron_expression, existing.timezone, existing.queue_name, existing.task_type,
          existing.concurrency_key, existing.priority, existing.payload,
          existing.contract_version, existing.payload_max_bytes, existing.result_max_bytes,
          existing.payload_redact_keys, existing.result_redact_keys,
          existing.max_attempts, existing.retry_policy, existing.configured_enabled
        ) IS DISTINCT FROM ROW(
          EXCLUDED.cron_expression, EXCLUDED.timezone, EXCLUDED.queue_name, EXCLUDED.task_type,
          EXCLUDED.concurrency_key, EXCLUDED.priority, EXCLUDED.payload,
          EXCLUDED.contract_version, EXCLUDED.payload_max_bytes, EXCLUDED.result_max_bytes,
          EXCLUDED.payload_redact_keys, EXCLUDED.result_redact_keys,
          EXCLUDED.max_attempts, EXCLUDED.retry_policy, EXCLUDED.configured_enabled
        ) THEN 1 ELSE 0 END,
        cron_expression = EXCLUDED.cron_expression,
        timezone = EXCLUDED.timezone,
        queue_name = EXCLUDED.queue_name,
        task_type = EXCLUDED.task_type,
        concurrency_key = EXCLUDED.concurrency_key,
        priority = EXCLUDED.priority,
        payload = EXCLUDED.payload,
        contract_version = EXCLUDED.contract_version,
        payload_max_bytes = EXCLUDED.payload_max_bytes,
        result_max_bytes = EXCLUDED.result_max_bytes,
        payload_redact_keys = EXCLUDED.payload_redact_keys,
        result_redact_keys = EXCLUDED.result_redact_keys,
        max_attempts = EXCLUDED.max_attempts,
        retry_policy = EXCLUDED.retry_policy,
        configured_enabled = EXCLUDED.configured_enabled,
        updated_at = clock_timestamp();

  IF p_prune THEN
    UPDATE workhorse.schedule_definition definition
       SET configured_enabled = false, revision = definition.revision + 1, updated_at = clock_timestamp()
     WHERE definition.namespace = p_namespace
       AND definition.configured_enabled
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_definitions) desired
          WHERE desired->>'name' = definition.schedule_name
       );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.sync_schedule_definitions_v2(
  p_namespace text, p_definitions jsonb, p_prune boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous jsonb;
BEGIN
  IF COALESCE(p_namespace, '') = '' THEN RAISE EXCEPTION 'namespace must not be empty'; END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'schedule definitions must be a JSON array';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_definitions) definition
     WHERE COALESCE(definition->>'catchupPolicy', 'skip') NOT IN ('skip', 'latest', 'all')
  ) THEN
    RAISE EXCEPTION 'schedule catch-up policy must be skip, latest, or all';
  END IF;

  SELECT COALESCE(jsonb_object_agg(
    definition.schedule_name,
    jsonb_build_object(
      'revision', definition.revision,
      'cronExpression', definition.cron_expression,
      'timezone', definition.timezone,
      'configuredEnabled', definition.configured_enabled,
      'catchupPolicy', definition.catchup_policy
    )
  ), '{}'::jsonb)
  INTO v_previous
  FROM workhorse.schedule_definition definition
  WHERE definition.namespace = p_namespace;

  PERFORM workhorse.sync_schedule_definitions_internal_v1(p_namespace, p_definitions, p_prune);

  UPDATE workhorse.schedule_definition definition
     SET revision = definition.revision + CASE
           WHEN v_previous ? definition.schedule_name
             AND definition.revision = (v_previous->definition.schedule_name->>'revision')::bigint
             AND definition.catchup_policy IS DISTINCT FROM
               COALESCE(desired.value->>'catchupPolicy', 'skip')
           THEN 1 ELSE 0
         END,
         last_evaluated_at = CASE
           WHEN NOT (v_previous ? definition.schedule_name)
             OR (v_previous->definition.schedule_name->>'cronExpression') IS DISTINCT FROM
               definition.cron_expression
             OR (v_previous->definition.schedule_name->>'timezone') IS DISTINCT FROM
               definition.timezone
             OR (v_previous->definition.schedule_name->>'catchupPolicy') IS DISTINCT FROM
               COALESCE(desired.value->>'catchupPolicy', 'skip')
             OR (
               NOT (v_previous->definition.schedule_name->>'configuredEnabled')::boolean
               AND definition.configured_enabled
               AND COALESCE(desired.value->>'catchupPolicy', 'skip') = 'skip'
             )
           THEN date_trunc('second', clock_timestamp()) - interval '1 microsecond'
           ELSE definition.last_evaluated_at
         END,
         catchup_policy = COALESCE(desired.value->>'catchupPolicy', 'skip')
    FROM jsonb_array_elements(p_definitions) desired(value)
   WHERE definition.namespace = p_namespace
     AND definition.schedule_name = desired.value->>'name';
END;
$$;

-- Synchronize queue concurrency policies as deployment-owned desired state. Omitted rows are pruned
-- by default, so one deployment cannot leave stale admission budgets behind indefinitely.
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

-- Synchronize queue rate limits as deployment-owned desired state. A policy update keeps accrued
-- bucket state, clamps it to the new burst on the next observation, and never manufactures starts.
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

-- Take the shared tier lock of every named queue, in a fixed order, and return the fast-tier ones.
-- A caller that writes a task or a policy for these queues holds the lock until it commits, which
-- is what lets set_queue_tier_v1 prove a queue empty before it changes the tier.
CREATE OR REPLACE FUNCTION workhorse.lock_queue_tiers_v1(p_queue_names text[])
RETURNS text[]
LANGUAGE plpgsql
AS $$
DECLARE
  v_queue_name text;
BEGIN
  FOR v_queue_name IN
    SELECT DISTINCT queue_name COLLATE "C" FROM unnest(p_queue_names) queue_name
     WHERE queue_name IS NOT NULL
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('workhorse:queue-tier:' || v_queue_name, 0)
    );
  END LOOP;
  RETURN ARRAY(
    SELECT control.queue_name FROM workhorse.queue_control control
     WHERE control.queue_name = ANY(p_queue_names) AND control.tier = 'fast'
  );
END;
$$;

-- Every rejection of a full-tier feature on a fast-tier queue raises the same error, so clients
-- can map it to one type. The detail names the queue and the feature; a batch caller adds the
-- ordinal of the request that carried it.
CREATE OR REPLACE FUNCTION workhorse.reject_fast_feature_v1(
  p_queue_name text, p_feature text, p_ordinal integer DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P1007',
    MESSAGE = format('fast-tier queue %s does not support %s', p_queue_name, p_feature),
    DETAIL = (
      jsonb_build_object('queue', p_queue_name, 'feature', p_feature)
      || CASE WHEN p_ordinal IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('ordinal', p_ordinal) END
    )::text;
END;
$$;

-- The core batch insert path. Accept up to 1,000 tasks atomically. Scoped idempotency keys are
-- resolved in ordinal order through their unique index before any durable task side effects. Exact
-- replays return the original identity; material mismatches abort the whole statement with SQLSTATE
-- P1001.
--
-- Clients call workhorse.enqueue_many_v1 instead. This function is the shared implementation
-- underneath it, enqueue_v1, enqueue_debounce_v1, and enqueue_throttle_v1, and it reports plain
-- acceptance rather than the coalescing outcomes those callers map.
CREATE OR REPLACE FUNCTION workhorse.enqueue_batch_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, accepted boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_now timestamptz := clock_timestamp();
  v_request jsonb;
  v_lock record;
  v_ordinal integer;
  v_queue_name text;
  v_task_type text;
  v_concurrency_key text;
  v_budget_name text;
  v_priority numeric;
  v_payload jsonb;
  v_contract_version text;
  v_payload_max_bytes numeric;
  v_result_max_bytes numeric;
  v_payload_redact_keys text[];
  v_result_redact_keys text[];
  v_trace_context jsonb;
  v_tags text[];
  v_run_at timestamptz;
  v_max_attempts integer;
  v_retry_policy jsonb;
  v_deadline_at timestamptz;
  v_execution_timeout_ms numeric;
  v_dependencies jsonb;
  v_prerequisite_task_ids uuid[];
  v_prerequisite_task_id uuid;
  v_on_success text;
  v_on_failure text;
  v_on_cancellation text;
  v_pending_prerequisites integer;
  v_terminal_prerequisite_id uuid;
  v_terminal_prerequisite_state text;
  v_terminal_action text;
  v_terminal record;
  v_state text;
  v_idempotency jsonb;
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_key_preview text;
  v_key_digest text;
  v_key_length integer;
  v_ttl_ms numeric;
  v_expires_at timestamptz;
  v_fingerprint jsonb;
  v_fingerprint_tags text[];
  v_request_digest text;
  v_conflicting_fields text[];
  v_proposed_task_id uuid;
  v_existing workhorse.enqueue_idempotency%ROWTYPE;
  v_is_new boolean;
  v_is_keyed boolean;
  v_ready_queues text[] := '{}';
  v_notify_queue text;
  v_fast_queues text[];
  v_is_fast boolean;
  v_fast_feature text;
  v_fast_task workhorse.task;
  v_fast_tasks workhorse.task[] := '{}';
  v_fast_runtime workhorse.fast_task_runtime;
  v_fast_runtimes workhorse.fast_task_runtime[] := '{}';
  v_fast_past_deadline uuid[] := '{}';
  v_fast_task_id uuid;
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  v_count := jsonb_array_length(p_requests);
  IF v_count > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
  END IF;

  -- Validate key identities before locking so malformed requests fail predictably, then acquire every
  -- batch key in one deterministic order. This prevents reverse-order overlapping batches from
  -- deadlocking while still serializing new and retained keys through the transaction boundary.
  FOR v_request IN SELECT value FROM jsonb_array_elements(p_requests)
  LOOP
    v_idempotency := v_request->'idempotency';
    IF v_idempotency IS NULL OR v_idempotency = 'null'::jsonb THEN CONTINUE; END IF;
    IF jsonb_typeof(v_idempotency) <> 'object'
       OR v_idempotency - ARRAY['key', 'scope', 'ttlMs'] <> '{}'::jsonb
       OR NOT (v_idempotency ? 'key')
       OR jsonb_typeof(v_idempotency->'key') <> 'string'
       OR (v_idempotency ? 'scope' AND jsonb_typeof(v_idempotency->'scope') <> 'string')
       OR (v_idempotency ? 'ttlMs' AND jsonb_typeof(v_idempotency->'ttlMs') <> 'number') THEN
      RAISE EXCEPTION 'idempotency requires a string key and only optional string scope and numeric ttlMs';
    END IF;
    v_key := v_idempotency->>'key';
    v_scope := COALESCE(v_idempotency->>'scope', 'default');
    v_ttl_ms := COALESCE((v_idempotency->>'ttlMs')::numeric, 86400000);
    IF v_key = '' OR octet_length(v_key) > 512 THEN
      RAISE EXCEPTION 'idempotency key must contain between 1 and 512 UTF-8 bytes';
    END IF;
    IF v_scope = '' OR octet_length(v_scope) > 256 THEN
      RAISE EXCEPTION 'idempotency scope must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_ttl_ms <> trunc(v_ttl_ms) OR v_ttl_ms NOT BETWEEN 1 AND 31536000000 THEN
      RAISE EXCEPTION 'idempotency ttlMs must be an integer between 1 and 31536000000';
    END IF;
  END LOOP;
  FOR v_lock IN
    SELECT locks.scope, locks.key
      FROM (
        SELECT DISTINCT COALESCE(idempotency->>'scope', 'default') AS scope,
               idempotency->>'key' AS key
          FROM jsonb_array_elements(p_requests) AS input(request)
          CROSS JOIN LATERAL (SELECT request->'idempotency' AS idempotency) parsed
         WHERE idempotency IS NOT NULL AND idempotency <> 'null'::jsonb
      ) locks
     ORDER BY locks.scope COLLATE "C", locks.key COLLATE "C"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock.scope || chr(31) || v_lock.key, 0));
  END LOOP;

  -- A queue's tier can change only while it holds no live task. The shared tier lock keeps the
  -- tier read here valid until this batch commits, so set_queue_tier_v1 cannot switch a queue
  -- between that read and the insert of its first task.
  v_fast_queues := workhorse.lock_queue_tiers_v1(ARRAY(
    SELECT DISTINCT request->>'queue'
      FROM jsonb_array_elements(p_requests) input(request)
     WHERE COALESCE(request->>'queue', '') <> ''
  ));

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    v_queue_name := v_request->>'queue';
    v_task_type := v_request->>'type';
    v_concurrency_key := v_request->>'concurrencyKey';
    v_budget_name := v_request->>'budget';
    v_priority := COALESCE((v_request->>'priority')::numeric, 0);
    v_payload := COALESCE(v_request->'payload', 'null'::jsonb);
    v_contract_version := v_request->>'contractVersion';
    v_payload_max_bytes := COALESCE((v_request->>'payloadMaxBytes')::numeric, 1048576);
    v_result_max_bytes := COALESCE((v_request->>'resultMaxBytes')::numeric, 1048576);
    IF v_contract_version IS NOT NULL
       AND char_length(v_contract_version) NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'contractVersion must contain 1 to 100 characters';
    END IF;
    IF v_payload_max_bytes <> trunc(v_payload_max_bytes)
       OR v_payload_max_bytes NOT BETWEEN 1 AND 16777216
       OR v_result_max_bytes <> trunc(v_result_max_bytes)
       OR v_result_max_bytes NOT BETWEEN 1 AND 16777216 THEN
      RAISE EXCEPTION 'payloadMaxBytes and resultMaxBytes must be integers between 1 and 16777216';
    END IF;
    IF octet_length(v_payload::text) > v_payload_max_bytes THEN
      RAISE EXCEPTION 'payload exceeds its configured size limit';
    END IF;
    IF jsonb_typeof(COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)) > 50
       OR jsonb_typeof(COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)) > 50
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb) ||
             COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)
           ) key
          WHERE jsonb_typeof(key) <> 'string'
             OR char_length(key #>> '{}') NOT BETWEEN 1 AND 200
       ) THEN
      RAISE EXCEPTION 'sensitive payload and result keys must contain at most 50 strings of 1 to 200 characters';
    END IF;
    v_payload_redact_keys := ARRAY(
      SELECT key
        FROM jsonb_array_elements_text(
          COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)
        ) key
       ORDER BY key COLLATE "C"
    );
    v_result_redact_keys := ARRAY(
      SELECT key
        FROM jsonb_array_elements_text(
          COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)
        ) key
       ORDER BY key COLLATE "C"
    );
    IF cardinality(v_payload_redact_keys) <> (
         SELECT count(DISTINCT key) FROM unnest(v_payload_redact_keys) key
       ) OR cardinality(v_result_redact_keys) <> (
         SELECT count(DISTINCT key) FROM unnest(v_result_redact_keys) key
       ) THEN
      RAISE EXCEPTION 'sensitive payload and result keys must contain unique values';
    END IF;
    v_trace_context := v_request->'traceContext';
    IF v_concurrency_key IS NOT NULL AND (
      v_concurrency_key = '' OR octet_length(v_concurrency_key) > 256
    ) THEN
      RAISE EXCEPTION 'concurrencyKey must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_budget_name IS NOT NULL AND (
      v_budget_name = '' OR octet_length(v_budget_name) > 256
    ) THEN
      RAISE EXCEPTION 'budget must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_priority <> trunc(v_priority) OR v_priority NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'priority must be an integer between 0 and 100';
    END IF;
    IF COALESCE(v_queue_name, '') = '' OR COALESCE(v_task_type, '') = ''
       OR jsonb_typeof(COALESCE(v_request->'tags', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'tags', '[]'::jsonb)) > 20
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(v_request->'tags', '[]'::jsonb)) tag
          WHERE jsonb_typeof(tag) <> 'string' OR tag #>> '{}' = ''
             OR char_length(tag #>> '{}') > 100
       ) THEN
      RAISE EXCEPTION 'each request requires non-empty queue/type, maxAttempts between 1 and 100, and at most 20 non-empty tags of at most 100 characters';
    END IF;
    v_tags := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_request->'tags', '[]'::jsonb))
    );
    IF NOT workhorse.valid_trace_context_v1(v_trace_context) THEN
      RAISE EXCEPTION 'traceContext must contain a string traceparent, optional string tracestate, and at most 1024 UTF-8 bytes';
    END IF;
    v_max_attempts := COALESCE((v_request->>'maxAttempts')::integer, 25);
    IF v_max_attempts NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'each request requires non-empty queue/type, maxAttempts between 1 and 100, and at most 20 non-empty tags of at most 100 characters';
    END IF;
    v_retry_policy := workhorse.normalize_retry_policy_v1(v_request->'retryPolicy');
    v_run_at := COALESCE((v_request->>'runAt')::timestamptz, v_now);
    IF NOT isfinite(v_run_at) THEN RAISE EXCEPTION 'runAt must be finite'; END IF;
    v_deadline_at := (v_request->>'deadline')::timestamptz;
    IF v_deadline_at IS NOT NULL AND NOT isfinite(v_deadline_at) THEN
      RAISE EXCEPTION 'deadline must be a finite absolute timestamp';
    END IF;
    v_execution_timeout_ms := (v_request->>'executionTimeoutMs')::numeric;
    IF v_execution_timeout_ms IS NOT NULL AND (
      v_execution_timeout_ms <> trunc(v_execution_timeout_ms)
      OR v_execution_timeout_ms NOT BETWEEN 1 AND 31536000000
    ) THEN
      RAISE EXCEPTION 'executionTimeoutMs must be an integer between 1 and 31536000000';
    END IF;
    IF v_request ? 'prerequisiteTaskId'
       AND v_request->'prerequisiteTaskId' <> 'null'::jsonb
       AND jsonb_typeof(v_request->'prerequisiteTaskId') <> 'string' THEN
      RAISE EXCEPTION 'prerequisiteTaskId must be a UUID string or null';
    END IF;
    v_dependencies := v_request->'dependencies';
    IF v_request->>'prerequisiteTaskId' IS NOT NULL
       AND v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      RAISE EXCEPTION 'prerequisiteTaskId and dependencies cannot be combined';
    END IF;
    IF v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      IF jsonb_typeof(v_dependencies) <> 'object'
         OR v_dependencies - ARRAY['prerequisiteTaskIds', 'onSuccess', 'onFailure', 'onCancellation'] <> '{}'::jsonb
         OR jsonb_typeof(v_dependencies->'prerequisiteTaskIds') <> 'array'
         OR jsonb_array_length(v_dependencies->'prerequisiteTaskIds') NOT BETWEEN 1 AND 100
         OR v_dependencies->>'onSuccess' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onFailure' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onCancellation' NOT IN ('release', 'cancel', 'fail')
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_dependencies->'prerequisiteTaskIds') item
            WHERE jsonb_typeof(item) <> 'string'
         ) THEN
        RAISE EXCEPTION 'dependencies requires 1 to 100 UUID strings and release, cancel, or fail outcome policies';
      END IF;
      v_prerequisite_task_ids := ARRAY(
        SELECT value::uuid
          FROM jsonb_array_elements_text(v_dependencies->'prerequisiteTaskIds') value
         ORDER BY value::uuid
      );
      v_on_success := v_dependencies->>'onSuccess';
      v_on_failure := v_dependencies->>'onFailure';
      v_on_cancellation := v_dependencies->>'onCancellation';
    ELSIF v_request->>'prerequisiteTaskId' IS NOT NULL THEN
      v_prerequisite_task_ids := ARRAY[(v_request->>'prerequisiteTaskId')::uuid];
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    ELSE
      v_prerequisite_task_ids := '{}';
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    END IF;
    v_is_fast := v_queue_name = ANY(v_fast_queues);
    IF v_is_fast THEN
      v_fast_feature := CASE
        WHEN v_concurrency_key IS NOT NULL THEN 'concurrency keys'
        WHEN v_budget_name IS NOT NULL THEN 'budgets'
        WHEN v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN 'dependencies'
        WHEN cardinality(v_prerequisite_task_ids) > 0 THEN 'prerequisite tasks'
      END;
      IF v_fast_feature IS NOT NULL THEN
        PERFORM workhorse.reject_fast_feature_v1(v_queue_name, v_fast_feature, v_ordinal);
      END IF;
    END IF;
    v_prerequisite_task_id := CASE
      WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
        THEN NULLIF(v_request->>'prerequisiteTaskId', '')::uuid
      ELSE NULL
    END;
    -- Most requests carry no prerequisite. The prerequisite lock, the existence check and both
    -- outcome scans answer nothing for an empty set, so a request without prerequisites states
    -- their answers directly and reaches the task insert without touching dependency relations.
    IF cardinality(v_prerequisite_task_ids) > 0 THEN
      IF cardinality(v_prerequisite_task_ids) <> (
        SELECT count(DISTINCT prerequisite_id) FROM unnest(v_prerequisite_task_ids) prerequisite_id
      ) THEN
        RAISE EXCEPTION 'dependency prerequisiteTaskIds must be unique';
      END IF;
      PERFORM 1 FROM workhorse.task prerequisite
       WHERE prerequisite.id = ANY(v_prerequisite_task_ids)
       ORDER BY prerequisite.id FOR UPDATE;
      GET DIAGNOSTICS v_pending_prerequisites = ROW_COUNT;
      IF v_pending_prerequisites <> cardinality(v_prerequisite_task_ids) THEN
        RAISE EXCEPTION 'prerequisite task does not exist';
      END IF;
      -- A fast-tier task never resolves dependents when it finishes, so a dependent on it would
      -- stay blocked forever.
      SELECT prerequisite_id INTO v_fast_task_id
        FROM unnest(v_prerequisite_task_ids) prerequisite_id
       WHERE EXISTS (
               SELECT 1 FROM workhorse.fast_task_runtime runtime
                WHERE runtime.task_id = prerequisite_id
             ) OR EXISTS (
               SELECT 1 FROM workhorse.fast_task_outcome outcome
                WHERE outcome.task_id = prerequisite_id
             )
       LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P1007',
          MESSAGE = format('fast-tier task %s cannot be a prerequisite', v_fast_task_id),
          DETAIL = jsonb_build_object(
            'feature', 'dependencies', 'taskId', v_fast_task_id, 'ordinal', v_ordinal
          )::text;
      END IF;
      SELECT count(*)::integer INTO v_pending_prerequisites
        FROM unnest(v_prerequisite_task_ids) prerequisite_id
        LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = prerequisite_id
       WHERE outcome.task_id IS NULL;
      SELECT outcome.task_id, outcome.state, action.policy_action
        INTO v_terminal_prerequisite_id, v_terminal_prerequisite_state, v_terminal_action
        FROM workhorse.task_outcome outcome
        CROSS JOIN LATERAL (
          SELECT CASE outcome.state
            WHEN 'succeeded' THEN v_on_success
            WHEN 'failed' THEN v_on_failure
            WHEN 'canceled' THEN v_on_cancellation
            ELSE 'release'
          END AS policy_action
        ) action
       WHERE outcome.task_id = ANY(v_prerequisite_task_ids)
         AND action.policy_action IN ('fail', 'cancel')
       ORDER BY CASE action.policy_action WHEN 'fail' THEN 0 ELSE 1 END, outcome.task_id
       LIMIT 1;
    ELSE
      v_pending_prerequisites := 0;
      v_terminal_prerequisite_id := NULL;
      v_terminal_prerequisite_state := NULL;
      v_terminal_action := NULL;
    END IF;
    v_state := CASE
      WHEN v_terminal_action IS NOT NULL THEN 'blocked'
      WHEN v_pending_prerequisites > 0 THEN 'blocked'
      WHEN v_run_at <= v_now THEN 'ready'
      ELSE 'scheduled'
    END;
    v_idempotency := v_request->'idempotency';
    v_is_new := true;
    v_is_keyed := false;
    v_key_hash := NULL;
    v_key_preview := NULL;
    v_key_digest := NULL;
    v_key_length := NULL;
    v_expires_at := NULL;
    v_request_digest := NULL;

    IF v_idempotency IS NOT NULL AND v_idempotency <> 'null'::jsonb THEN
      IF jsonb_typeof(v_idempotency) <> 'object'
         OR v_idempotency - ARRAY['key', 'scope', 'ttlMs'] <> '{}'::jsonb
         OR NOT (v_idempotency ? 'key')
         OR jsonb_typeof(v_idempotency->'key') <> 'string'
         OR (v_idempotency ? 'scope' AND jsonb_typeof(v_idempotency->'scope') <> 'string')
         OR (v_idempotency ? 'ttlMs' AND jsonb_typeof(v_idempotency->'ttlMs') <> 'number') THEN
        RAISE EXCEPTION 'idempotency requires a string key and only optional string scope and numeric ttlMs';
      END IF;
      v_is_keyed := true;
      v_key := v_idempotency->>'key';
      v_scope := COALESCE(v_idempotency->>'scope', 'default');
      v_ttl_ms := COALESCE((v_idempotency->>'ttlMs')::numeric, 86400000);
      IF v_key = '' OR octet_length(v_key) > 512 THEN
        RAISE EXCEPTION 'idempotency key must contain between 1 and 512 UTF-8 bytes';
      END IF;
      IF v_scope = '' OR octet_length(v_scope) > 256 THEN
        RAISE EXCEPTION 'idempotency scope must contain between 1 and 256 UTF-8 bytes';
      END IF;
      IF v_ttl_ms <> trunc(v_ttl_ms) OR v_ttl_ms NOT BETWEEN 1 AND 31536000000 THEN
        RAISE EXCEPTION 'idempotency ttlMs must be an integer between 1 and 31536000000';
      END IF;
      v_key_hash := workhorse.idempotency_key_hash_v1(v_scope, v_key);
      v_key_digest := left(encode(v_key_hash, 'hex'), 12);
      v_key_length := char_length(v_key);
      v_key_preview := CASE
        WHEN v_key_length <= 4 THEN repeat('•', v_key_length)
        WHEN v_key_length <= 8 THEN left(v_key, 2) || '…' || right(v_key, 2)
        ELSE left(v_key, 8) || '…' || right(v_key, 4)
      END;
      v_expires_at := v_now + v_ttl_ms * interval '1 millisecond';
      v_fingerprint_tags := ARRAY(
        SELECT unique_tags.tag
          FROM (SELECT DISTINCT tag FROM unnest(v_tags) tag) unique_tags
         ORDER BY unique_tags.tag COLLATE "C"
      );
      v_fingerprint := jsonb_build_object(
        'queue', v_queue_name,
        'type', v_task_type,
        'payload', v_payload,
        'priority', v_priority,
        'concurrencyKey', to_jsonb(v_concurrency_key),
        'contractVersion', to_jsonb(v_contract_version),
        'payloadMaxBytes', v_payload_max_bytes,
        'resultMaxBytes', v_result_max_bytes,
        'sensitivePayloadKeys', to_jsonb(v_payload_redact_keys),
        'sensitiveResultKeys', to_jsonb(v_result_redact_keys),
        'tags', to_jsonb(v_fingerprint_tags),
        'runAt', CASE
          WHEN v_request->>'runAt' IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_run_at)
        END,
        'deadline', to_jsonb(v_deadline_at),
        'executionTimeoutMs', to_jsonb(v_execution_timeout_ms),
        'maxAttempts', v_max_attempts,
        'retryPolicy', v_retry_policy,
        'prerequisiteTaskId', to_jsonb(v_prerequisite_task_id),
        'dependencies', CASE WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
          THEN 'null'::jsonb ELSE
          jsonb_build_object(
            'prerequisiteTaskIds', to_jsonb(v_prerequisite_task_ids),
            'onSuccess', v_on_success,
            'onFailure', v_on_failure,
            'onCancellation', v_on_cancellation
          ) END,
        'ttlMs', v_ttl_ms
      ) || CASE WHEN v_budget_name IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('budget', v_budget_name) END;
      v_request_digest := workhorse.sha256_hex_v1(v_fingerprint::text);

      LOOP
        v_proposed_task_id := gen_random_uuid();
        INSERT INTO workhorse.enqueue_idempotency AS existing(
          idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
        ) VALUES (
          v_scope, v_key_hash, v_fingerprint, v_proposed_task_id, v_expires_at
        )
        ON CONFLICT (idempotency_scope, idempotency_key_hash) DO UPDATE
          SET idempotency_key_hash = existing.idempotency_key_hash
        RETURNING existing.* INTO v_existing;

        IF v_existing.task_id = v_proposed_task_id THEN
          task_id := v_proposed_task_id;
          EXIT;
        END IF;
        IF v_existing.expires_at <= v_now THEN
          DELETE FROM workhorse.enqueue_idempotency AS expired
           WHERE expired.idempotency_scope = v_scope
             AND expired.idempotency_key_hash = v_key_hash
             AND expired.task_id = v_existing.task_id AND expired.expires_at <= v_now;
          CONTINUE;
        END IF;
        IF v_existing.request_fingerprint <> v_fingerprint THEN
          SELECT COALESCE(array_agg(field ORDER BY field COLLATE "C"), '{}')
            INTO v_conflicting_fields
            FROM jsonb_object_keys(v_fingerprint) field
           WHERE v_existing.request_fingerprint->field IS DISTINCT FROM v_fingerprint->field;
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = 'enqueue idempotency conflict with a retained request',
            DETAIL = jsonb_build_object(
              'scope', v_scope,
              'keyPreview', v_key_preview,
              'keyDigest', v_key_digest,
              'keyLength', v_key_length,
              'existingTaskId', v_existing.task_id,
              'ordinal', v_ordinal,
              'conflictingFields', to_jsonb(v_conflicting_fields),
              'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
              'rejectedRequestDigest', v_request_digest
            )::text;
        END IF;
        task_id := v_existing.task_id;
        v_is_new := false;
        EXIT;
      END LOOP;
    ELSE
      task_id := gen_random_uuid();
    END IF;

    IF v_is_new AND v_is_fast THEN
      -- Fast-tier rows are collected here and written after the loop, one statement per table.
      v_fast_task.id := task_id;
      v_fast_task.queue_name := v_queue_name;
      v_fast_task.task_type := v_task_type;
      v_fast_task.concurrency_key := NULL;
      v_fast_task.payload := v_payload;
      v_fast_task.contract_version := v_contract_version;
      v_fast_task.payload_max_bytes := v_payload_max_bytes::integer;
      v_fast_task.result_max_bytes := v_result_max_bytes::integer;
      v_fast_task.payload_redact_keys := v_payload_redact_keys;
      v_fast_task.result_redact_keys := v_result_redact_keys;
      v_fast_task.trace_context := v_trace_context;
      v_fast_task.tags := v_tags;
      v_fast_task.max_attempts := v_max_attempts;
      v_fast_task.retry_policy := v_retry_policy;
      v_fast_task.deadline_at := v_deadline_at;
      v_fast_task.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_fast_task.created_at := v_now;
      v_fast_task.priority := v_priority::integer;
      v_fast_task.budget_name := NULL;
      v_fast_tasks := array_append(v_fast_tasks, v_fast_task);

      v_fast_runtime := NULL;
      v_fast_runtime.task_id := task_id;
      v_fast_runtime.queue_name := v_queue_name;
      v_fast_runtime.task_type := v_task_type;
      v_fast_runtime.state := 'ready';
      v_fast_runtime.priority := v_priority::integer;
      v_fast_runtime.run_at := v_run_at;
      v_fast_runtime.sequence := nextval('workhorse.ready_sequence_seq');
      v_fast_runtime.payload := v_payload;
      v_fast_runtime.contract_version := v_contract_version;
      v_fast_runtime.result_max_bytes := v_result_max_bytes::integer;
      v_fast_runtime.redact := cardinality(v_payload_redact_keys) > 0
        OR cardinality(v_result_redact_keys) > 0;
      v_fast_runtime.trace_context := v_trace_context;
      v_fast_runtime.retry_policy := v_retry_policy;
      v_fast_runtime.max_attempts := v_max_attempts;
      v_fast_runtime.attempt := 1;
      v_fast_runtime.fence_token := 0;
      v_fast_runtime.deadline_at := v_deadline_at;
      v_fast_runtime.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_fast_runtime.errors := '[]'::jsonb;
      v_fast_runtime.errors_dropped := 0;
      v_fast_runtime.enqueued_at := v_now;
      v_fast_runtimes := array_append(v_fast_runtimes, v_fast_runtime);

      IF v_deadline_at IS NOT NULL AND v_deadline_at <= v_now THEN
        v_fast_past_deadline := array_append(v_fast_past_deadline, task_id);
      ELSIF v_run_at <= v_now AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    ELSIF v_is_new THEN
      INSERT INTO workhorse.task(
        id, queue_name, task_type, concurrency_key, priority, payload, contract_version,
        payload_max_bytes, result_max_bytes,
        payload_redact_keys, result_redact_keys, trace_context, tags, max_attempts, retry_policy,
        deadline_at, execution_timeout_ms, budget_name
      ) VALUES (
        task_id, v_queue_name, v_task_type, v_concurrency_key, v_priority::integer, v_payload, v_contract_version,
        v_payload_max_bytes::integer, v_result_max_bytes::integer,
        v_payload_redact_keys, v_result_redact_keys, v_trace_context, v_tags,
        v_max_attempts, v_retry_policy,
        v_deadline_at, v_execution_timeout_ms::bigint, v_budget_name
      );
      INSERT INTO workhorse.task_runtime(
        task_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at, sequence,
        deadline_at, budget_name
      ) VALUES (
        task_id, v_queue_name, v_concurrency_key, v_priority::integer, v_state, 1, v_run_at,
        CASE WHEN v_state = 'ready' THEN v_now END,
        CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
        v_deadline_at, v_budget_name
      );
      -- A request without prerequisites has no edge to write and no dependent to resolve. Running
      -- the insert anyway would fire the statement trigger on `task_dependency`, and that trigger
      -- walks the dependency graph recursively for a transition that cannot have occurred.
      IF cardinality(v_prerequisite_task_ids) > 0 THEN
        WITH prerequisites AS MATERIALIZED (
          SELECT input.prerequisite_task_id, outcome.state,
                 outcome.state IS NOT NULL AND (
                   (outcome.state = 'succeeded' AND v_on_success = 'release')
                   OR (outcome.state = 'failed' AND v_on_failure = 'release')
                   OR (outcome.state = 'canceled' AND v_on_cancellation = 'release')
                 ) AS releases_immediately
            FROM unnest(v_prerequisite_task_ids) input(prerequisite_task_id)
            LEFT JOIN workhorse.task_outcome outcome
              ON outcome.task_id = input.prerequisite_task_id
        ), inserted_edges AS (
          INSERT INTO workhorse.task_dependency(
            dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation,
            created_at, released_at, resolution
          )
          SELECT task_id, prerequisites.prerequisite_task_id,
                 v_on_success, v_on_failure, v_on_cancellation, v_now,
                 CASE WHEN prerequisites.releases_immediately THEN v_now END,
                 CASE WHEN prerequisites.releases_immediately THEN 'release' END
            FROM prerequisites
          RETURNING prerequisite_task_id, released_at
        )
        INSERT INTO workhorse.task_event(task_id, event_type, details)
        SELECT task_id,
               CASE WHEN inserted_edges.released_at IS NOT NULL
                 THEN 'dependency_released' ELSE 'dependency_blocked' END,
               jsonb_build_object(
                 'prerequisite_task_id', inserted_edges.prerequisite_task_id,
                 'state', v_state,
                 'reason', CASE
                   WHEN NOT prerequisites.releases_immediately THEN 'prerequisite_pending'
                   WHEN prerequisites.state = 'succeeded' THEN 'prerequisite_already_succeeded'
                   ELSE 'prerequisite_terminal_policy'
                 END
               )
          FROM inserted_edges
          JOIN prerequisites USING (prerequisite_task_id);
        FOR v_terminal IN
          SELECT outcome.task_id, outcome.state FROM workhorse.task_outcome outcome
           WHERE outcome.task_id = ANY(v_prerequisite_task_ids)
           ORDER BY outcome.task_id
        LOOP
          PERFORM workhorse.resolve_dependents_v1(v_terminal.task_id, v_terminal.state);
        END LOOP;
      END IF;
      INSERT INTO workhorse.task_event(task_id, event_type, details)
        VALUES (
          task_id,
          'enqueued',
          jsonb_build_object(
            'state', v_state,
            'priority', v_priority,
            'run_at', v_run_at,
            'deadline_at', v_deadline_at,
            'execution_timeout_ms', v_execution_timeout_ms
          ) ||
          CASE WHEN v_is_keyed THEN jsonb_build_object(
            'idempotency', jsonb_build_object(
              'scope', v_scope,
              'key_preview', v_key_preview,
              'key_digest', v_key_digest,
              'key_length', v_key_length,
              'ttl_ms', v_ttl_ms,
              'expires_at', v_expires_at,
              'request_digest', v_request_digest
            )
          ) ELSE '{}'::jsonb END
        );
      IF v_deadline_at IS NOT NULL AND v_deadline_at <= v_now THEN
        PERFORM workhorse.terminalize_deadline_v1(task_id);
      ELSIF v_state = 'ready' AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    END IF;
    ordinal := v_ordinal;
    accepted := v_is_new;
    RETURN NEXT;
  END LOOP;

  IF cardinality(v_fast_tasks) > 0 THEN
    INSERT INTO workhorse.task SELECT * FROM unnest(v_fast_tasks);
    INSERT INTO workhorse.fast_task_runtime SELECT * FROM unnest(v_fast_runtimes);
    FOREACH v_fast_task_id IN ARRAY v_fast_past_deadline LOOP
      PERFORM workhorse.fast_terminalize_deadline_v1(v_fast_task_id);
    END LOOP;
  END IF;

  FOREACH v_notify_queue IN ARRAY v_ready_queues LOOP
    PERFORM pg_notify('workhorse_tasks', v_notify_queue);
  END LOOP;
END;
$$;

-- Keyed debounce. Inside the window a same-key request replaces the pending definition. Only a task
-- that has never started an attempt and holds no durable wait is pending: a scheduled row may be a
-- suspended wait or a retry backoff, and replacing it would rewrite an attempt already under way.
CREATE OR REPLACE FUNCTION workhorse.enqueue_debounce_v1(p_request jsonb)
RETURNS TABLE (task_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_debounce jsonb := p_request->'debounce';
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_key_preview text;
  v_key_digest text;
  v_key_length integer;
  v_window_ms numeric;
  v_schedule text;
  v_run_at timestamptz;
  v_expires_at timestamptz;
  v_normalized jsonb;
  v_existing record;
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_has_identity boolean;
  v_validation record;
  v_row record;
  v_tags text[];
  v_fingerprint_tags text[];
  v_payload_redact_keys text[];
  v_result_redact_keys text[];
  v_retry_policy jsonb;
  v_fingerprint jsonb;
  v_stored_digest text;
  v_request_digest text;
  v_state text;
  v_sequence bigint;
BEGIN
  IF cardinality(workhorse.lock_queue_tiers_v1(ARRAY[p_request->>'queue'])) > 0 THEN
    PERFORM workhorse.reject_fast_feature_v1(p_request->>'queue', 'debounce');
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object'
     OR v_debounce IS NULL OR jsonb_typeof(v_debounce) <> 'object'
     OR v_debounce - ARRAY['key', 'scope', 'windowMs', 'schedule'] <> '{}'::jsonb
     OR NOT (v_debounce ?& ARRAY['key', 'windowMs', 'schedule'])
     OR jsonb_typeof(v_debounce->'key') <> 'string'
     OR (v_debounce ? 'scope' AND jsonb_typeof(v_debounce->'scope') <> 'string')
     OR jsonb_typeof(v_debounce->'windowMs') <> 'number'
     OR jsonb_typeof(v_debounce->'schedule') <> 'string' THEN
    RAISE EXCEPTION 'debounce requires key, windowMs, schedule, and only an optional scope';
  END IF;
  IF p_request ? 'idempotency' THEN
    RAISE EXCEPTION 'enqueue requests cannot combine idempotency and debounce';
  END IF;
  IF p_request ? 'runAt' THEN
    RAISE EXCEPTION 'debounced enqueue uses its PostgreSQL-owned window instead of runAt';
  END IF;
  IF COALESCE(p_request->'prerequisiteTaskId', 'null'::jsonb) <> 'null'::jsonb
     OR COALESCE(p_request->'dependencies', 'null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION
      'enqueue requests cannot combine debounce or throttle with prerequisiteTaskId or dependencies';
  END IF;

  v_key := v_debounce->>'key';
  v_scope := COALESCE(v_debounce->>'scope', 'default');
  v_window_ms := (v_debounce->>'windowMs')::numeric;
  v_schedule := v_debounce->>'schedule';
  IF v_key = '' OR octet_length(v_key) > 512 THEN
    RAISE EXCEPTION 'debounce key must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF v_scope = '' OR octet_length(v_scope) > 256 THEN
    RAISE EXCEPTION 'debounce scope must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF v_window_ms <> trunc(v_window_ms) OR v_window_ms NOT BETWEEN 1 AND 31536000000 THEN
    RAISE EXCEPTION 'debounce windowMs must be an integer between 1 and 31536000000';
  END IF;
  IF v_schedule NOT IN ('reset', 'preserve') THEN
    RAISE EXCEPTION 'debounce schedule must be reset or preserve';
  END IF;

  v_key_hash := workhorse.idempotency_key_hash_v1(v_scope, v_key);
  v_key_digest := left(encode(v_key_hash, 'hex'), 12);
  v_key_length := char_length(v_key);
  v_key_preview := CASE
    WHEN v_key_length <= 4 THEN repeat('•', v_key_length)
    WHEN v_key_length <= 8 THEN left(v_key, 2) || '…' || right(v_key, 2)
    ELSE left(v_key, 8) || '…' || right(v_key, 4)
  END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || chr(31) || v_key, 0));

  SELECT identity.task_id, identity.request_fingerprint, identity.expires_at,
         identity.coalescing_mode
    INTO v_existing
    FROM workhorse.enqueue_idempotency identity
   WHERE identity.idempotency_scope = v_scope
     AND identity.idempotency_key_hash = v_key_hash
   FOR UPDATE OF identity;
  v_has_identity := FOUND;
  IF v_has_identity THEN
    SELECT runtime.*
      INTO v_runtime
      FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = v_existing.task_id
     FOR UPDATE;
  END IF;

  IF v_has_identity AND v_existing.expires_at > v_now THEN
    IF v_existing.coalescing_mode <> 'debounce'
       OR v_runtime.state IS NULL
       OR v_runtime.state NOT IN ('ready', 'scheduled')
       OR v_runtime.attempt_started_at IS NOT NULL
       OR v_runtime.wait_name IS NOT NULL
       OR v_runtime.current_attempt > 1 THEN
      INSERT INTO workhorse.task_event(task_id, event_type, details)
      VALUES (v_existing.task_id, 'debounce_rejected', jsonb_build_object(
        'state', COALESCE(v_runtime.state, 'terminal'),
        'reason', CASE WHEN v_existing.coalescing_mode <> 'debounce'
          THEN 'incompatible_key_mode' ELSE 'not_pending' END,
        'debounce', jsonb_build_object(
          'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
          'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule
        )
      ));
      task_id := v_existing.task_id;
      outcome := 'non_replaceable';
      RETURN NEXT;
      RETURN;
    END IF;

    v_run_at := CASE WHEN v_schedule = 'reset'
      THEN v_now + v_window_ms * interval '1 millisecond' ELSE v_runtime.run_at END;
    v_expires_at := CASE WHEN v_schedule = 'reset'
      THEN v_now + v_window_ms * interval '1 millisecond' ELSE v_existing.expires_at END;
    v_normalized := (p_request - 'debounce') || jsonb_build_object(
      'runAt', v_run_at,
      'idempotency', jsonb_build_object('key', v_key, 'scope', v_scope, 'ttlMs', v_window_ms)
    );

    BEGIN
      SELECT * INTO v_validation
        FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_normalized));
    EXCEPTION WHEN SQLSTATE 'P1001' THEN
      NULL;
    END;

    v_tags := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_normalized->'tags', '[]'::jsonb))
    );
    v_fingerprint_tags := ARRAY(
      SELECT unique_tags.tag
        FROM (SELECT DISTINCT tag FROM unnest(v_tags) tag) unique_tags
       ORDER BY unique_tags.tag COLLATE "C"
    );
    v_payload_redact_keys := ARRAY(
      SELECT key FROM jsonb_array_elements_text(
        COALESCE(v_normalized->'sensitivePayloadKeys', '[]'::jsonb)
      ) key ORDER BY key COLLATE "C"
    );
    v_result_redact_keys := ARRAY(
      SELECT key FROM jsonb_array_elements_text(
        COALESCE(v_normalized->'sensitiveResultKeys', '[]'::jsonb)
      ) key ORDER BY key COLLATE "C"
    );
    v_retry_policy := workhorse.normalize_retry_policy_v1(v_normalized->'retryPolicy');
    v_fingerprint := jsonb_build_object(
      'queue', v_normalized->>'queue',
      'type', v_normalized->>'type',
      'payload', COALESCE(v_normalized->'payload', 'null'::jsonb),
      'concurrencyKey', to_jsonb(v_normalized->>'concurrencyKey'),
      'contractVersion', to_jsonb(v_normalized->>'contractVersion'),
      'payloadMaxBytes', COALESCE((v_normalized->>'payloadMaxBytes')::numeric, 1048576),
      'resultMaxBytes', COALESCE((v_normalized->>'resultMaxBytes')::numeric, 1048576),
      'sensitivePayloadKeys', to_jsonb(v_payload_redact_keys),
      'sensitiveResultKeys', to_jsonb(v_result_redact_keys),
      'tags', to_jsonb(v_fingerprint_tags),
      'runAt', to_jsonb(v_run_at),
      'deadline', to_jsonb((v_normalized->>'deadline')::timestamptz),
      'executionTimeoutMs', to_jsonb((v_normalized->>'executionTimeoutMs')::numeric),
      'maxAttempts', COALESCE((v_normalized->>'maxAttempts')::integer, 25),
      'retryPolicy', v_retry_policy,
      'priority', COALESCE((v_normalized->>'priority')::integer, 0),
      'ttlMs', v_window_ms
    ) || CASE WHEN v_normalized->>'budget' IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('budget', v_normalized->>'budget') END;
    v_stored_digest := workhorse.sha256_hex_v1(v_existing.request_fingerprint::text);
    v_request_digest := workhorse.sha256_hex_v1(v_fingerprint::text);

    UPDATE workhorse.task SET
      queue_name = v_normalized->>'queue',
      task_type = v_normalized->>'type',
      concurrency_key = v_normalized->>'concurrencyKey',
      payload = COALESCE(v_normalized->'payload', 'null'::jsonb),
      contract_version = v_normalized->>'contractVersion',
      payload_max_bytes = COALESCE((v_normalized->>'payloadMaxBytes')::integer, 1048576),
      result_max_bytes = COALESCE((v_normalized->>'resultMaxBytes')::integer, 1048576),
      payload_redact_keys = v_payload_redact_keys,
      result_redact_keys = v_result_redact_keys,
      trace_context = v_normalized->'traceContext',
      tags = v_tags,
      priority = COALESCE((v_normalized->>'priority')::integer, 0),
      max_attempts = COALESCE((v_normalized->>'maxAttempts')::integer, 25),
      retry_policy = v_retry_policy,
      deadline_at = (v_normalized->>'deadline')::timestamptz,
      execution_timeout_ms = (v_normalized->>'executionTimeoutMs')::bigint,
      budget_name = v_normalized->>'budget'
    WHERE id = v_existing.task_id;

    v_state := CASE WHEN v_run_at <= v_now THEN 'ready' ELSE 'scheduled' END;
    v_sequence := CASE
      WHEN v_state = 'ready' AND v_runtime.state = 'ready' THEN v_runtime.sequence
      WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq')
      ELSE NULL
    END;
    UPDATE workhorse.task_runtime runtime SET
      queue_name = v_normalized->>'queue',
      concurrency_key = v_normalized->>'concurrencyKey',
      budget_name = v_normalized->>'budget',
      priority = COALESCE((v_normalized->>'priority')::integer, 0),
      state = v_state,
      run_at = v_run_at,
      ready_at = CASE WHEN v_state = 'ready'
        THEN COALESCE(v_runtime.ready_at, v_now) ELSE NULL END,
      sequence = v_sequence,
      deadline_at = (v_normalized->>'deadline')::timestamptz,
      updated_at = v_now
    WHERE runtime.task_id = v_existing.task_id;

    UPDATE workhorse.enqueue_idempotency SET
      request_fingerprint = v_fingerprint,
      expires_at = v_expires_at
    WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;

    INSERT INTO workhorse.task_event(task_id, event_type, details)
    VALUES (v_existing.task_id, 'debounced', jsonb_build_object(
      'state', v_state, 'run_at', v_run_at,
      'stored_request_digest', v_stored_digest, 'request_digest', v_request_digest,
      'debounce', jsonb_build_object(
        'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
        'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule,
        'expires_at', v_expires_at
      )
    ));
    IF (v_normalized->>'deadline')::timestamptz <= v_now THEN
      PERFORM workhorse.terminalize_deadline_v1(v_existing.task_id);
    ELSIF v_state = 'ready' THEN
      PERFORM pg_notify('workhorse_tasks', v_normalized->>'queue');
    END IF;
    task_id := v_existing.task_id;
    outcome := 'replaced';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_has_identity AND v_existing.expires_at <= v_now
     AND v_runtime.state IN ('ready', 'scheduled') THEN
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    VALUES (v_existing.task_id, 'debounce_rejected', jsonb_build_object(
      'state', v_runtime.state, 'reason', 'window_elapsed_pending',
      'debounce', jsonb_build_object(
        'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
        'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule
      )
    ));
    task_id := v_existing.task_id;
    outcome := 'non_replaceable';
    RETURN NEXT;
    RETURN;
  END IF;

  v_run_at := v_now + v_window_ms * interval '1 millisecond';
  v_normalized := (p_request - 'debounce') || jsonb_build_object(
    'runAt', v_run_at,
    'idempotency', jsonb_build_object('key', v_key, 'scope', v_scope, 'ttlMs', v_window_ms)
  );
  SELECT * INTO v_row FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_normalized));
  UPDATE workhorse.enqueue_idempotency SET coalescing_mode = 'debounce', expires_at = v_run_at
   WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;
  UPDATE workhorse.task_event event SET details = event.details || jsonb_build_object(
    'debounce', jsonb_build_object(
      'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
      'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule,
      'expires_at', v_run_at
    )
  ) || jsonb_build_object(
    'idempotency', jsonb_set(event.details->'idempotency', '{expires_at}', to_jsonb(v_run_at))
  ) WHERE event.task_id = v_row.task_id AND event.event_type = 'enqueued';
  task_id := v_row.task_id;
  outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'replayed' END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_throttle_v1(p_request jsonb)
RETURNS TABLE (task_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz;
  v_throttle jsonb := p_request->'throttle';
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_key_digest text;
  v_key_length integer;
  v_window_ms numeric;
  v_expires_at timestamptz;
  v_existing record;
  v_normalized jsonb;
  v_row record;
BEGIN
  IF cardinality(workhorse.lock_queue_tiers_v1(ARRAY[p_request->>'queue'])) > 0 THEN
    PERFORM workhorse.reject_fast_feature_v1(p_request->>'queue', 'throttle');
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object'
     OR v_throttle IS NULL OR jsonb_typeof(v_throttle) <> 'object'
     OR v_throttle - ARRAY['key', 'scope', 'windowMs'] <> '{}'::jsonb
     OR NOT (v_throttle ?& ARRAY['key', 'windowMs'])
     OR jsonb_typeof(v_throttle->'key') <> 'string'
     OR (v_throttle ? 'scope' AND jsonb_typeof(v_throttle->'scope') <> 'string')
     OR jsonb_typeof(v_throttle->'windowMs') <> 'number' THEN
    RAISE EXCEPTION 'throttle requires key, windowMs, and only an optional scope';
  END IF;
  IF p_request ? 'idempotency' OR p_request ? 'debounce' THEN
    RAISE EXCEPTION 'enqueue requests cannot combine idempotency, debounce, or throttle';
  END IF;
  IF COALESCE(p_request->'prerequisiteTaskId', 'null'::jsonb) <> 'null'::jsonb
     OR COALESCE(p_request->'dependencies', 'null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION
      'enqueue requests cannot combine debounce or throttle with prerequisiteTaskId or dependencies';
  END IF;

  v_key := v_throttle->>'key';
  v_scope := COALESCE(v_throttle->>'scope', 'default');
  v_window_ms := (v_throttle->>'windowMs')::numeric;
  IF v_key = '' OR octet_length(v_key) > 512 THEN
    RAISE EXCEPTION 'throttle key must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF v_scope = '' OR octet_length(v_scope) > 256 THEN
    RAISE EXCEPTION 'throttle scope must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF v_window_ms <> trunc(v_window_ms) OR v_window_ms NOT BETWEEN 1 AND 31536000000 THEN
    RAISE EXCEPTION 'throttle windowMs must be an integer between 1 and 31536000000';
  END IF;

  v_key_hash := workhorse.idempotency_key_hash_v1(v_scope, v_key);
  v_key_digest := left(encode(v_key_hash, 'hex'), 12);
  v_key_length := char_length(v_key);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || chr(31) || v_key, 0));
  v_now := clock_timestamp();
  SELECT identity.task_id, identity.expires_at, identity.coalescing_mode
    INTO v_existing
    FROM workhorse.enqueue_idempotency identity
   WHERE identity.idempotency_scope = v_scope
     AND identity.idempotency_key_hash = v_key_hash
   FOR UPDATE OF identity;
  IF FOUND AND v_existing.expires_at > v_now
     AND v_existing.coalescing_mode <> 'throttle' THEN
    RAISE EXCEPTION 'throttle key is retained for incompatible coalescing mode';
  END IF;

  v_normalized := (p_request - 'throttle') || jsonb_build_object(
    'idempotency', jsonb_build_object('key', v_key, 'scope', v_scope, 'ttlMs', v_window_ms)
  );
  SELECT * INTO v_row FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_normalized));
  IF v_row.accepted THEN
    UPDATE workhorse.enqueue_idempotency SET coalescing_mode = 'throttle'
    WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;
  END IF;
  SELECT expires_at INTO v_expires_at
    FROM workhorse.enqueue_idempotency
   WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;
  IF v_row.accepted THEN
    UPDATE workhorse.task_event event SET details = event.details || jsonb_build_object(
      'throttle', jsonb_build_object(
        'scope', v_scope, 'key_digest', v_key_digest, 'key_length', v_key_length,
        'window_ms', v_window_ms, 'expires_at', v_expires_at
      )
    ) WHERE event.task_id = v_row.task_id AND event.event_type = 'enqueued';
  ELSE
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    VALUES (v_row.task_id, 'throttled', jsonb_build_object(
      'throttle', jsonb_build_object(
        'scope', v_scope, 'key_digest', v_key_digest, 'key_length', v_key_length,
        'window_ms', v_window_ms, 'expires_at', v_expires_at
      )
    ));
  END IF;
  task_id := v_row.task_id;
  outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'coalesced' END;
  RETURN NEXT;
END;
$$;

-- The client batch entry point. Adds keyed debounce and throttle handling over
-- workhorse.enqueue_batch_v1 and reports one coalescing outcome per member.
CREATE OR REPLACE FUNCTION workhorse.enqueue_many_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, outcome text, reason text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request jsonb;
  v_ordinal integer;
  v_row record;
  v_lock record;
  v_error_message text;
  v_error_detail text;
  v_contract_mismatch jsonb;
  v_fast_queue text;
  v_fast_feature text;
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  IF jsonb_array_length(p_requests) > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
  END IF;

  SELECT jsonb_build_object(
           'taskTypes', jsonb_agg(mismatch.task_type ORDER BY mismatch.task_type COLLATE "C")
         )
    INTO v_contract_mismatch
    FROM (
      SELECT DISTINCT request->>'type' AS task_type
        FROM jsonb_array_elements(p_requests) input(request)
        JOIN workhorse.contract_policy policy ON policy.task_type = request->>'type'
       WHERE request ? 'contractVersion'
         AND request->>'contractVersion' IS DISTINCT FROM policy.current_version
  ) mismatch;
  IF jsonb_typeof(v_contract_mismatch->'taskTypes') = 'array' THEN
    ordinal := 0;
    task_id := NULL;
    outcome := 'contract_mismatch';
    reason := v_contract_mismatch::text;
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_requests) input(request)
     WHERE (request ? 'idempotency')::integer
         + (request ? 'debounce')::integer
         + (request ? 'throttle')::integer > 1
  ) THEN
    RAISE EXCEPTION 'enqueue requests cannot combine idempotency, debounce, or throttle';
  END IF;

  IF EXISTS (
    SELECT keyed.scope, keyed.key
      FROM (
        SELECT COALESCE(request->'idempotency'->>'scope', 'default') AS scope,
               request->'idempotency'->>'key' AS key, 'idempotency' AS mode
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'idempotency'
        UNION ALL
        SELECT COALESCE(request->'debounce'->>'scope', 'default') AS scope,
               request->'debounce'->>'key' AS key, 'debounce' AS mode
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'debounce'
        UNION ALL
        SELECT COALESCE(request->'throttle'->>'scope', 'default') AS scope,
               request->'throttle'->>'key' AS key, 'throttle' AS mode
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'throttle'
      ) keyed
     WHERE keyed.key IS NOT NULL
     GROUP BY keyed.scope, keyed.key
    HAVING count(DISTINCT keyed.mode) > 1
  ) THEN
    RAISE EXCEPTION 'one enqueue batch cannot reuse a scoped key across incompatible coalescing modes';
  END IF;

  FOR v_lock IN
    SELECT ordered.scope, ordered.key
      FROM (
        SELECT DISTINCT keyed.scope COLLATE "C" AS scope, keyed.key COLLATE "C" AS key
          FROM (
        SELECT COALESCE(request->'debounce'->>'scope', 'default') AS scope,
               request->'debounce'->>'key' AS key
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'debounce'
        UNION ALL
        SELECT COALESCE(request->'throttle'->>'scope', 'default') AS scope,
               request->'throttle'->>'key' AS key
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'throttle'
        UNION ALL
        SELECT COALESCE(request->'idempotency'->>'scope', 'default') AS scope,
               request->'idempotency'->>'key' AS key
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'idempotency'
          ) keyed
         WHERE keyed.key IS NOT NULL
      ) ordered
     ORDER BY ordered.scope, ordered.key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock.scope || chr(31) || v_lock.key, 0));
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_requests) input(request)
      JOIN workhorse.enqueue_idempotency identity
        ON identity.idempotency_scope = COALESCE(request->'idempotency'->>'scope', 'default')
       AND identity.idempotency_key_hash = workhorse.idempotency_key_hash_v1(
             COALESCE(request->'idempotency'->>'scope', 'default'),
             request->'idempotency'->>'key'
           )
     WHERE request ? 'idempotency'
       AND jsonb_typeof(request->'idempotency') = 'object'
       AND jsonb_typeof(request->'idempotency'->'key') = 'string'
       AND identity.expires_at > clock_timestamp()
       AND identity.coalescing_mode <> 'idempotency'
  ) THEN
    RAISE EXCEPTION 'idempotency key is retained for incompatible coalescing mode';
  END IF;

  -- Report a coalescing request on a fast-tier queue with its ordinal before any request runs.
  SELECT input.request->>'queue',
         CASE WHEN input.request ? 'debounce' THEN 'debounce' ELSE 'throttle' END,
         input.ordinality::integer
    INTO v_fast_queue, v_fast_feature, v_ordinal
    FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
   WHERE (input.request ? 'debounce' OR input.request ? 'throttle')
     AND input.request->>'queue' = ANY(workhorse.lock_queue_tiers_v1(ARRAY(
       SELECT DISTINCT candidate->>'queue'
         FROM jsonb_array_elements(p_requests) candidate
        WHERE candidate ? 'debounce' OR candidate ? 'throttle'
     )))
   ORDER BY input.ordinality
   LIMIT 1;
  IF FOUND THEN
    PERFORM workhorse.reject_fast_feature_v1(v_fast_queue, v_fast_feature, v_ordinal);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) input(request)
     WHERE request ? 'debounce' OR request ? 'throttle'
  ) THEN
    RETURN QUERY
      SELECT result.ordinal, result.task_id,
             CASE WHEN result.accepted THEN 'accepted' ELSE 'replayed' END,
             NULL::text
        FROM workhorse.enqueue_batch_v1(p_requests) result ORDER BY result.ordinal;
    RETURN;
  END IF;

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    IF v_request ? 'debounce' THEN
      SELECT * INTO v_row FROM workhorse.enqueue_debounce_v1(v_request);
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := v_row.outcome;
      reason := CASE WHEN outcome = 'non_replaceable' THEN (
        SELECT event.details->>'reason'
          FROM workhorse.task_event event
         WHERE event.task_id = v_row.task_id
           AND event.event_type = 'debounce_rejected'
         ORDER BY event.occurred_at DESC, event.event_id DESC
         LIMIT 1
      ) ELSE NULL END;
    ELSIF v_request ? 'throttle' THEN
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_throttle_v1(v_request);
      EXCEPTION WHEN SQLSTATE 'P1001' THEN
        GET STACKED DIAGNOSTICS
          v_error_message = MESSAGE_TEXT,
          v_error_detail = PG_EXCEPTION_DETAIL;
        RAISE EXCEPTION USING
          ERRCODE = 'P1001',
          MESSAGE = v_error_message,
          DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
      END;
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := v_row.outcome;
      reason := NULL;
    ELSE
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_request));
      EXCEPTION WHEN SQLSTATE 'P1001' THEN
        GET STACKED DIAGNOSTICS
          v_error_message = MESSAGE_TEXT,
          v_error_detail = PG_EXCEPTION_DETAIL;
        RAISE EXCEPTION USING
          ERRCODE = 'P1001',
          MESSAGE = v_error_message,
          DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
      END;
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'replayed' END;
      reason := NULL;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.list_dead_letters_v1(
  p_filter jsonb DEFAULT '{}'::jsonb,
  p_limit integer DEFAULT 100,
  p_cursor_finished_at timestamptz DEFAULT NULL,
  p_cursor_task_id uuid DEFAULT NULL
) RETURNS TABLE (
  task_id uuid, queue_name text, task_type text, concurrency_key text, priority integer,
  payload jsonb, tags text[],
  current_attempt integer, max_attempts integer, retry_policy jsonb,
  deadline_at timestamptz, execution_timeout_ms bigint, error jsonb,
  finished_at timestamptz, redrive_count integer, has_more boolean,
  cursor_finished_at text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_filter jsonb := COALESCE(p_filter, '{}'::jsonb);
  v_tags text[];
  v_finished_after timestamptz;
  v_finished_before timestamptz;
BEGIN
  IF jsonb_typeof(v_filter) <> 'object'
     OR v_filter - ARRAY['queue', 'type', 'tags', 'errorName', 'finishedAfter', 'finishedBefore']
        <> '{}'::jsonb THEN
    RAISE EXCEPTION 'dead-letter filter must be an object containing only queue, type, tags, errorName, finishedAfter, and finishedBefore';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'dead-letter limit must be between 1 and 1000';
  END IF;
  IF (p_cursor_finished_at IS NULL) <> (p_cursor_task_id IS NULL) THEN
    RAISE EXCEPTION 'dead-letter cursor requires both finished_at and task_id';
  END IF;
  IF p_cursor_finished_at IS NOT NULL AND NOT isfinite(p_cursor_finished_at) THEN
    RAISE EXCEPTION 'dead-letter cursor finished_at must be finite';
  END IF;
  IF v_filter ? 'queue' AND (
       jsonb_typeof(v_filter->'queue') <> 'string' OR v_filter->>'queue' = ''
     ) THEN RAISE EXCEPTION 'dead-letter queue filter must be a non-empty string'; END IF;
  IF v_filter ? 'type' AND (
       jsonb_typeof(v_filter->'type') <> 'string' OR v_filter->>'type' = ''
     ) THEN RAISE EXCEPTION 'dead-letter type filter must be a non-empty string'; END IF;
  IF v_filter ? 'errorName' AND (
       jsonb_typeof(v_filter->'errorName') <> 'string' OR v_filter->>'errorName' = ''
     ) THEN RAISE EXCEPTION 'dead-letter errorName filter must be a non-empty string'; END IF;
  IF v_filter ? 'tags' THEN
    IF jsonb_typeof(v_filter->'tags') <> 'array' THEN
      RAISE EXCEPTION 'dead-letter tags filter must be an array';
    END IF;
    SELECT COALESCE(array_agg(value), '{}') INTO v_tags
      FROM jsonb_array_elements_text(v_filter->'tags') tag(value);
    IF NOT workhorse.valid_tags_v1(v_tags) THEN
      RAISE EXCEPTION 'dead-letter tags filter must contain at most 20 non-empty tags of at most 100 characters';
    END IF;
  END IF;
  IF v_filter ? 'finishedAfter' THEN
    IF jsonb_typeof(v_filter->'finishedAfter') <> 'string' THEN
      RAISE EXCEPTION 'dead-letter finishedAfter filter must be a timestamp string';
    END IF;
    v_finished_after := (v_filter->>'finishedAfter')::timestamptz;
    IF NOT isfinite(v_finished_after) THEN RAISE EXCEPTION 'dead-letter finishedAfter must be finite'; END IF;
  END IF;
  IF v_filter ? 'finishedBefore' THEN
    IF jsonb_typeof(v_filter->'finishedBefore') <> 'string' THEN
      RAISE EXCEPTION 'dead-letter finishedBefore filter must be a timestamp string';
    END IF;
    v_finished_before := (v_filter->>'finishedBefore')::timestamptz;
    IF NOT isfinite(v_finished_before) THEN RAISE EXCEPTION 'dead-letter finishedBefore must be finite'; END IF;
  END IF;
  IF v_finished_after IS NOT NULL AND v_finished_before IS NOT NULL
     AND v_finished_after >= v_finished_before THEN
    RAISE EXCEPTION 'dead-letter finishedAfter must be earlier than finishedBefore';
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT task.id, task.queue_name, task.task_type, task.concurrency_key, task.priority,
           workhorse.redact_top_level_keys_v1(task.payload, task.payload_redact_keys) AS payload,
           task.tags,
           outcome.current_attempt, task.max_attempts, task.retry_policy,
           task.deadline_at, task.execution_timeout_ms, outcome.error,
           outcome.finished_at,
           (SELECT count(*)::integer FROM workhorse.task_redrive redrive
             WHERE redrive.source_task_id = task.id) AS redrive_count
      FROM (
        SELECT full_outcome.task_id, full_outcome.current_attempt, full_outcome.error,
               full_outcome.finished_at
          FROM workhorse.task_outcome full_outcome
         WHERE full_outcome.state = 'failed'
        UNION ALL
        SELECT fast_outcome.task_id, fast_outcome.attempt, fast_outcome.error,
               fast_outcome.finished_at
          FROM workhorse.fast_task_outcome fast_outcome
         WHERE fast_outcome.state = 'failed'
      ) outcome
      JOIN workhorse.task task ON task.id = outcome.task_id
     WHERE true
       AND (NOT (v_filter ? 'queue') OR task.queue_name = v_filter->>'queue')
       AND (NOT (v_filter ? 'type') OR task.task_type = v_filter->>'type')
       AND (v_tags IS NULL OR task.tags @> v_tags)
       AND (NOT (v_filter ? 'errorName') OR outcome.error->>'name' = v_filter->>'errorName')
       AND (v_finished_after IS NULL OR outcome.finished_at >= v_finished_after)
       AND (v_finished_before IS NULL OR outcome.finished_at < v_finished_before)
       AND (p_cursor_finished_at IS NULL OR
            (outcome.finished_at, outcome.task_id) < (p_cursor_finished_at, p_cursor_task_id))
     ORDER BY outcome.finished_at DESC, outcome.task_id DESC
     LIMIT p_limit + 1
  )
  SELECT candidate.id, candidate.queue_name, candidate.task_type, candidate.concurrency_key,
         candidate.priority, candidate.payload, candidate.tags,
         candidate.current_attempt, candidate.max_attempts, candidate.retry_policy,
         candidate.deadline_at, candidate.execution_timeout_ms, candidate.error,
         candidate.finished_at, candidate.redrive_count,
         (SELECT count(*) FROM candidates) > p_limit,
         to_char(candidate.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    FROM candidates candidate
   ORDER BY candidate.finished_at DESC, candidate.id DESC
   LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.redrive_v1(
  p_source_task_id uuid,
  p_requested_by text,
  p_reason text,
  p_request_id text
) RETURNS TABLE (
  status text, source_task_id uuid, target_task_id uuid, source_state text,
  target_state text, requested_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_task workhorse.task%ROWTYPE;
  v_source_state text;
  v_source_attempt integer;
  v_target_fast boolean;
  v_existing workhorse.task_redrive%ROWTYPE;
  v_fingerprint jsonb;
  v_conflicting_fields text[];
  v_request_id_hash bytea;
  v_request_id_preview text;
  v_request_id_digest text;
  v_request_id_length integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_source_task_id IS NULL THEN RAISE EXCEPTION 'source_task_id is required'; END IF;
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;

  v_fingerprint := jsonb_build_object('requestedBy', p_requested_by, 'reason', p_reason);
  v_request_id_hash := sha256(convert_to(p_request_id, 'UTF8'));
  v_request_id_digest := left(encode(v_request_id_hash, 'hex'), 12);
  v_request_id_length := char_length(p_request_id);
  v_request_id_preview := CASE
    WHEN v_request_id_length <= 4 THEN repeat('•', v_request_id_length)
    WHEN v_request_id_length <= 8 THEN left(p_request_id, 2) || '…' || right(p_request_id, 2)
    ELSE left(p_request_id, 8) || '…' || right(p_request_id, 4)
  END;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workhorse:redrive:' || p_source_task_id::text || ':' || p_request_id, 0
  ));

  SELECT * INTO v_existing FROM workhorse.task_redrive redrive
   WHERE redrive.source_task_id = p_source_task_id
     AND redrive.request_id_hash = v_request_id_hash;
  IF FOUND THEN
    IF v_existing.request_fingerprint <> v_fingerprint THEN
      SELECT COALESCE(array_agg(field ORDER BY field COLLATE "C"), '{}')
        INTO v_conflicting_fields
        FROM jsonb_object_keys(v_fingerprint) field
       WHERE v_existing.request_fingerprint->field IS DISTINCT FROM v_fingerprint->field;
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'redrive request conflict with a retained request',
        DETAIL = jsonb_build_object(
          'sourceTaskId', p_source_task_id,
          'existingTargetTaskId', v_existing.target_task_id,
          'requestIdPreview', v_request_id_preview,
          'requestIdDigest', v_request_id_digest,
          'requestIdLength', v_request_id_length,
          'conflictingFields', to_jsonb(v_conflicting_fields),
          'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
          'rejectedRequestDigest', workhorse.sha256_hex_v1(v_fingerprint::text)
        )::text;
    END IF;
    RETURN QUERY
    SELECT 'replayed'::text, p_source_task_id, v_existing.target_task_id,
           'failed'::text,
           COALESCE(runtime.state, outcome.state), v_existing.requested_at
      FROM (VALUES (1)) singleton(value)
      LEFT JOIN LATERAL (
        SELECT full_runtime.state FROM workhorse.task_runtime full_runtime
         WHERE full_runtime.task_id = v_existing.target_task_id
        UNION ALL
        SELECT fast_runtime.state FROM workhorse.fast_task_runtime fast_runtime
         WHERE fast_runtime.task_id = v_existing.target_task_id
      ) runtime ON true
      LEFT JOIN LATERAL (
        SELECT full_outcome.state FROM workhorse.task_outcome full_outcome
         WHERE full_outcome.task_id = v_existing.target_task_id
        UNION ALL
        SELECT fast_outcome.state FROM workhorse.fast_task_outcome fast_outcome
         WHERE fast_outcome.task_id = v_existing.target_task_id
      ) outcome ON true;
    RETURN;
  END IF;

  SELECT task.* INTO v_task FROM workhorse.task task
   WHERE task.id = p_source_task_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN QUERY VALUES ('not_found'::text, p_source_task_id, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz);
    RETURN;
  END IF;
  -- A task has its outcome in exactly one of the two tables, depending on its tier at enqueue.
  SELECT outcome.state, outcome.current_attempt INTO v_source_state, v_source_attempt
    FROM workhorse.task_outcome outcome
   WHERE outcome.task_id = p_source_task_id FOR SHARE;
  IF NOT FOUND THEN
    SELECT outcome.state, outcome.attempt INTO v_source_state, v_source_attempt
      FROM workhorse.fast_task_outcome outcome
     WHERE outcome.task_id = p_source_task_id FOR SHARE;
  END IF;
  IF v_source_state IS DISTINCT FROM 'failed' THEN
    RETURN QUERY VALUES (
      'not_failed'::text, p_source_task_id, NULL::uuid,
      COALESCE(
        v_source_state,
        (SELECT runtime.state FROM workhorse.task_runtime runtime
          WHERE runtime.task_id = p_source_task_id),
        (SELECT runtime.state FROM workhorse.fast_task_runtime runtime
          WHERE runtime.task_id = p_source_task_id)
      ),
      NULL::text, NULL::timestamptz
    );
    RETURN;
  END IF;

  -- The copy takes the queue's current tier, not the source's. A queue that moved to the fast tier
  -- cannot accept a copy that carries a full-tier feature.
  v_target_fast := cardinality(workhorse.lock_queue_tiers_v1(ARRAY[v_task.queue_name])) > 0;
  IF v_target_fast AND v_task.concurrency_key IS NOT NULL THEN
    PERFORM workhorse.reject_fast_feature_v1(v_task.queue_name, 'concurrency keys');
  ELSIF v_target_fast AND v_task.budget_name IS NOT NULL THEN
    PERFORM workhorse.reject_fast_feature_v1(v_task.queue_name, 'budgets');
  END IF;

  target_task_id := gen_random_uuid();
  INSERT INTO workhorse.task(
    id, queue_name, task_type, concurrency_key, priority, payload, contract_version,
    payload_max_bytes, result_max_bytes,
    payload_redact_keys, result_redact_keys, tags, max_attempts, retry_policy,
    deadline_at, execution_timeout_ms, budget_name
  ) VALUES (
    target_task_id, v_task.queue_name, v_task.task_type, v_task.concurrency_key, v_task.priority,
    v_task.payload, v_task.contract_version,
    v_task.payload_max_bytes, v_task.result_max_bytes,
    v_task.payload_redact_keys, v_task.result_redact_keys, v_task.tags,
    v_task.max_attempts, v_task.retry_policy, NULL, v_task.execution_timeout_ms, v_task.budget_name
  );
  IF v_target_fast THEN
    INSERT INTO workhorse.fast_task_runtime(
      task_id, queue_name, task_type, state, priority, run_at, sequence, payload, contract_version,
      result_max_bytes, redact, retry_policy, max_attempts, execution_timeout_ms, enqueued_at
    ) VALUES (
      target_task_id, v_task.queue_name, v_task.task_type, 'ready', v_task.priority, v_now,
      nextval('workhorse.ready_sequence_seq'), v_task.payload, v_task.contract_version,
      v_task.result_max_bytes,
      cardinality(v_task.payload_redact_keys) > 0 OR cardinality(v_task.result_redact_keys) > 0,
      v_task.retry_policy, v_task.max_attempts, v_task.execution_timeout_ms, v_now
    );
  ELSE
    INSERT INTO workhorse.task_runtime(
      task_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at, sequence,
      deadline_at, budget_name
    ) VALUES (
      target_task_id, v_task.queue_name, v_task.concurrency_key, v_task.priority, 'ready', 1, v_now, v_now,
      nextval('workhorse.ready_sequence_seq'), NULL, v_task.budget_name
    );
  END IF;
  INSERT INTO workhorse.task_redrive(
    source_task_id, target_task_id, request_id_hash, request_id_preview,
    request_id_digest, request_id_length, requested_by, reason,
    request_fingerprint, source_state, target_initial_state, requested_at
  ) VALUES (
    p_source_task_id, target_task_id, v_request_id_hash, v_request_id_preview,
    v_request_id_digest, v_request_id_length, p_requested_by, p_reason,
    v_fingerprint, 'failed', 'ready', v_now
  );
  -- The history foreign key keeps the source identity while this event is retained. Semantic
  -- terminal evidence and its materialization watermark remain immutable.
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (p_source_task_id, v_source_attempt, 'redriven', jsonb_build_object(
      'target_task_id', target_task_id,
      'request_id_preview', v_request_id_preview,
      'request_id_digest', v_request_id_digest,
      'request_id_length', v_request_id_length,
      'requested_by', p_requested_by, 'reason', p_reason, 'requested_at', v_now
    ));
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (target_task_id, 1, 'redrive_created', jsonb_build_object(
      'source_task_id', p_source_task_id,
      'request_id_preview', v_request_id_preview,
      'request_id_digest', v_request_id_digest,
      'request_id_length', v_request_id_length,
      'requested_by', p_requested_by, 'reason', p_reason, 'requested_at', v_now,
      'state', 'ready', 'priority', v_task.priority
    ));
  PERFORM pg_notify('workhorse_tasks', v_task.queue_name);
  RETURN QUERY VALUES (
    'redriven'::text, p_source_task_id, target_task_id, 'failed'::text, 'ready'::text, v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.redrive_many_v1(
  p_filter jsonb,
  p_limit integer,
  p_dry_run boolean,
  p_requested_by text,
  p_reason text,
  p_request_id text,
  p_cursor_finished_at timestamptz DEFAULT NULL,
  p_cursor_task_id uuid DEFAULT NULL
) RETURNS TABLE (
  ordinal integer, status text, source_task_id uuid, target_task_id uuid,
  source_state text, target_state text, requested_at timestamptz,
  source_finished_at_cursor text, has_more boolean
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_filter jsonb := COALESCE(p_filter, '{}'::jsonb);
  v_tags text[];
  v_finished_after timestamptz;
  v_finished_before timestamptz;
  v_candidate record;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'bulk redrive limit must be between 1 and 1000';
  END IF;
  IF (p_cursor_finished_at IS NULL) <> (p_cursor_task_id IS NULL) THEN
    RAISE EXCEPTION 'bulk redrive cursor requires both finished_at and task_id';
  END IF;
  IF p_cursor_finished_at IS NOT NULL AND NOT isfinite(p_cursor_finished_at) THEN
    RAISE EXCEPTION 'bulk redrive cursor finished_at must be finite';
  END IF;
  IF p_dry_run IS NULL THEN RAISE EXCEPTION 'bulk redrive dry_run is required'; END IF;
  -- Validate attribution even for an empty selection and dry runs.
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF jsonb_typeof(v_filter) <> 'object'
     OR v_filter - ARRAY['queue', 'type', 'tags', 'errorName', 'finishedAfter', 'finishedBefore']
        <> '{}'::jsonb THEN
    RAISE EXCEPTION 'bulk redrive filter must be an object containing only queue, type, tags, errorName, finishedAfter, and finishedBefore';
  END IF;
  IF v_filter ? 'queue' AND (
       jsonb_typeof(v_filter->'queue') <> 'string' OR v_filter->>'queue' = ''
     ) THEN RAISE EXCEPTION 'bulk redrive queue filter must be a non-empty string'; END IF;
  IF v_filter ? 'type' AND (
       jsonb_typeof(v_filter->'type') <> 'string' OR v_filter->>'type' = ''
     ) THEN RAISE EXCEPTION 'bulk redrive type filter must be a non-empty string'; END IF;
  IF v_filter ? 'errorName' AND (
       jsonb_typeof(v_filter->'errorName') <> 'string' OR v_filter->>'errorName' = ''
     ) THEN RAISE EXCEPTION 'bulk redrive errorName filter must be a non-empty string'; END IF;
  IF v_filter ? 'tags' THEN
    IF jsonb_typeof(v_filter->'tags') <> 'array' THEN
      RAISE EXCEPTION 'bulk redrive tags filter must be an array';
    END IF;
    SELECT COALESCE(array_agg(value), '{}') INTO v_tags
      FROM jsonb_array_elements_text(v_filter->'tags') tag(value);
    IF NOT workhorse.valid_tags_v1(v_tags) THEN
      RAISE EXCEPTION 'bulk redrive tags filter must contain at most 20 non-empty tags of at most 100 characters';
    END IF;
  END IF;
  IF v_filter ? 'finishedAfter' THEN
    IF jsonb_typeof(v_filter->'finishedAfter') <> 'string' THEN
      RAISE EXCEPTION 'bulk redrive finishedAfter filter must be a timestamp string';
    END IF;
    v_finished_after := (v_filter->>'finishedAfter')::timestamptz;
    IF NOT isfinite(v_finished_after) THEN RAISE EXCEPTION 'bulk redrive finishedAfter must be finite'; END IF;
  END IF;
  IF v_filter ? 'finishedBefore' THEN
    IF jsonb_typeof(v_filter->'finishedBefore') <> 'string' THEN
      RAISE EXCEPTION 'bulk redrive finishedBefore filter must be a timestamp string';
    END IF;
    v_finished_before := (v_filter->>'finishedBefore')::timestamptz;
    IF NOT isfinite(v_finished_before) THEN RAISE EXCEPTION 'bulk redrive finishedBefore must be finite'; END IF;
  END IF;
  IF v_finished_after IS NOT NULL AND v_finished_before IS NOT NULL
     AND v_finished_after >= v_finished_before THEN
    RAISE EXCEPTION 'bulk redrive finishedAfter must be earlier than finishedBefore';
  END IF;

  ordinal := 0;
  FOR v_candidate IN
    WITH candidates AS MATERIALIZED (
      SELECT outcome.task_id, outcome.finished_at
        FROM (
          SELECT full_outcome.task_id, full_outcome.finished_at, full_outcome.error
            FROM workhorse.task_outcome full_outcome
           WHERE full_outcome.state = 'failed'
          UNION ALL
          SELECT fast_outcome.task_id, fast_outcome.finished_at, fast_outcome.error
            FROM workhorse.fast_task_outcome fast_outcome
           WHERE fast_outcome.state = 'failed'
        ) outcome
        JOIN workhorse.task task ON task.id = outcome.task_id
       WHERE true
         AND (NOT (v_filter ? 'queue') OR task.queue_name = v_filter->>'queue')
         AND (NOT (v_filter ? 'type') OR task.task_type = v_filter->>'type')
         AND (v_tags IS NULL OR task.tags @> v_tags)
         AND (NOT (v_filter ? 'errorName') OR outcome.error->>'name' = v_filter->>'errorName')
         AND (v_finished_after IS NULL OR outcome.finished_at >= v_finished_after)
         AND (v_finished_before IS NULL OR outcome.finished_at < v_finished_before)
         AND (p_cursor_finished_at IS NULL OR
              (outcome.finished_at, outcome.task_id) > (p_cursor_finished_at, p_cursor_task_id))
       ORDER BY outcome.finished_at, outcome.task_id
       LIMIT p_limit + 1
    )
    SELECT candidate.task_id, candidate.finished_at,
           (SELECT count(*) FROM candidates) > p_limit AS has_more
      FROM candidates candidate
     ORDER BY candidate.finished_at, candidate.task_id
     LIMIT p_limit
  LOOP
    ordinal := ordinal + 1;
    IF p_dry_run THEN
      status := 'eligible';
      source_task_id := v_candidate.task_id;
      target_task_id := NULL;
      source_state := 'failed';
      target_state := NULL;
      requested_at := NULL;
      source_finished_at_cursor := to_char(
        v_candidate.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      );
      has_more := v_candidate.has_more;
      RETURN NEXT;
    ELSE
      RETURN QUERY
      SELECT ordinal, result.status, result.source_task_id, result.target_task_id,
             result.source_state, result.target_state, result.requested_at,
             to_char(
               v_candidate.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ),
             v_candidate.has_more
        FROM workhorse.redrive_v1(
          v_candidate.task_id, p_requested_by, p_reason, p_request_id
        ) result;
    END IF;
  END LOOP;
END;
$$;

-- Change a queue's tier. The tier decides which tables hold the queue's tasks, so Workhorse
-- changes it only while the queue has no live task in either tier. The exclusive tier lock waits
-- for every enqueue that already read the old tier, and blocks new ones until this commits.
CREATE OR REPLACE FUNCTION workhorse.set_queue_tier_v1(
  p_queue_name text,
  p_tier text,
  p_requested_by text,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  IF p_tier IS NULL OR p_tier NOT IN ('fast', 'full') THEN
    RAISE EXCEPTION 'tier must be fast or full';
  END IF;
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:queue-tier:' || p_queue_name, 0));
  IF p_tier = COALESCE(
    (SELECT control.tier FROM workhorse.queue_control control
      WHERE control.queue_name = p_queue_name),
    'full'
  ) THEN
    RETURN p_tier;
  END IF;
  IF EXISTS (
       SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.queue_name = p_queue_name
     ) OR EXISTS (
       SELECT 1 FROM workhorse.fast_task_runtime runtime WHERE runtime.queue_name = p_queue_name
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1007',
      MESSAGE = format('queue %s has live tasks, so its tier cannot change', p_queue_name),
      DETAIL = jsonb_build_object('queue', p_queue_name, 'feature', 'tier change')::text;
  END IF;
  IF p_tier = 'fast' THEN
    IF EXISTS (
      SELECT 1 FROM workhorse.concurrency_policy policy WHERE policy.queue_name = p_queue_name
    ) THEN
      PERFORM workhorse.reject_fast_feature_v1(p_queue_name, 'concurrency policies');
    END IF;
    IF EXISTS (
      SELECT 1 FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = p_queue_name
    ) THEN
      PERFORM workhorse.reject_fast_feature_v1(p_queue_name, 'rate-limit policies');
    END IF;
  END IF;
  INSERT INTO workhorse.queue_control(queue_name, tier, updated_by, reason, updated_at)
  VALUES (p_queue_name, p_tier, p_requested_by, p_reason, clock_timestamp())
  ON CONFLICT (queue_name) DO UPDATE SET
    tier = EXCLUDED.tier,
    updated_by = EXCLUDED.updated_by,
    reason = EXCLUDED.reason,
    updated_at = EXCLUDED.updated_at;
  RETURN p_tier;
END;
$$;

-- Choose which optional history a fast-tier queue records. A null argument keeps that setting.
-- The change applies to claims and completions that start after it commits.
CREATE OR REPLACE FUNCTION workhorse.set_queue_history_v1(
  p_queue_name text,
  p_record_attempts boolean,
  p_record_claims boolean
)
RETURNS TABLE (record_attempts boolean, record_claims boolean)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  RETURN QUERY
    INSERT INTO workhorse.queue_control AS control(queue_name, record_attempts, record_claims)
    VALUES (p_queue_name, COALESCE(p_record_attempts, false), COALESCE(p_record_claims, false))
    ON CONFLICT (queue_name) DO UPDATE SET
      record_attempts = COALESCE(p_record_attempts, control.record_attempts),
      record_claims = COALESCE(p_record_claims, control.record_claims),
      updated_at = clock_timestamp()
    RETURNING control.record_attempts, control.record_claims;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.purge_queue_internal_v1(p_queue_name text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_fast_count integer;
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  INSERT INTO workhorse.queue_control(queue_name, paused)
    VALUES (p_queue_name, false)
  ON CONFLICT (queue_name) DO NOTHING;
  -- Lock both runtime and parent identities before taking a fresh statement snapshot for history
  -- deletion. The history insert trigger takes KEY SHARE on task, so it either commits before these
  -- deletes become visible or fails after the parent disappears; it cannot commit an orphan.
  PERFORM 1
    FROM workhorse.task_runtime runtime
    JOIN workhorse.task task ON task.id = runtime.task_id
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
   FOR UPDATE OF runtime, task;

  DELETE FROM workhorse.enqueue_idempotency idempotency
   USING workhorse.task_runtime runtime
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
     AND idempotency.task_id = runtime.task_id;
  DELETE FROM workhorse.task_event event
   USING workhorse.task_runtime runtime
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
     AND event.task_id = runtime.task_id;
  DELETE FROM workhorse.attempt_history attempt
   USING workhorse.task_runtime runtime
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
     AND attempt.task_id = runtime.task_id;
  DELETE FROM workhorse.task task
   USING workhorse.task_runtime runtime
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
     AND task.id = runtime.task_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Fast-tier ready rows carry no events, and deleting the task cascades to the runtime row.
  PERFORM 1
    FROM workhorse.fast_task_runtime fast
    JOIN workhorse.task task ON task.id = fast.task_id
   WHERE fast.queue_name = p_queue_name AND fast.state = 'ready'
   FOR UPDATE OF fast, task;
  DELETE FROM workhorse.enqueue_idempotency idempotency
   USING workhorse.fast_task_runtime fast
   WHERE fast.queue_name = p_queue_name AND fast.state = 'ready'
     AND idempotency.task_id = fast.task_id;
  DELETE FROM workhorse.attempt_history attempt
   USING workhorse.fast_task_runtime fast
   WHERE fast.queue_name = p_queue_name AND fast.state = 'ready'
     AND attempt.task_id = fast.task_id;
  DELETE FROM workhorse.task task
   USING workhorse.fast_task_runtime fast
   WHERE fast.queue_name = p_queue_name AND fast.state = 'ready'
     AND task.id = fast.task_id;
  GET DIAGNOSTICS v_fast_count = ROW_COUNT;
  RETURN v_count + v_fast_count;
END;
$$;

-- Audited operator release. The request identity is recorded only when the call
-- changes the task, and the raw request id never enters retained history. A release also ends a
-- live debounce window: the released definition runs now, and the next same-key request starts a
-- new task.
CREATE OR REPLACE FUNCTION workhorse.run_task_now_v1(
  p_task_id uuid,
  p_requested_by text,
  p_reason text,
  p_request_id text
)
RETURNS TABLE(status text, state text, run_at timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_outcome workhorse.task_outcome%ROWTYPE;
  v_fast_runtime workhorse.fast_task_runtime%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_request_id_hash bytea;
  v_request_id_length integer;
  v_request_id_preview text;
BEGIN
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;
  v_request_id_hash := sha256(convert_to(p_request_id, 'UTF8'));
  v_request_id_length := char_length(p_request_id);
  v_request_id_preview := CASE
    WHEN v_request_id_length <= 4 THEN repeat('•', v_request_id_length)
    WHEN v_request_id_length <= 8 THEN left(p_request_id, 2) || '…' || right(p_request_id, 2)
    ELSE left(p_request_id, 8) || '…' || right(p_request_id, 4)
  END;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_runtime.state IN ('ready', 'active') THEN
      RETURN QUERY VALUES ('already_ready'::text, v_runtime.state, v_runtime.run_at);
      RETURN;
    END IF;
    IF v_runtime.wait_name IS NOT NULL OR v_runtime.attempt_started_at IS NOT NULL THEN
      RETURN QUERY VALUES ('waiting'::text, v_runtime.state, v_runtime.run_at);
      RETURN;
    END IF;

    UPDATE workhorse.task_runtime runtime
       SET state = 'ready', run_at = v_now, ready_at = v_now,
           sequence = nextval('workhorse.ready_sequence_seq'), updated_at = v_now
     WHERE runtime.task_id = p_task_id AND runtime.state = 'scheduled'
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'locked scheduled task % changed state unexpectedly', p_task_id;
    END IF;
    DELETE FROM workhorse.enqueue_idempotency identity
     WHERE identity.task_id = p_task_id AND identity.coalescing_mode = 'debounce';

    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id,
        v_runtime.current_attempt,
        'promoted',
        jsonb_build_object(
          'reason', 'manual',
          'requested_by', p_requested_by,
          'request_reason', p_reason,
          'request_id_preview', v_request_id_preview,
          'request_id_digest', left(encode(v_request_id_hash, 'hex'), 12),
          'request_id_length', v_request_id_length
        )
      );
    PERFORM pg_notify('workhorse_tasks', v_runtime.queue_name);
    RETURN QUERY VALUES ('released'::text, v_runtime.state, v_runtime.run_at);
    RETURN;
  END IF;

  -- A delayed fast-tier task is ready with a future run_at, so running it now moves run_at to now.
  SELECT * INTO v_fast_runtime
    FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_fast_runtime.state = 'active' OR v_fast_runtime.run_at <= v_now THEN
      RETURN QUERY VALUES ('already_ready'::text, v_fast_runtime.state, v_fast_runtime.run_at);
      RETURN;
    END IF;
    UPDATE workhorse.fast_task_runtime runtime
       SET run_at = v_now, sequence = nextval('workhorse.ready_sequence_seq')
     WHERE runtime.task_id = p_task_id;
    PERFORM pg_notify('workhorse_tasks', v_fast_runtime.queue_name);
    RETURN QUERY VALUES ('released'::text, 'ready'::text, v_now);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_outcome outcome WHERE outcome.task_id = p_task_id) THEN
    RETURN QUERY SELECT 'not_scheduled'::text, outcome.state, NULL::timestamptz
      FROM workhorse.fast_task_outcome outcome WHERE outcome.task_id = p_task_id;
    RETURN;
  END IF;

  SELECT * INTO v_outcome
    FROM workhorse.task_outcome outcome
   WHERE outcome.task_id = p_task_id;
  IF FOUND THEN
    RETURN QUERY VALUES ('not_scheduled'::text, v_outcome.state, v_outcome.run_at);
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM workhorse.task task WHERE task.id = p_task_id) THEN
    RETURN QUERY VALUES ('not_scheduled'::text, NULL::text, NULL::timestamptz);
  ELSE
    RETURN QUERY VALUES ('not_found'::text, NULL::text, NULL::timestamptz);
  END IF;
END;
$$;

-- Fast-tier transitions (ADR 0077). A fast-tier task lives in one fast_task_runtime row until it
-- closes, and then in one fast_task_outcome row. These helpers own every write to those two
-- tables. The public functions below them branch here when the task or queue is fast-tier, so a
-- client calls the same function for both tiers.

-- Claim up to p_limit ready rows of one fast-tier queue. The caller has already validated the
-- arguments and checked that the queue is not paused. The claimed event is optional per queue, and
-- the claim picks one of two statements rather than filtering a writable CTE, so a queue that
-- records no claims pays for no task_event write.
CREATE OR REPLACE FUNCTION workhorse.fast_claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_limit integer,
  p_lease_ms integer,
  p_record_claims boolean
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
#variable_conflict use_column
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT p_record_claims THEN
    RETURN QUERY
    WITH claimed AS (
      UPDATE workhorse.fast_task_runtime runtime
         SET state = 'active', fence_token = nextval('workhorse.fence_token_seq'),
             worker_id = p_worker_id, claimed_at = v_now,
             expires_at = v_now + p_lease_ms * interval '1 millisecond',
             attempt_timeout_at = v_now + runtime.execution_timeout_ms * interval '1 millisecond'
       WHERE runtime.task_id = ANY (ARRAY(
               SELECT candidate.task_id FROM workhorse.fast_task_runtime candidate
                WHERE candidate.state = 'ready' AND candidate.queue_name = p_queue_name
                  AND candidate.run_at <= v_now
                  AND (candidate.deadline_at IS NULL OR candidate.deadline_at > v_now)
                ORDER BY candidate.priority DESC, candidate.run_at, candidate.sequence
                LIMIT p_limit
                FOR UPDATE SKIP LOCKED
             ))
         AND runtime.state = 'ready'
      RETURNING runtime.*
    )
    SELECT claimed.task_id, claimed.task_type, claimed.priority, claimed.payload,
           claimed.contract_version, claimed.result_max_bytes, claimed.redact,
           claimed.trace_context, claimed.attempt, claimed.max_attempts, claimed.retry_policy,
           claimed.deadline_at, claimed.execution_timeout_ms, claimed.attempt_timeout_at,
           claimed.fence_token, claimed.expires_at
      FROM claimed
     ORDER BY claimed.priority DESC, claimed.run_at, claimed.sequence;
  ELSE
    RETURN QUERY
    WITH claimed AS (
      UPDATE workhorse.fast_task_runtime runtime
         SET state = 'active', fence_token = nextval('workhorse.fence_token_seq'),
             worker_id = p_worker_id, claimed_at = v_now,
             expires_at = v_now + p_lease_ms * interval '1 millisecond',
             attempt_timeout_at = v_now + runtime.execution_timeout_ms * interval '1 millisecond'
       WHERE runtime.task_id = ANY (ARRAY(
               SELECT candidate.task_id FROM workhorse.fast_task_runtime candidate
                WHERE candidate.state = 'ready' AND candidate.queue_name = p_queue_name
                  AND candidate.run_at <= v_now
                  AND (candidate.deadline_at IS NULL OR candidate.deadline_at > v_now)
                ORDER BY candidate.priority DESC, candidate.run_at, candidate.sequence
                LIMIT p_limit
                FOR UPDATE SKIP LOCKED
             ))
         AND runtime.state = 'ready'
      RETURNING runtime.*
    ), claim_events AS (
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      SELECT claimed.task_id, claimed.attempt, 'claimed',
             jsonb_build_object(
               'worker_id', p_worker_id, 'fence_token', claimed.fence_token::text,
               'expires_at', claimed.expires_at
             )
        FROM claimed
    )
    SELECT claimed.task_id, claimed.task_type, claimed.priority, claimed.payload,
           claimed.contract_version, claimed.result_max_bytes, claimed.redact,
           claimed.trace_context, claimed.attempt, claimed.max_attempts, claimed.retry_policy,
           claimed.deadline_at, claimed.execution_timeout_ms, claimed.attempt_timeout_at,
           claimed.fence_token, claimed.expires_at
      FROM claimed
     ORDER BY claimed.priority DESC, claimed.run_at, claimed.sequence;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fast_records_attempts_v1(p_queue_name text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT control.record_attempts FROM workhorse.queue_control control
      WHERE control.queue_name = p_queue_name),
    false
  )
$$;

-- Close one attempt of an active fast-tier row and return the row to ready. The closed attempt
-- goes to attempt_history when the queue records attempts, and otherwise into the row's capped
-- errors list. The list keeps the most recent entries and counts the ones it drops, so a reader
-- can tell that the history is incomplete. The caller holds the row lock and has already decided
-- that another attempt remains.
CREATE OR REPLACE FUNCTION workhorse.fast_retry_v1(
  p_runtime workhorse.fast_task_runtime,
  p_outcome text,
  p_error jsonb,
  p_delay_ms bigint,
  p_next_previous_retry_delay_ms bigint
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_entry jsonb;
BEGIN
  IF workhorse.fast_records_attempts_v1(p_runtime.queue_name) THEN
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error
    ) VALUES (
      p_runtime.task_id, p_runtime.attempt, p_runtime.fence_token, p_runtime.worker_id, p_outcome,
      p_runtime.claimed_at, p_runtime.claimed_at, v_now, p_error
    );
  ELSE
    v_entry := jsonb_build_object(
      'attempt', p_runtime.attempt,
      'fence_token', p_runtime.fence_token::text,
      'worker_id', p_runtime.worker_id,
      'claimed_at', p_runtime.claimed_at,
      'finished_at', v_now,
      'outcome', p_outcome,
      'error', p_error
    );
  END IF;
  UPDATE workhorse.fast_task_runtime runtime
     SET state = 'ready', attempt = runtime.attempt + 1,
         worker_id = NULL, claimed_at = NULL, expires_at = NULL, attempt_timeout_at = NULL,
         previous_retry_delay_ms = p_next_previous_retry_delay_ms,
         run_at = v_now + GREATEST(0, p_delay_ms) * interval '1 millisecond',
         sequence = nextval('workhorse.ready_sequence_seq'),
         errors = CASE
           WHEN v_entry IS NULL THEN runtime.errors
           WHEN jsonb_array_length(runtime.errors) >= 10
             THEN (runtime.errors - 0) || jsonb_build_array(v_entry)
           ELSE runtime.errors || jsonb_build_array(v_entry)
         END,
         errors_dropped = runtime.errors_dropped + CASE
           WHEN v_entry IS NOT NULL AND jsonb_array_length(runtime.errors) >= 10 THEN 1
           ELSE 0
         END
   WHERE runtime.task_id = p_runtime.task_id;
  IF p_delay_ms > 0 THEN
    RETURN 'scheduled';
  END IF;
  PERFORM pg_notify('workhorse_tasks', p_runtime.queue_name);
  RETURN 'ready';
END;
$$;

-- Close a fast-tier task: delete its runtime row and write its one outcome row. The outcome names
-- the final claim only when the row was active, because a ready row has no claim of its own. When
-- the queue records attempts, an active row's final attempt also gets its attempt_history row. The
-- caller holds the row lock.
CREATE OR REPLACE FUNCTION workhorse.fast_finish_v1(
  p_runtime workhorse.fast_task_runtime,
  p_state text,
  p_result jsonb,
  p_error jsonb,
  p_closed_as text,
  p_history_outcome text
) RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_active boolean := p_runtime.state = 'active';
BEGIN
  DELETE FROM workhorse.fast_task_runtime runtime WHERE runtime.task_id = p_runtime.task_id;
  INSERT INTO workhorse.fast_task_outcome(
    task_id, queue_name, task_type, state, attempt, result, error,
    fence_token, worker_id, claimed_at, enqueued_at, finished_at, errors, errors_dropped, closed_as
  ) VALUES (
    p_runtime.task_id, p_runtime.queue_name, p_runtime.task_type, p_state, p_runtime.attempt,
    p_result, p_error,
    CASE WHEN v_active THEN p_runtime.fence_token END,
    CASE WHEN v_active THEN p_runtime.worker_id END,
    CASE WHEN v_active THEN p_runtime.claimed_at END,
    p_runtime.enqueued_at, v_now, p_runtime.errors, p_runtime.errors_dropped, p_closed_as
  );
  IF v_active AND workhorse.fast_records_attempts_v1(p_runtime.queue_name) THEN
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error
    ) VALUES (
      p_runtime.task_id, p_runtime.attempt, p_runtime.fence_token, p_runtime.worker_id,
      p_history_outcome, p_runtime.claimed_at, p_runtime.claimed_at, v_now, p_error
    );
  END IF;
  RETURN v_now;
END;
$$;

-- Complete a batch of fast-tier attempts in one statement. Each accepted attempt deletes its
-- runtime row and writes its outcome row. An attempt whose fence, lease, deadline, attempt timeout,
-- or cancellation no longer allows completion is left alone and missing from the result, exactly
-- as complete_v1 returns false for it. The worker checks result sizes before it calls; an oversized
-- result that still arrives fails the whole batch, as it fails complete_v1.
--
-- The DELETE matches on the primary key, the fence, and the owning worker. It has no state
-- predicate: fast_task_runtime_state_shape_check gives a ready row a NULL worker_id, so the
-- worker match already implies an active row. A state predicate let the planner prefer
-- fast_task_runtime_active_due_idx, whose scan grows with every active row of every worker.
-- The generic plan keeps the primary-key plan: a custom plan per call cost more to plan than
-- the statement costs to run. The history insert joins queue_control once instead of calling
-- fast_records_attempts_v1 per completed row.
CREATE OR REPLACE FUNCTION workhorse.fast_complete_many_v1(
  p_worker_id text, p_task_ids uuid[], p_fence_tokens bigint[], p_results jsonb[]
) RETURNS uuid[]
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_accepted uuid[];
BEGIN
  IF EXISTS (
    SELECT 1
      FROM unnest(p_task_ids, p_results) AS input(task_id, result)
      JOIN workhorse.fast_task_runtime runtime ON runtime.task_id = input.task_id
     WHERE octet_length(COALESCE(input.result, 'null'::jsonb)::text) > runtime.result_max_bytes
  ) THEN
    RAISE EXCEPTION 'result exceeds its configured size limit';
  END IF;
  WITH input AS (
    SELECT * FROM unnest(p_task_ids, p_fence_tokens, p_results)
      AS input(task_id, fence_token, result)
  ), done AS (
    DELETE FROM workhorse.fast_task_runtime runtime
     USING input
     WHERE runtime.task_id = input.task_id
       AND runtime.fence_token = input.fence_token AND runtime.worker_id = p_worker_id
       AND runtime.expires_at > v_now
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
       AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
       AND runtime.cancel_requested_at IS NULL
    RETURNING runtime.*, COALESCE(input.result, 'null'::jsonb) AS result
  ), kept AS (
    INSERT INTO workhorse.fast_task_outcome(
      task_id, queue_name, task_type, state, attempt, result,
      fence_token, worker_id, claimed_at, enqueued_at, finished_at, errors, errors_dropped
    )
    SELECT done.task_id, done.queue_name, done.task_type, 'succeeded', done.attempt, done.result,
           done.fence_token, done.worker_id, done.claimed_at, done.enqueued_at, v_now,
           done.errors, done.errors_dropped
      FROM done
    RETURNING fast_task_outcome.task_id
  ), history AS (
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at
    )
    SELECT done.task_id, done.attempt, done.fence_token, done.worker_id, 'succeeded',
           done.claimed_at, done.claimed_at, v_now
      FROM done
      JOIN workhorse.queue_control control
        ON control.queue_name = done.queue_name AND control.record_attempts
  )
  SELECT COALESCE(array_agg(kept.task_id), '{}'::uuid[]) INTO v_accepted FROM kept;
  RETURN v_accepted;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fast_complete_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_result jsonb
) RETURNS boolean
LANGUAGE sql
AS $$
  SELECT cardinality(workhorse.fast_complete_many_v1(
    p_worker_id, ARRAY[p_task_id], ARRAY[p_fence_token], ARRAY[p_result]
  )) = 1
$$;

-- Settle a fast-tier task whose deadline has passed. It mirrors terminalize_deadline_v1: a task
-- with a pending cancellation closes as canceled, and any other task fails with the deadline
-- envelope.
CREATE OR REPLACE FUNCTION workhorse.fast_terminalize_deadline_v1(p_task_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.deadline_at IS NULL OR v_runtime.deadline_at > clock_timestamp() THEN
    RETURN false;
  END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN
    PERFORM workhorse.fast_finish_v1(
      v_runtime, 'canceled', NULL,
      workhorse.cancellation_envelope_v1(
        v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
      ),
      'canceled', 'canceled'
    );
  ELSE
    PERFORM workhorse.fast_finish_v1(
      v_runtime, 'failed', NULL, workhorse.deadline_envelope_v1(v_runtime.deadline_at),
      'deadline_exceeded', 'deadline_exceeded'
    );
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fast_timeout_owned_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
  v_error jsonb;
  v_retry record;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.attempt_timeout_at IS NULL
     OR v_runtime.cancel_requested_at IS NOT NULL
     OR v_runtime.attempt_timeout_at > clock_timestamp() THEN
    RETURN false;
  END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_runtime.attempt_timeout_at
     AND v_runtime.deadline_at <= clock_timestamp() THEN
    RETURN workhorse.fast_terminalize_deadline_v1(p_task_id);
  END IF;
  v_error := workhorse.timeout_envelope_v1(
    v_runtime.execution_timeout_ms, v_runtime.attempt_timeout_at
  );
  IF v_runtime.attempt < v_runtime.max_attempts THEN
    SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
      p_task_id, v_runtime.attempt, v_runtime.retry_policy, v_runtime.previous_retry_delay_ms,
      NULL, 'execution-timeout-immediate'
    );
    PERFORM workhorse.fast_retry_v1(
      v_runtime, 'timeout', v_error, v_retry.delay_ms, v_retry.next_previous_retry_delay_ms
    );
  ELSE
    PERFORM workhorse.fast_finish_v1(v_runtime, 'failed', NULL, v_error, 'timeout', 'timeout');
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fast_expire_owned_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp()
     AND (
       v_runtime.attempt_timeout_at IS NULL
       OR v_runtime.attempt_timeout_at > clock_timestamp()
       OR v_runtime.deadline_at <= v_runtime.attempt_timeout_at
     ) THEN
    IF workhorse.fast_terminalize_deadline_v1(p_task_id) THEN RETURN 'deadline_exceeded'; END IF;
    RETURN 'stale';
  END IF;
  IF v_runtime.attempt_timeout_at IS NOT NULL
     AND v_runtime.attempt_timeout_at <= clock_timestamp() THEN
    IF workhorse.fast_timeout_owned_v1(p_task_id, p_worker_id, p_fence_token) THEN
      RETURN 'timeout_exceeded';
    END IF;
    RETURN 'stale';
  END IF;
  RETURN 'not_due';
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fast_fail_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_error jsonb, p_retry_delay_ms integer
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
  v_error jsonb;
  v_retry record;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp() THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp())
     OR (v_runtime.attempt_timeout_at IS NOT NULL
       AND v_runtime.attempt_timeout_at <= clock_timestamp()) THEN
    RETURN workhorse.fast_expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  v_error := workhorse.redact_error_details_v1(p_error, v_runtime.redact);
  IF v_runtime.attempt < v_runtime.max_attempts THEN
    SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
      p_task_id, v_runtime.attempt, v_runtime.retry_policy, v_runtime.previous_retry_delay_ms,
      p_retry_delay_ms, 'legacy-handler'
    );
    RETURN workhorse.fast_retry_v1(
      v_runtime, 'retry', v_error, v_retry.delay_ms, v_retry.next_previous_retry_delay_ms
    );
  END IF;
  PERFORM workhorse.fast_finish_v1(v_runtime, 'failed', NULL, v_error, NULL, 'failed');
  RETURN 'failed';
END;
$$;

-- Return an owned fast-tier task to ready without consuming its attempt. Unlike the full tier, the
-- fast tier keeps no execution budget across releases, so a released attempt starts its execution
-- timeout afresh when it is claimed again.
CREATE OR REPLACE FUNCTION workhorse.fast_release_owned_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp() THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp())
     OR (v_runtime.attempt_timeout_at IS NOT NULL
       AND v_runtime.attempt_timeout_at <= clock_timestamp()) THEN
    RETURN workhorse.fast_expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  UPDATE workhorse.fast_task_runtime runtime
     SET state = 'ready', worker_id = NULL, claimed_at = NULL, expires_at = NULL,
         attempt_timeout_at = NULL, run_at = clock_timestamp(),
         sequence = nextval('workhorse.ready_sequence_seq')
   WHERE runtime.task_id = p_task_id;
  PERFORM pg_notify('workhorse_tasks', v_runtime.queue_name);
  RETURN 'released';
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fast_heartbeat_many_v1(
  p_worker_id text, p_task_ids uuid[], p_fence_tokens bigint[], p_lease_ms integer[]
) RETURNS TABLE (ordinal bigint, task_id uuid, status text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  RETURN QUERY
  WITH leases AS MATERIALIZED (
    SELECT input.ordinal, input.task_id, input.fence_token, input.lease_ms
      FROM unnest(p_task_ids, p_fence_tokens, p_lease_ms)
        WITH ORDINALITY AS input(task_id, fence_token, lease_ms, ordinal)
  ), heartbeated AS (
    UPDATE workhorse.fast_task_runtime runtime
       SET expires_at = CASE
             WHEN runtime.cancel_requested_at IS NULL
               AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
               AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
               AND runtime.expires_at > v_now
             THEN v_now + lease.lease_ms * interval '1 millisecond'
             ELSE runtime.expires_at END
      FROM leases lease
     WHERE runtime.task_id = lease.task_id AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id AND runtime.fence_token = lease.fence_token
    RETURNING lease.ordinal, runtime.task_id,
      CASE
        WHEN runtime.cancel_requested_at IS NOT NULL THEN 'cancel_requested'
        WHEN runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= v_now THEN 'deadline_exceeded'
        WHEN runtime.attempt_timeout_at IS NOT NULL AND runtime.attempt_timeout_at <= v_now THEN 'timeout_exceeded'
        WHEN runtime.expires_at <= v_now THEN 'stale'
        ELSE 'accepted'
      END AS status
  )
  SELECT lease.ordinal, lease.task_id, COALESCE(heartbeated.status, 'stale')
    FROM leases lease
    LEFT JOIN heartbeated USING (ordinal, task_id)
   ORDER BY lease.ordinal;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fast_acknowledge_cancel_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
     AND runtime.expires_at > clock_timestamp() AND runtime.cancel_requested_at IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM workhorse.fast_finish_v1(
    v_runtime, 'canceled', NULL,
    workhorse.cancellation_envelope_v1(
      v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
    ),
    'canceled', 'canceled'
  );
  RETURN true;
END;
$$;

-- Cancel a live fast-tier task. The caller has validated the request and found the row. An active
-- task records the request once and waits for its worker or for lease recovery; a ready task
-- closes at once.
CREATE OR REPLACE FUNCTION workhorse.fast_cancel_v1(
  p_task_id uuid, p_requested_by text, p_reason text
) RETURNS TABLE (
  status text, state text, current_attempt integer, requested_at timestamptz,
  requested_by text, reason text, finished_at timestamptz
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_finished_at timestamptz;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_runtime.state = 'active' THEN
    IF v_runtime.cancel_requested_at IS NULL THEN
      UPDATE workhorse.fast_task_runtime runtime
         SET cancel_requested_at = v_now, cancel_requested_by = p_requested_by,
             cancel_reason = p_reason
       WHERE runtime.task_id = p_task_id
      RETURNING * INTO v_runtime;
    END IF;
    RETURN QUERY VALUES (
      'cancel_requested'::text, 'active'::text, v_runtime.attempt, v_runtime.cancel_requested_at,
      v_runtime.cancel_requested_by, v_runtime.cancel_reason, NULL::timestamptz
    );
    RETURN;
  END IF;
  v_finished_at := workhorse.fast_finish_v1(
    v_runtime, 'canceled', NULL,
    workhorse.cancellation_envelope_v1(v_now, p_requested_by, p_reason), 'canceled', 'canceled'
  );
  RETURN QUERY VALUES (
    'canceled'::text, 'canceled'::text, v_runtime.attempt, v_now, p_requested_by, p_reason,
    v_finished_at
  );
END;
$$;

-- Recover fast-tier rows that crossed a boundary: a ready row past its deadline, or an active row
-- past its deadline, attempt timeout, or lease. One index range scan finds the active rows, because
-- the index key is the earliest of the three boundaries. An active row with a pending cancellation
-- waits for its lease to lapse, unless its deadline passed first, as it does on the full tier.
CREATE OR REPLACE FUNCTION workhorse.fast_recover_expired_v1(
  p_limit integer, p_retry_delay_ms integer, p_now timestamptz
) RETURNS TABLE (
  recovered integer, expired_leases integer, retried integer, retry_dimensions jsonb,
  queues text[]
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_candidate uuid;
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
  v_retry record;
  v_error jsonb := jsonb_build_object('name', 'LeaseExpired', 'message', 'worker lease expired');
BEGIN
  recovered := 0;
  expired_leases := 0;
  retried := 0;
  retry_dimensions := '[]'::jsonb;
  queues := '{}'::text[];
  IF p_limit <= 0 THEN
    RETURN NEXT;
    RETURN;
  END IF;
  FOR v_candidate IN
    SELECT due.task_id FROM (
      SELECT runtime.task_id, runtime.deadline_at AS due_at
        FROM workhorse.fast_task_runtime runtime
       WHERE runtime.state = 'ready' AND runtime.deadline_at IS NOT NULL
         AND runtime.deadline_at <= p_now
      UNION ALL
      SELECT runtime.task_id, least(runtime.expires_at, runtime.attempt_timeout_at, runtime.deadline_at)
        FROM workhorse.fast_task_runtime runtime
       WHERE runtime.state = 'active'
         AND least(runtime.expires_at, runtime.attempt_timeout_at, runtime.deadline_at) <= p_now
         AND (
           runtime.cancel_requested_at IS NULL
           OR runtime.expires_at <= p_now
           OR runtime.deadline_at <= p_now
         )
    ) due
     ORDER BY due.due_at, due.task_id
     LIMIT p_limit
  LOOP
    -- The scan read an unlocked snapshot. Re-read the row under its lock so that a heartbeat,
    -- completion, or concurrent recovery that won the race is respected.
    SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
     WHERE runtime.task_id = v_candidate
     FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= p_now
       AND (
         v_runtime.state = 'ready'
         OR v_runtime.attempt_timeout_at IS NULL
         OR v_runtime.attempt_timeout_at > p_now
         OR v_runtime.deadline_at <= v_runtime.attempt_timeout_at
       ) THEN
      CONTINUE WHEN NOT workhorse.fast_terminalize_deadline_v1(v_runtime.task_id);
    ELSIF v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= p_now
       AND v_runtime.cancel_requested_at IS NULL THEN
      CONTINUE WHEN NOT workhorse.fast_timeout_owned_v1(
        v_runtime.task_id, v_runtime.worker_id, v_runtime.fence_token
      );
      IF v_runtime.attempt < v_runtime.max_attempts THEN
        retried := retried + 1;
        retry_dimensions := retry_dimensions || jsonb_build_array(jsonb_build_object(
          'queue', v_runtime.queue_name, 'type', v_runtime.task_type
        ));
      END IF;
    ELSIF v_runtime.expires_at <= p_now THEN
      IF v_runtime.cancel_requested_at IS NOT NULL THEN
        PERFORM workhorse.fast_finish_v1(
          v_runtime, 'canceled', NULL,
          workhorse.cancellation_envelope_v1(
            v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
          ),
          'canceled', 'canceled'
        );
      ELSIF v_runtime.attempt < v_runtime.max_attempts THEN
        SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
          v_runtime.task_id, v_runtime.attempt, v_runtime.retry_policy,
          v_runtime.previous_retry_delay_ms, p_retry_delay_ms, 'lease-recovery-immediate'
        );
        PERFORM workhorse.fast_retry_v1(
          v_runtime, 'lease_expired', v_error, v_retry.delay_ms,
          v_retry.next_previous_retry_delay_ms
        );
        retried := retried + 1;
        retry_dimensions := retry_dimensions || jsonb_build_array(jsonb_build_object(
          'queue', v_runtime.queue_name, 'type', v_runtime.task_type
        ));
      ELSE
        PERFORM workhorse.fast_finish_v1(
          v_runtime, 'failed', NULL, v_error, 'lease_expired', 'lease_expired'
        );
      END IF;
      expired_leases := expired_leases + 1;
    ELSE
      CONTINUE;
    END IF;
    recovered := recovered + 1;
    queues := array_append(queues, v_runtime.queue_name);
  END LOOP;
  RETURN NEXT;
END;
$$;

-- The fast tier's fused completion (ADR 0077). A worker completes the attempts it finished and
-- claims replacements for them in one round trip. The first row carries the accepted task ids; the
-- claimed tasks follow in claim order, and a call that claims nothing returns one row whose claim
-- columns are null. The queue must be fast-tier. A paused queue completes the batch and claims
-- nothing.
CREATE OR REPLACE FUNCTION workhorse.complete_many_and_claim_v1(
  p_worker_id text,
  p_task_ids uuid[],
  p_fence_tokens bigint[],
  p_results jsonb[],
  p_queue_name text,
  p_limit integer,
  p_lease_ms integer DEFAULT 30000
) RETURNS TABLE (
  accepted uuid[],
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_accepted uuid[];
  v_control workhorse.queue_control%ROWTYPE;
  v_first boolean := true;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 0 and 100';
  END IF;
  IF p_task_ids IS NULL OR p_fence_tokens IS NULL OR p_results IS NULL
     OR cardinality(p_task_ids) > 100
     OR cardinality(p_task_ids) <> cardinality(p_fence_tokens)
     OR cardinality(p_task_ids) <> cardinality(p_results) THEN
    RAISE EXCEPTION 'completions must contain at most 100 entries with one fence token and result each';
  END IF;
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF NOT FOUND OR v_control.tier <> 'fast' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1007',
      MESSAGE = format('queue %s is not a fast-tier queue', p_queue_name),
      DETAIL = jsonb_build_object('queue', p_queue_name, 'feature', 'batched completion')::text;
  END IF;
  v_accepted := workhorse.fast_complete_many_v1(p_worker_id, p_task_ids, p_fence_tokens, p_results);
  IF p_limit > 0 AND NOT v_control.paused THEN
    -- One set-returning query streams the claims. A per-row RETURN NEXT loop costs measurably more
    -- per claim on the hot path.
    RETURN QUERY
      SELECT CASE WHEN claim.ordinality = 1 THEN v_accepted END,
             claim.task_id, claim.task_type, claim.priority, claim.payload, claim.contract_version,
             claim.result_max_bytes, claim.redact_error_details, claim.trace_context, claim.attempt,
             claim.max_attempts, claim.retry_policy, claim.deadline_at, claim.execution_timeout_ms,
             claim.attempt_timeout_at, claim.fence_token, claim.lease_expires_at
        FROM workhorse.fast_claim_v1(
          p_queue_name, p_worker_id, p_limit, p_lease_ms, v_control.record_claims
        ) WITH ORDINALITY AS claim
       ORDER BY claim.ordinality;
    v_first := NOT FOUND;
  END IF;
  IF v_first THEN
    accepted := v_accepted;
    RETURN NEXT;
  END IF;
END;
$$;

-- Policy-aware claim. Governed queues serialize the short admission transaction through policy
-- rows, count only unexpired active leases, refill durable rate tokens from PostgreSQL time, and
-- inspect at most the highest-priority 100 ready rows. Concurrency remains a dispatch budget rather than a
-- guarantee that expired handler code has stopped executing. Budget capacity is counted across
-- queues (ADR 0067), so a claim locks every budget named in its priority window, one advisory lock
-- per budget name, before it reads the clock. It takes those locks in name order so two claims
-- that share budgets cannot deadlock. A claim that already holds budget locks from an earlier claim
-- in the same transaction passes p_wait_for_budgets = false: it takes only the locks it can get
-- without waiting and leaves rows naming any other budget for a later claim.
-- A claim that can pass over a row reads its window without locking and locks only the candidate it
-- takes (SM-801), so a claim that admits nothing writes no row lock. The admission decision cannot
-- go stale between that read and the lock: max_active_per_key holds the concurrency policy row,
-- a per-key rate cap holds the rate-limit policy row, and a budget holds its advisory lock, each
-- until this transaction ends. A queue with no policy, no per-key rate cap, and no budget lock
-- keeps the one-row fast path, which locks the first ready row it can take. That row holds the line
-- when it names a budget this claim never locked, because reading past it has no bound.
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
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_rate_status record;
  v_active integer;
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
  -- and pruning against deployment synchronization for this queue.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || p_queue_name, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:rate-limit-policy:' || p_queue_name, 0)
  );
  SELECT policy.* INTO v_policy
    FROM workhorse.concurrency_policy policy
   WHERE policy.queue_name = p_queue_name
   FOR UPDATE;
  SELECT policy.* INTO v_rate_policy
    FROM workhorse.rate_limit_policy policy
   WHERE policy.queue_name = p_queue_name
   FOR UPDATE;
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
  IF v_policy.queue_name IS NOT NULL THEN
    SELECT count(*)::integer INTO v_active
      FROM workhorse.task_runtime active
     WHERE active.state = 'active'
       AND active.queue_name = p_queue_name
       AND active.expires_at > v_now;
    IF v_active >= v_policy.max_active THEN RETURN; END IF;
  END IF;

  SELECT * INTO STRICT v_rate_status FROM workhorse.rate_limit_bucket_v1(
    p_queue_name, 'queue', '', v_rate_policy.rate_limit, v_rate_policy.rate_interval_ms,
    v_rate_policy.rate_burst, v_now, false
  );
  IF NOT v_rate_status.allowed THEN RETURN; END IF;

  v_fence := nextval('workhorse.fence_token_seq');
  IF v_policy.queue_name IS NULL AND v_rate_policy.per_key_limit IS NULL
     AND cardinality(v_budget_names) = 0 THEN
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
     FOR UPDATE OF runtime SKIP LOCKED
     LIMIT 1;
    IF v_candidate_budget IS NOT NULL THEN RETURN; END IF;
  ELSE
    -- An admission rule can pass over a row, so the window reads without locking and only the
    -- chosen candidate is locked. A claim that admits nothing leaves every sampled row unlocked.
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
        CROSS JOIN LATERAL workhorse.rate_limit_bucket_v1(
          p_queue_name, 'key', ready.concurrency_key, v_rate_policy.per_key_limit,
          v_rate_policy.per_key_interval_ms, v_rate_policy.per_key_burst, v_now, false
        ) keyed_rate
       WHERE (
         v_policy.queue_name IS NULL
         OR v_policy.max_active_per_key IS NULL
         OR ready.concurrency_key IS NULL
         OR (
            SELECT count(*)
              FROM workhorse.task_runtime active
             WHERE active.state = 'active'
               AND active.queue_name = p_queue_name
               AND active.concurrency_key = ready.concurrency_key
               AND active.expires_at > v_now
          ) < v_policy.max_active_per_key
       ) AND keyed_rate.allowed
         AND CASE
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
     FOR UPDATE OF runtime SKIP LOCKED
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

  PERFORM * FROM workhorse.rate_limit_bucket_v1(
    p_queue_name, 'queue', '', v_rate_policy.rate_limit, v_rate_policy.rate_interval_ms,
    v_rate_policy.rate_burst, v_now, true
  );
  PERFORM * FROM workhorse.rate_limit_bucket_v1(
    p_queue_name, 'key', v_runtime.concurrency_key, v_rate_policy.per_key_limit,
    v_rate_policy.per_key_interval_ms, v_rate_policy.per_key_burst, v_now, true
  );
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

-- Claim several tasks through one client round trip while retaining claim_one_v1 as the single
-- owner of ordering, policy admission, rate tokens, fencing, and claim event semantics. Only the
-- first claim may wait for a budget lock; later claims already hold budget locks, so waiting on
-- another budget could deadlock against a batch that holds them in a different order.
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
AS $$
DECLARE
  v_claimed integer;
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
  FOR v_index IN 1..p_limit LOOP
    RETURN QUERY SELECT * FROM workhorse.claim_one_v1(
      p_queue_name, p_worker_id, p_lease_ms, v_index = 1
    );
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    EXIT WHEN v_claimed = 0;
  END LOOP;
END;
$$;

-- Record process-local batch evidence against the immutable claims that entered the coordinator.
CREATE OR REPLACE FUNCTION workhorse.record_batch_event_v1(
  p_event_type text,
  p_batch_id uuid,
  p_task_ids uuid[],
  p_attempts integer[],
  p_fence_tokens bigint[],
  p_worker_id text
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_size integer := cardinality(p_task_ids);
  v_members jsonb;
  v_existing integer;
  v_matching integer;
  v_requested integer;
  v_authorized integer;
BEGIN
  IF p_event_type NOT IN ('batch_dispatched', 'batch_failed') THEN
    RAISE EXCEPTION 'unsupported batch event type';
  END IF;
  IF p_batch_id IS NULL THEN RAISE EXCEPTION 'batch_id must not be null'; END IF;
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF v_size IS NULL OR v_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 100';
  END IF;
  IF cardinality(p_attempts) <> v_size OR cardinality(p_fence_tokens) <> v_size THEN
    RAISE EXCEPTION 'batch member arrays must have equal lengths';
  END IF;
  IF array_position(p_task_ids, NULL) IS NOT NULL
     OR array_position(p_attempts, NULL) IS NOT NULL
     OR array_position(p_fence_tokens, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'batch member arrays must not contain nulls';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_task_ids) member(task_id)
     GROUP BY member.task_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'batch task ids must be unique';
  END IF;

  SELECT jsonb_agg(
           jsonb_build_object('task_id', member.task_id, 'attempt', member.attempt)
           ORDER BY member.ordinal
         )
    INTO v_members
    FROM unnest(p_task_ids, p_attempts) WITH ORDINALITY
      AS member(task_id, attempt, ordinal);

  PERFORM pg_advisory_xact_lock(hashtextextended(p_batch_id::text, 0));
  SELECT count(*)::integer
    INTO v_existing
    FROM workhorse.task_event event
   WHERE event.event_type IN ('batch_dispatched', 'batch_failed')
     AND event.details->>'batch_id' = p_batch_id::text;
  IF v_existing > 0 THEN
    SELECT count(*)::integer
      INTO v_matching
      FROM unnest(p_task_ids, p_attempts, p_fence_tokens) AS member(task_id, attempt, fence_token)
      JOIN workhorse.task_event event
        ON event.task_id = member.task_id
       AND event.attempt = member.attempt
       AND event.event_type IN ('batch_dispatched', 'batch_failed')
       AND event.details = jsonb_build_object(
         'batch_id', p_batch_id,
         'size', v_size,
         'members', v_members,
         'worker_id', p_worker_id,
         'fence_token', member.fence_token::text
       );
    IF v_matching <> v_existing THEN
      RAISE EXCEPTION 'batch id already records different evidence';
    END IF;
    SELECT count(*)::integer
      INTO v_requested
      FROM workhorse.task_event event
     WHERE event.event_type = p_event_type
       AND event.details->>'batch_id' = p_batch_id::text;
    IF v_requested = v_size THEN RETURN v_size; END IF;
    IF v_requested <> 0 THEN
      RAISE EXCEPTION 'batch event records an incomplete member set';
    END IF;
  END IF;

  SELECT count(*)::integer
    INTO v_authorized
    FROM unnest(p_task_ids, p_attempts, p_fence_tokens) AS member(task_id, attempt, fence_token)
   WHERE EXISTS (
     SELECT 1
       FROM workhorse.task_event claim
      WHERE claim.task_id = member.task_id
        AND claim.attempt = member.attempt
        AND claim.event_type = 'claimed'
        AND claim.details->>'worker_id' = p_worker_id
        AND claim.details->>'fence_token' = member.fence_token::text
   ) OR EXISTS (
     -- A fast-tier queue may record no claims, so its live lease is the evidence instead.
     SELECT 1
       FROM workhorse.fast_task_runtime fast
      WHERE fast.task_id = member.task_id AND fast.state = 'active'
        AND fast.attempt = member.attempt AND fast.worker_id = p_worker_id
        AND fast.fence_token = member.fence_token
   );
  IF v_authorized <> v_size THEN
    RAISE EXCEPTION 'batch members must match retained claims';
  END IF;

  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    SELECT member.task_id, member.attempt, p_event_type,
           jsonb_build_object(
             'batch_id', p_batch_id,
             'size', v_size,
             'members', v_members,
             'worker_id', p_worker_id,
             'fence_token', member.fence_token::text
           )
      FROM unnest(p_task_ids, p_attempts, p_fence_tokens) WITH ORDINALITY
        AS member(task_id, attempt, fence_token, ordinal)
     ORDER BY member.ordinal;
  RETURN v_size;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.timeout_owned_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_task workhorse.task%ROWTYPE;
  v_error jsonb;
  v_retry record;
  v_state text;
  v_run_at timestamptz;
BEGIN
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN workhorse.fast_timeout_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  SELECT * INTO v_runtime FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.attempt_timeout_at IS NULL
     OR v_runtime.attempt_timeout_at > clock_timestamp() THEN RETURN false; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO STRICT v_task FROM workhorse.task task WHERE task.id = p_task_id;
  IF v_task.deadline_at IS NOT NULL
     AND v_task.deadline_at <= v_runtime.attempt_timeout_at
     AND v_task.deadline_at <= clock_timestamp() THEN
    RETURN workhorse.terminalize_deadline_v1(p_task_id);
  END IF;
  v_error := workhorse.timeout_envelope_v1(
    v_task.execution_timeout_ms, v_runtime.attempt_timeout_at
  );
  IF v_runtime.current_attempt < v_task.max_attempts THEN
    SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
      p_task_id, v_runtime.current_attempt, v_task.retry_policy,
      v_runtime.previous_retry_delay_ms, NULL, 'execution-timeout-immediate'
    );
    v_run_at := clock_timestamp() +
      make_interval(secs => v_retry.delay_ms::double precision / 1000.0);
    v_state := CASE WHEN v_retry.delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
    UPDATE workhorse.task_runtime runtime SET
      state = v_state,
      current_attempt = runtime.current_attempt + 1,
      fence_token = 0,
      run_at = v_run_at,
      ready_at = CASE WHEN v_state = 'ready' THEN clock_timestamp() END,
      sequence = CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
      worker_id = NULL,
      acquired_at = NULL,
      heartbeat_at = NULL,
      expires_at = NULL,
      wait_name = NULL,
      attempt_started_at = NULL,
      execution_used_ms = 0,
      attempt_timeout_at = NULL,
      previous_retry_delay_ms = v_retry.next_previous_retry_delay_ms,
      error = v_error,
      updated_at = clock_timestamp()
     WHERE runtime.task_id = p_task_id;
    IF v_state = 'ready' THEN PERFORM pg_notify('workhorse_tasks', v_task.queue_name); END IF;
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_runtime.current_attempt, 'execution_timed_out',
        jsonb_build_object(
          'fence_token', p_fence_token::text,
          'timeout_at', v_runtime.attempt_timeout_at,
          'execution_timeout_ms', v_task.execution_timeout_ms,
          'next_state', v_state,
          'next_attempt', v_runtime.current_attempt + 1,
          'retry_delay_ms', v_retry.delay_ms,
          'retry_delay_source', v_retry.source
        )
      );
  ELSE
    DELETE FROM workhorse.task_runtime runtime WHERE runtime.task_id = p_task_id;
    INSERT INTO workhorse.task_outcome(
      task_id, state, current_attempt, fence_token, run_at, error, history_through_at
    ) VALUES (
      p_task_id, 'failed', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, v_error,
      clock_timestamp()
    );
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_runtime.current_attempt, 'execution_timed_out',
        jsonb_build_object(
          'fence_token', p_fence_token::text,
          'timeout_at', v_runtime.attempt_timeout_at,
          'execution_timeout_ms', v_task.execution_timeout_ms,
          'next_state', 'failed'
        )
      );
  END IF;
  INSERT INTO workhorse.attempt_history(
    task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
  ) VALUES (
    p_task_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'timeout',
    v_runtime.attempt_started_at, v_runtime.acquired_at, v_error
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.expire_owned_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN workhorse.fast_expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  SELECT * INTO v_runtime FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp()
     AND (
       v_runtime.attempt_timeout_at IS NULL
       OR v_runtime.attempt_timeout_at > clock_timestamp()
       OR v_runtime.deadline_at <= v_runtime.attempt_timeout_at
     ) THEN
    IF workhorse.terminalize_deadline_v1(p_task_id) THEN RETURN 'deadline_exceeded'; END IF;
    RETURN 'stale';
  END IF;
  IF v_runtime.attempt_timeout_at IS NOT NULL
     AND v_runtime.attempt_timeout_at <= clock_timestamp() THEN
    IF workhorse.timeout_owned_v1(p_task_id, p_worker_id, p_fence_token) THEN
      RETURN 'timeout_exceeded';
    END IF;
    RETURN 'stale';
  END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp() THEN
    IF workhorse.terminalize_deadline_v1(p_task_id) THEN RETURN 'deadline_exceeded'; END IF;
    RETURN 'stale';
  END IF;
  RETURN 'not_due';
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.heartbeat_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_lease_ms integer DEFAULT 30000
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_status text;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN (SELECT beat.status FROM workhorse.fast_heartbeat_many_v1(
      p_worker_id, ARRAY[p_task_id], ARRAY[p_fence_token], ARRAY[p_lease_ms]
    ) beat);
  END IF;
  UPDATE workhorse.task_runtime r
     SET heartbeat_at = CASE
           WHEN r.cancel_requested_at IS NULL
             AND (r.deadline_at IS NULL OR r.deadline_at > v_now)
             AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now)
             AND r.expires_at > v_now THEN v_now
           ELSE r.heartbeat_at END,
         expires_at = CASE
           WHEN r.cancel_requested_at IS NULL
             AND (r.deadline_at IS NULL OR r.deadline_at > v_now)
             AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now)
             AND r.expires_at > v_now
           THEN v_now + make_interval(secs => p_lease_ms::double precision / 1000.0)
           ELSE r.expires_at END,
         updated_at = CASE
           WHEN r.cancel_requested_at IS NULL
             AND (r.deadline_at IS NULL OR r.deadline_at > v_now)
             AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now)
             AND r.expires_at > v_now THEN v_now
           ELSE r.updated_at END
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
  RETURNING CASE
    WHEN r.cancel_requested_at IS NOT NULL THEN 'cancel_requested'
    WHEN r.deadline_at IS NOT NULL AND r.deadline_at <= v_now THEN 'deadline_exceeded'
    WHEN r.attempt_timeout_at IS NOT NULL AND r.attempt_timeout_at <= v_now THEN 'timeout_exceeded'
    WHEN r.expires_at <= v_now THEN 'stale'
    ELSE 'accepted'
  END INTO v_status;
  RETURN COALESCE(v_status, 'stale');
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.heartbeat_many_v1(
  p_worker_id text, p_leases jsonb
) RETURNS TABLE (ordinal bigint, task_id uuid, status text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_fast_count bigint;
  v_total bigint;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_leases IS NULL OR jsonb_typeof(p_leases) <> 'array'
     OR jsonb_array_length(p_leases) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'leases must contain between 1 and 100 entries';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_leases) item
     WHERE item->>'taskId' IS NULL OR item->>'fenceToken' IS NULL OR item->>'leaseMs' IS NULL
       OR (item->>'leaseMs')::integer NOT BETWEEN 100 AND 86400000
  ) THEN
    RAISE EXCEPTION 'each lease requires taskId, fenceToken, and leaseMs between 100 and 86400000';
  END IF;
  -- A batch that names no fast-tier task takes the full-tier path below unchanged. An all-fast
  -- batch takes the fast set-based path. A mixed batch goes one lease at a time.
  SELECT count(*) FILTER (WHERE fast.task_id IS NOT NULL), count(*)
    INTO v_fast_count, v_total
    FROM jsonb_array_elements(p_leases) item
    LEFT JOIN workhorse.fast_task_runtime fast ON fast.task_id = (item->>'taskId')::uuid;
  IF v_fast_count = v_total THEN
    RETURN QUERY SELECT * FROM workhorse.fast_heartbeat_many_v1(
      p_worker_id,
      ARRAY(SELECT (item->>'taskId')::uuid FROM jsonb_array_elements(p_leases) WITH ORDINALITY input(item, n) ORDER BY n),
      ARRAY(SELECT (item->>'fenceToken')::bigint FROM jsonb_array_elements(p_leases) WITH ORDINALITY input(item, n) ORDER BY n),
      ARRAY(SELECT (item->>'leaseMs')::integer FROM jsonb_array_elements(p_leases) WITH ORDINALITY input(item, n) ORDER BY n)
    );
    RETURN;
  ELSIF v_fast_count > 0 THEN
    RETURN QUERY
      SELECT input.n, (input.item->>'taskId')::uuid,
             workhorse.heartbeat_v1(
               (input.item->>'taskId')::uuid, p_worker_id, (input.item->>'fenceToken')::bigint,
               (input.item->>'leaseMs')::integer
             )
        FROM jsonb_array_elements(p_leases) WITH ORDINALITY input(item, n)
       ORDER BY input.n;
    RETURN;
  END IF;
  RETURN QUERY
  WITH leases AS MATERIALIZED (
    SELECT item.ordinality AS ordinal,
           (item.value->>'taskId')::uuid AS task_id,
           (item.value->>'fenceToken')::bigint AS fence_token,
           (item.value->>'leaseMs')::integer AS lease_ms
      FROM jsonb_array_elements(p_leases) WITH ORDINALITY AS item(value, ordinality)
  ), heartbeated AS (
    UPDATE workhorse.task_runtime runtime
       SET heartbeat_at = CASE
             WHEN runtime.cancel_requested_at IS NULL
               AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
               AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
               AND runtime.expires_at > v_now THEN v_now
             ELSE runtime.heartbeat_at END,
           expires_at = CASE
             WHEN runtime.cancel_requested_at IS NULL
               AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
               AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
               AND runtime.expires_at > v_now
             THEN v_now + make_interval(secs => lease.lease_ms::double precision / 1000.0)
             ELSE runtime.expires_at END,
           updated_at = CASE
             WHEN runtime.cancel_requested_at IS NULL
               AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
               AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
               AND runtime.expires_at > v_now THEN v_now
             ELSE runtime.updated_at END
      FROM leases lease
     WHERE runtime.task_id = lease.task_id AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id AND runtime.fence_token = lease.fence_token
    RETURNING lease.ordinal, runtime.task_id,
      CASE
        WHEN runtime.cancel_requested_at IS NOT NULL THEN 'cancel_requested'
        WHEN runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= v_now THEN 'deadline_exceeded'
        WHEN runtime.attempt_timeout_at IS NOT NULL AND runtime.attempt_timeout_at <= v_now THEN 'timeout_exceeded'
        WHEN runtime.expires_at <= v_now THEN 'stale'
        ELSE 'accepted'
      END AS status
  )
  SELECT lease.ordinal, lease.task_id, COALESCE(heartbeated.status, 'stale')
    FROM leases lease
    LEFT JOIN heartbeated USING (ordinal, task_id)
   ORDER BY lease.ordinal;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.acknowledge_cancel_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_envelope jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN workhorse.fast_acknowledge_cancel_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp()
     OR v_runtime.cancel_requested_at IS NULL THEN
    RETURN false;
  END IF;
  v_envelope := workhorse.cancellation_envelope_v1(
    v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
  );
  DELETE FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
     AND runtime.expires_at > clock_timestamp() AND runtime.cancel_requested_at IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO workhorse.task_outcome(
    task_id, state, current_attempt, fence_token, run_at, error, history_through_at
  )
    VALUES (
      p_task_id, 'canceled', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, v_envelope,
      clock_timestamp()
    );
  INSERT INTO workhorse.attempt_history(
    task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
  ) VALUES (
    p_task_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'canceled',
    v_runtime.attempt_started_at, v_runtime.acquired_at, v_envelope
  );
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (
      p_task_id,
      v_runtime.current_attempt,
      'canceled',
      jsonb_build_object(
        'requested_at', v_runtime.cancel_requested_at,
        'requested_by', v_runtime.cancel_requested_by,
        'reason', v_runtime.cancel_reason,
        'fence_token', p_fence_token::text,
        'source', 'acknowledged'
      )
    );
  RETURN true;
END;
$$;

-- Create one child and suspend its exact active parent generation in the same transaction. A
-- replay after the child succeeds returns its retained result and marks the join exactly once.
CREATE OR REPLACE FUNCTION workhorse.create_single_child_v1(
  p_parent_task_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_child_name text,
  p_request jsonb
) RETURNS TABLE (
  status text,
  child_task_id uuid,
  child_type text,
  created_at timestamptz,
  joined_at timestamptz,
  result jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_edge workhorse.task_child%ROWTYPE;
  v_enqueue record;
  v_outcome workhorse.task_outcome%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_child_name IS NULL OR p_child_name = '' OR char_length(p_child_name) > 200 THEN
    RAISE EXCEPTION 'child_name must contain between 1 and 200 characters';
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'child request must be a JSON object';
  END IF;
  IF p_request ?| ARRAY['idempotency', 'debounce', 'throttle']
     OR COALESCE(p_request->'prerequisiteTaskId', 'null'::jsonb) <> 'null'::jsonb
     OR COALESCE(p_request->'dependencies', 'null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION 'child tasks cannot use coalescing or dependency enqueue options';
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_parent_task_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR v_runtime.expires_at <= v_now
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now)
     OR (v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= v_now)
     OR v_runtime.cancel_requested_at IS NOT NULL THEN
    RETURN QUERY VALUES (
      'stale'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb
    );
    RETURN;
  END IF;

  SELECT * INTO v_edge
    FROM workhorse.task_child edge
   WHERE edge.parent_task_id = p_parent_task_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_edge.child_name <> p_child_name THEN
      RETURN QUERY VALUES (
        'limit_exceeded'::text, v_edge.child_task_id,
        (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    IF v_edge.request_fingerprint <> p_request THEN
      RETURN QUERY VALUES (
        'conflict'::text, v_edge.child_task_id,
        (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    SELECT * INTO v_outcome FROM workhorse.task_outcome outcome
     WHERE outcome.task_id = v_edge.child_task_id;
    IF NOT FOUND OR v_outcome.state <> 'succeeded' THEN
      RETURN QUERY VALUES (
        'stale'::text, v_edge.child_task_id,
        (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    IF v_edge.joined_at IS NULL THEN
      UPDATE workhorse.task_child edge SET joined_at = v_now
       WHERE edge.parent_task_id = p_parent_task_id
       RETURNING * INTO v_edge;
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
        VALUES (
          p_parent_task_id, v_runtime.current_attempt, 'child_joined',
          jsonb_build_object(
            'name', p_child_name,
            'child_task_id', v_edge.child_task_id,
            'fence_token', p_fence_token::text
          )
        );
    END IF;
    RETURN QUERY VALUES (
      'completed'::text, v_edge.child_task_id,
      (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
      v_edge.created_at, v_edge.joined_at, v_outcome.result
    );
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = p_parent_task_id) THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb
    );
    RETURN;
  END IF;

  -- A fast-tier task never resolves dependents, so it cannot be joined as a child.
  IF cardinality(workhorse.lock_queue_tiers_v1(ARRAY[p_request->>'queue'])) > 0 THEN
    PERFORM workhorse.reject_fast_feature_v1(p_request->>'queue', 'child tasks');
  END IF;

  BEGIN
    SELECT * INTO v_enqueue FROM workhorse.enqueue_many_v1(jsonb_build_array(p_request));
    IF v_enqueue.outcome <> 'accepted' THEN
      RAISE EXCEPTION 'child enqueue must create one new task';
    END IF;
    INSERT INTO workhorse.task_child(
      parent_task_id, child_task_id, child_name, request_fingerprint, created_at
    ) VALUES (
      p_parent_task_id, v_enqueue.task_id, p_child_name, p_request, v_now
    ) RETURNING * INTO v_edge;
    INSERT INTO workhorse.task_dependency(
      dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation, created_at
    ) VALUES (
      p_parent_task_id, v_enqueue.task_id, 'release', 'fail', 'cancel', v_now
    );

    UPDATE workhorse.task_runtime runtime
       SET state = 'blocked', fence_token = 0, ready_at = NULL, sequence = NULL,
           worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
           wait_name = NULL, attempt_started_at = NULL,
           execution_used_ms = LEAST(
             31536000000,
             runtime.execution_used_ms + GREATEST(
               0, floor(extract(epoch FROM v_now - runtime.acquired_at) * 1000)::bigint
             )
           ),
           attempt_timeout_at = NULL, error = NULL, updated_at = v_now
     WHERE runtime.task_id = p_parent_task_id
       AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id
       AND runtime.fence_token = p_fence_token
       AND runtime.expires_at > clock_timestamp()
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
       AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > clock_timestamp());
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1004',
        MESSAGE = 'child creation lost the parent lease';
    END IF;

    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_parent_task_id, v_runtime.current_attempt, 'child_created',
        jsonb_build_object(
          'name', p_child_name,
          'child_task_id', v_edge.child_task_id,
          'fence_token', p_fence_token::text
        )
      );
    INSERT INTO workhorse.task_event(task_id, event_type, details)
      VALUES (
        v_edge.child_task_id, 'parent_linked',
        jsonb_build_object('parent_task_id', p_parent_task_id, 'name', p_child_name)
      );
    RETURN QUERY VALUES (
      'created'::text, v_edge.child_task_id, p_request->>'type', v_edge.created_at,
      NULL::timestamptz, NULL::jsonb
    );
  EXCEPTION
    WHEN SQLSTATE 'P1004' THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::uuid, NULL::text, NULL::timestamptz,
        NULL::timestamptz, NULL::jsonb
      );
  END;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.create_children_v1(
  p_parent_task_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_children jsonb,
  p_mode text
) RETURNS TABLE (
  status text,
  children jsonb,
  results jsonb,
  result_bytes integer,
  result_limit_bytes integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_item record;
  v_enqueue record;
  v_existing_count integer;
  v_result_limit integer;
  v_children jsonb := '[]'::jsonb;
  v_results jsonb := '{}'::jsonb;
  v_result_bytes integer := 2;
  v_now timestamptz;
  v_had_unjoined boolean;
  v_fast_queue text;
BEGIN
  IF p_mode NOT IN ('settled', 'all_success') THEN
    RAISE EXCEPTION 'child join mode must be settled or all_success';
  END IF;
  IF p_children IS NULL OR jsonb_typeof(p_children) <> 'array' THEN
    RAISE EXCEPTION 'children must be a JSON array';
  END IF;
  IF jsonb_array_length(p_children) > 100 THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::jsonb, NULL::jsonb, NULL::integer, NULL::integer
    );
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) input(item)
     WHERE jsonb_typeof(item) <> 'object'
       OR jsonb_typeof(item->'name') <> 'string'
       OR item->>'name' = '' OR char_length(item->>'name') > 200
       OR jsonb_typeof(item->'request') <> 'object'
  ) THEN
    RAISE EXCEPTION 'each child requires a valid name and request object';
  END IF;
  IF EXISTS (
    SELECT item->>'name' FROM jsonb_array_elements(p_children) input(item)
     GROUP BY item->>'name' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'child names must be unique';
  END IF;

  SELECT runtime.* INTO v_runtime
    FROM workhorse.task_runtime runtime
    JOIN workhorse.task task ON task.id = runtime.task_id
   WHERE runtime.task_id = p_parent_task_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE OF runtime;
  IF FOUND THEN
    SELECT task.result_max_bytes INTO STRICT v_result_limit
      FROM workhorse.task task WHERE task.id = p_parent_task_id;
  END IF;
  v_now := clock_timestamp();
  IF NOT FOUND OR v_runtime.expires_at <= v_now
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now)
     OR (v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= v_now)
     OR v_runtime.cancel_requested_at IS NOT NULL THEN
    RETURN QUERY VALUES (
      'stale'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
    );
    RETURN;
  END IF;

  PERFORM 1 FROM workhorse.task_child edge
   WHERE edge.parent_task_id = p_parent_task_id
   ORDER BY edge.child_name FOR UPDATE;
  SELECT count(*)::integer INTO v_existing_count FROM workhorse.task_child edge
   WHERE edge.parent_task_id = p_parent_task_id;

  IF jsonb_array_length(p_children) = 0 THEN
    IF v_existing_count > 0 THEN
      RETURN QUERY VALUES (
        'conflict'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
    ELSIF 2 > v_result_limit THEN
      RETURN QUERY VALUES (
        'result_too_large'::text, NULL::jsonb, NULL::jsonb, 2, v_result_limit
      );
    ELSE
      RETURN QUERY VALUES ('completed'::text, '[]'::jsonb, '{}'::jsonb, 2, v_result_limit);
    END IF;
    RETURN;
  END IF;

  IF v_existing_count > 0 THEN
    IF v_existing_count <> jsonb_array_length(p_children) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_children) input(item)
      LEFT JOIN workhorse.task_child edge
        ON edge.parent_task_id = p_parent_task_id AND edge.child_name = item->>'name'
      WHERE edge.child_task_id IS NULL OR edge.request_fingerprint <> item->'request'
    ) OR EXISTS (
      SELECT 1 FROM workhorse.task_child edge
       WHERE edge.parent_task_id = p_parent_task_id AND NOT edge.created_as_set
    ) OR EXISTS (
      SELECT 1
        FROM workhorse.task_dependency dependency
        JOIN workhorse.task_child edge
          ON edge.parent_task_id = p_parent_task_id
         AND edge.child_task_id = dependency.prerequisite_task_id
       WHERE dependency.dependent_task_id = p_parent_task_id
         AND (
           dependency.on_success <> 'release'
           OR dependency.on_failure <> CASE WHEN p_mode = 'settled' THEN 'release' ELSE 'fail' END
           OR dependency.on_cancellation <> CASE WHEN p_mode = 'settled' THEN 'release' ELSE 'cancel' END
         )
    ) THEN
      RETURN QUERY VALUES (
        'conflict'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM workhorse.task_child edge
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = edge.child_task_id
       WHERE edge.parent_task_id = p_parent_task_id
         AND (
           outcome.task_id IS NULL
           OR (p_mode = 'all_success' AND outcome.state <> 'succeeded')
         )
    ) THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
      RETURN;
    END IF;

    SELECT jsonb_object_agg(edge.child_name, joined.value),
           jsonb_agg(jsonb_build_object(
             'childTaskId', edge.child_task_id,
             'name', edge.child_name,
             'type', task.task_type,
             'createdAt', edge.created_at,
             'joinedAt', COALESCE(edge.joined_at, v_now),
             CASE WHEN p_mode = 'all_success' THEN 'result' ELSE 'outcome' END,
             joined.value
           ) ORDER BY input.ordinality),
           bool_or(edge.joined_at IS NULL)
      INTO v_results, v_children, v_had_unjoined
      FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
      JOIN workhorse.task_child edge
        ON edge.parent_task_id = p_parent_task_id AND edge.child_name = input.item->>'name'
      JOIN workhorse.task task ON task.id = edge.child_task_id
      JOIN workhorse.task_outcome outcome ON outcome.task_id = edge.child_task_id
      CROSS JOIN LATERAL (
        SELECT CASE WHEN p_mode = 'all_success' THEN outcome.result ELSE
          CASE outcome.state
            WHEN 'succeeded' THEN jsonb_build_object(
              'status', 'succeeded', 'result', outcome.result
            )
            WHEN 'failed' THEN jsonb_build_object(
              'status', 'failed', 'error', outcome.error
            )
            WHEN 'canceled' THEN jsonb_build_object(
              'status', 'canceled', 'error', outcome.error
            )
          END
        END AS value
      ) joined;
    v_result_bytes := octet_length(v_results::text);
    IF v_result_bytes > v_result_limit THEN
      RETURN QUERY VALUES (
        'result_too_large'::text, NULL::jsonb, NULL::jsonb, v_result_bytes, v_result_limit
      );
      RETURN;
    END IF;
    IF v_had_unjoined THEN
      UPDATE workhorse.task_child edge SET joined_at = v_now
       WHERE edge.parent_task_id = p_parent_task_id AND edge.joined_at IS NULL;
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
        VALUES (
          p_parent_task_id, v_runtime.current_attempt, 'children_joined',
          jsonb_build_object(
            'child_count', v_existing_count,
            'names', (SELECT jsonb_agg(item->>'name' ORDER BY ordinality)
              FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)),
            'fence_token', p_fence_token::text,
            'result_bytes', v_result_bytes
          )
        );
    END IF;
    RETURN QUERY VALUES (
      'completed'::text, v_children, v_results, v_result_bytes, v_result_limit
    );
    RETURN;
  END IF;

  SELECT item->'request'->>'queue' INTO v_fast_queue
    FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
   WHERE item->'request'->>'queue' = ANY(workhorse.lock_queue_tiers_v1(ARRAY(
           SELECT DISTINCT child->'request'->>'queue'
             FROM jsonb_array_elements(p_children) child
            WHERE COALESCE(child->'request'->>'queue', '') <> '')))
   ORDER BY ordinality
   LIMIT 1;
  IF FOUND THEN
    PERFORM workhorse.reject_fast_feature_v1(v_fast_queue, 'child tasks');
  END IF;

  BEGIN
    FOR v_item IN
      SELECT item, ordinality::integer AS ordinal
        FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
       ORDER BY ordinality
    LOOP
      SELECT * INTO v_enqueue
        FROM workhorse.enqueue_many_v1(jsonb_build_array(v_item.item->'request'));
      IF v_enqueue.outcome <> 'accepted' THEN
        RAISE EXCEPTION 'child enqueue must create one new task';
      END IF;
      INSERT INTO workhorse.task_child(
        parent_task_id, child_task_id, child_name, request_fingerprint, created_at, created_as_set
      ) VALUES (
        p_parent_task_id, v_enqueue.task_id, v_item.item->>'name', v_item.item->'request', v_now, true
      );
      INSERT INTO workhorse.task_dependency(
        dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation, created_at
      ) VALUES (
        p_parent_task_id, v_enqueue.task_id, 'release',
        CASE WHEN p_mode = 'settled' THEN 'release' ELSE 'fail' END,
        CASE WHEN p_mode = 'settled' THEN 'release' ELSE 'cancel' END,
        v_now
      );
      INSERT INTO workhorse.task_event(task_id, event_type, details)
        VALUES (
          v_enqueue.task_id, 'parent_linked',
          jsonb_build_object('parent_task_id', p_parent_task_id, 'name', v_item.item->>'name')
        );
    END LOOP;

    UPDATE workhorse.task_runtime runtime
       SET state = 'blocked', fence_token = 0, ready_at = NULL, sequence = NULL,
           worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
           wait_name = NULL, attempt_started_at = NULL,
           execution_used_ms = LEAST(
             31536000000,
             runtime.execution_used_ms + GREATEST(
               0, floor(extract(epoch FROM v_now - runtime.acquired_at) * 1000)::bigint
             )
           ),
           attempt_timeout_at = NULL, error = NULL, updated_at = v_now
     WHERE runtime.task_id = p_parent_task_id
       AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id
       AND runtime.fence_token = p_fence_token
       AND runtime.expires_at > clock_timestamp()
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
       AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > clock_timestamp());
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1004', MESSAGE = 'child creation lost the parent lease';
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
             'childTaskId', edge.child_task_id,
             'name', edge.child_name,
             'type', task.task_type,
             'createdAt', edge.created_at,
             'joinedAt', edge.joined_at
           ) ORDER BY input.ordinality)
      INTO v_children
      FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
      JOIN workhorse.task_child edge
        ON edge.parent_task_id = p_parent_task_id AND edge.child_name = input.item->>'name'
      JOIN workhorse.task task ON task.id = edge.child_task_id;
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_parent_task_id, v_runtime.current_attempt, 'children_created',
        jsonb_build_object(
          'child_count', jsonb_array_length(p_children),
          'names', (SELECT jsonb_agg(item->>'name' ORDER BY ordinality)
            FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)),
          'fence_token', p_fence_token::text
        )
      );
    RETURN QUERY VALUES (
      'created'::text, v_children, NULL::jsonb, NULL::integer, v_result_limit
    );
  EXCEPTION
    WHEN SQLSTATE 'P1004' THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
  END;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.complete_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_result jsonb DEFAULT 'null'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_result_max_bytes integer;
BEGIN
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN workhorse.fast_complete_v1(p_task_id, p_worker_id, p_fence_token, p_result);
  END IF;
  SELECT task.result_max_bytes INTO v_result_max_bytes
    FROM workhorse.task_runtime runtime
    JOIN workhorse.task task ON task.id = runtime.task_id
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
     AND runtime.expires_at > clock_timestamp()
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
     AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > clock_timestamp())
     AND runtime.cancel_requested_at IS NULL
   FOR UPDATE OF runtime, task;
  IF NOT FOUND THEN RETURN false; END IF;
  IF octet_length(COALESCE(p_result, 'null'::jsonb)::text) > v_result_max_bytes THEN
    RAISE EXCEPTION 'result exceeds its configured size limit';
  END IF;
  DELETE FROM workhorse.task_runtime r
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
     AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
     AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
     AND r.cancel_requested_at IS NULL
  RETURNING * INTO v_runtime;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO workhorse.task_outcome(
    task_id, state, current_attempt, fence_token, run_at, result, history_through_at
  ) VALUES (
    p_task_id, 'succeeded', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, p_result,
    clock_timestamp()
  );
  INSERT INTO workhorse.attempt_history(
    task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at
  ) VALUES (
    p_task_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'succeeded',
    v_runtime.attempt_started_at, v_runtime.acquired_at
  );
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (p_task_id, v_runtime.current_attempt, 'succeeded', jsonb_build_object('fence_token', p_fence_token::text));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fail_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_error jsonb,
  p_retry_delay_ms integer DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_task workhorse.task%ROWTYPE;
  v_run_at timestamptz;
  v_state text;
  v_started_at timestamptz;
  v_claimed_at timestamptz;
  v_retry record;
  v_error jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN workhorse.fast_fail_v1(p_task_id, p_worker_id, p_fence_token, p_error, p_retry_delay_ms);
  END IF;
  SELECT * INTO v_runtime FROM workhorse.task_runtime r
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp() THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  IF v_runtime.attempt_timeout_at IS NOT NULL
     AND v_runtime.attempt_timeout_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  SELECT * INTO STRICT v_task FROM workhorse.task j WHERE j.id = p_task_id;
  v_error := workhorse.redact_error_details_v1(
    p_error,
    cardinality(v_task.payload_redact_keys) > 0 OR cardinality(v_task.result_redact_keys) > 0
  );

  IF v_runtime.current_attempt < v_task.max_attempts THEN
    v_started_at := v_runtime.attempt_started_at;
    v_claimed_at := v_runtime.acquired_at;
    SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
      p_task_id, v_runtime.current_attempt, v_task.retry_policy,
      v_runtime.previous_retry_delay_ms, p_retry_delay_ms, 'legacy-handler'
    );
    v_run_at := clock_timestamp() + make_interval(secs => v_retry.delay_ms::double precision / 1000.0);
    v_state := CASE WHEN v_retry.delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
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
     WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
       AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
       AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
       AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN RETURN 'stale'; END IF;
    IF v_state = 'ready' THEN PERFORM pg_notify('workhorse_tasks', v_task.queue_name); END IF;
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    )
      VALUES (p_task_id, v_runtime.current_attempt - 1, p_fence_token, p_worker_id, 'retry',
        v_started_at, v_claimed_at, v_error);
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (p_task_id, v_runtime.current_attempt - 1, 'retry_scheduled',
        jsonb_build_object('next_attempt', v_runtime.current_attempt, 'run_at', v_run_at,
          'error', v_error, 'retry_policy', v_task.retry_policy,
          'retry_delay_ms', v_retry.delay_ms, 'retry_delay_source', v_retry.source));
  ELSE
    DELETE FROM workhorse.task_runtime r
     WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
       AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
       AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
       AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN RETURN 'stale'; END IF;
    v_state := 'failed';
    INSERT INTO workhorse.task_outcome(
      task_id, state, current_attempt, fence_token, run_at, error, history_through_at
    ) VALUES (
      p_task_id, 'failed', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, v_error,
      clock_timestamp()
    );
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_task_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'failed',
      v_runtime.attempt_started_at, v_runtime.acquired_at, v_error
    );
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (p_task_id, v_runtime.current_attempt, 'failed', jsonb_build_object('error', v_error));
  END IF;
  RETURN v_state;
END;
$$;

-- Return an owned task to `ready` without consuming its attempt. A claim carries no task-type
-- filter, so a worker can claim a task whose type it has no handler for; failing that claim would
-- charge an attempt to a worker that never ran the handler. The release is fenced exactly as
-- completion and failure are, so a worker whose lease was already recovered cannot return a newer
-- attempt to the queue.
CREATE OR REPLACE FUNCTION workhorse.release_owned_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN workhorse.fast_release_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  SELECT * INTO v_runtime FROM workhorse.task_runtime r
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp() THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  -- A lease that already crossed its deadline or its attempt timeout is settled by the transition
  -- that owns that boundary, so a release never hides an expiry the database was about to record.
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  IF v_runtime.attempt_timeout_at IS NOT NULL
     AND v_runtime.attempt_timeout_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  -- The lease held time the attempt may not spend twice. Accounting it against the execution
  -- timeout keeps a task that bounces between workers without a handler from holding a budget open
  -- forever, exactly as a durable wait accounts the time it held the lease.
  UPDATE workhorse.task_runtime r
     SET state = 'ready', fence_token = 0, run_at = clock_timestamp(),
         ready_at = clock_timestamp(), sequence = nextval('workhorse.ready_sequence_seq'),
         worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
         wait_name = NULL,
         execution_used_ms = LEAST(
           31536000000,
           r.execution_used_ms + GREATEST(
             0, floor(extract(epoch FROM clock_timestamp() - r.acquired_at) * 1000)::bigint
           )
         ),
         attempt_timeout_at = NULL, error = NULL, updated_at = clock_timestamp()
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
     AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
     AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
     AND r.cancel_requested_at IS NULL
  RETURNING * INTO v_runtime;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  PERFORM pg_notify('workhorse_tasks', v_runtime.queue_name);
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (
      p_task_id, v_runtime.current_attempt, 'released',
      jsonb_build_object('worker_id', p_worker_id, 'fence_token', p_fence_token::text)
    );
  RETURN 'released';
END;
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
BEGIN
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

  FOR v_runtime IN
    SELECT r.* FROM workhorse.task_runtime r
     WHERE r.state = 'active' AND r.expires_at <= v_now
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

CREATE OR REPLACE FUNCTION workhorse.prune_terminal_tasks_v1(
  p_identity_before timestamptz, p_outcome_before timestamptz,
  p_history_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_fast_count integer;
  v_fast_before timestamptz := p_history_before;
BEGIN
  IF p_identity_before IS NULL OR p_outcome_before IS NULL OR p_history_before IS NULL
     OR NOT isfinite(p_identity_before) OR NOT isfinite(p_outcome_before)
     OR NOT isfinite(p_history_before) THEN
    RAISE EXCEPTION 'identity, outcome, and history cutoffs are required';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'terminal task limit must be between 1 and 100000'; END IF;

  WITH candidate_window AS MATERIALIZED (
    SELECT task.id, outcome.finished_at
      FROM workhorse.task task
      JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
     WHERE task.created_at < p_identity_before
       AND outcome.finished_at < p_outcome_before
       AND outcome.history_through_at < p_history_before
       AND NOT EXISTS (SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.task_id = task.id)
       AND NOT EXISTS (SELECT 1 FROM workhorse.task_event event WHERE event.task_id = task.id)
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.attempt_history attempt WHERE attempt.task_id = task.id
           )
     ORDER BY outcome.finished_at, task.id
     FOR UPDATE OF task SKIP LOCKED
     LIMIT LEAST(p_limit * 4, 100000)
  ), candidates AS (
    SELECT candidate.id
      FROM candidate_window candidate
     WHERE NOT EXISTS (
             SELECT 1 FROM workhorse.schedule_occurrence occurrence
              WHERE occurrence.task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.enqueue_idempotency idempotency
              WHERE idempotency.task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.task_redrive redrive
              WHERE redrive.source_task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.task_dependency dependency
              WHERE dependency.prerequisite_task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1
               FROM workhorse.task_child edge
               JOIN workhorse.task child ON child.id = edge.child_task_id
               LEFT JOIN workhorse.task_outcome child_outcome
                 ON child_outcome.task_id = edge.child_task_id
              WHERE edge.parent_task_id = candidate.id
                AND (
                  child_outcome.task_id IS NULL
                  OR child.created_at >= p_identity_before
                  OR child_outcome.finished_at >= p_outcome_before
                  OR child_outcome.history_through_at >= p_history_before
                )
           )
     ORDER BY candidate.finished_at, candidate.id
     LIMIT p_limit
  ), deleted AS (
    DELETE FROM workhorse.task task USING candidates WHERE task.id = candidates.id
    RETURNING task.id
  ), result AS (
    SELECT count(*)::integer AS pruned,
           count(*) = 0 AND EXISTS (
             SELECT 1
               FROM candidate_window candidate
               JOIN workhorse.task_dependency dependency
                 ON dependency.prerequisite_task_id = candidate.id
           ) AS dependency_starved
      FROM deleted
  ), recorded AS (
    UPDATE workhorse.maintenance_state state
       SET terminal_prune_dependency_starved = result.dependency_starved,
           updated_at = clock_timestamp()
      FROM result
     WHERE state.routine_name = 'terminal_storage'
    RETURNING result.pruned
  )
  SELECT pruned INTO STRICT v_count FROM recorded;

  -- Fast-tier outcomes share the batch. No fast task is a prerequisite or a child, and its history
  -- rows exist only when the queue opted in, so their absence stands in for history_through_at.
  -- The outcome row is the task's archived history, so while cold export is on it also waits for
  -- the fast_task_outcome export to pass its close time.
  IF EXISTS (SELECT 1 FROM workhorse.cold_export_policy policy WHERE policy.singleton AND policy.enabled) THEN
    SELECT LEAST(v_fast_before, COALESCE(
             (SELECT exported.exported_through FROM workhorse.cold_export_dataset exported
               WHERE exported.dataset = 'fast_task_outcome'),
             timestamp '2000-01-01' AT TIME ZONE 'UTC'))
      INTO v_fast_before;
  END IF;
  IF v_count < p_limit THEN
    WITH candidates AS MATERIALIZED (
      SELECT task.id
        FROM workhorse.fast_task_outcome outcome
        JOIN workhorse.task task ON task.id = outcome.task_id
       WHERE outcome.finished_at < p_outcome_before
         AND outcome.finished_at < v_fast_before
         AND task.created_at < p_identity_before
         AND NOT EXISTS (SELECT 1 FROM workhorse.task_event event WHERE event.task_id = task.id)
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.attempt_history attempt WHERE attempt.task_id = task.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.schedule_occurrence occurrence
                WHERE occurrence.task_id = task.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.enqueue_idempotency idempotency
                WHERE idempotency.task_id = task.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.task_redrive redrive
                WHERE redrive.source_task_id = task.id
             )
       ORDER BY outcome.finished_at, outcome.task_id
       FOR UPDATE OF task SKIP LOCKED
       LIMIT p_limit - v_count
    )
    DELETE FROM workhorse.task task USING candidates WHERE task.id = candidates.id;
    GET DIAGNOSTICS v_fast_count = ROW_COUNT;
    v_count := v_count + v_fast_count;
  END IF;
  RETURN v_count;
END;
$$;

-- Derive per-minute statistics from raw history for [p_from, p_to). This is the single definition
-- of what a bucket means: workhorse.rollup_stats_v1 materializes it for closed minutes, and
-- workhorse.stat_buckets_v1 evaluates it live for the minutes a rollup has not reached yet.
--
-- Sources are bucketed by the timestamp each grain is stamped with when it lands: enqueue events
-- and closed attempts by occurred_at, which is also the history partition key, and terminal tasks by
-- finished_at. Bucketing by anything the row does not carry would make recomputation non-idempotent.
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
  WITH fast_row AS MATERIALIZED (
    SELECT runtime.task_id, runtime.queue_name, runtime.task_type, runtime.enqueued_at,
           runtime.attempt, runtime.claimed_at, runtime.errors,
           NULL::text AS state, NULL::text AS closed_as, NULL::jsonb AS error,
           NULL::timestamptz AS finished_at
      FROM workhorse.fast_task_runtime runtime
     UNION ALL
    SELECT outcome.task_id, outcome.queue_name, outcome.task_type, outcome.enqueued_at,
           outcome.attempt, outcome.claimed_at, outcome.errors,
           outcome.state, outcome.closed_as, outcome.error, outcome.finished_at
      FROM workhorse.fast_task_outcome outcome
     WHERE outcome.finished_at >= p_from
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

CREATE OR REPLACE FUNCTION workhorse.list_tasks_v1(
  p_filter jsonb,
  p_limit integer,
  p_cursor_created_at timestamptz,
  p_cursor_task_id uuid,
  p_cursor_signature text,
  p_payload_projection jsonb
) RETURNS TABLE (
  task_id uuid,
  queue_name text,
  task_type text,
  concurrency_key text,
  priority integer,
  tags text[],
  state text,
  current_attempt integer,
  max_attempts integer,
  retry_policy jsonb,
  deadline_at timestamptz,
  execution_timeout_ms bigint,
  run_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by text,
  cancel_reason text,
  created_at timestamptz,
  updated_at timestamptz,
  payload jsonb,
  payload_status text,
  payload_bytes integer,
  has_more boolean,
  cursor_created_at timestamptz,
  cursor_signature text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_filter jsonb := COALESCE(p_filter, '{}'::jsonb);
  v_projection jsonb := COALESCE(p_payload_projection, '{}'::jsonb);
  v_normalized_filter jsonb;
  v_normalized_projection jsonb;
  v_queue text;
  v_type text;
  v_states text[];
  v_created_after timestamptz;
  v_created_before timestamptz;
  v_include boolean := false;
  v_max_bytes integer := 16384;
  v_redact_keys text[] := '{}';
  v_signature text;
  v_has_duplicates boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'limit must be between 1 and 1000';
  END IF;
  IF jsonb_typeof(v_filter) <> 'object' THEN RAISE EXCEPTION 'filter must be an object'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_filter) key
    WHERE key <> ALL (ARRAY['queue', 'type', 'states', 'createdAfter', 'createdBefore'])
  ) THEN
    RAISE EXCEPTION 'filter permits only queue, type, states, createdAfter, and createdBefore';
  END IF;
  IF v_filter ? 'queue' THEN
    IF jsonb_typeof(v_filter->'queue') <> 'string' OR v_filter->>'queue' = '' THEN
      RAISE EXCEPTION 'filter.queue must be a non-empty string';
    END IF;
    v_queue := v_filter->>'queue';
  END IF;
  IF v_filter ? 'type' THEN
    IF jsonb_typeof(v_filter->'type') <> 'string' OR v_filter->>'type' = '' THEN
      RAISE EXCEPTION 'filter.type must be a non-empty string';
    END IF;
    v_type := v_filter->>'type';
  END IF;
  IF v_filter ? 'states' THEN
    IF jsonb_typeof(v_filter->'states') <> 'array'
       OR jsonb_array_length(v_filter->'states') = 0 THEN
      RAISE EXCEPTION 'filter.states must be a non-empty array';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_filter->'states') state_value
      WHERE jsonb_typeof(state_value) <> 'string'
         OR state_value #>> '{}' NOT IN (
           'blocked', 'scheduled', 'ready', 'active', 'succeeded', 'failed', 'canceled'
         )
    ) THEN
      RAISE EXCEPTION 'filter.states contains an invalid lifecycle state';
    END IF;
    SELECT array_agg(state_value ORDER BY state_value), count(*) <> count(DISTINCT state_value)
      INTO STRICT v_states, v_has_duplicates
      FROM jsonb_array_elements_text(v_filter->'states') state_value;
    IF v_has_duplicates THEN RAISE EXCEPTION 'filter.states must contain unique values'; END IF;
  END IF;
  IF v_filter ? 'createdAfter' THEN
    IF jsonb_typeof(v_filter->'createdAfter') <> 'string' THEN
      RAISE EXCEPTION 'filter.createdAfter must be a timestamp string';
    END IF;
    v_created_after := (v_filter->>'createdAfter')::timestamptz;
    IF NOT isfinite(v_created_after) THEN RAISE EXCEPTION 'filter.createdAfter must be finite'; END IF;
  END IF;
  IF v_filter ? 'createdBefore' THEN
    IF jsonb_typeof(v_filter->'createdBefore') <> 'string' THEN
      RAISE EXCEPTION 'filter.createdBefore must be a timestamp string';
    END IF;
    v_created_before := (v_filter->>'createdBefore')::timestamptz;
    IF NOT isfinite(v_created_before) THEN RAISE EXCEPTION 'filter.createdBefore must be finite'; END IF;
  END IF;
  IF v_created_after IS NOT NULL AND v_created_before IS NOT NULL
     AND v_created_after >= v_created_before THEN
    RAISE EXCEPTION 'filter.createdAfter must be earlier than createdBefore';
  END IF;

  IF jsonb_typeof(v_projection) <> 'object' THEN
    RAISE EXCEPTION 'payloadProjection must be an object';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_projection) key
    WHERE key <> ALL (ARRAY['include', 'maxBytes', 'redactKeys'])
  ) THEN
    RAISE EXCEPTION 'payloadProjection permits only include, maxBytes, and redactKeys';
  END IF;
  IF v_projection ? 'include' THEN
    IF jsonb_typeof(v_projection->'include') <> 'boolean' THEN
      RAISE EXCEPTION 'payloadProjection.include must be boolean';
    END IF;
    v_include := (v_projection->>'include')::boolean;
  END IF;
  IF v_projection ? 'maxBytes' THEN
    IF jsonb_typeof(v_projection->'maxBytes') <> 'number'
       OR (v_projection->>'maxBytes')::numeric <> trunc((v_projection->>'maxBytes')::numeric)
       OR (v_projection->>'maxBytes')::numeric NOT BETWEEN 1 AND 1048576 THEN
      RAISE EXCEPTION 'payloadProjection.maxBytes must be an integer between 1 and 1048576';
    END IF;
    v_max_bytes := (v_projection->>'maxBytes')::integer;
  END IF;
  IF v_projection ? 'redactKeys' THEN
    IF jsonb_typeof(v_projection->'redactKeys') <> 'array'
       OR jsonb_array_length(v_projection->'redactKeys') > 50 THEN
      RAISE EXCEPTION 'payloadProjection.redactKeys must contain at most 50 values';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_projection->'redactKeys') key_value
      WHERE jsonb_typeof(key_value) <> 'string'
         OR char_length(key_value #>> '{}') NOT BETWEEN 1 AND 200
    ) THEN
      RAISE EXCEPTION 'payloadProjection.redactKeys values must contain 1 to 200 characters';
    END IF;
    SELECT COALESCE(array_agg(key_value ORDER BY key_value), '{}'),
           count(*) <> count(DISTINCT key_value)
      INTO STRICT v_redact_keys, v_has_duplicates
      FROM jsonb_array_elements_text(v_projection->'redactKeys') key_value;
    IF v_has_duplicates THEN
      RAISE EXCEPTION 'payloadProjection.redactKeys must contain unique values';
    END IF;
  END IF;

  v_normalized_filter := jsonb_strip_nulls(jsonb_build_object(
    'queue', v_queue,
    'type', v_type,
    'states', CASE WHEN v_states IS NULL THEN NULL ELSE to_jsonb(v_states) END,
    'createdAfter', CASE WHEN v_created_after IS NULL THEN NULL
      ELSE to_char(v_created_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'createdBefore', CASE WHEN v_created_before IS NULL THEN NULL
      ELSE to_char(v_created_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
  ));
  v_normalized_projection := jsonb_build_object(
    'include', v_include,
    'maxBytes', v_max_bytes,
    'redactKeys', to_jsonb(v_redact_keys)
  );
  v_signature := left(workhorse.sha256_hex_v1(jsonb_build_object(
    'filter', v_normalized_filter,
    'payloadProjection', v_normalized_projection
  )::text), 16);

  IF (p_cursor_created_at IS NULL) <> (p_cursor_task_id IS NULL)
     OR (p_cursor_created_at IS NULL) <> (p_cursor_signature IS NULL) THEN
    RAISE EXCEPTION 'cursor timestamp, task id, and signature must be provided together';
  END IF;
  IF p_cursor_created_at IS NOT NULL THEN
    IF NOT isfinite(p_cursor_created_at) THEN RAISE EXCEPTION 'cursor timestamp must be finite'; END IF;
    IF p_cursor_signature !~ '^[0-9a-f]{16}$' THEN
      RAISE EXCEPTION 'cursor signature must be 16 lowercase hexadecimal characters';
    END IF;
    IF p_cursor_signature <> v_signature THEN
      RAISE EXCEPTION 'cursor does not match the requested filter and payload projection';
    END IF;
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT query_row.task_id, query_row.queue_name, query_row.task_type,
           lifecycle.state, lifecycle.current_attempt, lifecycle.run_at,
           query_row.created_at, lifecycle.updated_at,
           lifecycle.cancel_requested_at, lifecycle.cancel_requested_by,
           lifecycle.cancel_reason
    FROM workhorse.task_query query_row
    JOIN LATERAL (
      SELECT runtime.state, runtime.current_attempt, runtime.run_at, runtime.updated_at,
             runtime.cancel_requested_at, runtime.cancel_requested_by, runtime.cancel_reason
        FROM workhorse.task_runtime runtime
       WHERE runtime.task_id = query_row.task_id
      UNION ALL
      SELECT outcome.state, outcome.current_attempt, outcome.run_at, outcome.updated_at,
             CASE WHEN outcome.state = 'canceled'
               THEN NULLIF(outcome.error->>'requested_at', '')::timestamptz END,
             CASE WHEN outcome.state = 'canceled' THEN outcome.error->>'requested_by' END,
             CASE WHEN outcome.state = 'canceled' THEN outcome.error->>'reason' END
        FROM workhorse.task_outcome outcome
       WHERE outcome.task_id = query_row.task_id
      UNION ALL
      SELECT CASE WHEN fast_runtime.state = 'ready' AND fast_runtime.run_at > statement_timestamp()
               THEN 'scheduled' ELSE fast_runtime.state END,
             fast_runtime.attempt, fast_runtime.run_at,
             COALESCE(fast_runtime.claimed_at, fast_runtime.run_at),
             fast_runtime.cancel_requested_at, fast_runtime.cancel_requested_by,
             fast_runtime.cancel_reason
        FROM workhorse.fast_task_runtime fast_runtime
       WHERE fast_runtime.task_id = query_row.task_id
      UNION ALL
      SELECT fast_outcome.state, fast_outcome.attempt,
             COALESCE(fast_outcome.claimed_at, fast_outcome.enqueued_at), fast_outcome.finished_at,
             CASE WHEN fast_outcome.state = 'canceled'
               THEN NULLIF(fast_outcome.error->>'requested_at', '')::timestamptz END,
             CASE WHEN fast_outcome.state = 'canceled' THEN fast_outcome.error->>'requested_by' END,
             CASE WHEN fast_outcome.state = 'canceled' THEN fast_outcome.error->>'reason' END
        FROM workhorse.fast_task_outcome fast_outcome
       WHERE fast_outcome.task_id = query_row.task_id
    ) lifecycle ON true
    WHERE (v_queue IS NULL OR query_row.queue_name = v_queue)
      AND (v_type IS NULL OR query_row.task_type = v_type)
      AND (v_states IS NULL OR lifecycle.state = ANY(v_states))
      AND (v_created_after IS NULL OR query_row.created_at >= v_created_after)
      AND (v_created_before IS NULL OR query_row.created_at < v_created_before)
      AND (p_cursor_created_at IS NULL
        OR (query_row.created_at, query_row.task_id) < (p_cursor_created_at, p_cursor_task_id))
    ORDER BY query_row.created_at DESC, query_row.task_id DESC
    LIMIT p_limit + 1
  ), page AS MATERIALIZED (
    SELECT candidate.*
    FROM candidates candidate
    ORDER BY candidate.created_at DESC, candidate.task_id DESC
    LIMIT p_limit
  ), page_meta AS (
    SELECT count(*) > p_limit AS has_more FROM candidates
  )
  SELECT
    page.task_id,
    page.queue_name,
    page.task_type,
    task.concurrency_key,
    task.priority,
    task.tags,
    page.state,
    page.current_attempt,
    task.max_attempts,
    task.retry_policy,
    task.deadline_at,
    task.execution_timeout_ms,
    page.run_at,
    page.cancel_requested_at,
    page.cancel_requested_by,
    page.cancel_reason,
    page.created_at,
    page.updated_at,
    CASE WHEN v_include AND payload_value.payload_bytes <= v_max_bytes
      THEN payload_value.payload END,
    CASE
      WHEN NOT v_include THEN 'omitted'
      WHEN payload_value.payload_bytes <= v_max_bytes THEN 'included'
      ELSE 'too_large'
    END,
    CASE WHEN v_include THEN payload_value.payload_bytes END,
    page_meta.has_more,
    page.created_at,
    v_signature
  FROM page
  JOIN workhorse.task task ON task.id = page.task_id
  CROSS JOIN page_meta
  LEFT JOIN LATERAL (
    SELECT redacted.payload, octet_length(redacted.payload::text)::integer AS payload_bytes
    FROM (
      SELECT workhorse.redact_top_level_keys_v1(
        task.payload, task.payload_redact_keys || v_redact_keys
      ) AS payload
    ) redacted
    WHERE v_include
  ) payload_value ON true
  ORDER BY page.created_at DESC, page.task_id DESC;
END;
$$;

-- These lifecycle functions read every suspension provenance table, so the clean-install layout
-- defines them after human waits instead of carrying incomplete earlier versions.
CREATE OR REPLACE FUNCTION workhorse.terminalize_deadline_v1(p_task_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_error jsonb;
  v_worker_id text;
  v_fence_token bigint := 0;
  v_claimed_at timestamptz;
BEGIN
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN workhorse.fast_terminalize_deadline_v1(p_task_id);
  END IF;
  SELECT * INTO v_runtime FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_runtime.deadline_at IS NULL
     OR v_runtime.deadline_at > clock_timestamp() THEN RETURN false; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN
    v_error := workhorse.cancellation_envelope_v1(
      v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
    );
    DELETE FROM workhorse.task_runtime runtime WHERE runtime.task_id = p_task_id;
    INSERT INTO workhorse.task_outcome(
      task_id, state, current_attempt, fence_token, run_at, error, history_through_at
    ) VALUES (
      p_task_id, 'canceled', v_runtime.current_attempt, v_runtime.fence_token,
      v_runtime.run_at, v_error, clock_timestamp()
    );
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_task_id, v_runtime.current_attempt, v_runtime.fence_token, v_runtime.worker_id,
      'canceled', v_runtime.attempt_started_at, v_runtime.acquired_at, v_error
    );
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_runtime.current_attempt, 'canceled',
        jsonb_build_object(
          'requested_at', v_runtime.cancel_requested_at,
          'requested_by', v_runtime.cancel_requested_by,
          'reason', v_runtime.cancel_reason,
          'fence_token', v_runtime.fence_token::text,
          'source', 'deadline_reaper'
        )
      );
    RETURN true;
  END IF;
  v_error := workhorse.deadline_envelope_v1(v_runtime.deadline_at);
  IF v_runtime.state = 'active' THEN
    v_worker_id := v_runtime.worker_id;
    v_fence_token := v_runtime.fence_token;
    v_claimed_at := v_runtime.acquired_at;
  ELSIF v_runtime.attempt_started_at IS NOT NULL THEN
    SELECT provenance.worker_id, provenance.fence_token, provenance.claimed_at
      INTO STRICT v_worker_id, v_fence_token, v_claimed_at
      FROM (
        SELECT wait_row.worker_id, wait_row.fence_token, wait_row.claimed_at,
               wait_row.created_at, wait_row.wait_name AS name
          FROM workhorse.task_wait wait_row
         WHERE wait_row.task_id = p_task_id AND wait_row.attempt = v_runtime.current_attempt
        UNION ALL
        SELECT signal.worker_id, signal.fence_token, signal.claimed_at,
               signal.created_at, signal.signal_name AS name
          FROM workhorse.task_signal_wait signal
         WHERE signal.task_id = p_task_id AND signal.attempt = v_runtime.current_attempt
        UNION ALL
        SELECT human_wait.worker_id, human_wait.fence_token, human_wait.claimed_at,
               human_wait.created_at, human_wait.token_name AS name
          FROM workhorse.task_human_wait human_wait
         WHERE human_wait.task_id = p_task_id
           AND human_wait.attempt = v_runtime.current_attempt
      ) provenance
     ORDER BY provenance.created_at DESC, provenance.name DESC LIMIT 1;
  END IF;
  DELETE FROM workhorse.task_runtime runtime WHERE runtime.task_id = p_task_id;
  INSERT INTO workhorse.task_outcome(
    task_id, state, current_attempt, fence_token, run_at, error, history_through_at
  ) VALUES (
    p_task_id, 'failed', v_runtime.current_attempt, v_fence_token, v_runtime.run_at, v_error,
    clock_timestamp()
  );
  IF v_runtime.attempt_started_at IS NOT NULL THEN
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_task_id, v_runtime.current_attempt, v_fence_token, v_worker_id,
      'deadline_exceeded', v_runtime.attempt_started_at, v_claimed_at, v_error
    );
  END IF;
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (
      p_task_id,
      CASE WHEN v_runtime.attempt_started_at IS NULL THEN NULL ELSE v_runtime.current_attempt END,
      'deadline_exceeded',
      jsonb_build_object(
        'deadline_at', v_runtime.deadline_at,
        'fence_token', v_fence_token::text,
        'started', v_runtime.attempt_started_at IS NOT NULL
      )
    );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.cancel_v1(
  p_task_id uuid, p_requested_by text DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS TABLE (
  status text, state text, current_attempt integer, requested_at timestamptz,
  requested_by text, reason text, finished_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_outcome workhorse.task_outcome%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_fence_token bigint := 0;
  v_worker_id text;
  v_claimed_at timestamptz;
  v_attempt integer;
  v_envelope jsonb;
  v_fast_outcome workhorse.fast_task_outcome%ROWTYPE;
BEGIN
  IF p_task_id IS NULL THEN RAISE EXCEPTION 'task_id is required'; END IF;
  IF p_requested_by IS NOT NULL
     AND (p_requested_by = '' OR char_length(p_requested_by) > 200) THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NOT NULL AND (p_reason = '' OR char_length(p_reason) > 2000) THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;

  -- A fast-tier task that settles between this check and its lock falls through to the outcome
  -- lookup below, which reads both outcome tables.
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN QUERY SELECT * FROM workhorse.fast_cancel_v1(p_task_id, p_requested_by, p_reason);
    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_runtime.state = 'active' THEN
      IF v_runtime.cancel_requested_at IS NULL THEN
        UPDATE workhorse.task_runtime runtime
           SET cancel_requested_at = v_now,
               cancel_requested_by = p_requested_by,
               cancel_reason = p_reason,
               updated_at = v_now
         WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
           AND runtime.cancel_requested_at IS NULL
        RETURNING * INTO v_runtime;
        IF FOUND THEN
          INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
            VALUES (
              p_task_id,
              v_runtime.current_attempt,
              'cancel_requested',
              jsonb_build_object(
                'requested_at', v_now,
                'requested_by', p_requested_by,
                'reason', p_reason,
                'fence_token', v_runtime.fence_token::text
              )
            );
        END IF;
      END IF;
      RETURN QUERY VALUES (
        'cancel_requested'::text,
        'active'::text,
        v_runtime.current_attempt,
        v_runtime.cancel_requested_at,
        v_runtime.cancel_requested_by,
        v_runtime.cancel_reason,
        NULL::timestamptz
      );
      RETURN;
    END IF;

    -- A suspended logical attempt retains its original worker/fence attribution in its timer or
    -- signal or human boundary even though scheduled runtime ownership has been released.
    IF v_runtime.attempt_started_at IS NOT NULL THEN
      SELECT provenance.fence_token, provenance.worker_id, provenance.attempt,
             provenance.claimed_at
        INTO v_fence_token, v_worker_id, v_attempt, v_claimed_at
        FROM (
          SELECT wait_row.fence_token, wait_row.worker_id, wait_row.attempt,
                 wait_row.claimed_at, wait_row.created_at, wait_row.wait_name AS name
            FROM workhorse.task_wait wait_row
           WHERE wait_row.task_id = p_task_id AND wait_row.attempt = v_runtime.current_attempt
          UNION ALL
          SELECT signal.fence_token, signal.worker_id, signal.attempt,
                 signal.claimed_at, signal.created_at, signal.signal_name AS name
            FROM workhorse.task_signal_wait signal
           WHERE signal.task_id = p_task_id AND signal.attempt = v_runtime.current_attempt
          UNION ALL
          SELECT human_wait.fence_token, human_wait.worker_id, human_wait.attempt,
                 human_wait.claimed_at, human_wait.created_at, human_wait.token_name AS name
            FROM workhorse.task_human_wait human_wait
           WHERE human_wait.task_id = p_task_id
             AND human_wait.attempt = v_runtime.current_attempt
        ) provenance
       ORDER BY provenance.created_at DESC, provenance.name DESC
       LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'started task % has no retained suspension attribution', p_task_id;
      END IF;
    END IF;
    v_envelope := workhorse.cancellation_envelope_v1(v_now, p_requested_by, p_reason);
    DELETE FROM workhorse.task_runtime runtime WHERE runtime.task_id = p_task_id;
    INSERT INTO workhorse.task_outcome(
      task_id, state, current_attempt, fence_token, run_at, error, finished_at, updated_at,
      history_through_at
    ) VALUES (
      p_task_id, 'canceled', v_runtime.current_attempt, v_fence_token, v_runtime.run_at,
      v_envelope, v_now, v_now, v_now
    ) RETURNING * INTO v_outcome;
    IF v_runtime.attempt_started_at IS NOT NULL THEN
      INSERT INTO workhorse.attempt_history(
        task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
      ) VALUES (
        p_task_id, v_attempt, v_fence_token, v_worker_id, 'canceled',
        v_runtime.attempt_started_at, v_claimed_at, v_envelope
      );
    END IF;
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id,
        CASE WHEN v_runtime.attempt_started_at IS NULL THEN NULL ELSE v_attempt END,
        'canceled',
        jsonb_build_object(
          'requested_at', v_now,
          'requested_by', p_requested_by,
          'reason', p_reason,
          'fence_token', v_fence_token::text,
          'source', 'immediate'
        )
      );
    RETURN QUERY VALUES (
      'canceled'::text, 'canceled'::text, v_runtime.current_attempt,
      v_now, p_requested_by, p_reason, v_outcome.finished_at
    );
    RETURN;
  END IF;

  SELECT * INTO v_outcome FROM workhorse.task_outcome outcome WHERE outcome.task_id = p_task_id;
  IF FOUND THEN
    IF v_outcome.state = 'canceled' THEN
      RETURN QUERY VALUES (
        'canceled'::text,
        v_outcome.state,
        v_outcome.current_attempt,
        NULLIF(v_outcome.error->>'requested_at', '')::timestamptz,
        v_outcome.error->>'requested_by',
        v_outcome.error->>'reason',
        v_outcome.finished_at
      );
    ELSE
      RETURN QUERY VALUES (
        'already_terminal'::text, v_outcome.state, v_outcome.current_attempt,
        NULL::timestamptz, NULL::text, NULL::text, v_outcome.finished_at
      );
    END IF;
    RETURN;
  END IF;

  SELECT * INTO v_fast_outcome FROM workhorse.fast_task_outcome outcome
   WHERE outcome.task_id = p_task_id;
  IF FOUND THEN
    IF v_fast_outcome.state = 'canceled' THEN
      RETURN QUERY VALUES (
        'canceled'::text, v_fast_outcome.state, v_fast_outcome.attempt,
        NULLIF(v_fast_outcome.error->>'requested_at', '')::timestamptz,
        v_fast_outcome.error->>'requested_by', v_fast_outcome.error->>'reason',
        v_fast_outcome.finished_at
      );
    ELSE
      RETURN QUERY VALUES (
        'already_terminal'::text, v_fast_outcome.state, v_fast_outcome.attempt,
        NULL::timestamptz, NULL::text, NULL::text, v_fast_outcome.finished_at
      );
    END IF;
    RETURN;
  END IF;

  RETURN QUERY VALUES (
    'not_found'::text, NULL::text, NULL::integer, NULL::timestamptz,
    NULL::text, NULL::text, NULL::timestamptz
  );
END;
$$;

-- Stable, versioned relations owned by core for dashboard reads. PostgreSQL stores each view's
-- expanded target list, so later private-table changes can preserve this contract in one migration.
-- A fast-tier task keeps its attempts in two places unless its queue records attempts: the capped
-- errors list holds each retried attempt, and the outcome row names the final claim. This view
-- presents both as attempt rows. A derived row takes a stable identity from its task and attempt,
-- so a detail read can find it again. A final attempt that attempt_history already records is not
-- derived a second time.
CREATE OR REPLACE VIEW workhorse.dashboard_attempt_history_v1 AS
  SELECT attempt_id, task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, error, occurred_at FROM workhorse.attempt_history
  UNION ALL
  SELECT md5(entries.task_id::text || ':' || entry.attempt || ':attempt')::uuid, entries.task_id,
         entry.attempt, entry.fence_token::bigint, entry.worker_id, entry.outcome,
         entry.claimed_at, entry.claimed_at, entry.finished_at, entry.error, entry.finished_at
    FROM (
      SELECT task_id, errors FROM workhorse.fast_task_runtime
      UNION ALL
      SELECT task_id, errors FROM workhorse.fast_task_outcome
    ) entries
    CROSS JOIN LATERAL jsonb_to_recordset(entries.errors) AS entry(
      attempt integer, fence_token text, worker_id text, claimed_at timestamptz,
      finished_at timestamptz, outcome text, error jsonb
    )
  UNION ALL
  SELECT md5(outcome.task_id::text || ':' || outcome.attempt || ':attempt')::uuid, outcome.task_id,
         outcome.attempt, outcome.fence_token, outcome.worker_id,
         COALESCE(outcome.closed_as, outcome.state), outcome.claimed_at, outcome.claimed_at,
         outcome.finished_at, CASE WHEN outcome.state <> 'succeeded' THEN outcome.error END,
         outcome.finished_at
    FROM workhorse.fast_task_outcome outcome
   WHERE outcome.claimed_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM workhorse.attempt_history recorded
        WHERE recorded.task_id = outcome.task_id AND recorded.attempt = outcome.attempt
     );

-- A fast-tier task writes no events of its own, so this view derives the three its rows can
-- support: the enqueue, each claim, and the close. A queue that records claims already has real
-- claimed events, and a derived claim for the same attempt is left out. Each derived event takes a
-- stable identity from its task, attempt, and kind.
CREATE OR REPLACE VIEW workhorse.dashboard_task_event_v1 AS
  SELECT event_id, task_id, attempt, event_type, details, occurred_at FROM workhorse.task_event
  UNION ALL
  SELECT md5(fast.task_id::text || ':0:enqueued')::uuid, fast.task_id, NULL::integer, 'enqueued',
         jsonb_build_object('tier', 'fast') || COALESCE((
           SELECT jsonb_build_object('idempotency', jsonb_build_object(
                    'scope', idempotency.idempotency_scope,
                    'expires_at', idempotency.expires_at))
             FROM workhorse.enqueue_idempotency idempotency
            WHERE idempotency.task_id = fast.task_id
            LIMIT 1
         ), '{}'::jsonb),
         fast.enqueued_at
    FROM (
      SELECT task_id, enqueued_at FROM workhorse.fast_task_runtime
      UNION ALL
      SELECT task_id, enqueued_at FROM workhorse.fast_task_outcome
    ) fast
  UNION ALL
  SELECT md5(claim.task_id::text || ':' || claim.attempt || ':claimed')::uuid, claim.task_id,
         claim.attempt, 'claimed',
         jsonb_build_object('worker_id', claim.worker_id, 'fence_token', claim.fence_token),
         claim.claimed_at
    FROM (
      SELECT runtime.task_id, runtime.attempt, runtime.worker_id, runtime.fence_token::text,
             runtime.claimed_at
        FROM workhorse.fast_task_runtime runtime
       WHERE runtime.state = 'active'
      UNION ALL
      SELECT outcome.task_id, outcome.attempt, outcome.worker_id, outcome.fence_token::text,
             outcome.claimed_at
        FROM workhorse.fast_task_outcome outcome
       WHERE outcome.claimed_at IS NOT NULL
      UNION ALL
      SELECT entries.task_id, entry.attempt, entry.worker_id, entry.fence_token, entry.claimed_at
        FROM (
          SELECT task_id, errors FROM workhorse.fast_task_runtime
          UNION ALL
          SELECT task_id, errors FROM workhorse.fast_task_outcome
        ) entries
        CROSS JOIN LATERAL jsonb_to_recordset(entries.errors) AS entry(
          attempt integer, fence_token text, worker_id text, claimed_at timestamptz
        )
    ) claim
   WHERE NOT EXISTS (
     SELECT 1 FROM workhorse.task_event recorded
      WHERE recorded.task_id = claim.task_id AND recorded.attempt = claim.attempt
        AND recorded.event_type = 'claimed'
   )
  UNION ALL
  SELECT md5(outcome.task_id::text || ':' || outcome.attempt || ':terminal')::uuid,
         outcome.task_id, CASE WHEN outcome.claimed_at IS NULL THEN NULL ELSE outcome.attempt END,
         COALESCE(outcome.closed_as, outcome.state),
         jsonb_strip_nulls(jsonb_build_object(
           'fence_token', outcome.fence_token::text,
           'error', CASE WHEN outcome.state <> 'succeeded' THEN outcome.error END
         )),
         outcome.finished_at
    FROM workhorse.fast_task_outcome outcome;

-- `result` is deliberately absent. Its redaction keys live on workhorse.task, so projecting it
-- here would join every reader of this view to workhorse.task, including the task list and the
-- activity chart, which never read a result. Measurement showed that join changing the loaded plan
-- for both. The one caller that needs a result reads workhorse.dashboard_task_result_v1 instead,
-- which ADR 0027 reserves for exactly this: a policy-bearing read a view cannot carry.
-- A fast-tier outcome keeps no run time of its own. Its last claim, or its enqueue when it was
-- never claimed, stands in for one.
CREATE OR REPLACE VIEW workhorse.dashboard_task_outcome_v1 AS
  SELECT task_id, state, current_attempt, run_at, error, finished_at, updated_at
    FROM workhorse.task_outcome
  UNION ALL
  SELECT task_id, state, attempt, COALESCE(claimed_at, enqueued_at), error, finished_at,
         finished_at
    FROM workhorse.fast_task_outcome;

-- The redacted terminal result for one task. Redaction is applied here, not by each dashboard
-- backend, so a backend in any language cannot forget it (ADR 0015, ADR 0035).
CREATE OR REPLACE FUNCTION workhorse.dashboard_task_result_v1(p_task_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT workhorse.redact_top_level_keys_v1(outcome.result, task.result_redact_keys)
    FROM (
      SELECT task_id, result FROM workhorse.task_outcome WHERE task_id = p_task_id
      UNION ALL
      SELECT task_id, result FROM workhorse.fast_task_outcome WHERE task_id = p_task_id
    ) outcome
    JOIN workhorse.task task ON task.id = outcome.task_id;
$$;

CREATE OR REPLACE VIEW workhorse.dashboard_task_runtime_v1 AS
  SELECT task_id, queue_name, state, current_attempt, fence_token, run_at, ready_at, worker_id,
         acquired_at, heartbeat_at, expires_at, attempt_timeout_at, wait_name, attempt_started_at,
         cancel_requested_at, cancel_requested_by, cancel_reason, error, updated_at, priority
    FROM workhorse.task_runtime
  UNION ALL
  -- A delayed fast-tier row is ready with a future run time. The dashboard shows it as scheduled,
  -- the state a full-tier task has in that position. A fast-tier row keeps no heartbeat time; a
  -- heartbeat only moves its expiry.
  SELECT task_id, queue_name,
         CASE WHEN state = 'ready' AND run_at > statement_timestamp() THEN 'scheduled' ELSE state END,
         attempt, fence_token, run_at,
         CASE WHEN state = 'ready' AND run_at <= statement_timestamp() THEN run_at END,
         worker_id, claimed_at, NULL::timestamptz, expires_at, attempt_timeout_at, NULL::text,
         claimed_at, cancel_requested_at, cancel_requested_by, cancel_reason,
         errors -> -1 -> 'error', COALESCE(claimed_at, run_at), priority
    FROM workhorse.fast_task_runtime;

CREATE OR REPLACE VIEW workhorse.dashboard_queue_control_v1 AS
  SELECT queue_name, paused, tier, record_attempts, record_claims FROM workhorse.queue_control;

-- The UTC day that holds the oldest retained row of one exported dataset, or NULL when nothing is
-- retained. Day partitions answer from their bounds; the default partition is scanned for its minimum.
CREATE OR REPLACE FUNCTION workhorse.cold_export_oldest_history_day_internal_v1(
  p_dataset text
) RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v_partition_day timestamptz;
DECLARE v_default_day timestamptz;
BEGIN
  IF p_dataset NOT IN ('task_event', 'attempt_history', 'fast_task_outcome') THEN
    RAISE EXCEPTION 'cold export dataset must be task_event, attempt_history or fast_task_outcome';
  END IF;
  -- Fast-tier outcomes live in one unpartitioned table, so its minimum close time is the answer.
  IF p_dataset = 'fast_task_outcome' THEN
    RETURN (
      SELECT date_trunc('day', min(outcome.finished_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        FROM workhorse.fast_task_outcome outcome
    );
  END IF;
  SELECT min(((regexp_match(
           pg_get_expr(child.relpartbound, child.oid),
           'FROM \(''([^'']+)''\)'
         ))[1])::timestamptz)
    INTO v_partition_day
    FROM pg_inherits inheritance
    JOIN pg_class parent ON parent.oid = inheritance.inhparent
    JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = inheritance.inhrelid
   WHERE namespace.nspname = 'workhorse'
     AND parent.relname = p_dataset
     AND child.relname <> p_dataset || '_default';
  IF p_dataset = 'task_event' THEN
    SELECT date_trunc('day', min(history.occurred_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      INTO v_default_day
      FROM workhorse.task_event_default history;
  ELSE
    SELECT date_trunc('day', min(history.occurred_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      INTO v_default_day
      FROM workhorse.attempt_history_default history;
  END IF;
  RETURN LEAST(v_partition_day, v_default_day);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.get_cold_export_status_v1()
RETURNS TABLE (
  enabled boolean,
  dataset text,
  exported_through timestamptz,
  exportable_through timestamptz,
  complete_segments bigint,
  exporting_segment_start timestamptz,
  exporting_attempts integer,
  last_error jsonb,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(policy.enabled, false),
         names.dataset,
         exported.exported_through,
         workhorse.cold_export_exportable_through_internal_v1(clock_timestamp()),
         (SELECT count(*) FROM workhorse.cold_export_segment segment
           WHERE segment.dataset = names.dataset AND segment.status = 'complete'),
         exporting.segment_start,
         exporting.attempts,
         (SELECT failed.last_error FROM workhorse.cold_export_segment failed
           WHERE failed.dataset = names.dataset AND failed.last_error IS NOT NULL
           ORDER BY failed.updated_at DESC LIMIT 1),
         GREATEST(policy.updated_at, exported.updated_at)
    FROM unnest(ARRAY['attempt_history', 'fast_task_outcome', 'task_event']) AS names(dataset)
    LEFT JOIN workhorse.cold_export_policy policy ON policy.singleton
    LEFT JOIN workhorse.cold_export_dataset exported ON exported.dataset = names.dataset
    LEFT JOIN LATERAL (
      SELECT segment.segment_start, segment.attempts
        FROM workhorse.cold_export_segment segment
       WHERE segment.dataset = names.dataset AND segment.status = 'exporting'
       ORDER BY segment.segment_start
       LIMIT 1
    ) exporting ON true
   ORDER BY names.dataset
$$;

-- Turn export on or off. Enabling starts each dataset at the UTC day of its oldest retained row
-- unless p_from names an earlier or later day; the start never moves once a dataset has one, and
-- re-enabling skips days retention deleted while export was off, because they cannot be exported.
CREATE OR REPLACE FUNCTION workhorse.set_cold_export_policy_v1(
  p_enabled boolean,
  p_from timestamptz DEFAULT NULL
) RETURNS TABLE (
  enabled boolean,
  dataset text,
  exported_through timestamptz,
  exportable_through timestamptz,
  complete_segments bigint,
  exporting_segment_start timestamptz,
  exporting_attempts integer,
  last_error jsonb,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.cold_export_policy%ROWTYPE;
DECLARE v_dataset text;
DECLARE v_existing timestamptz;
DECLARE v_oldest timestamptz;
DECLARE v_start timestamptz;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'cold export enabled flag is required'; END IF;
  IF p_from IS NOT NULL AND NOT isfinite(p_from) THEN
    RAISE EXCEPTION 'cold export start must be a finite timestamp';
  END IF;
  IF p_from IS NOT NULL AND NOT p_enabled THEN
    RAISE EXCEPTION 'cold export start applies only when enabling export';
  END IF;
  INSERT INTO workhorse.cold_export_policy(singleton) VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;
  SELECT * INTO STRICT v_policy FROM workhorse.cold_export_policy WHERE singleton FOR UPDATE;
  IF p_enabled THEN
    FOREACH v_dataset IN ARRAY ARRAY['task_event', 'attempt_history', 'fast_task_outcome'] LOOP
      v_oldest := COALESCE(
        workhorse.cold_export_oldest_history_day_internal_v1(v_dataset),
        date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      );
      SELECT exported.exported_through INTO v_existing
        FROM workhorse.cold_export_dataset exported
       WHERE exported.dataset = v_dataset
         FOR UPDATE;
      IF FOUND THEN
        IF p_from IS NOT NULL
           AND date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' <> v_existing THEN
          RAISE EXCEPTION 'cold export of % already started at %; the start cannot move',
            v_dataset, v_existing;
        END IF;
        UPDATE workhorse.cold_export_dataset exported
           SET exported_through = GREATEST(exported.exported_through, v_oldest),
               updated_at = clock_timestamp()
         WHERE exported.dataset = v_dataset
           AND exported.exported_through < v_oldest;
      ELSE
        v_start := COALESCE(
          date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', v_oldest
        );
        INSERT INTO workhorse.cold_export_dataset(dataset, exported_through)
        VALUES (v_dataset, v_start);
      END IF;
    END LOOP;
  END IF;
  UPDATE workhorse.cold_export_policy policy
     SET enabled = p_enabled,
         updated_at = CASE WHEN policy.enabled = p_enabled THEN policy.updated_at
                           ELSE clock_timestamp() END
   WHERE policy.singleton;
  RETURN QUERY SELECT * FROM workhorse.get_cold_export_status_v1();
END;
$$;

-- Hand one exporter the next day to export, oldest first. An abandoned segment whose lease has
-- lapsed is handed out again before a new one is opened, so a crashed export resumes rather than
-- leaving a hole. Nothing is handed out while export is off or while another exporter holds a lease.
CREATE OR REPLACE FUNCTION workhorse.claim_cold_export_segment_v1(
  p_dataset text,
  p_exporter_id text,
  p_lease_ms integer,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  dataset text,
  segment_start timestamptz,
  segment_end timestamptz,
  attempts integer,
  exportable_through timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE v_enabled boolean;
DECLARE v_exported_through timestamptz;
DECLARE v_limit timestamptz;
DECLARE v_segment workhorse.cold_export_segment%ROWTYPE;
BEGIN
  IF p_dataset NOT IN ('task_event', 'attempt_history', 'fast_task_outcome') THEN
    RAISE EXCEPTION 'cold export dataset must be task_event, attempt_history or fast_task_outcome';
  END IF;
  IF p_exporter_id IS NULL OR p_exporter_id = '' OR octet_length(p_exporter_id) > 256 THEN
    RAISE EXCEPTION 'cold export exporter id must contain 1 through 256 bytes';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 86400000 THEN
    RAISE EXCEPTION 'cold export lease must be between 1000 and 86400000 milliseconds';
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'claim time is required'; END IF;
  SELECT policy.enabled INTO v_enabled
    FROM workhorse.cold_export_policy policy WHERE policy.singleton;
  IF NOT COALESCE(v_enabled, false) THEN RETURN; END IF;
  SELECT exported.exported_through INTO v_exported_through
    FROM workhorse.cold_export_dataset exported
   WHERE exported.dataset = p_dataset
     FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_limit := workhorse.cold_export_exportable_through_internal_v1(p_now);

  SELECT * INTO v_segment
    FROM workhorse.cold_export_segment segment
   WHERE segment.dataset = p_dataset AND segment.status = 'exporting'
   ORDER BY segment.segment_start
   LIMIT 1
     FOR UPDATE;
  IF FOUND THEN
    IF v_segment.lease_expires_at IS NOT NULL AND v_segment.lease_expires_at > p_now THEN
      RETURN;
    END IF;
    UPDATE workhorse.cold_export_segment segment
       SET attempts = segment.attempts + 1,
           exporter_id = p_exporter_id,
           lease_expires_at = p_now + make_interval(secs => p_lease_ms / 1000.0),
           started_at = p_now,
           updated_at = clock_timestamp()
     WHERE segment.dataset = v_segment.dataset
       AND segment.segment_start = v_segment.segment_start
    RETURNING * INTO v_segment;
  ELSE
    IF v_exported_through + interval '1 day' > v_limit THEN RETURN; END IF;
    INSERT INTO workhorse.cold_export_segment(
      dataset, segment_start, segment_end, status, attempts, exporter_id, lease_expires_at,
      started_at
    ) VALUES (
      p_dataset, v_exported_through, v_exported_through + interval '1 day', 'exporting', 1,
      p_exporter_id, p_now + make_interval(secs => p_lease_ms / 1000.0), p_now
    )
    RETURNING * INTO v_segment;
  END IF;
  dataset := v_segment.dataset;
  segment_start := v_segment.segment_start;
  segment_end := v_segment.segment_end;
  attempts := v_segment.attempts;
  exportable_through := v_limit;
  RETURN NEXT;
END;
$$;

-- One keyset page of a history dataset inside a segment, in immutable identity order. The page
-- reads the parent relation so partition pruning selects the day, and to_jsonb keeps every column.
CREATE OR REPLACE FUNCTION workhorse.read_cold_export_rows_v1(
  p_dataset text,
  p_from timestamptz,
  p_to timestamptz,
  p_after_occurred_at timestamptz,
  p_after_id uuid,
  p_limit integer
) RETURNS TABLE (occurred_at timestamptz, row_id uuid, record jsonb)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to <= p_from THEN
    RAISE EXCEPTION 'cold export segment bounds must be a finite half-open range';
  END IF;
  IF (p_after_occurred_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'cold export cursor needs both a time and an identity';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'cold export page size must be between 1 and 100000';
  END IF;
  IF p_dataset = 'task_event' THEN
    RETURN QUERY
      SELECT history.occurred_at, history.event_id, to_jsonb(history)
        FROM workhorse.task_event history
       WHERE history.occurred_at >= p_from AND history.occurred_at < p_to
         AND (p_after_id IS NULL
              OR (history.occurred_at, history.event_id) > (p_after_occurred_at, p_after_id))
       ORDER BY history.occurred_at, history.event_id
       LIMIT p_limit;
  ELSIF p_dataset = 'attempt_history' THEN
    RETURN QUERY
      SELECT history.occurred_at, history.attempt_id, to_jsonb(history)
        FROM workhorse.attempt_history history
       WHERE history.occurred_at >= p_from AND history.occurred_at < p_to
         AND (p_after_id IS NULL
              OR (history.occurred_at, history.attempt_id) > (p_after_occurred_at, p_after_id))
       ORDER BY history.occurred_at, history.attempt_id
       LIMIT p_limit;
  ELSIF p_dataset = 'fast_task_outcome' THEN
    -- A fast-tier task's attempts live in its outcome row, so the row is its archived history.
    -- The close time orders the row, and the task id breaks ties.
    RETURN QUERY
      SELECT outcome.finished_at, outcome.task_id, to_jsonb(outcome)
        FROM workhorse.fast_task_outcome outcome
       WHERE outcome.finished_at >= p_from AND outcome.finished_at < p_to
         AND (p_after_id IS NULL
              OR (outcome.finished_at, outcome.task_id) > (p_after_occurred_at, p_after_id))
       ORDER BY outcome.finished_at, outcome.task_id
       LIMIT p_limit;
  ELSE
    RAISE EXCEPTION 'cold export dataset must be task_event, attempt_history or fast_task_outcome';
  END IF;
END;
$$;

-- The views add the events and attempts a fast-tier task keeps in its outcome row.
CREATE OR REPLACE FUNCTION workhorse.list_task_timeline_v1(
  p_task_id uuid,
  p_limit integer,
  p_cursor_occurred_at timestamptz,
  p_cursor_kind text,
  p_cursor_record_id uuid
) RETURNS TABLE (
  kind text,
  record_id uuid,
  task_id uuid,
  priority integer,
  occurred_at timestamptz,
  attempt integer,
  event_type text,
  details jsonb,
  fence_token bigint,
  worker_id text,
  outcome text,
  started_at timestamptz,
  claimed_at timestamptz,
  finished_at timestamptz,
  error jsonb,
  has_more boolean,
  cursor_occurred_at timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_cursor_rank integer;
BEGIN
  IF p_task_id IS NULL THEN RAISE EXCEPTION 'task_id is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'limit must be between 1 and 1000';
  END IF;
  IF (p_cursor_occurred_at IS NULL) <> (p_cursor_kind IS NULL)
     OR (p_cursor_occurred_at IS NULL) <> (p_cursor_record_id IS NULL) THEN
    RAISE EXCEPTION 'timeline cursor timestamp, kind, and record id must be provided together';
  END IF;
  IF p_cursor_occurred_at IS NOT NULL THEN
    IF NOT isfinite(p_cursor_occurred_at) THEN
      RAISE EXCEPTION 'timeline cursor timestamp must be finite';
    END IF;
    IF p_cursor_kind NOT IN ('event', 'attempt') THEN
      RAISE EXCEPTION 'timeline cursor kind must be event or attempt';
    END IF;
    v_cursor_rank := CASE p_cursor_kind WHEN 'event' THEN 1 ELSE 0 END;
  END IF;

  RETURN QUERY
  WITH merged AS MATERIALIZED (
    SELECT
      'event'::text AS kind,
      event.event_id AS record_id,
      event.task_id,
      event.occurred_at,
      event.attempt,
      event.event_type,
      event.details,
      NULL::bigint AS fence_token,
      NULL::text AS worker_id,
      NULL::text AS outcome,
      NULL::timestamptz AS started_at,
      NULL::timestamptz AS claimed_at,
      NULL::timestamptz AS finished_at,
      NULL::jsonb AS error,
      1 AS kind_rank
    FROM workhorse.dashboard_task_event_v1 event
    WHERE event.task_id = p_task_id
      AND (p_cursor_occurred_at IS NULL
        OR (event.occurred_at, 1, event.event_id)
          < (p_cursor_occurred_at, v_cursor_rank, p_cursor_record_id))
    UNION ALL
    SELECT
      'attempt'::text,
      history.attempt_id,
      history.task_id,
      history.occurred_at,
      history.attempt,
      NULL::text,
      NULL::jsonb,
      history.fence_token,
      history.worker_id,
      history.outcome,
      history.started_at,
      history.claimed_at,
      history.finished_at,
      history.error,
      0 AS kind_rank
    FROM workhorse.dashboard_attempt_history_v1 history
    WHERE history.task_id = p_task_id
      AND (p_cursor_occurred_at IS NULL
        OR (history.occurred_at, 0, history.attempt_id)
          < (p_cursor_occurred_at, v_cursor_rank, p_cursor_record_id))
    ORDER BY occurred_at DESC, kind_rank DESC, record_id DESC
    LIMIT p_limit + 1
  ), page AS MATERIALIZED (
    SELECT merged.* FROM merged
    ORDER BY merged.occurred_at DESC, merged.kind_rank DESC, merged.record_id DESC
    LIMIT p_limit
  ), page_meta AS (
    SELECT count(*) > p_limit AS has_more FROM merged
  )
  SELECT
    page.kind,
    page.record_id,
    page.task_id,
    task.priority,
    page.occurred_at,
    page.attempt,
    page.event_type,
    page.details,
    page.fence_token,
    page.worker_id,
    page.outcome,
    page.started_at,
    page.claimed_at,
    page.finished_at,
    page.error,
    page_meta.has_more,
    page.occurred_at
  FROM page
  JOIN workhorse.task task ON task.id = page.task_id
  CROSS JOIN page_meta
  ORDER BY page.occurred_at DESC, page.kind_rank DESC, page.record_id DESC;
END;
$$;

DROP FUNCTION workhorse.sync_schedule_definitions_v1(text, jsonb, boolean);
DROP FUNCTION workhorse.fire_due_schedules_v1(text[], timestamptz, integer);

DELETE FROM workhorse.protocol_version WHERE version <> 5;
INSERT INTO workhorse.protocol_version(version) VALUES (5) ON CONFLICT DO NOTHING;
