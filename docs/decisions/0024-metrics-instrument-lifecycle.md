# ADR 0024: Metric instruments use the lazy, provider-aware lifecycle

- **Status:** Accepted
- **Date:** 2026-08-11
- **Related:** [ADR 0019](0019-derived-rolling-statistics.md), [ADR 0020](0020-database-authoritative-configuration.md)

## Context

Core ships two instrumentation layers that fire on the same code paths, each with its own
instrument lifecycle. They are competing strategies, not complementary ones, and consolidating them
requires picking a survivor.

`typescript/core/src/metrics.ts` uses the **eager** lifecycle. It calls `metrics.getMeter("@workhorse/core")` once at
module evaluation and creates every instrument immediately at module scope. Emission is a direct
call on a captured instrument.

`typescript/core/src/telemetry.ts` uses the **lazy** lifecycle. `lazyCounter` and `lazyHistogram` defer instrument
creation to the first emission, and re-create the instrument whenever `metrics.getMeterProvider()`
returns a different provider than the one seen previously. Emission therefore costs one global
provider read and one identity comparison before the underlying call.

The prior consolidation attempts argued from aesthetics. This decision measures instead.

## Measurement

`typescript/core/benchmarks/metrics-lifecycle.ts` builds both lifecycles over the same counter with the attributes a
real emission carries — `workhorse.queue.name` and `workhorse.job.type`, as `recordClaimedJob` and
`telemetryMetrics.claimed` both do. It measures each lifecycle with telemetry off (no global
provider registered) and telemetry on (an SDK `MeterProvider` aggregating into memory), interleaving
the two lifecycles within each provider state so machine drift hits both equally. It also emits
through an instrument built before any provider exists, registers a provider, emits again, and
reports what that provider actually collected.

Run with `pnpm benchmark:metrics-lifecycle`. It needs no database. Full report:
`docs/benchmarks/results/2026-08-11-metrics-lifecycle.json`. Node 24.15.0, `@opentelemetry/api` 1.9.1 and
`@opentelemetry/sdk-metrics` 2.10.0; 1,000,000 emissions per repetition, 3 discarded warmup
repetitions and 12 measured repetitions per cell.

Cost per emission, in nanoseconds, mean with a 95% confidence interval:

| Lifecycle | Telemetry off        | Telemetry on            |
| --------- | -------------------- | ----------------------- |
| Eager     | 0.53 [0.50, 0.57]    | 373.85 [371.31, 376.39] |
| Lazy      | 11.47 [11.42, 11.52] | 414.12 [410.84, 417.41] |

The lazy lifecycle costs 10.9 ns more per emission with telemetry off and 40.3 ns more with
telemetry on. Both differences are outside the confidence intervals, so they are real, and both are
small against the work an emission accompanies: claim p50 latency in
`docs/benchmarks/results/2026-07-21-v3-default.json` is 0.89 ms, so 40 ns is 0.005% of one claim.
A claim path that emits twice pays about 0.01%. With telemetry off, the absolute cost of a lazy
emission is 11 ns, which is below the noise of a single PostgreSQL round trip by four orders of
magnitude.

The registration-order check is not close:

| Lifecycle | Emissions after a late provider registration | Collected by that provider      |
| --------- | -------------------------------------------- | ------------------------------- |
| Eager     | 5                                            | none — the metric never appears |
| Lazy      | 5                                            | 5                               |

`@opentelemetry/api` resolves `metrics.getMeter()` against whichever provider is registered at call
time and returns no proxy that re-binds later, unlike the tracing API. An eager module-scope
instrument created before the application installs its SDK is bound to the no-op provider for the
lifetime of the process, and every emission through it is silently discarded. This is the ordinary
case for a library: importing `@workhorse/core` to construct a `Queue` runs `typescript/core/src/metrics.ts` at
import, which commonly precedes SDK setup.

## Decision

Consolidated core instrumentation uses the lazy, provider-change-aware lifecycle from
`typescript/core/src/telemetry.ts`. `typescript/core/src/metrics.ts` is the losing module.

The measurement picks the survivor on correctness, not on overhead. Overhead does not decide this:
the eager lifecycle is faster by an amount that is invisible next to a PostgreSQL round trip, and
the eager lifecycle loses every emission made before an application registers its SDK. A cheaper
emission that no one receives is not cheaper.

Consolidation onto that lifecycle is 0.1b's work. This decision fixes only which lifecycle survives.

## Consequences

- Applications may install their OpenTelemetry SDK at any point relative to importing
  `@workhorse/core`. Emissions after registration reach the registered provider.
- Every core metric emission reads the global meter provider. That cost is measured above and
  accepted.
- Instruments migrated out of `typescript/core/src/metrics.ts` must move to `lazyCounter`, `lazyHistogram`, or an
  equivalent lazy constructor. Copying an instrument to module scope reintroduces the defect.
- `WorkhorseMetricsObserver` gauges and `registerQueueMetrics` observable gauges are a separate
  question. Observable instruments are read at collection time by whichever provider owns the
  callback, so their consolidation turns on ownership of the depth read, which 0.1c decides.
- Existing deployments that saw no `workhorse.job.*` metrics because they registered their SDK after
  import will start receiving them once 0.1b lands. That is a behavior change, and 0.1b records it
  in `CHANGELOG.md`.

## Rejected alternatives

**Keep the eager lifecycle and require applications to register their SDK before importing core.**
The requirement is unenforceable and invisible when broken — the failure mode is missing metrics,
not an error. It also constrains import order across a dependency graph the application does not
fully control.

**Measure the two lifecycles through a PostgreSQL throughput scenario.** A scenario cannot resolve
the difference. At 40 ns per emission against a 0.89 ms claim, the effect is roughly four orders of
magnitude below run-to-run variance, so any observed difference would be noise. The microbenchmark
is used instead, and the throughput scenarios remain the gate for the consolidation itself in 0.1b.
