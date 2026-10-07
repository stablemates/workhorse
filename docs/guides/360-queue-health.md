# How do I know the queue is healthy?

<!-- scenario-names: emails, billing, invoice-7 -->

You can watch dashboards all day, or you can ask the queue directly. `Queue.health()` returns one
snapshot with everything an operator would ask about: backlog depths, lease state, retention
progress, and admission pressure. It adds a verdict: healthy, degraded, or critical. Every budget
the queue has exceeded comes with a machine-readable reason.

## One statement, one instant

Imagine a health report built from two separate queries. Worker A crashed, and its lease on task
`invoice-7` has expired.

1. **At 0 ms** the report counts expired leases. It finds one: `invoice-7`.
2. **At 3 ms** recovery, the background pass that returns expired leases to the queue, puts
   `invoice-7` back in `ready`.
3. **At 5 ms** the report counts tasks by state. `invoice-7` now shows up as ready.

The report now claims an expired lease next to state counts that already include its recovery.
Nothing is wrong with the queue, but the report says something is.

Workhorse avoids this by reading every correctness-sensitive value in a single SQL statement.
PostgreSQL gives one statement one consistent view of the database. So every count, depth, and
watermark in the snapshot describes the queue at the same instant. The snapshot reports that
instant as `capturedAt`.

<details>
<summary>Reference: the snapshot function</summary>

`queue_health_v1(p_rejected_since timestamptz)` returns the snapshot. These SDK methods call it:

- TypeScript `Queue.health()`;
- Go `Queue.Health()`;
- Python `Queue.health()` and `AsyncQueue.health()`.

One MVCC snapshot covers the verified schema version, state counts, and dispatch depths. It also
covers dependency, child, deadline, timeout, promotion, concurrency, rate-limit, rollup, and
retention pressure.

| Field                  | Meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `capturedAt`           | PostgreSQL's transaction timestamp for the statement.              |
| `historyPartitionDays` | Whether each required daily history partition exists.              |
| `budgets`              | The thresholds PostgreSQL used for this snapshot's verdict.        |
| `observations`         | Statistics read after the snapshot. They are not exact. See below. |

`queue_health_v1` disables JIT for itself.

