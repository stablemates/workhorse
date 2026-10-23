# Workhorse documentation

Use [`guides/`](guides/) to learn Workhorse one concept at a time. Use
[`architecture.md`](architecture.md) and the per-area pages it indexes when you need the exact
current behavior, identifiers, and limits. The pages under [`site/content/docs/`](../site/content/docs/) adapt those sources for the
published site; they do not own product behavior.

## Choose a starting point

- If you want to run your first task, follow the [quickstart](https://workhorse.run/docs/quickstart) in your SDK's language.
- If you are learning the execution model, start with [tasks and state](guides/010-tasks-and-state.md), then read [leases](guides/020-leases-and-fences.md) and [delivery guarantees](guides/030-delivery-guarantees.md).
- If you are adding tasks to an existing application, read [transactional enqueue](guides/200-transactional-enqueue.md) before choosing an [integration](https://workhorse.run/docs/integrations).
- If you operate workers, start with [worker processes](worker-processes.md) and the [operations guide](https://workhorse.run/docs/operations).

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
- [`kubernetes.md`](kubernetes.md) deploys Workhorse as ordinary Kubernetes workloads, with
  reference manifests for the schema migration, the workers, and the dashboard.
- [`rust-conformance.md`](rust-conformance.md) is the generated evidence that the Rust SDK runs each
  `protocol/v1` fixture, or lists it as expected unsupported.

## Maintainer procedures and evidence

- [`benchmarking.md`](benchmarking.md) explains how to run benchmarks and preserve evidence.
- [`demo-feature-coverage.md`](demo-feature-coverage.md) maps demo scenarios to product features,
  while [`demo-findings.md`](demo-findings.md) records what the demo proves.
- [`schema-lifecycle.md`](schema-lifecycle.md) owns the procedure for changing and releasing the
  database schema.
- [`dashboard-security-review.md`](dashboard-security-review.md) owns the security review checklist
  for the dashboard server, and states when a pull request has to re-walk it.
- [`integration-brand-assets.md`](integration-brand-assets.md) records the source, the terms, and
  the digest of each integration mark that the site shows.
- [`tracker-history.md`](tracker-history.md) explains the earlier trackers, so you can follow a
  historical issue label in a commit or a decision record.

Architectural decisions live in [`decisions/`](decisions/). Dated benchmark reports and raw results
live in [`benchmarks/`](benchmarks/), and dated agent documentation eval notes live in
[`agent-evals/`](agent-evals/). Wayfinder research notes are written directly into `docs/research/`
in the private operations repository, `stablemates/workhorse-operations`. ADR 0044 established that
repository as the durable home for material this repository excludes, and it removed every tracked
file under `docs/research/` before publication. `origin` is public, so a `research/*` branch pushed
here is published whether or not it ever merges. No research note is committed to this repository on
any branch. Cite a note by its operations-repository path, or by its findings the way ADR 0049 cites
the agent documentation baseline.
