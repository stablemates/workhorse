# ADR 0121: Export a cold day after its snapshot frontier

- **Status:** Accepted
- **Date:** 2026-11-11
- **Issues:** SM-1928, SM-1959, SM-1978, SM-1979
- **Amends:** [ADR 0068](0068-export-cold-history-behind-the-rollup-watermark.md) (the export gate)
- **Related:** [ADR 0019](0019-derived-rolling-statistics.md),
  [ADR 0011](0011-daily-retention-and-split-maintenance.md)

## Context

Cold export copies each finished UTC day of history to an export store, and retention deletes a
day only after its export. ADR 0068 made a day exportable when the day had ended and the statistics
rollup had passed it.

A history row gets its time when it is written. `task_event.occurred_at` and
`attempt_history.occurred_at` default to `clock_timestamp()`, and the fast-tier functions write
`fast_task_outcome.finished_at` from a clock reading. Other sessions see the row only after its
transaction commits.

**Example.** An application enqueues a task in its own transaction at 23:59 UTC and commits at
00:10. At 00:03 the rollup has passed midnight, and an exporter claims, reads, and completes the
day. The `enqueued` event becomes visible at 00:10. It is below `exported_through` and in no export
object. When the event window ends, retention deletes the partition, and the export store never
gets the row (SM-1928).

The gate must therefore wait until no open transaction can still add a row to the day.

## Decision

### The claim waits for a snapshot frontier

`claim_cold_export_segment_v1` gives out a new day only after its snapshot frontier:

1. The claim reads `clock_timestamp()`, and then takes its transaction ID with
   `pg_current_xact_id()`. PostgreSQL gives out IDs in order, so each ID that it assigned before the
   clock reading is lower.
2. If the next day has no frontier, the claim records one in two new nullable columns of
   `cold_export_dataset`: `frontier_day_end` and `frontier_xid`. The clock reading must be at or after the end of the day plus
   `cold_export_frontier_margin_ms_v1()`. The transaction must also have had no ID before the claim.
3. The claim gives out the day only when `pg_snapshot_xmin(pg_current_snapshot())` is at or after
   `frontier_xid`. Each transaction with a lower ID has then ended. A prepared transaction keeps its
   ID in the snapshot until it is committed or rolled back, so it holds the day too.

The frontier is the claim's own new ID, not `pg_snapshot_xmax(pg_current_snapshot())`. The snapshot
`xmax` is the newest completed ID plus one. A transaction that got an ID before the snapshot and is
still running can have an ID at or above `xmax`. For example, a session's own snapshot showed `xmax=92189360`
while that session held ID 92189360. A gate `xmin >= xmax` could then open while that transaction
runs. A new ID is greater than every ID assigned before it.

A claim in a transaction that already has an ID records no frontier, because that ID can be older
than the clock reading. It can still give out a day whose frontier exists and has passed.
A stored frontier above the new ID of the claim cannot come from this server, for example after a
restore from a dump onto another server. The claim then records a new frontier, so the export does
not wait for the transaction counter to catch up.

A re-lease of an `exporting` segment passes the same frontier. A segment that is `exporting` when
migration 0096 runs was given out without a frontier. The migration fences it, as migration 0052
does: it increments `attempts` and clears the lease. A completion or failure from before the
migration then raises `not held by attempt`, and the next claim gives out the day again after its
frontier. The fence cannot stop an object or manifest upload that is already in flight. That upload
can write an earlier read of the day over the newer object. Thus the upgrade asks the step of
migration 0052. Stop every exporter, let its uploads finish, keep export enabled, and migrate. Then
start the exporters again.

The server clock decides when a frontier is recorded. `p_now` cannot,
because a frontier recorded at a time that `p_now` only claims proves nothing. The other `p_now`
gates stay. A frontier stays valid for its day, so a later claim, a re-enable, or a ledger repair
keeps it.

### The gate does not read `pg_stat_activity`

A gate on `pg_stat_activity.xact_start` and `backend_xid` sees the sessions of another role only
for a member of `pg_read_all_stats`. For other sessions, those columns are null, so that gate could
miss an open transaction. The snapshot frontier needs no privilege.

### A margin covers the clock reading before the ID

A column default reads the clock before PostgreSQL gives the inserting transaction its ID. If the
history insert is the first write of its transaction, the row reads its time first and gets its ID
later. A lock wait between the two steps makes the gap long. The leaf partition is opened when the
row is routed, after the default is computed.

