-- workhorse-migration: {"kind":"additive"}

-- Refuse a claim below read committed isolation (SM-1001).

-- Budget admission takes an advisory lock for each budget and then counts the active leases that
-- hold it. Under repeatable read or serializable, every statement reads the snapshot the
-- transaction took first, which can predate the lock wait. A claim that waited for a concurrent
-- claim on another queue then missed that claim's committed lease and admitted past maxActive.
--
-- Each claim entry point below now raises SQLSTATE 0A000 before it takes a lock unless the
-- transaction runs at read committed. PostgreSQL runs read uncommitted as read committed, so that
-- level is accepted. claim_v1 calls claim_many_v1 and needs no change.

CREATE OR REPLACE FUNCTION workhorse.complete_many_and_claim_v1(
  p_worker_id text,
  p_task_ids uuid[],
  p_fence_tokens bigint[],
  p_results jsonb[],
  p_queue_name text,
  p_limit integer,
  p_lease_ms integer DEFAULT 30000
) RETURNS TABLE (
  accepted uuid[],
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_accepted uuid[];
  v_control workhorse.queue_control%ROWTYPE;
  v_first boolean := true;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 0 and 100';
  END IF;
  IF p_task_ids IS NULL OR p_fence_tokens IS NULL OR p_results IS NULL
     OR cardinality(p_task_ids) > 100
     OR cardinality(p_task_ids) <> cardinality(p_fence_tokens)
     OR cardinality(p_task_ids) <> cardinality(p_results) THEN
    RAISE EXCEPTION 'completions must contain at most 100 entries with one fence token and result each';
  END IF;
  -- Admission counts active leases after it takes its locks, and only a statement snapshot taken
  -- after those locks sees every committed lease. PostgreSQL runs read uncommitted as read committed.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      ERRCODE = '0A000',
      MESSAGE = format(
        'Workhorse claims require read committed isolation, not %s',
        current_setting('transaction_isolation')
      );
  END IF;
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF NOT FOUND OR v_control.tier <> 'fast' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1007',
      MESSAGE = format('queue %s is not a fast-tier queue', p_queue_name),
      DETAIL = jsonb_build_object('queue', p_queue_name, 'feature', 'batched completion')::text;
  END IF;
  v_accepted := workhorse.fast_complete_many_v1(p_worker_id, p_task_ids, p_fence_tokens, p_results);
  IF p_limit > 0 AND NOT v_control.paused THEN
    -- One set-returning query streams the claims. A per-row RETURN NEXT loop costs measurably more
    -- per claim on the hot path.
    RETURN QUERY
      SELECT CASE WHEN claim.ordinality = 1 THEN v_accepted END,
             claim.task_id, claim.task_type, claim.priority, claim.payload, claim.contract_version,
             claim.result_max_bytes, claim.redact_error_details, claim.trace_context, claim.attempt,
             claim.max_attempts, claim.retry_policy, claim.deadline_at, claim.execution_timeout_ms,
             claim.attempt_timeout_at, claim.fence_token, claim.lease_expires_at
        FROM workhorse.fast_claim_v1(
          p_queue_name, p_worker_id, p_limit, p_lease_ms, v_control.record_claims
        ) WITH ORDINALITY AS claim
       ORDER BY claim.ordinality;
    v_first := NOT FOUND;
  END IF;
  IF v_first THEN
    accepted := v_accepted;
    RETURN NEXT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.claim_policy_batch_v1(
  p_queue_name text,
  p_worker_id text,
  p_limit integer,
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
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_claimed integer;
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
  v_direct boolean;
  v_index integer;
  v_shards integer;
  v_home integer;
  v_shard integer;
  v_held integer[] := '{}';
  v_rebalanced boolean := false;
  v_skipped boolean := false;
  v_short boolean := false;
  v_capped_out boolean := false;
  v_shard_room integer[];
  v_shard_tokens numeric[];
  v_conc_room integer;
  v_rate_room integer;
  v_all_room integer;
  v_all_tokens integer;
  v_want integer;
  v_gain_room integer;
  v_gain_tokens numeric;
  v_slots integer[];
  v_left integer;
  v_part integer;
  v_rest numeric;
  v_charge numeric;
  v_charged integer[];
  v_charges numeric[];
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
  END IF;
  -- Admission counts active leases after it takes its locks, and only a statement snapshot taken
  -- after those locks sees every committed lease. PostgreSQL runs read uncommitted as read committed.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      ERRCODE = '0A000',
      MESSAGE = format(
        'Workhorse claims require read committed isolation, not %s',
        current_setting('transaction_isolation')
      );
  END IF;
  -- Shared queue locks allow claims to overlap while holding every deployment synchronization of
  -- this queue's policies, and the rebalance it performs, back until this claim commits.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || p_queue_name, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:rate-limit-policy:' || p_queue_name, 0)
  );
  SELECT policy.* INTO v_policy
    FROM workhorse.concurrency_policy policy WHERE policy.queue_name = p_queue_name;
  SELECT policy.* INTO v_rate_policy
    FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = p_queue_name;
  v_shards := workhorse.admission_shard_count_v1(
    v_policy.max_active, v_policy.max_active_per_key, v_rate_policy.rate_burst,
    v_rate_policy.per_key_limit
  );
  v_home := CASE WHEN v_shards > 0 THEN pg_backend_pid() % v_shards END;
  -- A queue whose shard rows do not match its policies has not been rebalanced since a policy
  -- changed outside deployment synchronization. The rebalance leaves this claim holding every shard.
  -- A queue with no policy has no shards, and its stored rows are left alone.
  IF v_shards > 0 AND NOT EXISTS (
    SELECT 1 FROM workhorse.admission_shard stored
     WHERE stored.queue_name = p_queue_name
    HAVING count(*) = v_shards AND max(stored.shard) = v_shards - 1
  ) THEN
    PERFORM workhorse.rebalance_admission_shards_v1(p_queue_name, clock_timestamp());
    v_rebalanced := true;
    v_held := ARRAY(SELECT generate_series(0, v_shards - 1));
  END IF;

  LOOP
    -- Lock each budget the window can name, in name order, before reading the clock. Only a first
    -- round that holds no shard may wait; any other round takes only the locks it can get at once.
    -- A queue with no ready row that names a budget skips the sample.
    IF EXISTS (
      SELECT 1 FROM workhorse.task_runtime runtime
       WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
         AND runtime.budget_name IS NOT NULL
    ) THEN
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
        IF v_first_round AND p_wait_for_budgets AND NOT v_rebalanced THEN
          PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budget:' || v_budget_name, 0));
        ELSIF NOT pg_try_advisory_xact_lock(
          hashtextextended('workhorse:budget:' || v_budget_name, 0)
        ) THEN
          CONTINUE;
        END IF;
        v_budget_names := v_budget_names || v_budget_name;
      END LOOP;
    END IF;

    IF v_first_round AND NOT v_rebalanced AND v_shards > 0 THEN
      -- Take the first shard that is free, starting at home. When every shard is busy, wait for the
      -- home shard, or give up when this claim may not wait.
      FOR v_index IN 0..v_shards - 1 LOOP
        v_shard := (v_home + v_index) % v_shards;
        IF pg_try_advisory_xact_lock(
          hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_shard, 0)
        ) THEN
          v_held := ARRAY[v_shard];
          EXIT;
        END IF;
      END LOOP;
      IF cardinality(v_held) = 0 THEN
        IF NOT p_wait_for_budgets THEN
          v_skipped := true;
          v_short := true;
          v_capped_out := true;
          EXIT;
        END IF;
        PERFORM pg_advisory_xact_lock(
          hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_home, 0)
        );
        v_held := ARRAY[v_home];
      END IF;
    END IF;
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

    -- Read every shard's room and refilled tokens. A shard's room is its share of max_active less
    -- its unexpired active leases, and a null value means no rule limits it. The held room adds the
    -- overdraft of every shard this claim does not hold. When the held shards cannot cover what the
    -- whole queue could start, borrow the shards that have capacity and are free now, then read again.
    -- A queue with no shards has no queue-wide rule, so its room stays null.
    v_room := NULL;
    v_short := false;
    FOR v_index IN 1..2 LOOP
      EXIT WHEN v_shards = 0;
      WITH shard AS (
        SELECT slot.shard,
               CASE WHEN v_policy.queue_name IS NOT NULL THEN
                 workhorse.admission_share_v1(v_policy.max_active, v_shards, slot.shard)
                   - COALESCE(active.leases, 0)
               END AS room,
               CASE WHEN v_rate_policy.queue_name IS NOT NULL THEN LEAST(
                 workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)::numeric,
                 COALESCE(
                   stored.tokens + GREATEST(
                     0::numeric,
                     extract(epoch FROM v_now - stored.refilled_at) * 1000
                   ) * v_rate_policy.rate_limit::numeric
                     * workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)
                     / (v_rate_policy.rate_interval_ms::numeric * v_rate_policy.rate_burst),
                   workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)::numeric
                 )
               ) END AS tokens,
               slot.shard = ANY(v_held) AS held
          FROM generate_series(0, v_shards - 1) AS slot(shard)
          LEFT JOIN (
            SELECT COALESCE(active.admission_shard, 0) % v_shards AS shard,
                   count(*)::integer AS leases
              FROM workhorse.task_runtime active
             WHERE active.state = 'active' AND active.queue_name = p_queue_name
               AND active.expires_at > v_now
             GROUP BY 1
          ) active ON active.shard = slot.shard
          LEFT JOIN workhorse.admission_shard stored
            ON stored.queue_name = p_queue_name AND stored.shard = slot.shard
      )
      SELECT array_agg(shard.room ORDER BY shard.shard),
             array_agg(shard.tokens ORDER BY shard.shard),
             -- GREATEST and LEAST skip a null, so a queue with no concurrency policy tests for it.
             CASE WHEN v_policy.queue_name IS NOT NULL THEN LEAST(
               sum(GREATEST(shard.room, 0)) FILTER (WHERE shard.held),
               sum(shard.room) FILTER (WHERE shard.held)
                 + COALESCE(sum(LEAST(shard.room, 0)) FILTER (WHERE NOT shard.held), 0)
             ) END::integer,
             floor(sum(shard.tokens) FILTER (WHERE shard.held))::integer,
             sum(shard.room)::integer,
             floor(sum(shard.tokens))::integer
        INTO v_shard_room, v_shard_tokens, v_conc_room, v_rate_room, v_all_room, v_all_tokens
        FROM shard;
      v_room := LEAST(v_conc_room, v_rate_room);
      v_want := LEAST(p_limit - v_total, v_all_room, v_all_tokens);
      v_short := v_room < v_want;
      EXIT WHEN v_index = 2 OR NOT v_short OR cardinality(v_held) = v_shards;
      v_gain_room := 0;
      v_gain_tokens := 0;
      FOR v_offset IN 0..v_shards - 1 LOOP
        v_shard := (v_home + v_offset) % v_shards;
        CONTINUE WHEN v_shard = ANY(v_held)
          OR COALESCE(v_shard_room[v_shard + 1], 1) <= 0
          OR COALESCE(v_shard_tokens[v_shard + 1], 1) <= 0;
        IF pg_try_advisory_xact_lock(
          hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_shard, 0)
        ) THEN
          v_held := v_held || v_shard;
          v_gain_room := v_gain_room + COALESCE(v_shard_room[v_shard + 1], 0);
          v_gain_tokens := v_gain_tokens + COALESCE(v_shard_tokens[v_shard + 1], 0);
          EXIT WHEN (v_conc_room IS NULL OR v_conc_room + v_gain_room >= v_want)
            AND (v_rate_room IS NULL OR v_rate_room + v_gain_tokens >= v_want);
        ELSE
          v_skipped := true;
        END IF;
      END LOOP;
    END LOOP;

    v_take := p_limit - v_total;
    v_queue_capped := false;
    IF v_room <= v_take THEN v_take := v_room; v_queue_capped := true; END IF;
    IF v_take <= 0 THEN
      v_capped_out := true;
      EXIT;
    END IF;

    v_direct := v_policy.max_active_per_key IS NULL AND v_rate_policy.per_key_limit IS NULL
      AND cardinality(v_budget_names) = 0;
    IF v_direct THEN
      -- No per-key rule and no budget lock, so no rule passes over a row, and the first ready rows
      -- this claim can lock are the rows it takes. As in claim_one_v1, a row that names a budget
      -- holds the line, and the rows after it stay ready.
      SELECT array_agg(line.task_id ORDER BY line.priority DESC, line.sequence, line.task_id)
        INTO v_picked
        FROM (
          SELECT locked.task_id, locked.priority, locked.sequence,
                 bool_or(locked.budget_name IS NOT NULL) OVER (
                   ORDER BY locked.priority DESC, locked.sequence, locked.task_id
                 ) AS reached_budget
            FROM (
              SELECT runtime.task_id, runtime.budget_name, runtime.priority, runtime.sequence
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
               FOR NO KEY UPDATE OF runtime SKIP LOCKED
               LIMIT v_take
            ) locked
        ) line
       WHERE NOT line.reached_budget;
    ELSE
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
    END IF;
    v_claimed := COALESCE(cardinality(v_picked), 0);
    EXIT WHEN v_claimed = 0;

    -- Spread the picked rows over the held shards' room. A queue with no concurrency policy puts
    -- them all on the first held shard, because only the rate bucket limits it.
    v_slots := '{}';
    v_left := v_claimed;
    FOREACH v_shard IN ARRAY v_held LOOP
      EXIT WHEN v_left = 0;
      v_part := CASE WHEN v_policy.queue_name IS NULL THEN v_left
        ELSE LEAST(v_left, GREATEST(v_shard_room[v_shard + 1], 0)) END;
      CONTINUE WHEN v_part = 0;
      v_slots := v_slots || array_fill(v_shard, ARRAY[v_part]);
      v_left := v_left - v_part;
    END LOOP;

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
             error = NULL, updated_at = v_now,
             admission_shard = v_slots[array_position(v_picked, runtime.task_id)]
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

    -- Charge each bucket once for the starts this round admitted. The queue charge falls on the
    -- held shards in order, and each shard gives at most the tokens it holds. A missing bucket
    -- starts full, as in rate_limit_bucket_v1 and budget_bucket_v1, and refill never runs from a
    -- clock ahead of this claim.
    IF v_claimed > 0 AND v_rate_policy.queue_name IS NOT NULL THEN
      v_rest := v_claimed;
      v_charged := '{}';
      v_charges := '{}';
      FOREACH v_shard IN ARRAY v_held LOOP
        EXIT WHEN v_rest <= 0;
        v_charge := LEAST(v_shard_tokens[v_shard + 1], v_rest);
        CONTINUE WHEN v_charge <= 0;
        v_charged := v_charged || v_shard;
        v_charges := v_charges || (v_shard_tokens[v_shard + 1] - v_charge);
        v_rest := v_rest - v_charge;
      END LOOP;
      INSERT INTO workhorse.admission_shard AS shard_row(queue_name, shard, tokens, refilled_at)
      SELECT p_queue_name, charged.shard, charged.tokens, v_now
        FROM unnest(v_charged, v_charges) AS charged(shard, tokens)
      ON CONFLICT (queue_name, shard) DO UPDATE
         SET tokens = EXCLUDED.tokens,
             refilled_at = GREATEST(v_now, shard_row.refilled_at);
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
    v_capped_out := v_queue_capped AND v_claimed >= v_take;
    -- A round stops the batch when it fills the limit or the held room. A direct round always stops
    -- it, because a short one found no further row it could take. A window round also stops the
    -- batch when its window held every ready row, no row had both a limited key and a limited
    -- budget, and it activated every row that fit.
    EXIT WHEN v_direct OR v_total >= p_limit OR v_capped_out
      OR (v_window < 100 AND NOT v_mixed AND v_claimed >= v_fit);
  END LOOP;
  -- Capacity this claim could not reach sat in a shard another claim held. Wake a worker for it,
  -- so a queue never waits with room for longer than one claim round.
  IF v_skipped AND v_short AND v_capped_out THEN
    PERFORM pg_notify('workhorse_tasks', p_queue_name);
  END IF;
