# `@workhorse/hono`

Hono lifecycle integration and a complete mountable Workhorse admin application.

```ts
import { installSchema } from "@workhorse/core";
import { HonoWorkhorse, mountWorkhorseDashboard, serveWithWorkhorse } from "@workhorse/hono";
import { Hono } from "hono";

// Installation is an explicit deployment/startup step. Mounting never changes the schema.
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

const app = new Hono().use(workhorse.middleware()).post("/jobs", async (c) => {
  const id = await c.var.workhorse.queue.enqueue("email.send", await c.req.json());
  return c.json({ id }, 202);
});

mountWorkhorseDashboard(app, {
  path: "/workhorse",
  workhorse,
  environment: "production",
  authorize: (request) => isAdmin(request),
});

const server = await serveWithWorkhorse({ fetch: app.fetch, workhorse, port: 3000 });
process.once("SIGTERM", () => void server.shutdown());
```

The mount owns `/workhorse/*`, including the packaged React application, static assets, oRPC API,
and SSE refresh stream. Authorization is required explicitly. The adapter checks that the installed
schema is compatible and returns `503` when it is not, but it never installs or migrates database
objects.

Shutdown first stops accepting HTTP connections and stops new worker claims. It then waits for
in-flight requests and handlers before closing provider-owned resources.
