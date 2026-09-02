# `@stablemates/workhorse-dashboard-server`

The framework-neutral Node.js backend and read model for the Workhorse operator dashboard.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

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

## Package boundary

The host serves the compiled application and RPC API, but it never installs or migrates schema and
never owns the caller's database connection. Embedded applications must authenticate with `authorize`.
Standalone deployments must use `singleAdmin`, bind to loopback or a Unix socket unless authenticated,
and set the exact HTTPS `publicOrigin` when a proxy terminates TLS. Operator authorization remains the
host application's responsibility.

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
