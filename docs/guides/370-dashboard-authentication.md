# How do I protect the dashboard?

<!-- scenario-names: dana -->

The dashboard is the web interface that operators use to examine and change queue state. Because it
can cancel, release, and pause work, only operators must reach it. An embedded dashboard uses the
login of your application. The standalone dashboard can own one administrator login.

## Protect an embedded dashboard with your application login

**Example.** Dana is an operator. Dana's application has an admin login, and it mounts the
dashboard at `/workhorse`.

1. Dana opens `/workhorse`. The dashboard calls the `authorize` callback before it serves anything.
2. The callback reads the session of the application. It returns a principal that names `dana`.
3. The dashboard checks that the installed schema is compatible. It does not install or change the
   schema.
4. Dana cancels a task. The dashboard records `dana` as the operator who asked.

A principal is the identity that the `authorize` callback returns. If the callback refuses the
request, the dashboard serves nothing. Each language has its own host. Use the host for the
language of your application.

In TypeScript, `createDashboardHost` takes a database pool that you own. It returns a handler for
Fetch requests.

```ts
import { createDashboardHost } from "@stablemates/workhorse-dashboard/server";

const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  environment: "production",
  authorize: (request) => {
    const session = applicationAdminSession(request);
    return session ? { actor: session.username } : false;
  },
});
```

In Python, `DashboardHost` is a WSGI application over a synchronous Psycopg connection that you
own. The connection must use autocommit, so that one request cannot keep a transaction open.

```python
import os

import psycopg
from workhorse.dashboard import DashboardHost, DashboardPrincipal

connection = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)

def authorize(environ):
    username = environ.get("REMOTE_USER")
    return DashboardPrincipal(actor=str(username)) if username else False

dashboard = DashboardHost(
    connection,
    path="/workhorse",
    environment="production",
    authorize=authorize,
)
```

In Go, `dashboard.NewHandler` returns a standard `net/http` handler over a Workhorse executor that
you own.

```go
import (
	"net/http"

	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/dashboard"
)

operator, err := dashboard.NewHandler(dashboard.HandlerOptions{
	Executor:    workhorse.NewPGXExecutor(pool),
	Path:        "/workhorse",
	Environment: "production",
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

In Rust, `dashboard::handler` returns a `tower::Service` over a Workhorse executor that you own.
Turn on the `dashboard` feature of the crate.

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

In Ruby, `Stablemates::Workhorse::Dashboard` is a Rack application over a connection or a pool that
you own. Mount it with Rails routes or with a Rack builder.

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

All five hosts serve the same browser bundle and the same `dashboard/v1` procedures. Only the HTTP
adapter changes with the language. PostgreSQL keeps the operator behavior the same in each host.

A workspace is one named database that a dashboard serves. If the TypeScript host serves more than
one workspace, `authorize` also receives the name of the workspace. Thus, your application can give
an operator access to one workspace and not to the others.

Do not configure the built-in login together with `authorize`. If you configure both,
`createDashboardHost` rejects the configuration. It does not guess which login owns the request.

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
- The callback runs before the interface, the assets, the compatibility check, and every RPC
  method.
- After authorization, each host checks schema compatibility before it serves the request. It never
  installs or migrates the schema.
- In workspaces mode, TypeScript calls `authorize(request, workspace)` with the resolved workspace
  name. It passes null in single-workspace mode and outside every workspace.
- The Python host rejects a connection without `autocommit=True`.
- A non-empty `allowedHosts` list answers `421` for any other host, before `authorize` runs.

More detail: [Overview: Workspace routing](../architecture/overview.md#workspace-routing),
[Dashboard: Python backend](../architecture/dashboard.md#python-backend),
[Dashboard: Schema compatibility answer](../architecture/dashboard.md#schema-compatibility-answer),
and [Dashboard: Allowed hosts](../architecture/dashboard.md#allowed-hosts).

</details>

## Record who changes queue state

Workhorse records an actor for each change that an operator makes. An actor is the name that the
history of the task shows for the person who asked. The server sets the actor. The browser cannot
set it.

**Example.** Dana opens a task in the embedded dashboard.

1. Dana selects Cancel.
2. The browser sends the request with an actor name in it.
3. The server discards the actor name from the browser.
4. The server records `dana`, the actor of the principal that `authorize` returned.

The server takes the actor from one of these sources:

- With the built-in login, the server records the configured username.
- In an embedded host, the server records the actor of the principal that `authorize` returns.
- If `authorize` returns only `true`, the server records its configured audit actor.

A principal always has priority over the audit actor. The TypeScript, Python, and Ruby hosts accept
a `true` result, so they have an audit actor option. The Go and Rust callbacks must return a
principal, so those hosts have no audit actor option.

A mutation is a request that changes queue state. Each mutation must have an `Origin` header that
matches the origin of the dashboard. Thus, a valid session cookie alone cannot let a form or a
script from a different site change queue state.

<details>
<summary>Reference: mutations and attribution</summary>

| Source                       | Recorded actor                                                        |
| ---------------------------- | --------------------------------------------------------------------- |
| Single-admin session         | The configured username, as `DashboardRpcContext.authenticatedActor`. |
| Principal, every host        | The principal's `actor`.                                              |
| TypeScript `true`            | `auditActor`, default `dashboard`.                                    |
| Python `True` or Ruby `true` | `audit_actor`, default `dashboard`.                                   |

- `auditWithOccurredAt` replaces the browser's `audit.actor` before any operator controller runs.
- `rejectCrossOriginMutation` requires an `Origin` header whose origin exactly matches the request
  URL origin. The Python, Go, Rust, and Ruby hosts make the same check.
- `BoundaryTimeline` shows `details.requested_by` beside each operator event's reason.

More detail: [Dashboard: Mutations and attribution](../architecture/dashboard.md#mutations-and-attribution).

</details>

## Turn on the built-in login

The standalone dashboard is the `workhorse dashboard` command. It can own one administrator login.
The server keeps only a hash of the password, so its configuration never contains the password.

**Example.** Dana runs `workhorse dashboard` on a host behind `https://ops.example.com`.

