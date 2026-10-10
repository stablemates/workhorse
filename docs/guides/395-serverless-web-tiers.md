# Can I use Workhorse from a serverless app?

<!-- scenario-names: order-42, order.fulfill -->

Yes, if the request runtime can use a supported Workhorse client and reach PostgreSQL. Run the
worker separately unless the platform gives it a continuous process.

Two independent rules decide what each runtime can do.

- **Process lifetime:** A worker keeps a database pool open, renews leases, sends heartbeats, and
  drains when its supervisor stops it. A request or event invocation cannot own that lifecycle.
- **Database connectivity:** A producer needs a supported Workhorse client and a PostgreSQL
  session. Transport support does not make a client compatible with an edge runtime.

## Which runtimes can do what?

**Example.** A shop runs its checkout on Vercel Functions and wants an `order.fulfill` task for each
order.

1. **The checkout route runs on the Node.js runtime.** It opens a `pg` connection, so it can enqueue
   with `@stablemates/workhorse`.
2. **A product page runs on the Edge runtime.** It cannot use the published client, because the
   Edge runtime lacks the Node.js networking APIs that `pg` needs. If that page must enqueue, the
   shop moves its route to the Node.js runtime.
3. **Neither runtime can host the worker.** Neither gives the shop a continuous process that keeps
   renewing leases between requests. The shop runs the worker elsewhere.

The same split holds on other platforms. A Node.js function on Vercel, AWS Lambda, or a Cloud Run
service can enqueue, and can do it transactionally. A Cloudflare Workers isolate or a Vercel Edge
function cannot use the published client. Only a runtime with a persistent process, such as a Cloud
Run worker pool, can host a worker.

"Enqueue" here means a package that Workhorse publishes today. A fetch-based database driver may
reach PostgreSQL from another isolate, but it does not implement the `Queryable` contract or
Workhorse's versioned SQL behavior.

<details>
<summary>Reference: runtime matrix</summary>

| Platform              | Runtime                 | Enqueue                      | Host a worker | Requirement or boundary                                                                 |
| --------------------- | ----------------------- | ---------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| Cloudflare Workers    | Workers isolate         | No with the published client | No            | Hyperdrive provides a PostgreSQL path, but Workhorse does not publish a Workers client. |
| Vercel Functions      | Node.js                 | Yes, transactionally         | No            | Use `@stablemates/workhorse` with ordinary database access.                             |
| Vercel Functions      | Edge                    | No with the published client | No            | Move the route to the Node.js runtime.                                                  |
| AWS Lambda            | Node.js                 | Yes, transactionally         | No            | Use `@stablemates/workhorse` with a reachable database.                                 |
| Cloud Run service     | Node.js in request mode | Yes, transactionally         | No            | Keep the worker outside the request lifecycle.                                          |
| Cloud Run worker pool | Node.js container       | Yes                          | Yes           | Run the dedicated Workhorse process as a persistent instance.                           |

Lambda owns the execution environment's lifetime. On Cloud Run, request-based CPU allocation and
instance scaling cannot own a continuous worker loop. Vercel's Edge runtime omits the Node.js APIs
that `pg` and `@stablemates/workhorse` require.

The repository's PostgreSQL integration suite covers the Node.js transaction path used by Vercel
Functions, Lambda, and Cloud Run. Provider runtime documentation supplies the lifecycle
boundaries. The matrix was verified on 2026-08-18.

