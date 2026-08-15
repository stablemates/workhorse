BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('workhorse:schema-migration', 0));

DO $migration$
DECLARE
  v_version integer;
  v_version_rows integer;
BEGIN
  SELECT count(*)::integer, min(version) INTO v_version_rows, v_version
    FROM workhorse.schema_version;
  IF v_version_rows <> 1 THEN
    RAISE EXCEPTION 'workhorse.schema_version must contain exactly one row';
  END IF;
  IF v_version NOT IN (33, 34) THEN
    RAISE EXCEPTION 'migration 0034 requires schema version 33, found %', v_version;
  END IF;
END;
$migration$;

DROP INDEX IF EXISTS workhorse.job_child_parent_one_idx;

ALTER TABLE workhorse.job_child
  ADD COLUMN IF NOT EXISTS created_as_set boolean NOT NULL DEFAULT false;

DO $migration$
BEGIN
  IF to_regprocedure('workhorse.create_single_child_v1(uuid,text,bigint,text,jsonb)') IS NULL THEN
    ALTER FUNCTION workhorse.create_child_v1(uuid, text, bigint, text, jsonb)
      RENAME TO create_single_child_v1;
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION workhorse.create_child_v1(
  p_parent_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_child_name text,
  p_request jsonb
) RETURNS TABLE (
  status text,
  child_job_id uuid,
  child_type text,
  created_at timestamptz,
  joined_at timestamptz,
  result jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workhorse.job_child edge
     WHERE edge.parent_job_id = p_parent_job_id AND edge.created_as_set
  ) THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb
    );
    RETURN;
  END IF;
  RETURN QUERY
    SELECT single.status, single.child_job_id, single.child_type, single.created_at,
           single.joined_at, single.result
      FROM workhorse.create_single_child_v1(
        p_parent_job_id, p_worker_id, p_fence_token, p_child_name, p_request
      ) single;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.create_children_v1(
  p_parent_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_children jsonb
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
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_item record;
  v_enqueue record;
  v_existing_count integer;
  v_result_limit integer;
  v_children jsonb := '[]'::jsonb;
  v_results jsonb := '{}'::jsonb;
  v_result_bytes integer := 2;
  v_now timestamptz;
  v_had_unjoined boolean;
BEGIN
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
    FROM workhorse.job_runtime runtime
    JOIN workhorse.job job ON job.id = runtime.job_id
   WHERE runtime.job_id = p_parent_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE OF runtime;
  IF FOUND THEN
    SELECT job.result_max_bytes INTO STRICT v_result_limit
      FROM workhorse.job job WHERE job.id = p_parent_job_id;
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

  PERFORM 1 FROM workhorse.job_child edge
   WHERE edge.parent_job_id = p_parent_job_id
   ORDER BY edge.child_name FOR UPDATE;
  SELECT count(*)::integer INTO v_existing_count FROM workhorse.job_child edge
   WHERE edge.parent_job_id = p_parent_job_id;

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
      LEFT JOIN workhorse.job_child edge
        ON edge.parent_job_id = p_parent_job_id AND edge.child_name = item->>'name'
      WHERE edge.child_job_id IS NULL OR edge.request_fingerprint <> item->'request'
    ) OR EXISTS (
      SELECT 1 FROM workhorse.job_child edge
       WHERE edge.parent_job_id = p_parent_job_id AND NOT edge.created_as_set
    ) THEN
      RETURN QUERY VALUES (
        'conflict'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM workhorse.job_child edge
      LEFT JOIN workhorse.job_outcome outcome ON outcome.job_id = edge.child_job_id
       WHERE edge.parent_job_id = p_parent_job_id
         AND (outcome.job_id IS NULL OR outcome.state <> 'succeeded')
    ) THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
      RETURN;
    END IF;

    SELECT jsonb_object_agg(edge.child_name, outcome.result),
           jsonb_agg(jsonb_build_object(
             'childJobId', edge.child_job_id,
             'name', edge.child_name,
             'type', job.job_type,
             'createdAt', edge.created_at,
             'joinedAt', COALESCE(edge.joined_at, v_now),
             'result', outcome.result
           ) ORDER BY input.ordinality),
           bool_or(edge.joined_at IS NULL)
      INTO v_results, v_children, v_had_unjoined
      FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
      JOIN workhorse.job_child edge
        ON edge.parent_job_id = p_parent_job_id AND edge.child_name = input.item->>'name'
      JOIN workhorse.job job ON job.id = edge.child_job_id
      JOIN workhorse.job_outcome outcome ON outcome.job_id = edge.child_job_id;
    v_result_bytes := octet_length(v_results::text);
    IF v_result_bytes > v_result_limit THEN
      RETURN QUERY VALUES (
        'result_too_large'::text, NULL::jsonb, NULL::jsonb, v_result_bytes, v_result_limit
      );
      RETURN;
    END IF;
    IF v_had_unjoined THEN
      UPDATE workhorse.job_child edge SET joined_at = v_now
       WHERE edge.parent_job_id = p_parent_job_id AND edge.joined_at IS NULL;
      INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
        VALUES (
          p_parent_job_id, v_runtime.current_attempt, 'children_joined',
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

  BEGIN
    FOR v_item IN
      SELECT item, ordinality::integer AS ordinal
        FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
       ORDER BY ordinality
    LOOP
      SELECT * INTO v_enqueue
        FROM workhorse.enqueue_many_v2(jsonb_build_array(v_item.item->'request'));
      IF v_enqueue.outcome <> 'accepted' THEN
        RAISE EXCEPTION 'child enqueue must create one new job';
      END IF;
      INSERT INTO workhorse.job_child(
        parent_job_id, child_job_id, child_name, request_fingerprint, created_at, created_as_set
      ) VALUES (
        p_parent_job_id, v_enqueue.job_id, v_item.item->>'name', v_item.item->'request', v_now, true
      );
      INSERT INTO workhorse.job_dependency(
        dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation, created_at
      ) VALUES (
        p_parent_job_id, v_enqueue.job_id, 'release', 'fail', 'cancel', v_now
      );
      INSERT INTO workhorse.job_event(job_id, event_type, details)
        VALUES (
          v_enqueue.job_id, 'parent_linked',
          jsonb_build_object('parent_job_id', p_parent_job_id, 'name', v_item.item->>'name')
        );
    END LOOP;

    UPDATE workhorse.job_runtime runtime
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
     WHERE runtime.job_id = p_parent_job_id
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
             'childJobId', edge.child_job_id,
             'name', edge.child_name,
             'type', job.job_type,
             'createdAt', edge.created_at,
             'joinedAt', edge.joined_at
           ) ORDER BY input.ordinality)
      INTO v_children
      FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
      JOIN workhorse.job_child edge
        ON edge.parent_job_id = p_parent_job_id AND edge.child_name = input.item->>'name'
      JOIN workhorse.job job ON job.id = edge.child_job_id;
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_parent_job_id, v_runtime.current_attempt, 'children_created',
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

