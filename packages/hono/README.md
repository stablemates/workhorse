# `@workhorse/hono`

Hono lifecycle integration and a thin binding for the mountable Workhorse admin application.

This package is deliberately small. All dashboard behavior lives in the framework-neutral host in
[`@workhorse/dashboard/server`](../dashboard/README.md); this package only maps that host's mount
path onto Hono routes and adds the Hono-specific request and shutdown plumbing.

## Mounting the dashboard

```ts
import { mountWorkhorseDashboard } from "@workhorse/hono";
import { Hono } from "hono";

const app = new Hono();

mountWorkhorseDashboard(app, {
  path: "/workhorse",
  database: pool,
  environment: "production",
  authorize: (request) => isAdmin(request),
});
```

The mount needs only a database connection. It does **not** need a worker runtime:
your workers can — and in production should — run in their own processes. They register themselves
in PostgreSQL, and the dashboard reads the fleet from there.

The mount owns the configured path, including the packaged React application, static assets, oRPC
API. Use `/workhorse` to embed it beside host routes, or `/` when the
dashboard owns the whole application. Requests outside the mount path fall through to your own
routes untouched. Authorization is required explicitly. The host checks that the installed schema
is compatible and returns `503` when it is not, but it never installs or migrates database objects.

Hosts may provide trusted, host-owned ES modules through `browserModules`. The mount inserts those
module URLs before the dashboard entry script; the host remains responsible for serving, securing,
and versioning them. This is intended for private integration or development tooling and does not
add those modules to `@workhorse/dashboard`.

## Transactional enqueue from a request

`HonoWorkhorse` exposes the queue and the caller-owned transaction bridge to your routes:

```ts
const workhorse = new HonoWorkhorse(adapter);

const app = new Hono().use(workhorse.middleware()).post("/jobs", async (c) => {
  const id = await c.var.workhorse.queue.enqueue("email.send", await c.req.json());
  return c.json({ id }, 202);
});
```

## Co-hosting workers (small applications only)

Dedicated worker processes are the documented production default. `HonoWorkhorse` can still start
workers inside the web process, which is a reasonable choice for a small application:

```ts
import { installSchema } from "@workhorse/core";
import { HonoWorkhorse, serveWithWorkhorse } from "@workhorse/hono";

// Installation is an explicit deployment/startup step. Mounting never changes the schema.
// `workhorse schema install` does the same thing from the command line.
await installSchema(database);

const workhorse = new HonoWorkhorse(adapter, {
  workers: [
    {
      configure(worker) {
        worker.handle("email.send", async (payload) => ({ delivered: true }));
      },
    },
  ],
});

const server = await serveWithWorkhorse({ fetch: app.fetch, workhorse, port: 3000 });
process.once("SIGTERM", () => void server.shutdown());
```

Shutdown first stops accepting HTTP connections and stops new worker claims. It then waits for
in-flight requests and handlers before closing provider-owned resources.

For separate worker processes, see the `workhorse worker` CLI and
[`docs/worker-processes.md`](../../docs/worker-processes.md).
