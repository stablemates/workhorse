# Changelog

## 0.17.0 — 2026-11-24

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.17.0 <0.18.0`, so the
  adapter installs beside the 0.17.0 core. The npm packages, Python distribution, Go module,
  Rust crate, Ruby gem, JVM artifacts, and .NET packages release from one source commit. The core
  requires **schema v99**. 0.17.0 adds no migration, so the schema stays at version **106**. Its
  0.17.0 entry in [`CHANGELOG.md`](../../CHANGELOG.md) gives the upgrade steps of the core and the
  telemetry changes.

### Upgrade from 0.16.x to 0.17.0

**Roll out the new processes. The schema does not change.** 0.17.0 adds no migration. The schema
stays at version **106**, and the SDK compatibility floor stays at **99**. The adapter has no code
changes.

**Telemetry changes in every SDK.** In each SDK, 0.17.0 aligns the error status of the
`workhorse.handler` span, `workhorse.tasks.retried`, the redrive and cancellation counts, the
execution count, and the log events with the TypeScript records. Thus an alert or a dashboard that
you built on 0.16.0 numbers can move after the upgrade.

**The .NET log records use new keys.** This is a breaking change for each query of .NET log records.
They now carry the `workhorse.*` and `error.type` keys of the TypeScript records. A query that reads
only TypeScript records does not change for this reason.

**Fast-tier dispatch changes for a worker with a concurrency of 5 or more** (ADR 0076, SM-1833). The
number of plain claims and of fused claims for each completion changes, and a claim rate on a
dashboard can move.

[The 0.17.0 entry of `CHANGELOG.md`](../../CHANGELOG.md) and
[the upgrade notes](../../docs/upgrading.md#upgrade-from-016x-to-0170) give each change.

## 0.16.0 — 2026-11-22

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.16.0 <0.17.0`, so the
  adapter installs beside the 0.16.0 core. The npm packages, Python distribution, Go module,
  Rust crate, Ruby gem, JVM artifacts, and .NET packages release from one source commit. The core
  requires **schema v99**. Migration 0107 moves the schema from version 105 to version **106**. Its
  0.16.0 entry in [`CHANGELOG.md`](../../CHANGELOG.md) gives the upgrade steps of the core.

## 0.15.0 — 2026-11-21

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.15.0 <0.16.0`, so the
  adapter installs beside the 0.15.0 core. The npm packages, Python distribution, Go module,
  Rust crate, Ruby gem, JVM artifacts, and .NET packages release from one source commit. The core
  requires **schema v99**. Migration 0106 moves the schema from version 104 to version **105**. Its
  0.15.0 entry in [`CHANGELOG.md`](../../CHANGELOG.md) gives the upgrade steps of the core.

## 0.14.0 — 2026-11-13

There is no 0.13.0. A task queue does not tempt fate.

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.14.0 <0.15.0`, so the
  adapter installs beside the 0.14.0 core. The npm packages, Python distribution, Go module,
  Rust crate, Ruby gem, JVM artifacts, and .NET packages release from one source commit. The core
  requires **schema v99**. Migrations 0093 through 0105 move the schema from version 91 to version
  **104**. Its 0.14.0 entry in [`CHANGELOG.md`](../../CHANGELOG.md) gives the upgrade steps and the
  breaking changes of the core.

## 0.12.0 — 2026-11-07

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.12.0 <0.13.0`, so the
  adapter installs beside the 0.12.0 core. The npm packages, Python distribution, Go module,
  Rust crate, Ruby gem, JVM artifacts, and .NET packages release from one source commit. The core
  requires **schema v76**. Migrations 0091 and 0092 move the schema from version 89 to version
  **91**. Its 0.12.0 entry in [`CHANGELOG.md`](../../CHANGELOG.md) gives the upgrade step and the
  behavior changes of the core.

## 0.11.0 — 2026-10-28

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.11.0 <0.12.0`, so the
  adapter installs beside the 0.11.0 core. The npm packages, Python distribution, Go module,
  Rust crate, Ruby gem, JVM artifacts, and .NET packages release from one source commit. The core
  requires **schema v76**. Migrations 0088, 0089, and 0090 move the schema from version 86 to
  version **89**. Its 0.11.0 entry in [`CHANGELOG.md`](../../CHANGELOG.md) gives the upgrade
  step and the behavior changes of the core (SM-1857, SM-1864, SM-1884, SM-1899).

## 0.10.0 — 2026-10-26

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.10.0 <0.11.0`, so the
  adapter installs beside the 0.10.0 core.

## 0.9.0 — 2026-10-20

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.9.0 <0.10.0`, so the adapter
  installs beside the 0.9.0 core.

## 0.8.0 — 2026-10-13

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.8.0 <0.9.0`, so the adapter
  installs beside the 0.8.0 core.

## 0.7.1 — 2026-10-09

- No changes. 0.7.0 never published to npm, so 0.7.1 is the first release with the 0.7.0 change
  below. The package releases at 0.7.1 to keep one version across the registries
  ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).

## 0.7.0 — 2026-10-09

- Extract a task's stored trace context onto `ROOT_CONTEXT`. A task without one starts a new trace
  instead of joining a span active in the worker (SM-1170).

## 0.1.0-beta.2

- Add explicit OpenTelemetry registration for Workhorse traces, metrics, logs, and queue observations.
