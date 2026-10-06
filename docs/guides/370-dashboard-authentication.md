# How do I protect the dashboard?

<!-- scenario-names: dana -->

The dashboard can change queue state, so only operators should reach it. The standalone dashboard
can own one administrator login. An embedded dashboard keeps using the application's existing
session through `authorize`.

## Turn on the built-in login

An operator, Dana, runs `workhorse dashboard` on a host behind `https://ops.example.com`.

1. **Before starting,** Dana sets `WORKHORSE_DASHBOARD_USERNAME` to `dana` and
   `WORKHORSE_DASHBOARD_PASSWORD_HASH` to a versioned password hash. In a container Dana mounts each
   value as a secret file and sets the matching `_FILE` variable instead.
2. **At startup,** the server reads the hash. It never sees the plaintext password in its
   configuration.
3. **At login,** Dana types the password into the login form. The browser sends it to the
   TLS-protected server, which compares it against the hash without storing the plaintext value.

The login page follows the browser's light or dark color scheme. After login, the dashboard header
shows the authenticated administrator and provides a sign-out action.

<details>
<summary>Reference: credentials</summary>

| Variable                            | Rule                                             |
| ----------------------------------- | ------------------------------------------------ |
| `WORKHORSE_DASHBOARD_USERNAME`      | 1 to 256 characters.                             |
| `WORKHORSE_DASHBOARD_PASSWORD_HASH` | `scrypt-v1$<base64url-salt>$<base64url-digest>`. |

- Each value can come from its `_FILE` variant instead, with one trailing line ending removed.
- A direct value and its file variant are mutually exclusive.
- The username and hash must be configured together.

| Hash setting       | Value                   |
| ------------------ | ----------------------- |
| scrypt (version 1) | `N=16384`, `r=8`, `p=1` |
| salt               | at least 16 bytes       |
| digest             | exactly 32 bytes        |

The server compares the derived digest with `timingSafeEqual`. A password longer than 1,024
characters never matches.

