# ADR 0014: Immutable dead letters with audited redrive lineage

- **Status:** Accepted
- **Date:** 2026-08-03
- **Related:** [ADR 0001](0001-live-runtime-cold-outcome.md), [ADR 0009](0009-enqueue-idempotency-keys.md), [ADR 0010](0010-cooperative-job-cancellation.md), [ADR 0013](0013-deadlines-execution-timeouts.md)

## Context

Workhorse materializes terminal failures in the cold `job_outcome` relation, outside every dispatch index. Operators can inspect one known job, but there is no bounded failure inbox and no supported way to retry a terminal identity. Reusing the failed identity would violate the invariant that a terminal outcome is immutable, erase the evidence that exhausted its attempts, and make repeated operator requests ambiguous.

Redrive is an operational mutation, not another handler retry. It needs durable attribution, request idempotency, lineage, bounded bulk behavior, and a non-mutating preview. It must not claim exactly-once external effects or copy durable checkpoints from the failed execution.

## Decision

Workhorse exposes a failure-only, cursor-based dead-letter query over `job_outcome`. A partial cold-outcome index orders failed rows by immutable completion time and job identity. Failures are never copied into `job_runtime` or any ready, scheduled, or active dispatch index merely to make them queryable.

A redrive creates a new stable job identity. PostgreSQL copies the source queue, type, payload, tags, maximum attempts, retry policy, and per-attempt execution timeout. The new job begins ready at attempt one. The source absolute deadline is deliberately cleared because replaying an elapsed wall-clock boundary would usually create an immediately failed clone. Checkpoints, durable waits, attempt history, results, and prior cancellation state are never copied.

The original outcome's semantic terminal evidence remains immutable. PostgreSQL records one audited lineage edge from source to target plus append-only lifecycle events on both identities. Those events may advance the existing `history_through_at` retention watermark, but never alter terminal state, attempt, fence, run time, result, error, or finish time. `Admin.redrive` requires bounded `actor`, `reason`, and `requestId` values. The raw request ID is not persisted or exposed; its hash, safe preview, length, and request fingerprint provide durable replay evidence.

Redrive idempotency is scoped to the failed source identity and request ID. An exact replay returns the original target. Reusing that identity with materially different attribution fails with a typed conflict and safe diagnostics. Concurrent exact requests serialize in PostgreSQL and create one target.

Bulk redrive uses the same failure filters as listing, selects at most 1,000 sources in deterministic oldest-first order after an optional `(finishedAt, jobId)` cursor, and applies the same per-source idempotency contract. The result returns a continuation cursor only when another source exists, so large backlogs progress across requests and equal finish times without skipping. Repeating the same cursor and request replays the same page. Dry-run returns the eligible source set and writes no jobs, lineage, events, notifications, or audit rows.

Lineage protects source identity while a retained descendant still refers to it. Terminal pruning skips protected sources; deleting an eligible target removes its inbound lineage edge, allowing ancestors to become eligible later. Outcome and partitioned history retention remain governed by their existing independent windows.

## Consequences

### Positive

- Terminal failures remain cold and immutable.
- Operators can page and filter a bounded failure inbox without contaminating claim indexes.
- Every new execution has a distinct identity and complete retained lineage.
- Exact retries of an operator request cannot create duplicate targets.
- Bulk preview and execution use the same PostgreSQL filter semantics.
- Expired absolute deadlines do not make redriven work fail immediately.

### Negative

- Source job identities can outlive their normal identity-retention boundary while descendants remain retained.
- Redrive creates another at-least-once execution and can repeat external effects.
- Bulk redrive is intentionally capped and may require multiple requests for a large backlog.
- A redriven job does not inherit durable progress and must reconstruct safe external state itself.
- Schema version 14 remains a preproduction clean-install contract. Existing version 13 databases are rejected rather than modified; online upgrades remain part of the migration-framework roadmap.

## Rejected alternatives

### Move a failed outcome back into the live runtime

This destroys immutable terminal evidence, reuses attempt and fence generations, and makes concurrent inspection or replay unsafe.

### Copy failures into a dedicated dispatch-like dead-letter queue

A second mutable queue duplicates lifecycle authority and adds terminal volume to hot operational indexes. The cold outcome already is the durable dead-letter source of truth.

### Copy checkpoints and waits into the target

Those records describe restart boundaries for the source identity. Reusing them would silently skip work in a new execution whose external state may differ.

### Preserve the source absolute deadline automatically

Most operational redrives happen after the original deadline. Preserving it would create an immediately terminal clone and make redrive misleading. Callers can enqueue a separately defined job when a new deadline is required.

### Implement bulk redrive by listing in JavaScript and enqueueing independently

That splits eligibility, audit, idempotency, and mutation across transactions. PostgreSQL must own the bounded candidate set and every resulting lineage edge.

## Validation

Acceptance requires integration coverage for failure filtering and cursor order, index shape, single redrive copy and clearing semantics, immutable source outcomes, lifecycle events, retained lineage, exact replay, conflict translation, concurrent replay, nonfailed and missing sources, bulk bounds and filters, dry-run purity, repeated bulk requests, and retention protection. A focused operational scenario must exercise query, preview, mutation, replay, and source immutability. The complete format, lint, typecheck, unit, integration, packed-package, and clean-checkout demo gates must pass before the roadmap item is marked complete.
