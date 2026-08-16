# ADR 0032: Keep single-admin authentication process-local

- **Status:** Accepted
- **Date:** 2026-08-16
- **Related:** [ADR 0018](0018-framework-neutral-dashboard-host.md), [ADR 0022](0022-built-in-dashboard-authentication.md), [ADR 0029](0029-embeddable-dashboard-backends.md)
- **Clarifies:** the baseline session model selected by ADR 0022

## Context

ADR 0022 selected built-in credentials for a standalone dashboard that has no application session.
The implementation stores opaque session tokens in one process and applies one process-wide login
failure window.

That model has deliberate limits. A server restart ends every session. Replicas do not share
sessions or login failures. The session cap evicts the oldest successful login when another login
would exceed it. One caller can consume the shared failure window and temporarily stop all logins.

A durable store would support replicas and survive restart, but it would put authentication data,
cleanup, and availability inside the Workhorse database protocol. Per-source throttling would also
require a trusted client-address boundary that the standalone server does not currently have.

## Decision

Keep built-in `singleAdmin` authentication as a single-process deployment mode. Run one standalone
server replica when it owns authentication. Restart is a valid way to revoke every active session.

The server stores random session tokens and absolute expiry in process memory. It retains a bounded
set, removes expired records during login, and evicts the oldest record before accepting another
session beyond the cap.

The login failure window remains process-wide. The server does not partition failures by
`Forwarded` or `X-Forwarded-For`, because those headers are untrusted unless a deployment defines
and enforces a proxy trust chain.

This mode remains one administrator with one authority level. It is suitable for one protected
operator service behind TLS. It is not a highly available identity system.

Deployments that require replicas, durable sessions, individual identities, or per-actor policy
use an embedded dashboard with host-owned `authorize`, or an identity-aware proxy in front of the
standalone service. Those systems own their shared session store and trusted network boundary.

## Consequences

- The baseline stays self-contained and adds no authentication tables to the core schema.
- Restart, rollout, or process replacement signs the administrator out.
- Built-in authentication cannot load-balance across independent replicas without connection
  affinity, and connection affinity does not share login throttling.
- The bounded session set can evict an older browser. This is acceptable for one administrator,
  but the operator guide must state the single-process boundary.
- SSO and role-based access remain a separate capability rather than extending `singleAdmin` into a
  second identity platform.

## Rejected alternatives

### Store built-in sessions in the Workhorse database

This would make session availability depend on protocol migrations and database access. It would
also add credential rotation, cleanup, and security policy to a queue schema that does not own user
identity.

### Trust forwarding headers for per-source throttling

An untrusted client can choose those values. Supporting them safely requires explicit trusted-proxy
configuration and address normalization outside this baseline decision.

### Remove built-in authentication

Requiring every standalone deployment to add an identity proxy would undo the adoption path chosen
in ADR 0022. The constrained single-process mode remains useful when its boundary is explicit.
