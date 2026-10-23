-- workhorse-migration: {"kind":"additive"}

-- Report the retry state of a fast-tier task after an attempt timeout (SM-1694).

-- expire_owned_telemetry_v1 settles a due deadline or attempt timeout and returns status and
-- retry_state. The TypeScript, Python, Ruby, JVM, and .NET workers use retry_state to record a
-- workhorse.retry span and one workhorse.tasks.retried count. Before this step, the body reads
-- retry_state only from task_runtime. A fast-tier task keeps its runtime row in fast_task_runtime.
-- Thus, after fast_timeout_owned_v1 retries a fast-tier task, the earlier body returns a null
-- retry_state, and the worker records no retry telemetry. The task state is correct.
--
-- After this step, if status is timeout_exceeded and task_runtime has no ready or scheduled row,
-- the function reads the ready row in fast_task_runtime. A fast-tier row has no scheduled state, so
-- the function reports a ready row with a future run time as scheduled. The task status projection
-- of the fast tier uses the same rule. The full tier keeps its earlier values.
--
-- The name, the arguments, and the result columns do not change. The documentation states that
-- retry_state is ready or scheduled when the timeout retries the task, and null otherwise. The
-- earlier fast-tier null is a defect against that statement. Thus the function keeps its suffix
-- under ADR 0109, and the SDK floor stays the same.

CREATE OR REPLACE FUNCTION workhorse.expire_owned_telemetry_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS TABLE(status text, retry_state text)
LANGUAGE plpgsql
AS $$
BEGIN
  status := workhorse.expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  IF status = 'timeout_exceeded' THEN
    SELECT runtime.state INTO retry_state FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = p_task_id AND runtime.state IN ('ready', 'scheduled');
    IF retry_state IS NULL THEN
      -- A fast-tier row has no scheduled state; a ready row with a future run time is one.
      SELECT CASE WHEN fast.run_at > clock_timestamp() THEN 'scheduled' ELSE 'ready' END
        INTO retry_state
        FROM workhorse.fast_task_runtime fast
       WHERE fast.task_id = p_task_id AND fast.state = 'ready';
    END IF;
  END IF;
  RETURN NEXT;
END;
$$;
