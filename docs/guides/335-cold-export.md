# How do I keep history longer than PostgreSQL should hold it?

<!-- scenario-names: archiver-1, archiver-2 -->

Retention deletes events and attempts after a limited window. This window suits a database that
dispatches work. But an auditor can ask in March what happened to a task in January. Cold export
copies each finished UTC day of history to an export store, and only then lets retention delete
the day. An export store is storage that you own, such as an object store.

Cold export is off by default. If it is off, nothing on this page runs, and Workhorse uses only
PostgreSQL.

## Export one UTC day at a time

**Example.** You turn on cold export. An exporter named `archiver-1` runs each hour. An exporter is
a program that you run to copy history to the export store. Follow the history that your tasks write
on 14 September.

1. During 14 September UTC, tasks run and fail. Workhorse writes their events to `task_event` and
   their closed attempts to `attempt_history`.
2. At midnight UTC, the day ends. The statistics rollup, the routine that summarizes history, has
   not summarized the day. Thus the day is not ready for export.
3. Some minutes later, the rollup passes midnight. The day is now ready for export.
4. At its next run, `archiver-1` copies the 14 September segment of `task_event` to the export
   store. Then it marks the segment complete.
5. When the retention window of the day ends, retention can delete 14 September from PostgreSQL.
   The export store keeps the day.

A segment is one day of one history table. The exporter writes each segment as one compressed file
of JSON lines. The file has one line for each row of the table, with all columns. A row is an event,
an attempt, or a fast-tier outcome. A manifest file
next to it records the row count, the byte length, and a checksum of the stored file. If a day has
no rows, the exporter writes only the manifest.

A [fast-tier queue](305-fast-tier.md) writes little history. Thus cold export treats its outcome
rows as a third table, `fast_task_outcome`. Workhorse puts each outcome row in the day when its task
finished.

Workhorse permits the export of a day only after the day ends and the rollup passes it. The rollup
watermark also decides when retention can delete a day. Thus the export always comes before the
deletion. [320-statistics.md](320-statistics.md) explains the rollup watermark. Workhorse also keeps
one export watermark for each table. The export watermark is the start of the oldest day that is
not exported.

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

## Run an exporter

**Example.** An operator turns on cold export just before the first run of `archiver-1`.

1. Immediately, retention starts to wait for the export watermark.
2. At the hourly run, `archiver-1` claims the oldest day that is not exported. It reads the day,
   writes the file and its manifest, and completes the segment.
3. Then the export store refuses a write, and `archiver-1` reports the failure.
4. The next claim of `archiver-1` gets the same day again.

The exporter is not a routine. Workers never connect to your export store, and dispatch never waits
for an export. Workhorse supplies the ledger and the four SQL functions that an exporter calls. The
ledger is the record of segments in PostgreSQL. You run the exporter where you want, on the schedule
that you want. More than one exporter can run at the same time. This release does not include an
exporter.

Turn on cold export one time, from a deployment or from an operator session:

```ts
import { Pool, Queue } from "@stablemates/workhorse";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const queue = new Queue(pool);

// One time. The export starts at the oldest day that PostgreSQL still holds.
await queue.setColdExportPolicy({ enabled: true });
console.log(await queue.getColdExportStatus());
```

Turn on cold export only when an exporter is ready to run. From that time, retention waits for the
export watermark. If no exporter runs, Workhorse keeps history without a limit. The retention lag in
queue health increases until you turn off cold export or run an exporter.

An exporter repeats these calls:

1. Claim the next day.
2. Read the day in pages, in the order of the row identity.
3. Write the file and its manifest to the export store.
4. Complete the segment with the checksum and the counts.

If the write fails, report the failure. The next claim then gets the same day again.

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

`queue.getColdExportStatus()` shows the export watermark of each table and the newest day that is
ready for export. It also shows the segment that an exporter holds and the last error.

An export store can be any storage that writes one object under a name. The export store and its
provider own encryption at rest, access control, and write-once rules. Workhorse has no key of its
own.

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

## Find an exporter that stopped

**Example.** `archiver-1` stops on 20 September. Its host was removed, and nobody moved the
exporter.

1. On 20 September, the last complete segment of `task_event` is 19 September. The export watermark
   is 20 September.
2. On the next days, new days end, but no exporter copies them. The watermark stays at 20 September.
3. Then 20 September passes its retention window. The watermark is not past the day, so retention
   keeps it.
4. Each day after that, retention keeps one more day. The retention lag in
   [queue health](360-queue-health.md) increases, and you see the problem.

Workhorse records each segment in the ledger: the day, the status, the exporter that holds it, the
object name, the checksum, and any error. The watermark moves forward only across complete days
with no gap between them. Thus it cannot skip a missing day.

While cold export is on, history retention does not delete a day at or after the export watermark.
Thus an exporter that stops keeps history in PostgreSQL. It does not leave a gap in the export
store.

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

## Recover after an exporter crashes

A lease is the time that one exporter holds a segment. While the lease is active, no other exporter
can claim a day of that table.

**Example.** `archiver-1` claims 14 September with a one-hour lease and starts the upload.

1. At 0 min, the claim opens the segment as attempt 1 and leases it to `archiver-1`.
2. At 20 min, `archiver-1` crashes. Part of the file can already be in the export store.
3. At 60 min, the lease expires. At 70 min, `archiver-2` claims the same day as attempt 2.
4. `archiver-2` writes the same file under the same name, and completes the segment.
5. At 90 min, `archiver-1` restarts and tries to complete the segment as attempt 1. The ledger
   refuses, because attempt 2 holds the day.

