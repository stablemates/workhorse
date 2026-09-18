-- workhorse-migration: {"kind":"additive"}

-- Budget admission holds a per-budget lock (SM-800).

-- claim_v1 decided whether to take the single workhorse:budgets lock from an EXISTS check on one
-- snapshot, then called budget_admission_v1 on a later one. A budgeted task committed between the
-- two was admitted without the lock, so two claims on different queues could both take the last
-- slot of a max_active budget, and a rate-capped budget could start work its bucket did not charge.
-- The single lock also serialized every claim on every budgeted queue.

-- budget_admission_v1 now takes a transaction advisory lock keyed by the budget name before it
-- counts. claim_one_v1 carries the claim body: it locks every budget named in its priority window,
-- in name order, and admits only rows whose budget lock it holds. claim_v1 is that claim with
-- waiting allowed. claim_many_v1 lets only its first claim wait, because a later claim already
-- holds budget locks and waiting on another could deadlock against a batch in a different order.
-- Every signature and result shape is unchanged.

-- Whether one budget admits one more start now. Counts only unexpired active leases naming the
-- budget and probes the bucket without consuming. It first takes the transaction advisory lock keyed
-- by the budget name, so the count reads every start another claim committed before the lock was
-- granted, and a start admitted here is charged before any other claim can read the same budget.
CREATE OR REPLACE FUNCTION workhorse.budget_admission_v1(
  p_budget_name text,
  p_now timestamptz
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_budget workhorse.budget%ROWTYPE;
  v_active integer;
  v_status record;
BEGIN
  IF p_budget_name IS NULL THEN RETURN true; END IF;
  SELECT * INTO v_budget FROM workhorse.budget budget WHERE budget.budget_name = p_budget_name;
  IF NOT FOUND THEN RETURN true; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budget:' || p_budget_name, 0));
  IF v_budget.max_active IS NOT NULL THEN
    SELECT count(*)::integer INTO v_active
      FROM workhorse.task_runtime active
     WHERE active.state = 'active'
       AND active.budget_name = p_budget_name
       AND active.expires_at > p_now;
    IF v_active >= v_budget.max_active THEN RETURN false; END IF;
  END IF;
  IF v_budget.rate_limit IS NOT NULL THEN
    SELECT * INTO STRICT v_status FROM workhorse.budget_bucket_v1(p_budget_name, p_now, false);
    IF NOT v_status.allowed THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;

-- Policy-aware claim. Governed queues serialize the short admission transaction through policy
-- rows, count only unexpired active leases, refill durable rate tokens from PostgreSQL time, and
-- inspect at most the highest-priority 100 ready rows. Concurrency remains a dispatch budget rather than a
-- guarantee that expired handler code has stopped executing. Budget capacity is counted across
-- queues (ADR 0067), so a claim locks every budget named in its priority window, one advisory lock
-- per budget name, before it reads the clock. It takes those locks in name order so two claims
-- that share budgets cannot deadlock. A claim that already holds budget locks from an earlier claim
-- in the same transaction passes p_wait_for_budgets = false: it takes only the locks it can get
-- without waiting and leaves rows naming any other budget for a later claim.
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
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_rate_status record;
  v_active integer;
  v_budget_name text;
  v_budget_names text[] := '{}';
  v_fence bigint;
  v_now timestamptz;
  v_expires timestamptz;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  -- Shared queue locks allow unrelated claims to overlap while serializing first policy creation
  -- and pruning against deployment synchronization for this queue.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || p_queue_name, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:rate-limit-policy:' || p_queue_name, 0)
  );
  SELECT policy.* INTO v_policy
    FROM workhorse.concurrency_policy policy
   WHERE policy.queue_name = p_queue_name
   FOR UPDATE;
  SELECT policy.* INTO v_rate_policy
    FROM workhorse.rate_limit_policy policy
   WHERE policy.queue_name = p_queue_name
   FOR UPDATE;
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
  v_expires := v_now + make_interval(secs => p_lease_ms::double precision / 1000.0);
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
  IF v_policy.queue_name IS NOT NULL THEN
    SELECT count(*)::integer INTO v_active
      FROM workhorse.task_runtime active
     WHERE active.state = 'active'
       AND active.queue_name = p_queue_name
       AND active.expires_at > v_now;
    IF v_active >= v_policy.max_active THEN RETURN; END IF;
  END IF;

  SELECT * INTO STRICT v_rate_status FROM workhorse.rate_limit_bucket_v1(
    p_queue_name, 'queue', '', v_rate_policy.rate_limit, v_rate_policy.rate_interval_ms,
    v_rate_policy.rate_burst, v_now, false
  );
  IF NOT v_rate_status.allowed THEN RETURN; END IF;

  v_fence := nextval('workhorse.fence_token_seq');
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
     FOR UPDATE OF runtime SKIP LOCKED
     LIMIT CASE
       WHEN v_policy.queue_name IS NULL AND v_rate_policy.per_key_limit IS NULL
         AND cardinality(v_budget_names) = 0 THEN 1
       ELSE 100
     END
  ), candidate AS (
    SELECT ready.task_id
      FROM ready_window ready
      CROSS JOIN LATERAL workhorse.rate_limit_bucket_v1(
        p_queue_name, 'key', ready.concurrency_key, v_rate_policy.per_key_limit,
        v_rate_policy.per_key_interval_ms, v_rate_policy.per_key_burst, v_now, false
      ) keyed_rate
     WHERE (
       v_policy.queue_name IS NULL
       OR v_policy.max_active_per_key IS NULL
       OR ready.concurrency_key IS NULL
       OR (
          SELECT count(*)
            FROM workhorse.task_runtime active
           WHERE active.state = 'active'
             AND active.queue_name = p_queue_name
             AND active.concurrency_key = ready.concurrency_key
             AND active.expires_at > v_now
        ) < v_policy.max_active_per_key
     ) AND keyed_rate.allowed
       AND CASE
         WHEN ready.budget_name IS NULL THEN true
         WHEN ready.budget_name = ANY(v_budget_names)
           THEN workhorse.budget_admission_v1(ready.budget_name, v_now)
         ELSE false
       END
     ORDER BY ready.priority DESC, ready.sequence, ready.task_id
     LIMIT 1
  )
  UPDATE workhorse.task_runtime runtime
     SET state = 'active', fence_token = v_fence, worker_id = p_worker_id,
         acquired_at = v_now, heartbeat_at = v_now, expires_at = v_expires,
         ready_at = NULL, sequence = NULL, wait_name = NULL,
         attempt_started_at = COALESCE(runtime.attempt_started_at, v_now),
         attempt_timeout_at = CASE
           WHEN task.execution_timeout_ms IS NULL THEN NULL
           ELSE v_now + make_interval(secs =>
             (task.execution_timeout_ms - runtime.execution_used_ms)::double precision / 1000.0)
         END,
         error = NULL, updated_at = v_now
    FROM candidate, workhorse.task task
   WHERE runtime.task_id = candidate.task_id AND runtime.state = 'ready' AND task.id = runtime.task_id
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
  RETURNING runtime.* INTO v_runtime;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM * FROM workhorse.rate_limit_bucket_v1(
    p_queue_name, 'queue', '', v_rate_policy.rate_limit, v_rate_policy.rate_interval_ms,
    v_rate_policy.rate_burst, v_now, true
  );
  PERFORM * FROM workhorse.rate_limit_bucket_v1(
    p_queue_name, 'key', v_runtime.concurrency_key, v_rate_policy.per_key_limit,
    v_rate_policy.per_key_interval_ms, v_rate_policy.per_key_burst, v_now, true
  );
  IF v_runtime.budget_name IS NOT NULL THEN
    PERFORM * FROM workhorse.budget_bucket_v1(v_runtime.budget_name, v_now, true);
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

