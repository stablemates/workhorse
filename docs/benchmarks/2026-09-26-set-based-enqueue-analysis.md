# Set-based enqueue

Writing a batch's rows with one statement per table made a full-tier enqueue about two to five
times faster. Migration 0027 moved the inserts out of the request loop. Before it, a batch of 1,000 tasks
took a median of 222 ms. After it, the same batch took 68 ms. The gain grows with batch size. For
dependents, the change also removed an unstable cost: before it, the dependency trigger ran once
per request, and its plan could make one batch of dependents 50 times slower. The current schema,
version 31, keeps the whole gain.

[SM-911](https://linear.app/stablemates/issue/SM-911) made the change and measured it ad hoc. This
run repeats that comparison with the arms alternating in one invocation and a control on every
sample.

## Method

`pnpm benchmark:set-based-enqueue` built three arms on the benchmark database of one checkout:

- **Version 26** inserts each request's rows as the request loop reaches it.
- **Version 27** buffers the rows and writes each table once, after the loop.
- **Version 31** is the current schema.

Each arm starts from the frozen 0.4.0 release, `sql/releases/0024.sql`, and applies the migration
chain up to its version. That includes the contract step 0025, applied as a confirmed operator
would. Each arm was measured on the four shapes SM-911 used:

- 100 tasks in batches of 25.
- 1,000 tasks in batches of 100.
- 1,000 tasks in one batch.
- 100 dependents of one prerequisite in batches of 25. The prerequisite is enqueued before timing
  starts, and each sample gets a fresh one.

A sample is the time to enqueue the scenario's tasks through `enqueue_many_v1`, summed over its
calls. Each sample is followed on the same connection by a control: a plain multi-row `INSERT` of
the same row count into a table without triggers. The control shows how busy the host was at that
moment.

The run had 8 rounds. Each round rebuilt every arm and measured 10 samples of each scenario after 2
warmups, giving 80 samples per arm and scenario. The arm order reversed every round, so drift in
host load reached every arm alike. PostgreSQL 18.6 ran on a 32-CPU host that was also serving other
worktrees. Its 1-minute load average was 12.2 when the run started and 20.7 when it ended; each
round's load is in the JSON.

The complete machine-readable result is
[`2026-09-26-set-based-enqueue.json`](results/2026-09-26-set-based-enqueue.json).

## Results

Median milliseconds per sample, with each arm's median divided by version 26's median:

| Scenario                        | v26 (row at a time) | v27 (set-based) | v31 (current) | v27 / v26 | v31 / v26 |
| ------------------------------- | ------------------: | --------------: | ------------: | --------: | --------: |
| 100 tasks in batches of 25      |                30.7 |            17.0 |          16.2 |      0.55 |      0.53 |
| 1,000 tasks in batches of 100   |               240.3 |            87.7 |          83.8 |      0.36 |      0.35 |
| 1,000 tasks in one batch        |               222.2 |            68.2 |          67.9 |      0.31 |      0.31 |
| 100 dependents in batches of 25 |               182.0 |            38.7 |          33.5 |      0.21 |      0.18 |

The control medians stayed close across the arms. For the three plain scenarios they differed by
at most 0.4 ms, and dividing each sample by its own control moved no ratio by more than 0.06. The
dependents scenario's control ran slower in the version 26 arm, 1.46 ms against 1.07 to 1.11 ms.
Its control-normalized ratios are 0.32 for version 27 and 0.27 for version 31. The next section
explains why that scenario's ratio is unstable anyway. Every control-normalized ratio is in the JSON as
`relativeToBaseline.controlNormalized`.

The table reports medians because the host stalled several times during the run. The slowest
sample of a series took up to 11.6 times its median, and a mean follows such a sample. The means,
extremes and 95 percent intervals are in the JSON.

Three of the four ratios match SM-911's ad hoc figures of 0.54, 0.37 and 0.34. The dependents
ratio does not: SM-911 measured 0.65. Both runs measured version 27 at 39 to 48 ms. They
disagree on version 26, which took 74 ms in SM-911 and 182 ms here.

## Why the dependents ratio is unstable

`validate_task_dependencies_v1` is a statement trigger on `workhorse.task_dependency`. Each firing
walks the component around every inserted edge. Version 26 inserts one edge per statement, so 100
dependents fire the trigger 100 times. Version 27 fires it once per batch. The walk's plan depends
on the table's size and on its statistics, so version 26 multiplies any change in that plan by the
number of dependents.

A follow-up probe showed this directly. It enqueued 100 dependents of one prerequisite in batches
of 25, 15 times per series, on one arm without rebuilding it. It had no control and ran on a loaded
host, so read its figures as direction only:

| State of the arm                              |    Version 26 |  Version 31 |
| --------------------------------------------- | ------------: | ----------: |
| Freshly built                                 | 347 to 806 ms | 34 to 65 ms |
| Later series, same statistics                 | 145 to 180 ms | 20 to 21 ms |
| After `ANALYZE`, with 13,700 dependency edges |  8.0 to 8.6 s | 50 to 58 ms |

Version 26's time for the same scenario spanned a factor of 60. Spreading the dependents over one
prerequisite per batch did not reduce the spread. So a single ratio against version 26 describes the
state of the arm, not the change. The durable result is that version 27 and later stay within tens
of milliseconds in every state measured. [SM-952](https://linear.app/stablemates/issue/SM-952) tracks whether that holds for much larger
dependency tables.

## What this does not measure

The benchmark enqueues from one connection at a time. It does not measure concurrent producers,
which contend for the prerequisite locks the request loop takes. Nor does it measure enqueues that
use idempotency, debounce or throttle. The fast tier, which 0027 did not change, is out of scope.
