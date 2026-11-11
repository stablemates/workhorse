-- workhorse-migration: {"kind":"additive"}

-- Purge only the tasks that the purge locked, read the tier through a row lock outside read
-- committed, limit the queue name of an enqueue, and start a claim lease after the row lock.
--
-- purge_queue_internal_v1 locked the runtime rows of a queue, then the task rows from a later
-- snapshot, and then read the queue a third time for the identities that it deleted. A task that a
-- producer committed during the purge could be in that last read and in no lock. A worker could
-- claim it, and the delete of its task row then removed its active runtime row: the heartbeat
-- returned stale and the completion returned false. A task that committed between the two lock
-- statements could also make the purge deadlock with a claim. The fast-tier part read the queue
-- again in each delete, so a keyed enqueue between them could leave a key row with no task. The
-- purge now takes its identity array from its first lock statement, and every later lock and
-- delete uses that array.
--
-- lock_queue_tiers_v1 took a shared advisory lock and then read queue_control.tier. At repeatable
-- read or serializable, that read used the snapshot of the first statement of the transaction.
-- After a tier change to the fast tier, the enqueue still wrote a full-tier task, and no claim
-- found it. Outside read committed, the function now creates a missing queue_control row and
-- locks each row FOR SHARE. A tier change after the snapshot then makes the enqueue fail with
-- SQLSTATE 40001. Read committed takes no row lock. set_queue_tier_v1 now refuses an isolation
-- level other than read committed with SQLSTATE 0A000, as the claim functions do, because its
-- live-task checks need a snapshot from after its lock. Outside read committed, lock_queue_tiers_v1
-- also refuses a queue name above 256 UTF-8 bytes, which an earlier release accepted, because no
-- row can protect its tier read. add_task_group_members_v1 now takes the tier locks before its row
-- locks, so it cannot wait for the queue_control row of a purge while it holds a row that the purge
-- waits for.
--
-- enqueue_batch_v1 checked only that a queue name is not empty. A name above 8,000 bytes failed in
-- pg_notify with an error that named no input, and a name between 257 and 7,999 bytes was accepted
-- although no policy can name it. The enqueue now refuses a queue name above 256 UTF-8 bytes
-- before any lock or write. enqueue_debounce_v1 checks the same limit before its early returns,
-- because a request can return before its validation call to enqueue_batch_v1. Thus an enqueue to
-- a queue name above the limit now fails. sync_schedule_definitions_internal_v1 refuses a new or
-- changed definition with such a name. The migration adds no table constraint, so an existing task
-- or queue_control row with a longer name stays, and its claims, completions, and purges continue.
-- A stored schedule with a longer name also stays, but it no longer fires: each fire fails in the
-- enqueue. Until migration 0095 (SM-1927) runs each definition in a subtransaction, that failure
-- also fails the pass of fire_due_schedules_v2 for the other schedules, as each other enqueue
-- failure does. Both migrations ship in the same release.
--
-- claim_policy_batch_v1 and claim_one_v1 read the clock before their row locks and computed the
-- lease from that sample. A row lock can wait for the update chain of a concurrent transaction, so
-- the lease could be over when the worker got the task. Both functions now lock the task rows FOR
-- KEY SHARE before a second clock sample. The foreign key check of the claim event took that lock
-- later in the same call, so the claim takes no new row lock and writes no new WAL record. The
-- second sample sets the lease, the heartbeat, the attempt timeout, and the charge of the key and
-- budget buckets. Admission and the admission shard charge keep the first sample.
--
-- Each function keeps its name, its arguments, and its result type under ADR 0109. Each change
-- corrects a defect. The new refusals are of inputs that no document states as accepted: a queue
-- name that no policy can name, and a tier change outside read committed. The migration changes
-- no stored rows, and the SDK floor does not change.

