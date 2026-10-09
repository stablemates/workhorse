# Changelog

## 0.7.0 — 2026-10-09

- Extract a task's stored trace context onto `ROOT_CONTEXT`. A task without one starts a new trace
  instead of joining a span active in the worker (SM-1170).

## 0.1.0-beta.2

- Add explicit OpenTelemetry registration for Workhorse traces, metrics, logs, and queue observations.
