# ADR 0082: Shard the admission counters of a governed queue

- **Status:** Accepted
- **Date:** 2026-09-28
- **Related:** [ADR 0067](0067-add-named-budgets-that-span-queues.md),
  [ADR 0076](0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md),
  [SM-932](https://linear.app/stablemates/issue/SM-932)

## Context

A concurrency policy caps a queue's active tasks with `max_active`. A rate-limit policy caps its
starts with one token bucket. Each cap is one number that every claim must respect.

Before schema version 43, a claim locked the queue's `concurrency_policy` row and its
`rate_limit_policy` row `FOR UPDATE`, and it held them until it committed. The row locks kept the
count exact, because no other claim could change it while the claim read it. They also made claims
of one governed queue run one at a time. A worker fleet could add workers, but a governed queue
could not use them.

On the benchmark host at concurrency 4, a policy queue reached 0.57 times the throughput of an
unlimited queue, and a rate queue 0.67 times. At concurrency 16 the ratios were 0.34 to 0.60 and
0.56 to 0.74 across four sessions.

The release trigger `notify_concurrency_capacity_v1` also locked the policy row `FOR KEY SHARE`.
That lock ordered a release after any open claim, so the release saw the claim's leases.

Three remedies were considered:

1. **Shorten the time a claim holds the policy row.** The claim already did little else while it
   held the lock. The claims would still run one at a time.
2. **Shard only the concurrency counter.** A rate queue would still serialize on its bucket row,
   and a queue with both policies would gain nothing.
3. **Shard both counters.** Each cap becomes a set of shares, and claims that hold different shares
   admit at the same time. The shares must still add up to the cap exactly.

## Decision

**Split `max_active` and the rate bucket of a queue without a per-key rule into at most 8 admission
shards, and let a claim hold only the shards it spends.**

1. `admission_shard_count_v1` gives the shard count. A queue with no queue-wide rule has none. A
   queue with `max_active_per_key` or `per_key_limit` has one, because keyed admission must see the
   whole queue. Any other queue has `LEAST(8, max_active, rate_burst)`, so every share is at least 1.
2. `admission_share_v1` gives each shard its share. The lower shards take the remainder, so the
   shares add up to the cap.
3. The new table `admission_shard` holds each shard's tokens and refill time. A new
   `task_runtime.admission_shard` column records the shard an active lease counts against.
4. A claim reads the policy rows without locking them. It takes the advisory lock of the first free
   shard, starting at a home shard chosen from its backend process ID. When every shard is held, it
   waits for its home shard.
5. A claim that needs more than its shards hold borrows other shards. It tries each lock without
   waiting and never counts a shard another claim holds, so it never spends room another claim may
   be spending. A claim that holds a shard waits for no other shard, so claims cannot deadlock.
6. A claim that stopped short while a shard it could not lock had room publishes the queue on
   `workhorse_tasks`. Another worker then claims that room once the holder commits, so a queue never
   waits with room for longer than one claim round.
7. The release trigger tries a shared lock on the released row's shard and never waits. When it
   cannot take the lock at once, it publishes the queue. With the lock, it publishes when the shard,
   the queue, or the key is full. A full shard counts even when the queue has room, because an
   uncommitted claim may have filled the other shards.
8. `sync_concurrency_policies_v1` and `sync_rate_limit_policies_v1` rebuild the shards of every
   affected queue with `rebalance_admission_shards_v1`. The rebuild waits for every shard lock and
   carries the refilled tokens over, capped at the burst, so it never creates capacity.
9. Migration 0044 steps the schema from version 42 to 43. The schema floor rises to 43, because a
   worker at an older schema would not record `admission_shard`.
10. Queue-scope `rate_limit_bucket` rows written before version 43 stay in place and are inert. The
    table keeps holding per-key buckets.

## Consequences

- On the benchmark host at concurrency 4, with three kept repetitions each, a policy queue reached
  0.94 times the unlimited queue and a rate queue 0.89 times. Before the change the ratios were 0.57
  and 0.67. The reference queue's throughput was within 7% between the two sessions.
- At concurrency 16, the reference queue stayed below the host's validity floor in every session,
  so no concurrency-16 result is valid. The invalid sessions gave a policy queue 0.83 to 0.87 times
  the unlimited queue and a rate queue 0.89 to 0.94 times, against 0.34 to 0.60 and 0.56 to 0.74
  before.
- Node CPU per task did not change within the noise of the host.
- The cap stays exact. A new test holds some shards in one transaction and claims the rest from
  another, for both a concurrency cap and a rate cap, and the claims admit exactly the cap.
- Fence issuance and lease durability are unchanged. The claim allocates fences from
  `fence_token_seq` in the same order and writes the same claim event.
- A release from a full shard publishes the queue even when other shards have room, and a release
  that meets an open claim on its shard publishes without counting. Both wake a worker that may find
  nothing. The worker's empty claim costs one round.
- A claim that finds every shard busy and may not wait publishes the queue and returns nothing. Under
  heavy contention workers can wake each other briefly before one takes the room.
- An empty poll can borrow every free shard, because it cannot know how much work is ready. It holds
  them only for that claim.
- A lease written before version 43 has a null shard and counts against shard 0 until it ends.
- A policy row changed with direct SQL, outside synchronization, is not serialized with claims. The
  next claim finds shard rows that do not match and rebuilds them. A policy row deleted with direct
  SQL leaves inert shard rows until the next rebuild.
- Every synchronization rebuilds each affected queue and waits for its open claims. A sync can still
  meet `40P01` from a caller's transaction that claims from several queues, and every SDK sends it
  again as before.
