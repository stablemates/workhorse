# How do I protect the dashboard?

The standalone dashboard can own one administrator login. Embedded dashboards continue using the
application's existing session through `authorize`.

Set `WORKHORSE_DASHBOARD_USERNAME` and `WORKHORSE_DASHBOARD_PASSWORD_HASH` before starting
`workhorse dashboard`. Container deployments can mount either value as a secret file and use the
matching `_FILE` variable.

The server configuration accepts only a versioned password hash. The login form sends the password
to the TLS-protected server, which compares it without storing the plaintext value.

A successful login creates an opaque cookie backed by server memory. The cookie cannot reveal the
password, and deleting the server record ends the session even if a browser retains it.

The login page follows the browser's light or dark color scheme. After login, the dashboard header
shows the authenticated administrator and provides a sign-out action.

Built-in authentication keeps session state inside the standalone server process. Restarting that
process ends every session. Replicated deployments should use shared host-owned authentication.

Repeated failures temporarily pause login processing. The server owns this limit and does not trust
proxy headers to decide who shares it.

For a rolling password change, configure the new hash as current and the old hash as previous with
an absolute cutoff. The old password and every session it created stop working at that cutoff.

Send a `POST` request to `/logout` to end the current session. If a session expires while the
dashboard is open, the next private request replaces the application with the login page. Expired
sessions cannot read dashboard HTML, browser assets, or private RPC responses.

If your application embeds the dashboard, keep its authorization in the language-native host.
TypeScript applications return a principal from `createDashboardHost`:

```ts
const host = createDashboardHost({
  database: pool,
  path: "/workhorse",
  authorize: (request) => {
    const session = applicationAdminSession(request);
    return session ? { actor: session.username } : false;
  },
});
```

Python applications return a `DashboardPrincipal` from their WSGI host:

```python
from workhorse.dashboard import DashboardHost, DashboardPrincipal

dashboard = DashboardHost(
    connection,
    path="/workhorse",
    authorize=lambda environ: (
        DashboardPrincipal(actor=str(environ["REMOTE_USER"]))
        if environ.get("REMOTE_USER")
        else False
    ),
)
```

The Psycopg connection must use autocommit. This prevents one WSGI request from leaving a
transaction open for the next request.

Go applications return a `dashboard.Principal` from a standard `net/http` handler:

```go
operator, err := dashboard.NewHandler(dashboard.HandlerOptions{
    Executor: workhorse.NewPGXExecutor(pool),
    Path:     "/workhorse",
    Authorize: func(request *http.Request) dashboard.Authorization {
        username, ok := applicationAdminSession(request)
        if !ok {
            return dashboard.Authorization{}
        }
        return dashboard.Authorization{
            Principal: &dashboard.Principal{Actor: username},
        }
    },
})
if err != nil {
    return err
}
http.Handle("/workhorse/", operator)
```

All three hosts serve the same browser bundle and versioned dashboard procedures. The language
changes the HTTP adapter, while PostgreSQL keeps the operator behavior consistent.

If the TypeScript host serves several workspaces, `authorize` also receives the resolved workspace
name. An application can grant an operator one workspace without granting every workspace.

The browser still sends actor text as part of the dashboard wire contract, but the server discards
it for mutations. A built-in session supplies its configured username. An embedded host supplies
the principal returned by `authorize`, or its server-configured `auditActor` for a boolean result.

Mutation RPCs also require their `Origin` to match the dashboard request origin. A valid session
cookie alone cannot authorize a cross-site form or script to change queue state.

If a proxy terminates TLS, configure the browser-visible public origin. The server ignores forwarded
protocol headers, so a proxy cannot silently change cookie or same-origin decisions.

Without credentials, the standalone development bypass binds only to loopback or a Unix socket.
Remote listeners require authentication and a secure public origin.

Do not configure built-in credentials beside `authorize`. The dashboard rejects that ambiguous
boundary instead of guessing which identity system owns the request.

## Next

- [How do workers run in production?](310-workers.md)
- [How do I observe production behavior?](350-production-telemetry.md)
- [How do I know whether the queue is healthy?](360-queue-health.md)

[Authentication reference](../architecture.md#dashboard-package-boundary)
