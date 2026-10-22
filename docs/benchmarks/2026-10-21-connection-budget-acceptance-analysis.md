# Connection budget acceptance

A worker holds two connections that its handlers cannot use: the listener connection and the
heartbeat connection. SM-1565 changed every SDK so that all workers on one pool share one of each.
This acceptance run measures each SDK again after those changes, with the cells of the
[baseline](2026-10-21-connection-budget-baseline-analysis.md), and applies the acceptance
thresholds of SM-1565. The run used `pnpm benchmark:connection-budget` on `main` at
`b4e86d580a2885dbb78f1ac7f8ef9aacd86fbae2`. No SDK code changed for the run.

Every SDK variant kept every lease in every held-task cell, up to 64 workers with 25 tasks each.
Every variant completed every task of the refill cells once. In each cell, the role sampler
observed at most one listener connection and at most one heartbeat-role connection at one time.
No probe needed SIGKILL. 118 of the 120 cells pass. The fault cell of Ruby and the fault cell of
the JVM are inconclusive in two runs each. Thus these two cells do not pass the acceptance.

## Method

Each SDK variant ran the 15 cells of the `full` profile. The variants ran one after the other, from
2026-10-21 21:53 UTC to 2026-10-22 00:39 UTC. They ran in the order of the baseline: `typescript`,
`go`, `ruby`, `python-sync`, `python-async`, `python-asyncpg`, `rust`, and `jvm`. The
[runbook](../benchmarking.md#connection-budget-benchmark) describes the cells, the rules, and the
artifact.

The 15 cells are these:

- The 11 held-task cells of the baseline. Their shape, warm-up, and window are the same as in the
  baseline, so their values compare directly.
- 3 refill cells and 1 fault cell, which SM-1570 added after the baseline. The baseline has no
  values for them.

The driver changed in two ways after the baseline, in SM-1570. Both changes affect only how the
probe stops and how a cell gets its result:

1. The baseline sent SIGKILL 20 s after SIGTERM. Now the driver gives each probe a shutdown grace
   of 10 s. The kill deadline is that grace, plus the unwind window that the SDK documents, plus
   5 s.
2. The driver gives each cell a result from the SM-1565 rules. The artifacts use schema version 4.
   The baseline artifacts use schema version 3 and have no result for each cell. The baseline
   summaries give the baseline verdicts that this page uses. The
   [baseline analysis](2026-10-21-connection-budget-baseline-analysis.md#method) tells how the
   summary computes them.

The machine had 32 logical CPUs, and the available memory was between 78.3 and 80.7 GB in every
reading. PostgreSQL 18.6 ran on the same machine, with `max_connections` 500. The run used the
bench database of its own checkout. The machine is shared, so each variant held a slot of a lock
that the SM-1565 work uses for heavy commands. Before each variant, the runner waited until the
1-minute load was 6 or less. The 1-minute load was between 0.34 and 3.74 in every reading before
and after a cell. The highest reading came before the first TypeScript cell, after the build. The
driver guard waited at most 1 ms before a cell.

The probes were built once, from the same commit, before the first variant. Then the driver ran
with `--no-build`. Each SDK reported version 0.9.0. During the run, SM-1573 merged to `main` as
`e0f87579`. It changed documentation and the budget diagram, and no SDK source.

The summaries are in
[`results/2026-10-21-connection-budget-acceptance/`](results/2026-10-21-connection-budget-acceptance/),
one JSON file for each variant. The two `-rerun-` files are the second runs of the two
inconclusive fault cells. `pnpm benchmark:connection-budget:summary` writes each summary from a
full artifact. The summary keeps the provenance, the settings, the driver summary table, and each
cell with its result, its rules, and its key values. Each rule gives its value and its threshold.
The summary also keeps the 1-minute load before and after each cell. The load before the first
cell and after the last cell of a variant gives its load at the start and at the end.

The full artifacts and the logs of the runner are attached to SM-1574 in Linear, as
`sm1565-benchmark-raw-2026-10-21.tar.zst`. Its sha256 is
`b69dc0ab5fdbfcf4a204e4b291b9a500e7d6f9d2f7c3cf3ba3f4425b5e909041`. The full artifacts hold the
sample series. Each summary names its file in the attachment and gives the sha256 of that file. The
summary tool applied the rules again to each full artifact and got the result that the driver
stored.

## Results

### Held-task cells

Each entry gives the live leases at the end of the cell against W × C. Then it gives the most
active tasks with an expired lease in one sample. The baseline table uses the same form. A `K` would mark a
probe that needed SIGKILL, and no cell has one. All cells use a pool of 20, I = 1 s, and L = 3 s,
unless the row says otherwise. The rows with I = 10 s use L = 30 s.

| Cell (W × C)      | `typescript`  | `go`          | `ruby`        | `python-sync` | `python-async` | `python-asyncpg` | `rust`        | `jvm`         |
| ----------------- | ------------- | ------------- | ------------- | ------------- | -------------- | ---------------- | ------------- | ------------- |
| 2 × 1, pool 4     | 2/2 (0)       | 2/2 (0)       | 2/2 (0)       | 2/2 (0)       | 2/2 (0)        | 2/2 (0)          | 2/2 (0)       | 2/2 (0)       |
| 1 × 1             | 1/1 (0)       | 1/1 (0)       | 1/1 (0)       | 1/1 (0)       | 1/1 (0)        | 1/1 (0)          | 1/1 (0)       | 1/1 (0)       |
| 1 × 25            | 25/25 (0)     | 25/25 (0)     | 25/25 (0)     | 25/25 (0)     | 25/25 (0)      | 25/25 (0)        | 25/25 (0)     | 25/25 (0)     |
| 4 × 1             | 4/4 (0)       | 4/4 (0)       | 4/4 (0)       | 4/4 (0)       | 4/4 (0)        | 4/4 (0)          | 4/4 (0)       | 4/4 (0)       |
| 4 × 25            | 100/100 (0)   | 100/100 (0)   | 100/100 (0)   | 100/100 (0)   | 100/100 (0)    | 100/100 (0)      | 100/100 (0)   | 100/100 (0)   |
| 16 × 1            | 16/16 (0)     | 16/16 (0)     | 16/16 (0)     | 16/16 (0)     | 16/16 (0)      | 16/16 (0)        | 16/16 (0)     | 16/16 (0)     |
| 16 × 25           | 400/400 (0)   | 400/400 (0)   | 400/400 (0)   | 400/400 (0)   | 400/400 (0)    | 400/400 (0)      | 400/400 (0)   | 400/400 (0)   |
| 64 × 1            | 64/64 (0)     | 64/64 (0)     | 64/64 (0)     | 64/64 (0)     | 64/64 (0)      | 64/64 (0)        | 64/64 (0)     | 64/64 (0)     |
| 64 × 25           | 1600/1600 (0) | 1600/1600 (0) | 1600/1600 (0) | 1600/1600 (0) | 1600/1600 (0)  | 1600/1600 (0)    | 1600/1600 (0) | 1600/1600 (0) |
| 16 × 25, I = 10 s | 400/400 (0)   | 400/400 (0)   | 400/400 (0)   | 400/400 (0)   | 400/400 (0)    | 400/400 (0)      | 400/400 (0)   | 400/400 (0)   |
| 64 × 25, I = 10 s | 1600/1600 (0) | 1600/1600 (0) | 1600/1600 (0) | 1600/1600 (0) | 1600/1600 (0)  | 1600/1600 (0)    | 1600/1600 (0) | 1600/1600 (0) |

No variant recorded a lost lease in any cell.

### Refill cells

Each entry gives the tasks that completed once, with one attempt and one claim, against the
enqueued tasks. Then it gives the longest claim gap while the heartbeat reservation was ready.
Last, it gives the longest claim gap while the reservation was ready or its state was unknown. The limit is 5 s.
All refill cells use I = 1 s, L = 3 s, and a polling interval of 1 s.

| Cell            | `typescript`           | `go`                  | `ruby`                | `python-sync`        | `python-async`         | `python-asyncpg`       | `rust`                | `jvm`                  |
| --------------- | ---------------------- | --------------------- | --------------------- | -------------------- | ---------------------- | ---------------------- | --------------------- | ---------------------- |
| 2 × 1, pool 4   | 40/40, 2.1 / 18.6      | 40/40, 2.2 / 10       | 40/40, 7.7 / 27.8     | 40/40, 5.6 / 12.9    | 40/40, 5.7 / 18.8      | 40/40, 6.1 / 23.9      | 40/40, 5 / 7.7        | 40/40, 4.6 / 44.1      |
| 4 × 2, pool 6   | 160/160, 3.8 / 18.2    | 160/160, 5.1 / 9.3    | 160/160, 9.8 / 40.4   | 160/160, 7.6 / 15.7  | 160/160, 7.2 / 18.5    | 160/160, 5.5 / 19.2    | 160/160, 3.4 / 7.8    | 160/160, 7.9 / 46.5    |
| 16 × 4, pool 20 | 1280/1280, 10.6 / 42.4 | 1280/1280, 5.9 / 14.6 | 1280/1280, 16 / 151.6 | 1280/1280, 28.9 / 30 | 1280/1280, 14.5 / 35.7 | 1280/1280, 27.3 / 40.3 | 1280/1280, 5.6 / 10.2 | 1280/1280, 21.5 / 67.9 |

The gaps are in milliseconds. The longest gap in any refill cell is 151.6 ms, in Ruby, with an
unknown reservation state.

### Fault cell

The fault cell has W = 16, C = 4, a pool of 20, I = 10 s, and L = 30 s. The driver ends the
heartbeat connection of the probe once, during a heartbeat round. In every variant, the fault
interrupted a round.

| Value                                           | `typescript` | `go`    | `ruby`       | `python-sync` | `python-async` | `python-asyncpg` | `rust`  | `jvm`        |
| ----------------------------------------------- | ------------ | ------- | ------------ | ------------- | -------------- | ---------------- | ------- | ------------ |
| First round on the replacement, after the fault | 0.9 ms       | 0.7 ms  | 9998.6 ms    | 3.0 ms        | 5.4 ms         | 4.4 ms           | 0.4 ms  | 10001.1 ms   |
| Fresh claims before that round                  | 0            | 0       | 120          | 0             | 0              | 0                | 0       | 120          |
| First fresh claim, after the fault              | 20.9 ms      | 17.4 ms | 26.9 ms      | 33.9 ms       | 42.2 ms        | 34.7 ms          | 18.1 ms | 28.4 ms      |
| Recovered attempts                              | 0            | 0       | 0            | 0             | 0              | 0                | 0       | 0            |
| Claims in the cell                              | 779          | 773     | 779          | 779           | 779            | 779              | 779     | 779          |
| Result                                          | pass         | pass    | inconclusive | pass          | pass           | pass             | pass    | inconclusive |

A fresh claim is a claim whose claim function started after the statements that ran at the fault
had ended. The first fresh claim came within 43 ms of the fault in every variant. The limit is
2 × I, 20 s. "Dispatch before next round" is a detection-only rule, and it gave `notDetected` in
every fault run. `notDetected` does not change the result of a cell.

## Results against the acceptance thresholds

Each entry gives the baseline verdict, then the acceptance verdict. The baseline had no refill or
fault cells, so their baseline verdict is `-`.

| Cell                 | `typescript` | `go`        | `ruby`                   | `python-sync` | `python-async` | `python-asyncpg` | `rust`      | `jvm`                    |
| -------------------- | ------------ | ----------- | ------------------------ | ------------- | -------------- | ---------------- | ----------- | ------------------------ |
| 2 × 1, pool 4        | pass → pass  | pass → pass | pass → pass              | fail → pass   | fail → pass    | fail → pass      | fail → pass | fail → pass              |
| 1 × 1                | pass → pass  | pass → pass | pass → pass              | pass → pass   | pass → pass    | pass → pass      | pass → pass | pass → pass              |
| 1 × 25               | pass → pass  | pass → pass | pass → pass              | pass → pass   | pass → pass    | pass → pass      | pass → pass | pass → pass              |
| 4 × 1                | pass → pass  | pass → pass | pass → pass              | fail → pass   | fail → pass    | fail → pass      | fail → pass | fail → pass              |
| 4 × 25               | pass → pass  | pass → pass | pass → pass              | fail → pass   | fail → pass    | fail → pass      | fail → pass | fail → pass              |
| 16 × 1               | pass → pass  | pass → pass | pass → pass              | fail → pass   | fail → pass    | fail → pass      | fail → pass | fail → pass              |
| 16 × 25              | pass → pass  | pass → pass | pass → pass              | fail → pass   | fail → pass    | fail → pass      | fail → pass | fail → pass              |
| 64 × 1               | pass → pass  | pass → pass | pass → pass              | fail → pass   | fail → pass    | fail → pass      | fail → pass | fail → pass              |
| 64 × 25              | pass → pass  | pass → pass | pass → pass              | fail → pass   | fail → pass    | fail → pass      | fail → pass | fail → pass              |
| 16 × 25, I = 10 s    | pass → pass  | pass → pass | pass → pass              | fail → pass   | fail → pass    | fail → pass      | fail → pass | fail → pass              |
| 64 × 25, I = 10 s    | pass → pass  | pass → pass | pass → pass              | fail → pass   | fail → pass    | fail → pass      | fail → pass | fail → pass              |
| Refill 2 × 1, pool 4 | - → pass     | - → pass    | - → pass                 | - → pass      | - → pass       | - → pass         | - → pass    | - → pass                 |
| Refill 4 × 2, pool 6 | - → pass     | - → pass    | - → pass                 | - → pass      | - → pass       | - → pass         | - → pass    | - → pass                 |
| Refill 16 × 4        | - → pass     | - → pass    | - → pass                 | - → pass      | - → pass       | - → pass         | - → pass    | - → pass                 |
| Fault 16 × 4         | - → pass     | - → pass    | - → **inconclusive (2)** | - → pass      | - → pass       | - → pass         | - → pass    | - → **inconclusive (2)** |

`(2)` marks a cell that ran twice with the same result. The
[inconclusive fault cells](#the-inconclusive-fault-cells-of-ruby-and-the-jvm) section explains
them.

### The values against each threshold

The table gives the worst value of each variant against each threshold of a healthy cell. Each
value covers the 11 held-task cells and the 3 refill cells of the variant. The fault cell does not use these thresholds.

| Threshold                                           | `typescript` | `go`     | `ruby`   | `python-sync` | `python-async` | `python-asyncpg` | `rust`   | `jvm`    |
| --------------------------------------------------- | ------------ | -------- | -------- | ------------- | -------------- | ---------------- | -------- | -------- |
| Max renewal age, I = 1 s, below 2,000 ms            | 1095 ms      | 1215 ms  | 1026 ms  | 1005 ms       | 1057 ms        | 1021 ms          | 995 ms   | 1079 ms  |
| Min lease margin, I = 1 s, above 1,000 ms           | 1905 ms      | 1785 ms  | 1974 ms  | 1995 ms       | 1943 ms        | 1979 ms          | 2005 ms  | 1921 ms  |
| Max renewal age, I = 10 s, below 20,000 ms          | 10007 ms     | 10191 ms | 10016 ms | 10005 ms      | 10006 ms       | 10009 ms         | 9979 ms  | 10016 ms |
| Min lease margin, I = 10 s, above 10,000 ms         | 19993 ms     | 19810 ms | 19984 ms | 19995 ms      | 19994 ms       | 19991 ms         | 20022 ms | 19984 ms |
| Most listener connections at one time, at most 1    | 1            | 1        | 1        | 1             | 1              | 1                | 1        | 1        |
| Most observed heartbeat-role connections, at most 1 | 1            | 1        | 1        | 1             | 1              | 1                | 1        | 1        |
| Lost leases, 0                                      | 0            | 0        | 0        | 0             | 0              | 0                | 0        | 0        |
| Most expired active tasks in one sample, 0          | 0            | 0        | 0        | 0             | 0              | 0                | 0        | 0        |
| Worker errors and sample errors, 0                  | 0            | 0        | 0        | 0             | 0              | 0                | 0        | 0        |
| Longest stop after SIGTERM                          | 123 ms       | 92 ms    | 837 ms   | 720 ms        | 868 ms         | 561 ms           | 87 ms    | 545 ms   |
| Cells with SIGKILL, 0                               | 0            | 0        | 0        | 0             | 0              | 0                | 0        | 0        |

The longest stop includes the fault cells. Every probe exited with status 0 after SIGTERM, and no
probe session remained after any cell. The Rust listener connection sits outside the pool, and the
sampler counts it in the listener row.

### The cells that SM-1574 requires

- **The Python and Rust boundary cells pass.** The boundary cells are 2 × 1 on a pool of 4,
  16 × 1, and 16 × 25. They pass every rule of a held-task cell in `python-sync`, `python-async`,
  `python-asyncpg`, and `rust`. The refill cells on the small pools also pass in these four
  variants. These cells are 2 × 1 on a pool of 4 and 4 × 2 on a pool of 6.
- **64 × 1 passes in every variant.**
- **The JVM 64 × 25 cell passes.** It kept 1600 of 1600 leases. The maximum renewal age was
  1024 ms, and the minimum lease margin was 1976 ms. The 64 × 25 cell with I = 10 s also passes. ADR
  0071 rule 2 made the JVM capacity statement wait for this result.

### The inconclusive fault cells of Ruby and the JVM

The fault cell of Ruby and the fault cell of the JVM are inconclusive on the rule "no claim in
outage". Each cell ran a second time, with the same result. The runbook says that a cell whose
second run is not a pass does not pass the acceptance. Thus these two cells do not pass.

The four runs have the same pattern:

| Run                | Fault    | First fresh claim | Ready, lower bound | First round on the replacement | Fresh claims between the bounds | Recovered attempts |
| ------------------ | -------- | ----------------- | ------------------ | ------------------------------ | ------------------------------- | ------------------ |
| `ruby`, first run  | 20500 ms | 20527 ms          | 20500 ms           | 30499 ms                       | 120                             | 0                  |
| `ruby`, second run | 20440 ms | 20473 ms          | 20440 ms           | 30439 ms                       | 120                             | 0                  |
| `jvm`, first run   | 20442 ms | 20470 ms          | 20442 ms           | 30443 ms                       | 120                             | 0                  |
| `jvm`, second run  | 20446 ms | 20480 ms          | 20446 ms           | 30445 ms                       | 120                             | 0                  |

The times are from the start of the probe. The driver cannot see when an SDK reserves the
replacement connection. It bounds the ready time by two observations:

- The lower bound is the last ordinary use of the replacement backend before its first round. In
  all four runs, the backend showed no use after the fault, so the lower bound is the fault.
- The upper bound is the first heartbeat round on the replacement backend.

The rule uses these bounds in this way:

- A fresh claim before the lower bound fails the rule.
- The rule passes only when no fresh claim and no unattributed claim come before the upper bound.
- In all other cases, the rule is inconclusive.

In all four runs, no fresh claim came before the lower bound, and no unattributed claim came before
the upper bound. The 120 fresh claims came between the two bounds, so the observations cannot decide
the rule.

In TypeScript, Go, Python, and Rust, the first round on the replacement came within 6 ms of the
fault, so the two bounds were close. In Ruby and the JVM, the first round on the replacement came
at the next regular slot. That slot came about I = 10 s after the round that the fault interrupted. Ruby and the
JVM use one coordinator for all workers on a pool, and the coordinator keeps its schedule after a
replacement.

The source shows the order of events in both SDKs:

- In Ruby, `hold_rounds` in `ruby/lib/stablemates/workhorse/worker/heartbeat.rb` checks out the
  replacement and checks it with `usable?`. `usable?` reads the socket state and sends no SQL. Then
  `ready` opens the claim gate and calls the `on_ready` callback of each worker. The rounds then
  run at their schedule.
- In the JVM, `jvm/workhorse/src/main/java/run/workhorse/internal/Heartbeat.java` installs the
  replacement connection and calls the `onConnected` callback of each reservation, which wakes the
  workers. The rounds then run at their schedule.

Thus both SDKs open the claim gate when the replacement reservation is ready, as ADR 0071 rule 6
requires. Rule 6 does not require a round at once on the replacement. The data shows no fresh
claim before the lower bound, no claim from a statement that started before the fault, and no recovered
attempt. The watchdog rule passed in all four runs. The data does not prove that each of the 120
claims came after the reservation was ready. This run observed no defect in either SDK.

The deterministic proof of the order is the "dispatch wakes on recovery" test of each SDK:

- Ruby: "replaces a lost connection while no task runs, and claims nothing until the replacement
  is ready", in `ruby/spec/unit/heartbeat_reservation_spec.rb`.
- JVM: `claimsNothingWithoutAHeartbeatConnectionAndWakesWhenItReturns`, in
  `jvm/workhorse/src/test/java/run/workhorse/WorkerHeartbeatGateDatabaseTest.java`.

The coordinator must decide how the acceptance treats these two cells.

### The observed heartbeat-role connections are estimates

The heartbeat-role counts on this page are observed estimates from the role sampler, not counts of
reservations. The sampler reads `pg_stat_activity` about every 2 ms, and it finds a heartbeat
connection by the statements that the connection runs. A connection that a worker reserves and that runs no observed round does not show. The pool
state of each probe and the lifecycle tests of each SDK pull request corroborate the counts.

`heartbeatObservationIncomplete` was true in 57 of the 120 cells. The flag is a warning about SQL
observation: a missed marker, a round that the sampler did not confirm, or a late round. It is not
proof of a missing round. In every healthy cell, the maximum sampled renewal age was at most
61 percent of its limit of 2 × I.

## Anomalies

- **The Ruby and JVM fault cells.** Each ran twice and was inconclusive twice. The section above
  gives the data.
- **A replaced Ruby heartbeat connection in the warm-up.** In the Ruby 64 × 25 cell, the first
  heartbeat backend ran one round at 1967 ms and closed at 2035 ms. A second backend ran its first
  round at 2755 ms and kept the role to the end. This came 2 s into the 15 s warm-up, and no lease
  was lost. The baseline Ruby 64 × 25 cell shows the same events, at 1692 ms, 1766 ms, and 2553 ms.
  Thus the change did not cause it. The cell passes, because the sampler never saw two heartbeat
  connections at one time.
- **Two heartbeat backends in one interval of a fault cell.** In the fault cells of TypeScript, Go,
  `python-async`, and `python-asyncpg`, `peakHeartbeatBackendsInOneInterval` is 2. The fault ends
  one heartbeat backend, and its replacement runs a round in the same interval. At one time, the
  sampler never saw more than one.

## The results by SDK, against the baseline

- **TypeScript and Go** passed all 11 held-task cells in the baseline, and they pass all 15 cells
  now. At 64 × 25, the maximum sampled renewal age was 1008 ms in TypeScript and 1215 ms in Go. In
  the baseline it was 1008 ms and 968 ms.
- **Ruby** passed all 11 held-task cells in the baseline, and it passes all 14 healthy cells now.
  Its fault cell does not pass, as the section above explains.
- **Python, in all three variants,** failed every cell with more than one worker in the baseline.
  At 16 workers, the leases of 12 workers expired, and at 64 workers no claim started. Now every
  variant passes all 15 cells. In the baseline, `python-async` needed SIGKILL in 3 cells and
  `python-asyncpg` in 7 cells. Now no cell needs SIGKILL.
- **Rust** failed every cell with more than one worker in the baseline. At 64 workers, the heartbeat
  connections held the whole pool, no claim started, and the probe needed SIGKILL. Now it passes all
  15 cells, with one listener connection outside the pool and one observed heartbeat-role
  connection.
- **The JVM** failed every cell with more than one worker in the baseline. It lost 343 leases in
  the 64-worker cells. Now it passes all 14 healthy cells and records no lost lease. Its fault cell
  does not pass, as the section above explains.

## What this does not measure

The run used one process, one pool, and one machine with no network between the workers and
PostgreSQL. It did not measure more than 64 workers or more than 25 tasks for each worker. It did not
measure a loaded database, a connection pooler, mixed heartbeat intervals, or several processes on
one database.

The fault cell ends one backend. It does not make the database unreachable, so it does not test a
failed connection attempt or a retry with backoff. The
[fault cell limits](../benchmarking.md#fault-cells) give the details.

These results are not a production capacity limit.
