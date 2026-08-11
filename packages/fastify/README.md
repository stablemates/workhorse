# `@workhorse/fastify`

Fastify request-context and lifecycle integration for Workhorse.

`registerWorkhorse` exposes the queue and transaction bridge as `request.workhorse`, then binds
worker startup and shutdown to Fastify's existing lifecycle:

```ts
import Fastify from "fastify";
import { FastifyWorkhorse, registerWorkhorse } from "@workhorse/fastify";

const workhorse = new FastifyWorkhorse(adapter);
const app = Fastify();
await registerWorkhorse(app, workhorse);

app.post("/jobs", async (request, response) => {
  const id = await request.workhorse.queue.enqueue("email.send", request.body);
  return response.code(202).send({ id });
});

await app.listen({ port: 3000 });
process.once("SIGTERM", () => void app.close());
```

Dedicated worker processes are the production default. For a deliberately small deployment,
`FastifyWorkhorse` accepts worker definitions, starts them in `onReady`, stops new claims in
`preClose`, and closes adapter-owned resources in `onClose`.

Mount the dashboard with `createDashboardHost` and `dashboardNodeMiddleware` from
`@workhorse/dashboard/server` after registering `@fastify/middie`; the dashboard does not require
a `FastifyWorkhorse` instance.
