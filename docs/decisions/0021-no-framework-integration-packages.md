# ADR 0021: Web frameworks do not own worker integration

- **Status:** Accepted
- **Date:** 2026-08-11
- **Related:** [ADR 0012](0012-dedicated-worker-processes.md), [ADR 0018](0018-framework-neutral-dashboard-host.md)

## Context

The Hono, Express, and Fastify packages combined request-scoped queue access with worker startup and
shutdown. The lifecycle half encouraged web replicas to own workers, even though worker capacity,
failure isolation, database pools, and deployment drains need an independent process boundary.

The request half did not justify packages of its own. Applications can inject `Queue` or an ORM
adapter through their existing dependency-injection conventions. The dashboard already exposes a
Fetch-native host and a Connect-style Node bridge, so mounting it does not require a framework
package either.

## Decision

Workhorse does not publish framework integration packages. Workers run in dedicated processes
through `defineWorkerProcess`, `startWorkerProcess`, or the `workhorse worker` command. Each process
owns its worker lifecycle and database resources.

Web applications enqueue through `Queue` or an ORM adapter using their normal dependency-injection
mechanism. Fetch-native frameworks call `createDashboardHost().handle(request)` directly, while
Connect-style frameworks use `dashboardNodeMiddleware`.

The demo keeps Hono as an application dependency because it needs a basic HTTP server. Its Hono
process mounts the generic dashboard host and runs no workers. Two separate processes each run one
demo worker and own one PostgreSQL pool.

## Consequences

- HTTP replica count cannot silently multiply worker capacity or database pressure.
- Worker shutdown and failure handling remain independent of framework lifecycle hooks.
- Supporting another web framework requires documentation or an example only when its request
  adapter is unusual; it does not require another published package.
- Transactional enqueue remains an ORM boundary. Additional ORM adapters may still justify optional
  packages because transaction types and ownership differ materially.

## Superseded decisions

This decision supersedes ADR 0012's support for Hono co-hosting and ADR 0018's planned thin Hono
binding. Their dedicated-process and framework-neutral dashboard decisions remain accepted.
