# Benchmark suite v3 runbook

This runbook explains how to execute Workhorse's benchmark suite, preserve reproducible evidence, and interpret results without making unsupported performance claims.

## Recorded evidence

- [2026-10-21 connection budget baseline analysis](benchmarks/2026-10-21-connection-budget-baseline-analysis.md): the listener and heartbeat connections of each SDK on one pool before SM-1565, and the result of each cell against the held-task thresholds.
- [`results/2026-10-21-connection-budget-baseline/`](benchmarks/results/2026-10-21-connection-budget-baseline/): one `full`-profile artifact for each of the eight SDK variants, with load averages.
- [2026-10-11 checkpoint replay analysis](benchmarks/2026-10-11-checkpoint-replay-analysis.md): what a full-tier handler pays to replay 0 to 10,000 stored checkpoints on each pass after a durable wait, for SM-1209.
- [`results/2026-10-11-checkpoint-replay.json`](benchmarks/results/2026-10-11-checkpoint-replay.json): three sequential `full`-profile invocations of the `checkpoint-replay` scenario, with load averages.
- [2026-09-27 dependency release guard analysis](benchmarks/2026-09-27-dependency-release-guard-analysis.md): what the pending-edge probe before a zero-counter release costs `resolve_dependents_many_v1` on PostgreSQL 18 and 15, for SM-937.
- [`results/2026-09-27-dependency-release-guard.json`](benchmarks/results/2026-09-27-dependency-release-guard.json): three alternating invocations per PostgreSQL version, with per-round load averages.
- [2026-09-27 fast claim backlog analysis](benchmarks/2026-09-27-fast-claim-backlog-analysis.md): fast-tier claim latency with up to a million delayed rows above due work on PostgreSQL 18, 17, and 15, interpreted in [ADR 0080](decisions/0080-keep-delayed-fast-tier-tasks-in-the-ready-index.md).
- [`results/2026-09-27-fast-claim-backlog.json`](benchmarks/results/2026-09-27-fast-claim-backlog.json): three alternating invocations per PostgreSQL version, with per-round load averages and candidate plans.
- [2026-09-20 saturated claim analysis](benchmarks/2026-09-20-saturated-claim-analysis.md): row locks, WAL records, and latency of a claim on a queue whose keys are all at capacity, before and after the claim locked only the candidate it admits.
- [`results/2026-09-20-saturated-claim.json`](benchmarks/results/2026-09-20-saturated-claim.json): refused and admitting claim series on the schema that locks only the candidate.
- [2026-09-16 tenant cardinality analysis](benchmarks/2026-09-16-tenant-cardinality-analysis.md): claim admission, tag filter, budget, and health cost from 100 through 100,000 tenants on one queue, interpreted in [ADR 0069](decisions/0069-isolate-tenants-by-database-and-carry-tenant-identity-as-task-metadata.md).
- [`results/2026-09-16-tenant-cardinality.json`](benchmarks/results/2026-09-16-tenant-cardinality.json): keyed and budgeted profile artifact with plan node types and relation sizes per rung.
- [`results/2026-08-24-dashboard-read-surface.json`](benchmarks/results/2026-08-24-dashboard-read-surface.json): loaded dashboard plans plus WH-388 task and queue request comparisons with statement counts and latency percentiles.
- [2026-08-14 dependency operations smoke analysis](benchmarks/2026-08-14-dependency-operations-smoke-analysis.md): fan-in, cancellation policy, dependency health, and claim-plan cost against retained terminal history.
- [`results/2026-08-14-dependency-operations-smoke.json`](benchmarks/results/2026-08-14-dependency-operations-smoke.json): provenance-bearing dependency operations smoke artifact on PostgreSQL 18.
- [2026-08-14 coalescing ingress analysis](benchmarks/2026-08-14-coalescing-ingress-default-analysis.md): concurrent idempotency, debounce, and throttle cohorts with lifecycle, notification, index, and cleanup evidence.
- [`results/2026-08-14-coalescing-ingress-default.json`](benchmarks/results/2026-08-14-coalescing-ingress-default.json): default-profile coalescing ingress artifact on PostgreSQL 18.
- [2026-08-14 batch dispatch analysis](benchmarks/2026-08-14-batch-dispatch-default-analysis.md): serial and batched handler cohorts, full and partial dispatch, policy accounting, mixed outcomes, and isolated lease recovery.
- [`results/2026-08-14-batch-dispatch-default.json`](benchmarks/results/2026-08-14-batch-dispatch-default.json): default-profile batch dispatch artifact on PostgreSQL 18.
- [2026-08-14 priority dispatch analysis](benchmarks/2026-08-14-priority-dispatch-default-analysis.md): strict ordering, FIFO baseline cost, retained-history claim-plan bounds, and explicit starvation under replenished urgent work.
- [`results/2026-08-14-priority-dispatch-default.json`](benchmarks/results/2026-08-14-priority-dispatch-default.json): default-profile priority dispatch artifact on PostgreSQL 18.
- [`results/2026-08-12-dashboard-read-surface.json`](benchmarks/results/2026-08-12-dashboard-read-surface.json): loaded direct SQL, versioned view, and SQL-function plans for representative dashboard reads, interpreted in [ADR 0027](decisions/0027-keep-versioned-dashboard-views.md).
- [`results/2026-08-12-retention-strategies.json`](benchmarks/results/2026-08-12-retention-strategies.json): sustained partition-drop against row-delete-and-vacuum retention ladder, interpreted in [ADR 0026](decisions/0026-keep-daily-history-partitions.md).
- [`results/2026-08-12-schedule-cadence-default.json`](benchmarks/results/2026-08-12-schedule-cadence-default.json): loaded recurring-schedule cadence at the default maintenance interval for a worker, interpreted in [ADR 0025](decisions/0025-worker-schedule-cadence.md).
- [`results/2026-08-11-metrics-lifecycle.json`](benchmarks/results/2026-08-11-metrics-lifecycle.json): eager against lazy metric instrument lifecycle, per-emission cost and late-provider registration, interpreted in [ADR 0024](decisions/0024-metrics-instrument-lifecycle.md).
- [2026-08-10 payload-contract smoke analysis](benchmarks/2026-08-10-payload-contracts-smoke-analysis.md): contracted transition timings and redaction invariants without an overhead claim.
- [`results/2026-08-10-payload-contracts-smoke.json`](benchmarks/results/2026-08-10-payload-contracts-smoke.json): schema-v20 lifecycle smoke artifact for the extended `retry-paths` scenario.
- [`results/2026-08-10-notification-dispatch-smoke.json`](benchmarks/results/2026-08-10-notification-dispatch-smoke.json): notification-assisted dispatch smoke artifact comparing idle claims and enqueue-to-claim latency with polling-only dispatch.
- [`results/2026-07-22-runtime-pivot-v3-default.json`](benchmarks/results/2026-07-22-runtime-pivot-v3-default.json): prior v3 harness rerun against the live-runtime/cold-outcome schema.
- [2026-07-21 small-scale ladder](benchmarks/2026-07-21-small-scale-analysis.md): legacy v1 success-path results retained for historical comparison.
- [`results/2026-07-21-v3-smoke.json`](benchmarks/results/2026-07-21-v3-smoke.json): fresh v3 smoke artifact covering comparative and lifecycle suites.
- [`results/2026-07-21-v3-default.json`](benchmarks/results/2026-07-21-v3-default.json): clean-source v3 default artifact with batched ingress, counterbalanced paired runs, equal-load churn, and all lifecycle scenarios.
- [2026-07-21 v3 default-profile analysis](benchmarks/2026-07-21-v3-default-analysis.md): v2-to-v3 phase comparison, equal-load interpretation, WAL/storage limits, and architecture recommendation.
- [`results/2026-07-21-v2-default.json`](benchmarks/results/2026-07-21-v2-default.json): fresh v2 default-profile artifact with three repetitions at 1/4/8 workers, concurrent churn, and all lifecycle scenarios.
- [2026-07-21 v2 default-profile analysis](benchmarks/2026-07-21-v2-default-analysis.md): phase-level throughput diagnosis, paired comparisons, storage/WAL interpretation, churn limitations, and prioritized follow-up work.

## What v3 measures

V3 has two suites.

### Comparative suite

The comparative suite runs equivalent queue lifecycle semantics through two storage designs:

1. **Conventional:** a mutable lifetime task table with ready, scheduled, and expired-lease indexes plus event and attempt history.
2. **Hybrid/runtime:** stable task identity with a replaceable pending debounce definition, one live-only mutable runtime row, immutable terminal outcome, and append-only event and attempt history.

A seeded execution plan shuffles worker/repetition pairs and alternates which design runs first. The exact plan is recorded in `executionPlan`. For each pair, both designs are independently reset before measurement. The suite records:

