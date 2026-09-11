# How do I replace work while updates keep arriving?

A search indexer does not need to process every edit separately. It needs one pending task with the
latest document, scheduled after edits settle down.

Keyed debounce keeps that pending task in PostgreSQL. A repeated key replaces its accepted payload
while the task is still waiting. The database serializes concurrent replacements, so callers share
one stable task identity.

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

`enqueueWithResult` returns the stable `taskId` and an `outcome`. A new pending task is `accepted`.
A pending replacement is `replaced`.

## Replacement stops when processing starts

Only a `scheduled` or `ready` task can be replaced. If a worker owns the task, or the task is already
terminal, the outcome is `non_replaceable`. Workhorse discards the new request's payload and
returns the retained task's stable `taskId`, while its accepted payload stays unchanged. The result's
`reason` distinguishes a task that is no longer pending, an incompatible key mode, and a pending task
whose window elapsed.

If the window elapses before promotion runs, Workhorse also refuses replacement. This prevents a
late request from creating a second live task beside overdue work. After an operator purges the old
identity, the same key can accept a fresh task.

Debounce and [enqueue idempotency](210-enqueue-idempotency.md) solve different problems. Idempotency
replays an equivalent request and rejects a changed one. Debounce deliberately accepts changed
payloads while one task remains pending, so one request cannot enable both options.

A debounced task cannot declare the deprecated `prerequisiteTaskId` or `dependencies`. Replacement changes the
accepted task, but dependency edges must stay stable after acceptance. Use a regular
[dependent task](160-task-dependencies.md) when dispatch must wait for other work.

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — replaying an identical request safely
- [220-schedules.md](220-schedules.md) — recurring work from calendar rules
- [010-tasks-and-state.md](010-tasks-and-state.md) — the states that decide replacement eligibility

---

Exact SQL functions, limits, outcomes, and lifecycle events:
[`architecture.md`](../architecture.md#keyed-debounce).
