# `@workhorse/dashboard`

Embeddable React operator dashboard for Workhorse. The package owns the UI, data contracts, theme,
styles, browser bundle, oRPC client, and provider-neutral server read model and request host. It has
no dependency on the demo application.

## Mounting

The dashboard host is framework-neutral: it takes a `Request` and returns a `Response`, or `null`
when the request does not belong to its mount path.

```ts
import { createDashboardHost } from "@workhorse/dashboard/server";

const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  authorize: (request) => isAdmin(request),
});
```

**Fetch-native hosts** — Hono, Next.js route handlers, SvelteKit, Nitro — call `host.handle`
directly and fall through when it resolves to `null`:

```ts
const response = (await host.handle(request)) ?? new Response("Not found", { status: 404 });
```

**Connect-style hosts** — Express, Connect, Fastify via `@fastify/middie` — use the Node bridge:

```ts
import { dashboardNodeMiddleware } from "@workhorse/dashboard/server";

app.use(dashboardNodeMiddleware(host));
```

Requests the host does not own are passed to `next()` untouched, so the dashboard never takes over
unrelated application routes.

For Hono, `mountWorkhorseDashboard` from [`@workhorse/hono`](../hono/README.md) wraps the same host
and registers the routes for you.

The host never installs or migrates schema. It verifies that the installed schema is compatible and
returns `503` when it is not.

## Workers do not need to share your process

Mounting requires only a database connection. Workers register themselves in
`workhorse.worker_registry` and refresh their runtime state on a heartbeat cadence, so the dashboard
reports declared concurrency, slot use, draining, and pause state for every live worker — including
workers running in entirely separate processes or on other hosts. Operator pause is written to
PostgreSQL and applied cooperatively by the worker when it next refreshes.

## Refresh behavior

Auto refresh polls the active page every 15 seconds by default. The menu also has 5-second,
30-second, 1-minute, 5-minute, and manual-only options. Job volume does not start extra browser
refreshes, so the page has a stable update rate under load.

## Developing the dashboard itself

```bash
pnpm --filter @workhorse/dashboard dev
```

Runs the browser entry from source with HMR and proxies `/rpc` to a backend that already speaks it.
Useful for working against a backend you do not control.

Hosts can instead embed the same thing in their own development server, which keeps everything on
one origin:

```ts
import { createDashboardDevServer } from "@workhorse/dashboard/dev";

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
import { Dashboard, WorkhorseThemeProvider } from "@workhorse/dashboard";
import { createDashboardClient } from "@workhorse/dashboard/client";
import "@workhorse/dashboard/styles.css";

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
results at all, and `@workhorse/dashboard/styles.css` carries the styles the container needs.

The demo's job-seeding menu is not part of the required client contract. Opt into it with `demoTools`
only when a host intentionally supplies demo fixtures. All sample and seed data remain owned by the
demo project, never this package.
