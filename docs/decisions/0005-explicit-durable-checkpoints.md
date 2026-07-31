# ADR 0005: Immutable named durable checkpoints

## Status

Accepted for the schema version 6 validation protocol.

## Context

Workhorse retries restart a handler from its entry point. Applications with several expensive or externally visible steps need an explicit boundary that records completed work so a later attempt can reuse its result instead of repeating the whole handler.

A checkpoint cannot make an external effect exactly once. A process may disappear after an external system commits but before PostgreSQL records the result. The protocol must therefore preserve at-least-once semantics and continue to require provider idempotency, outbox/inbox, or compensation.

The checkpoint write must also obey the same ownership rules as heartbeat, completion, and failure. A worker whose lease expired or whose generation was recovered cannot record state for the newer attempt.

## Decision

Store checkpoints in `workhorse.job_checkpoint` as immutable JSON results keyed by `(job_id, checkpoint_name)`.

`save_checkpoint_v1` locks the active `job_runtime` row and then verifies the exact job, worker, fence, active state, and unexpired lease. Locking the runtime serializes checkpoint insertion against completion, failure, and expiry recovery. The row records the attempt, fence token, worker ID, and creation time that authorized it.

A repeated save of the same name and JSONB value returns the existing checkpoint. A repeated name with a different value is a conflict. A stale owner is rejected. Successful insertion appends a `checkpoint_saved` lifecycle event.

The TypeScript worker exposes:

- `context.getCheckpoint(name)` for an explicit read;
- `context.checkpoint(name, operation)` to return an existing value or run and persist the operation;
- `Queue.getCheckpoint` and `Queue.saveCheckpoint` as the thin protocol client methods.

One handler coalesces overlapping calls for the same checkpoint name. Checkpoints remain readable across retries and after terminal materialization, and are deleted only when their parent job identity is deleted.

## Consequences

- Handlers gain declared restart boundaries without introducing a workflow graph or stack-frame replay.
- Stable names become part of the application's durable execution contract. Renaming a checkpoint changes restart behavior.
- Checkpoint values are immutable. Applications needing revisions must use distinct names or a later purpose-built mutable-state feature.
- Checkpoint storage grows with retained job identities and requires inclusion in future retention and payload-size policies.
- Each value is bounded to 1 MiB of PostgreSQL's canonical JSONB text representation, so all language clients share one authoritative limit. Checkpoints have no independent prune operation because removing a completed name while retaining a retryable job could repeat the step; they are retired with the parent job identity.
- Named rows are a better fit for independently reusable steps than one mutable job snapshot, while preserving direct primary-key reads and keeping checkpoint data out of dispatch indexes.
- Cross-language clients can implement the same behavior through the versioned SQL function and JSON-compatible values.
- External effects remain at least once across the effect-to-checkpoint crash window.
- Every saved name appends a lifecycle event, so checkpoint-heavy handlers increase history-partition write volume and require benchmark evidence before scale claims.
- Schema version 6 remains a clean-install validation protocol. Existing version 5 databases are rejected rather than changed by an ad hoc migration; a supported release still requires the planned migration framework.

## Validation

Live PostgreSQL integration tests cover initial persistence, ownership provenance, JSON null, payload bounds, equal replay, conflicting values, stale-generation rejection after recovery, row-lock expiry revalidation, serialization against retry and completion, reuse by a later attempt, persistence after terminal success and failure, lifecycle events, and overlapping same-name handler calls.
