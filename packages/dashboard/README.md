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

## Staying live

Auto refresh defaults to **Live**: the application subscribes to the host's SSE stream and re-reads
whenever PostgreSQL says something changed, falling back to the timed intervals in the same menu
when a host serves no stream. `createDashboardHost` serves the stream at `{basePath}/events` and
hands its URL to the browser entry, so the packaged application needs no configuration.

Nothing on screen is rendered from a notification payload. Every frame is a hint to re-read, and the
page re-reads through the same queries a manual refresh uses, so a frame lost to a reconnect costs a
slightly later refetch and never a gap in what is displayed. This is also why the Events page reads
the durable `job_event` and `attempt_history` tables rather than the notification channels: those
payloads carry only a queue name, are coalesced twice before arriving, and are dropped entirely
while nothing is listening.

The stream has a periodic fallback, so it is always eventually fresh. To make it react promptly to
work happening elsewhere, bridge PostgreSQL notifications into its refresh hub:

```ts
import { listenForDashboardRefresh } from "@workhorse/dashboard/server";

const client = new Client({ connectionString });
await client.connect();
const listener = await listenForDashboardRefresh({ client, refresh });
```

This listens on two channels. `workhorse_jobs` is the dispatch wake hint and means ready work may
exist. `workhorse_activity` is the coalesced operator hint that workers publish when
`WorkerOptions.activityNotifications` is enabled, and covers transitions such as completion that
create no ready work at all. Both are liveness optimizations, never a source of truth.

The client must be a dedicated connection rather than a pooled one, because `LISTEN` registers
against a specific backend session.

## Developing the dashboard itself

```bash
pnpm --filter @workhorse/dashboard dev
```

Runs the browser entry from source with HMR, proxying `/rpc` and `/events` to a backend that already
speaks them. Useful for working against a backend you do not control.

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

Set `eventsUrl={null}` when a custom host does not expose server-sent refresh events. The demo's
job-seeding menu is not part of the required client contract. Opt into it with `demoTools` only when
a host intentionally supplies demo fixtures. All sample and seed data remain owned by the demo
project, never this package.
