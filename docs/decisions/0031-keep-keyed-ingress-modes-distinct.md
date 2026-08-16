# ADR 0031: Keep keyed ingress modes distinct

- **Status:** Accepted
- **Date:** 2026-08-16
- **Related:** [ADR 0009](0009-enqueue-idempotency-keys.md), [ADR 0030](0030-distinguish-suspensions-gates-and-child-joins.md)

## Context

Enqueue idempotency, debounce, and throttle all accept a caller key and converge requests on one
stable job identity. PostgreSQL stores their ownership in `enqueue_idempotency` and serializes them
through the same scoped-key lock.

Their caller promises differ. Idempotency says a repeated request is the same acceptance attempt.
Debounce says a newer pending definition should replace an older one. Throttle says one equivalent
acceptance is enough for a fixed window.

Treating these as one deduplication feature would make a repeated key ambiguous. PostgreSQL could
not know whether changed payload meant conflict, replacement, or intentional suppression.

## Decision

Keep `idempotency`, `debounce`, and `throttle` mutually exclusive in `EnqueueOptions`. A scoped key
may own only one mode until its binding expires or purge releases it.

Each mode keeps one meaning:

- **Idempotency** converges retries of one materially equivalent request. Exact replay returns the
  retained identity with `replayed`. A changed request raises `EnqueueIdempotencyConflictError`.
- **Debounce** owns one pending definition while arrivals continue. An eligible request may change
  the payload and other accepted fields, returning `replaced`. An ineligible replacement returns
  `non_replaceable` without changing the retained job.
- **Throttle** owns one materially equivalent acceptance for its window. Reuse returns
  `coalesced` whether the retained job is scheduled, ready, active, or terminal. A changed request
  raises `EnqueueIdempotencyConflictError`.

The structured outcomes remain distinct. `replayed` means the caller retried an acceptance.
`replaced` means PostgreSQL changed pending work. `non_replaceable` means it retained pending work
and refused the proposed change. `coalesced` means the acceptance window absorbed an equivalent
request.

The shared table and lock are implementation reuse, not a shared semantic contract. A mode mismatch
under a retained scoped key conflicts because two ownership meanings cannot coexist safely.

Idempotency may fingerprint dependency inputs because exact replay preserves the accepted graph.
Debounce and throttle reject `prerequisiteJobId` and `dependencies`. Debounce cannot mutate durable
edges after acceptance, and throttle cannot silently discard a changed graph.

Child creation rejects all three keyed ingress options. The stable parent identity and child name
already provide its replay boundary, so a second ownership key would create competing identities.

## Consequences

- Callers choose the mode from intent rather than treating all three as duplicate suppression.
- `Queue.enqueueWithResult` and `Queue.enqueueManyWithResults` retain enough information to explain
  whether PostgreSQL replayed, changed, refused, or absorbed a request.
- The database can share key hashing, lock ordering, expiry, cleanup, and safe diagnostics without
  collapsing behavior.
- Adding another keyed mode requires a new caller promise and outcome. It cannot reuse an existing
  name merely because its storage fits `enqueue_idempotency`.

## Rejected alternatives

### One keyed enqueue option with a mode flag

This would make incompatible fields valid in one structural type and move basic mistakes from
TypeScript construction to runtime validation.

### Treat every changed request as a conflict

That preserves idempotency and throttle, but removes the deliberate replacement behavior that
makes debounce useful.

### Treat every repeated request as coalesced

That would silently discard changed work under throttle and hide ambiguous-response retries under
idempotency. Callers need those failures and outcomes to detect incorrect keys.
