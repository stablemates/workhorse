# Benchmark suite v3 runbook

This runbook explains how to execute Workhorse's benchmark suite, preserve reproducible evidence, and interpret results without making unsupported performance claims.

## Recorded evidence

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
- [2026-07-22 performance pivot and competitor analysis](benchmarks/2026-07-22-performance-pivot-competitor-analysis.md): architecture pivot result, controlled Graphile Worker/pg-boss baseline, pg-boss batching sensitivity, resource costs, and supported product claims.
- [`results/2026-07-22-competitor-default.json`](benchmarks/results/2026-07-22-competitor-default.json): controlled per-job competitor baseline with six repetitions at 1/4/16 workers.
- [`results/2026-07-22-competitor-pgboss-batched-default.json`](benchmarks/results/2026-07-22-competitor-pgboss-batched-default.json): explicitly non-equivalent pg-boss batch-size sensitivity.
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

1. **Conventional:** a mutable lifetime job table with ready, scheduled, and expired-lease indexes plus event and attempt history.
2. **Hybrid/runtime:** immutable job identity, one live-only mutable runtime row, immutable terminal outcome, and append-only event and attempt history.

A seeded execution plan shuffles worker/repetition pairs and alternates which design runs first. The exact plan is recorded in `executionPlan`. For each pair, both designs are independently reset before measurement. The suite records:

- configurable `enqueueMany` batch size and the exact enqueue request count;
- enqueue, processing, and end-to-end duration plus phase-specific jobs/second;
- completed jobs per second;
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

The suite also performs equal-load fixed-rate producer-consumer churn. Both designs receive the same exact `targetJobs` at the same `targetRatePerSecond`; concurrent workers drain every job before the run can pass. It records production and drain duration, producer scheduling-lag distribution, maximum observed backlog, and exact completion. Telemetry runs on an independent scheduled task, not in the producer loop, and every sample records its own `sampleDurationMs`.

### Lifecycle suite

The lifecycle suite runs deterministic operational scenarios with hard invariants:

