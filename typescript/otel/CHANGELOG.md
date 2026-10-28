# Changelog

## 0.11.0 — 2026-10-28

- No code changes. The peer range on `@stablemates/workhorse` is `>=0.11.0 <0.12.0`, so the
  adapter installs beside the 0.11.0 core. The npm packages, Python distribution, Go module,
  Rust crate, Ruby gem, JVM artifacts, and .NET packages release from one source commit. The core
  requires **schema v76**. Migrations 0088, 0089, and 0090 move the schema from version 86 to
  version **89**. Its 0.11.0 entry in [`CHANGELOG.md`](../../CHANGELOG.md) gives the upgrade
  step and the behavior changes of the core (SM-1857, SM-1864, SM-1884).

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
