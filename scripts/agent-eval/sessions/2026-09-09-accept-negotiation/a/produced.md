I read the docs (home → quickstart → api → enqueue → workers → durable-execution → retries → worker-processes → installation → idempotency → cancellation → examples → rate-limits). Here is the complete integration.

---

## Design (why the code looks like this)

- **The enqueue joins your existing order transaction.** TypeScript's `queue.enqueue(type, payload, options, client)` takes the open `pg` client as the 4th argument, so the job row commits or rolls back with the order. No outbox.
- **Delivery is at-least-once.** The docs are explicit: a checkpoint commits _after_ its operation, so a crash between "provider accepted" and "checkpoint committed" re-runs the send. So the handler wraps the HTTP call in `ctx.checkpoint("provider-send", …)` **and** passes a provider-side `Idempotency-Key` derived from `orderId`. Checkpoint makes repeats rare; the provider key makes them harmless.
- **No `deadline` / no `runAt` on this job.** Enqueue idempotency fingerprints the queue, type, payload, tags, attempt budget, retry policy, deadline, execution timeout and explicit `runAt`. A clock-derived `deadline` would differ between a double-clicked request and its replay and throw `EnqueueIdempotencyConflictError` instead of converging.
- **`decorrelated-jitter` retry policy**, as the retries page recommends for anything talking to an external service, plus `executionTimeoutMs` to bound one attempt; both arrive on `ctx.signal`, which is forwarded into `fetch`.
- **The worker runs as its own process** via `defineWorkerProcess` + the packaged `workhorse worker` CLI (graceful drain on SIGTERM, `/livez` + `/readyz` probes).

---

### `src/workhorse/contract.ts` — shared names and types (no side effects; imported by web _and_ worker)

```ts
/**
 * Shared contract between the producer (web tier) and the worker process.
 * Keep this module free of side effects: both processes import it, and neither
 * should get the other's connection pool as a bonus.
 */

/** Queue the confirmation mail is claimed from. Workers claim per queue name. */
export const MAIL_QUEUE = "mail";

/**
 * Job type. Handler registration must use the identical string.
 * Treat it as immutable program state, like checkpoint names.
 */
export const ORDER_CONFIRMATION_JOB = "email.order-confirmation";

/** Everything the handler needs; it never reads the orders table back. */
export interface OrderConfirmationPayload {
  orderId: string;
  orderNumber: string;
  to: string;
  customerName: string;
  totalCents: number;
  currency: string;
  placedAt: string; // ISO-8601
}

/** Durable result recorded on the job outcome. */
export interface OrderConfirmationResult {
  orderId: string;
  to: string;
  messageId: string;
  replayed: boolean;
}

/**
 * Provider-side idempotency key for the outbound send.
 * Derived from a stable domain id, so every attempt, recovery and redrive of
 * this order presents the same key to the mail provider.
 */
export function confirmationIdempotencyKey(orderId: string): string {
  return `order-confirmation:${orderId}`;
}
```

---

### `src/workhorse/client.ts` — producer-side pool (web tier)

```ts
import { Pool, Queue, assertSchemaCompatible } from "@stablemates/workhorse";

/**
 * The package ships its own `pg`, and `Queue` accepts any Queryable: a pool,
 * a client, or an ORM adapter. Reuse your application's existing pool if you
 * already have one — this is just the wiring if you don't.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export const queue = new Queue(pool);

/**
 * Call once during application startup. Runtime processes verify the schema;
 * they never install it. Throws SchemaCompatibilityError, whose `code` names
 * the reason, when the deployed schema and this build disagree.
 */
export async function verifyWorkhorseSchema(): Promise<void> {
  await assertSchemaCompatible(pool);
}
```

---

### `src/orders/create-order.ts` — the order write with the job enqueued alongside it