-- Take the shared tier lock of every named queue, in a fixed order, and return the fast-tier ones.
-- A caller that writes a task or a policy for these queues holds the lock until it commits, which
-- is what lets set_queue_tier_v1 prove a queue empty before it changes the tier.
--
-- At read committed, the tier read below takes a new snapshot after the lock, so it sees every
-- committed tier change. A transaction at repeatable read or serializable reads the snapshot of its
-- first statement, which can be older than a tier change. Such a transaction therefore creates each
-- missing queue_control row and locks each row FOR SHARE. If a tier change committed after the
-- snapshot, the insert or the lock fails with SQLSTATE 40001, and the application retries. A key
-- share lock does not detect a change of the tier, because the tier is not a key column. Read
-- committed takes no row lock, so producers on one queue add no lock to the hot path. A queue name
-- above 256 UTF-8 bytes, which an earlier release accepted, cannot get a protected tier read here,
-- so the function refuses it outside read committed before any write. A redrive of such a task then
-- fails instead of writing it to a tier that the queue no longer has.
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
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    IF EXISTS (
      SELECT 1 FROM unnest(p_queue_names) queue_name WHERE octet_length(queue_name) > 256
    ) THEN
      RAISE EXCEPTION 'queue name must contain at most 256 UTF-8 bytes';
    END IF;
    INSERT INTO workhorse.queue_control(queue_name)
    SELECT DISTINCT queue_name COLLATE "C" FROM unnest(p_queue_names) queue_name
     WHERE queue_name <> ''
     ORDER BY 1
    ON CONFLICT (queue_name) DO NOTHING;
    PERFORM 1 FROM workhorse.queue_control control
     WHERE control.queue_name = ANY(p_queue_names)
     ORDER BY control.queue_name COLLATE "C"
     FOR SHARE;
  END IF;
  RETURN ARRAY(
    SELECT control.queue_name FROM workhorse.queue_control control
     WHERE control.queue_name = ANY(p_queue_names) AND control.tier = 'fast'
  );
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
  v_diagnostic text;
  v_count integer;
  v_now timestamptz;
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
  v_stored_fingerprint jsonb;
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
  -- A queue name has the limit of the policy functions. The check runs before any lock or write,
  -- so a longer name never reaches a queue_control row or a wake-up notification.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) input(request)
     WHERE octet_length(input.request->>'queue') > 256
  ) THEN
    RAISE EXCEPTION 'queue name must contain at most 256 UTF-8 bytes';
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

  -- Lock the stored key rows of the batch before the clock read. A purge deletes key rows without
  -- the key advisory lock. Without this lock, the key insert below can wait for that delete to
  -- commit after the clock read, and the new key then expires too early.
  PERFORM 1
    FROM workhorse.enqueue_idempotency identity
   WHERE (identity.idempotency_scope, identity.idempotency_key_hash) IN (
           SELECT DISTINCT COALESCE(input.request->'idempotency'->>'scope', 'default'),
                  workhorse.idempotency_key_hash_v1(
                    COALESCE(input.request->'idempotency'->>'scope', 'default'),
                    input.request->'idempotency'->>'key'
                  )
             FROM jsonb_array_elements(p_requests) input(request)
            WHERE jsonb_typeof(input.request->'idempotency') = 'object'
         )
   ORDER BY identity.idempotency_scope COLLATE "C", identity.idempotency_key_hash
   FOR UPDATE OF identity;

  -- The batch reads its one timestamp after its last lock and before it writes a row. A lock wait
  -- above then cannot move run_at, ready_at, or a key expiry into the past, and the expiry test of
  -- a stored key uses the same instant as the rows that the batch writes.
  v_now := clock_timestamp();

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
          WHEN v_request->>'runAt' IS NULL THEN 'null'::jsonb
          ELSE workhorse.idempotency_instant_v1(v_run_at)
        END,
        'deadline', workhorse.idempotency_instant_v1(v_deadline_at),
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
          -- The timestamp members compare as instants, so the session TimeZone of either request
          -- does not matter.
          v_stored_fingerprint :=
            workhorse.canonical_enqueue_fingerprint_v1(v_existing.request_fingerprint);
          IF v_stored_fingerprint <> v_fingerprint THEN
            SELECT COALESCE(array_agg(field ORDER BY field COLLATE "C"), '{}')
              INTO v_conflicting_fields
              FROM jsonb_object_keys(v_fingerprint) field
             WHERE v_stored_fingerprint->field IS DISTINCT FROM v_fingerprint->field;
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

