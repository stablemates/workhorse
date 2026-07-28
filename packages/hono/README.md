# `@workhorse/hono`

Hono middleware and Node.js lifecycle integration for Workhorse.

```ts
import { HonoWorkhorse, serveWithWorkhorse } from "@workhorse/hono";
import { Hono } from "hono";

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

const server = await serveWithWorkhorse({ fetch: app.fetch, workhorse, port: 3000 });
process.once("SIGTERM", () => void server.shutdown());
```

Shutdown first stops accepting HTTP connections and stops new worker claims. It then waits for
in-flight requests and handlers before closing provider-owned resources.