```ts
import { pool, queue } from "../workhorse/client.js";
import {
  MAIL_QUEUE,
  ORDER_CONFIRMATION_JOB,
  type OrderConfirmationPayload,
} from "../workhorse/contract.js";

export interface NewOrder {
  orderId: string;
  orderNumber: string;
  customerEmail: string;
  customerName: string;
  totalCents: number;
  currency: string;
  items: string[];
}

/**
 * Inserts the order and enqueues its confirmation email in ONE transaction.
 * The job is a row in that transaction: if the order rolls back, the job was
 * never enqueued; if the job fails to enqueue, the order does not exist.
 */
export async function createOrder(
  order: NewOrder,
): Promise<{ orderId: string; emailJobId: string }> {
  const placedAt = new Date();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Your existing order write, unchanged.
    await client.query(
      `INSERT INTO orders (id, order_number, customer_email, total_cents, currency, items, placed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        order.orderId,
        order.orderNumber,
        order.customerEmail,
        order.totalCents,
        order.currency,
        order.items,
        placedAt,
      ],
    );

    const payload: OrderConfirmationPayload = {
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      to: order.customerEmail,
      customerName: order.customerName,
      totalCents: order.totalCents,
      currency: order.currency,
      placedAt: placedAt.toISOString(),
    };

    // The 4th argument is the open transaction. This is the whole point.
    const emailJobId = await queue.enqueue(
      ORDER_CONFIRMATION_JOB,
      payload,
      {
        queue: MAIL_QUEUE,

        // Talking to somebody else's HTTP API: budget several attempts and
        // spread the wake times so a recovering provider is not re-flattened.
        maxAttempts: 8,
        retryPolicy: {
          type: "decorrelated-jitter",
          baseDelayMs: 2_000,
          maxDelayMs: 300_000,
        },

        // Bounds ONE attempt; surfaces on ctx.signal in the handler.
        executionTimeoutMs: 30_000,

        tags: [`order:${order.orderId}`, "order-confirmation"],

        // A double-clicked "Place order" (or a retried API call) that reaches a
        // rolled-back-then-retried transaction converges on one job instead of
        // two emails. The key is the business operation, never a timestamp.
        //
        // NOTE: deliberately no `deadline` and no `runAt` here. Both are part of
        // the idempotency fingerprint, so a clock-derived value would make a
        // replay differ from the original and raise
        // EnqueueIdempotencyConflictError instead of converging.
        idempotency: {
          key: `order-confirmation:${order.orderId}`,
          scope: "order-email",
          ttlMs: 86_400_000, // 24h replay window (the default, stated explicitly)
        },
      },
      client, // <- commits with the INSERT above
    );

    await client.query("COMMIT");
    return { orderId: order.orderId, emailJobId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

> Using an ORM instead of raw `pg`? Same guarantee, different handle: install `@stablemates/workhorse-drizzle` / `-prisma` / `-typeorm` / `-kysely` and call `adapter.forTransaction(tx).enqueue(ORDER_CONFIRMATION_JOB, payload, options)` inside your ORM's transaction callback.

---

### `src/email/provider.ts` — the external HTTP provider client

```ts
/**
 * Minimal transactional-email provider client.
 *
 * Two things matter to Workhorse:
 *  1. It accepts an idempotency key, so an at-least-once retry cannot send twice.
 *  2. It accepts an AbortSignal, so cancellation / deadline / execution timeout
 *     stop an in-flight request instead of only being noticed afterwards.
 */

const PROVIDER_URL = process.env.EMAIL_PROVIDER_URL ?? "https://api.email-provider.example";
const PROVIDER_API_KEY = process.env.EMAIL_PROVIDER_API_KEY ?? "";
const FROM_ADDRESS = process.env.EMAIL_FROM ?? "orders@example.com";

/** Base class so dead-letter filtering by `errorName` stays meaningful. */
export class EmailProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmailProviderError";
    this.status = status;
  }
}

/** 429 / 5xx / network / timeout: worth another attempt. */
export class EmailProviderTransientError extends EmailProviderError {
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, status, options);
    this.name = "EmailProviderTransientError";
  }
}

/** 4xx that will never succeed (bad address, rejected template, bad key). */
export class EmailProviderPermanentError extends EmailProviderError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "EmailProviderPermanentError";
  }
}

export interface SendEmailRequest {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Presented to the provider so a repeated call returns the first result. */
  idempotencyKey: string;
}

export interface SendEmailResponse {
  messageId: string;
  /** True when the provider recognised the idempotency key from an earlier call. */
  replayed: boolean;
}

const REQUEST_TIMEOUT_MS = 15_000;

export async function sendTransactionalEmail(
  request: SendEmailRequest,
  { signal }: { signal: AbortSignal },
): Promise<SendEmailResponse> {
  // Job-level abort (cancel / deadline / executionTimeoutMs) plus a shorter
  // per-request timeout. AbortSignal.any requires Node 20.3+.
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

  let response: Response;
  try {
    response = await fetch(`${PROVIDER_URL}/v1/messages`, {
      method: "POST",
      signal: requestSignal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${PROVIDER_API_KEY}`,
        // The half that Workhorse cannot close for you: only the system
        // performing the effect can dedupe the effect.
        "idempotency-key": request.idempotencyKey,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: request.to,
        subject: request.subject,
        html: request.html,
        text: request.text,
      }),
    });
  } catch (error) {
    // The job was cancelled / timed out: let the worker see the real reason.
    if (signal.aborted) throw signal.reason;
    throw new EmailProviderTransientError(
      "email provider request failed before a response",
      undefined,
      { cause: error },
    );
  }

  if (response.ok) {
    const body = (await response.json()) as { id?: string; replayed?: boolean };
    if (!body.id) {
      throw new EmailProviderTransientError(
        "email provider accepted the message but returned no id",
        response.status,
      );
    }
    return { messageId: body.id, replayed: body.replayed === true };
  }

  const detail = (await response.text()).slice(0, 500);

  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new EmailProviderTransientError(
      `email provider returned ${response.status}: ${detail}`,
      response.status,
    );
  }

  throw new EmailProviderPermanentError(
    `email provider rejected the message with ${response.status}: ${detail}`,
    response.status,
  );
}
```

---

### `src/jobs/order-confirmation.ts` — the handler

```ts
import type { Worker } from "@stablemates/workhorse";
import { EmailProviderPermanentError, sendTransactionalEmail } from "../email/provider.js";
import {
  ORDER_CONFIRMATION_JOB,
  confirmationIdempotencyKey,
  type OrderConfirmationPayload,
  type OrderConfirmationResult,
} from "../workhorse/contract.js";