-- Keyed debounce. Inside the window a same-key request replaces the pending definition. Only a task
-- that has never started an attempt and holds no durable wait is pending: a scheduled row may be a
-- suspended wait or a retry backoff, and replacing it would rewrite an attempt already under way.
--
-- The function locks the runtime row of the keyed task before the key row, in the order that
-- run_task_now_v1 and purge_queue_internal_v1 use. It reads the clock after its last lock, so a
-- lock wait cannot make it test the window with an old instant. Only enqueue_batch_v1 writes a key
-- row for a new task, and it holds the key advisory lock to do so. Thus, while this function holds
-- that lock, the key row can only disappear; it cannot name a different task.
CREATE OR REPLACE FUNCTION workhorse.enqueue_debounce_v1(p_request jsonb)
RETURNS TABLE (task_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz;
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
  v_existing_task_id uuid;
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_has_identity boolean;
  v_validation_message text;
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
  -- A request can return before its validation call to enqueue_batch_v1, so the queue name limit
  -- of that function is also checked here, before any lock or write.
  IF octet_length(p_request->>'queue') > 256 THEN
    RAISE EXCEPTION 'queue name must contain at most 256 UTF-8 bytes';
  END IF;
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

  -- Find the keyed task with no row lock, lock its runtime row, and then lock the key row again
  -- for that task. An operator that ran the task now or purged it holds the runtime row first and
  -- deletes the key row, so the second read then finds no row.
  SELECT identity.task_id
    INTO v_existing_task_id
    FROM workhorse.enqueue_idempotency identity
   WHERE identity.idempotency_scope = v_scope
     AND identity.idempotency_key_hash = v_key_hash;
  IF v_existing_task_id IS NOT NULL THEN
    SELECT runtime.*
      INTO v_runtime
      FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = v_existing_task_id
     FOR UPDATE;
  END IF;
  SELECT identity.task_id, identity.request_fingerprint, identity.expires_at,
         identity.coalescing_mode
    INTO v_existing
    FROM workhorse.enqueue_idempotency identity
   WHERE identity.idempotency_scope = v_scope
     AND identity.idempotency_key_hash = v_key_hash
     AND identity.task_id = v_existing_task_id
   FOR UPDATE OF identity;
  v_has_identity := FOUND;
  IF NOT v_has_identity THEN
    v_runtime := NULL;
  END IF;
  v_now := clock_timestamp();

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

    -- Validate the replacement with the checks of a plain enqueue, and then roll the validation
    -- back. The batch reads a later clock than this function. If the key expired between the two
    -- reads, the batch deletes the key row and writes a new task, and the rollback removes both.
    -- An idempotency conflict (P1001) is the usual end of the validation. Any other error of the
    -- request propagates unchanged.
    BEGIN
      PERFORM 1 FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_normalized));
      RAISE EXCEPTION 'workhorse debounce validation complete';
    EXCEPTION
      WHEN SQLSTATE 'P1001' THEN
        NULL;
      WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_validation_message = MESSAGE_TEXT;
        IF v_validation_message IS DISTINCT FROM 'workhorse debounce validation complete' THEN
          RAISE;
        END IF;
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
      'runAt', workhorse.idempotency_instant_v1(v_run_at),
      'deadline', workhorse.idempotency_instant_v1((v_normalized->>'deadline')::timestamptz),
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
    WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash
      AND enqueue_idempotency.task_id = v_existing.task_id;

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
  -- Each fire enqueues through enqueue_batch_v1, which refuses a longer queue name. A pass of
  -- fire_due_schedules_v2 then fails for every schedule, so the deployment refuses the name here.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_definitions) definition
     WHERE octet_length(definition->>'queue') > 256
  ) THEN
    RAISE EXCEPTION 'schedule queue name must contain at most 256 UTF-8 bytes';
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
  -- The live-task checks below must see every task that committed before the tier lock. Only a
  -- statement snapshot taken after that lock does. PostgreSQL runs read uncommitted as read
  -- committed.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      ERRCODE = '0A000',
      MESSAGE = format(
        'Workhorse tier changes require read committed isolation, not %s',
        current_setting('transaction_isolation')
      );
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