CREATE OR REPLACE FUNCTION workhorse.resolve_dependents_v1(
  p_prerequisite_job_id uuid, p_prerequisite_state text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_dependency workhorse.job_dependency%ROWTYPE;
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_count integer := 0;
  v_action text;
  v_final_action text;
  v_final_prerequisite_job_id uuid;
  v_final_prerequisite_state text;
  v_error jsonb;
BEGIN
  IF p_prerequisite_state NOT IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'prerequisite state must be succeeded, failed, or canceled';
  END IF;
  FOR v_dependency IN
    SELECT dependency.* FROM workhorse.job_dependency dependency
     WHERE dependency.prerequisite_job_id = p_prerequisite_job_id
       AND dependency.released_at IS NULL
     ORDER BY dependency.dependent_job_id FOR UPDATE
  LOOP
    SELECT * INTO v_runtime FROM workhorse.job_runtime runtime
     WHERE runtime.job_id = v_dependency.dependent_job_id FOR UPDATE;
    IF NOT FOUND OR v_runtime.state <> 'blocked' THEN CONTINUE; END IF;
    v_action := CASE p_prerequisite_state
      WHEN 'succeeded' THEN v_dependency.on_success
      WHEN 'failed' THEN v_dependency.on_failure
      WHEN 'canceled' THEN v_dependency.on_cancellation
    END;
    UPDATE workhorse.job_dependency dependency
       SET released_at = v_now, resolution = v_action
     WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
       AND dependency.prerequisite_job_id = p_prerequisite_job_id
       AND dependency.released_at IS NULL;
    IF EXISTS (
      SELECT 1 FROM workhorse.job_dependency dependency
       WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
         AND dependency.released_at IS NULL
    ) THEN CONTINUE; END IF;
    SELECT dependency.resolution, dependency.prerequisite_job_id, outcome.state
      INTO STRICT v_final_action, v_final_prerequisite_job_id, v_final_prerequisite_state
      FROM workhorse.job_dependency dependency
      JOIN workhorse.job_outcome outcome ON outcome.job_id = dependency.prerequisite_job_id
     WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
     ORDER BY CASE dependency.resolution WHEN 'fail' THEN 0 WHEN 'cancel' THEN 1 ELSE 2 END,
              dependency.prerequisite_job_id
     LIMIT 1;
    IF v_final_action IN ('fail', 'cancel') THEN
      v_error := jsonb_build_object(
        'name', CASE WHEN v_final_action = 'fail' THEN 'DependencyFailed' ELSE 'DependencyCanceled' END,
        'message', CASE WHEN v_final_action = 'fail'
          THEN 'a prerequisite reached a terminal outcome rejected by dependency policy'
          ELSE 'a prerequisite reached a terminal outcome that canceled its dependent' END,
        'prerequisite_job_id', v_final_prerequisite_job_id,
        'prerequisite_state', v_final_prerequisite_state,
        'policy_action', v_final_action
      );
      DELETE FROM workhorse.job_runtime runtime
       WHERE runtime.job_id = v_dependency.dependent_job_id AND runtime.state = 'blocked';
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.job_outcome(
        job_id, state, current_attempt, fence_token, run_at, error, finished_at, updated_at
      ) VALUES (
        v_dependency.dependent_job_id,
        CASE WHEN v_final_action = 'fail' THEN 'failed' ELSE 'canceled' END,
        v_runtime.current_attempt, 0, v_runtime.run_at, v_error, v_now, v_now
      );
      INSERT INTO workhorse.job_event(job_id, event_type, details)
        VALUES (
          v_dependency.dependent_job_id,
          CASE WHEN v_final_action = 'fail' THEN 'dependency_failed' ELSE 'dependency_canceled' END,
          v_error
        );
      v_count := v_count + 1;
      CONTINUE;
    END IF;
    UPDATE workhorse.job_runtime runtime
       SET state = CASE WHEN runtime.run_at <= v_now THEN 'ready' ELSE 'scheduled' END,
           ready_at = CASE WHEN runtime.run_at <= v_now THEN v_now END,
           sequence = CASE WHEN runtime.run_at <= v_now
             THEN nextval('workhorse.ready_sequence_seq') END,
           updated_at = v_now
     WHERE runtime.job_id = v_dependency.dependent_job_id AND runtime.state = 'blocked'
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN CONTINUE; END IF;

    INSERT INTO workhorse.job_event(job_id, event_type, details)
      VALUES (v_runtime.job_id, 'dependency_released', jsonb_build_object(
        'prerequisite_job_id', p_prerequisite_job_id, 'state', v_runtime.state,
        'reason', 'prerequisite_succeeded'
      ));
    v_count := v_count + 1;
    IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now THEN
      PERFORM workhorse.terminalize_deadline_v1(v_runtime.job_id);
    ELSIF v_runtime.state = 'ready' THEN
      PERFORM pg_notify('workhorse_jobs', v_runtime.queue_name);
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

INSERT INTO workhorse.schema_migration(version, description)
VALUES (34, 'add bounded child fan-out and joins')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

DELETE FROM workhorse.schema_version WHERE version = 33;
INSERT INTO workhorse.schema_version(version) VALUES (34) ON CONFLICT DO NOTHING;

COMMIT;