The gap was proven with three sessions and a real `send_signal_v1` to a task that does not wait.
Session 1 held `ACCESS EXCLUSIVE` on the day partition. Session 2 had no transaction ID, read
`occurred_at = 23:53:09.964`, and then waited. Session 3 recorded the frontier at 23:53:10.998.
After session 1 committed, session 2 got an ID above the frontier and stayed open. A later snapshot
had `xmin` equal to the ID of session 2, so a gate on the frontier would have opened before the
row committed.

Two rules close the gap:

1. **A margin.** A frontier is recorded only `cold_export_frontier_margin_ms_v1()`, 60 s, after the
   end of the day. A row can then be missed only if more than 60 s pass between its clock reading
   and its transaction ID.
2. **An ID before the event.** In each Workhorse function, the transaction has an ID before it writes a history row. An earlier write or row lock gives it one. Three paths had no such write.
   `send_signal_v1` and `complete_human_wait_v1`, when no wait row exists, and
   `record_batch_event_v1` now call `pg_current_xact_id()` before their event insert. Each of those
   paths writes a row in the same call, so the call adds no write, no lock, and no change to the
   result. No claim, completion, or enqueue path needed this change.

The history column defaults do not change, because a function call in a default costs each history
insert.

### Limits that remain

- The export of a day starts at the earliest 60 s after the end of the day.
- A transaction in any database of the server that has a transaction ID delays the export of each
  day until it ends. A long write transaction, or a prepared transaction that nobody commits, holds
  the export. Retention waits for the export, so it holds the day too.
- A history row written outside the Workhorse functions can still be missed if its transaction has
  no earlier write. That needs more than 60 s between its clock reading and its transaction ID. That
  needs an external lock on a history leaf partition or a stalled backend.

### The exporter reads one snapshot

The exporter contract adds two rules. An exporter calls the claim in a transaction of its own. It
reads all pages of a day in one `REPEATABLE READ` transaction that starts after the claim, so each
page reads the same snapshot.

### The statistics rollup keeps its recompute window

The statistics rollup has the same cause (SM-1959). Each pass rewrites the last
`statistics_recompute_buckets` minutes, and a row whose transaction commits after that window has
passed its minute is not counted. The rollup keeps the window, and the documents state the limit.

This differs from cold export for two reasons. A statistics miss changes only an aggregate. The raw
row stays, task reads include it, and the export includes an event or attempt row. A missed export row
is lost when retention deletes its day. Also, a rollup that waits for open transactions would make
each pass rewrite more buckets for as long as a long transaction is open.

### Statistics retention keeps rows the next tier needs

A coarser statistics tier is built only from the finer rows that remain. After a stop of more than
two days, a catch-up pass wrote minute rows older than their retention. The hour tier used them only
up to the last complete hour of the pass. The same pass then deleted the rest, and the hour and
day tiers lost those counts (SM-1978). Statistics retention now keeps each minute row at or after
`hourly_rolled_up_through`, and each hour row at or after `daily_rolled_up_through`. It also keeps
the hour and the day that the next pass rebuilds from the start of its recompute window. It keeps the
minute rows from the hour that holds `rolled_up_through` minus `statistics_recompute_buckets`
minutes. It keeps the hour rows from the day that holds that hour. Without that bound, a pass that ended at
H:01 let retention delete the minute rows of the hour before H. The next pass then rebuilt that hour
from two minutes.

The other way, ending a catch-up pass at an hour boundary, changes the range of each pass. The
retention rule states the invariant directly: no row is deleted before the next pass stops reading
it. It holds for any pass size, and in a normal pass it deletes the same rows.

### A held retention pass stays due

`retain_history_v1` judged completion against the cutoffs after the rollup and export clamps. Thus a
held pass recorded `succeeded` and waited for the next local date (SM-1979). It now judges
completion against the policy cutoffs. A held pass records `incomplete` and runs again on the next
offer. Health dates the pass from `last_started_at`, so a held pass adds no false due lag.

A day that the export frontier holds can also hold retention. In normal operation the frontier
holds a day for minutes, and the retention cutoff is days back, so the clamp does not bind.

## Consequences

- Each committed row of an exported day is in the export store, within the limits above.
- An exporter can get no day on a call after midnight, and it calls the claim again later.
- `exportableThrough` in the status reports the rollup and day gate only. It does not include the
  frontier.
- A held retention pass records one `incomplete` run on each offer. `maintenance_run` keeps 50 runs
  for each routine, so a long hold replaces the older runs of the routine.
- Migration 0096 adds the two columns and `cold_export_frontier_margin_ms_v1`, fences each
  `exporting` segment, and replaces the bodies of six functions. Each function keeps its name, its arguments, and its result type under
  ADR 0109.
