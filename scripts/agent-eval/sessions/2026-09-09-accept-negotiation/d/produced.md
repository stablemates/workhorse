I have what I need. Here is the complete integration.

## What I read and what it forced

- **Transactional enqueue** ([enqueue](https://workhorse.run/docs/enqueue.md)): TypeScript passes the open transaction client as the **fourth** argument to `enqueue`, so the job and the order row share one commit. This is the documented replacement for an outbox.
- **At-least-once is the design** ([limitations](https://workhorse.run/docs/limitations.md), [durable-execution](https://workhorse.run/docs/durable-execution.md)): a checkpoint commits _after_ its operation, so a crash between the HTTP send and the checkpoint commit resends. The docs are explicit that only a provider idempotency key closes that gap — so the handler uses **both**.
- **Enqueue idempotency fingerprints `deadline`, `runAt`, `maxAttempts`, `retryPolicy`** ([idempotency](https://workhorse.run/docs/idempotency.md)). A `deadline` computed from `Date.now()` would differ on a replayed request and throw `EnqueueIdempotencyConflictError`, so this code deliberately omits `deadline` and bounds work with `executionTimeoutMs` + attempts instead.
- **Decorrelated jitter** ([retries](https://workhorse.run/docs/retries.md)) is the documented recommendation for anything talking to an external service.
- **The schema is a deployment step, never a startup step** ([for-ai-agents](https://workhorse.run/docs/for-ai-agents.md)); runtime calls `assertSchemaCompatible`.
- **The worker CLI imports compiled JavaScript** ([worker-processes](https://workhorse.run/docs/worker-processes.md)) — it bundles no TypeScript loader, so the config path below points at `dist/`.

---

### `src/workhorse/client.ts` — shared pool, queue, startup assertion

```ts
import { Admin, Pool, Queue, assertSchemaCompatible } from "@stablemates/workhorse";

export const EMAIL_QUEUE = "email";
export const ORDER_CONFIRMATION_JOB = "email.order_confirmation";

/** The web tier's pool. The worker process owns a separate pool (see workhorse.worker.ts). */
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const queue = new Queue(pool);
export const admin = new Admin(pool);

/**
 * Call once during application startup. This only *verifies* the installed schema;
 * installation and migration are deployment steps (`workhorse schema install|migrate`).
 * Installing on the runtime path makes every replica race to migrate.
 */
export async function assertWorkhorseReady(): Promise<void> {
  await assertSchemaCompatible(pool);
}
```

### `src/email/provider.ts` — the external HTTP provider client

```ts
/**
 * Minimal client for the transactional-email provider's REST API.
 *
 * Every send carries an Idempotency-Key. Workhorse delivers handlers at least once,
 * and a checkpoint commits *after* its operation returns, so a worker can crash in the
 * window between "provider accepted the message" and "checkpoint recorded it".
 * The provider key is what makes that repeat harmless.
 */

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendReceipt {
  providerMessageId: string | null;
  httpStatus: number;
}

/** The provider refused this message and will refuse it identically forever (bad address, blocked domain). */
export class ProviderPermanentError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Email provider rejected the message with ${status}: ${detail}`);
    this.name = "ProviderPermanentError";
  }
}

/** Transient: rate limit, upstream fault, timeout. Worth another Workhorse attempt. */
export class ProviderRetryableError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Email provider failed transiently with ${status}: ${detail}`);
    this.name = "ProviderRetryableError";
  }
}

const RETRYABLE_CLIENT_STATUSES = new Set([408, 423, 425, 429]);

export interface EmailProviderOptions {
  baseUrl: string;
  apiToken: string;
  requestTimeoutMs?: number;
}

export class EmailProvider {
  readonly #baseUrl: string;
  readonly #apiToken: string;
  readonly #requestTimeoutMs: number;

  constructor(options: EmailProviderOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiToken = options.apiToken;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async send(
    message: EmailMessage,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<SendReceipt> {
    // Compose the handler's abort signal (cancellation, deadline, execution timeout)
    // with a per-request timeout, so a hung socket cannot hold a worker slot.
    const signals: AbortSignal[] = [AbortSignal.timeout(this.#requestTimeoutMs)];
    if (options.signal) signals.push(options.signal);

    const response = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiToken}`,
        "idempotency-key": options.idempotencyKey,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.any(signals),
    });

    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { id?: string };
      return { providerMessageId: body.id ?? null, httpStatus: response.status };
    }

    const detail = (await response.text().catch(() => "")).slice(0, 500);

    if (response.status >= 500 || RETRYABLE_CLIENT_STATUSES.has(response.status)) {
      throw new ProviderRetryableError(response.status, detail);
    }
    throw new ProviderPermanentError(response.status, detail);
  }
}
```

### `src/orders/create-order.ts` — the existing write, now with the job enqueued alongside it

```ts
import type { PoolClient } from "@stablemates/workhorse";
import { EMAIL_QUEUE, ORDER_CONFIRMATION_JOB, pool, queue } from "../workhorse/client.js";

export interface NewOrder {
  id: string;
  customerEmail: string;
  totalCents: number;
  currency: string;
}

export interface OrderConfirmationPayload {
  orderId: string;
  email: string;
}

/**
 * Insert the order and accept the confirmation-email job in ONE transaction.
 *
 * The job is written by the same transaction as the row, so there is no window where
 * an order exists without its email job, or a worker picks up an order that rolled back.
 * This is what replaces an outbox table.
 */
export async function createOrder(order: NewOrder): Promise<{ orderId: string; jobId: string }> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO orders (id, customer_email, total_cents, currency, status)
       VALUES ($1, $2, $3, $4, 'new')`,
      [order.id, order.customerEmail, order.totalCents, order.currency],
    );

    const payload: OrderConfirmationPayload = {
      orderId: order.id,
      email: order.customerEmail,
    };

    const jobId = await queue.enqueue(
      ORDER_CONFIRMATION_JOB,
      payload,
      {
        queue: EMAIL_QUEUE,
        // Decorrelated jitter is the documented choice for external services: when a
        // provider outage fails a thousand jobs at once, their retries spread out
        // instead of arriving together and re-toppling the recovering service.
        maxAttempts: 6,
        retryPolicy: { type: "decorrelated-jitter", baseDelayMs: 1_000, maxDelayMs: 60_000 },
        executionTimeoutMs: 30_000,
        tags: [`order:${order.id}`],
        // Guards duplicate *acceptance* (double-clicked checkout, retried API call).
        // NOTE: the idempotency fingerprint covers payload, maxAttempts, retryPolicy,
        // executionTimeoutMs and an explicit runAt. Keep all of them deterministic for a
        // given order — a `deadline` computed from Date.now() would differ between the
        // original and the replay and raise EnqueueIdempotencyConflictError. That is why
        // this job bounds itself with attempts and executionTimeoutMs and sets no deadline.
        idempotency: { key: `order:${order.id}`, scope: "order-confirmation" },
      },
      client, // <-- the fourth argument is the transaction. Without it, the job can
      //     commit while the order rolls back.
    );

    await client.query("COMMIT");
    return { orderId: order.id, jobId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

### `src/jobs/send-order-confirmation.ts` — the handler

```ts
import type { HandlerContext, Queryable } from "@stablemates/workhorse";
import { EmailProvider, ProviderPermanentError, type EmailMessage } from "../email/provider.js";
import type { OrderConfirmationPayload } from "../orders/create-order.js";

interface OrderRow {
  id: string;
  customer_email: string;
  total_cents: number;
  currency: string;
}

type SendOutcome =
  | { status: "sent"; providerMessageId: string | null; httpStatus: number }
  | { status: "rejected"; httpStatus: number; detail: string };

function parsePayload(payload: unknown): OrderConfirmationPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("order confirmation payload must be an object");
  }
  const { orderId, email } = payload as Partial<OrderConfirmationPayload>;
  if (typeof orderId !== "string" || typeof email !== "string") {
    throw new Error("order confirmation payload needs string orderId and email fields");
  }
  return { orderId, email };
}

function renderConfirmation(order: OrderRow, from: string): EmailMessage {
  const total = (order.total_cents / 100).toFixed(2);
  return {
    to: order.customer_email,
    from,
    subject: `Your order ${order.id} is confirmed`,
    text: `Thanks! Order ${order.id} is confirmed. Total: ${total} ${order.currency}.`,
    html: `<p>Thanks! Order <strong>${order.id}</strong> is confirmed.</p>
           <p>Total: ${total} ${order.currency}</p>`,
  };
}

export function createOrderConfirmationHandler(dependencies: {
  database: Queryable;
  provider: EmailProvider;
  fromAddress: string;
}) {
  const { database, provider, fromAddress } = dependencies;

  return async function sendOrderConfirmation(payload: unknown, context: HandlerContext) {
    const { orderId } = parsePayload(payload);

    // The job committed with the order row, so this read cannot miss.
    const { rows } = await database.query<OrderRow>(
      `SELECT id, customer_email, total_cents, currency FROM orders WHERE id = $1`,
      [orderId],
    );
    const order = rows[0];
    if (!order) throw new Error(`order ${orderId} not found`);

    // The one external effect, wrapped in a named checkpoint: the first activation sends
    // and persists the receipt; every later activation (retry, crash recovery, redrive of
    // this same job) replays the stored value without calling the provider again.
    // Checkpoint names are durable control flow — renaming this string makes in-flight
    // jobs re-send, so treat it as immutable.
    const outcome = await context.checkpoint<SendOutcome>("provider-send", async () => {
      try {
        const receipt = await provider.send(renderConfirmation(order, fromAddress), {
          // Closes the gap the checkpoint cannot: a crash between the accepted send and
          // the checkpoint commit reruns this operation, and the provider dedupes it.
          // Keyed on the order, not the attempt, so it is stable across attempts.
          idempotencyKey: `order-confirmation:${orderId}`,
          signal: context.signal, // aborts on cancellation, deadline, or execution timeout
        });
        return {
          status: "sent",
          providerMessageId: receipt.providerMessageId,
          httpStatus: receipt.httpStatus,
        };
      } catch (error) {
        // A permanent rejection (malformed or blocked address) will fail identically on
        // every attempt. Recording it as a durable result instead of rethrowing stops it
        // from burning the whole retry budget on a foregone conclusion, and the reason
        // stays queryable via Admin.getJob / the dashboard.
        // If you would rather have these land in the dead-letter queue for triage,
        // delete this catch and let the error propagate.
        if (error instanceof ProviderPermanentError) {
          return { status: "rejected", httpStatus: error.status, detail: error.detail };
        }
        // Everything else — 5xx, 429, socket failure — throws, spends one attempt, and
        // PostgreSQL reschedules it with the persisted jitter policy.
        throw error;
      }
    });

    if (outcome.status === "sent") {
      // Safe to repeat: a replayed activation writes the same row values.
      await database.query(
        `UPDATE orders SET confirmation_sent_at = COALESCE(confirmation_sent_at, now()) WHERE id = $1`,
        [orderId],
      );
    }

    return { orderId, ...outcome };
  };
}
```

### `src/workhorse.worker.ts` — the worker process

```ts
import {
  Pool,
  assertSchemaCompatible,
  createWorkhorseAdapter,
  defineWorkerProcess,
} from "@stablemates/workhorse";
import { EmailProvider } from "./email/provider.js";
import { createOrderConfirmationHandler } from "./jobs/send-order-confirmation.js";
import { EMAIL_QUEUE, ORDER_CONFIRMATION_JOB } from "./workhorse/client.js";

// One process, one pool. The adapter's close() ends it after the last worker drains.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// Verify, never install: `workhorse schema install|migrate` runs in the deploy pipeline.
await assertSchemaCompatible(pool);

const provider = new EmailProvider({
  baseUrl: process.env.EMAIL_PROVIDER_URL!,
  apiToken: process.env.EMAIL_PROVIDER_TOKEN!,
});

const sendOrderConfirmation = createOrderConfirmationHandler({
  database: pool,
  provider,
  fromAddress: process.env.EMAIL_FROM ?? "orders@example.com",
});

export default defineWorkerProcess({
  adapter() {
    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (transaction: typeof pool) => transaction,
      close: () => pool.end(),
    });
  },
  workers: [
    {
      options: {
        queues: [EMAIL_QUEUE],
        // Concurrent in-flight sends in this replica; replicas multiply it. If the
        // provider enforces a fleet-wide send rate, add a Workhorse rate-limit policy
        // rather than tuning this number per replica.
        concurrency: 8,
        leaseMs: 60_000,
      },
      configure(worker) {
        worker.handle(ORDER_CONFIRMATION_JOB, sendOrderConfirmation);
      },
    },
  ],
  // Keep this under your platform's termination grace period. On SIGTERM the process
  // stops claiming, readiness drops, and in-flight sends finish. Anything not drained
  // in time keeps its lease in PostgreSQL and is recovered by another worker.
  shutdownTimeoutMs: 25_000,
  probes: { hostname: "0.0.0.0", port: 9090 }, // /livez and /readyz
});
```

### `src/deploy/install-schema.ts` — optional, if you migrate in code rather than via the CLI

```ts
import { Pool, installSchema } from "@stablemates/workhorse";

// Equivalent to `workhorse schema install`. Run it from a deployment step, exactly once,
// never from application or worker startup.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await installSchema(pool);
} finally {
  await pool.end();
}
```

### Order table column this adds

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz;
```

### Running the worker

Compile first — the `workhorse worker` CLI imports plain JavaScript and ships no TypeScript loader:

```bash
npx tsc -p tsconfig.json
npx workhorse worker --config ./dist/workhorse.worker.js
```

### Notes on the boundaries this leaves open

- **Requires Node.js 22 or 24 and PostgreSQL 15–18.**
- Cancellation is cooperative. `context.signal` is threaded into `fetch`, which is the only slow operation here, so a cancelled or timed-out job stops promptly.
- Workhorse is in **public beta** (0.x); a minor release may change behaviour, so read the changelog before upgrading. Migrations are ordered and additive within a major line, so no database recreation.
- Failed-past-budget jobs become dead letters; replay them after an incident with `Admin.redriveMany`, reusing one `requestId` so a crashed script cannot double-send. Redrive is another at-least-once execution — the provider idempotency key keyed on `orderId` means a redriven confirmation dedupes at the provider rather than mailing the customer twice.

```install
npm install @stablemates/workhorse
npm exec --no -- workhorse schema install
```