function renderConfirmation(payload: OrderConfirmationPayload) {
  const total = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: payload.currency,
  }).format(payload.totalCents / 100);

  return {
    subject: `Your order ${payload.orderNumber} is confirmed`,
    text:
      `Hi ${payload.customerName},\n\n` +
      `Thanks for your order ${payload.orderNumber}, placed ${payload.placedAt}.\n` +
      `Order total: ${total}.\n`,
    html:
      `<p>Hi ${payload.customerName},</p>` +
      `<p>Thanks for your order <strong>${payload.orderNumber}</strong>.</p>` +
      `<p>Order total: <strong>${total}</strong></p>`,
  };
}

/**
 * Registers the confirmation-email handler on a worker.
 *
 * Handlers restart from the top after a retry, a crash, or a recovered lease,
 * so the single external effect lives inside one named checkpoint. On a second
 * activation the checkpoint replays its stored value and the provider is never
 * called again. The provider idempotency key covers the remaining gap: a crash
 * landing after the HTTP call but before the checkpoint commit.
 */
export function registerOrderConfirmationHandler(worker: Worker): void {
  worker.handle(ORDER_CONFIRMATION_JOB, async (payload: OrderConfirmationPayload, ctx) => {
    // Cheap cooperative check before starting an external effect: covers
    // queue.cancel(), the job deadline, and executionTimeoutMs at once.
    if (ctx.signal.aborted) throw ctx.signal.reason;

    const delivery = await ctx.checkpoint("provider-send", async () => {
      const message = renderConfirmation(payload);

      const sent = await sendTransactionalEmail(
        {
          to: payload.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          idempotencyKey: confirmationIdempotencyKey(payload.orderId),
        },
        { signal: ctx.signal },
      );

      // Keep the checkpoint value small: checkpoint values are size-capped,
      // and this is the evidence an operator actually wants.
      return {
        messageId: sent.messageId,
        replayed: sent.replayed,
        sentAt: new Date().toISOString(),
      };
    });

    const result: OrderConfirmationResult = {
      orderId: payload.orderId,
      to: payload.to,
      messageId: delivery.messageId,
      replayed: delivery.replayed,
    };
    return result;
  });
}