More detail: [Task lifecycle: Health snapshot](../architecture/lifecycle.md#health-snapshot).

</details>

## Facts versus observations

Not everything in the report can be a transactional fact. Suppose retention has just deleted a
large batch of old rows. The exact counts in the snapshot drop at once. PostgreSQL's own estimate of
dead rows in that table still shows the old value. It changes only after the statistics collector
flushes.

PostgreSQL keeps those running statistics in the background, so table sizes, dead-row estimates,
and vacuum timestamps lag reality by design. Pretending they are exact would be a lie.

So the report keeps the two apart. Exact values live at the top level of `QueueHealth`. Everything
that comes from PostgreSQL's statistics lives under `observations`, where lagging is expected. If a
number under `observations` disagrees with an exact count, the exact count wins.

<details>
<summary>Reference: observations</summary>

`QueueHealth.observations` holds:

- per-relation size and tuple statistics from `pg_stat_user_tables`, summed across
  `pg_partition_tree`;
- `oldestTransactionAgeMs` and `lockWaitCount` from `pg_stat_activity`;
- `pg_notification_queue_usage()`.

`queue_health_v1` reads them after the correctness snapshot, in the same function call. They may lag
until the statistics collector flushes.

More detail: [Task lifecycle: Observations](../architecture/lifecycle.md#observations).

</details>

## Bounded by design

A queue `emails` has run for two years. It has millions of succeeded tasks in its history, and a
few hundred live tasks. A health poll should not need to scan every old task to say how the queue
feels.

So the snapshot counts the live tasks exactly. It counts succeeded tasks only up to a limit, then
stops. It reports the limit as a lower bound and sets `terminalCountsCapped`. The statistics bucket
count gets the same treatment. The cost of the snapshot tracks live work, not lifetime history.

Rejected signal deliveries and human decisions describe a recent rolling window instead of all
retained history. The window keeps this operational signal relevant. It also lets a partial index
skip unrelated lifecycle events during every health poll.

<details>
<summary>Reference: scan caps and windows</summary>

| Value                                  | Bound                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Live-state counts and depths           | Exact. Read from `task_runtime`.                                             |
| Terminal state counts (`task_outcome`) | Exact up to `HEALTH_HISTORY_SCAN_LIMIT` (100,000). `terminalCountsCapped`.   |
| `task_stat_bucket` count               | Exact up to 100,000. `statistics.bucketsCapped`.                             |
| `externalWaits` pending and rejected   | Exact up to 10,000 each. `externalWaits.capped`.                             |
| Default history partition rows         | Exact through 10,000. `defaultHistoryRowsCapped` marks 10,001 a lower bound. |

A capped value is a lower bound that is exact until the cap.

**Rejected deliveries.** `externalWaits.rejectedDeliveries` counts `signal_rejected` and
`human_wait_rejected` events since `p_rejected_since`. The SDKs pass
`EXTERNAL_WAIT_REJECTION_WINDOW_MS` (86,400,000 ms, 24 hours) before now. The SQL default is also
one day. The partial index `task_event_rejected_delivery_idx` covers only those two event types.

More detail: [Task lifecycle: Snapshot cost](../architecture/lifecycle.md#snapshot-cost), [Task lifecycle: External wait health](../architecture/lifecycle.md#external-wait-health), and [Task lifecycle: Retention health](../architecture/lifecycle.md#retention-health).

</details>

## Budgets and reasons

Suppose every worker on queue `billing` stops after a bad deploy.

1. **Soon after** the stop, scheduled tasks fall due, but no worker runs promotion, the regular
   background pass that moves due tasks to `ready`.
2. **Once the oldest due task waits longer than its budget,** the verdict turns `critical`. It
   carries the reason `stalled-promotion`, with the observed age and the budget it broke.
3. **At the same time,** the leases of tasks that were running when the workers stopped expire. No
   worker runs recovery either, so a second critical reason, `expired-leases`, appears beside the
   first.

Raw numbers ask the operator to know what normal looks like. Health budgets encode that knowledge.
Each one says how far a value may drift before it counts as a problem. Each is generous against its
maintenance cadence, so routine jitter does not alert.

Each reason is a stable code plus the observed value and the budget it broke. Codes split into two
severities:

- **Critical** means work is stopping or being lost right now. Examples include an expired lease, an
  overdue external wait, stalled promotion, or missing daily history storage.
- **Degraded** means the queue still runs but something is falling behind. Examples include a
  stalled statistics rollup, late retention cleanup, terminal cleanup that cannot keep pace, history
  spilling into fallback storage, or ready work blocked by concurrency or rate-limit policies.

Because the codes are stable strings, automation can branch on them instead of parsing prose. The
`workhorse health --json` command exits non-zero when any budget is exceeded.

```ts
const health = await queue.health();
if (health.status.level !== "healthy") {
  for (const reason of health.status.reasons) {
    console.warn(reason.code, reason.observed, reason.budget);
  }
}
```

<details>
<summary>Reference: verdict and reason codes</summary>

`evaluate_queue_health_v1(snapshot, policy)` produces `status.level` and `status.reasons`.

- `level` is `critical` if any reason is critical, `degraded` if any reason exists, else `healthy`.
- Each reason is `{ code, severity, observed, budget }`.
- Queue admission codes add `queue`. `budget-blocked` adds `budgetName`. `retention-lag` adds
  `category`.

| Code                          | Severity | Raised when                                                             |
| ----------------------------- | -------- | ----------------------------------------------------------------------- |
| `expired-leases`              | critical | Any lease has expired.                                                  |
| `overdue-deadlines`           | critical | Any deadline is overdue.                                                |
| `overdue-execution-timeouts`  | critical | Any execution timeout is overdue.                                       |
| `overdue-external-waits`      | critical | Any signal or human wait is past its deadline.                          |
| `stalled-promotion`           | critical | The oldest due scheduled runtime exceeds `promotionLagMs`.              |
| `missing-history-partitions`  | critical | A partition side is absent for the current day or the three days after. |
| `rollup-stalled`              | degraded | Rollup lag exceeds `rollupStalledLagMs`.                                |
| `retention-lag`               | degraded | A retention category's cleanup lag exceeds its budget.                  |
| `terminal-cleanup-backlog`    | degraded | A terminal cleanup backlog has lasted longer than `rowRetentionLagMs`.  |
| `eligible-history-partitions` | degraded | Fully eligible event and attempt partitions exceed the budget.          |
| `default-history-rows`        | degraded | Any row sits in a default history partition.                            |
| `concurrency-blocked`         | degraded | A concurrency policy holds ready tasks back.                            |
| `rate-limit-throttled`        | degraded | A rate limit holds ready tasks back.                                    |
| `budget-blocked`              | degraded | A shared budget holds ready tasks back.                                 |

**CLI.** `workhorse health --json` writes the same `QueueHealth` object. `workhorse health` exits 2
when the level is not `healthy`, with or without `--json`.

More detail: [Task lifecycle: Health verdict](../architecture/lifecycle.md#health-verdict).

</details>

## The database owns the budgets

The database owns the budgets, so every SDK and dashboard backend receives the same verdict.

Suppose an operator raises the promotion budget for a slow staging cluster.

1. The operator overrides `promotion_lag_ms`. PostgreSQL records the override.
2. Later, the application syncs its own defaults. PostgreSQL stores them as application defaults
   but keeps the operator's value in force.
3. The next snapshot's `budgets` field shows the operator's value, because PostgreSQL used it.

An application sync records defaults, while operator overrides survive later syncs. The `budgets`
field lets automation explain a reason without guessing which process supplied its threshold.

<details>
<summary>Reference: health policy</summary>

`queue_health_policy` is a single row keyed by `singleton`.

| Column                        | Default                  | `QueueHealth.budgets` field |
| ----------------------------- | ------------------------ | --------------------------- |
| `promotion_lag_ms`            | 10,000 milliseconds      | `promotionLagMs`            |
| `rollup_stalled_lag_ms`       | 1,800,000 milliseconds   | `rollupStalledLagMs`        |
| `row_retention_lag_ms`        | 21,600,000 milliseconds  | `rowRetentionLagMs`         |
| `partition_retention_lag_ms`  | 172,800,000 milliseconds | `partitionRetentionLagMs`   |
| `eligible_history_partitions` | 2 partitions             | `eligibleHistoryPartitions` |

| Function                          | Behavior                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `sync_queue_health_policy_v1`     | Seeds application values without replacing overrides unless `p_force` is true. |
| `override_queue_health_policy_v1` | Accepts named non-negative integer values.                                     |
| `revert_queue_health_policy_v1`   | Restores named application defaults.                                           |
| `get_queue_health_policy_v1`      | Returns the policy row.                                                        |

`operator_overrides` records which values an operator set. Callers cannot supply per-call
thresholds.

More detail: [Task lifecycle: Health policy](../architecture/lifecycle.md#health-policy).

</details>

## Health on the dashboard

Go back to the `billing` incident.

1. **During the incident** an operator opens the dashboard's System page. The failing promotion
   check appears first, with resolution advice. The passing checks stay visible below it.
2. **A minute later** the operator switches the time range to the last hour. The Activity over time
   section redraws, and the health checks refresh to a new snapshot.

Every check is listed with its own status. Critical and degraded checks appear first, with
resolution advice.

Some checks show a neutral operating state instead of a failure. Rate limits show "Throttling" when
ready tasks wait for tokens. Concurrency limits and shared budgets show "Limiting" when they hold
ready tasks back. The dashboard does not display an aggregate verdict. The underlying
`QueueHealth.status` still carries the database's evaluation.

The time range controls the separate Activity over time section. That section labels
[statistics](320-statistics.md) as "Full + fast tiers". Health checks and Current operations show
the latest snapshot. Changing the range also refreshes that snapshot.

<details>
<summary>Reference: System page health</summary>

- `DashboardSystemPage.status` carries `level` and the raw reasons.
- The SPA lists all 14 reason-code checks through `systemHealthChecks`, including passing checks.
- It labels `rate-limit-throttled` as `Throttling`. It labels `concurrency-blocked` and
  `budget-blocked` as `Limiting`. Their protocol severity does not change.
- It does not display `status.level` or add thresholds.
- `dashboard_system_v1` calls `queue_health_v1()` once per invocation. Its `window` is `15m`, `1h`,
  or `24h`.
- Health checks carry a `Now` label. External-wait rejected deliveries keep their trailing-day
  scope whatever the window.

More detail: [Task lifecycle: System page](../architecture/lifecycle.md#system-page) and [Dashboard: System page](../architecture/dashboard.md#system-page).

</details>

## Next

- [320-statistics.md](320-statistics.md) — the rollup watermark that health watches
- [330-retention.md](330-retention.md) — the cleanup lag that health budgets
- [355-observability.md](355-observability.md) — exporting metrics instead of polling health

---

Exact fields, scan caps, budget defaults, and reason codes:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#read-models-and-health).
