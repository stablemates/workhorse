-- workhorse-migration: {"kind":"additive"}

-- Add task groups with completion callbacks (SM-1231, ADR 0095).

-- A task group is a set of full-tier tasks that Workhorse tracks as one unit. When the group is
-- sealed and every member task is finished, Workhorse enqueues its onFinish, onSuccess, or
-- onFailure callback task. task_group holds one row for each group with its counters, and
-- task_group_member holds one row for each member task. task_group_callback links a callback task
-- to its group, and task_group_event records the group history. No column supports nesting.
--
-- A statement trigger on task_outcome counts each member outcome in the transaction that writes
-- it. purge_queue_internal_v1 counts a purged member as canceled. The terminal_storage routine
-- keeps member tasks while their group is not finished, gains the task_groups phase, and deletes a
-- finished group after its callback tasks are terminal.

-- Task groups (ADR 0095). A task group is a set of full-tier tasks that Workhorse tracks as one
-- unit. Each change to a group locks its row before it reads or changes the counters: an add, a
-- seal, a cancel, a member outcome, and a purge of a member task. Only the change from sealed to
-- finished enqueues the callbacks, so each callback runs one time.
CREATE TABLE IF NOT EXISTS workhorse.task_group (
  id uuid PRIMARY KEY DEFAULT workhorse.uuid_v7_v1(),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'sealed', 'finished')),
  result text CHECK (result IN ('succeeded', 'failed')),
  total_count integer NOT NULL DEFAULT 0 CHECK (total_count BETWEEN 0 AND 100000),
  succeeded_count integer NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  canceled_count integer NOT NULL DEFAULT 0 CHECK (canceled_count >= 0),
  -- The enqueue request of each callback, exactly as the caller gave it.
  on_finish jsonb CHECK (on_finish IS NULL OR jsonb_typeof(on_finish) = 'object'),
  on_success jsonb CHECK (on_success IS NULL OR jsonb_typeof(on_success) = 'object'),
  on_failure jsonb CHECK (on_failure IS NULL OR jsonb_typeof(on_failure) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed_at timestamptz,
  finished_at timestamptz,
  canceled_at timestamptz,
  canceled_by text CHECK (
    canceled_by IS NULL OR (canceled_by <> '' AND char_length(canceled_by) <= 200)
  ),
  cancel_reason text CHECK (
    cancel_reason IS NULL OR (cancel_reason <> '' AND char_length(cancel_reason) <= 2000)
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_group_counts_check CHECK (
    succeeded_count + failed_count + canceled_count <= total_count
  ),
  CONSTRAINT task_group_state_shape_check CHECK (
    (state = 'open' AND sealed_at IS NULL AND finished_at IS NULL AND result IS NULL
      AND canceled_at IS NULL)
    OR (state = 'sealed' AND sealed_at IS NOT NULL AND finished_at IS NULL AND result IS NULL)
    OR (state = 'finished' AND sealed_at IS NOT NULL AND finished_at IS NOT NULL
      AND result IS NOT NULL
      AND succeeded_count + failed_count + canceled_count = total_count)
  ),
  CONSTRAINT task_group_cancellation_check CHECK (
    (canceled_at IS NULL AND canceled_by IS NULL AND cancel_reason IS NULL)
    OR (canceled_at IS NOT NULL AND canceled_by IS NOT NULL AND cancel_reason IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS task_group_created_idx
  ON workhorse.task_group (created_at, id);
CREATE INDEX IF NOT EXISTS task_group_sealed_idx
  ON workhorse.task_group (sealed_at, id) WHERE state = 'sealed';
CREATE INDEX IF NOT EXISTS task_group_finished_idx
  ON workhorse.task_group (finished_at, id) WHERE state = 'finished';

-- One row for each member task. The task reference has no foreign key: a purge deletes a member
-- task that is not terminal, and the row then keeps the canceled outcome the purge counted. A task
-- is a member of one group at most. outcome is the outcome the group counted for the member.
CREATE TABLE IF NOT EXISTS workhorse.task_group_member (
  task_id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES workhorse.task_group(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100000),
  outcome text CHECK (outcome IN ('succeeded', 'failed', 'canceled')),
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  counted_at timestamptz,
  CONSTRAINT task_group_member_position_key UNIQUE (group_id, position),
  CONSTRAINT task_group_member_counted_check CHECK ((outcome IS NULL) = (counted_at IS NULL))
);
CREATE INDEX IF NOT EXISTS task_group_member_pending_idx
  ON workhorse.task_group_member (group_id, task_id) WHERE outcome IS NULL;

-- One row for each callback task a finished group enqueued. A callback task is not a member task.
CREATE TABLE IF NOT EXISTS workhorse.task_group_callback (
  task_id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES workhorse.task_group(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('on_finish', 'on_success', 'on_failure')),
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_group_callback_kind_key UNIQUE (group_id, kind)
);

-- Append-only group history. A group's events live as long as the group.
CREATE TABLE IF NOT EXISTS workhorse.task_group_event (
  event_id uuid PRIMARY KEY DEFAULT workhorse.uuid_v7_v1(),
  group_id uuid NOT NULL REFERENCES workhorse.task_group(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'sealed', 'canceled', 'finished', 'callback_enqueued', 'callback_failed',
    'counter_repaired'
  )),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS task_group_event_group_time_idx
  ON workhorse.task_group_event (group_id, occurred_at, event_id);

-- The member limit of one task group.
CREATE OR REPLACE FUNCTION workhorse.task_group_member_limit_v1()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 100000;
$$;

CREATE OR REPLACE FUNCTION workhorse.get_task_group_v1(p_group_id uuid)
RETURNS TABLE (
  group_id uuid, state text, result text, total integer, succeeded integer, failed integer,
  canceled integer, pending integer, created_at timestamptz, sealed_at timestamptz,
  finished_at timestamptz, canceled_at timestamptz, canceled_by text, cancel_reason text,
  callbacks jsonb
)
LANGUAGE sql
STABLE
AS $$
  SELECT task_group.id, task_group.state, task_group.result, task_group.total_count,
         task_group.succeeded_count, task_group.failed_count, task_group.canceled_count,
         task_group.total_count - task_group.succeeded_count - task_group.failed_count
           - task_group.canceled_count,
         task_group.created_at, task_group.sealed_at, task_group.finished_at,
         task_group.canceled_at, task_group.canceled_by, task_group.cancel_reason,
         (
           SELECT COALESCE(jsonb_object_agg(requested.kind, jsonb_build_object(
                    'taskId', callback.task_id
                  ) ORDER BY requested.kind), '{}'::jsonb)
             FROM (VALUES
               ('on_finish', task_group.on_finish),
               ('on_success', task_group.on_success),
               ('on_failure', task_group.on_failure)
             ) requested(kind, request)
             LEFT JOIN workhorse.task_group_callback callback
               ON callback.group_id = task_group.id AND callback.kind = requested.kind
            WHERE requested.request IS NOT NULL
         )
    FROM workhorse.task_group task_group
   WHERE task_group.id = p_group_id;
$$;

-- The group a task is a member of, or the group whose callback the task is.
CREATE OR REPLACE FUNCTION workhorse.task_group_for_task_v1(p_task_id uuid)
RETURNS TABLE (
  role text, callback_kind text, group_id uuid, state text, result text, total integer,
  succeeded integer, failed integer, canceled integer, pending integer,
  created_at timestamptz, sealed_at timestamptz, finished_at timestamptz,
  canceled_at timestamptz, canceled_by text, cancel_reason text, callbacks jsonb
)
LANGUAGE sql
STABLE
AS $$
  SELECT 'member'::text, NULL::text, snapshot.*
    FROM workhorse.task_group_member member
    CROSS JOIN LATERAL workhorse.get_task_group_v1(member.group_id) snapshot
   WHERE member.task_id = p_task_id
  UNION ALL
  SELECT 'callback'::text, callback.kind, snapshot.*
    FROM workhorse.task_group_callback callback
    CROSS JOIN LATERAL workhorse.get_task_group_v1(callback.group_id) snapshot
   WHERE callback.task_id = p_task_id;
$$;

CREATE OR REPLACE FUNCTION workhorse.list_task_group_members_v1(
  p_group_id uuid, p_after_position integer, p_limit integer
) RETURNS TABLE (
  member_position integer, task_id uuid, queue_name text, task_type text, state text, outcome text,
  added_at timestamptz, counted_at timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_group_id IS NULL THEN RAISE EXCEPTION 'task group identity is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'task group member limit must be between 1 and 1000';
  END IF;
  RETURN QUERY
    SELECT member.position, member.task_id, task.queue_name, task.task_type,
           COALESCE(runtime.state, outcome.state), member.outcome, member.added_at,
           member.counted_at
      FROM workhorse.task_group_member member
      LEFT JOIN workhorse.task task ON task.id = member.task_id
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = member.task_id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = member.task_id
     WHERE member.group_id = p_group_id
       AND member.position > COALESCE(p_after_position, 0)
     ORDER BY member.position
     LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.list_task_group_events_v1(p_group_id uuid, p_limit integer)
RETURNS TABLE (event_id uuid, event_type text, details jsonb, occurred_at timestamptz)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_group_id IS NULL THEN RAISE EXCEPTION 'task group identity is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'task group event limit must be between 1 and 1000';
  END IF;
  RETURN QUERY
    SELECT event.event_id, event.event_type, event.details, event.occurred_at
      FROM workhorse.task_group_event event
     WHERE event.group_id = p_group_id
     ORDER BY event.occurred_at, event.event_id
     LIMIT p_limit;
END;
$$;

-- Finish a sealed group whose every member task is finished, and enqueue its callbacks in the same
-- transaction. The caller holds the group row lock. A callback that cannot be enqueued records a
-- callback_failed event instead of failing the transaction that wrote the last member outcome.
CREATE OR REPLACE FUNCTION workhorse.finish_task_group_internal_v1(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_group workhorse.task_group%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_kinds text[];
  v_requests jsonb[];
  v_index integer;
  v_task_id uuid;
BEGIN
  UPDATE workhorse.task_group task_group
     SET state = 'finished',
         result = CASE WHEN task_group.succeeded_count = task_group.total_count
           THEN 'succeeded' ELSE 'failed' END,
         finished_at = v_now,
         updated_at = v_now
   WHERE task_group.id = p_group_id
     AND task_group.state = 'sealed'
     AND task_group.succeeded_count + task_group.failed_count + task_group.canceled_count
       = task_group.total_count
  RETURNING task_group.* INTO v_group;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO workhorse.task_group_event(group_id, event_type, details, occurred_at)
  VALUES (p_group_id, 'finished', jsonb_build_object(
    'result', v_group.result, 'total', v_group.total_count,
    'succeeded', v_group.succeeded_count, 'failed', v_group.failed_count,
    'canceled', v_group.canceled_count
  ), v_now);

  v_kinds := ARRAY['on_finish', CASE WHEN v_group.result = 'succeeded'
    THEN 'on_success' ELSE 'on_failure' END];
  v_requests := ARRAY[v_group.on_finish, CASE WHEN v_group.result = 'succeeded'
    THEN v_group.on_success ELSE v_group.on_failure END];
  FOR v_index IN 1..2 LOOP
    CONTINUE WHEN v_requests[v_index] IS NULL;
    BEGIN
      SELECT enqueued.task_id INTO STRICT v_task_id
        FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_requests[v_index])) enqueued;
      INSERT INTO workhorse.task_group_callback(task_id, group_id, kind, enqueued_at)
      VALUES (v_task_id, p_group_id, v_kinds[v_index], v_now);
      INSERT INTO workhorse.task_group_event(group_id, event_type, details)
      VALUES (p_group_id, 'callback_enqueued', jsonb_build_object(
        'kind', v_kinds[v_index], 'taskId', v_task_id
      ));
    EXCEPTION WHEN OTHERS THEN
      -- A lost race or a canceled statement belongs to the whole transaction.
      IF SQLSTATE LIKE '40%' OR SQLSTATE LIKE '57%' THEN RAISE; END IF;
      INSERT INTO workhorse.task_group_event(group_id, event_type, details)
      VALUES (p_group_id, 'callback_failed', jsonb_build_object(
        'kind', v_kinds[v_index], 'code', SQLSTATE, 'message', SQLERRM
      ));
    END;
  END LOOP;
END;
$$;

-- Count the outcomes of member tasks. Each group row is locked in identity order before its
-- counters change. A member is counted one time: its membership row records the counted outcome.
CREATE OR REPLACE FUNCTION workhorse.count_task_group_outcomes_internal_v1(
  p_task_ids uuid[], p_states text[]
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_group_ids uuid[];
  v_group_id uuid;
  v_group workhorse.task_group%ROWTYPE;
  v_succeeded integer;
  v_failed integer;
  v_canceled integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  v_group_ids := ARRAY(
    SELECT DISTINCT member.group_id FROM workhorse.task_group_member member
     WHERE member.task_id = ANY(p_task_ids) AND member.outcome IS NULL
     ORDER BY 1
  );
  IF cardinality(v_group_ids) = 0 THEN RETURN; END IF;
  PERFORM 1 FROM workhorse.task_group task_group
   WHERE task_group.id = ANY(v_group_ids)
   ORDER BY task_group.id FOR UPDATE;

  FOREACH v_group_id IN ARRAY v_group_ids LOOP
    WITH counted AS (
      UPDATE workhorse.task_group_member member
         SET outcome = input.state, counted_at = v_now
        FROM unnest(p_task_ids, p_states) input(task_id, state)
       WHERE member.task_id = input.task_id
         AND member.group_id = v_group_id
         AND member.outcome IS NULL
      RETURNING member.outcome
    )
    SELECT count(*) FILTER (WHERE counted.outcome = 'succeeded'),
           count(*) FILTER (WHERE counted.outcome = 'failed'),
           count(*) FILTER (WHERE counted.outcome = 'canceled')
      INTO v_succeeded, v_failed, v_canceled
      FROM counted;
    CONTINUE WHEN v_succeeded + v_failed + v_canceled = 0;
    UPDATE workhorse.task_group task_group
       SET succeeded_count = task_group.succeeded_count + v_succeeded,
           failed_count = task_group.failed_count + v_failed,
           canceled_count = task_group.canceled_count + v_canceled,
           updated_at = v_now
     WHERE task_group.id = v_group_id
    RETURNING task_group.* INTO v_group;
    IF v_group.state = 'sealed'
       AND v_group.succeeded_count + v_group.failed_count + v_group.canceled_count
         = v_group.total_count THEN
      PERFORM workhorse.finish_task_group_internal_v1(v_group_id);
    END IF;
  END LOOP;
END;
$$;

-- One firing per statement counts every member outcome the statement inserted, in the transaction
-- that writes the outcome. A retry writes no outcome, so it never counts a member. Most outcomes
-- belong to no group, so one probe of the membership key ends the firing before any lock. The
-- trigger name sorts after task_outcome_resolve_dependencies_insert, so a dependency cascade
-- settles its dependents before this firing locks a group row.
CREATE OR REPLACE FUNCTION workhorse.settle_task_group_outcomes_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_task_ids uuid[];
  v_states text[];
BEGIN
  SELECT array_agg(outcome.task_id ORDER BY outcome.task_id),
         array_agg(outcome.state ORDER BY outcome.task_id)
    INTO v_task_ids, v_states
    FROM new_outcomes outcome
   WHERE EXISTS (
           SELECT 1 FROM workhorse.task_group_member member
            WHERE member.task_id = outcome.task_id AND member.outcome IS NULL
         );
  IF v_task_ids IS NOT NULL THEN
    PERFORM workhorse.count_task_group_outcomes_internal_v1(v_task_ids, v_states);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER task_outcome_settle_task_groups_insert
  AFTER INSERT ON workhorse.task_outcome
  REFERENCING NEW TABLE AS new_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION workhorse.settle_task_group_outcomes_v1();

-- Add up to 1,000 new tasks to a group. The group row lock serializes the add with every other
-- change to the group, and the member limit is checked under that lock. Every request is an
-- ordinary enqueue request without debounce or throttle. A task joins only when this call enqueues
-- it: an enqueue idempotency hit must return a task that is already a member of this group.
--
-- After the seal, only a running member task can add tasks: the caller passes that member's task
-- identity, worker, and fence token. The member is not terminal, so the group cannot finish first.
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
  v_group workhorse.task_group%ROWTYPE;
  v_refusal text;
  v_fast_queue text;
  v_fast_ordinal integer;
  v_row record;
  v_member_group_id uuid;
  v_new_task_ids uuid[] := '{}';
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

  -- Completion, cancellation, and purge lock a runtime row before its group row. Lock the
  -- prerequisites of the requests first, so an add that names a member as a prerequisite takes the
  -- same order and cannot deadlock with that member's completion.
  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);
  SELECT * INTO v_group FROM workhorse.task_group task_group
   WHERE task_group.id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task group % does not exist', p_group_id; END IF;
  v_refusal := CASE
    WHEN v_group.canceled_at IS NOT NULL THEN 'canceled'
    WHEN v_group.state = 'finished' THEN 'finished'
    WHEN p_member_task_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM workhorse.task_group_member member
        JOIN workhorse.task_runtime runtime ON runtime.task_id = member.task_id
       WHERE member.task_id = p_member_task_id
         AND member.group_id = p_group_id
         AND runtime.state = 'active'
         AND runtime.worker_id = p_worker_id
         AND runtime.fence_token = p_fence_token
    ) THEN 'not_running_member'
    WHEN v_group.state = 'sealed' AND p_member_task_id IS NULL THEN 'sealed'
  END;
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1008',
      MESSAGE = 'the task group does not accept tasks',
      DETAIL = jsonb_build_object(
        'groupId', p_group_id, 'state', v_group.state, 'reason', v_refusal
      )::text;
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
        RAISE EXCEPTION USING
          ERRCODE = 'P1010',
          MESSAGE = 'enqueue idempotency returned a task that is not a member of the task group',
          DETAIL = jsonb_build_object(
            'groupId', p_group_id, 'taskId', v_row.task_id, 'ordinal', v_row.ordinal,
            'memberOf', v_member_group_id
          )::text;
      END IF;
    END IF;
    ordinal := v_row.ordinal;
    task_id := v_row.task_id;
    outcome := v_row.outcome;
    reason := v_row.reason;
    RETURN NEXT;
  END LOOP;

  IF cardinality(v_new_task_ids) = 0 THEN RETURN; END IF;
  IF v_group.total_count + cardinality(v_new_task_ids) > workhorse.task_group_member_limit_v1() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1009',
      MESSAGE = 'a task group accepts at most 100000 member tasks',
      DETAIL = jsonb_build_object(
        'groupId', p_group_id, 'limit', workhorse.task_group_member_limit_v1(),
        'total', v_group.total_count, 'requested', cardinality(v_new_task_ids)
      )::text;
  END IF;
  INSERT INTO workhorse.task_group_member(task_id, group_id, position, added_at)
  SELECT added.task_id, p_group_id, v_group.total_count + added.ordinality::integer, v_now
    FROM unnest(v_new_task_ids) WITH ORDINALITY added(task_id, ordinality);
  UPDATE workhorse.task_group task_group
     SET total_count = task_group.total_count + cardinality(v_new_task_ids),
         updated_at = v_now
   WHERE task_group.id = p_group_id;

  -- An enqueue can write an outcome at once, for example for a deadline in the past or a rejected
  -- prerequisite. That outcome came before the membership row, so the trigger did not count it.
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

-- Seal an open group. A group with no pending member finishes at once. Sealing a sealed or finished
-- group changes nothing.
CREATE OR REPLACE FUNCTION workhorse.seal_task_group_internal_v1(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_group workhorse.task_group%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_group FROM workhorse.task_group task_group
   WHERE task_group.id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task group % does not exist', p_group_id; END IF;
  IF v_group.state <> 'open' THEN RETURN; END IF;
  UPDATE workhorse.task_group task_group
     SET state = 'sealed', sealed_at = v_now, updated_at = v_now
   WHERE task_group.id = p_group_id;
  INSERT INTO workhorse.task_group_event(group_id, event_type, details, occurred_at)
  VALUES (p_group_id, 'sealed', jsonb_build_object('total', v_group.total_count), v_now);
  PERFORM workhorse.finish_task_group_internal_v1(p_group_id);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.seal_task_group_v1(p_group_id uuid)
RETURNS TABLE (
  group_id uuid, state text, result text, total integer, succeeded integer, failed integer,
  canceled integer, pending integer, created_at timestamptz, sealed_at timestamptz,
  finished_at timestamptz, canceled_at timestamptz, canceled_by text, cancel_reason text,
  callbacks jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_group_id IS NULL THEN RAISE EXCEPTION 'task group identity is required'; END IF;
  PERFORM workhorse.seal_task_group_internal_v1(p_group_id);
  RETURN QUERY SELECT * FROM workhorse.get_task_group_v1(p_group_id);
END;
$$;

-- Create a group with up to one callback of each kind, add the given requests, and optionally seal
-- it, all in one transaction. The SDK block form uses one call with p_seal. A callback request is an
-- ordinary enqueue request without enqueue idempotency, debounce, or throttle, because the enqueue
-- could then return a task that already exists. A trial enqueue that rolls back checks each
-- callback, so a request that cannot enqueue fails here and not when the last member finishes.
--
-- The function returns one row for each request. Without requests, it returns one row whose
-- ordinal, task, and outcome are null. On a contract mismatch, it creates nothing and returns the
-- mismatch row with a null group.
CREATE OR REPLACE FUNCTION workhorse.create_task_group_v1(
  p_callbacks jsonb DEFAULT '{}'::jsonb,
  p_requests jsonb DEFAULT '[]'::jsonb,
  p_seal boolean DEFAULT false
) RETURNS TABLE (group_id uuid, ordinal integer, task_id uuid, outcome text, reason text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_callbacks jsonb := COALESCE(p_callbacks, '{}'::jsonb);
  v_requests jsonb := COALESCE(p_requests, '[]'::jsonb);
  v_kind text;
  v_request jsonb;
  v_group_id uuid;
  v_contract_mismatch jsonb;
  v_offset integer := 0;
  v_count integer;
  v_row record;
  v_sentinel constant text := 'workhorse: task group callback checked';
BEGIN
  IF jsonb_typeof(v_callbacks) <> 'object'
     OR v_callbacks - ARRAY['onFinish', 'onSuccess', 'onFailure'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'task group callbacks must be an object with only onFinish, onSuccess, and onFailure';
  END IF;
  IF jsonb_typeof(v_requests) <> 'array' THEN RAISE EXCEPTION 'requests must be a JSON array'; END IF;
  v_count := jsonb_array_length(v_requests);
  IF v_count > workhorse.task_group_member_limit_v1() THEN
    RAISE EXCEPTION 'a task group accepts at most 100000 member tasks';
  END IF;
  FOR v_kind, v_request IN SELECT key, value FROM jsonb_each(v_callbacks) LOOP
    CONTINUE WHEN v_request = 'null'::jsonb;
    IF jsonb_typeof(v_request) <> 'object' THEN
      RAISE EXCEPTION 'task group callback % must be an enqueue request object', v_kind;
    END IF;
    IF v_request ? 'idempotency' OR v_request ? 'debounce' OR v_request ? 'throttle' THEN
      RAISE EXCEPTION 'task group callback % cannot use enqueue idempotency, debounce, or throttle',
        v_kind;
    END IF;
    BEGIN
      PERFORM workhorse.enqueue_batch_v1(jsonb_build_array(v_request));
      RAISE EXCEPTION '%', v_sentinel;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> v_sentinel THEN RAISE; END IF;
    END;
  END LOOP;

  -- Report a contract mismatch of a member or a callback before anything is created, so a retry
  -- creates one group and stores each callback under its current contract version.
  SELECT jsonb_build_object(
           'taskTypes', jsonb_agg(mismatch.task_type ORDER BY mismatch.task_type COLLATE "C")
         )
    INTO v_contract_mismatch
    FROM (
      SELECT DISTINCT request->>'type' AS task_type
        FROM (
          SELECT member.request FROM jsonb_array_elements(v_requests) member(request)
          UNION ALL
          SELECT callback.value FROM jsonb_each(v_callbacks) callback
           WHERE jsonb_typeof(callback.value) = 'object'
        ) input(request)
        JOIN workhorse.contract_policy policy ON policy.task_type = request->>'type'
       WHERE request ? 'contractVersion'
         AND request->>'contractVersion' IS DISTINCT FROM policy.current_version
    ) mismatch;
  IF jsonb_typeof(v_contract_mismatch->'taskTypes') = 'array' THEN
    RETURN QUERY SELECT NULL::uuid, 0, NULL::uuid, 'contract_mismatch'::text,
                        v_contract_mismatch::text;
    RETURN;
  END IF;

  INSERT INTO workhorse.task_group(on_finish, on_success, on_failure)
  VALUES (
    NULLIF(v_callbacks->'onFinish', 'null'::jsonb),
    NULLIF(v_callbacks->'onSuccess', 'null'::jsonb),
    NULLIF(v_callbacks->'onFailure', 'null'::jsonb)
  )
  RETURNING id INTO v_group_id;
  INSERT INTO workhorse.task_group_event(group_id, event_type, details)
  VALUES (v_group_id, 'created', jsonb_build_object(
    'callbacks', COALESCE((
      SELECT jsonb_agg(key ORDER BY key) FROM jsonb_each(v_callbacks) WHERE value <> 'null'::jsonb
    ), '[]'::jsonb)
  ));

  -- Each add holds at most 1,000 requests, the limit of one add call.
  WHILE v_offset < v_count LOOP
    FOR v_row IN
      SELECT added.* FROM workhorse.add_task_group_members_v1(
        v_group_id,
        (SELECT jsonb_agg(input.request ORDER BY input.ordinality)
           FROM jsonb_array_elements(v_requests) WITH ORDINALITY input(request, ordinality)
          WHERE input.ordinality > v_offset AND input.ordinality <= v_offset + 1000)
      ) added
    LOOP
      IF v_row.outcome = 'contract_mismatch' THEN
        RAISE EXCEPTION 'task group contract policy changed while its tasks were added';
      END IF;
      RETURN QUERY SELECT v_group_id, v_offset + v_row.ordinal, v_row.task_id, v_row.outcome,
                          v_row.reason;
    END LOOP;
    v_offset := v_offset + 1000;
  END LOOP;

  IF p_seal THEN PERFORM workhorse.seal_task_group_internal_v1(v_group_id); END IF;
  IF v_count = 0 THEN
    RETURN QUERY SELECT v_group_id, NULL::integer, NULL::uuid, NULL::text, NULL::text;
  END IF;
END;
$$;

-- Seal an open group, so no task can join it after this call, not even from a running member task.
-- Then cancel every member task that is not terminal. The canceled members count as not succeeded,
-- so the group finishes as usual. A finished group stays unchanged.
--
-- The runtime rows of live members are locked before the group row, in the order that completion
-- and purge lock them, so a member that finishes at the same time cannot deadlock with the cancel.
CREATE OR REPLACE FUNCTION workhorse.cancel_task_group_v1(
  p_group_id uuid,
  p_requested_by text,
  p_reason text,
  p_request_id text
) RETURNS TABLE (
  group_id uuid, state text, result text, total integer, succeeded integer, failed integer,
  canceled integer, pending integer, created_at timestamptz, sealed_at timestamptz,
  finished_at timestamptz, canceled_at timestamptz, canceled_by text, cancel_reason text,
  callbacks jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_group workhorse.task_group%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_request_id_length integer;
  v_request_id_preview text;
  v_task_id uuid;
  v_canceled integer := 0;
BEGIN
  IF p_group_id IS NULL THEN RAISE EXCEPTION 'task group identity is required'; END IF;
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;
  v_request_id_length := char_length(p_request_id);
  v_request_id_preview := CASE
    WHEN v_request_id_length <= 4 THEN repeat('•', v_request_id_length)
    WHEN v_request_id_length <= 8 THEN left(p_request_id, 2) || '…' || right(p_request_id, 2)
    ELSE left(p_request_id, 8) || '…' || right(p_request_id, 4)
  END;

  PERFORM 1
    FROM workhorse.task_group_member member
    JOIN workhorse.task_runtime runtime ON runtime.task_id = member.task_id
   WHERE member.group_id = p_group_id AND member.outcome IS NULL
   ORDER BY runtime.task_id
   FOR UPDATE OF runtime;
  SELECT * INTO v_group FROM workhorse.task_group task_group
   WHERE task_group.id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_group.state = 'finished' THEN
    RETURN QUERY SELECT * FROM workhorse.get_task_group_v1(p_group_id);
    RETURN;
  END IF;

  IF v_group.state = 'open' THEN
    UPDATE workhorse.task_group task_group
       SET state = 'sealed', sealed_at = v_now, updated_at = v_now
     WHERE task_group.id = p_group_id;
    INSERT INTO workhorse.task_group_event(group_id, event_type, details, occurred_at)
    VALUES (p_group_id, 'sealed', jsonb_build_object('total', v_group.total_count), v_now);
  END IF;
  IF v_group.canceled_at IS NULL THEN
    UPDATE workhorse.task_group task_group
       SET canceled_at = v_now, canceled_by = p_requested_by, cancel_reason = p_reason,
           updated_at = v_now
     WHERE task_group.id = p_group_id;
  END IF;

  FOR v_task_id IN
    SELECT member.task_id
      FROM workhorse.task_group_member member
     WHERE member.group_id = p_group_id
       AND member.outcome IS NULL
       AND EXISTS (
             SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.task_id = member.task_id
           )
     ORDER BY member.task_id
  LOOP
    PERFORM workhorse.cancel_v1(v_task_id, p_requested_by, p_reason);
    v_canceled := v_canceled + 1;
  END LOOP;

  INSERT INTO workhorse.task_group_event(group_id, event_type, details)
  VALUES (p_group_id, 'canceled', jsonb_build_object(
    'requested_by', p_requested_by,
    'request_reason', p_reason,
    'request_id_preview', v_request_id_preview,
    'request_id_digest', left(encode(sha256(convert_to(p_request_id, 'UTF8')), 'hex'), 12),
    'request_id_length', v_request_id_length,
    'members', v_canceled
  ));
  -- An empty group, or a group whose members were all finished, finishes here. Otherwise the last
  -- canceled member finishes it, possibly after its handler acknowledges the cancellation.
  PERFORM workhorse.finish_task_group_internal_v1(p_group_id);
  RETURN QUERY SELECT * FROM workhorse.get_task_group_v1(p_group_id);
END;
$$;

-- Groups whose counters disagree with their member outcomes, in group identity order. A member is
-- finished when its outcome row exists, or when its task row is gone, which only a purge of a
-- member that was not terminal can do. A sealed group whose members are all finished also drifts:
-- its callbacks are not enqueued.
CREATE OR REPLACE FUNCTION workhorse.list_task_group_drift_v1(p_limit integer)
RETURNS TABLE (
  group_id uuid, state text, recorded_total integer, recorded_succeeded integer,
  recorded_failed integer, recorded_canceled integer, total integer, succeeded integer,
  failed integer, canceled integer, pending integer, action text
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'task group drift limit must be between 1 and 10000';
  END IF;
  RETURN QUERY
    SELECT task_group.id, task_group.state, task_group.total_count, task_group.succeeded_count,
           task_group.failed_count, task_group.canceled_count, actual.total, actual.succeeded,
           actual.failed, actual.canceled,
           actual.total - actual.succeeded - actual.failed - actual.canceled,
           CASE WHEN task_group.state = 'sealed'
                 AND actual.total = actual.succeeded + actual.failed + actual.canceled
             THEN 'finished' ELSE 'recounted' END
      FROM workhorse.task_group task_group
      CROSS JOIN LATERAL (
        SELECT count(*)::integer AS total,
               (count(*) FILTER (WHERE member_state.state = 'succeeded'))::integer AS succeeded,
               (count(*) FILTER (WHERE member_state.state = 'failed'))::integer AS failed,
               (count(*) FILTER (WHERE member_state.state = 'canceled'))::integer AS canceled
          FROM workhorse.task_group_member member
          CROSS JOIN LATERAL (
            SELECT COALESCE(
                     member.outcome,
                     (SELECT task_outcome.state FROM workhorse.task_outcome task_outcome
                       WHERE task_outcome.task_id = member.task_id),
                     CASE WHEN NOT EXISTS (
                       SELECT 1 FROM workhorse.task task WHERE task.id = member.task_id
                     ) THEN 'canceled' END
                   ) AS state
          ) member_state
         WHERE member.group_id = task_group.id
      ) actual
     WHERE task_group.state <> 'finished'
       AND (
         actual.total <> task_group.total_count
         OR actual.succeeded <> task_group.succeeded_count
         OR actual.failed <> task_group.failed_count
         OR actual.canceled <> task_group.canceled_count
         OR (task_group.state = 'sealed'
           AND actual.total = actual.succeeded + actual.failed + actual.canceled)
       )
     ORDER BY task_group.id
     LIMIT p_limit;
END;
$$;

-- Recount one group from its member outcomes under the group row lock, and finish it when it is
-- sealed and no member is pending. Returns no row when the group needed no change.
CREATE OR REPLACE FUNCTION workhorse.repair_task_group_internal_v1(
  p_group_id uuid, p_details jsonb
) RETURNS TABLE (group_id uuid, recorded_pending integer, pending integer, action text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_group workhorse.task_group%ROWTYPE;
  v_total integer;
  v_succeeded integer;
  v_failed integer;
  v_canceled integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_group FROM workhorse.task_group task_group
   WHERE task_group.id = p_group_id FOR UPDATE;
  IF NOT FOUND OR v_group.state = 'finished' THEN RETURN; END IF;

  UPDATE workhorse.task_group_member member
     SET outcome = COALESCE(
           (SELECT task_outcome.state FROM workhorse.task_outcome task_outcome
             WHERE task_outcome.task_id = member.task_id),
           'canceled'
         ),
         counted_at = v_now
   WHERE member.group_id = p_group_id
     AND member.outcome IS NULL
     AND NOT EXISTS (
           SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.task_id = member.task_id
         )
     AND (
       EXISTS (SELECT 1 FROM workhorse.task_outcome task_outcome
                WHERE task_outcome.task_id = member.task_id)
       OR NOT EXISTS (SELECT 1 FROM workhorse.task task WHERE task.id = member.task_id)
     );
  SELECT count(*)::integer,
         (count(*) FILTER (WHERE member.outcome = 'succeeded'))::integer,
         (count(*) FILTER (WHERE member.outcome = 'failed'))::integer,
         (count(*) FILTER (WHERE member.outcome = 'canceled'))::integer
    INTO v_total, v_succeeded, v_failed, v_canceled
    FROM workhorse.task_group_member member
   WHERE member.group_id = p_group_id;

  IF v_total = v_group.total_count AND v_succeeded = v_group.succeeded_count
     AND v_failed = v_group.failed_count AND v_canceled = v_group.canceled_count
     AND NOT (v_group.state = 'sealed' AND v_total = v_succeeded + v_failed + v_canceled) THEN
    RETURN;
  END IF;
  UPDATE workhorse.task_group task_group
     SET total_count = v_total, succeeded_count = v_succeeded, failed_count = v_failed,
         canceled_count = v_canceled, updated_at = v_now
   WHERE task_group.id = p_group_id;
  INSERT INTO workhorse.task_group_event(group_id, event_type, details, occurred_at)
  VALUES (p_group_id, 'counter_repaired', COALESCE(p_details, '{}'::jsonb) || jsonb_build_object(
    'recorded', jsonb_build_object(
      'total', v_group.total_count, 'succeeded', v_group.succeeded_count,
      'failed', v_group.failed_count, 'canceled', v_group.canceled_count
    ),
    'counted', jsonb_build_object(
      'total', v_total, 'succeeded', v_succeeded, 'failed', v_failed, 'canceled', v_canceled
    )
  ), v_now);
  group_id := p_group_id;
  recorded_pending := v_group.total_count - v_group.succeeded_count - v_group.failed_count
    - v_group.canceled_count;
  pending := v_total - v_succeeded - v_failed - v_canceled;
  action := 'recounted';
  IF v_group.state = 'sealed' AND pending = 0 THEN
    PERFORM workhorse.finish_task_group_internal_v1(p_group_id);
    action := 'finished';
  END IF;
  RETURN NEXT;
END;
$$;

-- Repair the drifted groups list_task_group_drift_v1 reports, on an operator's request. Each
-- counter_repaired event records the actor and reason, and a preview, digest, and length of the
-- request id rather than the id itself.
CREATE OR REPLACE FUNCTION workhorse.repair_task_group_drift_v1(
  p_limit integer,
  p_requested_by text,
  p_reason text,
  p_request_id text
) RETURNS TABLE (group_id uuid, recorded_pending integer, pending integer, action text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_request_id_length integer;
  v_details jsonb;
  v_group_id uuid;
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
  v_request_id_length := char_length(p_request_id);
  v_details := jsonb_build_object(
    'requested_by', p_requested_by,
    'request_reason', p_reason,
    'request_id_preview', CASE
      WHEN v_request_id_length <= 4 THEN repeat('•', v_request_id_length)
      WHEN v_request_id_length <= 8 THEN left(p_request_id, 2) || '…' || right(p_request_id, 2)
      ELSE left(p_request_id, 8) || '…' || right(p_request_id, 4)
    END,
    'request_id_digest', left(encode(sha256(convert_to(p_request_id, 'UTF8')), 'hex'), 12),
    'request_id_length', v_request_id_length
  );
  FOR v_group_id IN SELECT drift.group_id FROM workhorse.list_task_group_drift_v1(p_limit) drift
  LOOP
    RETURN QUERY SELECT * FROM workhorse.repair_task_group_internal_v1(v_group_id, v_details);
  END LOOP;
END;
$$;

-- The maintenance part of task groups, run by the terminal_storage routine. It finishes a sealed
-- group whose members are all finished but whose callbacks are not enqueued. Then it deletes a
-- finished group, with its membership, callback, and event rows, after its callback tasks are
-- terminal and its finish is older than the outcome cutoff. It never deletes an open or sealed
-- group. A healthy sealed group stops each probe at its first live member.
CREATE OR REPLACE FUNCTION workhorse.maintain_task_groups_v1(
  p_outcome_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_group_id uuid;
  v_repaired integer := 0;
  v_deleted integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'task group maintenance limit must be between 1 and 100000';
  END IF;
  FOR v_group_id IN
    SELECT task_group.id
      FROM workhorse.task_group task_group
     WHERE task_group.state = 'sealed'
       AND NOT EXISTS (
             SELECT 1
               FROM workhorse.task_group_member member
               JOIN workhorse.task_runtime runtime ON runtime.task_id = member.task_id
              WHERE member.group_id = task_group.id AND member.outcome IS NULL
           )
     ORDER BY task_group.sealed_at, task_group.id
     LIMIT p_limit
  LOOP
    v_repaired := v_repaired + (
      SELECT count(*)::integer FROM workhorse.repair_task_group_internal_v1(
        v_group_id, jsonb_build_object('requested_by', 'maintenance')
      )
    );
  END LOOP;

  IF p_outcome_before IS NOT NULL THEN
    WITH candidates AS (
      SELECT task_group.id
        FROM workhorse.task_group task_group
       WHERE task_group.state = 'finished'
         AND task_group.finished_at < p_outcome_before
         AND NOT EXISTS (
               SELECT 1
                 FROM workhorse.task_group_callback callback
                WHERE callback.group_id = task_group.id
                  AND (
                    EXISTS (SELECT 1 FROM workhorse.task_runtime runtime
                             WHERE runtime.task_id = callback.task_id)
                    OR EXISTS (SELECT 1 FROM workhorse.fast_task_runtime runtime
                                WHERE runtime.task_id = callback.task_id)
                  )
             )
       ORDER BY task_group.finished_at, task_group.id
       LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    )
    DELETE FROM workhorse.task_group task_group
     USING candidates WHERE task_group.id = candidates.id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;
  RETURN v_repaired + v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.purge_queue_internal_v1(p_queue_name text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_fast_count integer;
  v_member_task_ids uuid[];
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
  -- A purged member task counts as canceled for its group (ADR 0095). Every member is full-tier.
  v_member_task_ids := ARRAY(
    SELECT member.task_id
      FROM workhorse.task_runtime runtime
      JOIN workhorse.task_group_member member ON member.task_id = runtime.task_id
     WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
       AND member.outcome IS NULL
     ORDER BY member.task_id
  );

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
  -- The counters change after the deletes, so a callback a group enqueues on this queue survives.
  IF cardinality(v_member_task_ids) > 0 THEN
    PERFORM workhorse.count_task_group_outcomes_internal_v1(
      v_member_task_ids, array_fill('canceled'::text, ARRAY[cardinality(v_member_task_ids)])
    );
  END IF;

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

CREATE OR REPLACE FUNCTION workhorse.prune_full_terminal_tasks_internal_v1(
  p_identity_before timestamptz, p_outcome_before timestamptz,
  p_history_before timestamptz, p_limit integer
) RETURNS TABLE (pruned integer, dependency_starved boolean)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_limit < 1 THEN
    pruned := 0;
    dependency_starved := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
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
       -- A redrive source waits for its younger target, so it stays out of the window. Otherwise a
       -- window of sources would hide the targets that release them, and no pass would progress.
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.task_redrive redrive WHERE redrive.source_task_id = task.id
           )
       -- A group that is not finished needs its member outcomes when it finishes (ADR 0095).
       AND NOT EXISTS (
             SELECT 1
               FROM workhorse.task_group_member member
               JOIN workhorse.task_group task_group ON task_group.id = member.group_id
              WHERE member.task_id = task.id AND task_group.state <> 'finished'
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
  )
  SELECT result.pruned, result.dependency_starved INTO STRICT pruned, dependency_starved
    FROM result;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_terminal_storage_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_state workhorse.maintenance_state%ROWTYPE;
DECLARE v_history_before timestamptz;
DECLARE v_success boolean := true;
DECLARE v_identity_before timestamptz;
DECLARE v_outcome_before timestamptz;
DECLARE v_run_started_at timestamptz;
DECLARE v_run_completed_at timestamptz;
DECLARE v_rows_affected integer := 0;
DECLARE v_phases jsonb := '[]'::jsonb;
DECLARE v_batch integer;
DECLARE v_backlog boolean := false;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('workhorse:maintenance:terminal-storage', 0)
  ) THEN
    RETURN QUERY VALUES
      ('enqueue_idempotency'::text, 0, 0, true, NULL::jsonb),
      ('released_dependencies'::text, 0, 0, true, NULL::jsonb),
      ('terminal_tasks'::text, 0, 0, true, NULL::jsonb),
      ('task_groups'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.maintenance_state
   WHERE routine_name = 'terminal_storage' FOR UPDATE;
  -- A pass that ended with a full batch left eligible rows behind. The follow-up pass is due after
  -- the follow-up delay, or after the configured interval when that is shorter, instead of a full
  -- interval.
  IF NOT p_force AND v_state.last_completed_at IS NOT NULL
     AND v_state.last_completed_at > p_now - make_interval(
       secs => CASE WHEN v_state.terminal_cleanup_backlog_since IS NULL
         THEN v_maintenance.terminal_cleanup_interval_ms
         ELSE LEAST(v_maintenance.terminal_cleanup_interval_ms,
           workhorse.terminal_cleanup_follow_up_delay_ms_v1()) END / 1000.0
     ) THEN
    RETURN;
  END IF;
  v_run_started_at := clock_timestamp();
  SELECT history_retained_before INTO v_history_before
    FROM workhorse.maintenance_state WHERE routine_name = 'history_retention';
  UPDATE workhorse.maintenance_state SET last_started_at = p_now, updated_at = clock_timestamp()
   WHERE routine_name = 'terminal_storage';

  phase := 'enqueue_idempotency';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.prune_enqueue_idempotency_v1(
      p_now, v_policy.terminal_task_prune_limit
    );
    v_backlog := v_backlog OR rows_affected >= v_policy.terminal_task_prune_limit;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
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

  phase := 'released_dependencies';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.prune_released_dependencies_v1(
      v_policy.terminal_task_prune_limit
    );
    v_backlog := v_backlog OR rows_affected >= v_policy.terminal_task_prune_limit;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
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

  phase := 'terminal_tasks';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.task_identity_retention_days IS NOT NULL AND v_history_before IS NOT NULL THEN
      v_identity_before := p_now - make_interval(days => v_policy.task_identity_retention_days);
      v_outcome_before := p_now - make_interval(days => v_policy.terminal_outcome_retention_days);
      -- Batches repeat while each one fills, until the phase has run for one second. The time
      -- budget bounds how long one pass holds its transaction, whatever the batch limit.
      LOOP
        v_batch := workhorse.prune_terminal_tasks_v1(
          v_identity_before,
          v_outcome_before,
          v_history_before,
          v_policy.terminal_task_prune_limit
        );
        rows_affected := rows_affected + v_batch;
        EXIT WHEN v_batch < v_policy.terminal_task_prune_limit
          OR clock_timestamp() - v_started_at >= interval '1 second';
      END LOOP;
      v_backlog := v_backlog OR v_batch >= v_policy.terminal_task_prune_limit;
    ELSE
      UPDATE workhorse.maintenance_state
         SET terminal_prune_dependency_starved = false,
             updated_at = clock_timestamp()
       WHERE routine_name = 'terminal_storage';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The subtransaction rolled back every batch of this phase.
    rows_affected := 0;
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
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

  -- A finished group uses the retention period of terminal outcomes (ADR 0095).
  phase := 'task_groups';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.maintain_task_groups_v1(
      CASE WHEN v_policy.terminal_outcome_retention_days IS NOT NULL
        THEN p_now - make_interval(days => v_policy.terminal_outcome_retention_days) END,
      v_policy.terminal_task_prune_limit
    );
  EXCEPTION WHEN OTHERS THEN
    rows_affected := 0;
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  v_rows_affected := v_rows_affected + rows_affected;
  v_phases := v_phases || jsonb_build_array(jsonb_build_object(
    'phase', phase, 'rowsAffected', rows_affected, 'durationMs', duration_ms,
    'error', error
  ));
  -- The backlog start survives follow-up passes that still fill a batch. A phase that reached its
  -- limit shows a backlog even when another phase failed. Only a pass whose every phase succeeded
  -- can show that cleanup caught up, so only such a pass clears the start.
  UPDATE workhorse.maintenance_state
     SET terminal_cleanup_backlog_since = CASE
           WHEN v_backlog THEN COALESCE(terminal_cleanup_backlog_since, p_now)
           WHEN v_success THEN NULL
           ELSE terminal_cleanup_backlog_since END,
         updated_at = clock_timestamp()
   WHERE routine_name = 'terminal_storage';
  v_run_completed_at := clock_timestamp();
  IF v_success THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_at = p_now, updated_at = clock_timestamp()
     WHERE routine_name = 'terminal_storage';
  END IF;
  PERFORM workhorse.record_maintenance_run_internal_v1(
    'terminal_storage', v_run_started_at, v_run_completed_at,
    CASE WHEN v_success THEN 'succeeded' ELSE 'failed' END,
    v_rows_affected, v_phases
  );
  RETURN NEXT;
END;
$$;
