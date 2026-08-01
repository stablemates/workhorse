# ADR 0010: Cooperative job cancellation

## Status

Accepted for the schema version 11 validation protocol.

## Context

Operators and applications need to stop work that is no longer useful without weakening Workhorse's fenced ownership model. Queued work can terminate before a handler starts, but active JavaScript cannot be safely preempted by PostgreSQL. A process may also ignore a cooperative signal or disappear after cancellation is requested.

Cancellation therefore has to preserve the existing lifecycle exclusivity invariant, serialize with completion and failure, keep attempt history truthful, and avoid implying authorization or exactly-once external effects. Recurring schedules add another boundary: an occurrence is a normal job, while the schedule definition is independent desired state.

## Decision

Expose `Queue.cancel(jobId, { requestedBy?, reason? })` over `workhorse.cancel_v1`.

Ready, future-scheduled, and durable-wait continuations cancel immediately. The transition locks and deletes the sole runtime row, inserts one immutable `canceled` outcome, and appends one terminal event. A job whose handler never started has no attempt-history row. A durable-wait continuation whose logical attempt already started closes exactly one canceled attempt using its retained ownership provenance.

Active cancellation is cooperative. The first request stores `cancel_requested_at`, optional bounded attribution, and optional bounded reason on the active runtime and appends one `cancel_requested` event. Repeated requests return the first committed request without changing attribution or adding events.

Add `heartbeat_v2`, returning `accepted`, `cancel_requested`, or `stale`. It extends only accepted leases. Retain `heartbeat_v1` additively as a boolean compatibility function that returns true only for accepted ownership. The TypeScript worker converts `cancel_requested` into `CancellationRequestedError` on the handler's existing `AbortSignal`.

The worker acknowledges through `acknowledge_cancel_v1`. Acknowledgement requires the exact unexpired worker ID and fence token that owns the active runtime. It atomically deletes runtime and inserts one canceled outcome, one canceled attempt row, and one terminal event. Wrong-fence, stale, expired, or already-terminal acknowledgements fail.

If a handler ignores the signal, cancellation remains attached to the active lease. When the lease expires, `recover_expired_v1` materializes the requested cancellation instead of incrementing the attempt or selecting a retry delay. This gives abandoned requests a deterministic terminal path without forced interruption.

Completion, failure, checkpoint, durable-wait scheduling, heartbeat, acknowledgement, and recovery all serialize on the same runtime row. Cancellation versus completion or failure is first-committer-wins:

- if cancellation commits first, later owner writes are stale or cancellation-requested and cannot overwrite the outcome;
- if completion or terminal failure commits first, cancellation reports `already_terminal` with the committed state;
- repeated cancellation after terminal cancellation returns the existing outcome without duplicate events, outcomes, or attempt history.

`requestedBy` is attribution only. It records what the caller asserted for audit and display. It is not proof that the caller was authenticated or authorized. Applications, APIs, and operator layers must enforce permission checks before calling the core transition.

Canceling a recurring occurrence affects only the fired job. It does not disable or edit the schedule definition, change its revision, remove occurrence deduplication, or prevent later occurrences from firing.

## Consequences

- Canceled is a third immutable terminal outcome beside succeeded and failed.
- Never-started cancellation does not fabricate a worker, fence, or attempt row.
- Started active or durable-wait cancellation closes exactly one truthful attempt row.
- Active handlers receive a standard `AbortSignal` and should stop starting new effects promptly.
- Existing heartbeat clients retain their boolean API and treat both cancellation and stale ownership as false.
- Requested leases that expire cannot retry and later stale writes cannot recreate live state.
- Queue health and read models include canceled state and active request metadata.
- Cancellation timing can be observed by the operational benchmark, but no SLA or performance claim follows without a recorded artifact and environment analysis.

## Non-goals

- Forcefully interrupting JavaScript, terminating a process, or rolling back an already committed external effect.
- Exactly-once handler execution or exactly-once HTTP, email, payment, or other provider effects.
- Treating `requestedBy` as authentication, authorization, or non-repudiation.
- Disabling a recurring schedule when one occurrence is canceled.
- Providing general-purpose signals, workflow interruption, child-job propagation, deadlines, or execution timeouts.
