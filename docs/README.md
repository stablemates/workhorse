# Workhorse documentation

Use [`guides/`](guides/) to learn Workhorse one concept at a time. Use
[`architecture.md`](architecture.md) when you need the exact current behavior, identifiers, and
limits. The pages under [`site/content/docs/`](../site/content/docs/) adapt those sources for the
published site; they do not own product behavior.

## Product references

- [`compatibility.md`](compatibility.md) owns supported runtimes, PostgreSQL versions, and release
  compatibility.
- [`features.md`](features.md) owns the current product capability matrix.
- [`parity.md`](parity.md) is the generated matrix of capabilities exposed by each language SDK.

## Specialized references

- [`rolling-statistics.md`](rolling-statistics.md) owns the design and operating contract for
  derived statistics.
- [`worker-processes.md`](worker-processes.md) owns the process model and lifecycle for dedicated
  workers.

## Maintainer procedures and evidence

- [`benchmarking.md`](benchmarking.md) explains how to run benchmarks and preserve evidence.
- [`demo-feature-coverage.md`](demo-feature-coverage.md) maps demo scenarios to product features,
  while [`demo-findings.md`](demo-findings.md) records what the demo proves.
- [`schema-lifecycle.md`](schema-lifecycle.md) owns the procedure for changing and releasing the
  database schema.

Architectural decisions live in [`decisions/`](decisions/). Dated benchmark reports and raw results
live in [`benchmarks/`](benchmarks/). Wayfinder research notes stay on throwaway `research/*`
branches and never merge, because the publication boundary keeps `docs/research/` out of `main`.