CREATE OR REPLACE FUNCTION workhorse.purge_queue_internal_v1(p_queue_name text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_fast_count integer;
  v_purged_task_ids uuid[];
  v_fast_task_ids uuid[];
  v_canceled_task_ids uuid[];
  v_deleted_task_ids uuid[];
  v_member_task_ids uuid[];
  v_task_id uuid;
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  -- Two purges run one after the other, also for different queues. Each purge locks its own tasks
  -- before their dependents in other queues, so two purges whose queues depend on each other could
  -- otherwise lock the same rows in opposite orders. Take this lock before any row lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:purge-queue', 0));
  INSERT INTO workhorse.queue_control(queue_name, paused)
    VALUES (p_queue_name, false)
  ON CONFLICT (queue_name) DO NOTHING;
  -- Lock both runtime and parent identities before taking a fresh statement snapshot for history
  -- deletion. The history insert trigger takes KEY SHARE on task, so it either commits before these
  -- deletes become visible or fails after the parent disappears; it cannot commit an orphan.
  -- Lock every runtime row in identity order, then every task row in identity order. An enqueue
  -- locks its prerequisites in the same order, so the two cannot deadlock.
  --
  -- The purge removes exactly the tasks that its first lock statement locks, and every later
  -- statement uses that identity array. A task that commits while the purge waits for a lock is
  -- not in the array, so it stays and a worker can claim and complete it. A later read of the
  -- queue could find that task after a worker claimed it, and the delete of its task row would
  -- remove its active runtime row. The task-row lock also takes only these identities, so a task
  -- that commits between the two lock statements cannot hold a lock that a claim waits for.
  v_purged_task_ids := ARRAY(
    SELECT locked.task_id
      FROM (
        SELECT runtime.task_id
          FROM workhorse.task_runtime runtime
         WHERE runtime.queue_name = p_queue_name
           AND runtime.state IN ('blocked', 'ready', 'scheduled')
         ORDER BY runtime.task_id
         FOR UPDATE
      ) locked
     ORDER BY locked.task_id
  );
  PERFORM 1
    FROM workhorse.task task
   WHERE task.id = ANY(v_purged_task_ids)
   ORDER BY task.id
   FOR UPDATE;
  -- A cancel below settles the blocked dependents in other queues. Lock them as a cancel does:
  -- after the prerequisites, in identity order, FOR NO KEY UPDATE. A terminal transition of a
  -- purged task also locks it before its dependents, so the two cannot deadlock. The lock does not
  -- conflict with the key-share lock of an enqueue that names a dependent.
  PERFORM 1
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id IN (
           SELECT dependency.dependent_task_id
             FROM workhorse.task_dependency dependency
            WHERE dependency.prerequisite_task_id = ANY(v_purged_task_ids)
              AND dependency.released_at IS NULL
         )
     AND runtime.state = 'blocked'
     AND runtime.queue_name <> p_queue_name
   ORDER BY runtime.task_id
   FOR NO KEY UPDATE;

  -- A purged task stays, and the purge cancels it, when an edge leads to a dependent that stays.
  -- That is a dependent outside the purge, unless the edge is released and the dependent is
  -- terminal, or a purged task that stays itself. Depth counts the edges to the nearest dependent
  -- outside the purge along the longest path. The purge cancels in depth order, so every task is
  -- canceled after its dependents that stay, and each of them sees the purge's own cancel.
  WITH RECURSIVE staying(task_id, depth) AS (
    SELECT dependency.prerequisite_task_id, 0
      FROM workhorse.task_dependency dependency
     WHERE dependency.prerequisite_task_id = ANY(v_purged_task_ids)
       AND NOT dependency.dependent_task_id = ANY(v_purged_task_ids)
       AND (
             dependency.released_at IS NULL
             OR EXISTS (
                  SELECT 1 FROM workhorse.task_runtime runtime
                   WHERE runtime.task_id = dependency.dependent_task_id
                )
           )
    UNION
    SELECT dependency.prerequisite_task_id, staying.depth + 1
      FROM staying
      JOIN workhorse.task_dependency dependency
        ON dependency.dependent_task_id = staying.task_id
     WHERE dependency.prerequisite_task_id = ANY(v_purged_task_ids)
  )
  SELECT array_agg(deepest.task_id ORDER BY deepest.depth, deepest.task_id)
    INTO v_canceled_task_ids
    FROM (
      SELECT staying.task_id, max(staying.depth) AS depth
        FROM staying
       GROUP BY staying.task_id
    ) deepest;
  v_canceled_task_ids := coalesce(v_canceled_task_ids, '{}');
  v_deleted_task_ids := ARRAY(
    SELECT purged.task_id
      FROM unnest(v_purged_task_ids) purged(task_id)
     WHERE NOT purged.task_id = ANY(v_canceled_task_ids)
     ORDER BY purged.task_id
  );

  -- A purged member task counts as canceled for its group (ADR 0095). Every member is full-tier.
  -- The outcome trigger counts a canceled member, so this counts only the deleted ones.
  v_member_task_ids := ARRAY(
    SELECT member.task_id
      FROM workhorse.task_group_member member
     WHERE member.task_id = ANY(v_deleted_task_ids)
       AND member.outcome IS NULL
     ORDER BY member.task_id
  );

  DELETE FROM workhorse.enqueue_idempotency idempotency
   WHERE idempotency.task_id = ANY(v_deleted_task_ids);
  DELETE FROM workhorse.task_event event
   WHERE event.task_id = ANY(v_deleted_task_ids);
  DELETE FROM workhorse.attempt_history attempt
   WHERE attempt.task_id = ANY(v_deleted_task_ids);
  -- The restricting reference does not wait for the cascade from the dependent's delete, so the
  -- edges go first. An edge from a deleted task leads to a deleted dependent, or it is released
  -- and its dependent is terminal, as the pruning of released edges requires.
  DELETE FROM workhorse.task_dependency dependency
   WHERE dependency.dependent_task_id = ANY(v_deleted_task_ids);
  DELETE FROM workhorse.task_dependency dependency
   WHERE dependency.prerequisite_task_id = ANY(v_deleted_task_ids);
  DELETE FROM workhorse.task task
   WHERE task.id = ANY(v_deleted_task_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- The counters change after the deletes, so a callback a group enqueues on this queue survives.
  IF cardinality(v_member_task_ids) > 0 THEN
    PERFORM workhorse.count_task_group_outcomes_internal_v1(
      v_member_task_ids, array_fill('canceled'::text, ARRAY[cardinality(v_member_task_ids)])
    );
  END IF;
  -- The cancels follow the deletes for the same reason. Each one writes the canceled outcome whose
  -- trigger resolves the task's dependents and counts it for its group.
  FOREACH v_task_id IN ARRAY v_canceled_task_ids LOOP
    PERFORM workhorse.cancel_v1(v_task_id, NULL, 'queue purge');
  END LOOP;
  v_count := v_count + cardinality(v_canceled_task_ids);

  -- Fast-tier ready rows carry no events, and deleting the task cascades to the runtime row.
  -- The same order applies: every runtime row, then every task row, each in identity order.
  -- A fast-tier task is never a prerequisite. As above, every delete uses the identities that the
  -- first lock statement locked. A keyed task that commits between two deletes then keeps both its
  -- task row and its key row.
  v_fast_task_ids := ARRAY(
    SELECT locked.task_id
      FROM (
        SELECT fast.task_id
          FROM workhorse.fast_task_runtime fast
         WHERE fast.queue_name = p_queue_name AND fast.state = 'ready'
         ORDER BY fast.task_id
         FOR UPDATE
      ) locked
     ORDER BY locked.task_id
  );
  PERFORM 1
    FROM workhorse.task task
   WHERE task.id = ANY(v_fast_task_ids)
   ORDER BY task.id
   FOR UPDATE;
  DELETE FROM workhorse.enqueue_idempotency idempotency
   WHERE idempotency.task_id = ANY(v_fast_task_ids);
  DELETE FROM workhorse.attempt_history attempt
   WHERE attempt.task_id = ANY(v_fast_task_ids);
  DELETE FROM workhorse.task task
   WHERE task.id = ANY(v_fast_task_ids);
  GET DIAGNOSTICS v_fast_count = ROW_COUNT;
  RETURN v_count + v_fast_count;
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
  v_lease_at timestamptz;
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
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
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
    -- The lease starts from a clock sample taken after the row locks of this round. A locked row
    -- can make the pick wait for the update chain of a concurrent transaction, and a lease from
    -- the sample before that wait could already be over when the worker gets the task. Admission
    -- and the shard charge keep v_now, because the shard tokens were counted at that instant. The
    -- key and budget buckets refill from their stored rows, so they charge at the lease instant.
    -- The foreign key check of the claim event takes a key-share lock on each task row, and that
    -- lock can wait. The claim takes the same lock before the sample, in identity order, so the
    -- check later finds it held and writes nothing more. The key bucket charge below can still
    -- wait after the sample.
    PERFORM 1 FROM workhorse.task task
     WHERE task.id = ANY(v_picked)
     ORDER BY task.id
     FOR KEY SHARE;
    v_lease_at := clock_timestamp();
    v_expires := v_lease_at + make_interval(secs => p_lease_ms::double precision / 1000.0);
    WITH activated AS (
      UPDATE workhorse.task_runtime runtime
         SET state = 'active', fence_token = v_fences[array_position(v_picked, runtime.task_id)],
             worker_id = p_worker_id,
             acquired_at = v_lease_at, heartbeat_at = v_lease_at, expires_at = v_expires,
             ready_at = NULL, sequence = NULL, wait_name = NULL,
             attempt_started_at = COALESCE(runtime.attempt_started_at, v_lease_at),
             attempt_timeout_at = CASE
               WHEN task.execution_timeout_ms IS NULL THEN NULL
               ELSE v_lease_at + make_interval(secs =>
                 (task.execution_timeout_ms - runtime.execution_used_ms)::double precision / 1000.0)
             END,
             error = NULL, updated_at = v_lease_at,
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
      SELECT DISTINCT p_queue_name, 'key', claimed.bucket_key, v_rate_policy.per_key_burst, v_lease_at
        FROM unnest(v_keys) AS claimed(bucket_key)
       WHERE claimed.bucket_key IS NOT NULL
      ON CONFLICT DO NOTHING;
      UPDATE workhorse.rate_limit_bucket bucket
         SET tokens = LEAST(
               v_rate_policy.per_key_burst::numeric,
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM v_lease_at - bucket.refilled_at) * 1000
               ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric
             ) - started.starts,
             refilled_at = GREATEST(v_lease_at, bucket.refilled_at)
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
      SELECT budget.budget_name, budget.rate_burst, v_lease_at
        FROM workhorse.budget budget
       WHERE budget.rate_limit IS NOT NULL AND budget.budget_name = ANY(v_budgets)
      ON CONFLICT DO NOTHING;
      UPDATE workhorse.budget_bucket bucket
         SET tokens = LEAST(
               budget.rate_burst::numeric,
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM v_lease_at - bucket.refilled_at) * 1000
               ) * budget.rate_limit::numeric / budget.rate_interval_ms::numeric
             ) - started.starts,
             refilled_at = GREATEST(v_lease_at, bucket.refilled_at)
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
  v_lease_at timestamptz;
  v_control workhorse.queue_control%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
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

  -- The lease starts from a clock sample taken after the row lock. The lock can wait for the update
  -- chain of a concurrent transaction, and a lease from the sample before that wait could already
  -- be over when the worker gets the task. The budget bucket refills from its stored row, so it
  -- charges at the same instant.
  -- The foreign key check of the claim event takes a key-share lock on the task row, and that lock
  -- can wait. The claim takes the same lock before the sample, so the check later finds it held.
  PERFORM 1 FROM workhorse.task task WHERE task.id = v_task_id FOR KEY SHARE;
  v_lease_at := clock_timestamp();
  v_expires := v_lease_at + make_interval(secs => p_lease_ms::double precision / 1000.0);
  UPDATE workhorse.task_runtime runtime
     SET state = 'active', fence_token = v_fence, worker_id = p_worker_id,
         acquired_at = v_lease_at, heartbeat_at = v_lease_at, expires_at = v_expires,
         ready_at = NULL, sequence = NULL, wait_name = NULL,
         attempt_started_at = COALESCE(runtime.attempt_started_at, v_lease_at),
         attempt_timeout_at = CASE
           WHEN task.execution_timeout_ms IS NULL THEN NULL
           ELSE v_lease_at + make_interval(secs =>
             (task.execution_timeout_ms - runtime.execution_used_ms)::double precision / 1000.0)
         END,
         error = NULL, updated_at = v_lease_at
    FROM workhorse.task task
   WHERE runtime.task_id = v_task_id AND runtime.state = 'ready' AND task.id = runtime.task_id
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
  RETURNING runtime.* INTO v_runtime;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_runtime.budget_name IS NOT NULL THEN
    PERFORM * FROM workhorse.budget_bucket_v1(v_runtime.budget_name, v_lease_at, true);
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