/**
 * Operational note on failures:
 *
 * - EmailProviderTransientError burns one attempt and backs off on the persisted
 *   decorrelated-jitter policy. PostgreSQL enforces the attempt budget, so this
 *   cannot loop forever.
 * - EmailProviderPermanentError (a rejected address, say) also consumes the
 *   budget and then lands in the dead-letter relation with its error name and
 *   attempts intact — filter it with
 *   admin.listDeadLetters({ queue: "mail", errorName: "EmailProviderPermanentError" })
 *   and use admin.redrive(...) once the underlying problem is fixed.
 */
export { EmailProviderPermanentError };
```

---

### `src/workhorse.worker.ts` — the worker process

```ts
import { createWorkhorseAdapter, defineWorkerProcess, Pool } from "@stablemates/workhorse";
import { registerOrderConfirmationHandler } from "./jobs/order-confirmation.js";
import { MAIL_QUEUE } from "./workhorse/contract.js";

/**
 * Run with:  workhorse worker --config ./dist/workhorse.worker.js
 *
 * The CLI imports compiled JavaScript — it bundles no TypeScript loader — and
 * adds signal handling, bounded drain and supervision around this definition.
 */
export default defineWorkerProcess({
  // This process owns its own pool; the adapter closes it after the last drain.
  adapter() {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (transaction: typeof pool) => transaction,
      close: () => pool.end(),
    });
  },

  workers: [
    {
      options: {
        queue: MAIL_QUEUE,
        concurrency: 8,
        // Shorter lease => faster recovery of a killed worker's jobs; the
        // handler is checkpointed and idempotent, so recovery is cheap.
        leaseMs: 30_000,
      },
      configure(worker) {
        registerOrderConfirmationHandler(worker);
      },
    },
  ],

  // Keep this under your platform's termination window. First SIGTERM stops
  // claiming and lets active handlers finish; anything left over is recovered
  // in PostgreSQL by ordinary fenced recovery.
  shutdownTimeoutMs: 25_000,

  // /livez and /readyz for your orchestrator. Not application ingress.
  probes: { hostname: "0.0.0.0", port: 9090 },
});
```

---

### `scripts/sync-workhorse-policies.ts` — deploy step: fleet-wide provider rate limit

```ts
import { Pool, Queue } from "@stablemates/workhorse";
import { MAIL_QUEUE } from "../src/workhorse/contract.js";

/**
 * Run once per deploy. Rate limits are desired state owned by PostgreSQL, so
 * every worker replica draws from the same token bucket — concurrency alone
 * cannot bound "60 calls per minute" when each call takes 100ms.
 *
 * Tokens are spent on job STARTS and never refunded, so size the limit for
 * attempts (retries included), not for orders.
 */
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const queue = new Queue(pool);
  try {
    await queue.syncRateLimitPolicies("app-mail", [
      {
        queue: MAIL_QUEUE,
        rate: { limit: 60, intervalMs: 60_000, burst: 10 },
      },
    ]);
  } finally {
    await pool.end();
  }
}

await main();
```

---

### `package.json` (relevant parts — the SDK needs an ESM application)

```json
{
  "name": "orders-app",
  "type": "module",
  "engines": { "node": ">=20.3" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "schema:install": "workhorse schema install",
    "schema:migrate": "workhorse schema migrate",
    "schema:status": "workhorse schema status --json",
    "policies:sync": "node ./dist/scripts/sync-workhorse-policies.js",
    "worker": "workhorse worker --config ./dist/workhorse.worker.js"
  },
  "dependencies": {
    "@stablemates/workhorse": "^0.1.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

### Deploy order (not installs — commands your pipeline runs, in this order)

```
npm run build
npm exec --no -- workhorse schema migrate     # or schema:install on a clean database
npm exec --no -- workhorse schema status --json   # gate the deploy on exit code 0
npm run policies:sync
# then roll web replicas and worker replicas (npm run worker)
```

Required environment: `DATABASE_URL`, `EMAIL_PROVIDER_URL`, `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM`.

---

install

```
npm install @stablemates/workhorse
npm install --save-dev typescript @types/node
npm exec --no -- workhorse schema install
```
