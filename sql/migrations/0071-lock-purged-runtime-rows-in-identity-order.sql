-- workhorse-migration: {"kind":"additive"}

-- Lock the purged runtime rows in identity order (SM-1282).

-- purge_queue_internal_v1 locked the runtime rows and the task rows of the blocked, ready, and
-- scheduled tasks of its queue with one FOR UPDATE OF runtime, task, without ORDER BY. An enqueue
-- with two or more prerequisites locks their runtime rows, then their task rows, FOR KEY SHARE in
-- identity order, through lock_enqueue_prerequisites_internal_v1. A task group member add uses the
-- same order. A purge that took a higher prerequisite first and an enqueue that took a lower one
-- first could thus wait for each other, and PostgreSQL aborted one of them with 40P01. The purge
-- now locks every runtime row in identity order, then every task row in identity order, for the
-- full tier and for the fast tier. The signature, the deletes, and the returned count do not
-- change. No change touches stored data.

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
  -- Lock every runtime row in identity order, then every task row in identity order. An enqueue
  -- locks its prerequisites in the same order, so the two cannot deadlock.
  PERFORM 1
    FROM workhorse.task_runtime runtime
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
   ORDER BY runtime.task_id
   FOR UPDATE;
  PERFORM 1
    FROM workhorse.task_runtime runtime
    JOIN workhorse.task task ON task.id = runtime.task_id
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
   ORDER BY task.id
   FOR UPDATE OF task;
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
  -- The same order applies: every runtime row, then every task row, each in identity order.
  PERFORM 1
    FROM workhorse.fast_task_runtime fast
   WHERE fast.queue_name = p_queue_name AND fast.state = 'ready'
   ORDER BY fast.task_id
   FOR UPDATE;
  PERFORM 1
    FROM workhorse.fast_task_runtime fast
    JOIN workhorse.task task ON task.id = fast.task_id
   WHERE fast.queue_name = p_queue_name AND fast.state = 'ready'
   ORDER BY task.id
   FOR UPDATE OF task;
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
