# ADR 0017: Durable worker registry with process-scoped operator pause

- **Status:** Accepted
- **Date:** 2026-08-04
- **Related:** [ADR 0012](0012-dedicated-worker-processes.md), [ADR 0010](0010-cooperative-job-cancellation.md), [ADR 0018](0018-framework-neutral-dashboard-host.md)

## Context

ADR 0012 made dedicated worker processes the production default, but the operator dashboard could not follow. It read worker identity, declared concurrency, slot use, and pause state from process-local `Worker` objects, so it only ever knew about workers sharing its own process.

That single design decision forced the dashboard and the workers into one process. Following our own topology recommendation meant giving up the workers view, and the demo could not run the arrangement it documented.

Worker control had the same problem from the other side. `Worker.pause()` was a method call on an object, so it could not reach a worker in another process, and there was no durable record of an operator having asked for anything.

## Decision

Workers register themselves in `workhorse.worker_registry`, one row per live worker. Each SDK
exposes its own refresh cadence and opt-out option.

Ownership of the row is deliberately split:

- the **worker** publishes `queue_name`, `concurrency`, `active_slots`, `draining`, `hostname`, and `pid`
- **PostgreSQL** owns `paused`, which `register_worker_v1` returns in the same round trip

One call therefore pushes the state the worker knows and pulls the decision the database knows, which is what lets an operator surface report and control a fleet it does not host.

Registration refresh runs on its own loop rather than riding maintenance, because a maintenance pass evaluates and fires every due schedule and could otherwise starve fleet liveness.

### Operator pause is process-scoped

Each worker lifecycle start announces a fresh `instance_id`. `register_worker_v1` preserves
`paused` while that instance keeps refreshing, and clears it — with its attribution — when a new
instance takes over the same worker id.

The alternative, a pause that survives restarts, was considered and rejected. It requires stable worker identities, and it turns a 3am incident action into a flag that silently idles a worker after an unrelated deployment weeks later. Queue pause already provides a durable "stop this work" lever, keyed by queue name and unaffected by worker lifecycles, so the two controls stay distinct rather than overlapping.

Without `instance_id`, PostgreSQL could not distinguish a routine heartbeat from a restart, and the flag would be either indefinitely sticky or cleared by the worker's own next heartbeat.

### Identity and placement are separate columns

The default worker id is `<hostname>-<pid>-<random>`, which is readable in a fleet view and unique per instance. But a deployment that configures a stable `workerId` would otherwise lose any trace of where a worker runs, so `hostname` and `pid` are recorded as their own columns rather than inferred from the identity string.

### Failure is non-fatal but not silent

Registration is not part of the dispatch contract, so a failure never stops a worker from claiming.
TypeScript reports it through `WorkerOptions.onRegistrationError`, Python through
`on_registration_error`, and Go through `WorkerOptions.OnRegistrationError`, because an invisible
worker that continues to run is otherwise indistinguishable from a dead one.

## Consequences

- An operator dashboard mounted in any process reports every live worker. Mounting requires only a database connection.
- Reported slot use is eventually consistent, bounded by the refresh cadence. It is an operational indicator, not a synchronous read of another process's event loop.
- Pause takes effect within roughly one registry interval and never interrupts a running handler,
  matching the cooperative model established for cancellation in ADR 0010. TypeScript and Python
  keep local pause separate, so a local resume cannot clear an operator pause that is still in
  effect.
- `requestedBy` and `reason` remain bounded attribution, never authorization. Callers enforce their own permission checks.
- Graceful shutdown deregisters. A killed worker stops refreshing, is reported offline once its registration goes stale, and is removed by the bounded `prune_worker_registry_v1`.
- The relation holds one row per live worker and is never read by the claim path, so it cannot affect dispatch cost.
- Several workers may share a process, and therefore a hostname and pid. The random suffix in the default identity is what keeps them distinct, and `instance_id` is per `Worker` rather than per process so pause remains scoped correctly in that case.

## Non-goals

- Durable, restart-surviving worker quarantine. That is queue pause, or scaling the deployment.
- A worker role identity distinct from its lease identity. One id serves both; a future split would change the registry's primary key and belongs in its own decision.
- Forcing a worker to stop. Pause is cooperative in exactly the sense cancellation is.