| Scenario                        | Evidence produced                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scheduled-promotion-drift`     | bounded promotion batches and due-time drift distribution                                                                                                                                        |
| `schedule-cadence-jitter`       | recurring fire-delay distribution, worst observed delay, durable occurrence uniqueness, and completed load jobs at the configured maintenance cadence                                            |
| `heartbeat-fencing`             | accepted heartbeat cost and stale-fence rejection cost                                                                                                                                           |
| `priority-dispatch`             | FIFO and mixed-priority claim distributions, throughput, retained-history plan bounds, ready-index size, and strict starvation under replenished urgent work                                     |
| `cancellation-lifecycle`        | immediate/waiting cancellation, active signal/ack, expiry materialization, stale races, truthful history, recurrence, and query timings                                                          |
| `deadline-timeout-lifecycle`    | pre-claim deadline exclusion, active abort delivery, timeout retry, stale-write fencing, distinct history, and health pressure                                                                   |
| `dead-letter-redrive-lifecycle` | cold failure cursor paging, side-effect-free preview, audited redrive, exact replay, immutable sources, and retained lineage                                                                     |
| `query-listing-lifecycle`       | dedicated operator projection, immutable cursor continuation, default payload omission, redaction before byte bounds, heartbeat independence, merged timeline, and operator-index storage        |
| `progress-lifecycle`            | fenced latest-value updates, identical-value no-op, frequency limit, stale-fence rejection, lookup provenance, terminal retention, and bounded event evidence                                    |
| `crash-before-completion`       | durable state at all five worker crash boundaries                                                                                                                                                |
| `lease-expiry-recovery`         | recovery latency, new attempt/fence, and stale completion rejection                                                                                                                              |
| `retry-paths`                   | overrides; fixed/exponential/jitter selection and provenance; deterministic replay; promotion and exhaustion; versioned contract validation and redaction timings                                |
| `idempotent-ingress`            | exact replay, conflict rollback, same-batch duplicates, expiry reuse, and full transition timings/invariants                                                                                     |
| `coalescing-ingress`            | concurrent idempotent replay, debounce reset/preserve, throttle coalescing, durable effects, notifications, key-index size, and purge cost                                                       |
| `dependency-operations`         | fan-in release, terminal cancellation policy, dependency health, and claim-plan buffer cost before and after retained terminal history                                                           |
| `retention-pruning`             | persisted-policy housekeeping, independent event/attempt retirement, and retained job identity                                                                                                   |
| `health-snapshot`               | single-statement snapshot latency, capped-scan flags, and machine-readable critical status reasons                                                                                               |
| `worker-concurrency`            | 1/4/8-slot timing, equal-capacity single/balanced/distributed worker topologies, immediate/I/O-like profiles, start latency, query pressure, heartbeats, first-null, pause, and drain invariants |
| `batch-dispatch`                | equal serial and batched cohorts, full/partial groups, mixed outcomes, per-job policy admission, claim cost, active slots, and isolated recovery                                                 |
| `notification-dispatch`         | polling-only versus notification-assisted idle claim pressure, enqueue-to-claim latency, completion, and bounded-fallback invariants                                                             |
| `telemetry-context`             | equal-cohort enqueue and claiming timings with the OpenTelemetry SDK disabled and enabled, plus export, payload, and index invariants                                                            |

Scenario invariant failures abort the suite. This prevents a fast but semantically incorrect run from being treated as evidence.

`priority-dispatch` compares equal FIFO and mixed-priority cohorts with four concurrent claimers and overlapping handler intervals. It then grows terminal history while holding live ready depth constant. The scenario records claim distributions, throughput, actual `claim_v3` buffer work, and ready-index bytes. A final phase replenishes urgent work before every claim and proves ordinary work remains ready. Its single-host timings describe this run only.

`query-listing-lifecycle` records client-observed page, payload projection, and timeline durations plus
projection row count and the dedicated operator indexes' measured bytes. These are diagnostic observations,
not latency targets or publication-grade scale claims. The scenario proves operator pages do not require
claim-critical indexes, payload is omitted unless explicitly requested, redaction precedes the response byte
ceiling, heartbeats do not churn the projection, and retained events and attempts share one cursor stream.

`progress-lifecycle` records full client-observed durations for the first accepted update, identical-value
no-op, frequency-limit rejection, second accepted revision, and latest-value lookup. Its invariants prove
stale-fence rejection, terminal retention, and one value-free lifecycle event per accepted change. These
small-run observations are diagnostics, not an update-latency or throughput claim.

`retry-paths` records the selected fixed, exponential, and decorrelated-jitter delays plus the
client-observed duration of each failure transition and their total. It also records enqueue, claim,
and completion timings for a versioned contract while proving that operator reads redact its configured
fields. These timings cover the full transitions rather than isolated policy or validation functions.
No numerical overhead claim is supported until an actual benchmark artifact is recorded.

`idempotent-ingress` records client-observed durations for initial keyed acceptance, exact replay,
conflict rollback, duplicate-key batch acceptance, first expiring acceptance, and reuse after expiry. Its
hard invariants verify stable replay identity; no duplicate job, binding, event, runtime, or FIFO state;
whole-batch conflict rollback; duplicate result ordering alongside unchanged unkeyed behavior; and transfer
of scoped ownership after expiry. These are full SQL transition timings. No latency or overhead number is
claimed until a benchmark artifact containing this scenario is recorded.

`coalescing-ingress` runs concurrent requests across bounded key sets for idempotency, debounce with
reset and preserve scheduling, and throttle. It records per-request p50/p95, retained-key index
size, ready notifications, and pending-job purge cost. Hard invariants compare structured outcomes
with accepted identities, live runtimes, FIFO placement, and lifecycle events. The scenario proves
serialization and durable bookkeeping for the sampled traffic. It does not prove exactly-once
handler effects, production latency, or a generally faster coalescing mode.

`cancellation-lifecycle` records client-observed full-transition timings for immediate ready,
scheduled, and durable-wait cancellation; active request, repeated request, exact-fence settlement,
ignored-signal expiry materialization, and terminal replay; plus bounded state/event queries and firing
the next recurring occurrence. Its hard invariants prove `heartbeat_v2` and `AbortSignal` delivery,
wrong/stale fence rejection, immutable first-committer-wins outcomes, one request/terminal event,
attempt-history truthfulness, no retry after an expired request, and schedule independence. These are
operational observations from a small deterministic scenario, not an SLA, throughput result, latency
target, forced-interruption guarantee, or exactly-once claim. No cancellation performance claim is
supported until a recorded artifact is published and interpreted in its environment.

`deadline-timeout-lifecycle` records bounded reaping of never-started expired work, cooperative
active-deadline delivery, one timeout-to-retry transition, late-completion fencing, and canonical
health pressure. Its hard invariants distinguish deadline and execution-timeout evidence from generic
lease expiry, prove that expired jobs are not newly claimed, and fence late completion after
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
excluded from the throughput window. It records 1/4/8-slot durations and derived jobs/second, maximum
handler and runtime-slot overlap, total and maximum-overlap query/claim pressure proxies, heartbeat calls,
and terminal lease health. Its 10 ms scenario poll interval models continuous refill truthfully: once the
seeded backlog is exhausted while handlers remain active, the fallback may issue one serial null claim per
elapsed polling window. The hard claim bound is successful jobs plus `ceil(durationMs / pollMs)` plus two
calls of endpoint/scheduling slack. It does not multiply polling pressure by configured concurrency. The
scenario also verifies that claim calls remain serial and only occur with a free slot. Separate invariant
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

`batch-dispatch` runs equal serial and batched cohorts through the same `claim_v3` path. It records claim cost, throughput, group sizes, dispatch wait, active slots, and terminal health.

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
export WORKHORSE_BENCH_DATABASE_URL=postgres://workhorse:workhorse@localhost:5432/workhorse_bench
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
| `--jobs`             | positive integer                  | Jobs per fixed comparative run            |
| `--enqueue-batch`    | positive integer                  | Jobs per `enqueueMany` request            |
| `--repetitions`      | positive integer                  | Independent repetitions                   |
| `--workers`          | comma-separated integers          | Worker-concurrency sweep                  |
| `--churn-rate`       | positive integer                  | Producer target jobs per second           |
| `--churn-jobs`       | positive integer                  | Exact churn jobs per design               |
| `--sample-ms`        | positive integer                  | Independent telemetry interval            |
| `--schedule-samples` | positive integer                  | Recurring fires sampled under worker load |
| `--output`           | path                              | Persist canonical deterministic-key JSON  |

## Profiles

| Profile   | Intended use           | Fixed runs                                       | Equal-load churn    |
| --------- | ---------------------- | ------------------------------------------------ | ------------------- |
| `smoke`   | correctness and wiring | 12 jobs, batch 4, 2 reps, workers 1/2            | 20 jobs at 40/s     |
| `default` | local evidence         | 100 jobs, batch 25, 3 reps, workers 1/4/8        | 500 jobs at 100/s   |
| `full`    | controlled evidence    | 1,000 jobs, batch 100, 5 reps, workers 1/4/16/32 | 6,000 jobs at 100/s |

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
  --jobs 500 \
  --enqueue-batch 50 \
  --repetitions 5 \
  --workers 1,4,16 \
  --churn-rate 200 \
  --churn-jobs 6000 \
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
- Confirm claim plans use `conventional_job_claim_idx` and `job_runtime_ready_idx` before comparing latency.
- A smoke run proves wiring and invariants, not production scalability.
- Run publication-grade tests on stable hardware without unrelated load and preserve raw JSON plus environment metadata.
- External side effects remain at least once. Queue benchmark success does not prove exactly-once delivery to HTTP, email, or payment providers.

## Continuous smoke benchmarks

`.github/workflows/benchmark.yml` runs the smoke profile on every push to `main`, nightly at 04:17 UTC, and on manual dispatch. It provisions PostgreSQL 18, runs `pnpm db:reset:bench`, then:

```bash
pnpm benchmark -- --suite all --profile smoke --output benchmark-report.json
```

The job is capped at 30 minutes and the benchmark step at 20, so a scenario that waits on a job which never arrives fails the run instead of holding a runner.

Two things follow every run. A step summary renders each comparative group's mean throughput and per-run claim p95 with their 95% confidence intervals, plus every lifecycle scenario's duration and assertion verdict. The full canonical report is uploaded as the `benchmark-smoke-<run number>` artifact, retained for 90 days, and uploaded even when the run fails — a failing report is the evidence needed to diagnose the failure.

Before uploading, the workflow asserts the report is `schemaVersion: 3`, carries a source commit under `provenance`, contains comparative summaries and lifecycle scenarios, and that every lifecycle assertion passed. A run that produces a half-written report fails rather than publishing it as evidence.

### Reading the trend

The workflow answers one question: does the harness still run green, and has anything changed by an amount too large to be noise? It does not answer how fast Workhorse is.

- **Assertions are the signal.** A lifecycle assertion that flips from passing to failing is a real regression at any profile. Investigate it directly.
- **Timings are not a signal on their own.** The smoke profile runs 12 jobs over 2 repetitions on a shared runner. Confidence intervals at that size routinely span more than the mean, and consecutive nightly runs can differ by a factor of two with no code change between them.
- **Only act on a sustained shift.** Treat a timing change as worth investigating when several consecutive runs move the same way and the new interval does not overlap the old one. A single slow night is runner noise.
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
psql "$WORKHORSE_BENCH_DATABASE_URL" -Atc "SELECT version()"
psql "$WORKHORSE_BENCH_DATABASE_URL" -Atc "SELECT name || '=' || setting || COALESCE(unit, '')
  FROM pg_settings
  WHERE name IN (
    'shared_buffers', 'work_mem', 'maintenance_work_mem',
    'max_connections', 'autovacuum', 'autovacuum_naptime',
    'checkpoint_timeout', 'max_wal_size', 'synchronous_commit'
  ) ORDER BY name"
```