1. Before the start, Dana sets `WORKHORSE_DASHBOARD_USERNAME` to `dana`.
2. Dana sets `WORKHORSE_DASHBOARD_PASSWORD_HASH` to a versioned hash of the password.
3. At the start, the server reads the hash.
4. At login, Dana types the password into the login form. The browser sends it to the server over
   TLS.
5. The server compares the password with the hash. It does not keep the password.

In a container, mount each value as a secret file. Then set the matching `_FILE` variable, not the
direct variable.

The login page uses the light or dark color scheme of the browser. After login, the header of the
dashboard shows the administrator and a sign-out action.

<details>
<summary>Reference: credentials</summary>

| Variable                            | Rule                                             |
| ----------------------------------- | ------------------------------------------------ |
| `WORKHORSE_DASHBOARD_USERNAME`      | 1 to 256 characters.                             |
| `WORKHORSE_DASHBOARD_PASSWORD_HASH` | `scrypt-v1$<base64url-salt>$<base64url-digest>`. |

- Each value can come from its `_FILE` variant, with one trailing line ending removed.
- A direct value and its file variant are mutually exclusive.
- The username and the hash must be configured together.

| Hash setting       | Value                   |
| ------------------ | ----------------------- |
| scrypt (version 1) | `N=16384`, `r=8`, `p=1` |
| salt               | at least 16 bytes       |
| digest             | exactly 32 bytes        |

The server compares the derived digest with `timingSafeEqual`. A password longer than 1,024
characters never matches.

