# ADR 0013: PostgreSQL-owned deadlines and per-attempt execution timeouts

- **Status:** Accepted
- **Date:** 2026-08-02
- **Related:** [ADR 0005](0005-explicit-durable-checkpoints.md), [ADR 0006](0006-named-durable-timer-waits.md), [ADR 0008](0008-persisted-retry-policies.md), [ADR 0010](0010-cooperative-job-cancellation.md)

## Context

Workhorse already fences completion, failure, checkpoints, durable waits, cancellation acknowledgement, and lease recovery by the exact active worker and fence generation. It did not bound how long a job could remain eligible overall or how much execution time one attempt could consume. Applications therefore had to implement deadlines outside the durable protocol, where a late handler could still commit a success after an application timer fired.

A deadline and an execution timeout have different meanings. A deadline is an absolute lifetime boundary for the stable job identity and must stop all later dispatch or retry. An execution timeout closes only the current attempt and may use the existing retry budget. Neither boundary can forcibly preempt JavaScript or guarantee that already-started external effects stop immediately.

## Decision

Workhorse persists two optional limits with the immutable job definition:

- `deadline` is an absolute finite PostgreSQL timestamp.
- `executionTimeoutMs` is a bounded duration applied independently to each attempt.

PostgreSQL remains authoritative for both limits. Claim, heartbeat, completion, failure, checkpoint, durable-wait, promotion, and maintenance transitions serialize through the live runtime row and recheck the relevant boundary after acquiring its lock.

An expired deadline is terminal and never creates another attempt. Ready or scheduled work whose deadline has passed is materialized as a failed terminal outcome before it can be newly claimed. An active deadline aborts the handler signal cooperatively and removes the live runtime through the exact owned generation or bounded maintenance. Late completion and every other stale write are rejected.

An execution timeout closes the current attempt with distinct timeout evidence. If retry budget remains, PostgreSQL schedules the next attempt through the persisted retry policy. Otherwise it materializes a failed terminal outcome. Timeout handling is not lease recovery: it records its own lifecycle event, attempt outcome, and error envelope.

Durable timer waits release the lease and pause active execution accounting. Resuming a named wait continues the same logical attempt with its remaining execution budget. A deadline remains wall-clock based and continues to advance while a job is scheduled, waiting, retrying, or active.

Cancellation, deadlines, execution timeouts, completion, failure, and lease expiry use row-lock ordering and first-committer-wins semantics. A committed terminal outcome is immutable. A committed cancellation request retains cancellation precedence when later expiry maintenance closes the active lease. Otherwise PostgreSQL identifies the earliest due deadline or execution timeout explicitly rather than reporting a generic lease expiry; an exact timestamp tie is classified as the terminal deadline.

The worker uses the PostgreSQL-returned boundary snapshots only to deliver prompt `AbortSignal` reasons. Local timers are advisory. Durable truth comes from the SQL transition, and an ignored signal is eventually fenced and materialized by maintenance.

Ordinary handlers should finish within 110 seconds for safer rolling deployments. Longer work should
be expressed as durable, idempotent stages with named checkpoints and lease-releasing waits. This is a
deployment recommendation, not a hard protocol maximum, because supervisor grace periods differ.

`Queue.health()` reports the number of live jobs past deadline, jobs approaching their deadline, active attempts past timeout, and the nearest deadline. The dashboard projects the same low-cardinality signals and marks overdue work critical. Job IDs remain absent from dimensions. A production metrics or tracing exporter remains part of the separate production-telemetry roadmap item.

## Consequences

### Positive

- Expired jobs cannot enter a new handler activation.
- A late handler cannot overwrite a committed deadline or timeout transition.
- Deadline and timeout evidence remains distinct from cancellation and lease expiry.
- Timeout retries reuse the same PostgreSQL-owned retry policy and budget semantics.
- Durable waits do not accidentally consume active execution budget.
- Operators can see deadline pressure before it becomes a terminal failure backlog.

### Negative

- The live runtime carries additional timing state and deadline maintenance indexes.
- Worker abort delivery is cooperative, so external effects already in progress can outlive the signal.
- A timeout can cause at-least-once repetition when the timed-out attempt started an external effect before stopping.
- Deadline expiry and timeout expiry add maintenance work that must remain bounded.
- Schema version 13 remains a preproduction clean-install contract. Existing version 12 databases are rejected rather than modified; an online upgrade path still belongs to the planned migration framework.

## Rejected alternatives

### Implement limits only with JavaScript timers

A local timer cannot fence a late SQL completion after process pause, event-loop delay, or worker loss. It also cannot prevent another worker from claiming an already-expired job.

### Treat timeout as cancellation

Cancellation is an operator or application request with attribution and no automatic retry. An execution timeout is policy enforcement on one attempt and can legitimately retry.

### Treat deadline or timeout as lease expiry

Lease expiry means ownership disappeared or stopped heartbeating. A healthy worker can exceed a configured execution limit while still heartbeating, so folding the cases together would hide the actual cause and apply the wrong retry semantics.

### Let durable waits consume execution timeout

A durable wait deliberately releases the worker slot. Charging scheduled sleep against active execution would make long timers incompatible with short handler budgets and would turn a persistence boundary into accidental failure.

## Validation

Acceptance requires PostgreSQL integration coverage for validation and idempotency equivalence, expired ready and scheduled work, active cooperative delivery, ignored-signal maintenance, timeout retry and terminal exhaustion, durable-wait budget pause/resume, deadline-versus-timeout ordering, cancellation and completion races, stale-fence rejection, health pressure, recurring definitions, and a focused operational scenario. The complete typecheck, lint, unit, integration, packed-package, demo smoke, and format checks must pass before the roadmap item is marked complete.
