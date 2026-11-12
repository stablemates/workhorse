-- workhorse-migration: {"kind":"additive"}

-- Let an event detail read seek the task of its record (SM-2029).
--
-- dashboard_task_event_v1 and dashboard_attempt_history_v1 derive history records for a fast-tier
-- task. Each derived record has the identity md5(task_id || ':' || attempt || ':' || kind)::uuid,
-- and no index holds it. dashboard_event_detail_v1 finds a record by its identity, so each read did
-- a sequential scan of fast_task_runtime and fast_task_outcome and computed the MD5 of each row.
-- This was also true for the version 7 identity of a recorded event or attempt.
--
-- dashboard_event_detail_v1 now reads the optional input key taskId. The event feed returns the
-- task of each record, and the dashboard page sends it. With taskId, each branch of the two views
-- reads only the rows of that task through an index on task_id, and a record of another task is
-- not found. Without taskId, the read finds the record as before, so a released host, a released
-- page, and a bookmarked address keep working. An empty taskId counts as no task, as the other
-- empty input keys do. Another taskId that is not a UUID in canonical form gives no record, as an
-- invalid identity does. The output does not change. Only the body changes, so
-- the function keeps its suffix (ADR 0109). No stored data changes.

CREATE OR REPLACE FUNCTION workhorse.dashboard_event_detail_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_identity text := p_input->>'id';
  v_task_text text := NULLIF(p_input->>'taskId', '');
  v_redact boolean := COALESCE((p_input->>'redactErrorStacks')::boolean, false);
  v_kind text;
  v_record_id uuid;
  v_task_id uuid;
  v_event record;
  v_history record;
  v_result jsonb;
BEGIN
  -- A recorded event or attempt has a version 7 UUID. A record that dashboard_task_event_v1 or
  -- dashboard_attempt_history_v1 derives for a fast-tier task has an MD5 value cast to uuid, which
  -- can have any version and variant digits. Thus the check accepts any UUID in canonical form.
  IF v_identity IS NULL OR v_identity !~* '^(event|attempt):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  IF v_task_text IS NOT NULL AND v_task_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  v_kind := split_part(v_identity, ':', 1);
  v_record_id := split_part(v_identity, ':', 2)::uuid;
  v_task_id := v_task_text::uuid;

  -- No index holds a derived identity. With `taskId`, each branch of the two views reads only the
  -- rows of that task through an index on task_id, and a record of another task does not match.
  -- Without it, or with an empty value, the lookup reads each fast-tier row and computes its
  -- identity. Each statement
  -- names its own predicate, so a generic plan keeps the task_id index condition.
  IF v_kind = 'event' THEN
    IF v_task_id IS NULL THEN
      SELECT event.event_id, event.task_id, event.attempt, event.event_type, event.details,
             event.occurred_at
        INTO v_event
        FROM workhorse.dashboard_task_event_v1 event
       WHERE event.event_id = v_record_id;
    ELSE
      SELECT event.event_id, event.task_id, event.attempt, event.event_type, event.details,
             event.occurred_at
        INTO v_event
        FROM workhorse.dashboard_task_event_v1 event
       WHERE event.event_id = v_record_id AND event.task_id = v_task_id;
    END IF;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT jsonb_build_object(
      'id', 'event:' || v_event.event_id::text, 'kind', 'event',
      'recordId', v_event.event_id::text, 'taskId', v_event.task_id::text,
      'queue', task.queue_name, 'taskType', task.task_type,
      'occurredAt', workhorse.dashboard_iso_v1(v_event.occurred_at),
      'attempt', v_event.attempt, 'type', v_event.event_type,
      'details', workhorse.dashboard_details_without_stack_v1(v_event.details, v_redact),
      'workerId', COALESCE(v_event.details->>'worker_id', (
        SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
         WHERE history.task_id = v_event.task_id AND history.attempt = v_event.attempt
         ORDER BY history.occurred_at DESC, history.attempt_id DESC LIMIT 1
      )), 'fenceToken', NULL, 'startedAt', NULL, 'claimedAt', NULL,
      'finishedAt', NULL, 'durationMs', NULL, 'error', NULL, 'errorMessage', NULL)
      INTO v_result
      FROM (SELECT 1) one
      LEFT JOIN workhorse.dashboard_task_v1 task ON task.id = v_event.task_id;
  ELSE
    IF v_task_id IS NULL THEN
      SELECT history.attempt_id, history.task_id, history.attempt, history.fence_token,
             history.worker_id, history.outcome, history.started_at, history.claimed_at,
             history.finished_at, history.error, history.occurred_at
        INTO v_history
        FROM workhorse.dashboard_attempt_history_v1 history
       WHERE history.attempt_id = v_record_id;
    ELSE
      SELECT history.attempt_id, history.task_id, history.attempt, history.fence_token,
             history.worker_id, history.outcome, history.started_at, history.claimed_at,
             history.finished_at, history.error, history.occurred_at
        INTO v_history
        FROM workhorse.dashboard_attempt_history_v1 history
       WHERE history.attempt_id = v_record_id AND history.task_id = v_task_id;
    END IF;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT jsonb_build_object(
      'id', 'attempt:' || v_history.attempt_id::text, 'kind', 'attempt',
      'recordId', v_history.attempt_id::text, 'taskId', v_history.task_id::text,
      'queue', task.queue_name, 'taskType', task.task_type,
      'occurredAt', workhorse.dashboard_iso_v1(v_history.occurred_at),
      'attempt', v_history.attempt, 'type', v_history.outcome, 'details', NULL,
      'workerId', v_history.worker_id, 'fenceToken', v_history.fence_token::text,
      'startedAt', workhorse.dashboard_iso_v1(v_history.started_at),
      'claimedAt', workhorse.dashboard_iso_v1(v_history.claimed_at),
      'finishedAt', workhorse.dashboard_iso_v1(v_history.finished_at),
      'durationMs', round(extract(epoch FROM v_history.finished_at - v_history.started_at) * 1000),
      'error', workhorse.dashboard_error_without_stack_v1(v_history.error, v_redact),
      'errorMessage', v_history.error->>'message')
      INTO v_result
      FROM (SELECT 1) one
      LEFT JOIN workhorse.dashboard_task_v1 task ON task.id = v_history.task_id;
  END IF;

  RETURN v_result;
END;
$$;
