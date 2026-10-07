# ADR 0093: Key single-admin login throttling by the transport peer

- **Status:** Accepted; the rule against reading forwarding headers superseded by [ADR 0094](0094-read-the-login-throttle-client-through-trusted-proxies.md)
- **Date:** 2026-10-06
- **Related:** [ADR 0022](0022-built-in-dashboard-authentication.md), [ADR 0032](0032-keep-single-admin-authentication-process-local.md)
- **Supersedes:** the process-wide login failure window in ADR 0032
- **Issue:** SM-1168

## Context

ADR 0032 kept one login failure window for the whole process. It rejected per-source throttling
because the standalone server had no trusted client address. Five wrong passwords a minute from
anyone therefore answered `429` to every login, including the administrator's. A security review
rated that lockout Medium.

The transport does establish one address the client cannot choose: the peer of the TCP
connection. `Forwarded` and `X-Forwarded-For` are not such an address, because the client writes
them.

## Decision

Single-admin authentication counts login reservations per client. The client is the transport peer
address that `DashboardRequestContext.clientAddress` carries.

- `dashboardNodeMiddleware` passes `request.socket.remoteAddress`. A host that calls
  `handle(request, context)` itself passes an address it established.
- An IPv6 address shares one key with its /64 prefix, because one subscriber usually controls the
  whole prefix. An IPv4-mapped IPv6 address counts as its IPv4 address.
- A request without a parseable address shares one key with every other such request. A Unix
  socket listener therefore keeps the process-wide window.
- The server never reads `Forwarded` or `X-Forwarded-*`.
- The table of tracked clients is bounded. When it is full, the client tracked longest ago leaves
  first.
- A global bound limits concurrent scrypt derivations across every client. A submission beyond it
  answers `429` and reserves nothing.

Behind a reverse proxy the peer is the proxy. Every client of that proxy shares the proxy's key,
and one of them can still pause login for the others. Fixing that needs a trusted-proxy setting
that names which peers may state a forwarded address. That changes the CLI and the deployment
contract, so it is separate work.

ADR 0032's other decisions stand: sessions stay in process memory, and one replica owns them.

## Consequences

- A caller reaching the listener directly cannot lock out an administrator who connects from
  another address.
- An attacker with many addresses gets five guesses per address per minute. The global hashing
  bound caps the CPU and memory those guesses cost, not their number.
- Evicting the oldest tracked client lets a caller with more than the table's capacity of addresses
  reset its own oldest windows. It cannot reset a window it does not own without filling the
  table first.
- Deployments behind a proxy keep the shared-window behavior until a trusted-proxy setting exists.

## Rejected alternatives

### Trust forwarding headers

An untrusted client chooses those values, so it could spread its guesses across invented
addresses or charge its failures to the administrator's address.

### Keep a global ceiling beside the per-client window

A ceiling on all failures would restore the lockout this decision removes. The hashing bound limits
resource use without refusing a client that has not failed.

### Refuse new clients when the table is full

A caller with enough addresses could then lock out every new client. Evicting the oldest entry
keeps login available.
