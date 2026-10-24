# ADR 0022: Built-in dashboard authentication

- **Status:** Accepted
- **Date:** 2026-08-11
- **Related:** [ADR 0018](0018-framework-neutral-dashboard-host.md), [ADR 0020](0020-database-authoritative-configuration.md)
- **Clarified by:** [ADR 0032](0032-keep-single-admin-authentication-process-local.md)

## Context

An embedded dashboard can delegate authentication to its host through `authorize`, but the
standalone `workhorse dashboard` process has no application session to reuse. Loopback binding is a
safe local default, not an authentication mechanism for a remotely reachable operator service.

Requiring every installation to deploy an identity-aware proxy would make the standalone service
needlessly difficult to adopt. Treating browser-supplied `auditActor` values as identity would also
make mutation records attribution claims rather than authenticated audit evidence.

## Decision

The dashboard supports two exclusive authentication modes.

The baseline standalone mode uses one administrator username and password supplied through
environment-backed server configuration. Production configuration stores a password hash rather
than a plaintext password. A successful login creates a bounded `Secure` and `HttpOnly` cookie session;
the server owns expiry, logout, credential rotation, origin validation, and login throttling. The
authenticated username supplies the audit actor for every mutation.

Embedded JavaScript and TypeScript hosts may instead keep the existing application-owned
authorization boundary. The host authenticates the request through its own session and returns a
server-verified principal. The dashboard never combines host authorization with its built-in
credential mode, and it never accepts browser input as proof of identity.

SSO, multiple users, role-based access control, and human-specific audit history are a premium
capability built on the same server principal. They do not delay the baseline single-admin mode and
are not implied by it.

## Consequences

- A standalone dashboard can be exposed behind TLS without requiring an application host or a
  separate identity proxy.
- A supported container carries the standalone service for installations that do not otherwise run
  Node.js.
- One configured administrator has one authority level. Installations that need individual
  identities or narrower permissions use the later SSO and RBAC capability.
- Direct PostgreSQL access remains outside dashboard authorization. Deployment guidance must still
  apply least-privilege database roles and network controls.
- A development bypass remains explicit and is valid only on loopback or a Unix socket.

## Amendment: the database role guidance exists (2026-10-23)

The consequences above promise least-privilege database roles, but no guidance existed. SM-1667
records this amendment. The decision text does not change.

1. [Operations: Database roles](../architecture/operations.md#database-roles) gives the SQL for
   four roles: the installation role, the read-only dashboard, the writable dashboard, and the
   worker. `typescript/dashboard-server/test/database-roles-integration.test.ts` runs that SQL on a
   scratch database.
2. Each Workhorse function is `SECURITY INVOKER`, and the dashboard read functions read base
   tables. Thus the read-only role needs `SELECT` on each table in the `workhorse` schema. It can
   read each stored value, so its grants are not a redaction boundary.
3. A worker runs maintenance, which creates and drops history partitions. Thus the worker role is a
   member of the installation role, and its sessions act as that role.
4. The schema still installs no grant. [ADR 0113](0113-keep-one-dashboard-database-role-setup.md)
   decides that Workhorse offers no narrower read role that reads only the governed
   `dashboard_*_v1` views.
