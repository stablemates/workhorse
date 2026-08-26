# `@stablemates/workhorse-dashboard-server`

Workhorse is a public beta. It is usable for evaluation and early production adoption, but any
minor release may break compatibility, including the schema. There is no upgrade path between 0.x
releases; ordered migrations begin at 1.0.0.

TypeScript backend for the shared Workhorse operator dashboard. The package owns the provider-neutral
read model, request host, Node bridge, and the compiled application from `dashboard/app`. Existing
imports through `@stablemates/workhorse-dashboard` continue to work through the compatibility package.

## Mounting

The dashboard host is framework-neutral: it takes a `Request` and returns a `Response`, or `null`
when the request does not belong to its mount path.

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
```

**Fetch-native hosts** — Hono, Next.js route handlers, SvelteKit, Nitro — call `host.handle`
directly and fall through when it resolves to `null`:

```ts
const response = (await host.handle(request)) ?? new Response("Not found", { status: 404 });
```

**Connect-style hosts** — Express, Connect, Fastify via `@fastify/middie` — use the Node bridge:

```ts
import { dashboardNodeMiddleware } from "@stablemates/workhorse-dashboard-server/server";

app.use(dashboardNodeMiddleware(host));
```

Requests the host does not own are passed to `next()` untouched, so the dashboard never takes over
unrelated application routes.

The host never installs or migrates schema. It verifies that the installed schema is compatible and
returns `503` when it is not.

Embedded hosts keep authentication in the application through `authorize`. The standalone CLI can
instead pass `singleAdmin` credentials, which creates an opaque server-side session and protects
HTML, assets, and RPC responses. `createDashboardHost` rejects configurations that combine both
modes.

Mutation requests must carry a same-origin `Origin` header. The server replaces browser-provided
actor text with the single-admin username or the embedded host's verified principal before any
controller runs. A boolean embedded authorizer remains supported and uses the server-configured
`auditActor`, which defaults to `dashboard`, so browser input never becomes identity evidence.

The Node middleware ignores forwarded protocol headers. A standalone service behind a TLS proxy
must pass its exact browser-visible `publicOrigin`; that origin then owns Secure-cookie and
same-origin decisions. An unauthenticated standalone listener is accepted only on loopback or a
Unix socket.

The dashboard reads core-owned `workhorse.dashboard_*_v1` views and versioned SQL functions. Core
schema changes can ship independently when they preserve that surface, so dashboard and core patch
releases may move separately within the same minor line.

## Workers do not need to share your process

Mounting requires only a database connection. Workers register themselves in
`workhorse.worker_registry` and refresh their runtime state on a heartbeat cadence, so the dashboard
reports declared concurrency, slot use, draining, and pause state for every live worker — including
workers running in entirely separate processes or on other hosts. Operator pause is written to
PostgreSQL and applied cooperatively by the worker when it next refreshes.

## Refresh behavior

Auto refresh polls the active page every 15 seconds by default. The menu also has 5-second,
30-second, 1-minute, 5-minute, and manual-only options. Job volume does not start extra browser
refreshes, so the page has a stable update rate under load. Opening task details or a dropdown
pauses polling. After the last one closes, the refresh button counts down three seconds before
polling resumes from the point where it paused. A line under the refresh control freezes and
continues with the same interval.

## Developing the dashboard itself

```bash
pnpm dashboard:dev
```

Runs the browser entry from source with HMR and proxies `/rpc` to a backend that already speaks it.
Useful for working against a backend you do not control.

Hosts can instead embed the same thing in their own development server, which keeps everything on
one origin:

```ts
import { createDashboardDevServer } from "@stablemates/workhorse-dashboard/dev";

const dev = process.env.NODE_ENV === "development" ? await createDashboardDevServer() : undefined;

createDashboardHost({ database: pool, authorize, dev });
// then run `dev.middlewares` before your application's routing
```

The HTML still comes from `createDashboardHost`, so development exercises the same code path a
published consumer runs; only where the modules come from changes. `vite` is an optional peer,
loaded on demand.

The standalone harness accepts `WORKHORSE_DASHBOARD_API` to point at any backend that speaks the
private transport, including a `workhorse dashboard` console.

## Custom React integrations

```tsx
import { Dashboard, WorkhorseThemeProvider } from "@stablemates/workhorse-dashboard";
import { createDashboardClient } from "@stablemates/workhorse-dashboard/client";
import "@stablemates/workhorse-dashboard/styles.css";

const client = createDashboardClient("/workhorse/rpc");
root.render(
  <WorkhorseThemeProvider>
    <Dashboard client={client} basePath="/workhorse" />
  </WorkhorseThemeProvider>,
);
```

`WorkhorseThemeProvider` also mounts the notification container every operator result is reported
in — pausing a queue, clearing one, releasing a scheduled task, cancelling a task — as a toast in
the bottom-right corner. A custom integration that renders `Dashboard` without this provider gets no
results at all, and `@stablemates/workhorse-dashboard/styles.css` carries the styles the container needs.

The demo's job-seeding menu is not part of the required client contract. Opt into it with `demoTools`
only when a host intentionally supplies demo fixtures. All sample and seed data remain owned by the
demo project, never this package.
