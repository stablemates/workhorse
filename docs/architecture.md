# Workhorse architecture

This is the precise reference for Workhorse. Use it to find out whether observed behavior is a bug.
Each page under [`architecture/`](architecture/) owns one area. The page names the functions,
columns, and limits of that area. For an explanation of a concept, read the
[guides](guides/000-start-here.md) first.

## Pages

### [Overview](architecture/overview.md)

- [Design objective](architecture/overview.md#design-objective)
- [System context](architecture/overview.md#system-context), including the adapter contract
- [Errors](architecture/overview.md#errors)
- [Tenancy](architecture/overview.md#tenancy)

### [Schema, SQL protocol, and SDKs](architecture/schema-and-protocol.md)

- [Schema versions and migrations](architecture/schema-and-protocol.md#schema-versions-and-migrations):
  the current version, the migration plan, and the migration runner
- [SQL protocol conformance](architecture/schema-and-protocol.md#sql-protocol-conformance),
  including [durable replay conflicts](architecture/schema-and-protocol.md#durable-replay-conflicts)
  and the TypeScript test that [replays stored state](architecture/schema-and-protocol.md#replay-stored-state-in-a-test)
- The [Python](architecture/schema-and-protocol.md#python-sdk),
  [Go](architecture/schema-and-protocol.md#go-sdk),
  [Ruby](architecture/schema-and-protocol.md#ruby-sdk),
  [Rust](architecture/schema-and-protocol.md#rust-sdk),
  [JVM](architecture/schema-and-protocol.md#jvm-sdk), and
  [.NET](architecture/schema-and-protocol.md#net-sdk) SDKs. The JVM section covers the Java core,
  the Kotlin module, and the Spring Boot starter. The .NET section covers
  [connections](architecture/schema-and-protocol.md#net-connections), the
  [queue](architecture/schema-and-protocol.md#net-queue),
  [`Admin`](architecture/schema-and-protocol.md#net-admin), the
  [worker](architecture/schema-and-protocol.md#net-worker),
  [batch handlers](architecture/schema-and-protocol.md#net-batch-handlers),
  [hosting](architecture/schema-and-protocol.md#net-hosting),
  [EF Core transactions](architecture/schema-and-protocol.md#net-ef-core-transactions),
  [telemetry](architecture/schema-and-protocol.md#net-telemetry),
  [values and JSON](architecture/schema-and-protocol.md#net-values-and-json), and the
  [handler context](architecture/schema-and-protocol.md#net-handler-context).
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

### [Task groups](architecture/task-groups.md)

- The [task group](architecture/task-groups.md#task-groups) lifecycle, tables, counter shards,
  callbacks, cancel, drift repair, maintenance, the dashboard read, and limits

### [Fast tier](architecture/fast-tier.md)

- The [fast task tier](architecture/fast-tier.md#fast-tier): its settings, tables, functions,
  rejected features, and workers
- [Throttle on a fast-tier queue](architecture/fast-tier.md#throttle-on-a-fast-tier-queue), which
  writes no `throttled` event

### [Dashboard](architecture/dashboard.md)

- The [`dashboard/v1` wire contract](architecture/dashboard.md#dashboard-wire-contract), including
  the [cross-origin read refusal](architecture/dashboard.md#cross-origin-reads) of every backend
- The [dashboard package boundary](architecture/dashboard.md#dashboard-package-boundary), including
  the [Task groups page](architecture/dashboard.md#task-groups-page) and authentication
- The embedded [Python](architecture/dashboard.md#python-backend),
  [Go](architecture/dashboard.md#go-backend), [JVM](architecture/dashboard.md#jvm-backend), and
  [.NET](architecture/dashboard.md#net-backend) backends
- The SPA [browser preferences](architecture/dashboard.md#browser-preferences) and their defaults
  when browser storage fails

### [Telemetry](architecture/telemetry.md)

- [OpenTelemetry metrics](architecture/telemetry.md#opentelemetry-metrics)
- [Traces, logs, and baseline metrics](architecture/telemetry.md#opentelemetry-traces-logs-and-baseline-metrics)

### [Operations and CLI](architecture/operations.md)

- [Deployment synchronization](architecture/operations.md#deployment-synchronization)
- [Worker process lifecycle](architecture/operations.md#worker-process-lifecycle)
- [Command-line entry points](architecture/operations.md#command-line-entry-points)
- [Administrative CLI and TUI](architecture/operations.md#administrative-cli-and-tui)
- [Database roles](architecture/operations.md#database-roles) for the installation, dashboard, and
  worker connections
- [Operational limits](architecture/operations.md#operational-limits)
