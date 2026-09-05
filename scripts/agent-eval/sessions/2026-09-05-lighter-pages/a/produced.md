I read: the landing page → `llms.txt` → Quickstart, Installation, Enqueue & transactions, Workers, Worker processes, Durable execution, Retries, Idempotency, Rate limits, API overview (13 fetches).

Here is the complete code.

---

### `src/workhorse/client.ts` — one pool, one `Queue`, verified at startup

```ts
import { assertSchemaCompatible, Admin, Pool, Queue } from "@stablemates/workhorse";

/**
 * The web tier's pool. If the app already owns a `pg` Pool, reuse that one
 * instead — `new Queue(database)` takes any pg-compatible `Queryable`.
 */
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Default queue for everything this module enqueues. */
export const queue = new Queue(pool, "email");

/** Operator reads (job state, dead letters). Not needed to enqueue. */
export const admin = new Admin(pool);

/**
 * Call once during application startup, before serving traffic.
 * Runtime processes verify the schema; they never install it.
 * Throws SchemaCompatibilityError, whose `code` names the reason.
 */
export async function verifyWorkhorseSchema(): Promise<void> {
  await assertSchemaCompatible(pool);
}

export const ORDER_CONFIRMATION_JOB = "email.order-confirmation";

export type OrderConfirmationPayload = {
  orderId: string;
  to: string;
};
```

---

### `src/orders/create-order.ts` — the order row and the job commit together

```ts
import type { PoolClient } from "pg";

import {
  ORDER_CONFIRMATION_JOB,
  pool,
  queue,
  type OrderConfirmationPayload,
} from "../workhorse/client.js";

export type NewOrder = {
  id: string;
  customerEmail: string;
  total: number;
};

/**
 * Existing write, now with the confirmation email attached to it.
 *
 * `enqueue`'s fourth argument is the open transaction, so PostgreSQL commits
 * the job row and the order row together — or rolls both back. No outbox
 * table, no relay process: if the order does not exist, neither does the job.
 */
export async function createOrder(order: NewOrder): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("INSERT INTO orders (id, customer_email, total) VALUES ($1, $2, $3)", [
      order.id,
      order.customerEmail,
      order.total,
    ]);

    const payload: OrderConfirmationPayload = {
      orderId: order.id,
      to: order.customerEmail,
    };

    await queue.enqueue(
      ORDER_CONFIRMATION_JOB,
      payload,
      {
        queue: "email",
        // A double-clicked "Place order" (or a retried API call) that reaches
        // this path twice converges on one job instead of two emails.
        // Repeating it with a materially different payload throws
        // EnqueueIdempotencyConflictError rather than silently winning.
        idempotency: {
          key: `order-confirmation:${order.id}`,
          scope: "order-confirmation",
          ttlMs: 86_400_000,
        },
        // Talking to an external provider: give up after 5 attempts, and
        // spread the retry wave so a recovering provider is not re-flooded.
        maxAttempts: 5,
        retryPolicy: {
          type: "decorrelated-jitter",
          baseDelayMs: 1_000,
          maxDelayMs: 60_000,
        },
        // One attempt is stuck after 30s; this aborts ctx.signal mid-request.
        executionTimeoutMs: 30_000,
        tags: [`order:${order.id}`],
      },
      client,
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

---

### `src/workhorse/email-provider.ts` — the external HTTP provider

```ts
export type SendConfirmationRequest = {
  to: string;
  orderId: string;
  orderNumber: string;
  total: number;
  /** Provider-side dedupe key. This is what makes a repeated send harmless. */
  idempotencyKey: string;
  /** Aborted on cancellation, deadline, or execution timeout. */
  signal: AbortSignal;
};

export type SendConfirmationResult = {
  messageId: string;
};

/** Thrown for provider failures so the attempt fails and Workhorse retries. */
export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "EmailProviderError";
  }
}

const PROVIDER_URL =
  process.env.EMAIL_PROVIDER_URL ?? "https://api.email-provider.example/v1/messages";

