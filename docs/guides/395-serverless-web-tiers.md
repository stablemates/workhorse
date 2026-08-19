# Can I use Workhorse from a serverless app?

Yes, if the request runtime can use a supported Workhorse client and reach PostgreSQL. Run the
worker separately unless the platform gives it a continuous process.

Two independent rules decide what each runtime can do.

- **Process lifetime:** A worker keeps a database pool open, renews leases, sends heartbeats, and
  drains when its supervisor stops it. A request or event invocation cannot own that lifecycle.
- **Database connectivity:** A producer needs a supported Workhorse client and a PostgreSQL
  session. Transport support does not make a client compatible with an edge runtime.

## Which runtimes can do what?

| Platform              | Runtime                 | Enqueue                      | Host a worker | Requirement or boundary                                                                 |
| --------------------- | ----------------------- | ---------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| Cloudflare Workers    | Workers isolate         | No with the published client | No            | Hyperdrive provides a PostgreSQL path, but Workhorse does not publish a Workers client. |
| Vercel Functions      | Node.js                 | Yes, transactionally         | No            | Use `@workhorse/core` and `pg` with ordinary database access.                           |
| Vercel Functions      | Edge                    | No with the published client | No            | Move the route to the Node.js runtime.                                                  |
| AWS Lambda            | Node.js                 | Yes, transactionally         | No            | Use `@workhorse/core` and `pg` with a reachable database.                               |
| Cloud Run service     | Node.js in request mode | Yes, transactionally         | No            | Keep the worker outside the request lifecycle.                                          |
| Cloud Run worker pool | Node.js container       | Yes                          | Yes           | Run the dedicated Workhorse process as a persistent instance.                           |

The enqueue column describes packages that Workhorse publishes today. A fetch-based database
driver may reach PostgreSQL from another isolate, but it does not implement the `Queryable`
contract or Workhorse's versioned SQL behavior.

## Why does Vercel Node work normally?

Vercel's Node.js runtime can open a `pg` connection. If a function owns a transaction, pass it to
`Queue.enqueue`. PostgreSQL then commits or rolls back the job with the business write.

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("INSERT INTO orders (id) VALUES ($1)", [orderId]);
  await queue.enqueue("order.fulfill", { orderId }, {}, client);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
```

The platform may manage idle pool clients when it suspends the function. That pool lifecycle does
not change the transaction boundary.

## What does Hyperdrive change?

Cloudflare Hyperdrive lets a Workers isolate connect to PostgreSQL through `pg`. It solves the
transport problem and manages connections on the Cloudflare side.

The published `@workhorse/core` package still supports Node.js rather than the Workers runtime.
Hyperdrive therefore does not turn Cloudflare Workers into a supported producer or worker host.

## Where does the worker run?

The producer and worker only need access to the same PostgreSQL database. Keep request handlers on
the serverless platform. Run `workhorse worker` on a virtual machine, a container service, a
Kubernetes deployment, or a Cloud Run worker pool.

The [worker process guide](310-workers.md) explains handler execution. The
[operations guide](350-production-telemetry.md) explains how to observe the separate worker tier.

## Next

- [How do I run workers?](310-workers.md)
- [How does enqueue stay transactional?](200-transactional-enqueue.md)
- [How do I observe production?](350-production-telemetry.md)

Exact process lifecycle and PostgreSQL ownership rules:
[architecture reference](../architecture.md#worker-process-lifecycle).
