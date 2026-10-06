# How do I keep history longer than PostgreSQL should hold it?

<!-- scenario-names: archiver-1, archiver-2 -->

Retention deletes events and attempts after a bounded window. That suits a database whose job is
dispatch. It does not suit an auditor who asks in March what happened to a task in January. Cold
export answers that question without stretching retention. Workhorse copies each finished day of
history to a store you own, and only then lets retention delete it.

Export is off by default. With it off, nothing in this guide runs and Workhorse remains
PostgreSQL-only.

## A day is the unit

You turned export on, and an exporter process named `archiver-1` runs every hour. Follow the history
your tasks wrote on 14 September.

1. **During 14 September (UTC).** Tasks run and fail and retry. Workhorse writes their events to
   `task_event` and their closed attempts to `attempt_history`.
2. **At midnight UTC.** The day closes. It cannot be exported yet. The statistics rollup, the
   background pass that summarizes history, has not passed the day yet.
3. **A few minutes later.** The rollup passes midnight. The day is now exportable.
4. **At the next run.** `archiver-1` claims the 14 September segment of `task_event`. It reads the
   day's rows and writes one compressed file of JSON lines. Beside it, it writes a small manifest.
   Then it marks the segment complete.
5. **When the retention window ends.** Retention may now delete 14 September from PostgreSQL. The
   archive still holds it.

Each day of each history relation becomes one segment. A segment is one compressed file with one
row per event or attempt, every column kept. Its manifest records the row count, the byte length,
and a checksum of the file as stored. A day with no rows gets only the manifest.

A [fast-tier queue](305-fast-tier.md) writes little history. Export therefore treats its outcome
rows as a third relation, `fast_task_outcome`. Workhorse groups those rows by the day each task
finished.

Workhorse exports a day only after the day closed and the rollup passed it. The rollup watermark
already decides when deletion is safe. Export follows the same rule, so it always runs ahead of
deletion. See [320-statistics.md](320-statistics.md).

<details>
<summary>Reference: datasets and the export gate</summary>

**Datasets.** `ColdExportDataset` is `"task_event" | "attempt_history" | "fast_task_outcome"`.

| Dataset             | Row order                   | Day of a row             |
| ------------------- | --------------------------- | ------------------------ |
| `task_event`        | `(occurred_at, event_id)`   | UTC day of `occurred_at` |
| `attempt_history`   | `(occurred_at, attempt_id)` | UTC day of `occurred_at` |
| `fast_task_outcome` | `(finished_at, task_id)`    | UTC day of `finished_at` |

**Segment.** One `cold_export_segment` row per `(dataset, segment_start)`. `segment_start` is a UTC
midnight, and `segment_end` is exactly 86,400 seconds later.

**Gate.** `cold_export_exportable_through_internal_v1(p_now)` returns the newest day boundary a
segment may end at:

| Gate expression                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LEAST(date_bin('1 day', rolled_up_through, timestamp '2000-01-01' AT TIME ZONE 'UTC'), date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`, reading `rolled_up_through` from `task_stat_state` |

A rollup turned off holds export as well as retention.

**Object.** One gzipped JSON-lines object per day. Each line is the `to_jsonb` of one source row. A
day with no rows completes with a null object key and a manifest only.

More detail: [Data model: Export gate](../architecture/data-model.md#export-gate), [Data model: Tables](../architecture/data-model.md#tables), and [Data model: UTC bin origin](../architecture/data-model.md#utc-bin-origin).

</details>

## The ledger lives in PostgreSQL

Suppose `archiver-1` stops on 20 September, because its host was retired and nobody moved it.

1. **On 20 September.** The last complete segment of `task_event` is 19 September. The watermark,
   the start of the oldest day not yet exported, is 20 September.
2. **Over the next days.** New days close, but nobody exports them. The watermark stays at
   20 September.
3. **When 20 September leaves the retention window.** Retention would delete the day, but the
   watermark is not past it. Retention keeps the day.
4. **Every day after.** Retention holds one more day. The retention lag in
   [queue health](360-queue-health.md) grows, and that is how you notice.

Workhorse records every segment in its own schema: which day, whether it is complete, which exporter
holds it, the object name, the checksum, and any error. It also keeps one watermark per relation.
The watermark advances only across contiguous complete days, so it can never skip a hole.

That ledger is the interlock. While export is enabled, history retention does not delete a day at or
above the watermark. An exporter that stops holds history rather than leaving the archive
incomplete.

<details>
<summary>Reference: ledger and retention clamp</summary>

| Table                 | Holds                                                                        |
| --------------------- | ---------------------------------------------------------------------------- |
| `cold_export_policy`  | A singleton `enabled` flag, false on a clean install.                        |
| `cold_export_dataset` | One row per dataset with an exclusive, UTC-midnight `exported_through`.      |
| `cold_export_segment` | One row per segment: status, attempts, lease, keys, checksum, counts, error. |

`status` is `exporting` or `complete`. `checksum_sha256` is 64 hex characters. `object_key` and
`manifest_key` hold at most 1,024 bytes each.

**Clamp.** While `cold_export_policy.enabled` is true:

- `retain_history_v1` clamps its event and attempt cutoffs to the matching `exported_through`, after
  the rollup clamp.
- `prune_terminal_tasks_v1` clamps its fast-tier history cutoff to the `fast_task_outcome`
  watermark.
- A missing dataset row clamps to `2000-01-01 UTC`, so nothing is deleted.

With export off, the clamp is skipped and every other retention rule is unchanged.

**Health.** Queue health computes retention lag from the retention windows, not the clamp. Held
history therefore raises the degraded reasons `retention-lag` and `eligible-history-partitions`.

More detail: [Data model: Retention clamp](../architecture/data-model.md#retention-clamp) and [Data model: Tables](../architecture/data-model.md#tables).

</details>

## Resume is free

`archiver-1` claims 14 September with a one-hour lease and starts the upload. Halfway through, its
process crashes.

1. **At 0 min.** The claim opens the segment with attempt 1 and leases it to `archiver-1`.
2. **At 20 min.** `archiver-1` crashes. Part of the object may already be in the store.
3. **At 60 min.** The lease lapses. Until then, no other exporter can claim this relation.
4. **At 70 min.** `archiver-2` claims. It gets the same day with attempt 2. It writes the object again
   under the same name, with the same bytes, and completes the segment as attempt 2.
5. **At 90 min.** `archiver-1` restarts and tries to complete the segment as attempt 1. The ledger
   refuses, because attempt 2 now holds the day.

The same day always produces the same object. The object name comes from the segment identity, and
rows are read in a fixed order. So a second export overwrites a partial upload with the full one.
Nothing about the store needs to be transactional.

A crash cannot corrupt the ledger either. Each claim leases the day and counts the attempt. Only the
attempt that holds the lease can mark the day complete. An exporter that fails cleanly reports the
failure, which releases the lease at once, so the next claim hands out the same day again.

<details>
<summary>Reference: segment functions</summary>

**`claim_cold_export_segment_v1(p_dataset, p_exporter_id, p_lease_ms, p_now)`** returns nothing
when:

1. export is off;
2. another exporter holds an unexpired lease on this dataset;
3. the next day ends after the gate.

Otherwise it re-leases an `exporting` row whose lease lapsed and increments `attempts`. Failing
that, it opens the day at `exported_through` with `attempts` 1. Claims are serial per dataset.

| Argument        | Rule                        |
| --------------- | --------------------------- |
| `p_exporter_id` | 1 through 256 bytes         |
| `p_lease_ms`    | 1,000 through 86,400,000 ms |
| `p_dataset`     | One of the three datasets   |

**`read_cold_export_rows_v1(p_dataset, p_from, p_to, p_after_occurred_at, p_after_id, p_limit)`**
returns `(occurred_at, row_id, record)` pages of 1 through 100,000 rows in keyset order.

**`complete_cold_export_segment_v1(...)`** raises `not held by attempt` unless the row is `exporting`
at exactly `p_attempts`. It marks the row complete, advances `exported_through` across every
contiguous complete day, and returns the new watermark.

**`fail_cold_export_segment_v1(p_dataset, p_segment_start, p_attempts, p_error)`** clears the lease
and stores `last_error` under the same fence.

More detail: [Data model: Segment functions](../architecture/data-model.md#segment-functions) and [Data model: Tables](../architecture/data-model.md#tables).

</details>

## A day is a UTC day

An exporter session uses the time zone `America/New_York`. On 8 March 2026, New York moves its
clocks forward an hour. Earlier releases handled that day like this:

1. **The claim.** The segment starts at 8 March 00:00 UTC. The claim added one calendar day in the
   session time zone. The segment therefore ended at 8 March 23:00 UTC, an hour short.
2. **The next claim.** The next segment started at 8 March 23:00 UTC, off midnight. Its UTC date was
   also 8 March, so it had the same object name.
3. **The upload.** The exporter wrote the second segment under that name. It overwrote the object of
   the first, and the archive lost most of 8 March.

A day that turns the clocks back made a segment an hour too long instead. Either way, later
segments started off midnight.

A segment now always starts at a UTC midnight and lasts one UTC day, whatever the session time
zone.

The schema upgrade that adds this rule repairs a damaged ledger. Before you run it, stop every
exporter and let each finish its object and manifest uploads. Keep export enabled, so retention
still waits for the export. The repair fences an earlier exporter out of the ledger. It cannot stop
an upload already in flight, and that upload would overwrite the corrected day's object with the
old range.

The upgrade first waits for any running retention pass, and no pass deletes history until the
repair commits. A pass that read the old watermark therefore cannot delete history the repair
wants to export again. An exporter that claims or completes a day during the upgrade waits for it
too.

When a relation lost a completed day to a short or long segment, Workhorse moves its watermark back.
It goes to the first day that segment may have overwritten. The exporter then writes those days
again. Retention reads the watermark, so it keeps those days until the export has copied them.

Each damaged segment is then made one UTC day:

- A segment that starts at a UTC midnight and lies at or after the new watermark becomes one UTC day
  and is exported again. Its attempt count rises, so the exporter that held it before cannot
  complete it.
- Any other segment that is not one UTC day is dropped. Its object stays in your store, but the
  ledger no longer names it.

The upgrade raises a warning per relation with the count and the range of each kind of change.

The rewind reaches only history that PostgreSQL still holds. Retention may already have removed
some of those days. The watermark then stops at the oldest day still present. A second warning
names the days that cannot be written again. Treat their archive objects as suspect, and restore
them from another copy if you have one.

Retention can also remove part of a day. The fast tier prunes outcomes one row at a time, so a day
it already archived may keep only some of its rows. Exporting that day again would overwrite a
complete object with a smaller one. The rewind therefore also stops after the last completed day
whose source now holds fewer rows than its archive object recorded. Those days keep their objects,
and the same warning names them.

<details>
<summary>Reference: the UTC-day repair (migration 0052)</summary>

**Constraints since migration 0052**

- `cold_export_dataset_utc_midnight_check` holds `exported_through` at a UTC midnight.
- `cold_export_segment_utc_day_check` holds `segment_start` at a UTC midnight and a segment to
  exactly 86,400 seconds.
- A claim ends a day a fixed `interval '24 hours'` after its start.

**Locks, in order**

1. The advisory transaction locks `workhorse:maintenance:history-retention` and
   `workhorse:maintenance:terminal-storage`. `retain_history_v1` and `prune_terminal_storage_v1`
   skip while they are held.
2. The `cold_export_policy` row, `FOR UPDATE`.
3. `ACCESS EXCLUSIVE` on `cold_export_dataset` and `cold_export_segment`.

**Repair.** A dataset is damaged when it has a `complete` row off a UTC midnight or not 86,400
seconds long. For each damaged dataset:

1. `exported_through` rewinds to the UTC midnight of the earliest such `segment_start`. It never
   goes below `cold_export_oldest_history_day_internal_v1`.
2. The rewind moves past every `complete` row whose `row_count` exceeds the rows its range now
   holds.
3. A warning names the days it cannot re-export.
4. A damaged `complete` row at a UTC midnight on or after the rewound watermark returns to
   `exporting`, one day long, with `attempts` incremented. Its exporter, lease, keys, checksum,
   counts, error, and `completed_at` are cleared.
5. Every other row off a UTC midnight, or `complete` and not one day long, is deleted. A warning
   gives the counts and the range.
6. The rewound watermark steps over any `complete` row at it.
7. An `exporting` row at a UTC midnight is extended to one day, with `attempts` incremented and its
   lease cleared.

Any other watermark is rounded down to its UTC midnight.

More detail: [Data model: Migration 0052 repair](../architecture/data-model.md#migration-0052-repair) and [Data model: Segment functions](../architecture/data-model.md#segment-functions).

</details>

## Running an exporter

Go back to `archiver-1`. An operator enables export just before its first run.

1. **At once** retention starts to wait for the export watermark.
2. **At the hourly run** `archiver-1` claims the oldest day not yet exported. It reads the day,
   writes the object and its manifest, and completes the segment.
3. **Suppose the store refuses the write.** `archiver-1` reports the failure. Its next claim gets
   the same day again.

The exporter is not a worker routine. Workers never talk to your object store, and dispatch never
waits for an export. Workhorse ships the ledger and the four functions an exporter drives. The
exporter itself is a small program you run where you like, on the schedule you like. Several may run
at once. No exporter ships in this release.

Enable export once from a deployment or an operator session:

```ts
import { Pool, Queue } from "@stablemates/workhorse";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const queue = new Queue(pool);

// Once. Export starts at the oldest day still in PostgreSQL.
await queue.setColdExportPolicy({ enabled: true });
console.log(await queue.getColdExportStatus());
```

Do this only when an exporter is ready to run. From that moment, retention waits for the export
watermark. Enabling export with nothing to drain it holds history indefinitely. The retention lag in
queue health keeps growing until you disable export or run an exporter.

An exporter loops over four calls. It claims the next day and reads that day in pages ordered by
identity. It writes the object and its manifest. Then it completes the segment with the checksum
and counts. If writing fails, it reports the failure, so the next claim hands the same day out
again:

```sql
SELECT * FROM workhorse.claim_cold_export_segment_v1('task_event', 'archiver-1', 3600000);
SELECT * FROM workhorse.read_cold_export_rows_v1(
  'task_event', '2026-09-14T00:00Z', '2026-09-15T00:00Z', NULL, NULL, 5000);
SELECT workhorse.complete_cold_export_segment_v1(
  'task_event', '2026-09-14T00:00Z', 1,
  'workhorse/task_event/2026/09/14/task_event-2026-09-14.ndjson.gz',
  'workhorse/task_event/2026/09/14/task_event-2026-09-14.manifest.json',
  '<hex sha-256 of the object as stored>', 123456, 5000);
```

`queue.getColdExportStatus()` reports, per relation, the watermark and the newest day that may be
exported. It also reports the segment currently held and the last error.

A store is anything that writes one object under a name. Encryption at rest, access control, and
write-once rules belong to that store and its provider. Workhorse holds no key of its own.

<details>
<summary>Reference: exporter contract and status</summary>

An exporter runs these steps:

1. It claims one day of one dataset.
2. It reads the day in `read_cold_export_rows_v1` pages of 1 through 100,000 rows.
3. It writes one gzipped JSON-lines object, named as below.
4. It writes a `.manifest.json` beside the object, with the row count, byte length, and hex SHA-256
   of the object as stored.
5. It completes the segment with those values, or calls `fail_cold_export_segment_v1`.

| Object key pattern                                                         |
| -------------------------------------------------------------------------- |
| `<prefix>/<dataset>/<YYYY>/<MM>/<DD>/<dataset>-<YYYY>-<MM>-<DD>.ndjson.gz` |

**Status.** `Queue.getColdExportStatus()` wraps `get_cold_export_status_v1()`. It returns `enabled`,
`updatedAt`, and per dataset:

| Field               | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `exportedThrough`   | The watermark. Every day below it has a complete segment.    |
| `exportableThrough` | The newest day boundary a segment may end at.                |
| `completeSegments`  | Count of complete segments.                                  |
| `exporting`         | `{ segmentStart, attempts }` of a held or abandoned segment. |
| `lastError`         | The newest stored error.                                     |

More detail: [Data model: Exporter contract](../architecture/data-model.md#exporter-contract).

</details>

## Turning it off

You disable export on 1 October. Retention returns to its configured windows at once, and the next
passes delete the days that export was holding. On 20 October you enable export again. By then
PostgreSQL no longer holds those days. So the watermark moves forward to the oldest day still
present. Workhorse does not record empty segments for days that once had rows.

<details>
<summary>Reference: policy functions</summary>

`Queue.setColdExportPolicy({ enabled, from? })` wraps `set_cold_export_policy_v1(p_enabled, p_from)`
and emits the `workhorse.cold_export_policy.synchronized` log event.

Enabling seeds each dataset without a watermark at one of these days:

- the UTC day of `p_from`, when given;
- otherwise `cold_export_oldest_history_day_internal_v1`, the UTC day of the oldest retained row;
- the current UTC day, when the dataset is empty.

Rules:

- A `p_from` that differs from an existing watermark raises `already started`. The start never
  moves.
- `p_from` with `p_enabled = false` raises.
- Re-enabling advances a watermark that fell below the oldest retained day.

More detail: [Data model: Policy functions](../architecture/data-model.md#policy-functions).

</details>

## Reading an export back

In March an auditor asks how many events of each type the tasks wrote in September. Retention has
already deleted September from PostgreSQL, but `archiver-1` exported every day of it.

1. **The operator counts with DuckDB.** They point it at the September objects of `task_event` and
   group the lines by event type.
2. **The auditor then asks about one task.** The operator loads 14 September into a scratch table
   and queries it with PostgreSQL.

There is no transparent hot-and-cold query in this version. Read the archive with a tool that
understands JSON lines, or load a day into a scratch schema for a PostgreSQL query. Never load it
into the live `workhorse` schema. Retention would delete it again, and statistics would count it
twice.

With DuckDB:

```sql
SELECT event_type, count(*)
  FROM read_ndjson_auto('/mnt/archive/workhorse/task_event/2026/09/*/*.ndjson.gz')
 GROUP BY event_type;
```

With PostgreSQL, decompress and load each line as one `jsonb` value into a scratch table. The quote
and delimiter bytes below never occur in JSON, so `COPY` keeps every line intact:

```sh
gunzip -c task_event-2026-09-14.ndjson.gz \
  | psql "$DATABASE_URL" -c "COPY archive.task_event_lines (line) FROM STDIN \
      WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
```

Then project the lines into columns with `jsonb` operators. Each line holds one source row, keyed
by the column names it had when it was exported.

<details>
<summary>Reference: export contents and restore</summary>

- Each line is the `record` that `read_cold_export_rows_v1` returned: the `to_jsonb` of one row.
- Rows arrive in `(occurred_at, id)` order. For `fast_task_outcome`, the order is
  `(finished_at, task_id)`.
- An empty day completes with a null object key and a manifest only.
- ADR 0068 promises no hot and cold query through the dashboard or the operator API. It makes
  loading an export into the live `workhorse` schema unsupported, because retention would delete it
  again and statistics would count it twice.

More detail: [Data model: Segment functions](../architecture/data-model.md#segment-functions) and [ADR 0068: Export cold history behind the rollup watermark](../decisions/0068-export-cold-history-behind-the-rollup-watermark.md).

</details>

## Next

- [330-retention.md](330-retention.md) — the windows export runs ahead of
- [320-statistics.md](320-statistics.md) — the watermark that gates both deletion and export
- [360-queue-health.md](360-queue-health.md) — where a stalled exporter shows up

---

Exact table columns, function signatures, and bounds:
[`architecture/data-model.md`](../architecture/data-model.md#cold_export_policy-cold_export_dataset-and-cold_export_segment).
