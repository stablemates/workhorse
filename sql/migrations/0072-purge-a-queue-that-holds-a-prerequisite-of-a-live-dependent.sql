-- workhorse-migration: {"kind":"additive"}

-- Purge a queue that holds a prerequisite of a live dependent (SM-1284, ADR 0101).

-- task_dependency.prerequisite_task_id restricts deletion. purge_queue_internal_v1 deleted every
-- blocked, ready, and scheduled task of its queue, so a purge that held the prerequisite of a
-- dependent failed with 23001. That happened for a dependent in the same queue too, because one
-- delete removed both ends of the edge. The purge now removes the edges of the tasks it deletes
-- first. It does not delete a task whose dependent stays: it cancels that task as cancel_v1 does,
-- and the outcome trigger resolves the dependent by its own policy. A task stays when a pending
-- edge leads to a dependent outside the purge, or to a task that stays. The purge locks those
-- dependents after its own tasks, FOR NO KEY UPDATE, as a cancel does. One advisory lock makes
-- two purges run one after the other, so two purges cannot lock those rows in opposite orders.
-- The returned count includes the canceled tasks. The signature does not change. No change touches stored data.

CREATE OR REPLACE FUNCTION workhorse.purge_queue_internal_v1(p_queue_name text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_fast_count integer;
  v_purged_task_ids uuid[];
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
  -- A cancel below settles the blocked dependents in other queues. Lock them as a cancel does:
  -- after the prerequisites, in identity order, FOR NO KEY UPDATE. A terminal transition of a
  -- purged task also locks it before its dependents, so the two cannot deadlock. The lock does not
  -- conflict with the key-share lock of an enqueue that names a dependent.
  PERFORM 1
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id IN (
           SELECT dependency.dependent_task_id
             FROM workhorse.task_runtime purged
             JOIN workhorse.task_dependency dependency
               ON dependency.prerequisite_task_id = purged.task_id
            WHERE purged.queue_name = p_queue_name
              AND purged.state IN ('blocked', 'ready', 'scheduled')
              AND dependency.released_at IS NULL
         )
     AND runtime.state = 'blocked'
     AND runtime.queue_name <> p_queue_name
   ORDER BY runtime.task_id
   FOR NO KEY UPDATE;
  v_purged_task_ids := ARRAY(
    SELECT runtime.task_id
      FROM workhorse.task_runtime runtime
     WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
     ORDER BY runtime.task_id
  );

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
  -- A fast-tier task is never a prerequisite.
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