Also record storage type, VM/container status, concurrent workloads, held transactions, replication slots, and whether the database was freshly reset.

## Remaining evidence gaps

V2 closes the original equivalent-semantics, confidence interval, comparative-worker, churn, telemetry, and lifecycle-scenario gaps. Schema v11 adds invariant-gated `idempotent-ingress`, `worker-concurrency`, and `cancellation-lifecycle` coverage after the historical artifacts below were recorded. A commercial build decision still needs recorded live artifacts for those newer scenarios, larger retained-history horizons, deliberately held old snapshots or replication horizons, production-shaped payloads, reference-system comparisons, multiple PostgreSQL versions, and repeated runs on production-class hardware.

## Troubleshooting

### Reset or benchmark refuses the database

Preserve the `_bench` suffix. Remote resets additionally require `WORKHORSE_ALLOW_REMOTE_RESET=1`.

### PostgreSQL statistics are unavailable

Run with a local development role allowed to read the required statistics. Do not broaden production privileges for this harness.

### Results vary

Caches, checkpoints, autovacuum, CPU frequency, storage contention, and other clients affect results. Increase repetitions, stabilize the environment, and compare distributions.

### A lifecycle scenario aborts

The scenario detected an invariant failure. Treat the run as invalid, inspect the named scenario and database state, fix correctness first, then rerun from a fresh database.

