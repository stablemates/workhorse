# ADR 0048: Extract the TypeScript OpenTelemetry adapter

- **Status:** Accepted
- **Date:** 2026-08-27
- **Related:** [WH-446](https://app.plane.so/techprogress/browse/WH-446/), [ADR 0024](0024-metrics-instrument-lifecycle.md), [ADR 0041](0041-apache-2-and-contributor-agreement.md)

## Context

OpenTelemetry emission stays free and ships with the public beta. The language packages still need
different dependency boundaries because their package managers fail differently.

TypeScript core pins `@opentelemetry/api` and the unstable `@opentelemetry/api-logs` package as
ordinary dependencies. A consumer may then load an API copy that differs from the copy used by its
SDK. The losing copy can receive a no-op provider without reporting an error. Making those packages
optional peers would not fix core because its emitted JavaScript imports them statically.

Go selects one module version for a build, so its direct API dependency does not have the same
duplicate-copy failure. Python already puts its API dependency behind the `telemetry` extra and
falls back to no-op behaviour when that extra is absent.

## Decision

TypeScript core defines a vendor-neutral `WorkhorseTelemetryProvider`. Core owns the names and
meanings of its spans, metrics, logs, and queue observations. A provider translates those records
without exposing vendor types through the core API.

One provider may be active in a process. Core uses a permanent no-op provider until an application
registers another one. Registration rejects a competing active provider and returns a cleanup
function. Every emission consults the current provider, so registration after core import preserves
the late-installation guarantee from ADR 0024.

The free `@stablemates/workhorse-otel` package implements that provider. Its explicit
`registerOpenTelemetry()` function uses OpenTelemetry's global tracer, meter, logger, context, and
propagation providers. It carries traces, metrics, logs, and queue observations, and returns the
core registration cleanup function. Importing the package has no registration side effect.

The adapter declares compatible `@opentelemetry/api` and `@opentelemetry/api-logs` peer
dependencies. It also declares a compatible `@stablemates/workhorse` peer dependency. Installation
therefore resolves one host-owned API set or reports a version conflict instead of silently loading
an isolated copy.

Go keeps direct OpenTelemetry API dependencies in its module. Python keeps its optional `telemetry`
extra and no-op fallback.

## Consequences

Applications that do not use OpenTelemetry can import TypeScript core without installing any
OpenTelemetry package. Applications that do use it install the adapter and compatible API peers,
configure the global SDK providers, and call `registerOpenTelemetry()`.

The unstable logs API remains visible only to adapter consumers. A logs compatibility conflict can
block adapter installation, but it cannot block installation of core.

The extraction must preserve the W3C trace context stored by Workhorse, provider-aware metric
lifecycles, the cross-language signal catalogue, and no-op queue behaviour. Packed-package tests
must cover core without OpenTelemetry and the adapter with its peers installed.
