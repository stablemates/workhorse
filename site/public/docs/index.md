# What is Workhorse?

> A durable job queue that lives inside PostgreSQL, so your jobs commit with your data.

Every application eventually needs work that outlives a request: send the email, charge the card,
rebuild the report. The moment that work moves to a separate broker, you have two systems that can
disagree — an order row without its job, or a job for an order that rolled back.

Workhorse removes the second system. It is a durable job queue built from PostgreSQL tables and
versioned SQL functions, driven by the `@workhorse/core` TypeScript library. There is no broker, no
Redis, and no PostgreSQL extension — one database owns your business data, your queued work, your
execution state, and the evidence of what happened.

## The core promise

`Queue.enqueue` accepts your open transaction as its last argument. If the transaction commits, the
job exists; if it rolls back, PostgreSQL removes the business write and the job together.

```ts
import { Pool } from "pg";
import { Queue } from "@workhorse/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const queue = new Queue(pool);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("INSERT INTO orders (id) VALUES ($1)", [orderId]);
  await queue.enqueue("order.fulfill", { orderId }, {}, client);
  await client.query("COMMIT");
} finally {
  client.release();
}
```

A `Worker` claims the job and runs the handler you registered with `Worker.handle`. Each claim
grants a temporary lease and a fence token. If the worker dies, the lease expires, another worker
recovers the job, and the fence token blocks the dead worker from writing stale results.

Handlers run outside database transactions, so delivery is at least once: a handler can run twice
after a crash. Named checkpoints make that safe. If a handler restarts, `ctx.checkpoint` replays
each completed stage's stored result instead of running it again.

```ts
import { Worker } from "@workhorse/core";

const worker = new Worker(queue).handle("order.fulfill", async (payload, ctx) => {
  const charge = await ctx.checkpoint("charge", () => chargeCard(payload.orderId));
  // If the process dies here, the retry skips "charge" and resumes below.
  const label = await ctx.checkpoint("label", () => printLabel(payload.orderId));
  return { chargeId: charge.chargeId, labelId: label.labelId };
});
await worker.run();
```

Beyond checkpoints, jobs get retries with configurable backoff, durable sleeps that release the
worker slot, cron-style schedules, idempotent enqueue, dead letters with redrive, and immutable
history you can query with `Queue.getJob` and `Queue.getJobTimeline`.

## Where to go next

<Cards>
  <Card title="Getting started" href="/docs/comparison">
    Whether Workhorse fits, how to install it, and your first running job.
  </Card>
  <Card title="Producing work" href="/docs/enqueue">
    Enqueue, payload contracts, idempotency, schedules, priority, and rate limits.
  </Card>
  <Card title="Executing work" href="/docs/workers">
    Workers, retries, checkpoints, durable sleeps, signals, and cancellation.
  </Card>
  <Card title="Operating" href="/docs/queries">
    Queries, dead letters, retention, worker processes, and queue health.
  </Card>
  <Card title="Integrations" href="/docs/drizzle">
    Drizzle • Prisma • TypeORM • Kysely • Dashboard
  </Card>
  <Card title="Reference" href="/docs/api">
    The public API surface, the support boundary, and the current limits.
  </Card>
</Cards>

## Next

- [Should you use Workhorse?](/docs/comparison) — the trade, and when a broker wins instead
- [Installation](/docs/installation) — add the package and install its schema
- [Quickstart](/docs/quickstart) — run a job, kill the worker, watch it finish anyway

---

Exact lifecycle guarantees, tables, and protocol boundaries:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#design-objective).
