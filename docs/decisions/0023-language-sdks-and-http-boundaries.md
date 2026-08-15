# ADR 0023: Language SDKs and HTTP boundaries

- **Status:** Accepted; superseded in part by [ADR 0029](0029-embeddable-dashboard-backends.md)
- **Date:** 2026-08-11
- **Related:** [ADR 0012](0012-dedicated-worker-processes.md), [ADR 0015](0015-operator-query-api.md), [ADR 0018](0018-framework-neutral-dashboard-host.md), [ADR 0021](0021-no-framework-integration-packages.md)

> ADR 0029 supersedes the clause "Python and Go do not embed or reimplement it": language SDKs
> may embed the dashboard by implementing its backend against the versioned `dashboard/v1` wire
> specification. The standalone dashboard remains supported as decided here.

## Context

Workhorse currently publishes TypeScript clients and workers. Its correctness-sensitive lifecycle
already lives in versioned PostgreSQL functions, but its dashboard server and private oRPC transport
live in the JavaScript package. Porting the dashboard and its read model into every supported
language would create several operator products that drift independently.

Workhorse also has no supported application HTTP ingress API. The dashboard RPC endpoint is a
private browser transport, and the worker probe listener exposes only health state. Reusing either
surface for application calls would mix operator authority with application ingress and stabilize a
contract that was never designed for callers.

## Decision

PostgreSQL remains the language-neutral durable protocol. Python and Go each receive a native
client and worker SDK. Those SDKs own language-specific transactions, handler execution,
cancellation, concurrency, shutdown, and telemetry integration, while versioned SQL functions keep
claim, fence, heartbeat, retry, and settlement correctness out of language implementations.

The standalone dashboard is the common administration surface for every language. It owns its
database pool, authenticated operator HTTP service, React application, private RPC transport, and
generic queue controls. JavaScript and TypeScript applications may continue to embed the same
dashboard as a convenience, but Python and Go do not embed or reimplement it.

A future public HTTP ingress API is a separate product boundary. It uses a versioned caller
contract, its own listener and credentials, and application-oriented authorization and rate limits.
It does not share the dashboard's private RPC contract or expose administrative operations. Direct
client enqueue remains available when an application must join enqueueing to its own PostgreSQL
transaction; HTTP ingress cannot participate in that transaction.

## Consequences

- Every supported language receives the same dashboard UX and administrative behavior.
- Python and Go support require lifecycle and compatibility tests against the same schema version,
  without translating the TypeScript implementation line for line.
- The dashboard can evolve its private RPC transport without breaking application clients.
- Operators can deploy administration on a private network while exposing ingress through a
  separately scaled and secured endpoint.
- Supporting clients without PostgreSQL access remains possible through future HTTP ingress, but it
  adds a network dependency and cannot preserve caller-owned transaction atomicity.
