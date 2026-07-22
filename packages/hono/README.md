# `@ironshift/hono`

Hono middleware and Node.js lifecycle integration for Ironshift.

```ts
import { HonoIronshift, serveWithIronshift } from "@ironshift/hono";
import { Hono } from "hono";

const ironshift = new HonoIronshift(adapter, {
  workers: [
    {
      configure(worker) {
        worker.handle("email.send", async (payload) => ({ delivered: true }));
      },
    },
  ],
});

const app = new Hono().use(ironshift.middleware()).post("/jobs", async (c) => {
  const id = await c.var.ironshift.queue.enqueue("email.send", await c.req.json());
  return c.json({ id }, 202);
});

const server = await serveWithIronshift({ fetch: app.fetch, ironshift, port: 3000 });
process.once("SIGTERM", () => void server.shutdown());
```

Shutdown first stops accepting HTTP connections and stops new worker claims. It then waits for
in-flight requests and handlers before closing provider-owned resources.
