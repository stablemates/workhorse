-- workhorse-migration: {"kind":"additive"}

-- Count task group outcomes in counter shards (SM-1245, ADR 0096).

-- Migration 0066 counts every member outcome on the task_group row, so all member outcomes of one
-- group wait for one row lock. This migration moves the live counts to task_group_shard: 32 rows
-- for each group, and a member task uses the shard (position - 1) mod 32. The statement trigger on
-- task_outcome records each member outcome on its membership row and lists the member for the
-- transaction. A deferred constraint trigger applies the list to the shard rows at commit, in one
-- sorted pass. The group row is locked only when the pending count of a shard becomes 0.
--
-- The four counts on the task_group row stay 0 until the group finishes, and a check constraint
-- requires this. A member outcome or an add that started under the migration 0066 functions and
-- continues after this migration changes such a count, so PostgreSQL rolls that transaction back.
--
-- The migration also adds dashboard_task_groups_v1, the dashboard read of the task group list.

-- A member outcome, an add, a seal, or a cancel under the migration 0066 functions locks the group
-- row first. This lock makes each of them wait for the migration, so the counts below read every
-- committed member outcome.
LOCK TABLE workhorse.task_group IN EXCLUSIVE MODE;

-- One row for each counter shard of each group (ADR 0096). A shard row exists for the full life of
-- its group. The pending count of a shard is total_count minus the three outcome counts.
CREATE TABLE IF NOT EXISTS workhorse.task_group_shard (
  group_id uuid NOT NULL REFERENCES workhorse.task_group(id) ON DELETE CASCADE,
  shard smallint NOT NULL CHECK (shard >= 0),
  total_count integer NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  succeeded_count integer NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  canceled_count integer NOT NULL DEFAULT 0 CHECK (canceled_count >= 0),
  PRIMARY KEY (group_id, shard),
  CONSTRAINT task_group_shard_counts_check CHECK (
    succeeded_count + failed_count + canceled_count <= total_count
  )
);

-- shard_count is N for the group and never changes. pending_shard_count is the number of shards of
-- the group whose pending count is more than 0. Workhorse changes it only under the group row lock.
ALTER TABLE workhorse.task_group
  ADD COLUMN IF NOT EXISTS shard_count smallint,
  ADD COLUMN IF NOT EXISTS pending_shard_count integer NOT NULL DEFAULT 0;

UPDATE workhorse.task_group SET shard_count = 32 WHERE shard_count IS NULL;
ALTER TABLE workhorse.task_group ALTER COLUMN shard_count SET NOT NULL;

-- The membership rows record each counted member outcome, so they are the source of the shard
-- counts. A member that has an outcome row but no counted outcome stays pending in its shard, as it
-- stayed pending in the group counter. The drift listing reports such a group.
INSERT INTO workhorse.task_group_shard(
  group_id, shard, total_count, succeeded_count, failed_count, canceled_count
)
SELECT task_group.id, slot.shard, COALESCE(counted.total, 0), COALESCE(counted.succeeded, 0),
       COALESCE(counted.failed, 0), COALESCE(counted.canceled, 0)
  FROM workhorse.task_group task_group
  CROSS JOIN LATERAL generate_series(0, task_group.shard_count - 1) slot(shard)
  LEFT JOIN (
    SELECT member.group_id, (member.position - 1) % 32 AS shard, count(*)::integer AS total,
           (count(*) FILTER (WHERE member.outcome = 'succeeded'))::integer AS succeeded,
           (count(*) FILTER (WHERE member.outcome = 'failed'))::integer AS failed,
           (count(*) FILTER (WHERE member.outcome = 'canceled'))::integer AS canceled
      FROM workhorse.task_group_member member
     GROUP BY member.group_id, (member.position - 1) % 32
  ) counted ON counted.group_id = task_group.id AND counted.shard = slot.shard
ON CONFLICT (group_id, shard) DO NOTHING;

-- A group that is not finished keeps its counts only in its shard rows. A finished group keeps its
-- counts on its row.
UPDATE workhorse.task_group task_group
   SET pending_shard_count = (
         SELECT count(*)::integer FROM workhorse.task_group_shard shard
          WHERE shard.group_id = task_group.id
            AND shard.total_count > shard.succeeded_count + shard.failed_count + shard.canceled_count
       ),
       total_count = CASE WHEN task_group.state = 'finished' THEN task_group.total_count ELSE 0 END,
       succeeded_count = CASE WHEN task_group.state = 'finished'
         THEN task_group.succeeded_count ELSE 0 END,
       failed_count = CASE WHEN task_group.state = 'finished'
         THEN task_group.failed_count ELSE 0 END,
       canceled_count = CASE WHEN task_group.state = 'finished'
         THEN task_group.canceled_count ELSE 0 END;