-- Policy-aware claim of one task. claim_one_v1 owns ordering, policy and budget admission, rate
-- tokens, fencing, and the claim event; a standalone claim may wait for the budgets it needs.
CREATE OR REPLACE FUNCTION workhorse.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer DEFAULT 30000
) RETURNS TABLE (
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE sql
AS $$
  SELECT * FROM workhorse.claim_one_v1(p_queue_name, p_worker_id, p_lease_ms, true);
$$;

-- Claim several tasks through one client round trip while retaining claim_one_v1 as the single
-- owner of ordering, policy admission, rate tokens, fencing, and claim event semantics. Only the
-- first claim may wait for a budget lock; later claims already hold budget locks, so waiting on
-- another budget could deadlock against a batch that holds them in a different order.
CREATE OR REPLACE FUNCTION workhorse.claim_many_v1(
  p_queue_name text,
  p_worker_id text,
  p_limit integer,
  p_lease_ms integer DEFAULT 30000
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
  v_claimed integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
  END IF;
  FOR v_index IN 1..p_limit LOOP
    RETURN QUERY SELECT * FROM workhorse.claim_one_v1(
      p_queue_name, p_worker_id, p_lease_ms, v_index = 1
    );
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    EXIT WHEN v_claimed = 0;
  END LOOP;
END;
$$;