## Standalone competitor baseline

The competitor suite compares the common **successful immediate-job workload**, not the complete semantics of each queue:

```bash
pnpm db:reset:bench
pnpm benchmark:competitors -- --profile smoke --output docs/benchmarks/results/competitor-smoke.json
pnpm benchmark:competitors -- --profile default --output docs/benchmarks/results/competitor-default.json
pnpm benchmark:competitors -- --profile default --pg-boss-batch-size 10 \
  --output docs/benchmarks/results/competitor-pgboss-batched-default.json
```

### Targets and isolation

| Target          | Version            | Schema                       | Public APIs                                                      | Success retention                  |
| --------------- | ------------------ | ---------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Workhorse       | repository version | `workhorse`                  | `Queue.enqueueMany`, `claim`, `complete`; installed SQL protocol | retained with history              |
| pg-boss         | 12.26.2            | `pgboss_competitor`          | `insert`, `createQueue`, `work`, graceful `stop`                 | retained (`deleteAfterSeconds: 0`) |
| Graphile Worker | 0.17.3             | `graphile_worker_competitor` | `makeWorkerUtils().migrate/addJobs`, `run`, graceful `stop`      | deleted on success                 |

All targets use a 32-connection ceiling. pg-boss is configured with `retryLimit: 0`, `deleteAfterSeconds: 0`, `notify: true`, `useListenNotify: true`, and a per-job `batchSize: 1`; worker concurrency is supplied as `localConcurrency`. Graphile jobs use `maxAttempts: 1`, and `run()` receives the task list and concurrency without local claim batching. Workhorse jobs use one attempt and a 30-second lease.