ALTER TABLE workhorse.task_group
  ADD CONSTRAINT task_group_shards_check CHECK (
    shard_count >= 1 AND pending_shard_count BETWEEN 0 AND shard_count
  ),
  ADD CONSTRAINT task_group_unfinished_counts_check CHECK (
    state = 'finished'
    OR (total_count = 0 AND succeeded_count = 0 AND failed_count = 0 AND canceled_count = 0)
  );

-- The number of counter shards of a new group (ADR 0096). An existing group keeps the shard_count
-- that its row records.
CREATE OR REPLACE FUNCTION workhorse.task_group_shard_count_v1()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 32;
$$;

-- The members whose outcome this transaction recorded and that no apply step has counted yet. The
-- list is a transaction-local setting: PostgreSQL restores it when a savepoint rolls back, together
-- with the membership rows of that savepoint, and discards it when the transaction ends.
CREATE OR REPLACE FUNCTION workhorse.listed_task_group_outcomes_internal_v1()
RETURNS uuid[]
LANGUAGE sql
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('workhorse.task_group_outcomes', true), '')::uuid[], '{}'::uuid[]
  );
$$;

-- Record the outcome of each member task whose membership row has no outcome yet, and add the
-- recorded members to the list of the transaction. A member is counted one time, because only one
-- change can record its outcome. This step locks only the membership rows. Returns the groups of
-- the recorded members.
--
-- The members join the list before their membership rows change. After SET CONSTRAINTS ALL
-- IMMEDIATE, the apply trigger fires at the end of the UPDATE below, and it must find them there.
-- The row locks keep the outcome of each listed member null until the UPDATE records it.
CREATE OR REPLACE FUNCTION workhorse.record_task_group_outcomes_internal_v1(
  p_task_ids uuid[], p_states text[]
) RETURNS uuid[]
LANGUAGE plpgsql
AS $$
DECLARE
  v_recorded uuid[];
  v_group_ids uuid[];
  v_now timestamptz := clock_timestamp();
BEGIN
  v_recorded := ARRAY(
    SELECT member.task_id
      FROM workhorse.task_group_member member
     WHERE member.task_id = ANY(p_task_ids) AND member.outcome IS NULL
     ORDER BY member.task_id
       FOR UPDATE
  );
  IF cardinality(v_recorded) = 0 THEN RETURN '{}'::uuid[]; END IF;
  PERFORM set_config(
    'workhorse.task_group_outcomes',
    (workhorse.listed_task_group_outcomes_internal_v1() || v_recorded)::text,
    true
  );
  WITH recorded AS (
    UPDATE workhorse.task_group_member member
       SET outcome = input.state, counted_at = v_now
      FROM unnest(p_task_ids, p_states) input(task_id, state)
     WHERE member.task_id = input.task_id
       AND member.task_id = ANY(v_recorded)
    RETURNING member.group_id
  )
  SELECT array_agg(DISTINCT recorded.group_id ORDER BY recorded.group_id) INTO v_group_ids
    FROM recorded;
  RETURN v_group_ids;
END;
$$;

