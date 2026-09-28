# Dependency release guard

Before a dependent leaves `blocked` because its counter reached zero, `resolve_dependents_many_v1`
now probes `task_dependency_dependent_pending_idx` for an edge that is still pending. A healthy
release always takes that probe and never finds an edge. The probe exists for the drifted case: a
counter that reaches zero one edge early would otherwise release the dependent before a
prerequisite settled.

The probe costs a measurable but small amount. On PostgreSQL 18.6 and 15.19, a call releasing one
dependent took 8 to 11 µs longer, about 2 to 3 percent. A call releasing 100 dependents took 60 to
75 µs longer, about 1 percent or under 1 µs per release. The last edge of a dependent with 100
prerequisites took about 57 µs longer, about 5 percent. SM-937 keeps the guard: no case adds more
than about 0.08 ms to a call whose writes already take 0.4 to 8 ms.

## Method

`pnpm benchmark:dependency-release-guard` installs the schema, then copies the installed resolver
with `pg_get_functiondef` under the name `resolve_dependents_many_unguarded_bench`, with the probe
removed. The copy is the control, and the benchmark drops it when it finishes. The benchmark fails
if the installed resolver has no probe to remove.

It loads three shapes, each followed by `VACUUM ANALYZE`:

| Shape     | Fixture                                                 | Releases per call |
| --------- | ------------------------------------------------------- | ----------------: |
| `single`  | one prerequisite with one dependent                     |                 1 |
| `fan-out` | one prerequisite with 100 dependents                    |               100 |
| `fan-in`  | one dependent of 100 prerequisites, 99 already resolved |                 1 |

Every call resolves the fixture's prerequisite as `succeeded` inside a transaction that rolls back,
so each sample starts from the same rows. The benchmark checks that every call released the
expected number of dependents. Each shape ran 10 warmup calls per series, then 5 rounds of 100 calls
per series. The two series alternate call by call, and the order reverses every other call. Each
round starts with `VACUUM` and records the one-minute load average at its start and end.

The development host runs other checkouts at the same time, so each run used a dedicated server.
One `postgres:<major>-alpine` container per run was pinned to 4 of the host's 32 logical CPUs, with
a 4 GB memory limit and `shared_buffers` of 1 GB. The benchmark process was pinned to 4 other CPUs.
Three invocations each ran PostgreSQL 18.6 and 15.19 in turn, and each container was removed after
its run. The runs installed this change as schema version 36, before it moved to version 38 behind
the SM-950 plan setting. Both variants therefore planned the resolver's statements on every call. The host's one-minute load average stayed between 1.4 and 2.6
across all rounds. The complete machine-readable result of all six runs is
[`2026-09-27-dependency-release-guard.json`](results/2026-09-27-dependency-release-guard.json).

## Results

Mean call latency in milliseconds, averaged over the three invocations. The ratio is the guarded
mean divided by the control's mean within the same round, averaged over rounds and invocations.

| PostgreSQL | Shape     | Guarded | Unguarded | Added (µs) | Ratio | Per-invocation ratios |
| ---------- | --------- | ------: | --------: | ---------: | ----: | --------------------- |
| 18.6       | `single`  |   0.378 |     0.367 |         11 | 1.031 | 1.034, 1.030, 1.029   |
|            | `fan-out` |   7.381 |     7.321 |         60 | 1.008 | 1.010, 1.007, 1.008   |
|            | `fan-in`  |   1.293 |     1.235 |         58 | 1.047 | 1.054, 1.044, 1.044   |
| 15.19      | `single`  |   0.418 |     0.410 |          8 | 1.019 | 1.026, 1.007, 1.023   |
|            | `fan-out` |   8.339 |     8.264 |         75 | 1.009 | 1.009, 1.007, 1.011   |
|            | `fan-in`  |   1.269 |     1.212 |         57 | 1.047 | 1.045, 1.045, 1.048   |

The three invocations agreed, and the cost sits outside run-to-run noise. Every `fan-out` and
`fan-in` round on both versions was slower guarded than unguarded. `single` rounds ranged from 0.96
to 1.06, so one round cannot resolve its cost, but every invocation's mean ratio was above 1.

Run alone as a generic plan after 99 of 100 edges resolved, the probe is an index-only scan of the
partial index that hits 2 shared buffers and executes in about 0.013 ms on PostgreSQL 18. That is
less than the 57 µs `fan-in` adds inside the resolver. This benchmark does not isolate the
difference.

## What this does not measure

The benchmark runs one resolution at a time. It does not measure concurrent resolutions of edges
into the same dependent, which contend on the dependent's runtime row whether or not the guard
runs. It resolves one prerequisite per call, not a batch of completions. It does not measure a
drifted counter, where the probe finds an edge and the recount runs; that path is correct rather
than fast. It skips PostgreSQL 16 and 17.