- configurable `enqueueMany` batch size and the exact enqueue request count;
- enqueue, processing, and end-to-end duration plus phase-specific tasks/second;
- completed tasks per second;
- paired hybrid/conventional ratios and differences by worker level;
- raw client-observed claim latency samples and p50/p95/p99;
- Student-t 95% confidence intervals across independent repetitions;
- WAL bytes;
- per-relation heap, index, and total bytes;
- live/dead tuples, updates, HOT updates, deletes, vacuum, and analyze counters;
- schema totals;
- PostgreSQL activity before and after the run;
- `pg_stat_io` deltas where supported;
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the populated claim path.

The suite also performs equal-load fixed-rate producer-consumer churn. Both designs receive the same exact `targetTasks` at the same `targetRatePerSecond`; concurrent workers drain every task before the run can pass. It records production and drain duration, producer scheduling-lag distribution, maximum observed backlog, and exact completion. Telemetry runs on an independent scheduled task, not in the producer loop, and every sample records its own `sampleDurationMs`.

### Lifecycle suite

The lifecycle suite runs deterministic operational scenarios with hard invariants:

| Scenario                        | Evidence produced                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scheduled-promotion-drift`     | bounded promotion batches and due-time drift distribution                                                                                                                                              |
| `schedule-cadence-jitter`       | recurring fire-delay distribution, worst observed delay, durable occurrence uniqueness, and completed load tasks at the configured maintenance cadence                                                 |
| `heartbeat-fencing`             | accepted heartbeat cost and stale-fence rejection cost                                                                                                                                                 |
| `priority-dispatch`             | FIFO and mixed-priority claim distributions, throughput, retained-history plan bounds, ready-index size, and strict starvation under replenished urgent work                                           |
| `cancellation-lifecycle`        | immediate/waiting cancellation, active signal/ack, expiry materialization, stale races, truthful history, recurrence, and query timings                                                                |
| `deadline-timeout-lifecycle`    | pre-claim deadline exclusion, active abort delivery, timeout retry, stale-write fencing, distinct history, and health pressure                                                                         |
| `dead-letter-redrive-lifecycle` | cold failure cursor paging, side-effect-free preview, audited redrive, exact replay, immutable sources, and retained lineage                                                                           |
| `query-listing-lifecycle`       | dedicated routing projection, immutable cursor continuation, default payload omission, redaction before byte bounds, lifecycle-write independence, merged timeline, and operator-index storage         |
| `progress-lifecycle`            | fenced latest-value updates, identical-value no-op, frequency limit, stale-fence rejection, lookup provenance, terminal retention, and bounded event evidence                                          |
| `checkpoint-replay`             | save, list-query, and pass timings for each checkpoints-per-task count, replay share of the pass, list execution time, stored bytes, and one-list-per-replay invariants                                |
| `hot-task-group`                | drain time and tasks per second for one sealed task group and for the same tasks without a group, by worker count, with sampled waiters and lock wait on the group row and its shard rows              |
| `crash-before-completion`       | durable state at all five worker crash boundaries                                                                                                                                                      |
| `lease-expiry-recovery`         | recovery latency, new attempt/fence, and stale completion rejection                                                                                                                                    |
| `retry-paths`                   | overrides; fixed/exponential/jitter selection and provenance; deterministic replay; promotion and exhaustion; versioned contract validation and redaction timings                                      |
| `idempotent-ingress`            | exact replay, conflict rollback, same-batch duplicates, expiry reuse, and full transition timings/invariants                                                                                           |
| `coalescing-ingress`            | concurrent idempotent replay, debounce reset/preserve, throttle coalescing, durable effects, notifications, key-index size, and purge cost                                                             |
| `dependency-operations`         | fan-in release, maximum-width terminal fan-out settlement, concurrent enqueue into disconnected components, cancellation policy, dependency health, and claim-plan buffer cost around retained history |
| `retention-pruning`             | persisted-policy housekeeping, independent event/attempt retirement, and retained task identity                                                                                                        |
| `health-snapshot`               | single-statement snapshot latency, capped-scan flags, and machine-readable critical status reasons                                                                                                     |
| `worker-concurrency`            | 1/4/8-slot timing, equal-capacity single/balanced/distributed worker topologies, immediate/I/O-like profiles, start latency, query pressure, heartbeats, first-null, pause, and drain invariants       |
| `batch-dispatch`                | equal serial and batched cohorts, full and partial batches, mixed outcomes, per-task policy admission, claim cost, active slots, and isolated recovery                                                 |
| `notification-dispatch`         | polling-only versus notification-assisted idle claim pressure, enqueue-to-claim latency, completion, and bounded-fallback invariants                                                                   |
| `telemetry-context`             | equal-cohort enqueue and claiming timings with the OpenTelemetry SDK disabled and enabled, plus export, payload, and index invariants                                                                  |

Scenario invariant failures abort the suite. This prevents a fast but semantically incorrect run from being treated as evidence.

`priority-dispatch` compares equal FIFO and mixed-priority cohorts with four concurrent claimers and overlapping handler intervals. It then grows terminal history while holding live ready depth constant. The scenario records claim distributions, throughput, actual `claim_v1` buffer work, and ready-index bytes. A final phase replenishes urgent work before every claim and proves ordinary work remains ready. Its single-host timings describe this run only.

`query-listing-lifecycle` records client-observed page, payload projection, and timeline durations plus
projection row count and the dedicated operator indexes' measured bytes. These are diagnostic observations,
not latency targets or publication-grade scale claims. The scenario proves operator pages do not require
claim-critical indexes, payload is omitted unless explicitly requested, redaction precedes the response byte
ceiling, lifecycle transitions do not rewrite routing rows, and retained events and attempts share one cursor stream.

`progress-lifecycle` records full client-observed durations for the first accepted update, identical-value
no-op, frequency-limit rejection, second accepted revision, and latest-value lookup. Its invariants prove
stale-fence rejection, terminal retention, and one value-free lifecycle event per accepted change. These
small-run observations are diagnostics, not an update-latency or throughput claim.

`checkpoint-replay` runs one full-tier task for each count in `checkpointCounts`. Its handler saves
that many checkpoints, suspends on a durable wait, and replays them on each of
`checkpointReplayPasses` later passes. The `smoke` profile measures 0, 10, and 100 checkpoints, and
the `full` profile measures up to 10,000. Its timings describe the host that ran it, not a limit.

`hot-task-group` measures the counter shards of one task group under load. Each run enqueues
`hotGroupTasks` full-tier tasks, either as members of one sealed group or without a group. Then
each of `hotGroupWorkers` workers drains them with `hotGroupConcurrency` slots, its own pool, and a
handler that returns at once. Each member outcome locks its counter shard row, and it locks the
group row only when its shard reaches 0. A separate connection reads `pg_locks`, waits 5 ms, and
reads it again. It counts the backends that wait for the `task_group` row and, apart, the backends
that wait for a `task_group_shard` row. The scenario records the real interval between two samples.
A group run must sample a waiter on either kind of row when it has at least 100 tasks and more
worker slots than the group has counter shards. The run without a group must sample none. The
`full` profile drains 100,000 tasks, the member limit of ADR 0095, with 4, 16, and 32 workers. It
needs 353 free connections. If PostgreSQL has fewer, the scenario stops before the run starts. Its
timings describe the host that ran it, not a limit.

`hot-task-group` repeats each run `hotGroupRounds` times and alternates the order of the two
variants in each round. It summarizes each measure over the rounds with three metrics: `Median`,
`Min`, and `Max`. For an even count of rounds, the median is the mean of the two middle values. Thus
one slow round of two does not become the reported value. `TasksPerSecondRounds` lists the value of
each round. `WaitersPeak` is the most waiters that one sample of a round saw.
`GroupThroughputShare` divides the tasks per second with a group by the tasks per second without a
group in the same round, and the scenario summarizes these shares. The `full` profile runs 5
rounds, so one slow round on a loaded host cannot move the median. The `smoke` and `default`
profiles run 1 round. They prove the invariants, not the throughput.

`retry-paths` records the selected fixed, exponential, and decorrelated-jitter delays plus the
client-observed duration of each failure transition and their total. It also records enqueue, claim,
and completion timings for a versioned contract while proving that operator reads redact its configured
fields. These timings cover the full transitions rather than isolated policy or validation functions.
No numerical overhead claim is supported until an actual benchmark artifact is recorded.

`idempotent-ingress` records client-observed durations for initial keyed acceptance, exact replay,
conflict rollback, duplicate-key batch acceptance, first expiring acceptance, and reuse after expiry. Its
hard invariants verify stable replay identity; no duplicate task, binding, event, runtime, or FIFO state;
whole-batch conflict rollback; duplicate result ordering alongside unchanged unkeyed behavior; and transfer
of scoped ownership after expiry. These are full SQL transition timings. No latency or overhead number is
claimed until a benchmark artifact containing this scenario is recorded.

`coalescing-ingress` runs concurrent requests across bounded key sets for idempotency, debounce with
reset and preserve scheduling, and throttle. It records per-request p50/p95, retained-key index
size, ready notifications, and pending-task purge cost. Hard invariants compare structured outcomes
with accepted identities, live runtimes, FIFO placement, and lifecycle events. The scenario proves
serialization and durable bookkeeping for the sampled traffic. It does not prove exactly-once
handler effects, production latency, or a generally faster coalescing mode.

`cancellation-lifecycle` records client-observed full-transition timings for immediate ready,
scheduled, and durable-wait cancellation; active request, repeated request, exact-fence settlement,
ignored-signal expiry materialization, and terminal replay; plus bounded state/event queries and firing
the next recurring occurrence. Its hard invariants prove `heartbeat_v1` and `AbortSignal` delivery,
wrong/stale fence rejection, immutable first-committer-wins outcomes, one request/terminal event,
attempt-history truthfulness, no retry after an expired request, and schedule independence. These are
operational observations from a small deterministic scenario, not an SLA, throughput result, latency
target, forced-interruption guarantee, or exactly-once claim. No cancellation performance claim is
supported until a recorded artifact is published and interpreted in its environment.

`deadline-timeout-lifecycle` records bounded reaping of never-started expired work, cooperative
active-deadline delivery, one timeout-to-retry transition, late-completion fencing, and canonical
health pressure. Its hard invariants distinguish deadline and execution-timeout evidence from generic
lease expiry, prove that expired tasks are not newly claimed, and fence late completion after
terminalization. Cancellation precedence and cross-transition races remain covered by the live
PostgreSQL integration suite. The small timings are operational diagnostics only. No latency,
timeout-precision, or deployment-drain claim is supported until a live artifact is recorded and
interpreted with its platform grace periods.

`dead-letter-redrive-lifecycle` records client-observed failure-list, dry-run, single-redrive,
exact-replay, and bounded bulk-redrive durations. Its hard invariants prove that preview writes
nothing, fresh targets are ready with cleared absolute deadlines, source outcomes remain terminal,
replay creates no duplicate target, and every new identity has an audited retained lineage edge.
These small full-transition observations are diagnostics only, not a redrive throughput or latency
claim. No performance claim is supported until a live artifact is recorded and interpreted.

`worker-concurrency` seeds work before measurement, then times the complete worker run so no claim query is
excluded from the throughput window. It records 1/4/8-slot durations and derived tasks/second, maximum
handler and runtime-slot overlap, total and maximum-overlap query/claim pressure proxies, heartbeat calls,
and terminal lease health. Its 10 ms scenario poll interval models continuous refill truthfully: once the
seeded backlog is exhausted while handlers remain active, the fallback may issue one serial null claim per
elapsed polling window. The hard claim bound is successful tasks plus `ceil(durationMs / pollMs)` plus two
calls of endpoint/scheduling slack. It does not multiply polling pressure by configured concurrency. The
scenario also verifies that claim calls only occur with a free slot. Since ADR 0076 a worker keeps
overlapping claims in flight, so the scenario bounds them by `ceil(concurrency / refill batch)`
instead of requiring one at a time. Separate invariant
runs prove that one fill pass stops after its first null claim, pause issues no claims, and stop issues no
later claims while active handlers drain. The query counters are client-side pressure proxies, not PostgreSQL
connection-pool occupancy. No throughput, scaling, connection, or efficiency claim is supported until a live
artifact containing this scenario is recorded.

The same scenario compares equal total handler capacity using one multi-slot worker, a balanced two-worker
topology, and one single-slot worker per capacity unit. Each topology runs an immediate handler profile and
an I/O-like delayed profile. It records complete-run throughput, handler-start p50/p95/max, claim/query/
heartbeat pressure, maximum concurrent claims, and maximum handler overlap. Every topology uses the real
`Worker` runtime. These measurements cover process-local topology overhead, not operating-system process
isolation or global queue concurrency.

`batch-dispatch` runs equal serial and batched cohorts through the same `claim_v1` path. It records claim cost, throughput, batch sizes, dispatch wait, active slots, and terminal health.

Separate phases exercise mixed results, policy admission, and recovery of one expired member. Timings describe one local run and do not establish a production throughput advantage.

`notification-dispatch` holds polling-only and notification-assisted workers idle before enqueue,
then records empty claim calls and client-observed enqueue-to-claim latency. The smoke artifact
observed four empty polling claims versus zero notification-assisted claims in its short idle
window, and about 94 ms versus 28 ms enqueue-to-claim latency. These values prove the benchmark
wiring and the intended mechanism on one development machine; they are not production latency or
capacity claims.

`telemetry-context` records full enqueue and claiming durations for equal baseline and instrumented
cohorts. The instrumented cohort uses in-memory span and metric exporters, so the timings include
SDK recording and synchronous span export. Its hard invariants verify exports, payload isolation,
context recovery, equal completion counts, and the absence of a trace-context dispatch index. The
order is stable for reproducibility rather than counterbalanced for a publication claim, so cache
effects remain part of the observation. No overhead claim is supported until a live artifact
containing this scenario is recorded.

## Safety and prerequisites

Requirements:

- Node.js 22 or newer;
- pnpm;
- PostgreSQL 15 or newer;
- enough free disk and WAL capacity for the chosen profile.

The suite defaults to `workhorse_bench` and rejects database names without the `_bench` suffix. Override only with a benchmark-specific URL:

```bash
export DATABASE_URL_BENCH=postgres://workhorse:workhorse@localhost:5432/workhorse_bench
```

The benchmark resets Workhorse and benchmark-only tables while running. Never point it at production.

## Discover options

```bash
pnpm benchmark -- --help
```

Core options:

| Option               | Values                            | Meaning                                   |
| -------------------- | --------------------------------- | ----------------------------------------- |
| `--suite`            | `all`, `comparative`, `lifecycle` | Select the suite                          |
| `--profile`          | `smoke`, `default`, `full`        | Select a bounded configuration            |
| `--scenario`         | comma-separated names             | Run a lifecycle subset                    |
| `--seed`             | non-negative integer              | Seed the deterministic shuffled plan      |
| `--tasks`            | positive integer                  | Tasks per fixed comparative run           |
| `--enqueue-batch`    | positive integer                  | Tasks per `enqueueMany` request           |
| `--repetitions`      | positive integer                  | Independent repetitions                   |
| `--workers`          | comma-separated integers          | Worker-concurrency sweep                  |
| `--churn-rate`       | positive integer                  | Producer target tasks per second          |
| `--churn-tasks`      | positive integer                  | Exact churn tasks per design              |
| `--sample-ms`        | positive integer                  | Independent telemetry interval            |
| `--schedule-samples` | positive integer                  | Recurring fires sampled under worker load |
| `--output`           | path                              | Persist canonical deterministic-key JSON  |

## Profiles

| Profile   | Intended use           | Fixed runs                                        | Equal-load churn     |
| --------- | ---------------------- | ------------------------------------------------- | -------------------- |
| `smoke`   | correctness and wiring | 12 tasks, batch 4, 2 reps, workers 1/2            | 20 tasks at 40/s     |
| `default` | local evidence         | 100 tasks, batch 25, 3 reps, workers 1/4/8        | 500 tasks at 100/s   |
| `full`    | controlled evidence    | 1,000 tasks, batch 100, 5 reps, workers 1/4/16/32 | 6,000 tasks at 100/s |

Profile values are starting points, not universal publication standards. Use CLI overrides for the hardware and research question.

## Fresh smoke run

Always reset the benchmark database after schema changes:

```bash
pnpm db:reset:bench
pnpm benchmark -- \
  --profile smoke \
  --suite all \
  --output docs/benchmarks/results/v3-smoke.json