-- Apply the listed member outcomes of the given groups, or of every group when p_group_ids is null,
-- to the shard rows, and remove those members from the list. The membership rows give the
-- outcomes, so a member that the list names two times counts one time.
--
-- The step locks the shard rows in (group_id, shard) order, then the group rows of the shards whose
-- pending count became 0, in identity order. It decreases pending_shard_count for each such shard,
-- and it finishes a sealed group whose pending_shard_count becomes 0.
CREATE OR REPLACE FUNCTION workhorse.apply_task_group_outcomes_internal_v1(p_group_ids uuid[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_listed uuid[] := workhorse.listed_task_group_outcomes_internal_v1();
  v_applied uuid[];
  v_groups uuid[];
  v_shards smallint[];
  v_succeeded integer[];
  v_failed integer[];
  v_canceled integer[];
  v_emptied uuid[];
  v_group record;
  v_state text;
  v_pending_shards integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF cardinality(v_listed) = 0 THEN RETURN; END IF;
  v_applied := ARRAY(
    SELECT DISTINCT member.task_id
      FROM workhorse.task_group_member member
     WHERE member.task_id = ANY(v_listed)
       AND (p_group_ids IS NULL OR member.group_id = ANY(p_group_ids))
  );
  PERFORM set_config(
    'workhorse.task_group_outcomes',
    CASE WHEN p_group_ids IS NULL THEN ''
      ELSE ARRAY(
        SELECT listed.task_id FROM unnest(v_listed) listed(task_id)
         WHERE listed.task_id <> ALL(v_applied)
      )::text END,
    true
  );
  IF cardinality(v_applied) = 0 THEN RETURN; END IF;

  SELECT array_agg(counted.group_id ORDER BY counted.group_id, counted.shard),
         array_agg(counted.shard ORDER BY counted.group_id, counted.shard),
         array_agg(counted.succeeded ORDER BY counted.group_id, counted.shard),
         array_agg(counted.failed ORDER BY counted.group_id, counted.shard),
         array_agg(counted.canceled ORDER BY counted.group_id, counted.shard)
    INTO v_groups, v_shards, v_succeeded, v_failed, v_canceled
    FROM (
      SELECT member.group_id, ((member.position - 1) % task_group.shard_count)::smallint AS shard,
             (count(*) FILTER (WHERE member.outcome = 'succeeded'))::integer AS succeeded,
             (count(*) FILTER (WHERE member.outcome = 'failed'))::integer AS failed,
             (count(*) FILTER (WHERE member.outcome = 'canceled'))::integer AS canceled
        FROM workhorse.task_group_member member
        JOIN workhorse.task_group task_group ON task_group.id = member.group_id
       WHERE member.task_id = ANY(v_applied)
         AND member.outcome IS NOT NULL
       GROUP BY 1, 2
    ) counted;
  IF v_groups IS NULL THEN RETURN; END IF;

  PERFORM 1
    FROM workhorse.task_group_shard shard
    JOIN unnest(v_groups, v_shards) target(group_id, shard)
      ON shard.group_id = target.group_id AND shard.shard = target.shard
   ORDER BY shard.group_id, shard.shard
   FOR UPDATE OF shard;
  WITH changed AS (
    UPDATE workhorse.task_group_shard shard
       SET succeeded_count = shard.succeeded_count + target.succeeded,
           failed_count = shard.failed_count + target.failed,
           canceled_count = shard.canceled_count + target.canceled
      FROM unnest(v_groups, v_shards, v_succeeded, v_failed, v_canceled)
             target(group_id, shard, succeeded, failed, canceled)
     WHERE shard.group_id = target.group_id AND shard.shard = target.shard
       -- A shard that drifted and has no room for the outcomes keeps its counts, so the member
       -- outcome does not fail. The drift listing reports the shard.
       AND shard.succeeded_count + shard.failed_count + shard.canceled_count
         + target.succeeded + target.failed + target.canceled <= shard.total_count
    RETURNING shard.group_id,
              shard.total_count - shard.succeeded_count - shard.failed_count
                - shard.canceled_count AS pending
  )
  SELECT array_agg(changed.group_id ORDER BY changed.group_id) INTO v_emptied
    FROM changed WHERE changed.pending = 0;
  IF v_emptied IS NULL THEN RETURN; END IF;

  PERFORM 1 FROM workhorse.task_group task_group
   WHERE task_group.id = ANY(v_emptied)
   ORDER BY task_group.id FOR UPDATE;
  FOR v_group IN
    SELECT emptied.group_id, count(*)::integer AS shards
      FROM unnest(v_emptied) emptied(group_id)
     GROUP BY emptied.group_id
     ORDER BY emptied.group_id
  LOOP
    -- A pending_shard_count that drifted below the real value must not fail the member outcome.
    -- The drift listing reports it.
    UPDATE workhorse.task_group task_group
       SET pending_shard_count = GREATEST(task_group.pending_shard_count - v_group.shards, 0),
           updated_at = v_now
     WHERE task_group.id = v_group.group_id
    RETURNING task_group.state, task_group.pending_shard_count INTO v_state, v_pending_shards;
    IF v_state = 'sealed' AND v_pending_shards = 0 THEN
      PERFORM workhorse.finish_task_group_internal_v1(v_group.group_id);
    END IF;
  END LOOP;
END;
$$;

-- The first deferred firing of a transaction applies its whole list and clears it. Each later
-- firing finds an empty list and returns.
CREATE OR REPLACE FUNCTION workhorse.apply_task_group_outcomes_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM workhorse.apply_task_group_outcomes_internal_v1(NULL);
  RETURN NULL;
END;
$$;

-- PostgreSQL cannot replace a constraint trigger, so the block creates it only when it is absent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'workhorse.task_group_member'::regclass
       AND tgname = 'task_group_member_apply_outcomes'
  ) THEN
    CREATE CONSTRAINT TRIGGER task_group_member_apply_outcomes
      AFTER UPDATE OF outcome ON workhorse.task_group_member
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (OLD.outcome IS NULL AND NEW.outcome IS NOT NULL)
      EXECUTE FUNCTION workhorse.apply_task_group_outcomes_v1();
  END IF;
END;
$$;

-- Record and apply at once. An add and a purge use it for the outcomes that the trigger did not
-- record, and they must see the new counts before they return.
CREATE OR REPLACE FUNCTION workhorse.count_task_group_outcomes_internal_v1(
  p_task_ids uuid[], p_states text[]
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_group_ids uuid[];
BEGIN
  v_group_ids := workhorse.record_task_group_outcomes_internal_v1(p_task_ids, p_states);
  IF cardinality(v_group_ids) > 0 THEN
    PERFORM workhorse.apply_task_group_outcomes_internal_v1(v_group_ids);
  END IF;
END;
$$;

-- One firing per statement records every member outcome that the statement inserted, in the
-- transaction that writes the outcome. A retry writes no outcome, so it never counts a member. Most
-- outcomes belong to no group, so one probe of the membership key ends the firing. The firing locks
-- only membership rows: task_group_member_apply_outcomes changes the shard rows at commit.
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
    PERFORM workhorse.record_task_group_outcomes_internal_v1(v_task_ids, v_states);
  END IF;
  RETURN NULL;
END;
$$;

-- For a group that is not finished, the counts are the sums of its shard rows, read in one
-- statement without a lock. For a finished group, they are the counts on its row.
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
  SELECT task_group.id, task_group.state, task_group.result, counts.total, counts.succeeded,
         counts.failed, counts.canceled,
         counts.total - counts.succeeded - counts.failed - counts.canceled,
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
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(shard.total_count), 0)::integer AS total,
             COALESCE(sum(shard.succeeded_count), 0)::integer AS succeeded,
             COALESCE(sum(shard.failed_count), 0)::integer AS failed,
             COALESCE(sum(shard.canceled_count), 0)::integer AS canceled
        FROM workhorse.task_group_shard shard
       WHERE shard.group_id = task_group.id AND task_group.state <> 'finished'
    ) shard_counts
    CROSS JOIN LATERAL (
      SELECT CASE WHEN task_group.state = 'finished' THEN task_group.total_count
               ELSE shard_counts.total END AS total,
             CASE WHEN task_group.state = 'finished' THEN task_group.succeeded_count
               ELSE shard_counts.succeeded END AS succeeded,
             CASE WHEN task_group.state = 'finished' THEN task_group.failed_count
               ELSE shard_counts.failed END AS failed,
             CASE WHEN task_group.state = 'finished' THEN task_group.canceled_count
               ELSE shard_counts.canceled END AS canceled
    ) counts
   WHERE task_group.id = p_group_id;
