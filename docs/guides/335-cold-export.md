# Keeping history longer than PostgreSQL should hold it

Retention deletes events and attempts after a bounded window. That is the right thing for a
database whose job is dispatch, and the wrong thing for an auditor who asks in March what happened
to a task in January. Cold export answers that question without stretching retention: Workhorse
copies each finished day of history to a store you own, and only then lets retention delete it.

Export is off by default. With it off, nothing in this guide runs and Workhorse remains
PostgreSQL-only.

## A day is the unit

History is partitioned by UTC day, so a day is what gets exported. Each day of each history relation
becomes one segment: one compressed file of JSON lines, one row per event or attempt with every
column kept, plus a small manifest beside it that records the row count, the byte length, and a
checksum of the file as stored. A day with no rows gets only the manifest.

A [fast-tier queue](305-fast-tier.md) writes little history, so export treats its outcome rows as
a third relation, `fast_task_outcome`. Workhorse groups those rows by the day each task finished.

Workhorse exports a day only once it is closed and the statistics rollup has passed it. The rollup
watermark is already the rule for when deletion is safe, so export follows the same rule and always
runs ahead of deletion. See [320-statistics.md](320-statistics.md).

## The ledger lives in PostgreSQL

Workhorse records every segment in its own schema: which day, whether it is complete, which
exporter holds it, the object name, the checksum, and any error. It also keeps one watermark per
relation that marks the oldest day not yet exported. The watermark advances only across contiguous
complete days, so it can never skip a hole.

That ledger is the interlock. While export is enabled, history retention will not delete a day
above the watermark. An exporter that stops holds history rather than leaving the archive
incomplete, and the growing retention lag in queue health is how you notice.

## Resume is free

Object names come from the segment identity and rows are read in a fixed order, so exporting the
same day twice writes the same bytes to the same name. If an exporter crashes halfway, the next run
takes the day again and overwrites what was partly written. Nothing about the store needs to be
transactional.

A crash cannot corrupt the ledger either. A claim leases the day and counts the attempt, and only
the attempt that holds the lease can mark the day complete. A stale exporter that wakes up late is
refused.

## Running an exporter

The exporter is not a worker routine. Workers never talk to your object store and dispatch never
waits for an export. Workhorse ships the ledger and the four functions an exporter drives; the
exporter itself is a small program you run where you like, on the schedule you like, and several
may run at once. No exporter ships in this release.

Enable export once from a deployment or an operator session:

```ts
import { Pool, Queue } from "@stablemates/workhorse";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const queue = new Queue(pool);

// Once. Export starts at the oldest day still in PostgreSQL.
await queue.setColdExportPolicy({ enabled: true });
console.log(await queue.getColdExportStatus());
```

Do this only when an exporter is ready to run. From that moment retention waits for the export
watermark, so enabling export with nothing to drain it holds history indefinitely, and the retention
lag in queue health keeps growing until you disable export or run an exporter.

An exporter loops over four calls. It claims the next day, reads that day in pages ordered by
identity, writes the object and its manifest, and completes the segment with the checksum and
counts. If writing fails, it reports the failure so the next claim hands the same day out again:

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

`queue.getColdExportStatus()` reports the watermark, the newest day that may be exported, the
segment currently held, and the last error, per relation.

A store is anything that writes one object under a name. Encryption at rest, access control, and
write-once rules belong to that store and its provider; Workhorse holds no key of its own.

## Turning it off

Disable export and retention returns to its configured windows immediately. Days that retention
then deletes are gone from PostgreSQL, so if you enable export again later, the watermark moves
forward to the oldest day still present rather than recording empty segments for days that once had
rows.

## Reading an export back

There is no transparent hot-and-cold query in this version. Read the archive with a tool that
understands JSON lines, or load a day into a scratch schema for a PostgreSQL query. Never load it
into the live `workhorse` schema: retention would delete it again and statistics would count it
twice.

With DuckDB:

```sql
SELECT event_type, count(*)
  FROM read_ndjson_auto('/mnt/archive/workhorse/task_event/2026/09/*/*.ndjson.gz')
 GROUP BY event_type;
```

With PostgreSQL, decompress and load each line as one `jsonb` value into a scratch table. The
quote and delimiter bytes below never occur in JSON, so `COPY` keeps every line intact:

```sh
gunzip -c task_event-2026-09-14.ndjson.gz \
  | psql "$DATABASE_URL" -c "COPY archive.task_event_lines (line) FROM STDIN \
      WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
```

Then project the lines into columns with `jsonb` operators. The manifest names the schema version
the rows came from, so a reader knows which columns to expect.

## Next

- [330-retention.md](330-retention.md) — the windows export runs ahead of
- [320-statistics.md](320-statistics.md) — the watermark that gates both deletion and export
- [360-queue-health.md](360-queue-health.md) — where a stalled exporter shows up

---

Exact table columns, function signatures, and bounds:
[`architecture.md`](../architecture.md#cold_export_policy-cold_export_dataset-and-cold_export_segment).
