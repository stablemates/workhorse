# How do I know the queue is healthy?

You can watch dashboards all day, or you can ask the queue directly. `Queue.health()` returns
one snapshot with everything an operator would ask about — backlog depths, lease state,
retention progress, admission pressure — plus a verdict: healthy, degraded, or critical, with
a machine-readable reason for every budget the queue has exceeded.

## One statement, one instant

A health report assembled from many separate queries can contradict itself. If the expired-lease
count runs first and the state counts run a moment later, a recovery pass in between makes the
report claim an expired lease that no longer exists next to counts that already reflect its
recovery. Nothing is wrong, but the report says something is.

Workhorse avoids this by reading every correctness-sensitive value in a single SQL statement.
PostgreSQL gives one statement one consistent view of the database, so every count, depth, and
watermark in the snapshot describes the queue at the same instant. That instant is reported as
`capturedAt`.

## Facts versus observations

Not everything in the report can be a transactional fact. PostgreSQL also keeps its own running
statistics — table sizes, dead-row estimates, vacuum timestamps — and those are collected in the
background, so they lag reality by design. Pretending they are exact would be a lie.

The report keeps the two apart. Exact values live at the top level of `QueueHealth`. Everything
that comes from PostgreSQL's statistics machinery lives under `observations`, where lagging is
expected and documented. If a number under `observations` disagrees with an exact count, the
exact count wins.

## Bounded by design

A queue that has processed a hundred million jobs should not need to scan them all to say how it
feels. Live work is small by design, so live-state counts are exact. Terminal history is
unbounded, so its counts are size-capped: the snapshot counts exactly up to a limit, then stops
and marks the value as a lower bound with an explicit `capped` flag. The same treatment applies
to the statistics buckets. The result is a snapshot whose cost tracks live work, not lifetime
history.

## Budgets and reasons

Raw numbers ask the operator to know what normal looks like. Health budgets encode that
knowledge: each one says how far a value may drift before it counts as a problem, and each is
generous against its maintenance cadence so routine jitter never alerts.

When a budget is exceeded, the verdict carries a reason — a stable code plus the observed value
and the budget it broke. Codes split into two severities:

- **Critical** means work is stopping or being lost right now: an expired lease, a job past its
  deadline or execution timeout, due work that promotion is not picking up, or a missing daily
  history partition.
- **Degraded** means the queue still runs but something is falling behind: a stalled statistics
  rollup, late retention cleanup, history spilling into fallback storage, or ready work blocked
  by concurrency or rate-limit policies.

Because the codes are stable strings, automation can branch on them instead of parsing prose.
The `workhorse-health` command exits non-zero on any exceeded budget, the dashboard words the
same reasons for humans, and both read the identical evaluation — there is exactly one place
that decides what unhealthy means.

If the defaults don't fit a deployment, every budget can be overridden per call:

```ts
const health = await queue.health({ budgets: { rollupStalledLagMs: 5 * 60 * 1000 } });
if (health.status.level !== "healthy") {
  for (const reason of health.status.reasons) console.warn(reason.code, reason.observed);
}
```

## Next

- [320-statistics.md](320-statistics.md) — the rollup watermark that health watches
- [330-retention.md](330-retention.md) — the cleanup lag that health budgets
- [350-observability.md](350-observability.md) — exporting metrics instead of polling health

---

Exact fields, scan caps, budget defaults, and reason codes:
[`architecture.md`](../architecture.md#read-models-and-health).