$$;

-- Finish a sealed group whose every shard has a pending count of 0, and enqueue its callbacks in the
-- same transaction. The caller holds the group row lock. The shard rows are read without a lock: no
-- member outcome can change a shard with no pending member, only an add can make a shard pending
-- again, and an add needs the group row lock. The sums of the shard rows become the counts on the
-- group row. If pending_shard_count drifted and the sums still show a pending member, the group
-- stays sealed and the drift listing reports it.
--
-- A callback that cannot be enqueued records a callback_failed event instead of failing the
-- transaction that wrote the last member outcome.
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
         result = CASE WHEN sums.succeeded = sums.total THEN 'succeeded' ELSE 'failed' END,
         total_count = sums.total,
         succeeded_count = sums.succeeded,
         failed_count = sums.failed,
         canceled_count = sums.canceled,
         finished_at = v_now,
         updated_at = v_now
    FROM (
      SELECT COALESCE(sum(shard.total_count), 0)::integer AS total,
             COALESCE(sum(shard.succeeded_count), 0)::integer AS succeeded,
             COALESCE(sum(shard.failed_count), 0)::integer AS failed,
             COALESCE(sum(shard.canceled_count), 0)::integer AS canceled
        FROM workhorse.task_group_shard shard
       WHERE shard.group_id = p_group_id
    ) sums
   WHERE task_group.id = p_group_id
     AND task_group.state = 'sealed'
     AND task_group.pending_shard_count = 0
     AND sums.succeeded + sums.failed + sums.canceled = sums.total
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

