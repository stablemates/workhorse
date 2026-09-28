# ADR 0081: Release a fused claim's row locks before its wait can deadlock

- **Status:** Accepted
- **Date:** 2026-09-28
- **Related:** [ADR 0076](0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md),
  [ADR 0077](0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md),
  [SM-934](https://linear.app/stablemates/issue/SM-934)

## Context

`complete_many_and_claim_v1` completes a worker's fast-tier tasks and claims their successors in
one statement. Its claim, `fast_claim_v1`, selects candidates with `FOR UPDATE SKIP LOCKED`.

`SKIP LOCKED` skips a row that another transaction holds. It does not skip every wait. Suppose
another worker leases a candidate and commits between the claim's snapshot and its lock. The claim
then follows the row's update chain to the leased version, and that walk waits without a wait
policy. The recheck of `state = 'ready'` rejects the row, but the claim keeps its lock until its
transaction ends.

The owning worker's next statement names that row. Its `fast_complete_many_v1` pre-lock or its
`fast_heartbeat_many_v1` round waits on the claim. When the claim waits on that worker in turn,
PostgreSQL detects the cycle after `deadlock_timeout` and rolls one statement back with SQLSTATE
`40P01`. Every SDK resends a fenced write that was a deadlock victim, so the cycle cost a second
round trip rather than a failure.

A local reproduction ran 8 Rust workers at concurrency 16 on one fast-tier queue, with the heartbeat
at 100 ms and the resend disabled. Six 30-second runs on PostgreSQL 18 recorded 9 deadlocks in
`pg_stat_database.deadlocks`, between 0 and 3 per run.

Three remedies were considered:

1. **Lock only rows that are still ready.** The claim cannot tell, before it locks, that a
   candidate's latest version is leased. `SKIP LOCKED` does not skip the update-chain wait.
2. **Claim in a separate statement.** The completion and the claim would each hold locks briefly,
   but every refill would cost a second round trip. That undoes ADR 0076's fused refill.
3. **Bound the claim's lock wait and give its locks back.** The claim gives up before the deadlock
   detector runs, and nothing else in the statement changes.

## Decision

**`fast_claim_v1` bounds its lock waits at 50 ms and releases every row lock it took when a wait
times out.**

1. The function carries `SET lock_timeout = '50ms'`. PostgreSQL restores the caller's setting when
   the function returns, so the bound covers only the claim.
2. The claim runs inside a PL/pgSQL `BEGIN ... EXCEPTION WHEN lock_not_available` block. A timed-out
   wait rolls back that block's subtransaction, which releases the claim's row locks. The claim then
   returns no rows.
3. The completion in `complete_many_and_claim_v1` runs before the block and still commits. The
   worker's next poll or completion claims again.
4. The claim collects its rows into an array before it returns any. A set-returning function cannot
   withdraw a row it has already returned.
5. Migration 0040 replaces `fast_claim_v1` in place at schema 39. A claim may already return fewer
   rows than its limit, so the signature and the contract are unchanged.
6. The SDK resend of a `40P01` fenced write stays. It still covers a server whose
   `deadlock_timeout` is below 50 ms, a cycle through the completion half of the statement, and the
   settlement cascades that every fenced write shares.

## Consequences

- The same reproduction with the fix recorded no deadlock in six runs. The runs alternated control
  and fix in one session, and swapped only `fast_claim_v1` between runs.
- The fix costs no throughput the reproduction could measure. The fixed runs completed a mean of
  140,922 tasks and the control runs 128,982. Pair to pair the difference ranged from 7% lower to
  26% higher, within the noise of a shared host.
- A claim that times out returns nothing for one round. Under contention a worker may therefore
  refill a slot one poll later than before.
- The claim opens one subtransaction per call. A claim that leases a task assigns that
  subtransaction its own transaction ID, beside the one its statement already holds.
- A deployment that sets `deadlock_timeout` below 50 ms can still see the cycle resolved as a
  deadlock. The SDK resend then handles it as before.
