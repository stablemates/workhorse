# ADR 0006: Named durable timer waits

## Status

Accepted for the schema version 7 validation protocol.

## Context

A handler sometimes needs to pause for minutes, hours, or days without retaining a worker slot, an active lease, or an in-memory JavaScript stack. A process-local timer is not durable: process loss forgets it, and a long timer forces the worker to heartbeat an otherwise idle job.

Workhorse retries restart handlers from their entry point. A durable wait therefore cannot resume an arbitrary JavaScript stack frame. It must be an explicit, stable restart boundary whose replay is deterministic enough for clients in every supported language.

Timer suspension is not failure. It must not consume retry budget or create a new failure attempt. The transition must obey the same worker/fence/lease rules as checkpoints, completion, failure, and recovery. A stale worker must not schedule or alter a wait owned by a newer generation.

## Decision

Expose `context.sleep(name, durationMs)` as a named durable timer boundary.

The first call for a name atomically:

1. locks and revalidates the exact active, unexpired runtime generation;
2. inserts an immutable `workhorse.job_wait` row whose `wake_at` is calculated from PostgreSQL's clock;
3. moves `job_runtime` from `active` to `scheduled` at that `wake_at`;
4. clears active ownership and records a `wait_scheduled` lifecycle event.

The worker then exits the handler through an internal suspension signal and does not call failure or completion. No database transaction or row lock spans user code.

When normal bounded promotion makes the runtime ready again, it carries the locked row's `wait_name` through the `due` CTE, clears the runtime marker, and emits `wait_elapsed` with `reason = 'due'`. The immutable wait row is not updated. The next claim restarts the handler from its entry point. Reaching the same name after its stored target has elapsed returns immediately and emits `wait_replayed`. For relative `sleep`, the first committed duration fixes the PostgreSQL-computed `wake_at`; later duration arguments are ignored so configuration drift cannot poison replay. For absolute `sleepUntil`, reusing a name with a different timestamp is a conflict. Applications that need a repeated timer must use a new stable name for each logical occurrence.

Store waits separately from checkpoints as immutable rows keyed by `(job_id, wait_name)`, with mode, requested duration or absolute target, PostgreSQL-computed `wake_at`, and the attempt, fence, and worker provenance that authorized the first call. At most 1,000 distinct waits may exist for one job. Outstanding timers are read from `job_runtime` rows whose state is scheduled and whose `wait_name` is non-null, keeping promotion on the single live relation. Wait rows follow the parent job identity's retention lifecycle.

`job_runtime.wait_name` identifies a scheduled runtime created by a durable wait. `job_runtime.attempt_started_at` preserves the start of the logical attempt across one or more timer suspensions. The runtime constraint requires `wait_name` to be null outside scheduled state and limits it to 1..200 characters. Scheduled rows either have both wait metadata fields or neither; active rows require `attempt_started_at`; ready continuation rows may preserve it. Retry and lease recovery increment `current_attempt` and clear it. Claim sets it only when a new attempt begins. Timer suspension and promotion preserve it.

`attempt_history.started_at` records the logical attempt start, while a new `claimed_at` column records the final activation's acquisition time. Completion, retry, terminal failure, and lease-expiry history populate both. Timer suspension does not append attempt history, so every attempt still has one closing row.

A timer suspension preserves `current_attempt`. It does not append `attempt_history`, because the logical attempt remains open. Its later success or failure closes exactly one attempt-history row. Multiple claims may therefore occur inside one attempt, distinguished by fence token and lifecycle events.

The versioned SQL function is `workhorse.schedule_wait_v1(p_job_id uuid, p_worker_id text, p_fence_token bigint, p_wait_name text, p_duration_ms bigint, p_wake_at timestamptz)`. Exactly one of duration or absolute wake target is supplied. It returns the status plus the stored wait record. Status is `scheduled`, `elapsed`, `conflict`, `limit_exceeded`, or `stale`. Relative durations are whole milliseconds from 1 through 31,536,000,000 (365 days) and use PostgreSQL's clock. TypeScript accepts a safe integer `number` and sends it as bigint text. Absolute timestamps must be finite and no more than 365 days in the future when first stored. A first target already due is still recorded, does not change runtime, emits `wait_elapsed`, and returns `elapsed`.

## API and control flow

The TypeScript handler surface is:

```ts
await context.sleep("provider-cooldown", 60_000);
await context.sleepUntil("embargo", publishAt);
```

