# ADR 0077: Add a fast task tier that records one outcome row per task

- **Status:** Accepted
- **Date:** 2026-09-24
- **Amends:** [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
  [ADR 0057](0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md) for one
  release
- **Related:** [ADR 0073](0073-prune-the-migration-chain-to-the-0-2-0-baseline.md),
  [ADR 0076](0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md),
  [SM-909](https://linear.app/stablemates/issue/SM-909),
  [SM-917](https://linear.app/stablemates/issue/SM-917),
  [SM-918](https://linear.app/stablemates/issue/SM-918),
  [SM-919](https://linear.app/stablemates/issue/SM-919)

## Context

Every task pays for durable execution, even when it never uses it. A task that succeeds on its
first attempt writes six rows: `task`, `task_runtime`, `task_outcome`, an `enqueued` event, a
`claimed` event and an `attempt_history` row. `task_runtime` alone carries thirteen indexes. The
competitor baseline in the SM-907 harness writes two rows per job.

SM-909's perf-lab rounds 7 to 9 found that write volume, not dispatch, holds most of the remaining
throughput gap. Worker cohorts (SM-919) alone did not close it. Cohorts combined with a separate
storage tier reached 1.09–1.17× the baseline at concurrency 16, and about 1.0× at concurrency 4. A
crash test on that build lost no task and wrote no duplicate outcome. Re-runs stayed within the
worker's concurrency.

The research build reached that result with two unrelated mechanisms, and only one of them was
measured. Neither mechanism is on `main`. The research build is archived outside this repository.

1. **The implicit `policy_free` path**, in the research build's `sql/schema/current.sql`. A queue
   without a concurrency or rate-limit policy at claim time is claimed set-based through
   `queue_policy_state`. A success on it writes an outcome-only history. A fused
   `complete_and_claim_v1` and a lazy lease sit behind flags (`WORKHORSE_LAZY_LEASE`,
   `lazy_complete_v1`, `promoteLease`, `promoteAfterMs`). A task on this path can still
   checkpoint and wait, because nothing at enqueue knows the task is "fast". SM-917 therefore had
   to add the `task_runtime_policy_free_suspension` trigger. That trigger writes a deferred
   `claimed` event when such a claim suspends. SM-917 also added a `complete_v1` guard, which takes
   outcome-only history only when `attempt_started_at = acquired_at`. Two gaps remain. A resumed
   lazy attempt records `started_at = p_claimed_at`, and a policy sync that flips an active row to
   `policy_free = false` leaves that attempt without a `claimed` event.
2. **The explicit tier**, in the research build's SQL overlays. A live row in `workhorse.job`
   carries state, fence and lease together. A finished task leaves one wide row in
   `workhorse.job_outcome`. Every SM-909 throughput and crash result came from this build.

The maintainer chose two tiers in SM-909. The **fast tier** keeps minimal history. The **full
tier** is today's tier: full history and durable execution. This ADR fixes the fast tier's storage,
its limits and the cutover to it. It also settles which of the two research mechanisms reaches
`main`.

## Decision

**A queue is either fast-tier or full-tier. A fast-tier task lives in one runtime row and leaves one
outcome row, and it cannot use durable execution. Only the explicit tier is ported from the
research build; the implicit `policy_free` path is not. The change ships as one offline cutover,
and every SDK moves to the new protocol version in the same release train.**

### 1. The tier belongs to the queue

1. `workhorse.queue_control` gains a `tier` column, `'fast'` or `'full'`. A queue without a row is
   full-tier, so a queue nobody configured keeps today's behavior.
2. An operator changes a queue's tier only while the queue has no live task. Workhorse rejects the
   change otherwise. A task therefore never moves between tiers.
3. The tier is a queue property rather than a per-task option for three reasons:
   - The claim is per queue. One tier per queue lets the claim read one table in one priority
     order.
   - Concurrency and rate-limit policies are per queue, and the fast tier excludes them.
   - The opt-in history settings below are per queue too.
4. The claim already reads `queue_control` to check `paused`. It reads the tier from the same row,
   so choosing the claim path costs no extra lookup.

### 2. The fast tier rejects durable execution at enqueue

1. Enqueue into a fast-tier queue rejects a request that uses any of these features:
   - a checkpoint
   - a durable wait: a timer, signal or human wait
   - a signal
   - a dependency, a prerequisite task or a child task
   - a policy: a concurrency key, a budget, debounce or throttle
2. Workhorse rejects the whole batch with one error. The error names the feature and the queue. No
   request silently falls back to the full tier. The research build's `fast_plain_request_v1` did
   fall back, and this ADR rejects that behavior.
3. A handler on a fast-tier task that calls a checkpoint, wait or signal API gets an error from its
   SDK before any round trip. The attempt fails with that error, and it follows the task's retry
   policy.
4. Workhorse also rejects adding a concurrency policy or rate-limit policy to a fast-tier queue.
5. The fast tier keeps every feature that needs no suspension:
   - priority, scheduled `runAt`, deadlines and execution timeouts
   - retry policies and `maxAttempts`
   - tags and trace context
   - payload and result size limits, and sensitive-key redaction
   - idempotency keys, which enqueue settles before any runtime row exists
   - cancellation and queue pause

### 3. The fast tier's rows

The research tables are renamed to fit the glossary: `job` becomes `fast_task_runtime`, and
`job_outcome` becomes `fast_task_outcome`. "Job" is not a Workhorse term.

1. **`workhorse.task`** stays for both tiers. It holds the task's identity and its options.
   Workhorse writes it once, set-based, in one statement per enqueue batch, as the research
   build's `fast_enqueue_v1` did.
2. **`workhorse.fast_task_runtime`** holds one row per live fast-tier task. Workhorse deletes the
   row when the task finishes.
   - It carries a state (ready or active), the queue, type, priority, `run_at` and ready sequence.
   - It also carries the attempt counter, fence token, worker, `claimed_at`, lease expiry, attempt
     timeout and deadline.
   - Its `errors` array records the closed attempts so far (rule 4).
   - It copies what the claim returns from `task`, so the claim reads one table.
   - It carries two partial indexes for recovery. An active row's index key is the earliest of its
     lease expiry, attempt timeout and deadline (research lever 2). A ready row with a deadline has
     a deadline index.
3. **`workhorse.fast_task_outcome`** holds one row per finished fast-tier task, keyed by `task_id`.
   - `attempt`, `state` (succeeded, failed or canceled), `result` and `finished_at`
   - `queue_name` and `task_type`, for routing and statistics
   - the final claim's `fence_token`, `worker_id` and `claimed_at`. A check keeps all three null or
     all three set. They are null when the task closed without ever being claimed.
   - `enqueued_at`
   - `errors` and `errors_dropped` (rule 4)
   - `closed_as`, which names a cold close: `canceled`, `deadline_exceeded`, `timeout` or
     `lease_expired`. It is null for a handler's own success or failure.
   - a BRIN index on `finished_at`, and a btree index on `(finished_at, task_id)` for export and
     pruning keysets
4. **The error cap.** Each `errors` entry records one closed non-final attempt:
   - `attempt`, `fence_token`, `worker_id`, `claimed_at` and `finished_at`
   - `outcome`: `retry`, `timeout` or `lease_expired`
   - the redacted `error`

   Workhorse keeps the **last 10** entries and drops the oldest first. The number of dropped entries
   is kept in `errors_dropped`, so readers can say that history is incomplete. The cap bounds the
   row size: `maxAttempts` allows up to 100 attempts, and every entry carries an error document.
   `architecture.md` owns the exact value from here on.

5. A success on the first attempt writes three rows: `task`, then `fast_task_runtime`, then
   `fast_task_outcome`. Completion is one fenced `DELETE` combined with the outcome `INSERT` in one
   statement. Enqueue writes no `task_runtime` row and no `enqueued` event. The dashboard derives the
   enqueue from `enqueued_at`.
6. The fast tier's readers follow the research build's readers. The dashboard's attempt-history and
   event views each gain a branch built from `fast_task_runtime`, `fast_task_outcome` and their
   `errors` entries. A synthesized record gets the same md5-derived id whether it is read from the
   live row or the outcome row. Cold export and retention read `fast_task_outcome` alongside
   `task_outcome`.

### 4. Opt-in history

1. **Attempt history.** `queue_control.record_attempts` defaults to false. When it is true, every
   closed attempt of a fast-tier task writes one `attempt_history` row, the same row a full-tier
   attempt writes. It adds no `errors` entry, because each attempt has exactly one source. The cap
   does not apply, because the operator chose to pay for full history.
2. **The claimed event.** `queue_control.record_claims` defaults to false. When it is true, the
   fast-tier claim also writes one `claimed` task event per claimed task.
   - The research build used a session setting, `workhorse.claim_events`. That made a task's
     history depend on which worker claimed it. A queue setting makes it a property of the data.
   - The claim branches once per call (research lever 1). With the event off, the claim runs no
     writable CTE and touches no `task_event` index.
3. Both settings take effect for claims and completions that start after the change. They do not
   rewrite history already written.

### 5. The research build's implicit path is not ported

`main` never had the implicit path, and this ADR does not bring it over. The rejected alternative
[Keep the implicit `policy_free` path and harden it](#keep-the-implicit-policy_free-path-and-harden-it)
keeps its reasoning.

1. The full tier keeps `main`'s behavior. Every full-tier claim writes the `claimed` event, and every
   attempt writes one `attempt_history` row. `complete_v1` keeps its single history path.
2. These research-build parts stay out of `main`:
   - the `policy_free` column, the `queue_policy_state` table and its capacity trigger
   - the set-based policy-free claim branch
   - outcome-only history in `complete_v1`
   - the lazy durable lease: `WORKHORSE_LAZY_LEASE`, `lazy_complete_v1`, `ephemeral-lease.ts`,
     `promoteLease` and `promoteAfterMs`
   - the full-tier `complete_and_claim_v1`
   - SM-917's `task_runtime_policy_free_suspension` trigger and its
     `attempt_started_at = acquired_at` guard in `complete_v1`
3. The guard and the trigger protected claims that skipped their `claimed` event. No full-tier claim
   on `main` skips it, so neither has anything to protect. The two edge cases they left open cannot
   arise either.
4. A fast-tier claim writes its lease into the row it already updates, so a deferred lease saves
   nothing there.
5. The fast tier keeps its batched `complete_many_and_claim` as its completion path.
   `CompletionClaim` joins the public surface for that path only. The full tier keeps ADR 0076's
   overlapping claims. The SM-909 evidence measured fused completion only on the fast tier. A
   full-tier fused call can come later, with its own measurement.
6. Three research changes are independent of the tier, and they are ported:
   - set-based enqueue
   - `workhorse.uuid_v7_v1()` stays a portable top-level function. On PostgreSQL 18, a `DO` block
     replaces its body with the native `uuidv7()`.
   - SM-917's worker slot handover and refill-batch rule, on top of ADR 0076's refill batching

### 6. One offline cutover

ADR 0073's premise still holds: the Workhorse demo is the only installed instance. That makes one
offline cutover acceptable where ADR 0053 and ADR 0057 would otherwise demand a rolling one.

1. The cutover is one migration. It adds the fast tier and protocol version 5. In the same
   migration it narrows `workhorse.protocol_version` from 1–4 to exactly 5. There is no retained
   shim.
2. Narrowing retires two supersessions. Protocol 2 added `fire_due_schedules_v2` and
   `sync_schedule_definitions_v2`, so the cutover drops `fire_due_schedules_v1` and
   `sync_schedule_definitions_v1`. Protocols 3 and 4 were additive, so they retire nothing else.
   A function whose arguments or result shape protocol 5 changes gets a `_v2`, and the migration
   drops its `_v1`. A function whose contract is unchanged gains its fast-tier branch in place.
3. Because it drops functions and narrows `workhorse.protocol_version`, the migration is a contract
   step in ADR 0057's sense. It declares `kind: "contract"` and retires protocols 1 to 4.
   `workhorse schema migrate` stops before it, and `workhorse schema contract --yes` applies it. ADR
   0057 is amended in timing only: this contract step ships in a minor release, without the
   retention window.
4. `MINIMUM_PROTOCOL_VERSION` and `PROTOCOL_VERSION` both become 5. A client built for protocol 4
   fails its compatibility check at startup, rather than calling a function that no longer exists.
5. The TypeScript, Python, Go and Rust SDKs move to protocol 5 in one release train. So does
   Ruby, if the [SM-897](https://linear.app/stablemates/issue/SM-897) SDK ships first. No SDK
   release in that train speaks protocol 4.
6. The operator stops every worker and producer. Then they run `workhorse schema migrate` and
   `workhorse schema contract --yes`, and start the new release. Live full-tier tasks stay where
   they are, because every queue starts full-tier. No history needs a backfill, because `main`
   never wrote outcome-only history.
7. `typescript/demo/DEPLOYMENT.md` records the stop-contract-start order for this release, in the
   same commit as the migration.
8. From the release after the cutover, ADR 0053 and ADR 0057 apply unchanged.

### 7. Scope of SM-918 after this ADR

This ADR is the design. The implementation belongs to SM-918.

1. SM-918 owns the migration, the regenerated `sql/schema/current.sql` and the protocol manifest.
2. SM-918 owns the updated API snapshots for the fast-tier surface in every SDK.
3. SM-918 owns `architecture.md`, the guides and the site pages that describe the fast tier.
4. SM-918 owns a crash test and an SM-907 harness run with an in-invocation control. Both run
   against the migrated schema, not the research build.

## Consequences

### Positive

- A plain task writes three rows and touches two narrow tables. That is the storage the SM-909
  measurements rest on.
- The tier is visible in configuration and enforced at enqueue. A task cannot drift between history
  shapes at claim time, so `main` needs neither SM-917's trigger nor its guard.
- The full tier stays as simple as it is on `main`: one claim path, one history path and one lease
  path.
- A fast-tier outcome row has a bounded size, and it still names every attempt's worker, fence and
  error up to the cap.
- Operators who need a task's full history keep it by turning on `record_attempts` for that queue.
  Moving the queue to the full tier is not required.

### Negative

- Two tiers mean two sets of runtime functions, two readers per history view and two retention
  paths. Every future runtime change has to answer for both.
- A fast-tier task that later needs a checkpoint or a wait cannot get one. Its queue has to be
  drained and switched, or its producer has to enqueue into a full-tier queue.
- By default, the fast tier keeps no `claimed` event and no history beyond the last 10 attempts. An
  investigation of an older failure on a busy retry loop finds `errors_dropped`, not the errors.
- The cutover is offline and breaks every protocol-4 client at once. That is acceptable only because
  no installation other than the demo exists. The next change of this size needs a rolling plan.
- The fused completion-and-claim call exists on one tier only. Full-tier workers keep the extra
  round trip until a measurement justifies a full-tier version.

## Rejected alternatives

### Keep the implicit `policy_free` path and harden it

The research build tried this, and SM-917 showed what it costs. Nothing at enqueue knows the task
is "fast", so it can still checkpoint and wait. Each feature that can suspend a "fast" claim then
needs a trigger or guard that restores the full-tier history after the fact. SM-917 added two: the
`task_runtime_policy_free_suspension` trigger and the `attempt_started_at = acquired_at` guard in
`complete_v1`. Two gaps stayed open. A resumed lazy attempt records `started_at = p_claimed_at`. A
policy sync that flips an active row to `policy_free = false` leaves that attempt without a
`claimed` event.

The lazy lease behind the same path is what let a suspended attempt lose its claim record. The path
also needs a full-tier `complete_and_claim_v1` that the SM-909 runs never measured on the full
tier. And the implicit path was never the measured design: every SM-909 result came from the
explicit tier. Porting it would add all of that to `main` only to guard it afterwards.

### Choose the tier per task at enqueue

A queue could mix tiers, with a `tier` option on each request. The claim would then have to merge two
tables in one priority order, or starve one of them. Per-queue policies would have to check the tier
of every task. The research build already showed the cost: a queue could hold fast rows and blocked
full-tier rows at once.

### Fall back to the full tier when a request uses a full-tier feature

The research enqueue did this, which kept stock clients working unchanged. It also made a queue's
cost and history shape depend on its payloads. A task that asked for a checkpoint would get one only
because it quietly paid for the full tier. The issue asks for a clear error instead.

### Keep an uncapped errors array

Research round 7 did not cap it. A task with 100 attempts and large error documents then grows its
outcome row, and every retry rewrites the live row with the whole array. A cap with a drop count
keeps the row bounded and still reports the loss. `record_attempts` covers anyone who needs every
attempt.

### Keep the session setting for the claimed event

A per-session `workhorse.claim_events` makes history depend on worker configuration. Two workers on
one queue could then leave different histories for identical tasks. A queue setting keeps the choice
with the data.

### Ship the tier as a rolling, additive release

ADR 0057 would keep serving protocols 1 to 4 for twelve months, and retain every function they
call. That would protect installations that do not exist. It would also keep two protocol ranges
in every compatibility fixture and SDK bound for a year, for a cutover whose only installation is
the demo.