-- Add up to 1,000 new tasks to a group. The add reads the member count from the shard rows, so it
-- locks all of them, then the group row. The group row lock serializes the add with every other
-- change to the group, and the member limit is checked under that lock. Every request is an
-- ordinary enqueue request without debounce or throttle. A task joins only when this call enqueues
-- it: an enqueue idempotency hit must return a task that is already a member of this group.
--
-- After the seal, only a running member task can add tasks: the caller passes that member's task
-- identity, worker, and fence token. The member is not terminal, so its shard is pending and the
-- group cannot finish first.
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
  -- the same order and cannot deadlock with that member's completion.
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

-- Seal an open group. A group with no pending shard finishes at once. Sealing a sealed or finished
-- group changes nothing. The seal changes no shard row, so it reads them without a lock.
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
  VALUES (p_group_id, 'sealed', jsonb_build_object('total', (
    SELECT COALESCE(sum(shard.total_count), 0)::integer
      FROM workhorse.task_group_shard shard WHERE shard.group_id = p_group_id
  )), v_now);
  PERFORM workhorse.finish_task_group_internal_v1(p_group_id);
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
  v_shard_count integer;
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

  -- The group gets all of its shard rows now. A shard row exists for the full life of its group,
  -- so every later change locks rows that already exist.
  INSERT INTO workhorse.task_group(on_finish, on_success, on_failure, shard_count)
  VALUES (
    NULLIF(v_callbacks->'onFinish', 'null'::jsonb),
    NULLIF(v_callbacks->'onSuccess', 'null'::jsonb),
    NULLIF(v_callbacks->'onFailure', 'null'::jsonb),
    workhorse.task_group_shard_count_v1()
  )
  RETURNING id, shard_count INTO v_group_id, v_shard_count;
  INSERT INTO workhorse.task_group_shard(group_id, shard)
  SELECT v_group_id, slot.shard FROM generate_series(0, v_shard_count - 1) slot(shard);
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
-- The cancel locks the runtime rows of live members, then all shard rows, then the group row. This
-- is the order of a member outcome, so a member that finishes at the same time cannot deadlock with
-- the cancel. The outcomes that cancel_v1 writes find their shard rows already locked. The cancel
-- applies them at once, every 100 members, so the list of the transaction stays short.
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
  PERFORM 1 FROM workhorse.task_group_shard shard
   WHERE shard.group_id = p_group_id
   ORDER BY shard.shard FOR UPDATE;
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
    VALUES (p_group_id, 'sealed', jsonb_build_object('total', (
      SELECT COALESCE(sum(shard.total_count), 0)::integer
        FROM workhorse.task_group_shard shard WHERE shard.group_id = p_group_id
    )), v_now);
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
    IF v_canceled % 100 = 0 THEN
      PERFORM workhorse.apply_task_group_outcomes_internal_v1(ARRAY[p_group_id]);
    END IF;
  END LOOP;
  PERFORM workhorse.apply_task_group_outcomes_internal_v1(ARRAY[p_group_id]);

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

