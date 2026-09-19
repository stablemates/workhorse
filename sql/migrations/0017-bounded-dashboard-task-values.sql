-- workhorse-migration: {"kind":"additive"}

-- Bounded dashboard task values, schema 17 (SM-798).
--
-- Task detail inlined the whole payload and the whole result while a checkpoint value larger than
-- the inline bound was already reported by size alone. A megabyte payload therefore crossed the
-- wire every time an operator opened the task. The detail document now applies the same bound to
-- both, reporting `payloadBytes` and `payloadOmitted` beside the payload and `resultBytes` and
-- `resultOmitted` beside the outcome result.
--
-- `dashboard_task_value_v1` serves one withheld value on demand, beside
-- `dashboard_checkpoint_value_v1`. It reads a result through `dashboard_task_result_v1`, so the
-- redaction task detail applies holds for it too.

CREATE OR REPLACE FUNCTION workhorse.dashboard_task_detail_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  WITH parameters AS (
    SELECT (p_input->>'id')::uuid AS task_id,
           COALESCE((p_input->>'canSignal')::boolean, false) AS can_signal
  ), task AS (
    SELECT j.id, j.queue_name AS queue, j.task_type AS type, j.priority, j.payload,
           j.max_attempts, j.retry_policy, j.deadline_at, j.execution_timeout_ms,
           j.concurrency_key, j.created_at, j.tags,
           runtime.state AS runtime_state, runtime.current_attempt AS runtime_attempt,
           runtime.run_at, runtime.ready_at, runtime.worker_id,
           runtime.fence_token::text AS fence_token, runtime.acquired_at,
           runtime.heartbeat_at, runtime.expires_at, runtime.wait_name,
           runtime.attempt_started_at, runtime.attempt_timeout_at,
           runtime.cancel_requested_at, runtime.cancel_requested_by, runtime.cancel_reason,
           runtime.error AS runtime_error,
           outcome.state AS outcome_state, outcome.current_attempt AS outcome_attempt,
           outcome.finished_at, workhorse.dashboard_task_result_v1(j.id) AS result,
           outcome.error AS outcome_error,
           progress.progress_value, progress.revision::text AS progress_revision,
           progress.attempt AS progress_attempt,
           progress.fence_token::text AS progress_fence_token,
           progress.worker_id AS progress_worker_id,
           progress.created_at AS progress_created_at,
           progress.updated_at AS progress_updated_at,
           signal_wait.deadline_at AS signal_wait_deadline_at
      FROM parameters
      JOIN workhorse.dashboard_task_v1 j ON j.id = parameters.task_id
      LEFT JOIN workhorse.dashboard_task_runtime_v1 runtime ON runtime.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_outcome_v1 outcome ON outcome.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_progress_v1 progress ON progress.task_id = j.id
      LEFT JOIN workhorse.dashboard_signal_wait_v1 signal_wait
        ON signal_wait.task_id = j.id AND signal_wait.signal_name = runtime.wait_name
  ), task_values AS (
    -- The payload and the result are measured once here, because both the outcome and the document
    -- below decide on the same two sizes and re-measuring a megabyte twice is the cost this bound
    -- exists to avoid. A task with neither measures zero, which reads as present and empty.
    SELECT COALESCE(octet_length(task.payload::text), 0) AS payload_bytes,
           COALESCE(octet_length(task.result::text), 0) AS result_bytes,
           workhorse.dashboard_inline_value_bytes_v1() AS inline_bytes
      FROM task
  ), identity AS (
    SELECT jsonb_build_object(
      'id', task.id::text, 'queue', task.queue, 'type', task.type, 'priority', task.priority,
      'state', COALESCE(task.outcome_state, task.runtime_state, 'unknown'),
      'createdAt', workhorse.dashboard_iso_v1(task.created_at),
      'retryPolicy', task.retry_policy, 'maxAttempts', task.max_attempts,
      'deadlineAt', workhorse.dashboard_iso_v1(task.deadline_at),
      'executionTimeoutMs', task.execution_timeout_ms,
      'concurrencyKey', task.concurrency_key,
      'prerequisiteTaskId', CASE WHEN count(dependency.*) = 1
        THEN (array_agg(dependency.prerequisite_task_id))[1]::text END,
      'prerequisiteTaskIds', COALESCE(jsonb_agg(dependency.prerequisite_task_id::text
        ORDER BY dependency.prerequisite_task_id)
        FILTER (WHERE dependency.prerequisite_task_id IS NOT NULL), '[]'::jsonb),
      'dependencyPolicy', CASE WHEN count(dependency.*) > 0 THEN jsonb_build_object(
        'onSuccess', min(dependency.on_success),
        'onFailure', min(dependency.on_failure),
        'onCancellation', min(dependency.on_cancellation)) END,
      'dependencyReleasedAt', CASE WHEN bool_and(dependency.released_at IS NOT NULL)
        THEN workhorse.dashboard_iso_v1(max(dependency.released_at)) END,
      'blockedReason', CASE WHEN task.runtime_state = 'blocked' AND count(dependency.*) > 0
        THEN 'prerequisite_pending' END
    ) AS value
      FROM task
      LEFT JOIN workhorse.dashboard_task_dependency_v1 dependency
        ON dependency.dependent_task_id = task.id
     GROUP BY task.id, task.queue, task.type, task.priority, task.outcome_state, task.runtime_state,
              task.created_at, task.retry_policy, task.max_attempts, task.deadline_at,
              task.execution_timeout_ms, task.concurrency_key
  ), dependency_lineage AS (
    SELECT jsonb_build_object(
      'records', COALESCE(jsonb_agg(jsonb_build_object(
        'dependentTaskId', dependent_task_id::text,
        'prerequisiteTaskId', prerequisite_task_id::text,
        'onSuccess', on_success, 'onFailure', on_failure,
        'onCancellation', on_cancellation,
        'createdAt', workhorse.dashboard_iso_v1(created_at),
        'releasedAt', workhorse.dashboard_iso_v1(released_at), 'resolution', resolution
      ) ORDER BY dependent_task_id, prerequisite_task_id) FILTER (WHERE ordinal <= 100),
        '[]'::jsonb),
      'truncated', count(*) > 100
    ) AS value
      FROM (
        SELECT dependency.*, row_number() OVER (
          ORDER BY dependent_task_id, prerequisite_task_id) AS ordinal
          FROM parameters
          JOIN workhorse.dashboard_task_dependency_v1 dependency
            ON dependency.dependent_task_id = parameters.task_id
            OR dependency.prerequisite_task_id = parameters.task_id
         ORDER BY dependent_task_id, prerequisite_task_id LIMIT 101
      ) bounded
  ), child_lineage AS (
    SELECT jsonb_build_object(
      'records', COALESCE(jsonb_agg(jsonb_build_object(
        'parentTaskId', parent_task_id::text, 'childTaskId', child_task_id::text,
        'name', child_name, 'type', child_type,
        'createdAt', workhorse.dashboard_iso_v1(created_at),
        'joinedAt', workhorse.dashboard_iso_v1(joined_at),
        'outcomeState', outcome_state, 'error', outcome_error
      ) ORDER BY created_at, parent_task_id, child_task_id) FILTER (WHERE ordinal <= 101),
        '[]'::jsonb),
      'truncated', count(*) > 101
    ) AS value
      FROM (
        SELECT edge.*, child.task_type AS child_type, outcome.state AS outcome_state,
               outcome.error AS outcome_error,
               row_number() OVER (ORDER BY edge.created_at, edge.parent_task_id,
                                            edge.child_task_id) AS ordinal
          FROM parameters
          JOIN workhorse.dashboard_task_child_v1 edge
            ON edge.parent_task_id = parameters.task_id OR edge.child_task_id = parameters.task_id
          JOIN workhorse.dashboard_task_v1 child ON child.id = edge.child_task_id
          LEFT JOIN workhorse.dashboard_task_outcome_v1 outcome ON outcome.task_id = edge.child_task_id
         ORDER BY edge.created_at, edge.parent_task_id, edge.child_task_id LIMIT 102
      ) bounded
  ), redrive_lineage AS (
    SELECT jsonb_build_object(
      'records', COALESCE(jsonb_agg(jsonb_build_object(
        'sourceTaskId', source_task_id::text, 'targetTaskId', target_task_id::text,
        'requestedBy', requested_by, 'reason', reason,
        'requestIdPreview', request_id_preview, 'requestIdDigest', request_id_digest,
        'requestIdLength', request_id_length, 'sourceState', source_state,
        'targetInitialState', target_initial_state,
        'requestedAt', workhorse.dashboard_iso_v1(requested_at)
      ) ORDER BY ordinal) FILTER (WHERE ordinal <= 100), '[]'::jsonb),
      'truncated', count(*) > 100
    ) AS value
      FROM (
        SELECT lineage.*
          FROM parameters
          CROSS JOIN LATERAL workhorse.redrive_lineage_v1(parameters.task_id, 101)
            WITH ORDINALITY AS lineage(
              source_task_id, target_task_id, requested_by, reason, request_id_preview,
              request_id_digest, request_id_length, source_state, target_initial_state,
              requested_at, ordinal
            )
      ) bounded
  ), concurrency_policy AS (
    SELECT CASE WHEN policy.queue_name IS NULL THEN NULL ELSE jsonb_build_object(
      'namespace', policy.namespace, 'maxActive', policy.max_active,
      'utilizationKnown', measured.value IS NOT NULL,
      'active', COALESCE((measured.value->>'active')::integer, 0),
      'available', COALESCE(GREATEST(0, policy.max_active -
        (measured.value->>'active')::integer), 0),
      'blockedReady', COALESCE((measured.value->>'blocked_ready')::integer, 0),
      'maxActivePerKey', policy.max_active_per_key,
      'saturatedKeys', COALESCE((measured.value->>'saturated_keys')::integer, 0),
      'highestKeyActive', COALESCE((measured.value->>'highest_key_active')::integer, 0)
    ) END AS value
      FROM task
      LEFT JOIN workhorse.dashboard_concurrency_policy_v1 policy
        ON policy.queue_name = task.queue
      LEFT JOIN LATERAL (
        SELECT item AS value
          FROM jsonb_array_elements(CASE WHEN task.runtime_state IS NULL THEN '[]'::jsonb
            ELSE COALESCE(p_input->'health', workhorse.queue_health_v1())->'concurrency_policies'
            END) item
         WHERE item->>'queue_name' = task.queue
      ) measured ON true
  ), signal_wait AS (
    SELECT CASE WHEN wait_name IS NOT NULL AND signal_wait_deadline_at IS NOT NULL
      THEN jsonb_build_object('name', wait_name, 'deadlineAt',
        workhorse.dashboard_iso_v1(signal_wait_deadline_at)) END AS value FROM task
  ), progress AS (
    SELECT CASE WHEN progress_revision IS NOT NULL THEN jsonb_build_object(
      'value', progress_value, 'revision', progress_revision, 'attempt', progress_attempt,
      'fenceToken', progress_fence_token, 'workerId', progress_worker_id,
      'createdAt', workhorse.dashboard_iso_v1(progress_created_at),
      'updatedAt', workhorse.dashboard_iso_v1(progress_updated_at)) END AS value FROM task
  ), current_state AS (
    SELECT jsonb_build_object(
      'runtime', CASE WHEN runtime_state IS NOT NULL THEN jsonb_build_object(
        'state', runtime_state, 'attempt', runtime_attempt,
        'runAt', workhorse.dashboard_iso_v1(run_at),
        'readyAt', workhorse.dashboard_iso_v1(ready_at), 'workerId', worker_id,
        'fenceToken', fence_token, 'acquiredAt', workhorse.dashboard_iso_v1(acquired_at),
        'heartbeatAt', workhorse.dashboard_iso_v1(heartbeat_at),
        'expiresAt', workhorse.dashboard_iso_v1(expires_at), 'waitName', wait_name,
        'attemptStartedAt', workhorse.dashboard_iso_v1(attempt_started_at),
        'attemptTimeoutAt', workhorse.dashboard_iso_v1(attempt_timeout_at),
        'cancellation', CASE WHEN cancel_requested_at IS NOT NULL THEN jsonb_build_object(
          'requestedAt', workhorse.dashboard_iso_v1(cancel_requested_at),
          'requestedBy', NULLIF(cancel_requested_by, ''),
          'reason', NULLIF(cancel_reason, '')) END,
        'error', runtime_error) END,
      'outcome', CASE WHEN outcome_state IS NOT NULL THEN jsonb_build_object(
        'state', outcome_state, 'attempt', outcome_attempt,
        'finishedAt', workhorse.dashboard_iso_v1(finished_at),
        -- A result larger than the inline bound is reported by size alone, exactly as a checkpoint
        -- value is. `dashboard_task_value_v1` returns the one an operator opens.
        'result', CASE WHEN task_values.result_bytes <= task_values.inline_bytes THEN result END,
        'resultBytes', task_values.result_bytes,
        'resultOmitted', task_values.result_bytes > task_values.inline_bytes,
        'error', outcome_error) END,
      -- The result appears under the outcome alone. A result exists only once a task finishes, so
      -- a second copy beside it doubled what a megabyte result costs to open and named no new fact.
      'error', COALESCE(outcome_error, runtime_error)
    ) AS value FROM task CROSS JOIN task_values
  ), batch_executions AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', batch_id, 'attempt', selected_attempt,
      'dispatchedAt', workhorse.dashboard_iso_v1(dispatched_at),
      'batchWideFailure', batch_wide_failure, 'members', members
    ) ORDER BY dispatched_at, batch_id), '[]'::jsonb) AS value
      FROM (
        SELECT batch_id, selected_attempt, dispatched_at, batch_wide_failure,
               jsonb_agg(jsonb_build_object(
                 'id', member_task_id, 'type', task_type, 'attempt', attempt,
                 'outcome', outcome, 'error', error) ORDER BY ordinal) AS members
          FROM (
            SELECT dispatch.details->>'batch_id' AS batch_id,
                   dispatch.attempt AS selected_attempt,
                   dispatch.occurred_at AS dispatched_at,
                   EXISTS (
                     SELECT 1 FROM workhorse.dashboard_task_event_v1 failure
                      WHERE failure.task_id = dispatch.task_id
                        AND failure.attempt = dispatch.attempt
                        AND failure.event_type = 'batch_failed'
                        AND failure.details->>'batch_id' = dispatch.details->>'batch_id'
                   ) AS batch_wide_failure,
                   member.ordinal, member.value->>'task_id' AS member_task_id,
                   COALESCE(member_task.task_type, selected_task.task_type) AS task_type,
                   (member.value->>'attempt')::integer AS attempt,
                   history.outcome, history.error
              FROM parameters
              JOIN workhorse.dashboard_task_event_v1 dispatch
                ON dispatch.task_id = parameters.task_id AND dispatch.event_type = 'batch_dispatched'
              CROSS JOIN LATERAL jsonb_array_elements(dispatch.details->'members')
                WITH ORDINALITY AS member(value, ordinal)
              JOIN workhorse.dashboard_task_v1 selected_task ON selected_task.id = dispatch.task_id
              LEFT JOIN workhorse.dashboard_task_v1 member_task
                ON member_task.id = (member.value->>'task_id')::uuid
              LEFT JOIN workhorse.dashboard_attempt_history_v1 history
                ON history.task_id = (member.value->>'task_id')::uuid
               AND history.attempt = (member.value->>'attempt')::integer
          ) batch_rows
         GROUP BY batch_id, selected_attempt, dispatched_at, batch_wide_failure
      ) executions
  -- Each history section keeps its most recent rows and reports that it was cut. A task that
  -- retried for days would otherwise put its whole recorded life into one drawer, and the event
  -- feed filtered by this task identity is where the rest of it stays readable.
  ), attempts AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'attempt', attempt, 'workerId', worker_id, 'outcome', outcome,
      'startedAt', workhorse.dashboard_iso_v1(started_at),
      'claimedAt', workhorse.dashboard_iso_v1(claimed_at),
      'finishedAt', workhorse.dashboard_iso_v1(finished_at),
      'durationMs', extract(epoch FROM finished_at - claimed_at) * 1000,
      'executionMs', extract(epoch FROM finished_at - claimed_at) * 1000,
      'elapsedMs', extract(epoch FROM finished_at - started_at) * 1000,
      'error', error) ORDER BY attempt, attempt_id)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_detail_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_detail_limit_v1() AS truncated
      FROM (
        SELECT recent.*, row_number() OVER (ORDER BY recent.attempt DESC, recent.attempt_id DESC)
                 AS ordinal
          FROM (
            SELECT history.* FROM parameters
              JOIN workhorse.dashboard_attempt_history_v1 history
                ON history.task_id = parameters.task_id
             ORDER BY history.attempt DESC, history.attempt_id DESC
             LIMIT workhorse.dashboard_task_detail_limit_v1() + 1
          ) recent
      ) bounded
  ), checkpoints AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', checkpoint_name,
      'value', CASE WHEN value_bytes <= workhorse.dashboard_inline_value_bytes_v1()
                    THEN checkpoint_value END,
      'valueBytes', value_bytes,
      'valueOmitted', value_bytes > workhorse.dashboard_inline_value_bytes_v1(),
      'attempt', attempt,
      'fenceToken', fence_token::text, 'workerId', worker_id,
      'createdAt', workhorse.dashboard_iso_v1(created_at)
    ) ORDER BY created_at, checkpoint_name)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_detail_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_detail_limit_v1() AS truncated
      FROM (
        SELECT recent.*,
               row_number() OVER (ORDER BY recent.created_at DESC, recent.checkpoint_name DESC)
                 AS ordinal
          FROM (
            SELECT checkpoint.*,
                   octet_length(checkpoint.checkpoint_value::text) AS value_bytes
              FROM parameters
              JOIN workhorse.dashboard_task_checkpoint_v1 checkpoint
                ON checkpoint.task_id = parameters.task_id
             ORDER BY checkpoint.created_at DESC, checkpoint.checkpoint_name DESC
             LIMIT workhorse.dashboard_task_detail_limit_v1() + 1
          ) recent
      ) bounded
  ), waits AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', wait_name, 'mode', mode, 'durationMs', duration_ms,
      'requestedWakeAt', workhorse.dashboard_iso_v1(requested_wake_at),
      'wakeAt', workhorse.dashboard_iso_v1(wake_at), 'attempt', attempt,
      'fenceToken', fence_token::text, 'workerId', worker_id,
      'createdAt', workhorse.dashboard_iso_v1(created_at)
    ) ORDER BY created_at, wait_name)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_detail_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_detail_limit_v1() AS truncated
      FROM (
        SELECT recent.*,
               row_number() OVER (ORDER BY recent.created_at DESC, recent.wait_name DESC) AS ordinal
          FROM (
            SELECT wait_record.* FROM parameters
              JOIN workhorse.dashboard_task_wait_v1 wait_record
                ON wait_record.task_id = parameters.task_id
             ORDER BY wait_record.created_at DESC, wait_record.wait_name DESC
             LIMIT workhorse.dashboard_task_detail_limit_v1() + 1
          ) recent
      ) bounded
  ), events AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', event_id::text, 'attempt', attempt, 'type', event_type,
      'details', details, 'occurredAt', workhorse.dashboard_iso_v1(occurred_at)
    ) ORDER BY occurred_at, event_id)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_event_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_event_limit_v1() AS truncated
      FROM (
        SELECT recent.*,
               row_number() OVER (ORDER BY recent.occurred_at DESC, recent.event_id DESC) AS ordinal
          FROM (
            SELECT event_record.* FROM parameters
              JOIN workhorse.dashboard_task_event_v1 event_record
                ON event_record.task_id = parameters.task_id
             ORDER BY event_record.occurred_at DESC, event_record.event_id DESC
             LIMIT workhorse.dashboard_task_event_limit_v1() + 1
          ) recent
      ) bounded
  )
  SELECT jsonb_build_object(
    'tags', task.tags,
    'canCompleteHumanWait', COALESCE((p_input->>'canCompleteHumanWait')::boolean, false),
    'humanWait', (SELECT jsonb_build_object(
      'name', wait.token_name, 'context', wait.context,
      'deadlineAt', workhorse.dashboard_iso_v1(wait.deadline_at))
      FROM workhorse.dashboard_human_wait_v1 wait WHERE wait.task_id = task.id),
    'identity', identity.value,
    'dependencyLineage', dependency_lineage.value,
    'childLineage', child_lineage.value,
    'redriveLineage', redrive_lineage.value,
    'concurrencyPolicy', concurrency_policy.value,
    'signalWait', signal_wait.value,
    'canSignal', parameters.can_signal,
    'payload', CASE WHEN task_values.payload_bytes <= task_values.inline_bytes
                    THEN task.payload END,
    'payloadBytes', task_values.payload_bytes,
    'payloadOmitted', task_values.payload_bytes > task_values.inline_bytes,
    'progress', progress.value,
    'durability', NULL,
    'current', current_state.value,
    'batchExecutions', batch_executions.value,
    'attempts', attempts.value,
    'checkpoints', checkpoints.value,
    'waits', waits.value,
    'events', events.value,
    'truncated', jsonb_build_object(
      'attempts', attempts.truncated, 'checkpoints', checkpoints.truncated,
      'waits', waits.truncated, 'events', events.truncated)
  )
    FROM parameters
    JOIN task ON true
    JOIN task_values ON true
    JOIN identity ON true
    JOIN dependency_lineage ON true
    JOIN child_lineage ON true
    JOIN redrive_lineage ON true
    JOIN concurrency_policy ON true
    JOIN signal_wait ON true
    JOIN progress ON true
    JOIN current_state ON true
    JOIN batch_executions ON true
    JOIN attempts ON true
    JOIN checkpoints ON true
    JOIN waits ON true
    JOIN events ON true;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_task_value_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'id', task.id::text,
    'kind', p_input->>'kind',
    'value', stored.value,
    'valueBytes', COALESCE(octet_length(stored.value::text), 0))
    FROM workhorse.dashboard_task_v1 task
    CROSS JOIN LATERAL (
      SELECT CASE WHEN p_input->>'kind' = 'payload' THEN task.payload
                  ELSE workhorse.dashboard_task_result_v1(task.id) END AS value
    ) stored
   WHERE task.id = (p_input->>'id')::uuid
     AND p_input->>'kind' IN ('payload', 'result');
$$;
