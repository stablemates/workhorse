# Which health numbers can I compare safely?

`Queue.health()` separates queue truth from PostgreSQL observations. Use its exact snapshot when a
probe or operator decision depends on counts agreeing with each other.

## One snapshot describes one queue moment

A claim can move a job from ready to active while an observer is reading. Separate queries could
then count the old ready row and the new active row, even though both answers were individually
correct when PostgreSQL produced them.

`QueueHealth.snapshot` prevents that split. PostgreSQL reads its lifecycle counts and live pressure
from one statement snapshot. The shared `capturedAt` time also decides whether a lease, wait,
deadline, or execution timeout is overdue.

The snapshot includes terminal counts because operators often compare the complete lifecycle. Each
count stops at a fixed ceiling, so `cappedFields` identifies values that are lower bounds instead of
letting a health probe scan an unlimited backlog.

## PostgreSQL observations have another clock

Table size, estimated rows, vacuum activity, transaction age, lock waits, and notification usage
describe PostgreSQL around the snapshot. Some come from statistics that PostgreSQL flushes later,
and session activity can change during the health call.

Those fields live under `QueueHealth.postgresql`. Its `observedAt` time makes the weaker guarantee
visible, so an operator does not mistake an estimated row count for a transactional fact.

## Budgets turn pressure into stable reasons

`Queue.health()` evaluates exact pressure against default budgets. Applications can supply their
own tolerances for lease expiry, overdue waits, overdue timing boundaries, and ready age.

```ts
const health = await queue.health();

if (health.status.level === "degraded") {
  logger.warn({ reasons: health.status.reasons }, "Workhorse needs attention");
}
```

Each reason has a stable code plus the observed value and budget. Probes and alerts can branch on
that code while dashboards remain free to translate it into useful prose.

## Next

- [320-statistics.md](320-statistics.md) — how historical windows avoid raw scans
- [330-retention.md](330-retention.md) — why retained history affects health cost
- [350-observability.md](350-observability.md) — exporting database-wide gauges

---

Exact snapshot fields, budgets, codes, aliases, and query bounds:
[`architecture.md`](../architecture.md#read-models-and-health).
