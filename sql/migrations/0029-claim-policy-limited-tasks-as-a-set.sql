-- workhorse-migration: {"kind":"additive"}

-- A queue with a concurrency or rate-limit policy claims a batch as a set (SM-915).

-- claim_many_v1 called claim_one_v1 once per task. On a queue with a policy every call locked the
-- policy rows, sampled and locked budgets, pruned key buckets, counted active leases, read a window
-- of up to 100 ready rows, and charged each bucket for one start. A batch of n tasks paid that n
-- times, and every other claim on the queue waited behind the policy row locks while it did.

-- claim_many_v1 now admits such a batch in rounds. Each round reads the window once, derives how
-- many rows each concurrency key and each budget can still start, and activates every admitted row
-- in one statement. It then charges each bucket once with the number of starts it admitted.
-- claim_v1 is claim_many_v1 with a limit of one, so single claims take the same admission path. A
-- queue with no policy keeps the claim_one_v1 loop. Every signature and result shape is unchanged.

-- Claim several tasks through one client round trip. A fast-tier queue branches to fast_claim_v1.
-- A queue with no concurrency or rate-limit policy repeats claim_one_v1 until the limit or an empty
-- claim; only the first claim may wait for a budget lock, because later claims already hold budget
-- locks and waiting on another could deadlock against a batch that holds them in a different order.
-- A queue with a concurrency or rate-limit policy admits the batch as a set (SM-915). It locks the
-- policy rows and the window's budgets once, reads the clock once, and derives from one read of the
-- 100-row window how many rows each concurrency key and each budget can still start: the room left
-- under max_active_per_key and max_active, and the whole tokens left in the per-key and budget
-- buckets. A row whose key or budget has no room is dropped, and the rest are ranked within their
-- key and within their budget in claim order. A row is admitted when both ranks fit, and the batch
-- takes at most as many rows as the queue's own active room and whole queue tokens allow. It then
-- locks only the admitted rows, activates them, appends their claim events, and charges every
-- bucket once with the number of starts it admitted. A round never admits more than claim_one_v1
-- would. It can admit fewer when a row has both a limited key and a limited budget, because such a
-- row can use a key rank and then miss its budget rank. The first row that claim_one_v1 would take
-- always fits both ranks, so a round admits nothing only when claim_one_v1 would admit nothing. A
-- short round is repeated from a fresh window, with budget locks it can take without waiting, until
-- the limit, an empty round, exhausted queue capacity, or a window that no further round can change.
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
  v_control workhorse.queue_control%ROWTYPE;
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_budget_name text;
  v_budget_names text[] := '{}';
  v_first_round boolean := true;
  v_now timestamptz;
  v_expires timestamptz;
  v_room integer;
  v_take integer;
  v_queue_capped boolean;
  v_window integer;
  v_mixed boolean;
  v_fit integer;
  v_picked uuid[];
  v_fences bigint[];
  v_ids uuid[];
  v_keys text[];
  v_budgets text[];
  v_total integer := 0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
  END IF;
  -- A fast-tier queue has no admission policy to apply row by row, so it claims the whole batch in
  -- one statement.
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF FOUND AND v_control.tier = 'fast' THEN
    IF p_worker_id IS NULL OR p_worker_id = '' THEN
      RAISE EXCEPTION 'worker_id must not be empty';
    END IF;
    IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
      RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
    END IF;
    IF NOT v_control.paused THEN
      RETURN QUERY SELECT * FROM workhorse.fast_claim_v1(
        p_queue_name, p_worker_id, p_limit, p_lease_ms, v_control.record_claims
      );
    END IF;
    RETURN;
  END IF;
  -- This read takes no lock. A policy created after it is still enforced, because claim_one_v1
  -- locks and applies the policy rows itself. A policy removed after it leaves the set path with no
  -- rule to apply, and admits as a plain claim would.
  IF NOT EXISTS (
    SELECT 1 FROM workhorse.concurrency_policy policy WHERE policy.queue_name = p_queue_name
  ) AND NOT EXISTS (
    SELECT 1 FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = p_queue_name
  ) THEN
    FOR v_index IN 1..p_limit LOOP
      RETURN QUERY SELECT * FROM workhorse.claim_one_v1(
        p_queue_name, p_worker_id, p_lease_ms, v_index = 1
      );
      GET DIAGNOSTICS v_claimed = ROW_COUNT;
      EXIT WHEN v_claimed = 0;
    END LOOP;
    RETURN;
  END IF;

  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  -- The same locks claim_one_v1 takes. The policy row locks serialize every policy claim on this
  -- queue, so no other claim changes the counts and buckets this batch reads until it commits.
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

  LOOP
    -- Lock each budget the window can name, in name order, before reading the clock. Only the
    -- first round may wait; a later round already holds budget locks and takes only the ones it can
    -- get at once.
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
      CONTINUE WHEN v_budget_name = ANY(v_budget_names);
      IF v_first_round THEN
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

    IF v_first_round THEN
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
    END IF;
    v_first_round := false;

    -- The queue's own room: unexpired active leases under max_active and whole queue tokens.
    v_take := p_limit - v_total;
    v_queue_capped := false;
    IF v_policy.queue_name IS NOT NULL THEN
      SELECT v_policy.max_active - count(*)::integer INTO v_room
        FROM workhorse.task_runtime active
       WHERE active.state = 'active'
         AND active.queue_name = p_queue_name
         AND active.expires_at > v_now;
      IF v_room <= v_take THEN v_take := v_room; v_queue_capped := true; END IF;
    END IF;
    IF v_rate_policy.rate_limit IS NOT NULL THEN
      SELECT floor(status.tokens)::integer INTO v_room
        FROM workhorse.rate_limit_bucket_v1(
          p_queue_name, 'queue', '', v_rate_policy.rate_limit, v_rate_policy.rate_interval_ms,
          v_rate_policy.rate_burst, v_now, false
        ) status;
      IF v_room <= v_take THEN v_take := v_room; v_queue_capped := true; END IF;
    END IF;
    EXIT WHEN v_take <= 0;

    -- The window reads without locking, and only the admitted rows are locked (SM-801). A null
    -- room means no rule limits that key or budget.
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
    ), key_room AS (
      SELECT keys.concurrency_key, LEAST(
        CASE WHEN v_policy.max_active_per_key IS NOT NULL THEN
          v_policy.max_active_per_key - (
            SELECT count(*)::integer
              FROM workhorse.task_runtime active
             WHERE active.state = 'active'
               AND active.queue_name = p_queue_name
               AND active.concurrency_key = keys.concurrency_key
               AND active.expires_at > v_now
          )
        END,
        CASE WHEN v_rate_policy.per_key_limit IS NOT NULL THEN floor(LEAST(
          v_rate_policy.per_key_burst::numeric,
          COALESCE(
            bucket.tokens + GREATEST(
              0::numeric,
              extract(epoch FROM v_now - bucket.refilled_at) * 1000
            ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric,
            v_rate_policy.per_key_burst::numeric
          )
        ))::integer END
      ) AS room
        FROM (
          SELECT DISTINCT ready.concurrency_key FROM ready_window ready
           WHERE ready.concurrency_key IS NOT NULL
        ) keys
        LEFT JOIN workhorse.rate_limit_bucket bucket
          ON bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
         AND bucket.bucket_key = keys.concurrency_key
    ), budget_room AS (
      -- A budget this claim never locked has no room, whether or not it exists.
      SELECT names.budget_name, CASE
        WHEN NOT (names.budget_name = ANY(v_budget_names)) THEN 0
        WHEN budget.budget_name IS NULL THEN NULL
        ELSE LEAST(
          budget.max_active - (
            SELECT count(*)::integer
              FROM workhorse.task_runtime active
             WHERE active.state = 'active'
               AND active.budget_name = names.budget_name
               AND active.expires_at > v_now
          ),
          CASE WHEN budget.rate_limit IS NOT NULL THEN floor(LEAST(
            budget.rate_burst::numeric,
            COALESCE(
              bucket.tokens + GREATEST(
                0::numeric,
                extract(epoch FROM v_now - bucket.refilled_at) * 1000
              ) * budget.rate_limit::numeric / budget.rate_interval_ms::numeric,
              budget.rate_burst::numeric
            )
          ))::integer END
        )
      END AS room
        FROM (
          SELECT DISTINCT ready.budget_name FROM ready_window ready
           WHERE ready.budget_name IS NOT NULL
        ) names
        LEFT JOIN workhorse.budget budget ON budget.budget_name = names.budget_name
        LEFT JOIN workhorse.budget_bucket bucket ON bucket.budget_name = names.budget_name
    ), eligible AS (
      SELECT ready.task_id, ready.concurrency_key, ready.budget_name, ready.priority,
             ready.sequence, key_room.room AS key_room, budget_room.room AS budget_room
        FROM ready_window ready
        LEFT JOIN key_room ON key_room.concurrency_key = ready.concurrency_key
        LEFT JOIN budget_room ON budget_room.budget_name = ready.budget_name
       WHERE COALESCE(key_room.room, 1) >= 1 AND COALESCE(budget_room.room, 1) >= 1
    ), ranked AS (
      SELECT eligible.*,
             row_number() OVER (
               PARTITION BY eligible.concurrency_key
               ORDER BY eligible.priority DESC, eligible.sequence, eligible.task_id
             ) AS key_rank,
             row_number() OVER (
               PARTITION BY eligible.budget_name
               ORDER BY eligible.priority DESC, eligible.sequence, eligible.task_id
             ) AS budget_rank
        FROM eligible
    ), picked AS (
      SELECT runtime.task_id, ranked.priority, ranked.sequence
        FROM ranked
        JOIN workhorse.task_runtime runtime ON runtime.task_id = ranked.task_id
       WHERE runtime.state = 'ready'
         AND (ranked.key_room IS NULL OR ranked.key_rank <= ranked.key_room)
         AND (ranked.budget_room IS NULL OR ranked.budget_rank <= ranked.budget_room)
       ORDER BY ranked.priority DESC, ranked.sequence, ranked.task_id
       FOR NO KEY UPDATE OF runtime SKIP LOCKED
       LIMIT v_take
    )
    SELECT (SELECT array_agg(picked.task_id ORDER BY picked.priority DESC, picked.sequence,
                             picked.task_id)
              FROM picked),
           (SELECT count(*)::integer FROM ready_window),
           (SELECT COALESCE(bool_or(eligible.key_room IS NOT NULL
                                    AND eligible.budget_room IS NOT NULL), false)
              FROM eligible),
           (SELECT count(*)::integer FROM ranked
             WHERE (ranked.key_room IS NULL OR ranked.key_rank <= ranked.key_room)
               AND (ranked.budget_room IS NULL OR ranked.budget_rank <= ranked.budget_room))
      INTO v_picked, v_window, v_mixed, v_fit;
    v_claimed := COALESCE(cardinality(v_picked), 0);
    EXIT WHEN v_claimed = 0;

    SELECT array_agg(fence ORDER BY fence) INTO v_fences
      FROM (
        SELECT nextval('workhorse.fence_token_seq') AS fence
          FROM generate_series(1, v_claimed)
      ) allocated;
    WITH activated AS (
      UPDATE workhorse.task_runtime runtime
         SET state = 'active', fence_token = v_fences[array_position(v_picked, runtime.task_id)],
             worker_id = p_worker_id,
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
       WHERE runtime.task_id = ANY(v_picked) AND runtime.state = 'ready'
         AND task.id = runtime.task_id
         AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
      RETURNING runtime.task_id, runtime.current_attempt, runtime.fence_token,
                runtime.concurrency_key, runtime.budget_name
    ), events AS (
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      SELECT activated.task_id, activated.current_attempt, 'claimed',
             jsonb_build_object(
               'worker_id', p_worker_id, 'fence_token', activated.fence_token::text,
               'expires_at', v_expires
             )
        FROM activated
       ORDER BY activated.fence_token
    )
    SELECT array_agg(activated.task_id ORDER BY activated.fence_token),
           array_agg(activated.concurrency_key ORDER BY activated.fence_token),
           array_agg(activated.budget_name ORDER BY activated.fence_token)
      INTO v_ids, v_keys, v_budgets
      FROM activated;
    v_claimed := COALESCE(cardinality(v_ids), 0);

    -- Charge each bucket once for the starts this round admitted. A missing bucket starts full,
    -- as in rate_limit_bucket_v1 and budget_bucket_v1, and refill never runs from a clock ahead of
    -- this claim.
    IF v_claimed > 0 AND v_rate_policy.rate_limit IS NOT NULL THEN
      INSERT INTO workhorse.rate_limit_bucket(
        queue_name, bucket_scope, bucket_key, tokens, refilled_at
      ) VALUES (p_queue_name, 'queue', '', v_rate_policy.rate_burst, v_now)
      ON CONFLICT DO NOTHING;
      UPDATE workhorse.rate_limit_bucket bucket
         SET tokens = LEAST(
               v_rate_policy.rate_burst::numeric,
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM v_now - bucket.refilled_at) * 1000
               ) * v_rate_policy.rate_limit::numeric / v_rate_policy.rate_interval_ms::numeric
             ) - v_claimed,
             refilled_at = GREATEST(v_now, bucket.refilled_at)
       WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'queue'
         AND bucket.bucket_key = '';
    END IF;
    IF v_claimed > 0 AND v_rate_policy.per_key_limit IS NOT NULL THEN
      INSERT INTO workhorse.rate_limit_bucket(
        queue_name, bucket_scope, bucket_key, tokens, refilled_at
      )
      SELECT DISTINCT p_queue_name, 'key', claimed.bucket_key, v_rate_policy.per_key_burst, v_now
        FROM unnest(v_keys) AS claimed(bucket_key)
       WHERE claimed.bucket_key IS NOT NULL
      ON CONFLICT DO NOTHING;
      UPDATE workhorse.rate_limit_bucket bucket
         SET tokens = LEAST(
               v_rate_policy.per_key_burst::numeric,
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM v_now - bucket.refilled_at) * 1000
               ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric
             ) - started.starts,
             refilled_at = GREATEST(v_now, bucket.refilled_at)
        FROM (
          SELECT claimed.bucket_key, count(*)::integer AS starts
            FROM unnest(v_keys) AS claimed(bucket_key)
           WHERE claimed.bucket_key IS NOT NULL
           GROUP BY claimed.bucket_key
        ) started
       WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
         AND bucket.bucket_key = started.bucket_key;
    END IF;
    IF v_claimed > 0 AND EXISTS (
      SELECT 1 FROM unnest(v_budgets) AS claimed(budget_name) WHERE claimed.budget_name IS NOT NULL
    ) THEN
      INSERT INTO workhorse.budget_bucket(budget_name, tokens, refilled_at)
      SELECT budget.budget_name, budget.rate_burst, v_now
        FROM workhorse.budget budget
       WHERE budget.rate_limit IS NOT NULL AND budget.budget_name = ANY(v_budgets)
      ON CONFLICT DO NOTHING;
      UPDATE workhorse.budget_bucket bucket
         SET tokens = LEAST(
               budget.rate_burst::numeric,
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM v_now - bucket.refilled_at) * 1000
               ) * budget.rate_limit::numeric / budget.rate_interval_ms::numeric
             ) - started.starts,
             refilled_at = GREATEST(v_now, bucket.refilled_at)
        FROM workhorse.budget budget, (
          SELECT claimed.budget_name, count(*)::integer AS starts
            FROM unnest(v_budgets) AS claimed(budget_name)
           WHERE claimed.budget_name IS NOT NULL
           GROUP BY claimed.budget_name
        ) started
       WHERE budget.budget_name = started.budget_name AND budget.rate_limit IS NOT NULL
         AND bucket.budget_name = started.budget_name;
    END IF;

    RETURN QUERY
      SELECT task.id, task.task_type, task.priority, task.payload, task.contract_version,
             task.result_max_bytes,
             cardinality(task.payload_redact_keys) > 0 OR cardinality(task.result_redact_keys) > 0,
             task.trace_context,
             runtime.current_attempt, task.max_attempts,
             task.retry_policy, task.deadline_at, task.execution_timeout_ms,
             runtime.attempt_timeout_at, runtime.fence_token, runtime.expires_at
        FROM unnest(v_ids) WITH ORDINALITY AS claimed(task_id, ordinality)
        JOIN workhorse.task task ON task.id = claimed.task_id
        JOIN workhorse.task_runtime runtime ON runtime.task_id = claimed.task_id
       ORDER BY claimed.ordinality;
    v_total := v_total + v_claimed;
    -- A round stops the batch when it fills the limit or the queue's own room. It also stops the
    -- batch when its window held every ready row, no row had both a limited key and a limited
    -- budget, and it activated every row that fit, because then it admitted every row claim_one_v1
    -- would have admitted.
    EXIT WHEN v_total >= p_limit OR (v_queue_capped AND v_claimed >= v_take)
      OR (v_window < 100 AND NOT v_mixed AND v_claimed >= v_fit);
  END LOOP;
END;
$$;

-- Policy-aware claim of one task. It is claim_many_v1 with a limit of one, so a single claim and a
-- batch share one admission path on every queue.
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
  SELECT * FROM workhorse.claim_many_v1(p_queue_name, p_worker_id, 1, p_lease_ms);
$$;

