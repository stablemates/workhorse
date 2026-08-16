# How do I replace work while updates keep arriving?

A search indexer does not need to process every edit separately. It needs one pending job with the
latest document, scheduled after edits settle down.

Keyed debounce keeps that pending job in PostgreSQL. A repeated key replaces its accepted payload
while the job is still waiting. The database serializes concurrent replacements, so callers share
one stable job identity.

## Reset or preserve the schedule

Choose `reset` when every replacement should start a fresh quiet period. Choose `preserve` when the
first request should fix the run time and later requests should only update the payload.

```ts
const result = await queue.enqueueWithResult(
  "search.reindex",
  { documentId, revision },
  {
    debounce: {
      key: documentId,
      scope: "search-index",
      windowMs: quietPeriodMs,
      schedule: "reset",
    },
  },
);
```

`enqueueWithResult` returns the stable `jobId` and an `outcome`. A new pending job is `accepted`.
A pending replacement is `replaced`.

## Replacement stops when processing starts

Only a `scheduled` or `ready` job can be replaced. If a worker owns the job, or the job is already
terminal, the outcome is `non_replaceable`. Workhorse discards the new request's payload and
returns the retained job's stable `jobId`, while its accepted payload stays unchanged.

If the window elapses before promotion runs, Workhorse also refuses replacement. This prevents a
late request from creating a second live job beside overdue work. After an operator purges the old
identity, the same key can accept a fresh job.

Debounce and [enqueue idempotency](210-enqueue-idempotency.md) solve different problems. Idempotency
replays an equivalent request and rejects a changed one. Debounce deliberately accepts changed
payloads while one job remains pending, so one request cannot enable both options.

A debounced job cannot declare `prerequisiteJobId` or `dependencies`. Replacement changes the
accepted job, but dependency edges must stay stable after acceptance. Use a regular
[dependent job](160-job-dependencies.md) when dispatch must wait for other work.

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — replaying an identical request safely
- [220-schedules.md](220-schedules.md) — recurring work from calendar rules
- [010-jobs-and-state.md](010-jobs-and-state.md) — the states that decide replacement eligibility

---

Exact SQL functions, limits, outcomes, and lifecycle events:
[`architecture.md`](../architecture.md#keyed-debounce).
