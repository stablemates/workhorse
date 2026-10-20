# JVM changelog

The versions and release notes of the three JVM artifacts live here: `run.workhorse:workhorse`,
`run.workhorse:workhorse-kotlin`, and `run.workhorse:workhorse-spring-boot-starter`. The three
artifacts always carry one version. It is the version that the other SDKs carry, because every
release tag names one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## Unreleased

This is the first release of the JVM SDK. The npm packages, Python distribution, Go module, Rust
crate, Ruby gem, and JVM artifacts release from one source commit.

Requires **schema v72**, Java **21** or newer, and PostgreSQL **15** or newer.

- The JVM SDK needs schema version 72 or later. The SDK compatibility floor is schema version
  **72**. Install or migrate the schema with the `workhorse` CLI as a deployment step, before the
  application starts. The application never installs or migrates the schema.
- The SDK has three artifacts. All three use the group `run.workhorse` and one version ([ADR
  0103](../docs/decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)):
  - `workhorse`, package `run.workhorse`: the queue client, `Admin`, the worker, and the dashboard
    backend.
  - `workhorse-kotlin`, package `run.workhorse.kotlin`: suspend handlers, suspend wrappers, and a
    worker DSL.
  - `workhorse-spring-boot-starter`, package `run.workhorse.spring`: auto-configuration,
    transactions, lifecycle, and health.
- Every module compiles with `--release 21`. The Kotlin module sets language and API version 2.2,
  and needs kotlinx-coroutines 1.10.2 or later. The starter needs Spring Boot 4.0 or later. Every
  module needs PgJDBC 42.7.12 or later. Spring Boot 4.0.0 to 4.0.7 manage an older PgJDBC, so use
  Spring Boot 4.0.8 or later, or override `postgresql.version`. [Supported
  versions](../docs/compatibility.md#supported-versions) states each floor and its end-of-life date.
- The core has two optional dependencies, the OpenTelemetry API and the Jakarta Servlet API. Maven
  does not add them. Gradle adds each one only when the build asks for its feature, `opentelemetry`
  or `servlet`.
- The worker renews leases through `heartbeat_many_v2`, and it keeps a lease that the answer marks
  `busy`. Its heartbeat rounds follow the rules of the other SDKs: a fixed schedule, a round bound
  of three quarters of the interval from 200 ms, and server timeouts in each round on the dedicated
  connection. A round that expires before it sends the heartbeat statement rolls back and keeps
  the dedicated connection, and a round that may still run a statement discards it. A busy retry
  with less than 20 ms left before its deadline sends nothing, and the next regular round renews the
  busy leases (SM-1492). For `Worker.Builder.heartbeat` and `WorkerScope.heartbeat`, 100 ms is the
  smallest supported value. The [heartbeat round
  deadline](../docs/architecture/lifecycle.md#heartbeat-round-deadline) and the [heartbeat
  schedule](../docs/architecture/lifecycle.md#heartbeat-schedule) state each rule.