export async function sendOrderConfirmation(
  request: SendConfirmationRequest,
): Promise<SendConfirmationResult> {
  const response = await fetch(PROVIDER_URL, {
    method: "POST",
    signal: request.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.EMAIL_PROVIDER_API_KEY}`,
      // Same key on every retry and every replayed activation, so the
      // provider collapses duplicates into one delivery.
      "idempotency-key": request.idempotencyKey,
    },
    body: JSON.stringify({
      to: request.to,
      template: "order-confirmation",
      variables: {
        orderId: request.orderId,
        orderNumber: request.orderNumber,
        total: request.total,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new EmailProviderError(
      `email provider responded ${response.status}`,
      response.status,
      body,
    );
  }

  const delivery = (await response.json()) as { id: string };
  return { messageId: delivery.id };
}
```

---

### `src/jobs/order-confirmation.ts` — the handler

```ts
import type { Pool } from "@stablemates/workhorse";

import { sendOrderConfirmation, type SendConfirmationResult } from "../workhorse/email-provider.js";
import type { OrderConfirmationPayload } from "../workhorse/client.js";

type OrderRow = {
  order_number: string;
  customer_email: string;
  total: number;
};

function assertPayload(payload: unknown): asserts payload is OrderConfirmationPayload {
  const value = payload as Partial<OrderConfirmationPayload> | null;
  if (!value || typeof value.orderId !== "string" || typeof value.to !== "string") {
    throw new Error("order confirmation payload needs string orderId and to fields");
  }
}

/**
 * Handlers restart from the top after a retry, a crash, or a durable wait,
 * so every effect that must not repeat sits behind a named checkpoint AND
 * carries a provider idempotency key. The checkpoint makes repeats rare;
 * the provider key makes them harmless.
 */
export function createOrderConfirmationHandler(database: Pool) {
  return async function handleOrderConfirmation(
    payload: unknown,
    ctx: {
      job: { id: string; attempt: number };
      signal: AbortSignal;
      checkpoint: <T>(name: string, operation: () => Promise<T> | T) => Promise<T>;
      setProgress: (value: unknown) => Promise<unknown>;
    },
  ) {
    assertPayload(payload);
    const { orderId, to } = payload;

    // Cheap read; safe to repeat, so it needs no checkpoint.
    const { rows } = await database.query<OrderRow>(
      "SELECT order_number, customer_email, total FROM orders WHERE id = $1",
      [orderId],
    );
    const order = rows[0];
    if (!order) {
      // The job commits with the order, so this only happens if the row was
      // deleted afterwards. Nothing to confirm.
      return { skipped: "order-missing" as const, orderId };
    }

    await ctx.setProgress({ stage: "sending", attempt: ctx.job.attempt });

    // Deadline, execution timeout, and queue.cancel() all arrive here.
    if (ctx.signal.aborted) throw ctx.signal.reason;

    const delivery = await ctx.checkpoint<SendConfirmationResult>("send", () =>
      sendOrderConfirmation({
        to,
        orderId,
        orderNumber: order.order_number,
        total: order.total,
        // Stable domain key: identical across retries, replays, and redrives.
        idempotencyKey: `order-confirmation:${orderId}`,
        signal: ctx.signal,
      }),
    );

    // Replayed on any later activation, never a second provider call.
    await ctx.checkpoint("record-delivery", async () => {
      await database.query(
        `UPDATE orders
            SET confirmation_message_id = $2,
                confirmation_sent_at = now()
          WHERE id = $1
            AND confirmation_message_id IS NULL`,
        [orderId, delivery.messageId],
      );
      return { recorded: true };
    });

    // Becomes the job's durable, queryable result.
    return { deliveredTo: to, messageId: delivery.messageId };
  };
}
```

---

### `src/workhorse.worker.ts` — the worker process (compiled, then run by the CLI)

```ts
import { createWorkhorseAdapter, defineWorkerProcess, Pool } from "@stablemates/workhorse";

import { createOrderConfirmationHandler } from "./jobs/order-confirmation.js";
import { ORDER_CONFIRMATION_JOB } from "./workhorse/client.js";

export default defineWorkerProcess({
  adapter() {
    // This process owns its own pool; the adapter closes it after the last
    // worker drains.
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });

    const definition = createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (transaction: typeof pool) => transaction,
      close: () => pool.end(),
    });

    // Handlers need the same pool for their reads/writes.
    workerPool = pool;
    return definition;
  },
  workers: [
    {
      options: { queues: ["email"], concurrency: 8 },
      configure(worker) {
        worker.handle(ORDER_CONFIRMATION_JOB, createOrderConfirmationHandler(workerPool));
      },
    },
  ],
  // First SIGTERM/SIGINT stops claiming and drains active handlers.
  shutdownTimeoutMs: 25_000,
  // /livez and /readyz for the orchestrator; readiness drops when draining.
  probes: { hostname: "0.0.0.0", port: 9090 },
});

let workerPool!: Pool;
```

Run it (the CLI imports compiled JavaScript — it ships no TypeScript loader):

```bash
npm exec --no -- workhorse worker --config ./dist/workhorse.worker.js
```

---

### `scripts/deploy-workhorse.ts` — deployment step

```ts
import { installSchema, migrateSchema, Pool, Queue } from "@stablemates/workhorse";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// New database: installSchema(pool). Existing installation: migrateSchema(pool).
if (process.env.WORKHORSE_FRESH_INSTALL === "1") {
  await installSchema(pool);
} else {
  await migrateSchema(pool);
}

// The provider allows 60 calls/minute across the whole fleet. PostgreSQL owns
// the token bucket, so every worker replica draws from the same budget.
// Desired state: rerun on every deploy.
await new Queue(pool, "email").syncRateLimitPolicies("order-email", [
  {
    queue: "email",
    rate: { limit: 60, intervalMs: 60_000, burst: 10 },
  },
]);

await pool.end();
```

---

**Notes on the two guarantees this relies on.** The job is a row in your transaction, so the confirmation email exists exactly when the order does — that is the enqueue's fourth argument. Delivery to the handler is still at-least-once (a worker can die mid-attempt and its lease is recovered), so the send sits behind `ctx.checkpoint("send", …)`, which replays its stored result on any later activation. A checkpoint commits _after_ its operation, so a crash landing between the HTTP call and that commit would re-run the send — that final gap is closed only by the provider's own `idempotency-key`, which is why the code passes a stable `order-confirmation:${orderId}`. Attempts that exhaust `maxAttempts: 5` land in the dead-letter relation with their error and can be redriven through `Admin.redrive` once the provider incident is fixed.

```install
npm install @stablemates/workhorse
npm exec --no -- workhorse schema install
```
