-- workhorse-migration: {"kind":"additive"}

-- HINT carries the diagnostic details (SM-1638, ADR 0107).

-- Workhorse sends the structured fields of SQLSTATE P1001 to P1010 as a JSON object in DETAIL.
-- Npgsql, the .NET driver, hides DETAIL unless the connection string sets Include Error Detail.
-- That setting also shows the row values of every other DETAIL on the data source, so a .NET
-- caller with the default settings got none of the fields.
--
-- Each raise and re-raise of P1001 to P1010 now also sets HINT to the same JSON text as DETAIL.
-- Npgsql does not hide HINT. DETAIL does not change and stays the authoritative field, so a client
-- that reads DETAIL keeps its behavior. The functions build the JSON text once, in v_diagnostic,
-- so the two fields cannot differ.
--
-- The signatures, the messages, and the outcomes do not change. No change touches stored data.


CREATE OR REPLACE FUNCTION workhorse.reject_self_task_dependency_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_diagnostic text;
BEGIN
  IF NEW.dependent_task_id = NEW.prerequisite_task_id THEN
    v_diagnostic := jsonb_build_object(
      'dependentTaskId', NEW.dependent_task_id,
      'prerequisiteTaskId', NEW.prerequisite_task_id,
      'cycleTaskIds', jsonb_build_array(NEW.dependent_task_id, NEW.prerequisite_task_id),
      'truncated', false
    )::text;
    RAISE EXCEPTION USING
      ERRCODE = 'P1003',
      MESSAGE = 'dependency cycle rejected',
      DETAIL = v_diagnostic,
      HINT = v_diagnostic;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.validate_task_dependencies_v1()
RETURNS trigger
LANGUAGE plpgsql
-- The recursive walks' row estimates overshoot jit_above_cost, and JIT compilation then costs more
-- than the walk. Each walk is an index probe per frontier row, so one generic plan serves every
-- firing.
SET jit = off
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_diagnostic text;
  v_component_task_id text;
  v_cycle uuid[];
  v_fan_out_root uuid;
  v_limit_task_id uuid;
  v_sinks boolean;
  v_exact_fan_out boolean := true;
  v_prerequisites uuid[];
  v_cone uuid[];
  v_walk uuid[];
