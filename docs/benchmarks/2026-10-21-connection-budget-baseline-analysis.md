# Connection budget baseline

A worker holds two connections that its handlers cannot use: the listener connection and the
heartbeat connection. This baseline measures what these connections cost in each SDK before
SM-1565 changes them. It also shows whether one shared heartbeat connection renews many leases in
time. The run used `pnpm benchmark:connection-budget` from SM-1566 on 2026-10-21, on `main` at
`2745340496e533806c5c8893ca08a8029f53b85f`, before any fix.

In TypeScript, Go, and Ruby, all workers on one pool share one listener and one heartbeat
connection. These three SDKs kept every lease in every cell, up to 64 workers with 25 tasks each.
Python and Rust hold one heartbeat connection for each worker. Python, Rust, and the JVM hold one
listener connection for each worker, and the Rust listener connections are outside the pool. On a
pool of 20, the reserved connections took the pool, so claims or renewals stopped. The JVM lost
leases at 64 workers.

## Method

Each SDK variant ran the 11 cells that the `full` profile had at that time. The variants ran one
after the other, from 07:18 to 09:51 UTC. A cell has W workers in one process on one pool of P
connections. Each worker has a concurrency C, a heartbeat interval I, and a lease L. In every cell
of this run, each handler held its task until the probe stopped. The
[runbook](../benchmarking.md#connection-budget-benchmark) describes the cells and the artifact.

The machine had 32 logical CPUs, and the available memory was between 78.8 and 79.6 GB in every
reading. PostgreSQL 18.6 ran on the
same machine, with `max_connections` 500. The 1-minute load average was between 0.26 and 1.55 in
every reading. The highest reading came after the Ruby 64 × 25 cell. The machine was lightly
loaded, not idle.

The summaries are in
[`results/2026-10-21-connection-budget-baseline/`](results/2026-10-21-connection-budget-baseline/),
one file for each variant. `pnpm benchmark:connection-budget:summary` writes each summary from a
full artifact. The summary keeps the provenance, the settings, and each cell with its result, its
rules, and its key values. It keeps the cells in the order of the run, so `runs[5]` is the sixth
cell in both files.

The full artifacts use schema version 3. That version stopped a probe with SIGKILL 20 s after
SIGTERM, and recorded the stop as `killedAfterGrace`. It recorded no result for each cell. Thus the
summary computes the result of each cell with the rules of the driver, `cellResult`, and the kill
deadline of 20 s. Schema 3 also does not record which worker errors came after SIGTERM. The summary
counts none for the shutdown rule. Every cell with a worker error also fails the rule "no errors",
so its result does not depend on that count.

The full artifacts and the logs of the runner are attached to SM-1574 in Linear, as
`sm1565-benchmark-raw-2026-10-21.tar.zst`. Its sha256 is
`b69dc0ab5fdbfcf4a204e4b291b9a500e7d6f9d2f7c3cf3ba3f4425b5e909041`. The full artifacts hold the
sample series. Each summary names its file in the attachment and gives the sha256 of that file.

## Results

Each entry gives the live leases at the end of the cell against W × C, then the most active tasks
with an expired lease in one sample. A `K` marks a probe that needed SIGKILL. All cells use a pool
of 20, I = 1 s, and L = 3 s, unless the row says otherwise. The rows with I = 10 s use L = 30 s.

| Cell (W × C)      | `typescript`  | `go`          | `ruby`        | `python-sync` | `python-async`  | `python-asyncpg` | `rust`       | `jvm`          |
| ----------------- | ------------- | ------------- | ------------- | ------------- | --------------- | ---------------- | ------------ | -------------- |
| 2 × 1, pool 4     | 2/2 (0)       | 2/2 (0)       | 2/2 (0)       | 2/2 (0)       | 2/2 (0) K       | 2/2 (0) K        | 2/2 (0)      | 2/2 (0)        |
| 1 × 1             | 1/1 (0)       | 1/1 (0)       | 1/1 (0)       | 1/1 (0)       | 1/1 (0)         | 1/1 (0)          | 1/1 (0)      | 1/1 (0)        |
| 1 × 25            | 25/25 (0)     | 25/25 (0)     | 25/25 (0)     | 25/25 (0)     | 25/25 (0)       | 25/25 (0)        | 25/25 (0)    | 25/25 (0)      |
| 4 × 1             | 4/4 (0)       | 4/4 (0)       | 4/4 (0)       | 4/4 (0)       | 4/4 (0)         | 4/4 (0)          | 4/4 (0)      | 4/4 (0)        |
| 4 × 25            | 100/100 (0)   | 100/100 (0)   | 100/100 (0)   | 100/100 (0)   | 100/100 (0)     | 100/100 (0)      | 100/100 (0)  | 100/100 (0)    |
| 16 × 1            | 16/16 (0)     | 16/16 (0)     | 16/16 (0)     | 4/16 (12)     | 4/16 (12) K     | 4/16 (12) K      | 16/16 (0)    | 16/16 (0)      |
| 16 × 25           | 400/400 (0)   | 400/400 (0)   | 400/400 (0)   | 100/400 (300) | 100/400 (300) K | 100/400 (300) K  | 400/400 (0)  | 400/400 (0)    |
| 64 × 1            | 64/64 (0)     | 64/64 (0)     | 64/64 (0)     | 0/64 (0)      | 0/64 (0)        | 0/64 (0) K       | 0/64 (0) K   | 4/64 (46)      |
| 64 × 25           | 1600/1600 (0) | 1600/1600 (0) | 1600/1600 (0) | 0/1600 (0)    | 0/1600 (0)      | 0/1600 (0) K     | 0/1600 (0) K | 0/1600 (1760)  |
| 16 × 25, I = 10 s | 400/400 (0)   | 400/400 (0)   | 400/400 (0)   | 100/400 (300) | 100/400 (300)   | 100/400 (300) K  | 400/400 (0)  | 400/400 (0)    |
| 64 × 25, I = 10 s | 1600/1600 (0) | 1600/1600 (0) | 1600/1600 (0) | 0/1600 (0)    | 0/1600 (0)      | 0/1600 (0) K     | 0/1600 (0) K | 25/1600 (1260) |

A cell with 0 live leases and 0 expired active tasks never claimed a task. A count of expired
active tasks is a lease that expired while no worker recorded its loss. Workhorse records a lost
lease only when a worker recovers it, so the two counts are independent.

### The results by SDK

- **TypeScript, Go, and Ruby** kept every lease in all 11 cells. They recorded no lost lease, no
  expired active task, and no second attempt. At 64 × 25 the maximum sampled renewal age was
  1008 ms in TypeScript, 968 ms in Go, and 945 ms in Ruby, against a lease of 3000 ms.
- **Python, in all three variants,** starved at 16 workers. One listener connection for each worker
  and four heartbeat connections took the pool. Four workers kept their leases, and the leases of
  the others expired. At 64 workers, the listener connections took all 20 connections, and no
  claim started.
- **Rust** kept every lease at 16 workers, because its listener connections are outside the pool.
  But 16 heartbeat connections held 16 of the 20 pool connections. At 64 workers the heartbeat
  connections held the whole pool, and no claim started.
- **The JVM** lost leases at 64 workers: 43 at 64 × 1, 100 at 64 × 25, and 200 at 64 × 25 with
  I = 10 s. One listener connection for each worker took the pool, so the one shared heartbeat
  connection could not get a connection. A lost lease lets another worker claim the task again.
  This result is about pool starvation from unbounded acquisition, not about the capacity of the
  JVM heartbeat scheduler.

### The results against the acceptance thresholds

SM-1570 adds a result for each cell, from the thresholds of SM-1565. Every cell of
this run is a held-task cell. The summary of each variant gives these results, with the 20 s kill
deadline of the run. The table counts them.

| Variant          | Cells that pass | Lost leases | Most expired active tasks | Cells with SIGKILL                                 |
| ---------------- | --------------- | ----------- | ------------------------- | -------------------------------------------------- |
| `typescript`     | 11 of 11        | 0           | 0                         | none                                               |
| `go`             | 11 of 11        | 0           | 0                         | none                                               |
| `ruby`           | 11 of 11        | 0           | 0                         | none                                               |
| `python-sync`    | 2 of 11         | 0           | 300                       | none                                               |
| `python-async`   | 2 of 11         | 0           | 300                       | 2 × 1 on a pool of 4; 16 × 1; 16 × 25              |
| `python-asyncpg` | 2 of 11         | 0           | 300                       | every cell except 1 × 1, 1 × 25, 4 × 1, and 4 × 25 |
| `rust`           | 2 of 11         | 0           | 0                         | 64 × 1; 64 × 25; 64 × 25 with I = 10 s             |
| `jvm`            | 2 of 11         | 343         | 1760                      | none                                               |

In Python, Rust, and the JVM, every cell with more than one worker fails the rule of reserved
backends. The pool held more than one listener or heartbeat connection, or the driver observed no
heartbeat round. Only the cells with one worker pass.

## Corrections to the first summary

The first summary of this run, in a comment on SM-1565, had two errors:

1. It recorded no SIGKILL for `python-async`. The `python-async` probe needed SIGKILL in three
   cells: 2 × 1 on a pool of 4, 16 × 1, and 16 × 25. These are `runs[0]`, `runs[5]`, and `runs[6]`
   of `python-async.json`, in the summary and in the full artifact.
2. It gave the range of the 1-minute load as 0.3 to 1.4. The recorded range is 0.26 to 1.55.

A SIGKILL shows only that the probe did not stop within 20 s. The drain of an SDK can take 25 s,
and a psycopg pool acquisition can wait 30 s. Thus a SIGKILL in this run does not prove a wait
without a limit.

## What this does not measure

Every handler in this run held its task until the probe stopped. Thus no cell tests whether claims
continue after a task completes, and the two-worker Python cell filled its slots before the reserved
connections took the pool. The refill and fault cells of SM-1570 test that.

The run used one process, one pool, and one machine with no network between the workers and
PostgreSQL. It did not measure more than 64 workers, more than 25 tasks for each worker, a loaded
database, a connection pooler, or mixed heartbeat intervals. These results are not a production
capacity limit.
