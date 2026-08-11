# Demo feature coverage

The demo turns the supported task lifecycle into eight discoverable feature families. Each family owns
exactly three idempotently seeded one-off scenarios and one namespaced recurring definition. This keeps the
dashboard populated with useful contrasts without pretending that every infrastructure capability is a job
outcome.

| Feature family           | Three startup scenarios                                                     | Recurring variation                                     |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Ingress and routing      | immediate tagged work, future delivery, idempotent acceptance               | success, retry/recovery, or terminal failure            |
| Retry policies           | fixed recovery, exponential recovery, jitter exhaustion                     | success, recovery, or exhausted retry budget            |
| Durable checkpoints      | single artifact, replay after retry, three-stage work                       | one to three checkpoints plus mixed outcomes            |
| Durable waits            | short cooldown, longer embargo, wait then retry                             | different wait durations plus mixed outcomes            |
| Progress                 | successful progress, progress through retry, progress before failure        | latest progress ending in success, recovery, or failure |
| Timing controls          | expired deadline, execution timeout, completion within both budgets         | varied execution duration and outcome                   |
| Cancellation             | ready cancellation, scheduled cancellation, cooperative active cancellation | success, cooperative cancellation, or failure           |
| Dead letters and redrive | terminal failure, successful redrive, idempotent redrive replay             | success, retry/recovery, or terminal failure            |

All recurring definitions fire once per minute. Their immutable job identity selects a stable variant for
that occurrence, so retries preserve one scenario while later occurrences naturally rotate through different
results. Schedule occurrence deduplication still guarantees one accepted job per definition and second.

## Coverage of the feature matrix

The eight families exercise immediate and delayed enqueue, tags, named queues, enqueue idempotency, all
persisted retry policies, recurring schedules, checkpoints, durable waits, progress, deadlines, execution
timeouts, cancellation, terminal outcomes, dead-letter queries, redrive lineage, and idempotent redrive.
Every task also remains available through cross-state listing and the merged lifecycle timeline.

Operational capabilities are demonstrated through their own surfaces rather than fabricated task failures:

- leases, heartbeats, fencing, recovery, worker concurrency, pause, and drain appear on Workers and System;
- queue pause, resume, purge, and statistics appear in the local operator controls;
- the `partner-api` queue consumes its initial queue and per-key token bursts, leaving a visible
  throttled backlog with a PostgreSQL-calculated next eligibility time; its dedicated worker drains
  that backlog only as tokens refill;
- retention, partition preparation, cleanup, and health remain deterministic on System;
- Drizzle transactional enqueue and generic dashboard embedding remain application-level proofs;
- indexes, notification hints, dedicated worker CLI behavior, bounds, and validation remain integration-test
  and benchmark concerns.

The catalog is declared in `demo/src/feature-showcase.ts`. Seed orchestration and the generic handler live in
`demo/src/app.ts`, while `demo/test/app.integration.test.ts` verifies the three-per-family invariant, schedule
sync, idempotent startup, redrive artifacts, and dashboard discoverability.
