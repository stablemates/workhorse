# `@stablemates/workhorse-dashboard-server`

The framework-neutral Node.js backend and read model for the Workhorse operator dashboard.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the changelog before you upgrade. It will not ask you to
> recreate your database: migrations are ordered, and inside a major line a migration only adds, so
> a running deployment upgrades in place.
> Migration 0025 is the one exception. If your database is from a release before 0.5.0, upgrade it
> offline with [these steps](https://workhorse.run/docs/installation#upgrade-a-04x-database-offline).

## Install

```bash
npm install @stablemates/workhorse @stablemates/workhorse-dashboard-server
```

## Mount the dashboard

```ts
import { createDashboardHost } from "@stablemates/workhorse-dashboard-server/server";

const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  authorize: (request) => {
    const session = applicationAdminSession(request);
    return session ? { actor: session.username } : false;
  },
});

const response = (await host.handle(request)) ?? new Response("Not found", { status: 404 });
```

Fetch-native hosts pass requests to `host.handle`. Express and other Connect-style hosts can pass
the same host to `dashboardNodeMiddleware`.

`handle` takes an optional second argument, `{ clientAddress }`. Built-in `singleAdmin` login
counts failures per client address, so pass the peer address your transport established. Never
pass a value read from `Forwarded` or `X-Forwarded-For` unless your own proxy chain sets it.
Without an address, every request shares one failure window. `dashboardNodeMiddleware` passes the
socket's remote address itself. Behind a reverse proxy, name the proxy in its `trustedProxies`
option, as addresses or CIDR ranges. The middleware then takes the rightmost `X-Forwarded-For` or
`Forwarded` hop that is not a listed proxy, and only from a listed peer.

```ts
const response = await host.handle(request, { clientAddress: connection.remoteAddress });
```

## Package boundary

The host serves the compiled application and RPC API, but it never installs or migrates schema and
never owns the caller's database connection. Embedded applications must authenticate with `authorize`.
Standalone deployments must use `singleAdmin`, bind to loopback or a Unix socket unless authenticated,
and set the exact HTTPS `publicOrigin` when a proxy terminates TLS. Operator authorization remains the
host application's responsibility.

Set `allowedHosts` to the `host[:port]` values the dashboard answers to when the application does
not already validate `Host`. The host then answers any other host with `421 Misdirected Request`
before `authorize` runs. `workhorse dashboard` sets it to its own loopback address.

Set `allowedHosts` or `publicOrigin` if `authorize` accepts a request by its network position, for
example each request from the internal network. Without both settings, the host takes its origin
from the `Host` header. A foreign host name can resolve to the address of the dashboard (DNS
rebinding). A page on that name then sends the same name in `Host` and in `Origin`, so the
same-origin check accepts its mutations. A session cookie for the dashboard host name is not sent
to the foreign name. Thus `authorize` that requires such a cookie refuses the request, and this
case does not apply to it.

## Response headers an embedder owns

`workhorse dashboard` owns its whole origin, so it sends a Content Security Policy,
`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and `X-Robots-Tag` on every
response. An embedded host shares its origin with its own pages, and a second policy on the
dashboard's responses would intersect with the application's own, so this package sends none by
default and the embedder decides.

Each dashboard page has two inline boot scripts: the color scheme script and the runtime
configuration that the host writes. The host makes a new nonce for each page and puts it on both
scripts. Give the host a `contentSecurityPolicy` function to send the page policy with that nonce.
Use this policy if the application has no stricter one:

```ts
createDashboardHost({
  // ...
  contentSecurityPolicy: ({ nonce }) =>
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
    ].join("; "),
});
```

The other dashboard responses have no inline script. For them, use the same policy with
`script-src 'self'`. `style-src` keeps `'unsafe-inline'` for the style elements that the
application adds as it renders. Widen `connect-src` and `img-src` only for origins that the
application itself adds.

The server reads core-owned `workhorse.dashboard_*_v1` views and versioned SQL functions. [Workhorse core](https://workhorse.run/docs/installation)
owns schema installation and changes. Workers can run in other processes because PostgreSQL owns
their registry and operator pause state.

## Next

- Read the [dashboard guide](https://workhorse.run/docs/dashboard),
  [deployment guidance](https://workhorse.run/docs/operations), and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
