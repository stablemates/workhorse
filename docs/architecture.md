# Workhorse architecture

This is the precise reference for Workhorse. Each page under [`architecture/`](architecture/) owns
one area. It names that area's functions, columns, and limits, so it can answer whether observed
behavior is a bug. For an explanation of a concept, read the [guides](guides/000-start-here.md)
first.

## Pages

### [Overview](architecture/overview.md)

- [Design objective](architecture/overview.md#design-objective)
- [System context](architecture/overview.md#system-context), including the adapter contract
- [Errors](architecture/overview.md#errors)
- [Tenancy](architecture/overview.md#tenancy)

### [Schema, SQL protocol, and SDKs](architecture/schema-and-protocol.md)

- [Schema versions and migrations](architecture/schema-and-protocol.md#schema-versions-and-migrations):
  the current version, the migration plan, and the migration runner
- [SQL protocol conformance](architecture/schema-and-protocol.md#sql-protocol-conformance)
- The [Python](architecture/schema-and-protocol.md#python-sdk),
  [Go](architecture/schema-and-protocol.md#go-sdk),
  [Ruby](architecture/schema-and-protocol.md#ruby-sdk), and
  [Rust](architecture/schema-and-protocol.md#rust-sdk) SDKs
- [Documentation and release checks](architecture/schema-and-protocol.md#documentation-and-release-checks)
- [PostgreSQL and runtime responsibilities](architecture/schema-and-protocol.md#postgresql-and-runtime-responsibilities)

### [Data model](architecture/data-model.md)

- [Every table](architecture/data-model.md#data-model) with its columns, constraints, and indexes
- [Declarative schedules](architecture/data-model.md#declarative-schedules)

### [Task lifecycle](architecture/lifecycle.md)

- The [atomic lifecycle](architecture/lifecycle.md#atomic-lifecycle): enqueue, claim, suspension,
  retry, and terminal outcome
- [Delivery semantics](architecture/lifecycle.md#delivery-semantics)
- [Read models and health](architecture/lifecycle.md#read-models-and-health)

### [Fast tier](architecture/fast-tier.md)

- The [fast task tier](architecture/fast-tier.md#fast-tier): its settings, tables, functions,
  rejected features, and workers

### [LangGraph approval recipe](architecture/langgraph-bridge.md)

- The bounded Python graph's ownership, application tables, driver lock, crash recovery,
  cancellation, retention, and trust boundaries

### [Dashboard](architecture/dashboard.md)

- The [`dashboard/v1` wire contract](architecture/dashboard.md#dashboard-wire-contract)
- The [dashboard package boundary](architecture/dashboard.md#dashboard-package-boundary), including
  authentication

### [Telemetry](architecture/telemetry.md)

- [OpenTelemetry metrics](architecture/telemetry.md#opentelemetry-metrics)
- [Traces, logs, and baseline metrics](architecture/telemetry.md#opentelemetry-traces-logs-and-baseline-metrics)

### [Operations and CLI](architecture/operations.md)

- [Deployment synchronization](architecture/operations.md#deployment-synchronization)
- [Worker process lifecycle](architecture/operations.md#worker-process-lifecycle)
- [Command-line entry points](architecture/operations.md#command-line-entry-points)
- [Administrative CLI and TUI](architecture/operations.md#administrative-cli-and-tui)
- [Operational limits](architecture/operations.md#operational-limits)
