-- workhorse-migration: {"kind":"additive"}

-- Reject an oversized fast-tier result per row (SM-941).

-- fast_complete_many_v1 raised when any result in its batch exceeded its result_max_bytes. Inside
-- complete_many_and_claim_v1 that exception rolled back every completion of the statement and the
-- refill claim that followed them, so one oversized row failed up to a whole batch of unrelated
-- work. The server measures octet_length(result::jsonb::text), and PostgreSQL's jsonb text puts a
-- space after each ':' and ',', so a result that a client measured as compact JSON could still be
-- over the limit. Some SDKs do not measure results at all.
--
-- The function now fails each oversized attempt on its own through fast_fail_v1, with a
-- TaskValueSizeLimitError envelope, and completes the rest. fast_complete_v1 becomes PL/pgSQL so a
-- single completion still raises, as complete_v1 does on the full tier. Every signature and result
-- shape is unchanged.

-- Complete a batch of fast-tier attempts in one statement. Each accepted attempt deletes its
-- runtime row and writes its outcome row. An attempt whose fence, lease, deadline, attempt timeout,
-- or cancellation no longer allows completion is left alone and missing from the result, exactly
-- as complete_v1 returns false for it.
--
-- The worker checks result sizes before it calls, but not every SDK does, and a client measure can
-- disagree with PostgreSQL's jsonb text. An oversized result therefore fails only its own attempt.
-- The function passes it to fast_fail_v1 with a TaskValueSizeLimitError envelope, so the retry
-- policy decides what happens next, and leaves it out of the result. The other completions in the
-- batch, and the fused claim that follows them, are unaffected. fast_complete_v1 keeps raising for
-- one oversized result, as complete_v1 does on the full tier.
--
-- The DELETE matches on the primary key, the fence, and the owning worker. It has no state
-- predicate: fast_task_runtime_state_shape_check gives a ready row a NULL worker_id, so the
-- worker match already implies an active row. A state predicate let the planner prefer
-- fast_task_runtime_active_due_idx, whose scan grows with every active row of every worker.
-- The generic plan keeps the primary-key plan: a custom plan per call cost more to plan than
-- the statement costs to run. The history insert joins queue_control once instead of calling
-- fast_records_attempts_v1 per completed row.
--
-- Before the DELETE, the function locks the worker's rows in task ID order, as
-- fast_heartbeat_many_v1 does. The DELETE's plan locks rows in input order, and a heartbeat's plan
-- can lock them in index order. Without the shared order, a worker's completion and its own
-- heartbeat could each hold a row the other needs, and PostgreSQL rolled one back with 40P01.
-- The oversized attempts fail after that lock, in task ID order, so they add no new lock order.
CREATE OR REPLACE FUNCTION workhorse.fast_complete_many_v1(
  p_worker_id text, p_task_ids uuid[], p_fence_tokens bigint[], p_results jsonb[]
) RETURNS uuid[]
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_accepted uuid[];
  v_oversized uuid[] := '{}'::uuid[];
  v_rejection record;
BEGIN
  PERFORM 1 FROM (
    SELECT FROM workhorse.fast_task_runtime runtime
     WHERE runtime.task_id = ANY (p_task_ids) AND runtime.worker_id = p_worker_id
     ORDER BY runtime.task_id
       FOR UPDATE
  ) locked;
  FOR v_rejection IN
    SELECT input.task_id, input.fence_token, runtime.task_type
      FROM unnest(p_task_ids, p_fence_tokens, p_results) AS input(task_id, fence_token, result)
      JOIN workhorse.fast_task_runtime runtime ON runtime.task_id = input.task_id
     WHERE octet_length(COALESCE(input.result, 'null'::jsonb)::text) > runtime.result_max_bytes
     ORDER BY input.task_id
  LOOP
    v_oversized := v_oversized || v_rejection.task_id;
    PERFORM workhorse.fast_fail_v1(
      v_rejection.task_id, p_worker_id, v_rejection.fence_token,
      jsonb_build_object(
        'name', 'TaskValueSizeLimitError',
        'message', v_rejection.task_type || ' result exceeds its configured size limit',
        'stack', NULL
      ),
      NULL
    );
  END LOOP;
  WITH input AS (
    SELECT * FROM unnest(p_task_ids, p_fence_tokens, p_results)
      AS input(task_id, fence_token, result)
     WHERE input.task_id <> ALL (v_oversized)
  ), done AS (
    DELETE FROM workhorse.fast_task_runtime runtime
     USING input
     WHERE runtime.task_id = input.task_id
       AND runtime.fence_token = input.fence_token AND runtime.worker_id = p_worker_id
       AND runtime.expires_at > v_now
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
       AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
       AND runtime.cancel_requested_at IS NULL
    RETURNING runtime.*, COALESCE(input.result, 'null'::jsonb) AS result
  ), kept AS (
    INSERT INTO workhorse.fast_task_outcome(
      task_id, queue_name, task_type, state, attempt, result,
      fence_token, worker_id, claimed_at, enqueued_at, finished_at, errors, errors_dropped
    )
    SELECT done.task_id, done.queue_name, done.task_type, 'succeeded', done.attempt, done.result,
           done.fence_token, done.worker_id, done.claimed_at, done.enqueued_at, v_now,
           done.errors, done.errors_dropped
      FROM done
    RETURNING fast_task_outcome.task_id
  ), history AS (
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at
    )
    SELECT done.task_id, done.attempt, done.fence_token, done.worker_id, 'succeeded',
           done.claimed_at, done.claimed_at, v_now
      FROM done
      JOIN workhorse.queue_control control
        ON control.queue_name = done.queue_name AND control.record_attempts
  )
  SELECT COALESCE(array_agg(kept.task_id), '{}'::uuid[]) INTO v_accepted FROM kept;
  RETURN v_accepted;
END;
$$;

-- Complete one fast-tier attempt. An oversized result raises, as complete_v1 raises on the full
-- tier, so a single completion keeps the same outcome on either tier.
CREATE OR REPLACE FUNCTION workhorse.fast_complete_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_result jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workhorse.fast_task_runtime runtime
     WHERE runtime.task_id = p_task_id
       AND octet_length(COALESCE(p_result, 'null'::jsonb)::text) > runtime.result_max_bytes
  ) THEN
    RAISE EXCEPTION 'result exceeds its configured size limit';
  END IF;
  RETURN cardinality(workhorse.fast_complete_many_v1(
    p_worker_id, ARRAY[p_task_id], ARRAY[p_fence_token], ARRAY[p_result]
  )) = 1;
END;
$$;