-- Groups whose shard counts disagree with their member outcomes, in group identity order. A member
-- is finished when its outcome row exists, or when its task row is gone, which only a purge of a
-- member that was not terminal can do. A group drifts when the counts of one shard differ from its
-- membership rows, when pending_shard_count differs from the shard rows, or when it is sealed and
-- no member is pending: then its callbacks are not enqueued. The recorded counts are the sums of
-- the shard rows.
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
    SELECT task_group.id, task_group.state, shards.recorded_total, shards.recorded_succeeded,
           shards.recorded_failed, shards.recorded_canceled, shards.total, shards.succeeded,
           shards.failed, shards.canceled,
           shards.total - shards.succeeded - shards.failed - shards.canceled,
           CASE WHEN task_group.state = 'sealed'
                 AND shards.total = shards.succeeded + shards.failed + shards.canceled
             THEN 'finished' ELSE 'recounted' END
      FROM workhorse.task_group task_group
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(recorded.total_count), 0)::integer AS recorded_total,
               COALESCE(sum(recorded.succeeded_count), 0)::integer AS recorded_succeeded,
               COALESCE(sum(recorded.failed_count), 0)::integer AS recorded_failed,
               COALESCE(sum(recorded.canceled_count), 0)::integer AS recorded_canceled,
               COALESCE(sum(expected.total), 0)::integer AS total,
               COALESCE(sum(expected.succeeded), 0)::integer AS succeeded,
               COALESCE(sum(expected.failed), 0)::integer AS failed,
               COALESCE(sum(expected.canceled), 0)::integer AS canceled,
               bool_or(
                 recorded.shard IS NULL
                 OR recorded.total_count <> COALESCE(expected.total, 0)
                 OR recorded.succeeded_count <> COALESCE(expected.succeeded, 0)
                 OR recorded.failed_count <> COALESCE(expected.failed, 0)
                 OR recorded.canceled_count <> COALESCE(expected.canceled, 0)
               ) AS shard_differs,
               (count(*) FILTER (
                 WHERE recorded.total_count > recorded.succeeded_count + recorded.failed_count
                   + recorded.canceled_count
               ))::integer AS recorded_pending_shards
          FROM generate_series(0, task_group.shard_count - 1) slot(shard)
          LEFT JOIN workhorse.task_group_shard recorded
            ON recorded.group_id = task_group.id AND recorded.shard = slot.shard
          LEFT JOIN (
            SELECT (member.position - 1) % task_group.shard_count AS shard,
                   count(*)::integer AS total,
                   (count(*) FILTER (WHERE member_state.state = 'succeeded'))::integer
                     AS succeeded,
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
             GROUP BY 1
          ) expected ON expected.shard = slot.shard
      ) shards
     WHERE task_group.state <> 'finished'
       AND (
         shards.shard_differs
         OR task_group.pending_shard_count <> shards.recorded_pending_shards
         OR (task_group.state = 'sealed'
           AND shards.total = shards.succeeded + shards.failed + shards.canceled)
       )
     ORDER BY task_group.id
     LIMIT p_limit;
END;
$$;