```

A valid artifact has `schemaVersion: 3`, comparative runs and summaries, two churn results, and all lifecycle scenario assertions passing.

Useful checks:

```bash
jq '{schemaVersion, suite, profile, environment}' docs/benchmarks/results/v3-smoke.json

jq '.comparative.summaries[] | {
  design,
  workers: .workerConcurrency,
  throughput: .throughputPerSecond,
  claim_p95: .claimLatencyMs.perRunP95
}' docs/benchmarks/results/v3-smoke.json

jq '.lifecycle.scenarios[] | {
  name,
  durationMs,
  assertions_passed: ([.assertions[].passed] | all)
}' docs/benchmarks/results/v3-smoke.json
```

## Focused runs

Comparative only:

```bash
pnpm db:reset:bench
pnpm benchmark -- --suite comparative --profile default --output comparative.json
```

A worker sweep with custom churn:

```bash
pnpm benchmark -- \
  --suite comparative \
  --profile smoke \
  --seed 42 \
  --tasks 500 \
  --enqueue-batch 50 \
  --repetitions 5 \
  --workers 1,4,16 \
  --churn-rate 200 \
  --churn-tasks 6000 \
  --sample-ms 1000 \
  --output worker-sweep.json
```

Lifecycle only or one scenario:

```bash
pnpm benchmark -- --suite lifecycle --profile smoke --output lifecycle.json
pnpm benchmark -- --suite lifecycle --profile smoke --scenario lease-expiry-recovery
pnpm benchmark -- --suite lifecycle --profile smoke --scenario idempotent-ingress
pnpm benchmark -- --suite lifecycle --profile smoke --scenario cancellation-lifecycle
pnpm benchmark -- --suite lifecycle --profile smoke --scenario worker-concurrency
pnpm benchmark -- --suite lifecycle --profile smoke --scenario batch-dispatch
pnpm benchmark -- --suite lifecycle --profile smoke --scenario notification-dispatch
```

## Canonical JSON contract

Top-level fields:

- `schemaVersion`: report contract version, currently `3`;
- `generatedAt`: client wall-clock timestamp;
- `suite` and `profile`: resolved run selection;
- `environment`: database name, PostgreSQL version, and material PostgreSQL settings;
- `provenance`: exact command arguments, Node/OS/CPU/memory runtime metadata, source commit, and dirty state across benchmark-affecting source/configuration paths, including untracked files but excluding generated result artifacts;
- `configuration`: comparative and lifecycle inputs;
- `comparative`: independent runs, confidence summaries, and churn telemetry when selected;
- `lifecycle`: scenario metrics and assertions when selected.

Raw claim samples and raw PostgreSQL plans are intentionally retained so derived metrics can be independently recomputed. Dates and big integers are serialized safely.

## Interpretation rules

- Compare distributions and confidence intervals, not the single fastest run.
- Treat WAL as cluster-wide. Other database writes contaminate the delta.
- Treat tuple statistics as estimates that may lag or change after vacuum.
- Confirm claim plans use `conventional_job_claim_idx` and `task_runtime_ready_idx` before comparing latency.
- A smoke run proves wiring and invariants, not production scalability.
- Run publication-grade tests on stable hardware without unrelated load and preserve raw JSON plus environment metadata.
- External side effects remain at least once. Queue benchmark success does not prove exactly-once delivery to HTTP, email, or payment providers.

## Continuous smoke benchmarks

`.github/workflows/benchmark.yml` runs the smoke profile weekly on Sunday at 06:17 UTC and on manual dispatch. It provisions PostgreSQL 18. The package script selects workspace source exports, so the workflow can run `pnpm db:reset:bench`, then:

```bash
pnpm benchmark -- --suite all --profile smoke --output benchmark-report.json
```

The task is capped at 30 minutes and the benchmark step at 20, so a scenario that waits on a task which never arrives fails the run instead of holding a runner.

Two things follow every run. A step summary renders each comparative group's mean throughput and per-run claim p95 with their 95% confidence intervals, plus every lifecycle scenario's duration and assertion verdict. The full canonical report is uploaded as the `benchmark-smoke-<run number>` artifact, retained for 90 days, and uploaded even when the run fails — a failing report is the evidence needed to diagnose the failure.

Before uploading, the workflow asserts the report is `schemaVersion: 3`, carries a source commit under `provenance`, contains comparative summaries and lifecycle scenarios, and that every lifecycle assertion passed. A run that produces a half-written report fails rather than publishing it as evidence.

When a scheduled run fails, the workflow opens a repository issue titled "Scheduled benchmark is failing", or comments on the open one. Nobody waits on a scheduled run, so that issue is the only signal that the smoke run has stopped passing.

The smoke run does not run on pull requests. A change to worker dispatch, claims, heartbeats, telemetry attributes, or the SQL schema can stop a scenario from starting or make an assertion stale. Before opening such a pull request, run the smoke profile against the checkout's bench database:

```bash
pnpm db:reset:bench
pnpm benchmark -- --suite all --profile smoke --output benchmark-report.json
```

A manual dispatch of the workflow on the pull request branch runs the same check in CI.

### Reading the trend

The workflow answers one question: does the harness still run green, and has anything changed by an amount too large to be noise? It does not answer how fast Workhorse is.

- **Assertions are the signal.** A lifecycle assertion that flips from passing to failing is a real regression at any profile. Investigate it directly.
- **Timings are not a signal on their own.** The smoke profile runs 12 tasks over 2 repetitions on a shared runner. Confidence intervals at that size routinely span more than the mean, and consecutive runs can differ by a factor of two with no code change between them.
- **Only act on a sustained shift.** Treat a timing change as worth investigating when several consecutive runs move the same way and the new interval does not overlap the old one. A single slow run is runner noise.
- **Never compare across environments.** Runner hardware, PostgreSQL image, and settings all vary. Compare a workflow artifact only with other workflow artifacts, and read `environment` and `provenance` before concluding anything.
- **Reproduce before recording.** A trend the workflow surfaces is a prompt to run `default` or `full` on stable hardware and record that artifact under `docs/benchmarks/`. The workflow artifact itself is never publication evidence.

The [interpretation rules](#interpretation-rules) above apply to these artifacts unchanged.

## Environment metadata

Alongside a publication artifact, capture at least:

```bash
node --version
pnpm --version
uname -a
lscpu
psql "$DATABASE_URL_BENCH" -Atc "SELECT version()"
psql "$DATABASE_URL_BENCH" -Atc "SELECT name || '=' || setting || COALESCE(unit, '')
  FROM pg_settings
  WHERE name IN (
    'shared_buffers', 'work_mem', 'maintenance_work_mem',
    'max_connections', 'autovacuum', 'autovacuum_naptime',
    'checkpoint_timeout', 'max_wal_size', 'synchronous_commit'
  ) ORDER BY name"
