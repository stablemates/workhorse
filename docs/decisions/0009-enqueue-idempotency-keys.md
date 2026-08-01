# ADR 0009: PostgreSQL-owned scoped enqueue idempotency keys

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

Applications can lose an enqueue response after PostgreSQL commits, retry an HTTP request, or submit duplicate entries inside one batch. Before schema version 10, every accepted retry created a new stable job identity, runtime row, enqueue event, FIFO placement, and possible wake notification. Caller transactions made one attempt atomic, but they did not let a later attempt discover whether the same durable request had already committed.

Enqueue deduplication affects identity allocation, batch ordering, transactional rollback, ready-sequence allocation, notifications, retention, purge, and diagnostics. A process-local cache cannot serialize competing producers or survive process loss. The ownership decision therefore belongs in PostgreSQL beside the acceptance transition.

This decision covers durable enqueue acceptance only. Workhorse handler delivery and external effects remain at least once.

## Decision

Schema version 10 adds optional enqueue options:

```ts
interface EnqueueIdempotency {
  key: string;
  scope?: string;
  ttlMs?: number;
}

interface EnqueueOptions {
  idempotency?: EnqueueIdempotency;
}
```

The default scope is `default`. The default TTL is 86,400,000 milliseconds, or 24 hours. Keys contain 1 through 512 UTF-8 bytes, scopes contain 1 through 256 UTF-8 bytes, and TTL is an integer from 1 through 31,536,000,000 milliseconds, or 365 days.

Requests that omit `idempotency` bypass the new ownership relation and preserve the previous behavior: every accepted request receives a new job identity.

### PostgreSQL owns scoped unique ownership

`workhorse.enqueue_idempotency` stores the scope, full SHA-256 key hash, canonical request fingerprint, owned job ID, and expiry. Raw keys are never persisted. Its primary key `(idempotency_scope, idempotency_key_hash)` is the serialization point for concurrent producers.

`enqueue_many_v1` acquires every distinct scoped-key lock in deterministic sorted order before processing requests, so overlapping batches cannot deadlock when callers submit the same keys in opposite orders. Job, event, runtime, FIFO, and result processing still follows caller ordinal order. A new owner reserves its scoped key before creating any durable acceptance side effect. The deferred reference from the binding to stable job identity allows that reservation and the new job to commit atomically. Caller transactions retain control of the whole operation.

### Request equivalence is explicit

The canonical fingerprint includes:

- queue name;
- job type;
- PostgreSQL-canonical JSON payload;
- sorted tags;
- `maxAttempts`;
- normalized persisted `retryPolicy`;
- idempotency TTL;
- explicitly supplied `runAt`.

For keyed immediate ingress, omitted `runAt` remains omitted in the fingerprint. PostgreSQL still uses one statement timestamp to classify new work as ready or scheduled, but it does not materialize that timestamp into equivalence. A client can therefore retry an immediate keyed request later and replay the committed acceptance.

TTL is material because it defines how long the caller asked Workhorse to retain ownership. Scope and key select the owner and are not duplicated inside the fingerprint.

### Exact replay has no duplicate acceptance side effects

When the scoped key is retained and the fingerprint is equivalent, enqueue returns the existing job ID. Replay does not create another:

- `job` identity;
- `job_runtime` row;
- `job_event` row;
- ready FIFO sequence allocation;
- `NOTIFY workhorse_jobs` wake hint.

The same rule applies across separate calls, concurrent callers, caller-owned transactions, and duplicate keys inside one `enqueueMany` request. Returned IDs still correspond to input order, so equivalent duplicate positions repeat the same ID.

### Material mismatch is a safe structured conflict

When a retained scoped key has a different fingerprint, PostgreSQL aborts the statement with a dedicated conflict code. The TypeScript client translates it to a structured enqueue-idempotency conflict that identifies the existing job and conflicting request ordinal.

Raw idempotency keys are never persisted. The initial `enqueued` event, UI projections, logs derived from the public error, and structured conflict details expose only a bounded key preview plus 12-hex key digest. Exact replay emits no new event. Conflicts additionally include full SHA-256 digests of the stored and rejected canonical requests. This allows operators to correlate ownership and material differences without turning caller credentials or personal data embedded in keys into broad observability data.