-- Recount one group from its member outcomes, and finish it when it is sealed and no member is
-- pending. The repair locks all shard rows, then the group row. It sets the shard counts from the
-- membership rows; it does not add to them. Thus it removes the members of the group from the list
-- of the transaction: an outcome that the transaction recorded before the repair is in the repaired
-- counts one time, and the apply step at commit must not add it again. Returns no row when the
-- group needed no change.
CREATE OR REPLACE FUNCTION workhorse.repair_task_group_internal_v1(
  p_group_id uuid, p_details jsonb
) RETURNS TABLE (group_id uuid, recorded_pending integer, pending integer, action text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_group workhorse.task_group%ROWTYPE;
  v_listed uuid[];
  v_changed jsonb;
  v_recorded_total integer;
  v_recorded_succeeded integer;
  v_recorded_failed integer;
  v_recorded_canceled integer;
  v_total integer;
  v_succeeded integer;
  v_failed integer;
  v_canceled integer;
  v_pending_shards integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM 1 FROM workhorse.task_group_shard shard
   WHERE shard.group_id = p_group_id
   ORDER BY shard.shard FOR UPDATE;
  SELECT * INTO v_group FROM workhorse.task_group task_group
   WHERE task_group.id = p_group_id FOR UPDATE;
  IF NOT FOUND OR v_group.state = 'finished' THEN RETURN; END IF;

  -- A membership row that another transaction holds is being recorded there, and that
  -- transaction applies it at its commit. The repair skips such a row and counts the member as
  -- pending, so it never waits for a membership row while it holds the shard and group rows.
  UPDATE workhorse.task_group_member member
     SET outcome = COALESCE(
           (SELECT task_outcome.state FROM workhorse.task_outcome task_outcome
             WHERE task_outcome.task_id = member.task_id),
           'canceled'
         ),
         counted_at = v_now
   WHERE member.task_id IN (
           SELECT candidate.task_id
             FROM workhorse.task_group_member candidate
            WHERE candidate.group_id = p_group_id
              AND candidate.outcome IS NULL
              AND NOT EXISTS (
                    SELECT 1 FROM workhorse.task_runtime runtime
                     WHERE runtime.task_id = candidate.task_id
                  )
              AND (
                EXISTS (SELECT 1 FROM workhorse.task_outcome task_outcome
                         WHERE task_outcome.task_id = candidate.task_id)
                OR NOT EXISTS (SELECT 1 FROM workhorse.task task WHERE task.id = candidate.task_id)
              )
            ORDER BY candidate.task_id
              FOR UPDATE SKIP LOCKED
         );

  v_listed := workhorse.listed_task_group_outcomes_internal_v1();
  IF cardinality(v_listed) > 0 THEN
    PERFORM set_config(
      'workhorse.task_group_outcomes',
      ARRAY(
        SELECT listed.task_id FROM unnest(v_listed) listed(task_id)
         WHERE NOT EXISTS (
                 SELECT 1 FROM workhorse.task_group_member member
                  WHERE member.task_id = listed.task_id AND member.group_id = p_group_id
               )
      )::text,
      true
    );
  END IF;

  WITH counted AS (
    SELECT (member.position - 1) % v_group.shard_count AS shard,
           count(*)::integer AS total,
           (count(*) FILTER (WHERE member.outcome = 'succeeded'))::integer AS succeeded,
           (count(*) FILTER (WHERE member.outcome = 'failed'))::integer AS failed,
           (count(*) FILTER (WHERE member.outcome = 'canceled'))::integer AS canceled
      FROM workhorse.task_group_member member
     WHERE member.group_id = p_group_id
     GROUP BY 1
  ), compared AS (
    SELECT slot.shard,
           COALESCE(recorded.total_count, 0) AS recorded_total,
           COALESCE(recorded.succeeded_count, 0) AS recorded_succeeded,
           COALESCE(recorded.failed_count, 0) AS recorded_failed,
           COALESCE(recorded.canceled_count, 0) AS recorded_canceled,
           COALESCE(counted.total, 0) AS total,
           COALESCE(counted.succeeded, 0) AS succeeded,
           COALESCE(counted.failed, 0) AS failed,
           COALESCE(counted.canceled, 0) AS canceled,
           recorded.shard IS NULL AS missing
      FROM generate_series(0, v_group.shard_count - 1) slot(shard)
      LEFT JOIN workhorse.task_group_shard recorded
        ON recorded.group_id = p_group_id AND recorded.shard = slot.shard
      LEFT JOIN counted ON counted.shard = slot.shard
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'shard', compared.shard,
           'recorded', jsonb_build_object(
             'total', compared.recorded_total, 'succeeded', compared.recorded_succeeded,
             'failed', compared.recorded_failed, 'canceled', compared.recorded_canceled
           ),
           'counted', jsonb_build_object(
             'total', compared.total, 'succeeded', compared.succeeded,
             'failed', compared.failed, 'canceled', compared.canceled
           )
         ) ORDER BY compared.shard) FILTER (
           WHERE compared.missing
              OR (compared.recorded_total, compared.recorded_succeeded, compared.recorded_failed,
                  compared.recorded_canceled)
                 <> (compared.total, compared.succeeded, compared.failed, compared.canceled)
         ), '[]'::jsonb),
         sum(compared.recorded_total)::integer, sum(compared.recorded_succeeded)::integer,
         sum(compared.recorded_failed)::integer, sum(compared.recorded_canceled)::integer,
         sum(compared.total)::integer, sum(compared.succeeded)::integer,
         sum(compared.failed)::integer, sum(compared.canceled)::integer,
         (count(*) FILTER (
           WHERE compared.total > compared.succeeded + compared.failed + compared.canceled
         ))::integer
    INTO v_changed, v_recorded_total, v_recorded_succeeded, v_recorded_failed,
         v_recorded_canceled, v_total, v_succeeded, v_failed, v_canceled, v_pending_shards
    FROM compared;

  IF jsonb_array_length(v_changed) = 0 AND v_group.pending_shard_count = v_pending_shards
     AND NOT (v_group.state = 'sealed' AND v_pending_shards = 0) THEN
    RETURN;
  END IF;
  INSERT INTO workhorse.task_group_shard(
    group_id, shard, total_count, succeeded_count, failed_count, canceled_count
  )
  SELECT p_group_id, (changed.value->>'shard')::smallint,
         (changed.value->'counted'->>'total')::integer,
         (changed.value->'counted'->>'succeeded')::integer,
         (changed.value->'counted'->>'failed')::integer,
         (changed.value->'counted'->>'canceled')::integer
    FROM jsonb_array_elements(v_changed) changed(value)
  ON CONFLICT (group_id, shard) DO UPDATE
     SET total_count = EXCLUDED.total_count, succeeded_count = EXCLUDED.succeeded_count,
         failed_count = EXCLUDED.failed_count, canceled_count = EXCLUDED.canceled_count;
  UPDATE workhorse.task_group task_group
     SET pending_shard_count = v_pending_shards, updated_at = v_now
   WHERE task_group.id = p_group_id;
  INSERT INTO workhorse.task_group_event(group_id, event_type, details, occurred_at)
  VALUES (p_group_id, 'counter_repaired', COALESCE(p_details, '{}'::jsonb) || jsonb_build_object(
    'recorded', jsonb_build_object(
      'total', v_recorded_total, 'succeeded', v_recorded_succeeded,
      'failed', v_recorded_failed, 'canceled', v_recorded_canceled
    ),
    'counted', jsonb_build_object(
      'total', v_total, 'succeeded', v_succeeded, 'failed', v_failed, 'canceled', v_canceled
    ),
    'shards', v_changed
  ), v_now);
  group_id := p_group_id;
  recorded_pending := v_recorded_total - v_recorded_succeeded - v_recorded_failed
    - v_recorded_canceled;
  pending := v_total - v_succeeded - v_failed - v_canceled;
  action := 'recounted';
  IF v_group.state = 'sealed' AND v_pending_shards = 0 THEN
    PERFORM workhorse.finish_task_group_internal_v1(p_group_id);
    action := 'finished';
  END IF;
  RETURN NEXT;