The common target interface is workload-level: `reset/setup`, batched enqueue, start consumers, observe the exact expected completion set, stop, close, and expose schema metadata/capabilities. This deliberately hides native worker-loop differences while preserving them in target notes.

### Workloads and ordering

Both profiles run fixed batched burn-downs and one equal-offered-load producer/consumer churn per target. The plan uses deterministic shuffled three-target blocks. Within every worker/repetition block each target appears once, and repetitions rotate the three positions so position counts are balanced when repetitions are a multiple of three. Smoke uses three repetitions for this reason. Churn has only one observation per target and is exploratory; it cannot support a confidence-backed ranking.

The controlled default remains deliberately bounded at 100 jobs per fixed run and 600 churn jobs. pg-boss intentionally waits between single-job fetches from a preloaded backlog, and increasing `batchSize` would change the handler contract. Large native-throughput studies therefore require a separate configuration matrix with each product's batching behavior labeled explicitly.

`--pg-boss-batch-size N` runs that explicit sensitivity. Values above one enable pg-boss's full-batch burst behavior and must not be presented as a common per-job ranking.

Each run records enqueue, processing, and total phases; churn also records production, drain, sampled backlog, and maximum backlog. Exact completion is mandatory. Database evidence includes WAL bytes, schema totals/growth, and per-relation telemetry before and after the workload.

### Artifact contract

The JSON root is `artifactVersion: 1`, `contract: "common-success-path-v1"`, and `semanticEquivalence: false`. It contains:

- normalized profile configuration and deterministic execution plan;
- provenance: command, git SHA, source dirty state, Node/platform, database name and PostgreSQL version;
- target package versions, schema/queue configuration, capability flags, retention behavior, and semantic notes;
- per-run offered/enqueued/completed counts, exact-completion flag, position, phase durations, rates, load samples, WAL, schema growth, and relation telemetry;
- summaries grouped by target, workload kind, and concurrency.

Do not compare Graphile's post-success schema size as if it retained completed jobs. Do not interpret pg-boss or Graphile handler timing as directly comparable manual claim latency, and do not infer fencing guarantees from this suite. Workhorse exposes public claim/fence operations; both competitor worker APIs own claiming internally.

The timed end point is successful completion of every task handler. Framework-owned durable settlement can finish after a handler returns, so the suite does not claim a cross-product durable-settlement latency. Graceful shutdown and telemetry collection are outside timed phases. Product-specific handler/claim batching must be reported in a separately labeled optimized profile rather than mixed into this common per-job baseline.

## Standalone metric lifecycle microbenchmark

`benchmarks/metrics-lifecycle.ts` compares the two metric instrument lifecycles core ships: the eager module-scope instruments in `src/metrics.ts` and the lazy, provider-change-aware instruments in `src/telemetry.ts`. It measures per-emission cost with telemetry off and on, and reports whether each lifecycle still reaches an OpenTelemetry SDK registered after the instrumentation module loaded.

```bash
pnpm benchmark:metrics-lifecycle -- --output docs/benchmarks/results/<date>-metrics-lifecycle.json
```

This benchmark needs no database and does not run under `pnpm benchmark`. Emission cost is nanoseconds per call, roughly four orders of magnitude below claim latency, so a throughput scenario cannot resolve the difference between the lifecycles; do not read one as evidence about them. [ADR 0024](decisions/0024-metrics-instrument-lifecycle.md) interprets the result.
