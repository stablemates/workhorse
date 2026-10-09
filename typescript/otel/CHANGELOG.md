# Changelog

## 0.7.1 — 2026-10-09

- No changes. 0.7.0 never published to npm, so 0.7.1 is the first release with the 0.7.0 change
  below. The package releases at 0.7.1 to keep one version across the registries
  ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).

## 0.7.0 — 2026-10-09

- Extract a task's stored trace context onto `ROOT_CONTEXT`. A task without one starts a new trace
  instead of joining a span active in the worker (SM-1170).

## 0.1.0-beta.2

- Add explicit OpenTelemetry registration for Workhorse traces, metrics, logs, and queue observations.