More detail: [Dashboard: Credentials](../architecture/dashboard.md#credentials).

</details>

## What a login creates

Dana logs in at 09:00.

1. **At login,** the server creates a random token and keeps it, with an expiry, in its own memory.
   The browser receives the token in a cookie. The cookie is opaque, so it cannot reveal the
   password.
2. **During the day,** every request carries the cookie. The server checks the token against its
   record.
3. **At 17:00,** Dana leaves the dashboard tab open, and the session expires. Dana's next private
   request fails, and the dashboard replaces the application with the login page.

An expired session cannot read dashboard HTML, browser assets, or private RPC responses. To end a
session early, send a `POST` request to `/logout`. Deleting the server record ends the session even
if a browser retains the cookie.

<details>
<summary>Reference: sessions</summary>

| Setting          | Value                                                                   |
| ---------------- | ----------------------------------------------------------------------- |
| Cookie           | `__Host-workhorse-dashboard-session`                                    |
| Cookie flags     | `Path=/`, `Max-Age`, `Secure`, `HttpOnly`, `SameSite=Strict`            |
| Token            | 32 random bytes                                                         |
| Session lifetime | Default 28,800 seconds (8 hours). An integer from 60 through 86,400 s.  |
| Sessions kept    | At most 16 per process. Login evicts the oldest record past that bound. |

**Requests without a valid session**

| Request                         | Answer                  |
| ------------------------------- | ----------------------- |
| `GET` for a page                | `302` to `{path}/login` |
| RPC, asset, or any other method | `401`                   |

**Login and logout.** A successful login answers `303` to the mount path. `POST /logout` deletes the
server record, expires the cookie, and answers `303` to the login page. Another method on
`/logout` answers `405`. After a `401`, `createDashboardClient()` calls
`window.location.replace(loginUrl)` once.

More detail: [Dashboard: Sessions](../architecture/dashboard.md#sessions) and [Dashboard: Credentials](../architecture/dashboard.md#credentials).

</details>

## One process owns the sessions

Dana's dashboard runs as one process. At 11:00 a deploy restarts it.

1. **Before the restart,** Dana's session lives only in that process's memory.
2. **After the restart,** the new process has no session records. Dana's cookie no longer matches
   anything, so Dana logs in again.

Built-in authentication keeps session state inside the standalone server process. Restarting that
process ends every session. A second replica would not know the first replica's sessions either. So
replicated deployments should use shared host-owned authentication.

<details>
<summary>Reference: process boundary</summary>

- Built-in authentication supports one standalone server replica.
- A restart revokes every session.
- Replicated deployments use host-owned authorization, or an identity-aware proxy with its own
  shared session boundary.
- ADR 0032 records this boundary.

More detail: [Dashboard: Process boundary](../architecture/dashboard.md#process-boundary).

</details>

## Repeated failures pause login

Someone tries to guess Dana's password.

1. **Within a minute,** they submit several wrong passwords. Each gets the generic invalid-login
   page.
2. **On the next attempt,** the server stops processing logins. It answers that the client should
   retry later, and it does not check the password.
3. **When the oldest attempt leaves the window,** the server processes logins again.

Repeated failures temporarily pause login processing. The server owns this limit. It counts all
login attempts in the process together, because it does not trust proxy headers to decide who
shares the limit. A successful login clears the count.

<details>
<summary>Reference: login rate limit</summary>

1. The server keeps at most five login reservations in a rolling 60-second window.
2. Each form submission reserves capacity before scrypt begins. Concurrent requests therefore cannot
   bypass the bound.
3. An invalid submission keeps its reservation and returns the generic `401` page.
4. Further submissions return `429` with `Retry-After` until the oldest reservation leaves the
   window.
5. A successful login clears the reservations.

The limit is process-wide. It does not trust `Forwarded` or `X-Forwarded-*` as client identity.

**Login body.** The login body may be at most `MAX_LOGIN_BODY_BYTES` (4,096 bytes). A larger or
malformed declared length gets `413` before the form is read. The body must be
`application/x-www-form-urlencoded`, or the server answers `415`.

More detail: [Dashboard: Login rate limit](../architecture/dashboard.md#login-rate-limit) and [Dashboard: Login body limit](../architecture/dashboard.md#login-body-limit).

</details>

## Rotate the password

Dana changes the password on Monday. Two other operators still use the old one, so Dana gives them
until Friday 18:00 UTC.

1. **On Monday,** Dana configures the new hash as current. Dana also configures the old hash as previous,
   with an absolute cutoff of Friday 18:00 UTC.
2. **Until the cutoff,** either password logs in. A session from the old password expires at the
   cutoff at the latest, even if its normal lifetime runs longer.
3. **At Friday 18:00 UTC,** the old password stops working. Every session it created stops working
   at the same moment.

<details>
<summary>Reference: password rotation</summary>

| Variable                                                | Meaning                            |
| ------------------------------------------------------- | ---------------------------------- |
| `WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH`            | The old hash, in the same format.  |
| `WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH_EXPIRES_AT` | The cutoff, an ISO 8601 timestamp. |

- Both variables must be configured together. Each has a `_FILE` variant.
- They map to `previousPasswordHash` and `previousPasswordHashExpiresAt`.
- Before the cutoff, either hash authenticates.
- A previous-hash session expires at the earlier of the session lifetime and the cutoff.
- At and after the cutoff, the previous hash and every session it created fail authentication.

More detail: [Dashboard: Password rotation](../architecture/dashboard.md#password-rotation).

</details>

## Embed the dashboard in your application

Your application already has an admin login. You mount the dashboard at `/workhorse` inside it.

1. **On each request,** the dashboard calls your `authorize` callback before it serves anything.
2. **Your callback** reads the application's own session. It returns a principal that names the
   operator, or refuses the request.
3. **For a mutation,** the dashboard records the principal's actor as the operator who asked.

So if your application embeds the dashboard, keep its authorization in the language-native host.
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

Rust applications return a `Principal` from a `tower::Service` behind the crate's `dashboard`
feature:

```rust
use workhorse::dashboard::{self, Authorization, DashboardOptions, Principal};

let authorize = dashboard::authorize(|request| {
    let session = application_admin_session(request);
    async move {
        match session {
            Some(username) => Authorization::Principal(Principal { actor: username }),
            None => Authorization::Unauthenticated,
        }
    }
});
let mut options = DashboardOptions::new(pool, authorize);
options.path = "/workhorse".into();
options.environment = "production".into();
let operator = dashboard::handler(options)?;
let app = axum::Router::new().nest_service("/workhorse", operator);
```

Ruby applications return a `Principal` from a Rack application, which Rails routes or any Rack
builder can mount:

```ruby
dashboard = Stablemates::Workhorse::Dashboard.new(
  pool,
  authorize: lambda do |env|
    username = application_admin_session(env)
    username ? Stablemates::Workhorse::Dashboard::Principal.new(actor: username) : false
  end,
  path: "/workhorse",
  environment: "production",
  allowed_hosts: ["ops.example.com"]
)
app = Rack::Builder.new { map("/workhorse") { run dashboard } }
```

All five hosts serve the same browser bundle and versioned dashboard procedures. The language
changes the HTTP adapter, while PostgreSQL keeps the operator behavior consistent.

If the TypeScript host serves several workspaces, `authorize` also receives the resolved workspace
name. An application can grant an operator one workspace without granting every workspace.

Do not configure built-in credentials beside `authorize`. The dashboard rejects that ambiguous
boundary instead of guessing which identity system owns the request.

<details>
<summary>Reference: embedded hosts</summary>

| Language   | Host                                       | `authorize` returns                                                |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------ |
| TypeScript | `createDashboardHost`                      | A `DashboardPrincipal`, `true`, `false`, or a `Response`.          |
| Python     | `workhorse.dashboard.DashboardHost` (WSGI) | A `DashboardPrincipal`, `True`, `False`, or a `DashboardResponse`. |
| Go         | `dashboard.NewHandler` (`net/http`)        | A `dashboard.Authorization` with `Principal` or `Response`.        |
| Rust       | `dashboard::handler` (`tower::Service`)    | `Authorization::Principal`, `Unauthenticated`, or `Response`.      |
| Ruby       | `Stablemates::Workhorse::Dashboard` (Rack) | A `Principal`, `true`, `false`, or a Rack response.                |

- `createDashboardHost` accepts exactly one of `authorize` and `singleAdmin`. It rejects both or
  neither.
- In workspaces mode, TypeScript calls `authorize(request, workspace)` with the resolved workspace
  name. It passes null in single-workspace mode and outside every workspace.
- The Python host rejects a connection without `autocommit=True`.
- A non-empty `allowedHosts` list answers `421` for any other host, before `authorize` runs.

More detail: [Overview: Workspace routing](../architecture/overview.md#workspace-routing), [Dashboard: Python backend](../architecture/dashboard.md#python-backend), and [Dashboard: Allowed hosts](../architecture/dashboard.md#allowed-hosts).

</details>

## Who a change is recorded as

An operator cancels a task from the dashboard. The browser sends actor text as part of the dashboard
wire contract, but the server discards it for mutations.

1. **With the built-in login,** the server records the configured username, here `dana`.
2. **In an embedded host,** the server records the actor from the principal that `authorize`
   returned.
3. **If `authorize` returned only `true`,** the server records its configured audit actor instead.

Each host lets you configure that audit actor. The TypeScript host uses it only for a `true`
result. The Python, Go, Rust, and Ruby hosts use a configured audit actor in place of the
principal's actor.

Mutation RPCs also require their `Origin` to match the dashboard request origin. A valid session
cookie alone cannot authorize a cross-site form or script to change queue state.

<details>
<summary>Reference: mutations and attribution</summary>

| Source                 | Recorded actor                                                        |
| ---------------------- | --------------------------------------------------------------------- |
| Single-admin session   | The configured username, as `DashboardRpcContext.authenticatedActor`. |
| TypeScript principal   | The principal's `actor`.                                              |
| TypeScript `true`      | `auditActor`, default `dashboard`.                                    |
| Python, Go, Rust, Ruby | The configured audit actor if set, else the principal's actor.        |

- `auditWithOccurredAt` replaces the browser's `audit.actor` before any operator controller runs.
- `rejectCrossOriginMutation` requires an `Origin` header whose origin exactly matches the request
  URL origin. The Python, Go, Rust, and Ruby hosts make the same check.
- `BoundaryTimeline` shows `details.requested_by` beside each operator event's reason.

More detail: [Dashboard: Mutations and attribution](../architecture/dashboard.md#mutations-and-attribution).

</details>

## Behind a proxy or on a remote listener

Dana's server sits behind a proxy that terminates TLS. The proxy talks plain HTTP to the server.

1. **Without configuration,** the server sees an HTTP request. It ignores forwarded protocol
   headers, so the proxy cannot change its cookie or same-origin decisions.
2. **So Dana configures** the browser-visible public origin, `https://ops.example.com`. The server
   then uses that origin for those decisions.

Without credentials, the standalone development bypass binds only to loopback or a Unix socket.
Remote listeners require authentication and a secure public origin.

<details>
<summary>Reference: listener exposure</summary>

- The CLI maps `--public-origin` and `WORKHORSE_DASHBOARD_PUBLIC_ORIGIN` to `publicOrigin`, and
  `--socket` to `socketPath`.
- The unauthenticated bypass accepts only `127.0.0.0/8`, `::1`, or a Unix socket.
- A remote TCP listener without authentication fails before `listen`.
- An unauthenticated local listener rejects a non-loopback `publicOrigin`.
- An authenticated remote TCP listener requires an HTTPS `publicOrigin`.
- `dashboardNodeMiddleware` ignores `Forwarded` and `X-Forwarded-*`.

More detail: [Dashboard: Listener exposure](../architecture/dashboard.md#listener-exposure).

</details>

## Browser security headers

Dana runs the standalone dashboard on its own origin. Another team embeds the dashboard under
`/admin` on their application's origin.

1. **Standalone.** Every response from Dana's dashboard carries a content security policy and the
   other browser protections. Nothing else serves pages on that origin, so the dashboard owns them.
2. **Embedded.** The application's own pages already send a content security policy. If the
   dashboard added a second one, the browser would apply both, and each would narrow the other. So
   the embedded host sends none, and the team copies the documented policy into their own headers.

The standalone listener owns its whole origin, so it also states a content security policy and the
other browser protections on every response. An embedded host shares its origin with the
application's own pages, and two policies on one response narrow each other. The application
therefore owns those headers, and the dashboard server package states the policy to copy.

<details>
<summary>Reference: standalone headers</summary>

`startDashboardServer` sets these headers on every response:

- `content-security-policy`
- `x-content-type-options: nosniff`
- `referrer-policy: strict-origin-when-cross-origin`
- `x-frame-options: DENY`
- `x-robots-tag: noindex, nofollow, noarchive`

`createDashboardHost` sets none of them. `typescript/dashboard-server/README.md` states the policy
an embedder copies.

More detail: [Dashboard: Browser security headers](../architecture/dashboard.md#browser-security-headers).

</details>

## Next

- [How do workers run in production?](310-workers.md)
- [How do I observe production behavior?](350-production-telemetry.md)
- [How do I know whether the queue is healthy?](360-queue-health.md)

---

Credentials, sessions, rotation, and listener rules:
[`architecture/dashboard.md`](../architecture/dashboard.md#single-admin-authentication).
