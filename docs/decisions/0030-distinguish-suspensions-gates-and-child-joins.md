# ADR 0030: Distinguish suspensions, dependency gates, and child joins

- **Status:** Accepted
- **Date:** 2026-08-16
- **Related:** [ADR 0005](0005-explicit-durable-checkpoints.md), [ADR 0006](0006-named-durable-timer-waits.md), [ADR 0013](0013-deadlines-execution-timeouts.md)

## Context

`HandlerContext` offers three ways for a running handler to release its lease and resume later.
`sleep` and `sleepUntil` record a timer. `waitForSignal` and `waitForHuman` require an external
delivery. `runChild` and `runChildren` create other jobs and consume their results.

`EnqueueOptions.dependencies` also delays dispatch, but no handler has started when PostgreSQL
creates that boundary. It controls whether a job may enter dispatch after prerequisite outcomes.

These mechanisms share some storage details. Timer, signal, and human boundaries use a
`scheduled` runtime with `wait_name`. A child join and an enqueue dependency use a `blocked`
runtime plus `job_dependency`. Those shared states do not make the mechanisms interchangeable.

The public vocabulary blurred the distinction. `Admin.getWait` and `Admin.listWaits` return only
`job_wait` timer records. `blockedReason` reports `prerequisite_pending` even when a child edge
caused the blocked state. A workflow runtime built on those names could mistake storage shape for
user intent.

## Decision

Use **suspension** for a handler transition that releases its lease, preserves its logical attempt,
and restarts the handler from entry. Every suspension requires replay-safe code before its boundary.

Keep four distinct domain mechanisms:

- A **timer wait** is the immutable `job_wait` record created by `sleep` or `sleepUntil`.
  `Admin.getWait` and `Admin.listWaits` remain timer-only APIs.
- A **signal boundary** is the `job_signal_wait` record completed by `Queue.sendSignal`.
  It carries a delivered application payload.
- A **human decision** is the `job_human_wait` record completed by
  `Queue.completeHumanWait`. It carries operator context, result, and attribution.
- A **child join** is the `job_child` lineage created by `runChild` or `runChildren`.
  It delegates independent work and consumes retained successful results.

An enqueue dependency is a **dependency gate**, not a suspension. It exists before any handler
activation, consumes no logical attempt, and applies declared policy to prerequisite outcomes.

The runtime states remain implementation states. `scheduled` means the runtime cannot enter
dispatch until another transition. Ordinary schedules and timer waits use `run_at` for later
eligibility. Signal boundaries and human decisions use external delivery for resumption and
`deadline_at` for terminal timeout. The owning evidence table distinguishes those meanings.

`blocked` means another job outcome controls dispatch. Operator projections must inspect retained
evidence before calling that reason a dependency gate or child join.

Expand `blockedReason` to `"prerequisite_pending" | "child_pending" | null` instead of treating
`prerequisite_pending` as universal. A child-controlled parent reports `child_pending`. A job with
ordinary dependency edges reports `prerequisite_pending`. The public read contract must adopt this
union before a workflow runtime depends on it.

Keep the existing `HandlerContext` identifiers for compatibility. New documentation and APIs use
`wait` only as the noun for a timer record. They use `claim` and `redrive` as verbs, `fence token`
as a noun, and `pause` as the operator action.

`BatchHandlerContext` continues to omit all suspension and child-join methods. One member cannot
release its lease while a shared callback still owes an outcome for every other member.

## Consequences

- A workflow runtime composes explicit timers, signals, human decisions, child joins, and
  dependency gates. It does not build on one generic wait abstraction.
- `Admin.getWait` and `Admin.listWaits` keep their stable timer-record meaning.
- Operational reads add `child_pending` before they can describe every blocked job accurately.
- Signal and human list APIs stay separate because their payload, completion, attribution, and
  authorization contracts differ.
- The SQL implementation may continue sharing runtime states and dependency edges. Public meaning
  comes from the owning evidence table, not that shared storage.

## Rejected alternatives

### Model every mechanism as a wait

This would hide whether PostgreSQL needs a clock, an external payload, an operator decision, or a
job outcome. It would also make `Admin.getWait` return incompatible record shapes.

### Model dependencies as handler suspension

A dependency gate exists before the first handler activation. Calling it a suspension would imply
replay, attempt, and fence-token behavior that never occurred.

### Model child joins as ordinary dependencies

The SQL edge is useful for release policy, but the handler also owns a stable child name, request
fingerprint, result, and join record. Hiding those fields would make replay conflicts and lineage
impossible to explain.
