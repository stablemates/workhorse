---
name: workhorse
description: "Use when adding background jobs, durable execution, or a job queue to a TypeScript application that already runs on PostgreSQL. Triggers include \"background job\", \"job queue\", \"durable execution\", \"retry a failed job\", \"schedule a task\", \"cron in postgres\", \"outbox pattern\", \"enqueue in a transaction\", \"resume after a crash\", \"dead letter\", \"redrive\", \"rate limit a queue\", \"@workhorse/core\", or setting up Workhorse with Drizzle, Prisma, TypeORM, or Kysely."
---

# Workhorse

Workhorse is a durable job queue built from PostgreSQL tables and versioned SQL functions, driven by the `@workhorse/core` TypeScript library. There is no broker, no Redis, and no PostgreSQL extension.

The one thing to understand before writing any code: **a job is a row in the same database as your data**. So it can be enqueued inside the transaction that writes the data, and it either commits with that data or does not exist.

Full documentation: <https://workhorse.run/llms.txt>. Every page is available as Markdown by appending `.md` to its URL.

## Before you write code

1. **Confirm the runtime.** Node.js 22 or newer, PostgreSQL 15 or newer. Below either line there is no supported path.
2. **Confirm the package.** `@workhorse/core` plus the `pg` driver covers most applications. Add `@workhorse/drizzle`, `@workhorse/prisma`, `@workhorse/typeorm`, or `@workhorse/kysely` only to enqueue inside that ORM's own transactions.
3. **Never install the schema from application code.** Installation is a deployment step. Runtime processes verify, they do not create.

## The four things you will write

### 1. Install the schema, once, from a deployment step

```bash
npx workhorse schema install
npx workhorse schema status
```

Or from deployment code:

```ts
import { Pool } from "pg";
import { installSchema } from "@workhorse/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);
await pool.end();
```

`installSchema` targets a clean database and refuses anything mixed, unversioned, or older. It is not an upgrade path — that is `migrateSchema`.

Application and worker processes call `assertSchemaCompatible(pool)` instead. It reads the installed version and changes nothing.

### 2. Enqueue inside the transaction that writes your data

This is the whole point. Pass your open transaction as the **last** argument.

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

If the transaction rolls back, PostgreSQL removes the order row and the job together. No outbox table, no relay process.

Omit the transaction argument and the job is enqueued on its own connection, which is correct only when nothing else is being written.

`enqueue` returns the job id. The signature is `enqueue(type, payload, options?, transaction?)`.

### 3. Register a handler and run a worker

```ts
import { Worker } from "@workhorse/core";

const worker = new Worker(queue).handle("order.fulfill", async (payload, ctx) => {
  const charge = await ctx.checkpoint("charge", () => chargeCard(payload.orderId));
  // If the process dies here, the retry replays "charge" from storage and resumes below.
  const label = await ctx.checkpoint("label", () => printLabel(payload.orderId));
  return { chargeId: charge.chargeId, labelId: label.labelId };
});

await worker.run();
```

### 4. Decide what happens when it fails

Set the attempt budget and backoff at enqueue time through `EnqueueOptions`.

## Delivery is at least once — plan for it

A handler can run twice after a crash. This is the single most common source of bugs, and no configuration removes it.

- **Inside your process**, wrap each side effect in `ctx.checkpoint(name, fn)`. A completed stage returns its stored result on replay instead of running again.
- **Outside your process**, you still need the provider's idempotency key. A checkpoint cannot make a payment API idempotent for you.

A retry is the same job having another go. A redrive is different: it happens only after terminal failure and creates a new job identity.

## `HandlerContext`, the API you will actually use

Verified against `typescript/core/src/worker.ts`.

- **`ctx.checkpoint(name, operation)`**: run once, persist the JSON result, replay it on later attempts.
- **`ctx.getCheckpoint(name)`**: read a stored boundary without executing anything.
- **`ctx.sleep(name, durationMs)`** and **`ctx.sleepUntil(name, wakeAt)`**: suspend without consuming the attempt and without holding a worker slot.
- **`ctx.waitForSignal(name, options?)`**: suspend until an external delivery supplies that named payload.
- **`ctx.waitForHuman(name, context, options?)`**: suspend until an operator completes a named decision.
- **`ctx.runChild(name, type, payload, options?)`**: create or replay one named child and get its result.
- **`ctx.setProgress(value)`** and **`ctx.getProgress()`**: mutable progress for operators to watch.
- **`ctx.job`**: the claimed job. **`ctx.signal`**: an `AbortSignal` for cooperative cancellation.

## `EnqueueOptions`, the fields worth knowing

Verified against `typescript/core/src/types.ts`.

- **`queue`**: queue name. **`priority`**: 0 through 100, higher is claimed first.
- **`runAt`**: earliest run time. **`deadline`**: absolute wall clock, terminal on arrival even with budget left.
- **`executionTimeoutMs`**: active execution time for one attempt, excluding durable waits.
- **`maxAttempts`** and **`retryPolicy`**: the attempt budget and the persisted backoff.
- **`concurrencyKey`**: queue-scoped group for durable concurrency admission.
- **`tags`**: labels for querying.

## Rules that prevent the common mistakes

1. **Pass the transaction, or explain why not.** An enqueue outside the caller's transaction reintroduces the two-system problem the library exists to remove.
2. **Name every checkpoint, sleep, wait, and child.** The name is the replay key. Renaming one in a deploy orphans in-flight jobs.
3. **Return JSON from a checkpoint.** The value is persisted; a class instance or a `Date` will not survive replay as itself.
4. **Do not call `installSchema` at runtime.** Use `assertSchemaCompatible`.
5. **Do not hold a worker slot with `setTimeout`.** Use `ctx.sleep`, which releases the slot.
6. **Check `ctx.signal` in long loops.** Cancellation is cooperative.
7. **Do not invent options.** If a field is not in `EnqueueOptions`, it does not exist. Read the page rather than guessing.

## When Workhorse is the wrong tool

Say so rather than forcing it.

- The queue must scale independently of the database.
- The work is not transactional, so the main advantage does not apply.
- A workflow definition language is required. Workhorse gives durable primitives; orchestration stays application code.
- PostgreSQL is older than 15.

## Where to read more

Fetch the Markdown, not the HTML.

- <https://workhorse.run/llms.txt> — the full index.
- <https://workhorse.run/docs/quickstart.md> — first running job.
- <https://workhorse.run/docs/concepts.md> — identity, ownership, delivery, evidence.
- <https://workhorse.run/docs/durable-execution.md> — checkpoints and durable waits.
- <https://workhorse.run/docs/retries.md> — attempt budgets and backoff.
- <https://workhorse.run/docs/limitations.md> — the boundaries, stated plainly.
