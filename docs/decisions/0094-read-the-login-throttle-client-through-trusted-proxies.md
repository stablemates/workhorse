# ADR 0094: Read the login-throttle client through trusted proxies

- **Status:** Accepted
- **Date:** 2026-10-07
- **Related:** [ADR 0032](0032-keep-single-admin-authentication-process-local.md)
- **Supersedes:** the rule in [ADR 0093](0093-key-single-admin-login-throttling-by-transport-peer.md)
  that the server never reads `Forwarded` or `X-Forwarded-*`
- **Issue:** SM-1177

## Context

ADR 0093 keys single-admin login throttling by the transport peer. Behind a reverse proxy, every
connection's peer is the proxy. Five wrong passwords from one client therefore answer `429` to
every client of that proxy, including the administrator.

The proxy knows each client's address and appends it to `X-Forwarded-For` or `Forwarded`. The
client can write those headers too. A hop is therefore honest only when a proxy the operator trusts
wrote it.

## Decision

The operator names trusted proxies. The default list is empty, and an empty list keeps ADR 0093's
behavior exactly: the client is the socket peer, and no forwarding header is read.

- `dashboardNodeMiddleware` takes `trustedProxies`, a list of IPv4 or IPv6 addresses and CIDR
  ranges. `workhorse dashboard` maps `--trusted-proxy` and `WORKHORSE_DASHBOARD_TRUSTED_PROXIES` to
  it. Any flag replaces the whole variable.
- The middleware reads a forwarding header only when the socket peer is in the list.
- That request must carry exactly one of `X-Forwarded-For` and `Forwarded`. When it carries both,
  the client wrote one of them and nothing says which, so the client stays the peer.
- `Forwarded` is split outside quoted strings. A header whose quoted string never closes keeps
  the peer, because a client's open quote would otherwise hide the hop its proxy appends.
- The middleware walks the hops from the right. The first hop that is not itself a trusted proxy
  is the client. When every hop is trusted, the leftmost hop is the client.
- An unparseable hop, such as `unknown` or an obfuscated `Forwarded` identifier, ends the walk. The
  client is then the trusted proxy that wrote that hop.
- The chosen address becomes `DashboardRequestContext.clientAddress`. ADR 0093's keying still
  applies to it, including the /64 grouping of IPv6 addresses.
- Parsing is strict, and a malformed entry stops the listener at startup. An entry must be one
  address or one range. A range must not set bits beyond its prefix. A prefix of 0 is refused,
  because it would trust every client. An IPv4-mapped IPv6 entry must be written as its IPv4
  address, and an address with a zone is refused.
- A Unix socket listener refuses a non-empty list, because its peer has no address to trust.

ADR 0093's other decisions stand: the bounded client table, the global hashing bound, and the
shared `unidentified` key.

## Consequences

- Clients behind a named proxy get separate login windows, so one of them cannot pause login for
  the others.
- A client cannot choose its key by writing a forwarding header. Every hop it writes lies left of
  the hop its first trusted proxy appends.
- A client inside a trusted range is treated as a proxy. Its own forwarding header can then choose
  its key, so a range should cover only proxies.
- A trusted proxy that forwards the client's own `Forwarded` header and appends `X-Forwarded-For`
  sends both headers. Its clients then share the proxy's window, as before this decision.

## Rejected alternatives

### Trust the rightmost forwarded address from any peer

A client reaching the listener directly would then choose its own key on every request.

### Prefer one header when both are present

The client may have written the preferred one. Keeping the peer costs only the shared window that
existed before, and the client cannot use it to impersonate another address.

### Ignore a malformed entry

A typo would then silently trust no proxy, or the wrong one. Refusing to start makes the mistake
visible before any traffic arrives.
