-- workhorse-migration: {"kind":"additive","execution":"nontransactional"}

-- Fence a task group member add and index the dashboard group list by state (SM-1273).

-- A running member task can add tasks to its group after the seal. add_task_group_members_v1
-- checked the worker and the fence token of the member with a plain read, without a row lock. It
-- did not check the lease expiry, the deadline, the attempt timeout, or a cancel request. A worker
-- whose lease expired could thus add tasks after Workhorse gave the member to a new worker. The add
-- now locks the member's runtime row first, with the runtime rows of the prerequisites in identity
-- order, before the shard rows and the group row. Completion, cancellation, purge, and lease recovery
-- lock that row first too. enqueue_prerequisite_task_ids_internal_v1 is new: it returns the
-- prerequisite identities that lock_enqueue_prerequisites_internal_v1 locks. After its last
-- lock, the add makes the checks of save_checkpoint_v2. A failed check refuses the add with P1008
-- and the reason not_running_member, as before. The signature does not change.
--
-- dashboard_task_groups_v1 filtered by state and ordered by (created_at DESC, id DESC) in one
-- statement, through task_group_created_idx for every group. For a state that few groups have,
-- PostgreSQL read the groups of every state to fill one page. task_group_state_created_idx orders
-- the groups of each state, and the function now uses one statement for the page without a filter
-- and one for the page with a filter.
--
-- The step is non-transactional, so the index build does not block writes to task_group. Each
-- statement is idempotent, so a rerun after a failure part-way applies the step again. A failed
-- index build leaves an invalid task_group_state_created_idx, and IF NOT EXISTS then skips the
-- build. Before the rerun, drop it with DROP INDEX CONCURRENTLY IF EXISTS
-- workhorse.task_group_state_created_idx, as docs/schema-lifecycle.md states. No change touches
-- stored data.

CREATE INDEX CONCURRENTLY IF NOT EXISTS task_group_state_created_idx
  ON workhorse.task_group (state, created_at, id);

-- The distinct prerequisite identities that the requests of one enqueue batch name: the identities
-- that lock_enqueue_prerequisites_internal_v1 locks. A value that is not a UUID is left out, so the
-- per-request validation raises its usual error. A member add of a task group uses it to lock its
-- member task in identity order with the prerequisites.
CREATE OR REPLACE FUNCTION workhorse.enqueue_prerequisite_task_ids_internal_v1(p_requests jsonb)
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY(
    SELECT DISTINCT prerequisite.value::uuid
      FROM jsonb_array_elements(p_requests) input(request)
      CROSS JOIN LATERAL (
        SELECT input.request->>'prerequisiteTaskId' AS value
         WHERE jsonb_typeof(input.request->'prerequisiteTaskId') = 'string'
        UNION ALL
        SELECT item.value
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(input.request->'dependencies') = 'object'
                  AND jsonb_typeof(input.request->'dependencies'->'prerequisiteTaskIds') = 'array'
              THEN input.request->'dependencies'->'prerequisiteTaskIds' ELSE '[]'::jsonb END
          ) item(value)
      ) prerequisite
     WHERE prerequisite.value ~* '^(\{[0-9a-f]{4}(-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(-?[0-9a-f]{4}){7})$'
  );
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
  SELECT COALESCE(sum(shard.total_count), 0)::integer INTO v_total
    FROM workhorse.task_group_shard shard WHERE shard.group_id = p_group_id;
  IF v_total + cardinality(v_new_task_ids) > workhorse.task_group_member_limit_v1() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1009',
      MESSAGE = 'a task group accepts at most 100000 member tasks',
      DETAIL = jsonb_build_object(
        'groupId', p_group_id, 'limit', workhorse.task_group_member_limit_v1(),
        'total', v_total, 'requested', cardinality(v_new_task_ids)
      )::text;
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

