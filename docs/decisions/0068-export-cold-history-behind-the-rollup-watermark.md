# ADR 0068: Export cold history behind the rollup watermark

- **Status:** Accepted
- **Date:** 2026-09-16
- **Related:** SM-23, [ADR 0011](0011-daily-retention-and-split-maintenance.md),
  [ADR 0019](0019-derived-rolling-statistics.md),
  [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
  [ADR 0054](0054-define-what-1-0-0-promises.md)

## Context

History retention deletes `task_event` and `attempt_history` by the UTC day, fourteen days back by
default. The rollup keeps summaries beyond that, but a summary cannot answer "what happened to task
X in March". Operators who need the raw rows for audit or offline analysis have had one option:
lengthen retention and let PostgreSQL hold everything, which is the wrong store for cold rows.

ADR 0011 deferred an optional cold export until a rollup watermark existed, so that export could
follow the same rule deletion follows. ADR 0019 shipped that watermark. This decision adds the
export behind it.

Two shapes were considered. A **worker routine** would export from every worker's maintenance
loop, the way retention runs. That puts object-storage credentials, network stalls, and provider
SDKs into every worker process, on the same connection pool as dispatch, for a job that has no
reason to run near dispatch at all. An **operator-run exporter** runs wherever the operator decides,
against a ledger PostgreSQL owns, and the only thing the worker fleet learns about it is that
retention waits. The second shape is chosen.

## Decision

**The unit of export is one UTC day of one dataset.** A segment is `(dataset, segment_start)` with
`segment_end` one day later, matching the history day partitions so retention and export agree on
boundaries. The two datasets are `task_event` and `attempt_history`. Statistics buckets are not
exported: they have their own retention, are cheap to keep for years, and can be derived from an
exported day if needed.

**A day is exportable once it is closed and rolled up.** `claim_cold_export_segment_v1` hands out
the next day only when its end is at or before both the start of the current UTC day and the minute
rollup watermark `task_stat_state.rolled_up_through`. The rollup is what makes deletion safe today,
so export precedes deletion by following the same gate. A rollup opted out with a zero interval
therefore holds export as well as retention.

**PostgreSQL owns the ledger.** `cold_export_policy` holds the on/off switch, `cold_export_dataset`
one exclusive, day-aligned `exported_through` watermark per dataset, and `cold_export_segment` one
row per day with its status, attempt count, lease, object key, manifest key, SHA-256 checksum,
byte length, row count, and last error. The watermark advances only across contiguous complete
days, so a gap in the ledger is impossible by construction.

**Completion is fenced by attempt number.** A claim increments `attempts` and takes a lease. A
lapsed lease lets another exporter claim the same day; the earlier exporter's completion then fails
because its attempt number no longer matches. This is the fence-token rule ADR 0011 relies on for
task attempts, applied to segments.

**Object names derive from the segment identity, and content is deterministic.** An exporter names the data object
`<prefix>/<dataset>/<YYYY>/<MM>/<DD>/<dataset>-<YYYY>-<MM>-<DD>.ndjson.gz` and the manifest sits
beside it as `.manifest.json`, reads rows through `read_cold_export_rows_v1` in `(occurred_at, id)`
order by keyset pages, serializes one JSON object per line from `to_jsonb`, and gzips. A retried
segment rewrites the same key with the same bytes, which is what makes resume idempotent without the
store having to be transactional. A day with no rows writes only a manifest.

**Checksums are recorded, encryption and access control are the store's.** An exporter computes
SHA-256 over the bytes as stored and records it in the manifest and the ledger. Workhorse never
holds a key or a credential: everything about the destination, encryption at rest, IAM, lifecycle,
and write-once enforcement, belongs to the store. Workhorse's own RBAC (P2-04) is not a prerequisite: turning export
on is an operator policy call with the same trust as the retention policy calls it sits beside.

**Export is a retention interlock only while it is enabled.** `retain_history_v1` already clamps its
cutoffs to the rollup watermark. While `cold_export_policy.enabled` is true it also clamps each
dataset's cutoff to that dataset's `exported_through`. An exporter that falls behind holds history
and surfaces as growing retention lag, exactly as a stalled rollup does. With export off nothing
changes and PostgreSQL-only operation is the default.

**Enabling starts from the oldest retained day, and the start never moves.** `set_cold_export_policy_v1`
seeds each dataset's watermark at the UTC day of its oldest retained row unless the operator names a
day, refuses to move a watermark once one exists, and on re-enabling advances a watermark that fell
below the oldest retained day, because retention deleted those days while export was off and they
cannot be exported any more.

**No exporter ships in the beta.** The SQL functions are the exporter contract, and they are in
every generated catalogue, so any language can drive them. Which package an exporter and its
object-storage providers belong in is a packaging decision this release does not make, so none
ships yet (SM-759, SM-760). Until then an operator who enables export supplies their own driver of
the four segment functions, and the guide says so.

**Restore is by loading, not by querying through.** The first version promises no transparent
hot/cold query from the dashboard or the operator API. The guide shows how to read an exported day
with DuckDB and how to `COPY` it into a scratch schema for a PostgreSQL query. Reading exports back
into the live `workhorse` schema is unsupported because retention would delete them again and
statistics would double count.

Everything ships additively under ADR 0053 and ADR 0054: three tables, seven functions, one
replaced function body, two `Queue` methods, and one log event name. The migration is
`sql/migrations/0004-cold-history-export.sql`, schema version 4, protocol version 4.

## Consequences

- An operator keeps raw history for as long as their object store keeps it, while PostgreSQL keeps
  the configured window, and retention cannot outrun the archive.
- Claims are serial per dataset: one day at a time, oldest first. Two datasets export in parallel.
  Parallel days can be added later because the watermark advances across contiguous complete days
  regardless of completion order.
- An exporter that stops, or export enabled with no exporter running, holds history. This surfaces
  as retention lag today; a named health reason and a dashboard panel are SM-761.
- No SDK ships an exporter. SM-759 and SM-760 wait on the packaging decision.
- Rows inserted into an already exported day through privileged SQL are not re-exported. The ledger
  keeps the exported row count so an audit can detect the difference.