END;
$$;

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
  v_budget_name text;
  v_budget_names text[] := '{}';
  v_task_id uuid;
  v_candidate_budget text;
  v_fence bigint;
  v_now timestamptz;
  v_expires timestamptz;
  v_control workhorse.queue_control%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  -- Admission counts active leases after it takes its locks, and only a statement snapshot taken
  -- after those locks sees every committed lease. PostgreSQL runs read uncommitted as read committed.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      ERRCODE = '0A000',
      MESSAGE = format(
        'Workhorse claims require read committed isolation, not %s',
        current_setting('transaction_isolation')
      );
  END IF;
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF FOUND AND v_control.tier = 'fast' THEN
    IF NOT v_control.paused THEN
      RETURN QUERY SELECT * FROM workhorse.fast_claim_v1(
        p_queue_name, p_worker_id, 1, p_lease_ms, v_control.record_claims
      );
    END IF;
    RETURN;
  END IF;
  -- Shared queue locks allow unrelated claims to overlap while serializing first policy creation
  -- and pruning against deployment synchronization for this queue. A queue with a policy admits
  -- through its admission shards.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || p_queue_name, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:rate-limit-policy:' || p_queue_name, 0)
  );
  IF EXISTS (
    SELECT 1 FROM workhorse.concurrency_policy policy WHERE policy.queue_name = p_queue_name
  ) OR EXISTS (
    SELECT 1 FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = p_queue_name
  ) THEN
    RETURN QUERY SELECT * FROM workhorse.claim_policy_batch_v1(
      p_queue_name, p_worker_id, 1, p_lease_ms, p_wait_for_budgets
    );
    RETURN;
  END IF;
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
  v_fence := nextval('workhorse.fence_token_seq');
  IF cardinality(v_budget_names) = 0 THEN
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
     FOR NO KEY UPDATE OF runtime SKIP LOCKED
     LIMIT 1;
    IF v_candidate_budget IS NOT NULL THEN RETURN; END IF;
  ELSE
    -- A budget can pass over a row, so the window reads without locking and only the chosen
    -- candidate is locked. A claim that admits nothing leaves every sampled row unlocked.
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
       WHERE CASE
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
     FOR NO KEY UPDATE OF runtime SKIP LOCKED
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
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_control workhorse.queue_control%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
  END IF;
  -- Admission counts active leases after it takes its locks, and only a statement snapshot taken
  -- after those locks sees every committed lease. PostgreSQL runs read uncommitted as read committed.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      ERRCODE = '0A000',
      MESSAGE = format(
        'Workhorse claims require read committed isolation, not %s',
        current_setting('transaction_isolation')
      );
  END IF;
  -- A fast-tier queue has no admission policy to apply row by row, so it claims the whole batch in
  -- one statement.
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF FOUND AND v_control.tier = 'fast' THEN
    IF p_worker_id IS NULL OR p_worker_id = '' THEN
      RAISE EXCEPTION 'worker_id must not be empty';
    END IF;
    IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
      RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
    END IF;
    IF NOT v_control.paused THEN
      RETURN QUERY SELECT * FROM workhorse.fast_claim_v1(
        p_queue_name, p_worker_id, p_limit, p_lease_ms, v_control.record_claims
      );
    END IF;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM workhorse.claim_policy_batch_v1(
    p_queue_name, p_worker_id, p_limit, p_lease_ms, true
  );
END;
$$;