```

Also record storage type, VM/container status, concurrent workloads, held transactions, replication slots, and whether the database was freshly reset.

## Remaining evidence gaps

V2 closes the original equivalent-semantics, confidence interval, comparative-worker, churn, telemetry, and lifecycle-scenario gaps. Schema v11 adds invariant-gated `idempotent-ingress`, `worker-concurrency`, and `cancellation-lifecycle` coverage after the historical artifacts below were recorded. A commercial build decision still needs recorded live artifacts for those newer scenarios, larger retained-history horizons, deliberately held old snapshots or replication horizons, production-shaped payloads, reference-system comparisons, multiple PostgreSQL versions, and repeated runs on production-grade hardware.

## Troubleshooting

### Reset or benchmark refuses the database

Preserve the `_bench` suffix. Remote resets additionally require `WORKHORSE_ALLOW_REMOTE_RESET=1`.

### PostgreSQL statistics are unavailable

Run with a local development role allowed to read the required statistics. Do not broaden production privileges for this harness.

### Results vary

Caches, checkpoints, autovacuum, CPU frequency, storage contention, and other clients affect results. Increase repetitions, stabilize the environment, and compare distributions.

### A lifecycle scenario aborts

The scenario detected an invariant failure. Treat the run as invalid, inspect the named scenario and database state, fix correctness first, then rerun from a fresh database.

## Standalone metric lifecycle microbenchmark

`typescript/core/benchmarks/metrics-lifecycle.ts` compares the two metric instrument lifecycles core ships: the eager module-scope instruments in `typescript/core/src/metrics.ts` and the lazy, provider-change-aware instruments in `typescript/core/src/telemetry.ts`. It measures per-emission cost with telemetry off and on, and reports whether each lifecycle still reaches an OpenTelemetry SDK registered after the instrumentation module loaded.

```bash
pnpm benchmark:metrics-lifecycle -- --output docs/benchmarks/results/<date>-metrics-lifecycle.json
```

This benchmark needs no database and does not run under `pnpm benchmark`. Emission cost is nanoseconds per call, roughly four orders of magnitude below claim latency, so a throughput scenario cannot resolve the difference between the lifecycles; do not read one as evidence about them. [ADR 0024](decisions/0024-metrics-instrument-lifecycle.md) interprets the result.

## Connection budget benchmark

A worker holds connections that its handlers cannot use: the listener connection and the heartbeat
connection. The SDKs do not hold them in the same way. Some SDKs share one of each for all the
workers on a pool, and other SDKs hold one of each for each worker. The connection budget benchmark
measures what these connections cost in each SDK. It also measures whether leases renew in time
when several workers share one pool, whether workers continue to claim after tasks complete, and
how workers recover when they lose the heartbeat connection. Each cell gets a result from the
acceptance thresholds of SM-1565.

The benchmark measures from PostgreSQL. Thus one driver, `scripts/benchmark-connection-budget.ts`,
serves every SDK. It does not run under `pnpm benchmark`, and nothing in CI runs it.

### Run the benchmark

The benchmark uses the `DATABASE_URL_BENCH` database of the checkout. It drops and installs the
`workhorse` schema before each cell. It builds each probe with the toolchains that `mise.toml` pins.

1. Run the smoke profile for each SDK variant. It runs one cell of each kind and takes about
   2 minutes for one variant.

   ```bash
   pnpm benchmark:connection-budget -- --profile smoke
   ```

2. Run the full profile for one SDK variant at a time.

   ```bash
   pnpm benchmark:connection-budget -- --profile full --sdk go \
     --out docs/benchmarks/results/<date>-connection-budget-go.json
   ```

3. To run some cells only, give their ids to `--cells`, separated by commas.

   ```bash
   pnpm benchmark:connection-budget -- --profile full --sdk rust --cells starvation-w2-c1-p4
   ```

Run one benchmark at a time. The driver runs one cell at a time, but it cannot see a second driver.
`--no-build` uses the probe builds that exist. `--help` lists every option.

### What a cell does

A cell has W workers, a pool of P connections, concurrency C, heartbeat interval I, and lease L. A
cell has one of three kinds:

- A **held-task cell** holds every claimed task until the probe stops.
- A **refill cell** finishes each task after a fixed time, so the workers must claim again.
- A **fault cell** runs a refill workload and ends the heartbeat connection of the probe once.

The driver does these steps for each cell:

1. It ends each probe session that an earlier cell left open, and it records the session.
2. It drops and installs the schema. Then it enqueues tasks:
   - for a held-task cell, W × C tasks and 10% more, with a minimum of 2;
   - for a refill or a fault cell, W × C × the tasks for each slot.
3. It starts the probe of the SDK as a child process, in a process group of its own.
4. It samples the database every 250 ms and records the latest pool state that the probe reported.
   In parallel, the role sampler records what each probe connection runs, until the cell ends.
5. In a fault cell, it ends the heartbeat connection after the warm-up. The
   [fault cell](#fault-cells) section gives the steps.
6. It reads the claims, the closed attempts, and the completions of each task.
7. It sends SIGTERM to the process group of the probe. If the probe has not exited at the kill
   deadline, it sends SIGKILL.
8. It waits up to 10 s for the probe sessions to close. Then it ends each session that remains, and
   it records the session.
9. It gives the cell a result: pass, fail, or inconclusive.

A held-task cell ends when its measurement window closes. A refill cell ends when no task has been
ready or active for 1 s, or when its window closes. A fault cell ends 3 × I after the fault, or when
its window closes.

The driver always does steps 7 and 8, also when a step before them fails. If the driver gets SIGINT
or SIGTERM, it stops the probe before it exits. If a cell fails, the driver writes the artifact with
the cells that finished, and `aborted` gives the error. Each driver query has a timeout. A sample
query stops after 1 s, so a blocked query cannot keep a cell past its end.

Each probe starts W workers in one process on one pool. The payload of each task of a refill or a
fault cell has a `handlerMs` value. Its handler returns after that time. A task without the value
holds its slot. Every handler returns when the probe stops or the worker cancels the attempt, so
the stop time measures the SDK and not the handler. The probe does not set `sharedHeartbeats`,
`SharedHeartbeats`, or `shared_heartbeats`. Each pool opens a connection only when the SDK asks for
one, so the count shows what the SDK needs. Each probe sets a fixed `application_name`,
`wh-bench-<sdk>`, on every connection that it opens. The Rust probe gives each worker a
`listen_config` with the same name, so the Rust listener connections outside the pool also count.

The driver gives each probe these settings:

- `WH_BENCH_SHUTDOWN_GRACE_MS`: the shutdown grace, 10 s in every cell.
- `WH_BENCH_POLL_MS`: the polling interval, 1 s in refill and fault cells. A held-task cell keeps
  the default of the SDK.

The probe applies them, and its `started` event names the values that it applied. In Go, Ruby,
Rust, and the JVM, the grace is a worker option. The TypeScript and Python workers have no grace.
Their process runners, `runWorkerProcess` and `run_worker_process`, exit with status 1 when the
grace passes, and their probes do the same.

The kill deadline of the driver is the grace, plus the unwind window that the SDK documents, plus
5 s. A probe that is still running at the deadline gets SIGKILL. The driver records each unwind
window and its source in `settings.shutdown`:

| SDK variant                                     | Unwind window | Source                                                                    |
| ----------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `typescript`                                    | 0 ms          | `runWorkerProcess` exits at `shutdownTimeoutMs`                           |
| `go`                                            | 2,250 ms      | a 250 ms unwind, `deregister_worker_v1` and `UNLISTEN` for 1,000 ms each  |
| `ruby`                                          | 250 ms        | the unwind window, `UNWIND_WINDOW`                                        |
| `python-sync`, `python-async`, `python-asyncpg` | 0 ms          | `run_worker_process` exits at `shutdown_timeout_ms`                       |
| `rust`                                          | 1,250 ms      | `UNWIND_WINDOW`, then `CLEANUP_WINDOW`, which ends 1 s after the deadline |
| `jvm`                                           | 2,000 ms      | a complete shutdown can end up to about 2 seconds after `shutdownGrace`   |

The shutdown sections of [the schema and protocol reference](architecture/schema-and-protocol.md)
give each window.

Each probe writes the state of its pool to standard output as one JSON line every 250 ms. The probe
reads the state from inside its process, with the API of the pool. No SDK code changes for this.

| SDK variant      | Probe                                                                         | Pool state API                            |
| ---------------- | ----------------------------------------------------------------------------- | ----------------------------------------- |
| `typescript`     | `scripts/benchmark-connection-budget-probe.ts`                                | `totalCount`, `idleCount`, `waitingCount` |
| `go`             | `benchmarks/connection-budget/go-probe`, a separate Go module                 | `Stat()`                                  |
| `ruby`           | `ruby/tools/connection_budget_probe.rb`                                       | `size`, `available`, `idle`               |
| `python-sync`    | `python/tools/connection_budget_probe.py sync`, `Worker` on a psycopg pool    | `get_stats()`                             |
| `python-async`   | `python/tools/connection_budget_probe.py async`, `AsyncWorker.from_psycopg`   | `get_stats()`                             |
| `python-asyncpg` | `python/tools/connection_budget_probe.py asyncpg`, `AsyncWorker.from_asyncpg` | `get_size()`, `get_idle_size()`           |
| `rust`           | `rust/tools/connection-budget-probe`                                          | `status()`                                |
| `jvm`            | `jvm/connection-budget-probe`, on a HikariCP pool, started with `java -cp`    | `HikariPoolMXBean`                        |

Three pools count no callers that wait for a connection: pgxpool, connection_pool, and asyncpg.
Thus `waiting` is null for `go`, `ruby`, and `python-asyncpg`. For `go`, `waitedAcquires` gives the
acquires that had to wait since the probe started, from `EmptyAcquireCount`. The other variants
record null there.

No published package holds a probe. The Go probe is a separate module with a `replace` directive
to `go/`, so the release of the `go/` module does not hold it. The Python source distribution
excludes `tools/connection_budget_probe.py`. The gem holds only `lib/`, the Rust crate holds only
its `include` list, and the JVM probe project has no publication.

### Profiles

The warm-up starts when the probe starts. The measurement window follows the warm-up. A held-task
cell ends when the window closes. A refill cell or a fault cell can end before that, as
[What a cell does](#what-a-cell-does) states. A cell that stalls also ends when the window closes.

| Profile | Kind   | Cell ids                      | W            | C       | P        | I    | L    | Tasks per slot | Warm-up | Window |
| ------- | ------ | ----------------------------- | ------------ | ------- | -------- | ---- | ---- | -------------- | ------- | ------ |
| `smoke` | held   | `smoke-w2-c2-p20`             | 2            | 2       | 20       | 1 s  | 3 s  | -              | 5 s     | 15 s   |
| `smoke` | refill | `smoke-refill-w2-c2-p20`      | 2            | 2       | 20       | 1 s  | 3 s  | 10             | 5 s     | 55 s   |
| `smoke` | fault  | `smoke-fault-w4-c4-p20`       | 4            | 4       | 20       | 10 s | 30 s | 25             | 15 s    | 70 s   |
| `full`  | held   | `starvation-w2-c1-p4`         | 2            | 1       | 4        | 1 s  | 3 s  | -              | 10 s    | 30 s   |
| `full`  | held   | `capacity-w<W>-c<C>-p20`      | 1, 4, 16, 64 | 1, 25   | 20       | 1 s  | 3 s  | -              | 15 s    | 60 s   |
| `full`  | held   | `default-timing-w<W>-c25-p20` | 16, 64       | 25      | 20       | 10 s | 30 s | -              | 20 s    | 180 s  |
| `full`  | refill | `refill-w<W>-c<C>-p<P>`       | 2, 4, 16     | 1, 2, 4 | 4, 6, 20 | 1 s  | 3 s  | 20             | 5 s     | 85 s   |
| `full`  | fault  | `fault-w16-c4-p20`            | 16           | 4       | 20       | 10 s | 30 s | 25             | 15 s    | 70 s   |

The refill cells of the full profile are `refill-w2-c1-p4`, `refill-w4-c2-p6`, and
`refill-w16-c4-p20`. The small pools have few free connections after the reserved connections.
Thus these cells show whether claims continue when the pool is almost full.

The full profile has 15 cells and about 20 minutes of cell time for one SDK variant. Schema
installation, enqueue, and probe stop add about 10 s to each cell. Thus a full run of one SDK
variant takes about 23 minutes, when the machine guard does not wait.

### Refill cells

A refill cell tests whether the workers continue to claim after tasks complete. Every handler
returns after 1.2 s, so a heartbeat round renews each task at least once. Each slot has 20 tasks,
or 10 in the smoke profile, so each slot claims many times. The probe sets its polling interval to
1 s, because the default fallback poll of 5 s is as long as the claim gap limit.

The driver reads the time and the worker of each `claimed` event and of each closed attempt in
`workhorse.attempt_history`. Both times come from `clock_timestamp()`, so they are more exact than
the samples. It reads the start time of each worker from `started_at` in
`workhorse.worker_registry`. From these times, the driver replays the dispatch state once, for the
whole observation:

- A worker has its slots from its start, or from its first claim if that comes first.
- A claim takes one slot of its worker and one ready task.
- A closed attempt frees the slot of its worker. A retry or a lost lease makes its task ready
  again.
- A claim and a closed attempt at the same time are a fused completion. The closed attempt counts
  first.

The replay also reads the readiness of the heartbeat reservation. The benchmark has one pool
identity, so one heartbeat connection serves every worker. The reservation is ready while some
backend has the heartbeat role. At other times, for example before the first round or between a
closed heartbeat connection and its replacement, its state is unknown.

A claim gap is a time in which one worker has a free slot, a task is ready, and that worker claims
nothing. A claim of another worker does not end the gap. The gap ends at the next claim of the
worker, or when one of its conditions ends. The replay gives two gaps:

- the longest gap while the reservation was ready, from the observations;
- the longest gap while the reservation was ready or its state was unknown.

Thus the delay of a worker before its first claim counts, and the time after the last ready task
does not. The probe has no pauses, policy limits, or held claims in a refill cell, so no other time
is excluded.

`outcome.refill.certainGap` and `outcome.refill.possibleGap` give the two gaps, each with its start,
its end, and its worker. `readyIntervals` gives the times with an observed heartbeat role, and
`workers` gives the start of each worker. The driver also counts, for each task, its successful
attempts, its closed attempts, and its `claimed` events. `outcome.refill.perTask` gives each
combination with its count of tasks. `completedOnce` counts the tasks with one success, one
attempt, and one claim.

### Fault cells

A fault cell tests what the workers do when they lose the heartbeat connection. It runs at the
default timing, I = 10 s and L = 30 s. One task in four runs 15 s, so its lease needs renewal
through the fault. The other tasks run 1 s, so claims come often. The probe sets its polling
interval to 1 s.

The driver does the fault in these steps:

1. After the warm-up, it starts a PL/pgSQL function in `pg_temp` of a driver session. The function
   reads `pg_stat_activity` about every millisecond, with the heartbeat marker of the role sampler.
2. When a probe backend runs a heartbeat round, the function records the start of that round, the
   `xact_start` of the backend, and the other statements of the probe that are running. Then it
   ends the backend of the round with `pg_terminate_backend`. The round fails immediately, so the
   SDK knows of the loss at the time of the fault.
3. The function reads `pg_stat_activity` until each recorded statement has ended, for at most 3 s.
4. The driver ends each other backend that has the heartbeat role in the observations of the role
   sampler. No other probe backend ends.
5. The driver observes for 3 × I more.

If no round comes in 2 × I + 2 s, the function stops. The fault then ends only the backends that
have the heartbeat role, and `outcome.fault.searchTimedOut` is true.

The outage is the time without a usable heartbeat reservation. It starts at the fault. The driver
sorts each claim after the fault by the start of its claim function. The `expires_at` of the
`claimed` event is that start plus the lease:

- A claim whose claim function started before the fault came from a statement that started before
  it. It does not count.
- A claim whose claim function started before the recorded statements ended is unattributed. Such
  a statement started before the fault, but its claim function can start after a lock wait.
- Every other claim is fresh. If the function did not record the end of the statements, no claim
  is fresh.

The driver cannot see when the SDK reserves the replacement connection. It finds the first
heartbeat round on another backend after the fault, and that round is the upper bound. The lower
bound is the last time before that round at which the backend was in ordinary use, or its start.
Only a sample of a running statement, or the `state_change` of an idle sample, shows a use. An
idle backend keeps the text of its last statement, so that text alone does not move the bound. If
the backend shows no use after the fault, the lower bound is the fault itself.

The rule on claims in the outage has three results:

- It fails when a fresh claim came before the lower bound.
- It passes when no fresh and no unattributed claim came before the upper bound.
- In all other cases, the observations cannot decide it, and the rule is inconclusive.

After the replacement is ready, a free slot and a ready task must lead to a claim before the next
regular round. The SDK sends a regular round at its slot, and a busy retry runs between two slots.
The driver cannot prove when the next slot falls. A sampler of `pg_stat_activity` can miss any
round between two samples, so no sampled data shows the slot. The driver gives only the latest
possible next slot:

- If the fault interrupted a round, the latest possible slot is the start of that round plus I. A
  slot is never later than the start of a round that runs in it.
- Otherwise, the latest possible slot is the fault plus I. A round that the sampler did not see can
  move the slot past an older observation.

Thus the benchmark detects only a clear violation of the immediate dispatch wake. The positive
proof is the deterministic test "dispatch wakes on recovery". Each SDK pull request for SM-1565
must include that test, as its child issues require.

`outcome.fault.demand` gives the times in which some worker had a free slot and a task was
ready, from the same replay as a refill cell.

The watchdog runs inside the worker, and no driver data shows when it fired. The driver has these
records for each attempt:

- its claim, from its `claimed` event;
- its last accepted renewal and its lease deadline, from the last sample of `heartbeat_at` and
  `expires_at` in `workhorse.task_runtime` for its task and fence token. Only an accepted renewal
  changes these columns. A heartbeat statement in `pg_stat_activity` does not prove a renewal,
  because a round can fail or report a busy lease;
- its settlement in `workhorse.attempt_history`. For a lost lease, `finished_at` is when the
  database recovered the attempt, not when the worker ended it. The worker can end an attempt
  locally and early, and the database recovers it only after its deadline;
- whether it was live with an unexpired lease in the last sample.

`outcome.fault` gives these values:

- `atMs`, `inRound`, `roleBackends`, and `roleBackendsEndedMs`: the time of the fault, the
  backends that it ended, and when the driver ended the backends of step 4.
- `inFlight` and `inFlightEndedMs`: the statements that ran at the fault, and when they had all
  ended. `inFlightEndedMs` is null when a statement still ran after 3 s.
- `replacement`: the backend of the first round after the fault, with `readyNotBeforeMs` and
  `firstRoundMs`, the two bounds.
- `claimsFromStatementsBeforeFault`, `unattributedClaimsMs`, and `freshClaimsMs`: the claims after
  the fault by origin.
- `nextRound` and `demand`: the latest possible next regular slot, and the times with a free slot
  and a ready task.
- `watchdog` and `recoveries`: the counts of the watchdog rule, and each recovered attempt with its
  `finished_at` and the deadline of its last sample.
- `lastRoundBeforeFaultMs`: the last observed round before the fault. The interrupted round
  renews nothing. Thus a round on the backend of `inRound` counts only when it came at least I / 2
  before the fault.
- `firstClaimAfterReplacementRoundMs`: the delay from the first round on the replacement to the
  next claim.

Ending one backend does not make the database unreachable. This limit changes what the cell
measures:

- The other probe connections keep working. Thus an SDK can get a replacement connection
  immediately, and the outage can be a few milliseconds long.
- The database is reachable at the time of the fault. Thus the delay from recovery to the first
  claim is the delay from the fault.
- The cell does not test a failed replacement: a connection attempt that fails, and a retry with
  backoff.

A test of an unreachable database must stop the connections of the probe at the network or at the
server. This benchmark does not do that.

The cell has three other limits:

- It expects one heartbeat connection for each pool identity. If an SDK holds one for each worker,
  the driver ends them all, but it ends the others some milliseconds after the first. The role
  sampler can also miss a heartbeat connection that ran its first round less than 1 s before the
  fault.
- If an SDK runs a statement other than a heartbeat round on its replacement connection before the
  first round, the lower bound comes too late. Then a claim after the true ready time can count as
  a claim in the outage.
- The driver compares its own clock with `clock_timestamp()`, so PostgreSQL must run on the same
  host as the driver.

### Cell results

Each run has a `result`. Its `outcome` is `pass`, `fail`, or `inconclusive`. It names the
`failed` rules and the `inconclusive` rules, and it gives each rule with its values. A cell passes
only when every rule of its kind passes. It fails when one rule fails. It is inconclusive when no
rule fails, but the observations cannot decide one rule. The rules are the acceptance thresholds of
SM-1565.

An inconclusive result is not a pass. Treat it in this way:

1. Run the inconclusive cell again once. Use the driver with `--cells` and the id of that cell.
2. Record the first result and the reason for it in the Linear issue of the run.
3. If the second run is not a pass, the cell does not pass the acceptance.

A detection-only rule gives `violated` or `notDetected` in `detected` instead of `pass`. A
violation fails the cell. `notDetected` is not a pass, it does not make the cell inconclusive, and
it does not change the outcome.

A failed cell can also run once more. Record the anomaly and both results in the Linear issue of
the run.

A held-task cell has these rules:

1. **live leases**: W × C live leases at the end, no lost lease, and no expired active task in
   any sample.
2. **renewal age and margin**: the maximum sampled renewal age is below 2 × I, and the minimum
   sampled lease margin is above I.
3. **reserved backends**: the role sampler observes at most one listener connection and at most
   one heartbeat connection at one time in the window. The pool has one identity in each probe. A
   heartbeat count of `unknown` fails.
4. **no errors**: no `worker_error` event and no failed driver query.
5. **shutdown**: the probe exits with status 0 after SIGTERM, before the kill deadline. It writes
   no `worker_error` or `shutdown_incomplete` event after SIGTERM. Thus an incomplete drain fails
   in every SDK: Go, Ruby, Rust, and the JVM report it as an error, and the TypeScript and Python
   probes exit with status 1 at the grace.

A refill cell has these rules:

1. **complete once**: each enqueued task completed once, with one attempt and one claim. No
   active task and no ready task remain. No lease was lost, and no active task had an expired
   lease.
2. **claim gap**: the probe applied a polling interval of 1 s. The rule fails when a gap with the
   reservation ready is longer than 5 s. It is inconclusive when only a gap with an unknown
   reservation state is longer than 5 s.
3. Rules 3, 4, and 5 of a held-task cell.

A fault cell has these rules:

1. **no claim in outage**: the fault ended a heartbeat connection, and no claim came in the
   outage. The three results are above.
2. **lease loss in watchdog bound**: the watchdog of ADR 0071 and ADR 0105 ends an attempt only
   after one lease without an accepted renewal. The driver cannot see when a watchdog fired, so:
   - The rule fails when the database recovered an attempt before the deadline that its samples
     show.
   - Any other recovered attempt makes the rule inconclusive, because its local loss time is not
     known.
   - An attempt with no settlement proves nothing about an early local abort. It makes the rule
     inconclusive, unless it is live with an unexpired lease in the last sample and had an
     accepted renewal after the fault. A worker that ended it would not renew it.
   - An attempt that the worker settled with another outcome was not ended early.

   Thus the rule passes only when every attempt claimed before the last sample is settled or
   proven live. A cell with a lost lease is never a pass.

3. **claim after recovery**: the first fresh claim comes within 2 × I of the fault. If only an
   unattributed claim comes within that time, the rule is inconclusive.
4. **dispatch before next round**, detection only: the rule gives `violated` when no claim of
   either kind came before the latest possible next slot, although the replacement was ready and a
   worker had a free slot and a ready task at least 1 s before that slot. Otherwise it gives
   `notDetected`. A delayed dispatch that ends before the latest possible slot is not detected.
   The limit of 2 × I in rule 3 still applies.
5. **reserved after recovery**: from the first round on the replacement to the end, at most one
   listener and one heartbeat connection.
6. **no sample errors**: no failed driver query. The cell records worker errors, but a worker
   error does not fail it.
7. **shutdown**: as in rule 5 of a held-task cell.

The artifact also has a `summary` with one row for each cell, and the driver prints it at the end.
Each row gives these values:

- the result, which is `pass`, `FAIL`, or `inconclusive`, and the rules that failed, with `?` after
  a rule that is inconclusive;
- the live leases of a held-task cell, the tasks that completed once of a refill cell, or the
  claims of a fault cell;
- the lost leases and the most expired active tasks in one sample;
- the maximum renewal age and the minimum lease margin;
- the two claim gaps of a refill cell, with the reservation ready and with its state unknown;
- the fresh and the unattributed claims before the first round on the replacement, and the delay
  from the fault to the first fresh claim;
- the most listener and heartbeat connections at one time;
- the stop time, and whether the probe got SIGKILL.

### Machine guard

The machine is shared, so the load of other processes can change a result. Before each cell, the
driver reads the 1-minute load average and the available memory. If the load is above 16 or the
available memory is below 8 GB, the driver waits. It reads the values again every 15 s. The
artifact records the wait, each busy reading, and the values before and after each cell.

### Read the artifact

Each sample has two parts. The database part counts the sessions of the probe in
`pg_stat_activity`: in total, `active`, `idle`, `idle in transaction`, and the sessions whose last
statement is `LISTEN`. The pool part gives the latest pool state that the probe reported: the
connections that the pool holds, the idle connections, the checked-out connections, and the
callers that wait. `outOfPoolSessions` is the session count less the pool total. It counts the
Rust listener connections, and any connection that an SDK takes out of its pool.

Each sample also counts the active tasks, the active tasks whose lease is not expired, the active
tasks whose lease has expired, and the ready tasks. It counts the `claimed` events, which grow with
each claim, and the distinct tasks that a worker claimed. For each active task, it reads the renewal
age, `now - heartbeat_at`, and the lease margin, `expires_at - now`, from `workhorse.task_runtime`.
The `series` of each run keeps every sample, and `poolSeries` keeps every pool state.

### Find the listener and heartbeat connections

A worker reserves its listener connection and its heartbeat connection. A count of connections
cannot show which connections a worker reserves. Claims, registration, and maintenance can check
out a connection at every sample, and a heartbeat connection can close and open again. Thus the
driver finds each listener and heartbeat connection by the statements that it runs. The result is
an estimate from SQL observation, not a count of reservations. The benchmark does not record when
an SDK takes or returns a connection, because that needs SDK changes.

The role sampler is a PL/pgSQL function in `pg_temp` of a driver session, so it leaves nothing in
the bench database. It reads `pg_stat_activity` about every 2 ms, for 1 s in each call, without a
round trip to the driver. It gives each sample of a probe backend one kind:

| Kind        | Last statement of the backend                                                        |
| ----------- | ------------------------------------------------------------------------------------ |
| `listen`    | `LISTEN`                                                                             |
| `heartbeat` | a `heartbeat_*_v<n>` statement, or the `set_config` of a heartbeat round: the marker |
| `commit`    | `COMMIT`, with the time at which that `COMMIT` started                               |
| `neutral`   | `BEGIN`, `ROLLBACK`, or nothing                                                      |
| `statement` | any other statement: a claim, registration, maintenance, or the reset of a pool      |

Each SDK runs a heartbeat round as `BEGIN`, a `set_config` of `idle_in_transaction_session_timeout`,
a heartbeat statement, and `COMMIT`. The driver counts an observed round on a backend in two cases:

1. A sample sees the marker.
2. A sample sees a `COMMIT` that started after a marker of the backend, and no `listen` or
   `statement` sample came between the marker and that `COMMIT`.

Two observations less than half a heartbeat interval apart are one round. A `COMMIT` stays the last
statement until the next round, so case 2 sees most rounds that case 1 misses. A returned
connection keeps its last `COMMIT`, and a rollback ends with `ROLLBACK`. Neither case counts them.
A round of case 2 is confirmed when it comes at most one expiry time, max(2 × I, 2 s), after the
last marker. Every round renews the heartbeat role, but only a marker or a confirmed round counts
for coverage. Thus `COMMIT`s alone cannot make the observation of a backend look complete.
`heartbeatCoverage` counts the other rounds as `unconfirmedCommitRounds`.

Case 2 depends on one assumption: each probe sends every statement other than a heartbeat round in
autocommit, so only a heartbeat round ends with an explicit `COMMIT`. These probe settings and SDK
paths give that:

- Both psycopg probes open their pools with `autocommit` set
  (`python/tools/connection_budget_probe.py`).
- The asyncpg executor calls `fetch` (`python/src/workhorse/_drivers.py`).
- The TypeScript and Go SDKs send each protocol statement through the pool. The Go executor calls
  `Query` (`go/executor.go`).
- The Ruby executor calls `exec_params` (`ruby/lib/stablemates/workhorse/executor.rb`).
- The Rust SDK sends one pooled query (`rust/src/queue.rs`).
- JVM worker calls use autocommit (`jvm/workhorse/src/main/java/run/workhorse/Worker.java`).

If a probe adds an explicit transaction outside the heartbeat rounds, run the driver with
`--no-commit-inference`. Then only markers count as rounds.

A backend has the heartbeat role from the first observed round. It keeps the role while the driver
observes a round at least once in each expiry time, max(2 × I, 2 s). Then the backend becomes a
former heartbeat connection, until it runs another kind of statement. If it runs another kind of
statement, its role is that kind at once. Thus a released connection leaves the heartbeat count at
most one expiry time after its last round. A connection that a worker reserves for a short time
and that runs no observed round does not show at all.

The driver detects the closure of a backend at the first later sample that does not see it. It
records the last sample that saw the backend and the first sample that did not, as the bounds of
the closure. Only a backend whose last call of the sampler failed has an uncertain closure.

`outcome.connectionRoles` gives these values:

- `observedHeartbeatRoleConnections`: the backends with the heartbeat role at one time, every
  250 ms of the measurement window, as minimum, median, and maximum. In the steady state, this is
  the value for decisions. It is `unknown` when the driver observed no round in the cell.
- `peakHeartbeatBackendsInOneInterval`: the most distinct backends with an observed round in one
  heartbeat interval, at any time in the cell. `peakMarkerBackendsInOneInterval` counts markers only.
- `listenerConnections`, `formerHeartbeatConnections`, `statementConnections`, and
  `unclassifiedConnections`: the backends in each other role at one time, in the same form.
- `listenerPids`, `heartbeatPids`, and `statementPids`: the backends that had each role in the cell.
- `markerRounds`, `commitInferredRounds`, and `unconfirmedCommitRounds`: the observed rounds by
  case, for the cell.
- `heartbeatCoverage`: for each heartbeat backend, these values:
  - the rounds by case, the unconfirmed rounds of case 2, and the marker samples;
  - the whole heartbeat intervals of its role, the intervals with a confirmed round, and the
    intervals with a marker;
  - the longest gap between confirmed rounds, which includes the gap from the last confirmed round
    to the end of the role;
  - the gaps between rounds above 1.5 × I, and the final gaps above 1.5 × I;
  - the roles that expired while the backend was open.

  A final gap up to 1.5 × I is a short last interval. A longer one is a missing or a late round.

- `heartbeatObservationIncomplete`: true when the driver observed no round, when a sampler call
  failed, or when a heartbeat backend has a gap above 1.5 × I, a final gap above 1.5 × I, or a role
  that expired while it was open. A late round also makes a gap, so a gap is a missed or a late
  round. The flag cannot show a heartbeat connection on which the driver observed no round at all.
- `events`: each `heartbeat-start` and `heartbeat-end`, with its time and PID. An end gives its
  reason: `statement`, `listen`, `expired`, `closed` with the closure bounds, or `unresolved`. An
  end followed by a start on another PID is a replacement of the heartbeat connection.
- `effectiveIntervalMs`: the mean time between two samples, for the cell and for the first and the
  last three calls of the measurement window. `maxRelationBytes` is the largest size of the table of
  the sampler in one call.
- `series`: the backends in each role, every 250 ms.

`outcome.poolState` gives the pool state that the probe reported in the measurement window:

- `checkedOut`, `idleCached`, and `total`: the minimum, median, and maximum of each count. A
  checked-out count includes the reserved connections and the short checkouts of claims,
  registration, and maintenance.
- `waitingMax`: the most callers that waited for a connection in one sample. This value is the direct
  sign of starvation. It is null when the pool does not count waiting callers.
- `outOfPoolSessions`: the sessions outside the pool. `steady` is the median, with a minimum of 0.

`outcome.measurementCost` gives the CPU time of the driver process and of the backend that runs the
role sampler, from the probe start to the end of the window. It also gives each as a percentage of
one core. The backend time comes from `/proc`, so it is null when PostgreSQL runs on another host.
In the smoke cells of 2026-10-21, the driver used less than 1% of one core, and the role sampler
backend used 5% to 8%. In a 75 s check with 84 probe sessions, the sampler backend used 21% of one
core, and the mean time between two samples stayed at 2.5 ms to 2.6 ms.

The other values of the `outcome` of each run are:

- `finalUnexpiredActiveTasks`, `finalClaimEvents`, and `finalClaimedTasks` against `expectedSlots`,
  which is W × C. `enqueuedTasks` is the count of tasks that the driver enqueued.
- `endReason`: why the sampling ended: `window`, `drained`, `fault-observed`, or `probe-exited`.
- `firstClaimMs` and `fullOccupancyMs`: the time from the probe start to the first claim, and to
  W × C active tasks whose leases are not expired.
- `initialCapacityFailure`: true when the cell never had W × C active tasks with unexpired leases.
- `longestClaimGapMs`: after the first claim, the longest time in which slots were free, ready tasks
  waited, and no claim came. A slot is free when fewer unexpired leases are active than the cell
  has slots.
- `progressFailure`: true when `longestClaimGapMs` is 10 s or more. These two values come from the
  samples. A refill cell uses the exact claim gap in `refill`.
- `refill` and `fault`: the values of a refill cell and of a fault cell, as the sections above
  describe. They are null in other cells.
- `lostLeases`: the `lease_expired` attempts in `workhorse.attempt_history`.
  `leaseExpiredEvents` counts the `lease_expired` events, and `maxAttempt` is the highest attempt.
- `renewalAgeMs`: the maximum, p50, p95, and p99 renewal age in the measurement window.
- `minLeaseMarginMs` and `maxExpiredActiveTasks`.
- `maxConnections`: the maximum count of each kind of session and pool value in one sample.
- `connectionsAtEnd`: the state and the last statement of the probe sessions at the end.
- `sampleErrors`, `sampleErrorMessages`, and `finalErrors`: the queries that failed or timed out.
- `strayProbeSessionsBefore` and `leftoverProbeSessionsAfter`: the probe sessions that the driver
  ended before and after the cell.
- `probe`: the exit code or signal, the shutdown grace, the kill deadline, `killedAtDeadline`, the
  time to stop, the count of `worker_error` events, the `started` event with the settings that the
  probe applied, the count of pool states, the first 200 events of the probe, and the last 4 KB of
  its other output.

Each run also has its `result`. The top level records the PostgreSQL version, the SDK and toolchain
versions, the matrix, the shutdown settings, the `summary`, the wall time, and the provenance of the
run. Schema version 4 adds the cell kinds, the results, and the summary. Version 3 artifacts stop a
probe with SIGKILL 20 s after SIGTERM, and they name that stop `killedAfterGrace`.

Use these rules when you read a result:

- Use `observedHeartbeatRoleConnections` in the steady state for the heartbeat connections. It is an
  estimate from observed SQL, not a count of reservations. The session counts and the checked-out
  counts include connections that a pool keeps after claims, registration, and maintenance, so no
  count gives the heartbeat connections.
- A heartbeat round shows its marker for a few milliseconds only. If the driver observes no round on
  a backend, that backend does not count. If `heartbeatObservationIncomplete` is true, read
  `heartbeatCoverage` before you use the count.
- A connection that a worker reserves and that runs no statement shows as `unknown`. For example, a
  worker that waits for its first task holds its heartbeat connection with no round. The pool state
  then shows the connection as checked out.
- PostgreSQL shows a session as `idle` also when the pool has checked it out. Use the pool state to
  know whether a connection is checked out.
- The pool state and the database sample can be up to 250 ms apart. One pair of values can differ
  while a connection opens or closes.
- A renewal age up to I is normal, because a lease renews once in each interval.
- Workhorse records a lost lease only when a worker recovers it. If every worker waits for a
  connection, nothing recovers the lease. Thus also read `minLeaseMarginMs` and
  `maxExpiredActiveTasks`. A negative margin is a lease that expired.
- A smoke run proves that each probe runs. It does not give a capacity result.

Write the artifact of a recorded run to `docs/benchmarks/results/`. Keep a smoke artifact out of
Git.
