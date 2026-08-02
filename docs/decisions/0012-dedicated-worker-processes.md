# ADR 0012: Dedicated worker processes as the production default

- **Status:** Accepted
- **Date:** 2026-08-02
- **Related:** [ADR 0003](0003-worker-owned-scheduler.md), [native worker concurrency analysis](../benchmarks/2026-08-02-native-worker-concurrency-analysis.md)

## Context

Workhorse initially demonstrated workers inside the Hono demo process. That topology is convenient, but it couples HTTP replica count, worker capacity, PostgreSQL pool pressure, deployment drains, and failure domains. Configurable worker concurrency also raised a separate question: whether capacity should be expressed as multiple one-slot worker loops or as bounded slots behind one coordinator.

The native concurrency benchmark showed that one multi-slot worker and multiple independent workers provide equivalent throughput for representative I/O-like handlers at equal total capacity. The single coordinator bounds concurrent claim pressure. Multiple coordinators improve only extremely short no-op workloads where claim round trips dominate. The existing `Worker.stop()` contract stops later claims and drains active handlers while their heartbeat loops continue, but Node process signals and a bounded hard-exit policy were application-owned.

Production workers need a repeatable process boundary that does not depend on a web framework. The boundary must distinguish process termination from durable job cancellation, preserve lease/fence truth, close owned resources, fail coherently when a worker loop fails, and expose only the minimum optional surface needed by an orchestrator.

## Decision

Dedicated worker processes are the recommended production topology. Hono co-hosting remains supported for development, demonstrations, and explicitly small deployments.

Core exports three process APIs:

1. `defineWorkerProcess()` type-checks a module configuration.
2. `startWorkerProcess()` starts configured workers without global signal ownership.
3. `runWorkerProcess()` owns standalone `SIGINT` and `SIGTERM` behavior.

The package exposes `workhorse worker --config <compiled-module>`. The module default-exports a definition that creates one process-owned adapter and configures one or more Workers. The CLI imports compiled JavaScript rather than embedding a TypeScript runtime.

The first termination signal marks readiness false, stops every worker, drains all committed active work, then closes adapter and probe resources. Heartbeats continue during the drain. The signal does not abort handler signals or create a durable cancellation outcome. A claim transaction already in flight may commit and is drained; no later claim request begins after shutdown is observed.

Shutdown defaults to a 25-second deadline. A second signal hard-exits with the conventional signal code. A missed deadline hard-exits with code 1. Hard termination leaves leases to expire and be recovered through the normal fenced protocol. An unexpected worker-loop resolution or rejection is fatal to the process runtime, stops sibling workers, and applies the same bounded drain before resources close.

An optional status-only HTTP server provides liveness and readiness endpoints. It is not application ingress. Readiness becomes unavailable during drain while liveness remains available until resource shutdown completes.

Within one process, the default topology is one multi-slot Worker per materially distinct queue or policy group. Operators scale process replicas for availability and aggregate capacity rather than creating one Worker per slot.

## Consequences

### Positive

- HTTP and job capacity scale independently.
- Worker failures and long drains do not remove application ingress capacity.
- Every production process receives the same signal, deadline, resource-close, and exit-code behavior.
- Active handlers retain heartbeats and fenced ownership during graceful drain.
- Hard termination remains truthful: leases expire instead of being mislabeled as handler failures.
- One multi-slot coordinator limits claim-query pressure for normal asynchronous workloads.
- Framework integrations no longer define the only convenient worker lifecycle.
- Probe endpoints let container schedulers remove a draining worker before it exits.

### Negative

- Production deployment requires another process or workload definition.
- Each process needs an explicitly budgeted PostgreSQL pool, memory allocation, and replica count.
- The CLI configuration must be compiled before a plain Node production invocation.
- A shutdown deadline can terminate a legitimate long-running handler before it completes.
- Hard exit cannot run application cleanup and relies on lease expiry for recovery.
- The optional probe listener adds a small HTTP server even though the process has no application ingress.

## Rejected alternatives

### Co-host workers with web servers by default

This minimizes deployment objects but accidentally ties worker concurrency and scheduler contenders to HTTP autoscaling. It also requires one shutdown path to coordinate unrelated request and job drains.

### Install signal handlers in every `Worker` constructor

Individual workers do not own the Node process or shared adapter. Multiple instances would install competing global listeners and could close shared resources prematurely. Signal ownership belongs to the process runner.

### Abort active handlers on process termination

Process drain and durable job cancellation have different meanings. Aborting handlers would require defining whether the attempt failed, canceled, retried, or remained leased. Workhorse instead preserves ownership during the bounded drain and relies on expiry recovery after hard termination.

### Run one one-slot Worker per concurrency slot

The benchmark found no useful-work throughput advantage for I/O-like handlers and observed greater simultaneous claim pressure. Independent coordinators remain appropriate only for different queues or policies, not as the default slot implementation.

### Wait forever for graceful shutdown

A JavaScript handler may never settle. Unbounded shutdown prevents supervisors from replacing the process and can defeat deployment termination guarantees.

## Validation

Acceptance requires unit coverage for idempotent startup/shutdown, sibling shutdown after unexpected worker failure, adapter cleanup after configuration failure, first-signal drain, second-signal conventional exit, deadline exit, probe running/draining status, input validation, CLI help/error behavior, packed public types and binary contents, lint, typecheck, the complete integration suite, and documentation of benchmark evidence and operational limitations.
