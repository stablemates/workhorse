# ADR 0018: Framework-neutral dashboard host

- **Status:** Accepted
- **Date:** 2026-08-04
- **Related:** [ADR 0017](0017-durable-worker-registry.md), [ADR 0012](0012-dedicated-worker-processes.md), [ADR 0021](0021-no-framework-integration-packages.md)
- **Superseded in part by:** [ADR 0021](0021-no-framework-integration-packages.md), [ADR 0022](0022-built-in-dashboard-authentication.md)

## Context

The mountable dashboard lived in `@workhorse-js/hono` as roughly 200 lines, of which only about 40 were Hono-specific route registrations. Asset serving, HTML templating, runtime-configuration injection, oRPC prefixing, and the SSE stream were already written against Web `Request`/`Response` but were reachable only through Hono.

The mount also required a `HonoWorkhorse` — a worker-lifecycle object — purely to reach a database connection and a `Queue`. Mounting an admin page therefore meant constructing a worker runtime, which contradicted the topology in ADR 0012.

Separately, the demo's development mode reimplemented the HTML contract in its own Vite config: two implementations of the same runtime-configuration injection, in different packages, with nothing forcing them to agree.

## Decision

Dashboard behavior lives in `createDashboardHost` in `@workhorse-js/dashboard/server`. It takes a `Request` and returns a `Response`, or `null` when the request does not belong to its mount path, so a host falls through to its own routing untouched.

`@workhorse-js/hono` becomes a thin binding that maps the host's mount path onto Hono routes, and drops its `@orpc/server` dependency.

Three further consequences follow from making the host the single owner:

- **`dashboardNodeMiddleware`** adapts the host to Connect-style hosts, so Express, Connect, and Fastify integrate without new packages. Fetch-native hosts — Hono, Next.js route handlers, SvelteKit, Nitro — call `handle` directly.
- **`renderDashboardHtml`** is the one implementation of the HTML contract. The request host and any development server share it, so adding a runtime field reaches every caller rather than silently applying to one.
- **`createDashboardDevServer`** in `@workhorse-js/dashboard/dev` runs Vite in middleware mode against this package's own browser entry. A host mounts its middlewares and passes it as `dev`, and one origin then serves the live-compiled UI with hot reload while the page is still assembled by the same host a production consumer runs. `vite` is an optional peer, loaded on demand.

### The mount takes a connection, not a connection string

`createDashboardHost` accepts a `Queryable`. It is a guest in the caller's process and must not own pool sizing, shutdown ordering, reconnection, or TLS for an application that already has a connection. A structural interface also keeps the package driver-agnostic and free of a `pg` dependency, and works for deployments that have no URL at all, such as IAM token auth or unix sockets.

It does not take a `Queue` either. The read model needed one only for `health()`, which reads through the same connection, so the host constructs it.

The standalone `workhorse dashboard` CLI is the deliberate exception: it owns its process, so it owns its pool and accepts a connection string. It binds loopback and is read-only by default, because a standalone console has no session to authorize against; `--host` and `--allow-mutations` widen that and warn.

## Consequences

- Mounting the dashboard requires only a database connection. Combined with ADR 0017, an application can host the operator console while every worker runs elsewhere.
- Adding a framework means writing route registration, not reimplementing the dashboard. Lifecycle integration — transactional enqueue, startup, graceful shutdown — remains the real per-framework work.
- The demo is a plain consumer: no Vite config, no browser entry, no React dependency, and no path a real application could not copy.
- Development and production differ only in where modules come from. The HTML is assembled by the same code in both.
- `@workhorse-js/core` gained a `dashboard` command without installing `@workhorse-js/dashboard` for worker-only users. The type-only `@workhorse-js/dashboard-contract` package now defines the standalone entry point without depending on either package. Core loads the optional `@workhorse-js/dashboard/standalone` entry, while dashboard implements the shared contract, so package checks replace the former runtime-built specifier and copied structural types.

## Non-goals

- Publishing framework packages for their own sake. The host covers mounting; a package is justified only by lifecycle integration.
- Authentication or RBAC was outside this decision. ADR 0022 later adds a built-in single-admin
  mode while preserving host-supplied authorization for embedded dashboards.
