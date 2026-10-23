# ADR 0108: Keep an operator pause after a registry prune

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** [ADR 0017](0017-durable-worker-registry.md)
- **Issue:** SM-1646

## Context

ADR 0017 makes an operator pause process-scoped. `register_worker_v1` keeps `paused` while the same
`instance_id` refreshes, and clears it when a new instance takes over the worker ID. ADR 0017 also
lets `prune_worker_registry_v1` remove the row of a worker that stopped refreshing.

These two rules conflict when a live instance misses its refreshes for a short time.

**Example.**

1. An operator pauses worker instance `w1`.
2. A network partition stops `w1` from refreshing for 70 seconds.
3. Maintenance prunes the stale row of `w1` after one minute.
4. `w1` registers again. `register_worker_v1` inserts a new row with `paused = false`.
5. `w1` claims tasks again. No operator ended the pause, and no log line records the change.

The same instance is still running, so ADR 0017 requires that it keeps its pause. The prune removed
the only record of the pause.

A second defect makes this more frequent. The prune age is one minute for each row. A worker with a
`registry_interval_ms` above one minute can lose its row between two healthy refreshes.

## Decision

Maintenance keeps the pause of a pruned paused row in `workhorse.worker_pause_tombstone`. The kept
pause belongs to one `instance_id`.

1. `prune_worker_registry_v1` copies the pause and its attribution into the table, in the same
   statement that deletes the row.
2. If the same instance registers again before the kept pause expires, `register_worker_v1` restores
   the pause. A new instance removes the kept pause and starts running, as ADR 0017 requires.
3. An operator resume removes the kept pause. A deregistration of the instance removes it too,
   because the instance ends.
4. The kept pause expires after one day or three registration intervals of the pruned row, whichever
   is longer. The prune removes the expired kept pauses in the same maintenance phase.
5. `prune_worker_registry_v1` keeps each row for at least three of its own registration intervals.

The expiry uses the interval that the row reports, so it needs no new setting. One day is the
default `p_max_age` of `prune_worker_registry_v1`.

Only an operator, the end of the instance, or the expiry ends a pause. The expiry bounds the table.
It applies only to an instance that stays away for one day, or for three of its registration
intervals if that is longer.

Registration, resume, deregistration, and pruning of one worker ID take one transaction advisory
lock. Without it, a resume could miss the uncommitted row of a registration that restores a kept
pause, and the worker would stay paused. Pruning only tries the lock and skips a busy worker ID, so
it cannot deadlock.

## Alternatives

A longer prune age was considered and rejected. It still loses the pause after the longer age, and
it keeps dead workers visible in the fleet view for longer.

A pause keyed by worker ID was rejected for the reason that ADR 0017 gives. It would idle a
replacement process after a later deployment.

## Consequences

- A partition or a failover longer than the prune age no longer ends an operator pause.
- `admin resume-worker` on a pruned worker ends the kept pause. It still reports that the worker is
  not registered, because no row exists to report.
- The fleet view does not show a kept pause. The worker shows again, paused, when it registers.
- A prune can skip a stale row whose worker ID is locked at that time. A later prune removes it.
- The schema floor does not change. Every SDK reads the restored pause from the return value of
  `register_worker_v1`.