More detail: [Dashboard: Credentials](../architecture/dashboard.md#credentials).

</details>

## Control how long a login session lasts

A login session is the period in which the browser can use the dashboard without a new login. The
server keeps each session in its memory and gives the browser only a random token.

**Example.** Dana logs in at 09:00.

1. At 09:00, the server makes a random token. It keeps the token and its expiry in its memory.
2. The browser receives the token in a cookie. The token does not contain the password.
3. During the day, each request sends the cookie. The server compares the token with its record.
4. At 17:00, the session expires. Dana's dashboard tab is still open.
5. The next request from the tab fails. The dashboard shows the login page.

If the session expired, the browser cannot read the dashboard HTML, the assets, or the RPC
responses. To end a session before it expires, send a `POST` request to the logout path. The server
deletes its record. After that, the cookie does not work, even if the browser keeps it.

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

**Login and logout.** A successful login answers `303` to the mount path. `POST /logout` (at
`{path}/logout`) deletes the server record, expires the cookie, and answers `303` to the login page.
Another method on `/logout` answers `405`. After a `401`, `createDashboardClient()` calls
`window.location.replace(loginUrl)` once.

More detail: [Dashboard: Sessions](../architecture/dashboard.md#sessions),
[Dashboard: Login page and client](../architecture/dashboard.md#login-page-and-client), and
[Dashboard: Credentials](../architecture/dashboard.md#credentials).

</details>

## Run one process for the built-in login

The built-in login keeps its sessions in the memory of one standalone server process. Other
processes cannot read them.

**Example.** Dana is logged in. At 11:00, Dana restarts the dashboard process to install an update.

1. Before the restart, Dana's session is only in the memory of the old process.
2. The new process starts with no session records.
3. Dana's cookie matches no record, so Dana logs in again.

A restart ends every session. A second replica does not know the sessions of the first replica. If
you run more than one replica, use an embedded host with the shared login of your application.

<details>
<summary>Reference: process boundary</summary>

- Built-in authentication supports one standalone server replica.
- A restart revokes every session.
- Replicated deployments use host-owned authorization, or an identity-aware proxy with its own
  shared session boundary.
- [ADR 0032](../decisions/0032-keep-single-admin-authentication-process-local.md) records this
  boundary.

More detail: [Dashboard: Process boundary](../architecture/dashboard.md#process-boundary).

</details>

## Stop repeated password guesses

The built-in login limits the number of failed logins from one client. A client is the network
address that a login comes from. The limit stops a person who tries many passwords.

**Example.** A person at `203.0.113.7` tries to guess Dana's password.

1. In less than one minute, the person sends some wrong passwords. Each gets the same invalid-login
   page.
2. The server stops the login check for `203.0.113.7`. It tells the client to try again later. It
   does not check the password.
3. At the same time, Dana logs in from a different address. The server checks Dana's password.
4. The oldest failed attempt leaves the time window. The server accepts logins from `203.0.113.7`
   again.

The server identifies a client by the address of the network connection. It ignores proxy headers
by default, because a client can write these headers. A successful login clears the count of that
client.

Each password check uses much processing time on purpose. Thus, the server checks only a small
number of passwords at the same time.

<details>
<summary>Reference: login rate limit</summary>

1. The server keeps at most five login reservations per client in a rolling 60-second window.
2. The client is the transport peer address. When the peer is a trusted proxy, the client is the
   rightmost hop of `X-Forwarded-For` or `Forwarded` that is not a trusted proxy. An IPv6 address
   shares its /64 prefix with its neighbors. A request without an address uses one shared key.
3. Each form submission reserves capacity before scrypt begins. Concurrent requests therefore cannot
   bypass the bound.
4. An invalid submission keeps its reservation and returns the generic `401` page.
5. Further submissions from that client return `429` with `Retry-After` until its oldest
   reservation leaves the window.
6. A successful login clears that client's reservations.
7. At most `MAX_CONCURRENT_PASSWORD_HASHES` (2) password checks run at once. Another submission
   gets `429` with `Retry-After: 1` and reserves nothing.

**Login body.** The login body may be at most `MAX_LOGIN_BODY_BYTES` (4,096 bytes). A larger or
malformed declared length gets `413` before the form is read. The body must be
`application/x-www-form-urlencoded`, or the server answers `415`.

More detail: [Dashboard: Login rate limit](../architecture/dashboard.md#login-rate-limit) and
[Dashboard: Login body limit](../architecture/dashboard.md#login-body-limit).

</details>

## Count login failures behind a reverse proxy

A reverse proxy is a server that receives requests and sends them to the dashboard. Behind a
reverse proxy, each connection comes from the proxy. Thus, all clients of the proxy share one count
of failures. To prevent this, name the proxy as a trusted proxy.

**Example.** Dana's server is behind a proxy at `10.0.0.2`. Dana sets
`WORKHORSE_DASHBOARD_TRUSTED_PROXIES` to `10.0.0.2` before the start.

1. The person at `203.0.113.7` sends a login. The request has a false `X-Forwarded-For` entry with
   Dana's address.
2. The proxy adds `203.0.113.7` to the right of that entry.
3. The connection comes from a trusted proxy, so the server reads the header.
4. The server takes the rightmost address that is not a trusted proxy. It counts the failure for
   `203.0.113.7`.
5. Dana's logins count for Dana's own address.

The server reads a forwarding header only from a proxy that you name. A request from a different
connection keeps the address of that connection. The headers do not change it. If an entry in the
setting is not valid, the server does not start.

<details>
<summary>Reference: trusted proxies</summary>

The list is empty by default, so `dashboardNodeMiddleware` passes the socket address and reads no
forwarding header.

- `--trusted-proxy`, repeatable, or the comma-separated `WORKHORSE_DASHBOARD_TRUSTED_PROXIES` names
  addresses and CIDR ranges. Any flag replaces the whole variable.
- A trusted proxy's request that carries both `X-Forwarded-For` and `Forwarded`, or neither, keeps
  the proxy's address. So does a `Forwarded` header whose quoted string never closes.
- An unparseable hop ends the walk at the trusted proxy that wrote it.
- A malformed entry, or a non-empty list on a Unix socket listener, stops the server at startup.

[ADR 0093](../decisions/0093-key-single-admin-login-throttling-by-transport-peer.md) and
[ADR 0094](../decisions/0094-read-the-login-throttle-client-through-trusted-proxies.md) record this
model.

More detail: [Dashboard: Login rate limit](../architecture/dashboard.md#login-rate-limit).

</details>

## Rotate the password

To change the password, you can accept the old password for a limited time. Thus, other operators
have time to change to the new password.

**Example.** Dana changes the password on Monday. Two other operators still use the old password.
Dana gives them until Friday 18:00 UTC.

1. On Monday, Dana configures the new hash as the current hash.
2. Dana configures the old hash as the previous hash, with a cutoff time of Friday 18:00 UTC.
3. Until the cutoff, both passwords log in.
4. A session from the old password expires at the cutoff or before it, even if its lifetime is
   longer.
5. At Friday 18:00 UTC, the old password stops working. Each session that it made stops working at
   the same time.

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

## Publish the standalone dashboard behind a proxy

A listener is the network address or the Unix socket where the dashboard accepts connections.
Without a login, the standalone dashboard must use a loopback address or a Unix socket. A remote
listener must have the
built-in login and an HTTPS public origin. The public origin is the scheme and host name that the
browser uses.

If a proxy decrypts TLS and sends plain HTTP to the server, the server sees an HTTP request. The
server ignores forwarded protocol headers, so a proxy cannot change its cookie or origin decisions.
Thus, you must give the public origin to the server.

To publish the dashboard behind a proxy, do these steps:

1. Turn on the built-in login.
2. Set `WORKHORSE_DASHBOARD_PUBLIC_ORIGIN` to the origin that the browser uses, for example
   `https://ops.example.com`.
3. Name the proxy as a trusted proxy, so that each client gets its own count of login failures.
4. Start `workhorse dashboard` on an address that the proxy can reach.

<details>
<summary>Reference: listener exposure</summary>

- The CLI maps `--public-origin` and `WORKHORSE_DASHBOARD_PUBLIC_ORIGIN` to `publicOrigin`, and
  `--socket` to `socketPath`.
- The unauthenticated bypass accepts only `127.0.0.0/8`, `::1`, or a Unix socket.
- A remote TCP listener without authentication fails before `listen`.
- An unauthenticated local listener rejects a non-loopback `publicOrigin`.
- An authenticated remote TCP listener requires an HTTPS `publicOrigin`.
- `dashboardNodeMiddleware` ignores `Forwarded` and `X-Forwarded-*` when it builds the request URL.

More detail: [Dashboard: Listener exposure](../architecture/dashboard.md#listener-exposure).

</details>

## Set the browser security headers

Security headers tell the browser which content a page can load and show. The standalone dashboard
owns all of its origin, so it sends a content security policy and other browser protections on
each response.

An embedded host shares its origin with the pages of your application. If two content security
policies apply to one response, the browser applies both, and each policy limits the other. Thus,
an embedded host sends no security headers. Copy the documented policy into the headers of your
application.

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
