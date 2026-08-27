# Demo feature coverage

The demo turns the supported task lifecycle into seventeen discoverable feature families. Each family
owns exactly three idempotently seeded one-off scenarios and one namespaced recurring definition. This
keeps the dashboard populated with useful contrasts without pretending that every infrastructure
capability is a job outcome.

| Feature family           | Task type                  | Three startup scenarios                                                     | Recurring variation                                     |
| ------------------------ | -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Ingress and routing      | `demo.ingress-routing`     | immediate tagged work, future delivery, idempotent acceptance               | success, retry/recovery, or terminal failure            |
| Retry policies           | `demo.retry-policy`        | fixed recovery, exponential recovery, jitter exhaustion                     | success, recovery, or exhausted retry budget            |
| Durable checkpoints      | `demo.durable-checkpoint`  | single artifact, replay after retry, three-stage work                       | one to three checkpoints plus mixed outcomes            |
| Durable waits            | `demo.durable-wait`        | short relative cooldown, absolute-target embargo, wait then retry           | different wait durations plus mixed outcomes            |
| Progress                 | `demo.progress-reporting`  | successful progress, progress through retry, progress before failure        | latest progress ending in success, recovery, or failure |
| Timing controls          | `demo.timing-control`      | expired deadline, execution timeout, completion within both budgets         | varied execution duration and outcome                   |
| Cancellation             | `demo.cancellation`        | ready cancellation, scheduled cancellation, cooperative active cancellation | success, cooperative cancellation, or failure           |
| Dead letters and redrive | `demo.dead-letter-redrive` | terminal failure, successful redrive, idempotent redrive replay             | success, retry/recovery, or terminal failure            |
| Job dependencies         | `demo.job-dependency`      | single prerequisite release, two-prerequisite fan-in, cancel on failure     | a fresh prerequisite-to-dependent chain per occurrence  |
| Child workflows          | `demo.child-workflow`      | one awaited child, three-child fan-out join, child retry before join        | one to three children joined by name                    |
| Signals                  | `demo.signal-wait`         | companion-task delivery, operator delivery, expiring unanswered             | delivered, operator-answerable, or expiring             |
| Human decisions          | `demo.human-decision`      | refund approval, publication sign-off, expiring review                      | operator-answerable or expiring decisions               |
| Keyed debounce           | `demo.keyed-debounce`      | trailing-window replacement, preserved run time, collapsed burst            | a driver returning both keyed dispositions as a result  |
| Keyed throttle           | `demo.keyed-throttle`      | repeat coalesced, batch burst coalesced, independent per-key lanes          | a driver returning the burst's dispositions as a result |
| Priority lanes           | `demo.priority-lane`       | expedited, standard, and bulk `enqueueMany` backfill                        | a driver enqueueing one trio across three priorities    |
| Batch handlers           | `demo.batch-digest`        | grouped digest, partial batch after linger, independent member failure      | one member joining whatever batch is forming            |
| Payload contracts        | `demo.contract-check`      | accepted under `v1`, result rejected at completion, payload rejection probe | accepted under `v1`                                     |

The seventeen definitions are staggered across a seventeen-minute cycle, one family per minute. Their
stable job identity selects a stable variant for that occurrence, so retries preserve one scenario
while later occurrences rotate through different results. Schedule occurrence deduplication still
guarantees one accepted job per definition and second.

## Coverage of the feature matrix

The seventeen families exercise immediate and delayed enqueue, tags, named queues, enqueue
idempotency, keyed debounce and throttle with their durable `enqueueWithResult` dispositions,
`enqueueMany` batch acceptance, priority, all persisted retry policies, recurring schedules,
checkpoints, relative and absolute durable waits, progress, deadlines, execution timeouts,
cancellation, job dependencies with terminal policies, child jobs with named join, external signals,
human wait tokens, batch handlers with independent settlement, payload and result contracts,
terminal outcomes, dead-letter queries, redrive lineage, and idempotent redrive. Every task also
remains available through cross-state listing and the merged lifecycle timeline.

External boundaries stay answerable from the dashboard: the seeded operator-handoff signal and both
pending human decisions wait a full day for a person, while every recurring occurrence of those
families expires on its own so unanswered boundaries never accumulate. The local operator menu can
also trigger a live redrive of the newest unredriven dead letter, complementing the pre-seeded
redrive lineage.

Built-in dashboard authentication is available as a documented toggle: setting
`WORKHORSE_DEMO_ADMIN_USERNAME` and `WORKHORSE_DEMO_ADMIN_PASSWORD_HASH` switches the demo host from
its default open access to the packaged single-administrator login.

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

The catalog is declared in `typescript/demo/src/feature-showcase.ts`. Seed orchestration lives in
`typescript/demo/src/app.ts`, the handlers in `typescript/demo/src/handlers.ts`, and the shared
contract options in `typescript/demo/src/contracts.ts`.
`typescript/demo/test/app.integration.test.ts` verifies the three-per-family invariant, schedule
sync, idempotent startup, redrive artifacts, and dashboard discoverability.