BEGIN
  -- Any concurrent edge insert that touches one of these tasks takes the same lock, so the checks
  -- below see every committed edge that names an endpoint. Key-share locks, which enqueue and
  -- foreign key checks take, do not conflict with this lock.
  PERFORM 1 FROM workhorse.task task
   WHERE task.id IN (
     SELECT inserted.dependent_task_id FROM inserted_dependencies inserted
     UNION
     SELECT inserted.prerequisite_task_id FROM inserted_dependencies inserted
   )
   ORDER BY task.id FOR NO KEY UPDATE;
  -- A cycle through a new edge needs a path from its prerequisite back to its dependent, and the
  -- last edge of that path names the dependent as a prerequisite. Enqueue always inserts such
  -- sinks, because every dependent it inserts is new.
  v_sinks := NOT EXISTS (
    SELECT 1 FROM workhorse.task_dependency dependency
     WHERE dependency.prerequisite_task_id IN (
       SELECT inserted.dependent_task_id FROM inserted_dependencies inserted
     )
  );
  IF NOT v_sinks THEN
    -- Lock every task in each pre-existing component touched by this statement in canonical order.
    -- Transactions which mutate disconnected components proceed independently. Mutations which
    -- overlap a component share a lock even when a concurrent commit has just merged its root.
    FOR v_component_task_id IN
      WITH RECURSIVE inserted_tasks(task_id) AS (
        SELECT inserted.dependent_task_id FROM inserted_dependencies inserted
        UNION
        SELECT inserted.prerequisite_task_id FROM inserted_dependencies inserted
      ), component(seed_task_id, task_id) AS (
        SELECT inserted_tasks.task_id, inserted_tasks.task_id FROM inserted_tasks
        UNION
        SELECT component.seed_task_id, neighbor.task_id
          FROM component
          CROSS JOIN LATERAL (
            SELECT dependency.prerequisite_task_id AS task_id
              FROM workhorse.task_dependency dependency
             WHERE dependency.dependent_task_id = component.task_id
               AND NOT EXISTS (
                 SELECT 1 FROM inserted_dependencies inserted
                  WHERE inserted.dependent_task_id = dependency.dependent_task_id
                    AND inserted.prerequisite_task_id = dependency.prerequisite_task_id
               )
            UNION
            SELECT dependency.dependent_task_id
              FROM workhorse.task_dependency dependency
             WHERE dependency.prerequisite_task_id = component.task_id
               AND NOT EXISTS (
                 SELECT 1 FROM inserted_dependencies inserted
                  WHERE inserted.dependent_task_id = dependency.dependent_task_id
                    AND inserted.prerequisite_task_id = dependency.prerequisite_task_id
               )
          ) neighbor
      )
      SELECT DISTINCT component.task_id::text
        FROM component
       ORDER BY component.task_id::text
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'workhorse:task-dependency-component-task:' || v_component_task_id,
        0
      ));
    END LOOP;

    WITH RECURSIVE reachable(dependent_task_id, task_id, path) AS (
      SELECT inserted.dependent_task_id,
             inserted.prerequisite_task_id,
             ARRAY[inserted.dependent_task_id, inserted.prerequisite_task_id]
        FROM inserted_dependencies inserted
      UNION ALL
      SELECT reachable.dependent_task_id,
             edge.prerequisite_task_id,
             reachable.path || edge.prerequisite_task_id
        FROM reachable
        JOIN workhorse.task_dependency edge ON edge.dependent_task_id = reachable.task_id
       WHERE (
         edge.prerequisite_task_id = reachable.dependent_task_id
         OR NOT edge.prerequisite_task_id = ANY(reachable.path)
       )
         AND reachable.task_id <> reachable.dependent_task_id
    )
    SELECT reachable.path INTO v_cycle
      FROM reachable
     WHERE reachable.task_id = reachable.dependent_task_id
     ORDER BY cardinality(reachable.path)
     LIMIT 1;
    IF v_cycle IS NOT NULL THEN
      v_diagnostic := jsonb_build_object(
        'dependentTaskId', v_cycle[1],
        'prerequisiteTaskId', v_cycle[2],
        'cycleTaskIds', to_jsonb(v_cycle[1:101]),
        'truncated', cardinality(v_cycle) > 101
      )::text;
      RAISE EXCEPTION USING
        ERRCODE = 'P1003',
        MESSAGE = 'dependency cycle rejected',
        DETAIL = v_diagnostic,
        HINT = v_diagnostic;
    END IF;
  END IF;
  SELECT dependency.dependent_task_id INTO v_limit_task_id
      FROM workhorse.task_dependency dependency
      JOIN (
        SELECT DISTINCT inserted.dependent_task_id FROM inserted_dependencies inserted
         WHERE inserted.released_at IS NULL
      ) touched USING (dependent_task_id)
     WHERE dependency.released_at IS NULL
     GROUP BY dependency.dependent_task_id
    HAVING count(*) > 100
     ORDER BY dependency.dependent_task_id
     LIMIT 1;
  IF v_limit_task_id IS NOT NULL THEN
    v_diagnostic := jsonb_build_object(
      'taskId', v_limit_task_id,
      'limit', 'prerequisites',
      'max', 100
    )::text;
    RAISE EXCEPTION USING
      ERRCODE = 'P1005',
      MESSAGE = 'a task accepts at most 100 prerequisite dependencies',
      DETAIL = v_diagnostic,
      HINT = v_diagnostic;
  END IF;
  SELECT dependency.prerequisite_task_id INTO v_limit_task_id
      FROM workhorse.task_dependency dependency
      JOIN (
        SELECT DISTINCT inserted.prerequisite_task_id FROM inserted_dependencies inserted
      ) touched USING (prerequisite_task_id)
     GROUP BY dependency.prerequisite_task_id
    HAVING count(*) > 100
     ORDER BY dependency.prerequisite_task_id
     LIMIT 1;
  IF v_limit_task_id IS NOT NULL THEN
    v_diagnostic := jsonb_build_object(
      'taskId', v_limit_task_id,
      'limit', 'dependents',
      'max', 100
    )::text;
    RAISE EXCEPTION USING
      ERRCODE = 'P1005',
      MESSAGE = 'a task accepts at most 100 dependent tasks',
      DETAIL = v_diagnostic,
      HINT = v_diagnostic;
  END IF;
  SELECT array_agg(DISTINCT inserted.prerequisite_task_id) INTO v_prerequisites
    FROM inserted_dependencies inserted
   WHERE inserted.released_at IS NULL;
  IF v_prerequisites IS NOT NULL THEN
    IF v_sinks THEN
      -- New sinks change only the transitive counts of their prerequisites' unresolved upstream
      -- cone. Lock the cone with the component keys, then walk it again: a writer that grew the
      -- cone before the locks were granted is visible to the next walk, and its new members are
      -- locked in turn. Every walk step is a LATERAL index probe fenced by OFFSET 0, so the plan
      -- stays a nested loop over the frontier even when statistics lag a fast-growing graph.
      v_cone := '{}';
      LOOP
        WITH RECURSIVE cone(task_id) AS (
          SELECT unnest(v_prerequisites)
          UNION
          SELECT upstream.task_id
            FROM cone
            CROSS JOIN LATERAL (
              SELECT dependency.prerequisite_task_id AS task_id
                FROM workhorse.task_dependency dependency
               WHERE dependency.dependent_task_id = cone.task_id
                 AND dependency.released_at IS NULL
              OFFSET 0
            ) upstream
        )
        SELECT array_agg(cone.task_id ORDER BY cone.task_id::text) INTO v_walk
          FROM cone
         WHERE cone.task_id <> ALL(v_cone);
        EXIT WHEN v_walk IS NULL;
        FOREACH v_component_task_id IN ARRAY v_walk::text[] LOOP
          PERFORM pg_advisory_xact_lock(hashtextextended(
            'workhorse:task-dependency-component-task:' || v_component_task_id,
            0
          ));
        END LOOP;
        v_cone := v_cone || v_walk;
      END LOOP;
      -- A task's transitive dependents include those of every task below it, so the largest count
      -- in the cone belongs to a cone source. The union of the sources' dependents bounds every
      -- source's own count, so one walk that stops above the cap settles the common case. Only a
      -- union above the cap counts each source separately.
      SELECT array_agg(cone.task_id) INTO v_cone
        FROM unnest(v_cone) AS cone(task_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM workhorse.task_dependency dependency
          WHERE dependency.dependent_task_id = cone.task_id
            AND dependency.released_at IS NULL
       );
      v_exact_fan_out := (
        WITH RECURSIVE reachable(task_id) AS (
          SELECT downstream.task_id
            FROM unnest(v_cone) AS source(task_id)
            CROSS JOIN LATERAL (
              SELECT dependency.dependent_task_id AS task_id
                FROM workhorse.task_dependency dependency
               WHERE dependency.prerequisite_task_id = source.task_id
                 AND dependency.released_at IS NULL
              OFFSET 0
            ) downstream
          UNION
          SELECT downstream.task_id
            FROM reachable
            CROSS JOIN LATERAL (
              SELECT dependency.dependent_task_id AS task_id
                FROM workhorse.task_dependency dependency
               WHERE dependency.prerequisite_task_id = reachable.task_id
                 AND dependency.released_at IS NULL
              OFFSET 0
            ) downstream
        )
        SELECT count(*) FROM (SELECT 1 FROM reachable LIMIT 101) bounded
      ) > 100 AND EXISTS (
        SELECT 1
          FROM unnest(v_cone) AS source(task_id)
         WHERE (
           WITH RECURSIVE reachable(task_id) AS (
             SELECT dependency.dependent_task_id
               FROM workhorse.task_dependency dependency
              WHERE dependency.prerequisite_task_id = source.task_id
                AND dependency.released_at IS NULL
             UNION
             SELECT downstream.task_id
               FROM reachable
               CROSS JOIN LATERAL (
                 SELECT dependency.dependent_task_id AS task_id
                   FROM workhorse.task_dependency dependency
                  WHERE dependency.prerequisite_task_id = reachable.task_id
                    AND dependency.released_at IS NULL
                 OFFSET 0
               ) downstream
           )
           SELECT count(*) FROM (SELECT 1 FROM reachable LIMIT 101) bounded
         ) > 100
      );
    END IF;
    -- The exact check names the same task whichever path reached it.
    IF v_exact_fan_out THEN
      WITH RECURSIVE affected(root_task_id) AS (
        SELECT unnest(v_prerequisites)
        UNION
        SELECT dependency.prerequisite_task_id
          FROM affected
          JOIN workhorse.task_dependency dependency
            ON dependency.dependent_task_id = affected.root_task_id
           AND dependency.released_at IS NULL
      ), reachable(root_task_id, dependent_task_id) AS (
        SELECT affected.root_task_id, dependency.dependent_task_id
          FROM affected
          JOIN workhorse.task_dependency dependency
            ON dependency.prerequisite_task_id = affected.root_task_id
           AND dependency.released_at IS NULL
        UNION
        SELECT reachable.root_task_id, dependency.dependent_task_id
          FROM reachable
          JOIN workhorse.task_dependency dependency
            ON dependency.prerequisite_task_id = reachable.dependent_task_id
           AND dependency.released_at IS NULL
      )
      SELECT reachable.root_task_id INTO v_fan_out_root
        FROM reachable
       GROUP BY reachable.root_task_id
      HAVING count(*) > 100
       ORDER BY reachable.root_task_id
       LIMIT 1;
      IF v_fan_out_root IS NOT NULL THEN
        v_diagnostic := jsonb_build_object(
          'taskId', v_fan_out_root,
          'limit', 'unresolved_dependents',
          'max', 100
        )::text;
        RAISE EXCEPTION USING
          ERRCODE = 'P1005',
          MESSAGE = 'a task accepts at most 100 unresolved transitive dependent tasks',
          DETAIL = v_diagnostic,
          HINT = v_diagnostic;
      END IF;
    END IF;
  END IF;
  IF EXISTS (
    SELECT dependency.dependent_task_id
      FROM workhorse.task_dependency dependency
      JOIN (
        SELECT DISTINCT inserted.dependent_task_id FROM inserted_dependencies inserted
         WHERE inserted.released_at IS NULL
      ) touched USING (dependent_task_id)
     WHERE dependency.released_at IS NULL
     GROUP BY dependency.dependent_task_id
    HAVING count(DISTINCT (
      dependency.on_success,
      dependency.on_failure,
      dependency.on_cancellation
    )) > 1
  ) THEN
    RAISE EXCEPTION 'every dependency edge for one task must use the same outcome policies';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.reject_fast_feature_v1(
  p_queue_name text, p_feature text, p_ordinal integer DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_diagnostic text;
BEGIN
  v_diagnostic := (
    jsonb_build_object('queue', p_queue_name, 'feature', p_feature)
    || CASE WHEN p_ordinal IS NULL THEN '{}'::jsonb
       ELSE jsonb_build_object('ordinal', p_ordinal) END
  )::text;
  RAISE EXCEPTION USING
    ERRCODE = 'P1007',
    MESSAGE = format('fast-tier queue %s does not support %s', p_queue_name, p_feature),
    DETAIL = v_diagnostic,
    HINT = v_diagnostic;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_batch_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, accepted boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_diagnostic text;
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
  v_pending_edges integer;
  v_terminal_prerequisite_id uuid;
  v_terminal_prerequisite_state text;
  v_terminal_action text;
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
  v_full_task workhorse.task;
  v_full_tasks workhorse.task[] := '{}';
  v_full_runtime workhorse.task_runtime;
  v_full_runtimes workhorse.task_runtime[] := '{}';
  v_full_enqueued_details jsonb[] := '{}';
  v_full_past_deadline uuid[] := '{}';
  v_edge workhorse.task_dependency;
  v_edges workhorse.task_dependency[] := '{}';
  v_full_task_id uuid;
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

  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);

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
    -- their answers directly and reaches the buffer without touching dependency relations.
    IF cardinality(v_prerequisite_task_ids) > 0 THEN
      IF cardinality(v_prerequisite_task_ids) <> (
        SELECT count(DISTINCT prerequisite_id) FROM unnest(v_prerequisite_task_ids) prerequisite_id
      ) THEN
        RAISE EXCEPTION 'dependency prerequisiteTaskIds must be unique';
      END IF;
      -- The batch already holds these rows, so locking them again waits for nothing. The lock
      -- still counts the prerequisites that exist, and it covers a spelling of a UUID that the
      -- batch pattern missed.
      PERFORM 1 FROM workhorse.task_runtime runtime
       WHERE runtime.task_id = ANY(v_prerequisite_task_ids)
       ORDER BY runtime.task_id FOR KEY SHARE;
      PERFORM 1 FROM workhorse.task prerequisite
       WHERE prerequisite.id = ANY(v_prerequisite_task_ids)
       ORDER BY prerequisite.id FOR KEY SHARE;
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
        v_diagnostic := jsonb_build_object(
          'feature', 'dependencies', 'taskId', v_fast_task_id, 'ordinal', v_ordinal
        )::text;
        RAISE EXCEPTION USING
          ERRCODE = 'P1007',
          MESSAGE = format('fast-tier task %s cannot be a prerequisite', v_fast_task_id),
          DETAIL = v_diagnostic,
          HINT = v_diagnostic;
      END IF;
      -- An edge starts pending unless its prerequisite is terminal and its policy releases. The
      -- dependent's counter starts at that count and falls as the pending edges resolve.
      SELECT count(*) FILTER (WHERE outcome.task_id IS NULL)::integer,
             count(*) FILTER (
               WHERE outcome.task_id IS NULL OR CASE outcome.state
                 WHEN 'succeeded' THEN v_on_success
                 WHEN 'failed' THEN v_on_failure
                 WHEN 'canceled' THEN v_on_cancellation
               END <> 'release'
             )::integer
        INTO v_pending_prerequisites, v_pending_edges
        FROM unnest(v_prerequisite_task_ids) prerequisite_id
        LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = prerequisite_id;
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
      v_pending_edges := 0;
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
          v_diagnostic := jsonb_build_object(
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
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = 'enqueue idempotency conflict with a retained request',
            DETAIL = v_diagnostic,
            HINT = v_diagnostic;
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
      -- Full-tier rows are collected here and written after the loop, one statement per table.
      -- A prerequisite exists before this batch starts, because the batch generates every new task
      -- identity, so no check or lock above needs a buffered row.
      v_full_task := NULL;
      v_full_task.id := task_id;
      v_full_task.queue_name := v_queue_name;
      v_full_task.task_type := v_task_type;
      v_full_task.concurrency_key := v_concurrency_key;
      v_full_task.priority := v_priority::integer;
      v_full_task.payload := v_payload;
      v_full_task.contract_version := v_contract_version;
      v_full_task.payload_max_bytes := v_payload_max_bytes::integer;
      v_full_task.result_max_bytes := v_result_max_bytes::integer;
      v_full_task.payload_redact_keys := v_payload_redact_keys;
      v_full_task.result_redact_keys := v_result_redact_keys;
      v_full_task.trace_context := v_trace_context;
      v_full_task.tags := v_tags;
      v_full_task.max_attempts := v_max_attempts;
      v_full_task.retry_policy := v_retry_policy;
      v_full_task.deadline_at := v_deadline_at;
      v_full_task.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_full_task.budget_name := v_budget_name;
      v_full_tasks := array_append(v_full_tasks, v_full_task);

      v_full_runtime := NULL;
      v_full_runtime.task_id := task_id;
      v_full_runtime.queue_name := v_queue_name;
      v_full_runtime.concurrency_key := v_concurrency_key;
      v_full_runtime.priority := v_priority::integer;
      v_full_runtime.state := v_state;
      v_full_runtime.current_attempt := 1;
      v_full_runtime.run_at := v_run_at;
      v_full_runtime.ready_at := CASE WHEN v_state = 'ready' THEN v_now END;
      v_full_runtime.sequence := CASE WHEN v_state = 'ready'
        THEN nextval('workhorse.ready_sequence_seq') END;
      v_full_runtime.deadline_at := v_deadline_at;
      v_full_runtime.budget_name := v_budget_name;
      v_full_runtime.pending_prerequisites := v_pending_edges;
      v_full_runtime.dependency_rejected := false;
      v_full_runtimes := array_append(v_full_runtimes, v_full_runtime);

      FOREACH v_prerequisite_task_id IN ARRAY v_prerequisite_task_ids LOOP
        v_edge := NULL;
        v_edge.dependent_task_id := task_id;
        v_edge.prerequisite_task_id := v_prerequisite_task_id;
        v_edge.on_success := v_on_success;
        v_edge.on_failure := v_on_failure;
        v_edge.on_cancellation := v_on_cancellation;
        v_edges := array_append(v_edges, v_edge);
      END LOOP;

      v_full_enqueued_details := array_append(v_full_enqueued_details,
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
        v_full_past_deadline := array_append(v_full_past_deadline, task_id);
      ELSIF v_state = 'ready' AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    END IF;
    ordinal := v_ordinal;
    accepted := v_is_new;
    RETURN NEXT;
  END LOOP;

  -- The buffered writes keep each task's evidence in the order the one-row writes produced: its
  -- dependency events, the resolution of any terminal prerequisite, `enqueued`, then an expired
  -- deadline. Omitted columns keep their per-row defaults, so created_at, updated_at and the event
  -- identity advance with each row.
  IF cardinality(v_full_tasks) > 0 THEN
    INSERT INTO workhorse.task(
      id, queue_name, task_type, concurrency_key, priority, payload, contract_version,
      payload_max_bytes, result_max_bytes,
      payload_redact_keys, result_redact_keys, trace_context, tags, max_attempts, retry_policy,
      deadline_at, execution_timeout_ms, budget_name
    )
    SELECT buffered.id, buffered.queue_name, buffered.task_type, buffered.concurrency_key,
           buffered.priority, buffered.payload, buffered.contract_version,
           buffered.payload_max_bytes, buffered.result_max_bytes,
           buffered.payload_redact_keys, buffered.result_redact_keys, buffered.trace_context,
           buffered.tags, buffered.max_attempts, buffered.retry_policy,
           buffered.deadline_at, buffered.execution_timeout_ms, buffered.budget_name
      FROM unnest(v_full_tasks) WITH ORDINALITY buffered
     ORDER BY buffered.ordinality;
    INSERT INTO workhorse.task_runtime(
      task_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at,
      sequence, deadline_at, budget_name, pending_prerequisites, dependency_rejected
    )
    SELECT buffered.task_id, buffered.queue_name, buffered.concurrency_key, buffered.priority,
           buffered.state, buffered.current_attempt, buffered.run_at, buffered.ready_at,
           buffered.sequence, buffered.deadline_at, buffered.budget_name,
           buffered.pending_prerequisites, buffered.dependency_rejected
      FROM unnest(v_full_runtimes) WITH ORDINALITY buffered
     ORDER BY buffered.ordinality;
    -- A batch without prerequisites has no edge to write and no dependent to resolve. Running the
    -- insert anyway would fire the statement trigger on `task_dependency`, and that trigger walks
    -- the dependency graph recursively for a transition that cannot have occurred.
    IF cardinality(v_edges) > 0 THEN
      WITH edges AS MATERIALIZED (
        SELECT edge.dependent_task_id, edge.prerequisite_task_id, edge.on_success,
               edge.on_failure, edge.on_cancellation, edge.ordinality, outcome.state,
               outcome.state IS NOT NULL AND (
                 (outcome.state = 'succeeded' AND edge.on_success = 'release')
                 OR (outcome.state = 'failed' AND edge.on_failure = 'release')
                 OR (outcome.state = 'canceled' AND edge.on_cancellation = 'release')
               ) AS releases_immediately
          FROM unnest(v_edges) WITH ORDINALITY edge
          LEFT JOIN workhorse.task_outcome outcome
            ON outcome.task_id = edge.prerequisite_task_id
      ), inserted_edges AS (
        INSERT INTO workhorse.task_dependency(
          dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation,
          created_at, released_at, resolution
        )
        SELECT edges.dependent_task_id, edges.prerequisite_task_id,
               edges.on_success, edges.on_failure, edges.on_cancellation, v_now,
               CASE WHEN edges.releases_immediately THEN v_now END,
               CASE WHEN edges.releases_immediately THEN 'release' END
          FROM edges
         ORDER BY edges.ordinality
        RETURNING dependent_task_id, prerequisite_task_id
      )
      INSERT INTO workhorse.task_event(task_id, event_type, details)
      SELECT edges.dependent_task_id,
             CASE WHEN edges.releases_immediately
               THEN 'dependency_released' ELSE 'dependency_blocked' END,
             jsonb_build_object(
               'prerequisite_task_id', edges.prerequisite_task_id,
               'state', runtime.state,
               'reason', CASE
                 WHEN NOT edges.releases_immediately THEN 'prerequisite_pending'
                 WHEN edges.state = 'succeeded' THEN 'prerequisite_already_succeeded'
                 ELSE 'prerequisite_terminal_policy'
               END
             )
        FROM edges
        JOIN inserted_edges USING (dependent_task_id, prerequisite_task_id)
        JOIN unnest(v_full_runtimes) runtime ON runtime.task_id = edges.dependent_task_id
       ORDER BY edges.ordinality;
      -- One resolver call resolves the pending edges to every terminal prerequisite in the batch. A
      -- dependent's fate depends only on the resolutions of its edges, so it matches the fate that
      -- one call per dependent produced.
      PERFORM workhorse.resolve_dependents_many_v1(terminal.task_ids, terminal.states)
         FROM (
           SELECT array_agg(outcome.task_id ORDER BY outcome.task_id) AS task_ids,
                  array_agg(outcome.state ORDER BY outcome.task_id) AS states
             FROM workhorse.task_outcome outcome
            WHERE outcome.task_id IN (
              SELECT edge.prerequisite_task_id FROM unnest(v_edges) edge
            )
         ) terminal
        WHERE terminal.task_ids IS NOT NULL;
    END IF;
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    SELECT buffered.id, 'enqueued', event.details
      FROM unnest(v_full_tasks) WITH ORDINALITY buffered
      JOIN unnest(v_full_enqueued_details) WITH ORDINALITY event(details, ordinality)
        ON event.ordinality = buffered.ordinality
     ORDER BY buffered.ordinality;
    FOREACH v_full_task_id IN ARRAY v_full_past_deadline LOOP
      PERFORM workhorse.terminalize_deadline_v1(v_full_task_id);
    END LOOP;
  END IF;

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

CREATE OR REPLACE FUNCTION workhorse.enqueue_many_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, outcome text, reason text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_diagnostic text;
  v_request jsonb;
  v_ordinal integer;
  v_row record;
  v_lock record;
  v_error_message text;
  v_error_detail text;
  v_contract_mismatch jsonb;
  v_fast_queue text;
  v_fast_queues text[];
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

  -- Lock the tiers of every debounce and throttle queue in name order before any request runs.
  -- Throttle works on both tiers, but its queues still take their tier locks here.
  v_fast_queues := workhorse.lock_queue_tiers_v1(ARRAY(
    SELECT DISTINCT candidate->>'queue'
      FROM jsonb_array_elements(p_requests) candidate
     WHERE candidate ? 'debounce' OR candidate ? 'throttle'
  ));
  -- Report a debounce request on a fast-tier queue with its ordinal.
  SELECT input.request->>'queue', input.ordinality::integer
    INTO v_fast_queue, v_ordinal
    FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
   WHERE input.request ? 'debounce'
     AND input.request->>'queue' = ANY(v_fast_queues)
   ORDER BY input.ordinality
   LIMIT 1;
  IF FOUND THEN
    PERFORM workhorse.reject_fast_feature_v1(v_fast_queue, 'debounce', v_ordinal);
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

  -- A debounce or throttle member makes the batch enqueue member by member. Each plain member
  -- would then lock only its own prerequisites, so lock every member's prerequisites first.
  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);

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
      EXCEPTION
        WHEN SQLSTATE 'P1001' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          v_diagnostic := (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = v_error_message,
            DETAIL = v_diagnostic,
            HINT = v_diagnostic;
        -- A fast-tier rejection of the member reports the ordinal of the member in the batch.
        WHEN SQLSTATE 'P1007' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          v_diagnostic := (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
          RAISE EXCEPTION USING
            ERRCODE = 'P1007',
            MESSAGE = v_error_message,
            DETAIL = v_diagnostic,
            HINT = v_diagnostic;
      END;
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := v_row.outcome;
      reason := NULL;
    ELSE
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_request));
      EXCEPTION
        WHEN SQLSTATE 'P1001' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          v_diagnostic := (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = v_error_message,
            DETAIL = v_diagnostic,
            HINT = v_diagnostic;
        -- A fast-tier rejection of the member reports the ordinal of the member in the batch.
        WHEN SQLSTATE 'P1007' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          v_diagnostic := (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
          RAISE EXCEPTION USING
            ERRCODE = 'P1007',
            MESSAGE = v_error_message,
            DETAIL = v_diagnostic,
            HINT = v_diagnostic;
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
  v_diagnostic text;
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
      v_diagnostic := jsonb_build_object(
        'sourceTaskId', p_source_task_id,
        'existingTargetTaskId', v_existing.target_task_id,
        'requestIdPreview', v_request_id_preview,
        'requestIdDigest', v_request_id_digest,
        'requestIdLength', v_request_id_length,
        'conflictingFields', to_jsonb(v_conflicting_fields),
        'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
        'rejectedRequestDigest', workhorse.sha256_hex_v1(v_fingerprint::text)
      )::text;
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'redrive request conflict with a retained request',
        DETAIL = v_diagnostic,
        HINT = v_diagnostic;
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

CREATE OR REPLACE FUNCTION workhorse.set_queue_tier_v1(
  p_queue_name text,
  p_tier text,
  p_requested_by text,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_diagnostic text;
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
    v_diagnostic := jsonb_build_object('queue', p_queue_name, 'feature', 'tier change')::text;
    RAISE EXCEPTION USING
      ERRCODE = 'P1007',
      MESSAGE = format('queue %s has live tasks, so its tier cannot change', p_queue_name),
      DETAIL = v_diagnostic,
      HINT = v_diagnostic;
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

CREATE OR REPLACE FUNCTION workhorse.purge_queue_v1(
  p_queue_name text,
  p_requested_by text,
  p_reason text,
  p_request_id text
)
RETURNS TABLE (deleted_count integer, replayed boolean, requested_at timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE
  v_diagnostic text;
  v_existing workhorse.queue_purge_request%ROWTYPE;
  v_fingerprint jsonb;
  v_conflicting_fields text[];
  v_request_id_hash bytea;
  v_request_id_preview text;
  v_request_id_digest text;
  v_request_id_length integer;
  v_deleted_count integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;

  v_fingerprint := jsonb_build_object(
    'queue', p_queue_name,
    'requestedBy', p_requested_by,
    'reason', p_reason
  );
  v_request_id_hash := sha256(convert_to(p_request_id, 'UTF8'));
  v_request_id_digest := left(encode(v_request_id_hash, 'hex'), 12);
  v_request_id_length := char_length(p_request_id);
  v_request_id_preview := CASE
    WHEN v_request_id_length <= 4 THEN repeat('•', v_request_id_length)
    WHEN v_request_id_length <= 8 THEN left(p_request_id, 2) || '…' || right(p_request_id, 2)
    ELSE left(p_request_id, 8) || '…' || right(p_request_id, 4)
  END;

  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:purge:' || p_request_id, 0));
  SELECT * INTO v_existing FROM workhorse.queue_purge_request request
   WHERE request.request_id_hash = v_request_id_hash;
  IF FOUND THEN
    IF v_existing.request_fingerprint <> v_fingerprint THEN
      SELECT COALESCE(array_agg(field ORDER BY field COLLATE "C"), '{}')
        INTO v_conflicting_fields
        FROM jsonb_object_keys(v_fingerprint) field
       WHERE v_existing.request_fingerprint->field IS DISTINCT FROM v_fingerprint->field;
      v_diagnostic := jsonb_build_object(
        'queue', p_queue_name,
        'requestIdPreview', v_request_id_preview,
        'requestIdDigest', v_request_id_digest,
        'requestIdLength', v_request_id_length,
        'conflictingFields', to_jsonb(v_conflicting_fields),
        'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
        'rejectedRequestDigest', workhorse.sha256_hex_v1(v_fingerprint::text)
      )::text;
      RAISE EXCEPTION USING
        ERRCODE = 'P1006',
        MESSAGE = 'queue purge request conflict with a retained request',
        DETAIL = v_diagnostic,
        HINT = v_diagnostic;
    END IF;
    RETURN QUERY SELECT v_existing.deleted_count, true, v_existing.requested_at;
    RETURN;
  END IF;

  v_deleted_count := workhorse.purge_queue_internal_v1(p_queue_name);
  INSERT INTO workhorse.queue_purge_request(
    request_id_hash, request_id_preview, request_id_digest, request_id_length,
    queue_name, requested_by, reason, request_fingerprint, deleted_count, requested_at
  ) VALUES (
    v_request_id_hash, v_request_id_preview, v_request_id_digest, v_request_id_length,
    p_queue_name, p_requested_by, p_reason, v_fingerprint, v_deleted_count, v_now
  );
  RETURN QUERY SELECT v_deleted_count, false, v_now;
END;
$$;

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
  v_diagnostic text;
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
  -- Admission counts active leases after it takes its locks, and only a statement snapshot taken
  -- after those locks sees every committed lease. PostgreSQL runs read uncommitted as read committed.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      ERRCODE = '0A000',
      MESSAGE = format(
        'Workhorse claims require read committed isolation, not %s',
        current_setting('transaction_isolation')
      );
  END IF;
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF NOT FOUND OR v_control.tier <> 'fast' THEN
    v_diagnostic := jsonb_build_object('queue', p_queue_name, 'feature', 'batched completion')::text;
    RAISE EXCEPTION USING
      ERRCODE = 'P1007',
      MESSAGE = format('queue %s is not a fast-tier queue', p_queue_name),
      DETAIL = v_diagnostic,
      HINT = v_diagnostic;
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

CREATE OR REPLACE FUNCTION workhorse.add_task_group_members_v1(
  p_group_id uuid,
  p_requests jsonb,
  p_member_task_id uuid DEFAULT NULL,
  p_worker_id text DEFAULT NULL,
  p_fence_token bigint DEFAULT NULL
) RETURNS TABLE (ordinal integer, task_id uuid, outcome text, reason text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_diagnostic text;
  v_group workhorse.task_group%ROWTYPE;
  v_member workhorse.task_runtime%ROWTYPE;
  v_lock_task_id uuid;
  v_refusal text;
  v_fast_queue text;
  v_fast_ordinal integer;
  v_row record;
  v_member_group_id uuid;
  v_new_task_ids uuid[] := '{}';
  v_total integer;
  v_opened integer;
  v_counted_task_ids uuid[];
  v_counted_states text[];
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_group_id IS NULL THEN RAISE EXCEPTION 'task group identity is required'; END IF;
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  IF jsonb_array_length(p_requests) > 1000 THEN
    RAISE EXCEPTION 'a task group add accepts at most 1000 tasks';
  END IF;
  IF (p_member_task_id IS NULL) <> (p_worker_id IS NULL)
     OR (p_member_task_id IS NULL) <> (p_fence_token IS NULL) THEN
    RAISE EXCEPTION 'a member add requires the member task, worker, and fence token';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) input(request)
     WHERE jsonb_typeof(input.request) = 'object'
       AND (input.request ? 'debounce' OR input.request ? 'throttle')
  ) THEN
    RAISE EXCEPTION 'a task group add cannot use debounce or throttle';
  END IF;

  -- Completion, cancellation, and purge lock a runtime row before the shard and group rows. Lock
  -- the prerequisites of the requests first, so an add that names a member as a prerequisite takes
  -- the same order and cannot deadlock with that member's completion. A member add also locks the
  -- member's runtime row in this pass. FOR NO KEY UPDATE conflicts with every update and delete of
  -- the row, and it does not block the key-share lock of an enqueue that names the member as a
  -- prerequisite. The pass locks in identity order, as cancel_task_group_v1 and a resolver do, so
  -- it does not hold the member while it waits for a lower runtime row that a cancel holds.
  IF p_member_task_id IS NOT NULL THEN
    FOR v_lock_task_id IN
      SELECT locked.task_id
        FROM unnest(
          workhorse.enqueue_prerequisite_task_ids_internal_v1(p_requests) || p_member_task_id
        ) locked(task_id)
       GROUP BY locked.task_id
       ORDER BY locked.task_id
    LOOP
      IF v_lock_task_id = p_member_task_id THEN
        SELECT * INTO v_member FROM workhorse.task_runtime runtime
         WHERE runtime.task_id = p_member_task_id FOR NO KEY UPDATE;
      ELSE
        PERFORM 1 FROM workhorse.task_runtime runtime
         WHERE runtime.task_id = v_lock_task_id FOR KEY SHARE;
      END IF;
    END LOOP;
  END IF;
  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);
  PERFORM 1 FROM workhorse.task_group_shard shard
   WHERE shard.group_id = p_group_id
   ORDER BY shard.shard FOR UPDATE;
  SELECT * INTO v_group FROM workhorse.task_group task_group
   WHERE task_group.id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task group % does not exist', p_group_id; END IF;
  v_refusal := CASE
    WHEN v_group.canceled_at IS NOT NULL THEN 'canceled'
    WHEN v_group.state = 'finished' THEN 'finished'
    WHEN p_member_task_id IS NOT NULL AND NOT COALESCE(
      v_member.state = 'active'
        AND v_member.worker_id = p_worker_id
        AND v_member.fence_token = p_fence_token
        AND v_member.expires_at > clock_timestamp()
        AND (v_member.deadline_at IS NULL OR v_member.deadline_at > clock_timestamp())
        AND (v_member.attempt_timeout_at IS NULL
          OR v_member.attempt_timeout_at > clock_timestamp())
        AND v_member.cancel_requested_at IS NULL
        AND EXISTS (
          SELECT 1 FROM workhorse.task_group_member member
           WHERE member.task_id = p_member_task_id AND member.group_id = p_group_id
        ),
      false
    ) THEN 'not_running_member'
    WHEN v_group.state = 'sealed' AND p_member_task_id IS NULL THEN 'sealed'
  END;
  IF v_refusal IS NOT NULL THEN
    v_diagnostic := jsonb_build_object(
      'groupId', p_group_id, 'state', v_group.state, 'reason', v_refusal
    )::text;
    RAISE EXCEPTION USING
      ERRCODE = 'P1008',
      MESSAGE = 'the task group does not accept tasks',
      DETAIL = v_diagnostic,
      HINT = v_diagnostic;
  END IF;

  -- A fast-tier task records no outcome row that a group could count (ADR 0077).
  SELECT input.request->>'queue', input.ordinality::integer
    INTO v_fast_queue, v_fast_ordinal
    FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
   WHERE input.request->>'queue' = ANY(workhorse.lock_queue_tiers_v1(ARRAY(
     SELECT DISTINCT candidate->>'queue' FROM jsonb_array_elements(p_requests) candidate
   )))
   ORDER BY input.ordinality
   LIMIT 1;
  IF FOUND THEN
    PERFORM workhorse.reject_fast_feature_v1(v_fast_queue, 'task groups', v_fast_ordinal);
  END IF;

  FOR v_row IN SELECT * FROM workhorse.enqueue_many_v1(p_requests) enqueued
                ORDER BY enqueued.ordinal LOOP
    IF v_row.outcome = 'contract_mismatch' THEN
      -- Nothing was enqueued. The caller refreshes its contracts and calls again.
      ordinal := v_row.ordinal;
      task_id := NULL;
      outcome := v_row.outcome;
      reason := v_row.reason;
      RETURN NEXT;
      RETURN;
    END IF;
    IF v_row.outcome = 'accepted' THEN
      v_new_task_ids := array_append(v_new_task_ids, v_row.task_id);
    ELSIF NOT v_row.task_id = ANY(v_new_task_ids) THEN
      SELECT member.group_id INTO v_member_group_id
        FROM workhorse.task_group_member member WHERE member.task_id = v_row.task_id;
      IF v_member_group_id IS DISTINCT FROM p_group_id THEN
        v_diagnostic := jsonb_build_object(
          'groupId', p_group_id, 'taskId', v_row.task_id, 'ordinal', v_row.ordinal,
          'memberOf', v_member_group_id
        )::text;
        RAISE EXCEPTION USING
          ERRCODE = 'P1010',
          MESSAGE = 'enqueue idempotency returned a task that is not a member of the task group',
          DETAIL = v_diagnostic,
          HINT = v_diagnostic;
      END IF;
    END IF;
    ordinal := v_row.ordinal;
    task_id := v_row.task_id;
    outcome := v_row.outcome;
    reason := v_row.reason;
    RETURN NEXT;
  END LOOP;

  IF cardinality(v_new_task_ids) = 0 THEN RETURN; END IF;
  SELECT COALESCE(sum(shard.total_count), 0)::integer INTO v_total
    FROM workhorse.task_group_shard shard WHERE shard.group_id = p_group_id;
  IF v_total + cardinality(v_new_task_ids) > workhorse.task_group_member_limit_v1() THEN
    v_diagnostic := jsonb_build_object(
      'groupId', p_group_id, 'limit', workhorse.task_group_member_limit_v1(),
      'total', v_total, 'requested', cardinality(v_new_task_ids)
    )::text;
    RAISE EXCEPTION USING
      ERRCODE = 'P1009',
      MESSAGE = 'a task group accepts at most 100000 member tasks',
      DETAIL = v_diagnostic,
      HINT = v_diagnostic;
  END IF;
  INSERT INTO workhorse.task_group_member(task_id, group_id, position, added_at)
  SELECT added.task_id, p_group_id, v_total + added.ordinality::integer, v_now
    FROM unnest(v_new_task_ids) WITH ORDINALITY added(task_id, ordinality);
  -- A member task uses the shard (position - 1) mod shard_count. A shard whose pending count
  -- changes from 0 to more than 0 increases pending_shard_count.
  WITH added AS (
    SELECT ((v_total + slot.ordinality - 1) % v_group.shard_count)::smallint AS shard,
           count(*)::integer AS members
      FROM generate_series(1, cardinality(v_new_task_ids)) slot(ordinality)
     GROUP BY 1
  ), changed AS (
    UPDATE workhorse.task_group_shard shard
       SET total_count = shard.total_count + added.members
      FROM added
     WHERE shard.group_id = p_group_id AND shard.shard = added.shard
    RETURNING shard.total_count - added.members - shard.succeeded_count - shard.failed_count
                - shard.canceled_count AS pending_before
  )
  SELECT count(*) FILTER (WHERE changed.pending_before = 0)::integer INTO v_opened FROM changed;
  UPDATE workhorse.task_group task_group
     SET pending_shard_count = task_group.pending_shard_count + v_opened,
         updated_at = v_now
   WHERE task_group.id = p_group_id;

  -- An enqueue can write an outcome at once, for example for a deadline in the past or a rejected
  -- prerequisite. That outcome came before the membership row, so the trigger did not record it.
  SELECT array_agg(task_outcome.task_id ORDER BY task_outcome.task_id),
         array_agg(task_outcome.state ORDER BY task_outcome.task_id)
    INTO v_counted_task_ids, v_counted_states
    FROM workhorse.task_outcome task_outcome
   WHERE task_outcome.task_id = ANY(v_new_task_ids);
  IF v_counted_task_ids IS NOT NULL THEN
    PERFORM workhorse.count_task_group_outcomes_internal_v1(v_counted_task_ids, v_counted_states);
  END IF;
END;
$$;