-- Add up to 1,000 new tasks to a group. The add reads the member count from the shard rows, so it
-- locks all of them, then the group row. The group row lock serializes the add with every other
-- change to the group, and the member limit is checked under that lock. Every request is an
-- ordinary enqueue request without debounce or throttle. A task joins only when this call enqueues
-- it: an enqueue idempotency hit must return a task that is already a member of this group.
--
-- After the seal, only a running member task can add tasks: the caller passes that member's task
-- identity, worker, and fence token. The member is not terminal, so its shard is pending and the
-- group cannot finish first.
--
-- A member add locks the member's runtime row first, with the runtime rows of the prerequisites in
-- identity order, before the shard rows and the group row. Completion, cancellation, purge, and
-- lease recovery change or delete that row first too, so they wait for the add, or the add waits
-- for them and then sees their result. The
-- add then checks, as save_checkpoint_v2 does, that the caller owns the active lease and that the
-- lease, the deadline, and the attempt timeout have not passed and no cancel was requested. It
-- checks the times after its last lock, so a wait for the group row cannot make them stale.
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

  -- Outside read committed, lock_queue_tiers_v1 creates and locks the queue_control row of each
  -- queue. A purge creates the row of its queue before it locks the tasks of that queue, so the add
  -- takes the tier locks before any row lock. Otherwise it could hold a prerequisite that the purge
  -- waits for while it waits for the uncommitted row of the purge.
  PERFORM workhorse.lock_queue_tiers_v1(ARRAY(
    SELECT DISTINCT candidate->>'queue' FROM jsonb_array_elements(p_requests) candidate
  ));

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