-- One dashboard/v1 page of task groups, newest first (ADR 0096). The input carries state (all,
-- open, sealed, or finished), page, and pageSize. The page without a filter reads
-- task_group_created_idx. A page with a filter reads task_group_state_created_idx, so a state that
-- few groups have does not walk the groups of the other states. Each group
-- has the snapshot of get_task_group_v1, so a group that is not finished shows the sums of its
-- shard rows. The page reads one group more than it returns, so hasMore costs no count of the whole
-- table. The dashboard reads task groups only through functions, so the task group tables do not
-- become a governed dashboard read.
CREATE OR REPLACE FUNCTION workhorse.dashboard_task_groups_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_state text := COALESCE(p_input->>'state', 'all');
  v_page integer := COALESCE((p_input->>'page')::integer, 1);
  v_page_size integer := COALESCE((p_input->>'pageSize')::integer, 50);
  v_ids uuid[];
BEGIN
  IF v_state NOT IN ('all', 'open', 'sealed', 'finished') THEN
    RAISE EXCEPTION 'task group state filter must be all, open, sealed, or finished';
  END IF;
  IF v_page NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'task group page must be between 1 and 1000';
  END IF;
  IF v_page_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'task group page size must be between 1 and 100';
  END IF;
  -- Two statements, because one statement with an optional filter has one plan for both cases.
  -- The filtered page also orders by state, the first column of task_group_state_created_idx. The
  -- order of the page does not change, because every row has the same state. Without it, a generic
  -- plan, which PL/pgSQL can choose after five calls, reads task_group_created_idx and filters it.
  IF v_state = 'all' THEN
    v_ids := ARRAY(
      SELECT task_group.id
        FROM workhorse.task_group task_group
       ORDER BY task_group.created_at DESC, task_group.id DESC
      OFFSET (v_page - 1) * v_page_size
       LIMIT v_page_size + 1
    );
  ELSE
    v_ids := ARRAY(
      SELECT task_group.id
        FROM workhorse.task_group task_group
       WHERE task_group.state = v_state
       ORDER BY task_group.state DESC, task_group.created_at DESC, task_group.id DESC
      OFFSET (v_page - 1) * v_page_size
       LIMIT v_page_size + 1
    );
  END IF;
  RETURN (
    WITH listed AS (
      SELECT candidate.id, candidate.ordinal
        FROM unnest(v_ids) WITH ORDINALITY candidate(id, ordinal)
    )
    SELECT jsonb_build_object(
      'state', v_state,
      'page', v_page,
      'pageSize', v_page_size,
      'hasMore', (SELECT count(*) FROM listed) > v_page_size,
      'groups', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'id', snapshot.group_id,
                 'state', snapshot.state,
                 'result', snapshot.result,
                 'counts', jsonb_build_object(
                   'total', snapshot.total,
                   'succeeded', snapshot.succeeded,
                   'failed', snapshot.failed,
                   'canceled', snapshot.canceled,
                   'pending', snapshot.pending
                 ),
                 'createdAt', workhorse.dashboard_iso_v1(snapshot.created_at),
                 'sealedAt', workhorse.dashboard_iso_v1(snapshot.sealed_at),
                 'finishedAt', workhorse.dashboard_iso_v1(snapshot.finished_at),
                 'canceledAt', workhorse.dashboard_iso_v1(snapshot.canceled_at),
                 'canceledBy', snapshot.canceled_by,
                 'cancelReason', snapshot.cancel_reason,
                 'callbacks', (
                   SELECT COALESCE(jsonb_agg(jsonb_build_object(
                            'kind', callback.kind,
                            'taskId', snapshot.callbacks -> callback.name ->> 'taskId'
                          ) ORDER BY callback.ordinal), '[]'::jsonb)
                     FROM (VALUES
                       (1, 'on_finish', 'onFinish'),
                       (2, 'on_success', 'onSuccess'),
                       (3, 'on_failure', 'onFailure')
                     ) callback(ordinal, name, kind)
                    WHERE snapshot.callbacks -> callback.name IS NOT NULL
                 )
               ) ORDER BY listed.ordinal), '[]'::jsonb)
          FROM listed
          CROSS JOIN LATERAL workhorse.get_task_group_v1(listed.id) snapshot
         WHERE listed.ordinal <= v_page_size
      )
    )
  );
END;
$$;