The same day always gives the same file. The file name comes from the segment, and the exporter
reads the rows in a fixed order. Thus a second export replaces a partial upload with the full file.
The export store does not need transactions.

A crash also cannot damage the ledger. Each claim leases the day and counts the attempt. Only the
attempt that holds the lease can mark the day complete. If an exporter reports a failure, Workhorse
releases the lease immediately. The next claim then gets the same day again.

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

## Read an export

**Example.** In March, an auditor asks how many events of each type the tasks wrote in September.
Retention has deleted September from PostgreSQL, but `archiver-1` exported each day.

1. The operator uses DuckDB on the September files of `task_event`, and groups the lines by event
   type.
2. The auditor then asks about one task. The operator loads 14 September into a scratch table and
   queries it with PostgreSQL.

This version has no query that reads PostgreSQL and the export store together. Read the export
store with a tool that reads JSON lines. Or load a day into a scratch schema for a PostgreSQL query.
A scratch schema is a schema that you make only for this work.

Do not load an export into the live `workhorse` schema. Retention deletes the rows again, and the
statistics count them two times.

With DuckDB:

```sql
SELECT event_type, count(*)
  FROM read_ndjson_auto('/mnt/archive/workhorse/task_event/2026/09/*/*.ndjson.gz')
 GROUP BY event_type;
```

With PostgreSQL, decompress the file and load each line as one `jsonb` value into a scratch table.
The quote byte and the delimiter byte below never occur in JSON. Thus `COPY` keeps each line
complete:

```sh
gunzip -c task_event-2026-09-14.ndjson.gz \
  | psql "$DATABASE_URL" -c "COPY archive.task_event_lines (line) FROM STDIN \
      WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
```

Then get columns from the lines with `jsonb` operators. Each line holds one source row. Its keys are
the column names at the time of the export.

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

## Turn off cold export

If you turn off cold export, retention uses only its windows again. If you turn it on later, the
export starts at the oldest day that PostgreSQL still holds.

**Example.** You turn off cold export on 1 October.

1. Retention immediately uses its windows again.
2. The next passes delete the days that the export kept.
3. On 20 October, you turn on cold export again. PostgreSQL no longer holds those days.
4. Workhorse moves the export watermark forward to the oldest day that PostgreSQL still holds.

Workhorse does not record empty segments for days that had rows before.

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

<a id="a-day-is-a-utc-day"></a>

## Repair segments that are not one UTC day

A segment always starts at a UTC midnight and lasts one UTC day. The time zone of the session has no
effect. Earlier releases did not obey this rule on a day with a clock change.

**Example.** An exporter session uses the time zone `America/New_York`. On 8 March 2026, New York
moves its clocks forward one hour. An earlier release did these steps:

1. A segment started at 8 March 00:00 UTC. The claim added one calendar day in the session time
   zone, so the segment ended at 8 March 23:00 UTC.
2. The next segment started at 8 March 23:00 UTC, not at midnight. Its UTC date was also 8 March,
   so it got the same object name.
3. The exporter wrote the second segment under that name. It replaced the file of the first
   segment, and the export store lost most of 8 March.

On a day when the clocks moved back, a segment was one hour too long. In both cases, the later
segments did not start at midnight.

The schema upgrade that adds the UTC-day rule repairs a damaged ledger. Before you run the upgrade,
do these steps:

1. Stop each exporter.
2. Let each exporter finish its file and manifest uploads.
3. Keep cold export on, so that retention still waits for the export.

The repair removes earlier exporters from the ledger. It cannot stop an upload that is in progress.
That upload can replace the file of a repaired day with the old range.

The upgrade first waits for a running retention pass. No pass deletes history until the repair
commits. Thus a pass that read the old watermark cannot delete history that the repair must export
again. An exporter that claims or completes a day during the upgrade also waits.

If a table lost a complete day to a short or long segment, Workhorse moves its export watermark
back. The watermark goes to the first day that the segment can have replaced. The exporter then
writes those days again. Retention reads the watermark, so it keeps those days until the export
copies them.

Then Workhorse makes each damaged segment one UTC day:

- If a segment starts at a UTC midnight and is at or after the new watermark, it becomes one UTC
  day. The exporter exports it again. Its attempt count increases, so its earlier exporter cannot
  complete it.
- Workhorse deletes each other segment that is not one UTC day. Its file stays in your export
  store, but the ledger no longer names it.

The upgrade gives a warning for each table, with the count and the range of each type of change.

The watermark moves back only to history that PostgreSQL still holds. Retention can already have
deleted some of those days. Then the watermark stops at the oldest day that remains. A second
warning names the days that the exporter cannot write again. Do not trust their exported files. If
you have another copy of them, restore them from it.

Retention can also delete part of a day. Fast-tier cleanup deletes outcomes one row at a time. Thus
an exported day can keep only some of its rows in PostgreSQL. A new export of that day replaces a
complete file with a smaller file. Thus the watermark also stops after the last complete day whose
source holds fewer rows than its exported file. Those days keep their files, and the same warning
names them.

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

## Next

- [330-retention.md](330-retention.md) — the windows that the export comes before
- [320-statistics.md](320-statistics.md) — the watermark that controls deletion and export
- [360-queue-health.md](360-queue-health.md) — where an exporter that stopped shows

---

Exact table columns, function signatures, and limits:
[`architecture/data-model.md`](../architecture/data-model.md#cold_export_policy-cold_export_dataset-and-cold_export_segment).
