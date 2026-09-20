# Saturated claim locking

A claim on a queue whose keys were all at capacity admitted nothing and still locked 100 ready rows,
writing 101 WAL records and 5.5 KB of WAL. Locking only the candidate the claim admits removed both:
the same claim now locks no row and writes one WAL record of 54 bytes. A claim that does admit a
task dropped from 100 row locks to 1, and from 111 WAL records to 12. The refused claim also came
back a little sooner, by about 0.05 ms; an admitting claim took the same time as before.

The repetition is what made the waste matter. Every completion on such a queue notifies every
worker, so the refused claim runs once per worker per completion while the keys stay saturated.

## Method

`pnpm benchmark:saturated-claim` loaded one queue, `saturated-claim`, with a concurrency policy of
`maxActivePerKey` 1 over 40 keys. Each key held one active lease and four ready rows, so 160 ready
rows sat behind 40 saturated keys and the 100-row admission window reached only saturated work. The
**saturated** series measured that refused claim. The **admitting** series then released key 24, the
last key whose ready rows still fall inside the window, so every claim admitted a task only after
passing over the rows of every key still at capacity.

Each series ran 60 measured claims after 2 warmups. Every claim ran inside its own transaction that
rolled back, so each sample started from the same rows. While that transaction stayed open, a second
connection counted the queue's ready rows it could not take with `FOR UPDATE SKIP LOCKED`; that
count is the row locks the claim held. A second claim of each sample ran under
`EXPLAIN (ANALYZE, WAL)`, which attributes WAL to the backend that ran it. The WAL insert position
does not: it advances for the whole cluster. Node instrumentation inflates its own timing, so
latency came from the plain call. PostgreSQL 18.6 ran the benchmark database of one checkout.

Before and after ran back to back on the same database, twice, by installing the schema of each
version in turn: version 20 for the window lock and version 21 for the candidate lock. The complete
machine-readable result of version 21 is
[`2026-09-20-saturated-claim.json`](results/2026-09-20-saturated-claim.json).

## Results

| Series                 | Measure      | Window lock (v20) | Candidate lock (v21) |
| ---------------------- | ------------ | ----------------: | -------------------: |
| Saturated, admits none | Row locks    |               100 |                    0 |
|                        | WAL records  |               101 |                    1 |
|                        | WAL bytes    |             5,454 |                   54 |
|                        | Latency mean |           0.45 ms |              0.39 ms |
| Admits a task          | Row locks    |               100 |                    1 |
|                        | WAL records  |               111 |                   12 |
|                        | WAL bytes    |             6,453 |                1,107 |
|                        | Latency mean |           0.58 ms |              0.58 ms |

Row locks and WAL records held their values on every sample of every run. WAL bytes report the
minimum, because a full-page image after a checkpoint adds up to 8 KB to whichever sample touches a
page first. Latency reports the mean of two runs per version. The refused claim was faster on both
runs of the candidate lock, though the 95 percent intervals of the two versions still touch, so
treat the direction as established and the size as approximate. The admitting series did not
separate the versions at all.

The twelve WAL records of an admitting claim are the work of the claim itself: the lock on the
candidate, the runtime update, the claim event, and their index entries. The one record of a refused
claim is the fence sequence, which `claim_one_v1` draws before it reads its window.

## What this does not measure

The benchmark runs one claim at a time. It does not measure how claims of the same queue interleave,
which the row lock also affected: a claim that locked its whole window forced every concurrent claim
of that queue to look past those rows. Nor does it measure the wake-up traffic that makes the
refused claim repeat, which [SM-801](https://linear.app/stablemates/issue/SM-801) names but does not
change.