Any conflict rolls back the complete batch, including earlier new keys in that statement. A surrounding caller transaction also remains authoritative for commit or rollback.

### Expiry, housekeeping, and purge release ownership

A binding whose `expires_at` has passed no longer owns its scoped key. A later request may atomically remove the expired binding, establish new ownership, and create a new job identity, even when its request differs from the expired request. Reuse does not delete or mutate the original job.

`housekeep_v1` cleans expired enqueue-idempotency bindings before terminal identity pruning in the same pass. This order prevents an expired binding from unnecessarily retaining an otherwise eligible terminal identity while preserving active bindings as deletion guards.

`purge_queue_v1` releases bindings for queued or scheduled jobs deleted by purge. Active and terminal jobs remain outside purge as before.

### Enqueue deduplication is not exactly-once execution

The key governs acceptance of one durable job identity. It does not prevent the job handler from running more than once after lease expiry, process loss, or an ambiguous completion response. It also cannot make HTTP calls, emails, payments, or other external effects exactly once.

Handlers must continue to use provider idempotency keys, transactional outbox/inbox patterns, explicit checkpoints with an understood crash window, or compensation where effects cannot safely repeat.

## Consequences

### Positive

- Ambiguous enqueue retries converge on one durable identity while the binding is retained.
- PostgreSQL serializes concurrent producers without a process-local coordination service.
- Exact replay avoids duplicate job, history, FIFO, and notification work.
- Batch duplicates preserve input/result ordering, and any mismatch rolls back atomically.
- Explicit equivalence prevents a reused key from silently changing durable work.
- Omitted keyed `runAt` supports practical retry of immediate ingress.
- Expiry and purge provide bounded ownership rather than permanent key reservation.
- Full key hashing plus safe previews and digests support correlation without persisting or spreading raw keys.
- Existing unkeyed callers keep their prior API and behavior.

### Negative

- Keyed enqueue adds one scoped ownership lookup and retained binding row.
- TTL becomes part of request equivalence, so callers must retry with the same retention intent.
- Applications must choose stable key and scope conventions and avoid placing secrets in keys despite diagnostic redaction.
- Expiry permits intentional reuse and therefore cannot provide permanent global deduplication.
- The contract does not reduce at-least-once handler execution or external-effect risk.

## Rejected alternatives

- **Always derive a key from the request:** callers often need domain identity, and automatic hashing cannot express the intended retry boundary or retention scope.
- **Keep a process-local cache:** it cannot coordinate multiple producers, survive restart, or participate in the enqueue transaction.
- **Store the binding on `job`:** scoped uniqueness and expiry cleanup are separate ownership concerns and should not add mutable lookup fields to immutable job identity.
- **Treat omitted `runAt` as the statement timestamp:** each retry would fingerprint a different immediate timestamp and defeat the primary ambiguous-response use case.
- **Ignore material mismatches:** silently returning the old job for changed work would hide caller bugs and cross-request key collisions.
- **Make keys permanent:** permanent ownership creates unbounded retention and prevents legitimate reuse after the caller's risk window.
- **Claim exactly-once effects:** enqueue identity convergence does not fence external side effects performed by an at-least-once handler.

## Validation

Integration coverage exercises schema version 10 hash-only storage and constraints, UTF-8 byte and TTL bounds, default scope and TTL, concurrent exact replay, one safe initial enqueue event and no duplicate job/event/runtime/FIFO/notification effects, sorted-tag and normalized-policy equivalence, explicit and omitted `runAt`, structured redacted conflicts with key and request digests, retention-window mismatch, same-batch duplicates, whole-batch rollback, caller-transaction rollback, unkeyed compatibility, expiry reuse, purge release, and housekeeping-before-terminal-pruning order.

The `idempotent-ingress` operational benchmark scenario adds hard invariants for exact replay, conflict rollback, batch duplicates, expiry reuse, and resulting durable state. It records full client-observed transition timings. No numerical latency or overhead claim is accepted until a benchmark artifact containing the scenario is recorded.
