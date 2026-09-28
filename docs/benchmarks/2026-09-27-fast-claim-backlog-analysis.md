# Fast claim over a delayed backlog

A delayed fast-tier task waits in `ready` with a future `run_at`, so the fast claim reads past it.
How far it reads depends on the PostgreSQL major version. On PostgreSQL 18, a million delayed rows
above the due work added about 0.07 ms to a claim, and a million delayed rows with nothing due added
about 0.16 ms. On PostgreSQL 17 and 15, the same claims walked the whole backlog: 30 to 43 ms with
due work underneath, and 32 to 48 ms with nothing due.

The difference is the btree skip scan that PostgreSQL 18 added. The candidate query of
`fast_claim_v1` reads `fast_task_runtime_ready_idx` in `priority DESC, run_at, sequence` order and
keeps rows whose `run_at` has arrived. Within one priority the due rows come first, so the claim
only passes over delayed rows at priorities above the highest due row. PostgreSQL 18 skips each such
priority with one index descent. Earlier versions read every delayed index entry at those
priorities.

[ADR 0080](../decisions/0080-keep-delayed-fast-tier-tasks-in-the-ready-index.md) records the
decision this evidence supports.

## Method

`pnpm benchmark:fast-claim-backlog` installs the schema and loads four fast-tier queues into one
`fast_task_runtime` table, so every series reads the same index. Delayed rows run one day ahead,
due rows ran one minute ago, and priorities spread evenly within each band:

| Series         | Delayed rows at priority | Due rows at priority | Role                       |
| -------------- | ------------------------ | -------------------- | -------------------------- |
| `above`        | 51 to 100                | 0 to 50              | treatment                  |
| `below`        | 0 to 49                  | 50 to 100            | control for `above`        |
| `delayed-only` | 0 to 100                 | none                 | treatment                  |
| `empty`        | none                     | none                 | control for `delayed-only` |

`above` and `below` hold the same rows with the bands swapped, and each has 200 due rows. Each
backlog size loads anew: 1,000, 10,000, 100,000, and 1,000,000 delayed rows per queue, followed by
`VACUUM ANALYZE`.

Every claim calls `claim_many_v1` with a limit of 1 inside a transaction that rolls back, so each
sample starts from the same rows. Each backlog size ran 5 warmup claims per series, then 5 rounds
of 40 claims per series. The series alternate claim by claim, and the order reverses every other
claim. Each round records the one-minute load average at its start and end. The benchmark checks
that `above` and `below` claim a task every time and that the other two claim nothing. One more
claim per series runs the candidate query under `EXPLAIN (ANALYZE, BUFFERS)` as a generic plan,
the plan `fast_claim_v1` uses.

The development host runs other checkouts at the same time, so each run used a dedicated server.
One `postgres:<major>-alpine` container per run was pinned to 4 of the host's 32 logical CPUs, with
a 4 GB memory limit and `shared_buffers` of 1 GB. The benchmark process was pinned to 4 other CPUs.
Three invocations each ran PostgreSQL 18.6, 17.11, and 15.19 in turn, and each container was
removed after its run. The host's one-minute load average stayed between 2.7 and 11.0 across all
rounds. The complete machine-readable result of all nine runs is
[`2026-09-27-fast-claim-backlog.json`](results/2026-09-27-fast-claim-backlog.json).

## Results

Mean claim latency in milliseconds, averaged over the three invocations. The treatment ratio is the
treatment's mean divided by its control's mean within the same round.

| PostgreSQL | Delayed rows | `above` | `below` | Ratio | `delayed-only` | `empty` | Ratio |
| ---------- | -----------: | ------: | ------: | ----: | -------------: | ------: | ----: |
| 18.6       |        1,000 |   0.184 |   0.170 |  1.09 |          0.104 |   0.083 |  1.25 |
|            |       10,000 |   0.214 |   0.168 |  1.27 |          0.209 |   0.079 |  2.65 |
|            |      100,000 |   0.234 |   0.176 |  1.33 |          0.199 |   0.084 |  2.39 |
|            |    1,000,000 |   0.261 |   0.194 |  1.38 |          0.249 |   0.089 |  2.81 |
| 17.11      |        1,000 |   0.178 |   0.160 |  1.12 |          0.102 |   0.078 |  1.31 |
|            |       10,000 |   0.315 |   0.158 |  1.99 |          0.235 |   0.078 |  3.03 |
|            |      100,000 |   1.890 |   0.190 |  9.96 |          1.841 |   0.094 | 19.64 |
|            |    1,000,000 |  29.664 |   0.381 | 79.56 |         32.026 |   0.187 | 174.7 |
| 15.19      |        1,000 |   0.202 |   0.169 |  1.19 |          0.121 |   0.084 |  1.45 |
|            |       10,000 |   0.439 |   0.163 |  2.70 |          0.380 |   0.079 |  4.81 |
|            |      100,000 |   3.278 |   0.269 | 15.01 |          3.197 |   0.094 | 34.11 |
|            |    1,000,000 |  42.880 |   0.421 | 103.2 |         48.390 |   0.211 | 232.0 |

The candidate plan shows why. On PostgreSQL 18 at 100,000 rows and above, the `above` scan made 51
index searches, one per priority from 100 down to the first due row, and hit 155 to 206 shared
buffers. The `delayed-only` scan made 102 searches and hit 306 to 408 buffers. At 1,000 rows the
scan made a single search and read the backlog directly. On PostgreSQL 17 and 15 every scan made
one search, and at a million rows `above` hit about 10,700 buffers and `delayed-only` about 12,200.
The `below` scan hit 4 to 6 buffers on every version and size.

The three invocations agreed. Every ratio stayed within 13 percent of its three-run mean. The widest
spread was PostgreSQL 17 at a million rows, where the host load reached 11.0 and the `delayed-only`
ratio ranged from 160 to 197.

The `below` control also grew with the backlog on PostgreSQL 17 and 15, from about 0.16 to 0.4 ms.
Its candidate scan read 4 to 6 buffers throughout, so that scan does not explain the growth.

## What this does not measure

The benchmark runs one claim at a time with a limit of 1. It does not measure concurrent claims on
the same queue, which each repeat the walk, nor a batch claim, which walks once for its whole limit.
It holds the backlog still, so no delayed row comes due during a run, and no completion deletes a
row while the index grows. It skips PostgreSQL 16, which lacks skip scan just as 15 and 17 do.
It measures one priority spread. A backlog on fewer priorities than the 50 or 101 used here needs
fewer descents on PostgreSQL 18, and costs PostgreSQL 15 through 17 the same walk.