`context.getWait(name)` and the low-level Queue read/schedule methods expose the stored wait and provenance. Lease loss and absolute-target conflicts are typed errors.

Scheduling a wait is implemented as internal worker control flow. The worker aborts the handler signal with its private suspension sentinel, stops the heartbeat loop in `finally`, and releases the worker slot before the next claim. It recognizes the sentinel and deliberately skips `fail_v1` and `complete_v1`. The signal is not part of the public API and application code must not catch and suppress it. If handler code catches the sentinel and returns, the outcome arbiter reasserts the recorded suspension and emits `workhorse.handler.signal_swallowed` at warning severity. Arbitrary user effects performed after catching the signal cannot be undone.

Code before a sleep is replayed when the handler restarts. Externally visible or expensive work before a wait must use checkpoints or its own idempotency. Durable sleep does not introduce stack-frame persistence or a workflow graph.

## Races and ownership

The wait function locks the runtime row and rechecks expiry after acquiring the lock. It explicitly writes `state = 'scheduled'`, `run_at = wake_at`, `fence_token = 0`, preserves `current_attempt` and `attempt_started_at`, sets `wait_name`, and nulls `ready_at`, `sequence`, `worker_id`, `acquired_at`, `heartbeat_at`, and `expires_at`. That serializes suspension against checkpoint writes, completion, failure, and expiry recovery.

- If failure, completion, or recovery wins, the waiter returns `stale` and creates no wait row.
- If suspension wins, later completion or failure from the old active generation is stale because ownership has been cleared.
- If the lease expires while the wait function is blocked on the runtime lock, post-lock revalidation rejects it.
- If the first target is already due, the wait is inserted and released immediately without changing the active runtime; replay is therefore stable.
- A call against ready, scheduled, terminal, or another active generation returns `stale` because the exact fenced active row is absent.
- Repeated relative calls are first-write-wins by name and emit `wait_replayed` with the requested and stored targets. A different absolute target, or changing between relative and absolute mode, conflicts.
- At most 1,000 names may be retained for one job, preventing unbounded replay loops.
- Queue purge or future parent-job retention deletes waits through the parent foreign key.

## Rejected alternatives

- **Process-local timers with heartbeats:** not durable and retain scarce worker capacity.
- **Checkpoint-only timers:** checkpoint persistence and active-to-scheduled transition would need one new atomic SQL operation anyway, while timer metadata and observability do not represent a JSON operation result. Overloading checkpoints also obscures the distinction between completed work and pending time.
- **Incrementing attempts on every wake:** long-lived jobs would exhaust retry budgets through successful control flow. Timer suspension is not failure.
- **Adding a public `waiting` dispatch state:** the existing scheduled index and bounded promotion mechanism already provide the correct eligibility path. A nullable wait marker supplies reason-specific observability without another claim-state index.
- **Persisting JavaScript continuations:** language-specific, operationally opaque, and incompatible with Workhorse's explicit replay model.

## Consequences

- Workers release ownership immediately and can process other jobs during long waits.
- Timer eligibility reuses the existing selective scheduled index and worker-owned promotion cadence.
- Named waits become part of the application's durable execution contract. Renaming a wait creates a new boundary. A relative duration is first-write-wins, while an absolute target is immutable.
- Claim events may repeat for one attempt, while attempt history still contains one closing row for that logical attempt.
- Wait timing is at least the requested duration. Promotion cadence, queue pause, worker availability, and database downtime can make actual resumption later. The default maintenance interval creates an approximately one-second scheduling floor; sub-second durable sleeps still require a full promote-and-claim cycle and are an anti-pattern.
- Timer waits alone do not provide signals, cancellation, dependencies, or a workflow runtime.
- Schema version 7 remains clean-install validation only. A production upgrade path still requires the planned migration framework.

## Validation

Live PostgreSQL tests must cover first suspension, immutable provenance, relative first-write-wins replay, absolute-target conflict, mode conflict, name/duration/timestamp bounds, the 1,000-wait limit, past-due first calls, stale-generation and non-active rejection, lock-wait expiry revalidation, serialization against completion/failure/recovery, due promotion with the carried wait name, same-attempt continuation, truthful logical start and final claim timestamps, failure after wake, multiple named waits, terminal retention, parent deletion, `wait_scheduled`/`wait_elapsed`/`wait_replayed` events, worker-slot release, and handler replay without re-running checkpointed work.
