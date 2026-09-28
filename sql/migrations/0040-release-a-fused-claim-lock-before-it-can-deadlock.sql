-- workhorse-migration: {"kind":"additive"}

-- Release a fused claim's row locks before its wait can deadlock (SM-934).

-- Migration 0031 ordered a worker's completion and heartbeat locks, but a fused claim could still
-- deadlock with another worker. The claim's FOR UPDATE SKIP LOCKED keeps its lock on a row whose
-- recheck fails because another worker has just leased it. It can also wait without a wait policy
-- while it follows that row's update chain. The owning worker's completion or heartbeat then waits
-- on the claim's lock, and PostgreSQL rolled one statement back with 40P01.
--
-- fast_claim_v1 now claims inside a subtransaction under a lock_timeout far below the default
-- deadlock_timeout. A claim that times out rolls back only its subtransaction, which releases its
-- row locks, and returns no rows. The completion in the same statement still commits. The
-- replacement keeps the signature and the result shape. A claim already returned up to p_limit
-- rows, so an empty claim is within its contract.

-- Claim up to p_limit ready rows of one fast-tier queue. The caller has already validated the
-- arguments and checked that the queue is not paused. The claimed event is optional per queue, and
-- the claim picks one of two statements rather than filtering a writable CTE, so a queue that
-- records no claims pays for no task_event write.
--
-- FOR UPDATE SKIP LOCKED skips a row another claim holds, but it can still wait. When it locks a
-- row whose ready version another worker has just leased, it follows the update chain, and that
-- walk waits without a wait policy. The claim then also keeps the lock on the row its recheck
-- rejected. The owning worker's completion or heartbeat can wait on that lock, and PostgreSQL
-- resolved the cycle with 40P01 (SM-934). The claim therefore runs in a subtransaction under a
-- lock_timeout far below the default deadlock_timeout. A claim that times out rolls back its
-- subtransaction, which releases every row lock it took, and claims nothing. The caller's
-- completion stays, and the worker's next poll claims again. The claim collects its rows before it
-- returns any, because a set-returning function cannot withdraw rows it has already returned.
CREATE OR REPLACE FUNCTION workhorse.fast_claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_limit integer,
  p_lease_ms integer,
  p_record_claims boolean
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
SET lock_timeout = '50ms'
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := clock_timestamp();
  v_claimed workhorse.fast_task_runtime[];
BEGIN
  BEGIN
    IF NOT p_record_claims THEN
      WITH claimed AS (
        UPDATE workhorse.fast_task_runtime runtime
           SET state = 'active', fence_token = nextval('workhorse.fence_token_seq'),
               worker_id = p_worker_id, claimed_at = v_now,
               expires_at = v_now + p_lease_ms * interval '1 millisecond',
               attempt_timeout_at = v_now + runtime.execution_timeout_ms * interval '1 millisecond'
         WHERE runtime.task_id = ANY (ARRAY(
                 SELECT candidate.task_id FROM workhorse.fast_task_runtime candidate
                  WHERE candidate.state = 'ready' AND candidate.queue_name = p_queue_name
                    AND candidate.run_at <= v_now
                    AND (candidate.deadline_at IS NULL OR candidate.deadline_at > v_now)
                  ORDER BY candidate.priority DESC, candidate.run_at, candidate.sequence
                  LIMIT p_limit
                  FOR UPDATE SKIP LOCKED
               ))
           AND runtime.state = 'ready'
        RETURNING runtime.*
      )
      SELECT array_agg(
               claimed::workhorse.fast_task_runtime
               ORDER BY claimed.priority DESC, claimed.run_at, claimed.sequence
             )
        INTO v_claimed
        FROM claimed;
    ELSE
      WITH claimed AS (
        UPDATE workhorse.fast_task_runtime runtime
           SET state = 'active', fence_token = nextval('workhorse.fence_token_seq'),
               worker_id = p_worker_id, claimed_at = v_now,
               expires_at = v_now + p_lease_ms * interval '1 millisecond',
               attempt_timeout_at = v_now + runtime.execution_timeout_ms * interval '1 millisecond'
         WHERE runtime.task_id = ANY (ARRAY(
                 SELECT candidate.task_id FROM workhorse.fast_task_runtime candidate
                  WHERE candidate.state = 'ready' AND candidate.queue_name = p_queue_name
                    AND candidate.run_at <= v_now
                    AND (candidate.deadline_at IS NULL OR candidate.deadline_at > v_now)
                  ORDER BY candidate.priority DESC, candidate.run_at, candidate.sequence
                  LIMIT p_limit
                  FOR UPDATE SKIP LOCKED
               ))
           AND runtime.state = 'ready'
        RETURNING runtime.*
      ), claim_events AS (
        INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
        SELECT claimed.task_id, claimed.attempt, 'claimed',
               jsonb_build_object(
                 'worker_id', p_worker_id, 'fence_token', claimed.fence_token::text,
                 'expires_at', claimed.expires_at
               )
          FROM claimed
      )
      SELECT array_agg(
               claimed::workhorse.fast_task_runtime
               ORDER BY claimed.priority DESC, claimed.run_at, claimed.sequence
             )
        INTO v_claimed
        FROM claimed;
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RETURN;
  END;
  RETURN QUERY
    SELECT claimed.task_id, claimed.task_type, claimed.priority, claimed.payload,
           claimed.contract_version, claimed.result_max_bytes, claimed.redact,
           claimed.trace_context, claimed.attempt, claimed.max_attempts, claimed.retry_policy,
           claimed.deadline_at, claimed.execution_timeout_ms, claimed.attempt_timeout_at,
           claimed.fence_token, claimed.expires_at
      FROM unnest(v_claimed) WITH ORDINALITY AS claimed
     ORDER BY claimed.ordinality;
END;
$$;