END;
$$;

-- The maintenance part of task groups, run by the terminal_storage routine. It finishes a sealed
-- group whose members are all finished but whose callbacks are not enqueued. Then it deletes a
-- finished group, with its shard, membership, callback, and event rows, after its callback tasks
-- are terminal and its finish is older than the outcome cutoff. It never deletes an open or sealed
-- group. A healthy sealed group stops each probe at its first live member.
--
-- The delete locks all shard rows of a group, then the group row, and skips the group when one of
-- them is locked. Without this order, the cascade locks the shard rows after the group row, and an
-- add to that group could deadlock with the delete. The delete never waits for a lock.
CREATE OR REPLACE FUNCTION workhorse.maintain_task_groups_v1(
  p_outcome_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_group_id uuid;
  v_shard_count integer;
  v_locked integer;
  v_repaired integer := 0;
  v_deleted integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'task group maintenance limit must be between 1 and 100000';
  END IF;
  -- The phase selects the oldest sealed groups, and repairs them in identity order: the order of
  -- repair_task_group_drift_v1 and of the apply step. A repair keeps the locks of each group until
  -- the transaction ends, so another order could deadlock with an operator repair.
  FOR v_group_id IN
    SELECT oldest.id
      FROM (
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
      ) oldest
     ORDER BY oldest.id
  LOOP
    v_repaired := v_repaired + (
      SELECT count(*)::integer FROM workhorse.repair_task_group_internal_v1(
        v_group_id, jsonb_build_object('requested_by', 'maintenance')
      )
    );
  END LOOP;

  IF p_outcome_before IS NOT NULL THEN
    FOR v_group_id, v_shard_count IN
      SELECT task_group.id, task_group.shard_count
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
    LOOP
      PERFORM 1 FROM workhorse.task_group_shard shard
       WHERE shard.group_id = v_group_id
       ORDER BY shard.shard FOR UPDATE SKIP LOCKED;
      GET DIAGNOSTICS v_locked = ROW_COUNT;
      CONTINUE WHEN v_locked < v_shard_count;
      PERFORM 1 FROM workhorse.task_group task_group
       WHERE task_group.id = v_group_id
       FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN NOT FOUND;
      DELETE FROM workhorse.task_group task_group WHERE task_group.id = v_group_id;
      v_deleted := v_deleted + 1;
    END LOOP;
  END IF;
  RETURN v_repaired + v_deleted;
END;
$$;

-- One dashboard/v1 page of task groups, newest first, read through task_group_created_idx (ADR
-- 0096). The input carries state (all, open, sealed, or finished), page, and pageSize. Each group
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
  RETURN (
    WITH listed AS (
      SELECT candidate.id,
             row_number() OVER (ORDER BY candidate.created_at DESC, candidate.id DESC) AS ordinal
        FROM (
          SELECT task_group.id, task_group.created_at
            FROM workhorse.task_group task_group
           WHERE v_state = 'all' OR task_group.state = v_state
           ORDER BY task_group.created_at DESC, task_group.id DESC
          OFFSET (v_page - 1) * v_page_size
           LIMIT v_page_size + 1
        ) candidate
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
