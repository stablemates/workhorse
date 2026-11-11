# ADR 0123: Give the expired-lease scan gate a floor

- **Status:** Accepted
- **Date:** 2026-11-11
- **Issues:** SM-1960
- **Related:** [ADR 0004](0004-two-cadence-maintenance.md),
  [ADR 0112](0112-define-the-poll-wait-order-and-the-worker-interval-range.md),
  [ADR 0109](0109-keep-a-function-suffix-when-a-body-change-stays-compatible.md)

## Context

`tick_v1` recovers expired leases of the full tier with a scan that reads every active row of
`task_runtime`. An index on `expires_at` would serve the scan, but each heartbeat would then lose
its HOT update, so the table has no such index. Since migration 0061, a tick skips the scan when
another tick ran it within half the shortest `maintenance_interval_ms` of the live registered
workers.

`worker_registry` accepts an interval of 100 ms or more. Thus one worker at 100 ms set a 50 ms gate
for the whole fleet. A measurement with many active leases showed that such a worker made the fleet
run the scan at the rate of its own ticks. Its ticks held the `workhorse:tick` lock for almost all
the time, and each tick of the other workers skipped on the lock. Workers at the default interval
of 1,000 ms ran the scan much less often on the same table. The measurement is in SM-1960.

## Decision

**The gate interval of the expired-lease scan is the shortest live `maintenance_interval_ms`, but
never less than 1,000 ms.**

1. 1,000 ms is the default maintenance interval of each SDK. A fleet at the default interval keeps
   its spacing of 500 ms, and a fleet whose shortest interval is longer keeps half that interval.
   Thus the floor never makes the scan run more often than before.
2. The floor is a constant in `tick_v1`, not a setting.
3. With no live registered worker, as for a direct `tick_v1` caller, every tick still runs the
   scan. The floor applies only to a gate that a live worker sets.
4. Only the scan gate gets the floor. A worker with a shorter interval still ticks at that
   interval. Each tick still promotes, recovers deadlines, attempt timeouts, and fast-tier leases,
   and drives the schedule evaluation of that worker.
5. Migration 0101 replaces the body of `tick_v1`. The signature and the result rows do not change,
   so the function keeps its suffix, as ADR 0109 permits.

## Consequences

- One worker cannot make the scan a continuous load on the database. The scan runs at most once in
  500 ms while a live worker is registered.
- A short interval no longer makes the full tier find an expired lease sooner than the floor
  permits. While registered workers tick, the first scan after an expiry waits at most 500 ms plus
  the interval of the fastest registered worker, if that interval is below 1,000 ms. A user who set
  a short interval for faster recovery gets a slower recovery. Each SDK changelog and the upgrade
  notes state this.
- The fast tier does not change, because it finds overdue leases through an index.
- A test drives `tick_v1` with a recorded scan time that it sets, so it does not depend on the
  speed of the host.

Rejected options:

- Keep the gate and document its effect. One worker could still turn the scan into a continuous
  load.
- Leave a worker below a documented minimum out of the `min()`. A worker at 999 ms would still
  set a 499.5 ms gate, and a fleet of only short-interval workers would have no gate at all.
- An index on `expires_at`. Each heartbeat would lose its HOT update.

[Task lifecycle: Maintenance cadence](../architecture/lifecycle.md#maintenance-cadence) owns the
current rule.
