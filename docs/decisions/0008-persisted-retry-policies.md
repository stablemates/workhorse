# ADR 0008: Persisted PostgreSQL-owned retry policies

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

Workhorse previously had two compatibility behaviors rather than one durable policy model. Handler failure without an explicit delay used a Sidekiq-inspired random backoff in SQL, while expired-lease recovery requeued immediately. Applications could provide a numeric `Queue.fail` delay or configure `WorkerOptions.retryDelayMs`, including a callback, but that process-local choice was not persisted with the job or recurring schedule definition.

That made named policy intent unavailable to claims, snapshots, operators, and lifecycle history. A callback could also produce a different result after process restart or `Queue` recreation. Lease recovery could diverge from handler failure even when an application intended one explicit policy for both paths.

Retry scheduling affects durable state, attempt history, ownership fencing, and dispatch timing. Policy validation and delay choice therefore belong with the PostgreSQL transition rather than in whichever worker process observes a failure.

## Decision

Schema version 9 persists an optional normalized `retry_policy` JSON value on stable job identity and recurring schedule definitions. The public union is:

```ts
type RetryPolicy =
  | { type: "fixed"; delayMs: number }
  | {
      type: "exponential";
      initialDelayMs: number;
      multiplier: number;
      maxDelayMs: number;
    }
  | { type: "decorrelated-jitter"; baseDelayMs: number; maxDelayMs: number };
```

Enqueue and schedule synchronization accept the union. Schedule firing copies the definition policy to the new stable job identity. Claims and `JobSnapshot` return the normalized persisted policy so handlers and read models can inspect the same durable configuration.

### PostgreSQL owns validation and transition

PostgreSQL validates exact object shape, normalizes numeric values, selects each delay, updates live runtime, persists any required selector state, and appends lifecycle provenance in the same transaction. The same explicit policy applies to handler failure and expired-lease recovery.

Delay values must be integers from zero through 31,536,000,000 milliseconds, or 365 days. Exponential multipliers must be integers from 1 through 100. Exponential and decorrelated-jitter maxima must be at least their initial or base delay. Invalid, overflowing, extra-key, or JSON `null` policies are rejected before durable acceptance.

`retry_scheduled` and `lease_expired` event details include the normalized `retry_policy`, selected `retry_delay_ms`, and `retry_delay_source`. This records whether PostgreSQL selected a fixed, exponential, or jitter policy, a caller supplied an override, or a compatibility default applied.

### Compatibility defaults remain path-specific

Omitting `retryPolicy` does not silently change existing behavior:

- handler failure uses the legacy Sidekiq-inspired random backoff;
- expired-lease recovery uses zero delay and becomes ready immediately.

`Queue.recoverExpired(limit)` passes an omitted delay as SQL `NULL`, which is distinct from explicitly passing zero and allows PostgreSQL to select a persisted policy or the immediate compatibility default.

### Decorrelated jitter is deterministic

Decorrelated jitter uses stable job identity, current attempt, and the persisted previous jitter delay as selector inputs. PostgreSQL stores the selected value in `job_runtime.previous_retry_delay_ms` for the next retry. Replaying the same selector inputs or recreating the TypeScript `Queue` therefore cannot change a previously determined sequence.

The deterministic selector avoids process-local random state while retaining bounded decorrelation between jobs and attempts. It is deterministic scheduling, not a cryptographic random source.

### Manual override precedence is preserved

A numeric `Queue.fail` delay and the numeric or callback-derived result of `WorkerOptions.retryDelayMs` remain higher-precedence manual overrides. An explicit numeric recovery delay has the same precedence. Overrides select timing only. PostgreSQL still owns retry-budget exhaustion, state transition, attempt closure, fencing, and provenance.

## Consequences

### Positive

- Retry intent survives worker restart, replay, schedule firing, and `Queue` recreation.
- Handler failure and lease recovery obey one explicit policy when one is configured.
- Validation, bounds, delay selection, transition, and provenance commit atomically.
- Operators can inspect policy and selected-delay source through claims, snapshots, and lifecycle events.
- Existing applications that omit policy retain their prior handler-failure and lease-recovery behavior.
- Manual operational and handler overrides remain available without bypassing retry budgets.

### Negative

- Stable job identity and recurring schedule definitions carry additional JSON policy data.
- Decorrelated jitter requires one nullable previous-delay field in live runtime.
- Deterministic jitter is tied to the current PostgreSQL hash-based selector contract, so changing that algorithm would require an explicit protocol decision.
- Numeric policy selection timings are not yet isolated from the surrounding failure transition; benchmark evidence should be interpreted as full transition cost.

## Rejected alternatives

- **Keep callbacks as the primary policy API:** callbacks are process-local, not inspectable, and can change across deployment or replay.
- **Select delays in TypeScript and persist only the result:** this splits correctness authority and can diverge between handler failure, maintenance recovery, and other clients.
- **Use nondeterministic database randomness for decorrelated jitter:** replay of identical durable state could select another delay and make provenance harder to reason about.
- **Change omitted lease recovery to the handler backoff:** this would break compatibility and delay recovery for applications that never requested that behavior.
- **Let explicit delay bypass exhaustion:** timing configuration must not weaken the persisted attempt budget.

## Validation

Integration coverage exercises policy normalization and bounds, fixed and exponential sequences, deterministic decorrelated jitter with persisted prior delay, enqueue and schedule persistence, claim and snapshot exposure, handler failure, lease recovery, compatibility defaults, override precedence, event provenance, `Queue` recreation, and terminal exhaustion. The existing `retry-paths` lifecycle benchmark additionally exercises fixed, exponential, and jitter selection and records full failure-transition timings without claiming unrecorded overhead numbers.