More detail: [Compatibility and support boundary: Serverless and edge runtimes](../compatibility.md#serverless-and-edge-runtimes).

</details>

## Why does Vercel Node work normally?

The checkout route from the example writes an order and enqueues its task.

1. The route takes a `pg` client and opens a transaction.
2. It inserts order `order-42`.
3. It passes the same client to `Queue.enqueue` for `order.fulfill`.
4. It commits. PostgreSQL writes the order and the task together. If the insert had failed, the
   rollback would have removed both.

Vercel's Node.js runtime can open a `pg` connection like any Node.js process.
[Transactional enqueue](200-transactional-enqueue.md) shows the full pattern.

The platform may manage idle pool clients when it suspends the function. That pool lifecycle does
not change the transaction boundary.

<details>
<summary>Reference: transaction handover and pool management</summary>

- `Queue.enqueue` takes the caller's transaction client as its fourth argument. The task then
  commits or rolls back with the business write.
- On Vercel Fluid Compute, the published serverless page calls Vercel's `attachDatabasePool` after
  creating the pool, so Vercel can release idle clients before it suspends the function.

More detail: [Task lifecycle: Batch write order](../architecture/lifecycle.md#batch-write-order).

</details>

## What does Hyperdrive change?

Suppose the shop moves the checkout route to Cloudflare Workers.

1. The route binds Cloudflare Hyperdrive and connects through `pg`. A query reaches PostgreSQL.
2. The route then imports `@stablemates/workhorse`. That package supports Node.js, not the Workers
   runtime, so the route has no supported way to enqueue.
3. Cloudflare ties execution to an invocation and may cancel work after the response, so the route
   cannot host a worker either.

Hyperdrive solves the transport problem and manages connections on the Cloudflare side. It does not
turn Cloudflare Workers into a supported producer or worker host. A Node.js producer is the
supported path.

<details>
<summary>Reference: Hyperdrive verification</summary>

A Wrangler 4.124 local Worker used `nodejs_compat`, the repository's `pg` dependency, and a local
Hyperdrive binding. It ran `SELECT 1` against the worktree test database and returned
`{ "connected": true }`.

That test covers the Workers runtime and the PostgreSQL transport. Local Hyperdrive does not enable
Cloudflare's managed pooling or cache. Cloudflare's own documentation states that Hyperdrive
manages connection pooling. Cloudflare's runtime limits also let it cancel work after the response
or a client disconnect.

More detail: [Compatibility and support boundary: Serverless and edge runtimes](../compatibility.md#serverless-and-edge-runtimes).

</details>

## Where does the worker run?

The shop keeps its checkout on Vercel and runs `workhorse worker` on a Cloud Run worker pool.

1. A checkout request commits order `order-42` and its `order.fulfill` task.
2. The worker, connected to the same PostgreSQL database, claims the task and runs the handler.
3. During a deployment, the platform sends the old instance a termination signal. The worker stops
   claiming, lets active handlers finish within a bounded drain, then exits.

The producer and worker only need access to the same PostgreSQL database. Keep request handlers on
the serverless platform. Run `workhorse worker` on a virtual machine, a container service, a
Kubernetes deployment, or a Cloud Run worker pool. Give that worker a pool with room for its
dedicated connections; the [connection pooling guide](390-connection-pooling.md) explains the
budget and the opt-out for a pool that cannot spare them.

The [worker process guide](310-workers.md) explains handler execution. The
[operations guide](350-production-telemetry.md) explains how to observe the separate worker tier.

<details>
<summary>Reference: worker process lifecycle</summary>

**Entry points**

- `defineWorkerProcess()` declares a process-owned adapter and one or more worker configurations.
- `startWorkerProcess()` orchestrates without global signals.
- `runWorkerProcess()` and `workhorse worker --config` add the standalone Node lifecycle.

**Shutdown**

| Event                          | Result                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| First `SIGINT` or `SIGTERM`    | Readiness turns false, claims stop, active handlers and heartbeats go on. |
| Second signal                  | Exits with the conventional signal code.                                  |
| Missed deadline                | Exits with code 1. The default deadline is 25 seconds.                    |
| Unexpected worker-loop failure | Stops sibling workers, applies the same bounded drain, fails the process. |

`shutdownTimeoutMs` sets the deadline. Hard termination leaves active leases for ordinary fenced
expiry recovery.

More detail: [Operations and CLI: Worker process lifecycle](../architecture/operations.md#worker-process-lifecycle).

</details>

## Next

- [How do I run workers?](310-workers.md)
- [How does enqueue stay transactional?](200-transactional-enqueue.md)
- [How do I observe production?](350-production-telemetry.md)

Exact process lifecycle and PostgreSQL ownership rules:
[architecture reference](../architecture/operations.md#worker-process-lifecycle).
