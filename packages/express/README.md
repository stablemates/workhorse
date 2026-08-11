# `@workhorse/express`

Express request-context and lifecycle integration for Workhorse.

`ExpressWorkhorse.middleware()` exposes the queue and transaction bridge as `request.workhorse`:

```ts
import express from "express";
import { ExpressWorkhorse, serveWithWorkhorse } from "@workhorse/express";

const workhorse = new ExpressWorkhorse(adapter);
const app = express().use(express.json()).use(workhorse.middleware());

app.post("/jobs", async (request, response) => {
  const id = await request.workhorse.queue.enqueue("email.send", request.body);
  response.status(202).json({ id });
});

const server = await serveWithWorkhorse({ app, workhorse, port: 3000 });
process.once("SIGTERM", () => void server.shutdown());
```

Dedicated worker processes are the production default. For a deliberately small deployment,
`ExpressWorkhorse` accepts worker definitions and starts them once when `serveWithWorkhorse`
starts the HTTP server. Shutdown stops new connections and claims, drains requests and handlers,
then closes resources owned by the adapter.

Mount the dashboard with `createDashboardHost` and `dashboardNodeMiddleware` from
`@workhorse/dashboard/server`; the dashboard does not require an `ExpressWorkhorse` instance.
