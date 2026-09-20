-- workhorse-migration: {"kind":"additive"}

-- A claim locks only the row it takes (SM-801).

-- claim_one_v1 locked up to 100 ready rows with FOR UPDATE SKIP LOCKED before per-key, per-key
-- rate, and budget admission ran over them. On a queue whose keys were all saturated the claim
-- admitted nothing and still wrote a lock record for every row it had sampled, and every
-- completion on such a queue wakes every worker, so that empty claim repeated once per worker per
-- completion.

-- The window now reads without locking whenever an admission rule can pass over a row, and only
-- the chosen candidate is locked, with SKIP LOCKED so a row another claim holds is passed over.
-- The admission decision cannot go stale between the read and the lock: max_active_per_key holds
-- the concurrency policy row, a per-key rate cap holds the rate-limit policy row, and a budget
-- holds its advisory lock, each until the claim transaction ends. A queue with no policy, no
-- per-key rate cap, and no budgeted ready work keeps the one-row fast path, which already locked
-- only the row it took. Every signature and result shape is unchanged.

-- Policy-aware claim. Governed queues serialize the short admission transaction through policy
-- rows, count only unexpired active leases, refill durable rate tokens from PostgreSQL time, and
-- inspect at most the highest-priority 100 ready rows. Concurrency remains a dispatch budget rather than a
-- guarantee that expired handler code has stopped executing. Budget capacity is counted across
-- queues (ADR 0067), so a claim locks every budget named in its priority window, one advisory lock
-- per budget name, before it reads the clock. It takes those locks in name order so two claims
-- that share budgets cannot deadlock. A claim that already holds budget locks from an earlier claim
-- in the same transaction passes p_wait_for_budgets = false: it takes only the locks it can get
-- without waiting and leaves rows naming any other budget for a later claim.
-- A claim that can pass over a row reads its window without locking and locks only the candidate it
-- takes (SM-801), so a claim that admits nothing writes no row lock. The admission decision cannot
-- go stale between that read and the lock: max_active_per_key holds the concurrency policy row,
-- a per-key rate cap holds the rate-limit policy row, and a budget holds its advisory lock, each
-- until this transaction ends. A queue with no policy, no per-key rate cap, and no budget lock
-- keeps the one-row fast path, which locks the first ready row it can take. That row holds the line
-- when it names a budget this claim never locked, because reading past it has no bound.
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
  v_task_id uuid;
  v_candidate_budget text;
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
  IF v_policy.queue_name IS NULL AND v_rate_policy.per_key_limit IS NULL
     AND cardinality(v_budget_names) = 0 THEN
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
     FOR UPDATE OF runtime SKIP LOCKED
     LIMIT 1;
    IF v_candidate_budget IS NOT NULL THEN RETURN; END IF;
  ELSE
    -- An admission rule can pass over a row, so the window reads without locking and only the
    -- chosen candidate is locked. A claim that admits nothing leaves every sampled row unlocked.
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
    )
    SELECT runtime.task_id INTO v_task_id
      FROM admissible
      JOIN workhorse.task_runtime runtime ON runtime.task_id = admissible.task_id
     WHERE runtime.state = 'ready'
     ORDER BY admissible.priority DESC, admissible.sequence, admissible.task_id
     FOR UPDATE OF runtime SKIP LOCKED
     LIMIT 1;
  END IF;
  IF v_task_id IS NULL THEN RETURN; END IF;

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
    FROM workhorse.task task
   WHERE runtime.task_id = v_task_id AND runtime.state = 'ready' AND task.id = runtime.task_id
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
