I read the docs. Here is the complete integration.

## What I read

`llms.txt` → `for-ai-agents`, `installation`, `enqueue`, `workers`, `durable-execution`, `worker-processes`, `retries`, `contracts`, `api`, `idempotency`, `rate-limits`, `examples` (12 fetches).

The shape it prescribes: enqueue inside your existing transaction (this replaces an outbox), wrap the external send in `HandlerContext.checkpoint`, still pass a provider idempotency key (a crash can land between the send and the checkpoint commit), install the schema from deployment and only _assert_ it at runtime, and run the worker as its own process.

---

## Code

### `src/jobs/contracts.ts` — payload/result contract for the job type

```ts
import type { JobTypeContracts } from "@stablemates/workhorse";

export const ORDER_CONFIRMATION_EMAIL = "order.confirmation-email" as const;

/** The queue this work is claimed from. Workers claim per-queue. */
export const EMAIL_QUEUE = "email" as const;

export type OrderConfirmationEmailPayload = {
  orderId: string;
  customerId: string;
  /** Recipient address. Declared sensitive: operators never see it. */
  to: string;
  locale: string;
  totalCents: number;
  currency: string;
};

export const contracts: Record<string, JobTypeContracts> = {
  [ORDER_CONFIRMATION_EMAIL]: {
    currentVersion: "v1",
    versions: {
      v1: {
        payloadSchema: {
          type: "object",
          required: ["orderId", "customerId", "to", "locale", "totalCents", "currency"],
          properties: {
            orderId: { type: "string" },
            customerId: { type: "string" },
            to: { type: "string" },
            locale: { type: "string" },
            totalCents: { type: "integer" },
            currency: { type: "string" },
          },
          additionalProperties: false,
        },
        resultSchema: { type: "object" },
        // Top-level keys stripped from job lookup, listing, dead letters and the dashboard.
        sensitivePayloadKeys: ["to"],
      },
    },
  },
};
```

### `src/workhorse/client.ts` — pool, queue, startup check (web/API tier)

```ts
import { Admin, Pool, Queue, assertSchemaCompatible } from "@stablemates/workhorse";
import { contracts } from "../jobs/contracts.js";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Verify, never install. Installation is a deployment step (see install commands).
// Throws SchemaCompatibilityError, whose `code` names the reason.
await assertSchemaCompatible(pool);

export const queue = new Queue(pool, "default", { contracts });
export const admin = new Admin(pool);

// Publish the versioned contract documents at application startup.
await queue.syncContracts();
```

### `src/orders/create-order.ts` — the existing order write, now carrying the job

```ts
import { pool, queue } from "../workhorse/client.js";
import {
  EMAIL_QUEUE,
  ORDER_CONFIRMATION_EMAIL,
  type OrderConfirmationEmailPayload,
} from "../jobs/contracts.js";

export type NewOrder = {
  id: string;
  customerId: string;
  customerEmail: string;
  locale: string;
  totalCents: number;
  currency: string;
};

/**
 * Inserts the order and accepts the confirmation-email job in ONE transaction.
 * If the insert fails there is no job; if the enqueue fails there is no order.
 */
export async function createOrder(order: NewOrder): Promise<{ orderId: string; jobId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO orders (id, customer_id, total_cents, currency, status)
       VALUES ($1, $2, $3, $4, 'new')`,
      [order.id, order.customerId, order.totalCents, order.currency],
    );

    const payload: OrderConfirmationEmailPayload = {
      orderId: order.id,
      customerId: order.customerId,
      to: order.customerEmail,
      locale: order.locale,
      totalCents: order.totalCents,
      currency: order.currency,
    };

    // The 4th argument is the open transaction — this is what replaces an outbox.
    const jobId = await queue.enqueue(
      ORDER_CONFIRMATION_EMAIL,
      payload,
      {
        queue: EMAIL_QUEUE,
        // A retried API call / double-clicked "Place order" converges on one job.
        idempotency: {
          key: `order-confirmation:${order.id}`,
          scope: "order-confirmation-email",
        },
        // Per-key rate limiting + fair sharing across customers.
        concurrencyKey: order.customerId,
        tags: [`order:${order.id}`],
        maxAttempts: 8,
        // Jitter, because this talks to an external service: a provider outage
        // that fails a thousand jobs must not produce a synchronized retry wave.
        retryPolicy: { type: "decorrelated-jitter", baseDelayMs: 1_000, maxDelayMs: 60_000 },
        executionTimeoutMs: 30_000,
        // A confirmation email is worthless a day later; stop trying then.
        deadline: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      },
      client,
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

### `src/email/provider.ts` — the external HTTP provider client

```ts
export class RetryableProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RetryableProviderError";
  }
}

export type ProviderSendResult =
  | { delivered: true; messageId: string; status: number }
  | { delivered: false; status: number; reason: string };

const endpoint = process.env.EMAIL_PROVIDER_URL ?? "https://api.email-provider.example/v1/messages";

export async function sendTransactionalEmail(input: {
  to: string;
  template: string;
  locale: string;
  variables: Record<string, unknown>;
  /**
   * The provider's own idempotency key. This is the half a checkpoint cannot
   * close: a crash between the HTTP send and the checkpoint commit replays the
   * send, and only the provider can make that replay harmless.
   */
  idempotencyKey: string;
  signal: AbortSignal;
}): Promise<ProviderSendResult> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.EMAIL_PROVIDER_API_KEY}`,
        "idempotency-key": input.idempotencyKey,
      },
      body: JSON.stringify({
        to: input.to,
        template: input.template,
        locale: input.locale,
        variables: input.variables,
      }),
      signal: input.signal,
    });
  } catch (cause) {
    // Network failure, execution timeout, or cancellation. Aborts rethrow as-is
    // so Workhorse records the real cause; everything else is worth retrying.
    if (input.signal.aborted) throw input.signal.reason ?? cause;
    throw new RetryableProviderError(`email provider unreachable: ${String(cause)}`);
  }

  if (response.ok) {
    const body = (await response.json()) as { id?: string; messageId?: string };
    return {
      delivered: true,
      messageId: body.messageId ?? body.id ?? "unknown",
      status: response.status,
    };
  }

  const detail = (await response.text()).slice(0, 500);

  // 5xx, 429 and 408 are transient: throw, and the persisted jitter policy
  // decides when the next attempt starts.
  if (response.status >= 500 || response.status === 429 || response.status === 408) {
    throw new RetryableProviderError(
      `email provider ${response.status}: ${detail}`,
      response.status,
    );
  }

  // Any other 4xx is the request itself being wrong — a suppressed address, an
  // invalid template. Retrying cannot fix it, so record it as a durable outcome
  // instead of burning eight attempts to reach the same answer.
  return { delivered: false, status: response.status, reason: detail };
}
```

### `src/jobs/order-confirmation-email.ts` — the handler

```ts
import type { HandlerContext } from "@stablemates/workhorse";
import { sendTransactionalEmail } from "../email/provider.js";
import type { OrderConfirmationEmailPayload } from "./contracts.js";

export async function sendOrderConfirmationEmail(
  payload: OrderConfirmationEmailPayload,
  context: HandlerContext,
) {
  // The send runs once. A retry, a crash, or a lease recovery replays the
  // recorded provider response instead of calling the provider again.
  const outcome = await context.checkpoint("provider-send", () =>
    sendTransactionalEmail({
      to: payload.to,
      template: "order-confirmation",
      locale: payload.locale,
      variables: {
        orderId: payload.orderId,
        totalCents: payload.totalCents,
        currency: payload.currency,
      },
      // Stable domain value — the same across every attempt of this job.
      idempotencyKey: `order-confirmation:${payload.orderId}`,
      signal: context.signal,
    }),
  );

  if (!outcome.delivered) {
    return {
      orderId: payload.orderId,
      delivered: false as const,
      providerStatus: outcome.status,
      reason: outcome.reason,
    };
  }

  return {
    orderId: payload.orderId,
    delivered: true as const,
    messageId: outcome.messageId,
    providerStatus: outcome.status,
  };
}
```

### `src/workhorse.worker.ts` — the worker process (compiled, then run by the CLI)

```ts
import {
  Pool,
  assertSchemaCompatible,
  createWorkhorseAdapter,
  defineWorkerProcess,
} from "@stablemates/workhorse";
import { contracts, EMAIL_QUEUE, ORDER_CONFIRMATION_EMAIL } from "./jobs/contracts.js";
import { sendOrderConfirmationEmail } from "./jobs/order-confirmation-email.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// Verify the installed schema before this process claims anything.
await assertSchemaCompatible(pool);

export default defineWorkerProcess({
  adapter() {
    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (transaction: typeof pool) => transaction,
      close: () => pool.end(),
      // Workers validate handler results against the same contract documents.
      queueOptions: { contracts },
    });
  },
  workers: [
    {
      options: { queues: [EMAIL_QUEUE], concurrency: 8 },
      configure(worker) {
        worker.handle(ORDER_CONFIRMATION_EMAIL, sendOrderConfirmationEmail);
      },
    },
  ],
  // Keep this under your platform's termination window.
  shutdownTimeoutMs: 25_000,
  probes: { hostname: "0.0.0.0", port: 9090 },
});
```

Run it (after `tsc`):

```bash
npm exec --no -- workhorse worker --config ./dist/workhorse.worker.js
```

`SIGTERM` drops readiness on `/readyz`, stops claiming, and drains active sends; anything past the deadline is recovered by another worker through lease expiry.

### `scripts/sync-policies.ts` — deployment step, run after migrate, before the new release starts

```ts
import { Pool, Queue } from "@stablemates/workhorse";
import { contracts, EMAIL_QUEUE } from "../src/jobs/contracts.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const queue = new Queue(pool, "default", { contracts });

await queue.syncContracts();

// The provider allows 60 calls/minute overall, and we cap any single customer
// at 5/minute. PostgreSQL owns the buckets, so every worker replica shares them.
await queue.syncRateLimitPolicies("workers", [
  {
    queue: EMAIL_QUEUE,
    rate: { limit: 60, intervalMs: 60_000, burst: 10 },
    perKey: { limit: 5, intervalMs: 60_000, burst: 2 },
  },
]);

await pool.end();
```

### `src/orders/confirmation-status.ts` — optional: confirm the job settled

```ts
import { admin } from "../workhorse/client.js";

export async function confirmationStatus(jobId: string) {
  const job = await admin.getJob(jobId);
  // Until it settles this reports the state it is in — which is how you tell a
  // slow worker from a missing one. The recipient address is redacted here.
  return { state: job?.state ?? "missing", result: job?.result ?? null };
}
```

---

## Notes on the choices

- **`concurrencyKey: customerId`** is what feeds the `perKey` rate-limit bucket; a keyless job would draw from the queue bucket only.
- **Tokens are never refunded** and every retry start spends one, so the 60/min limit is sized for attempts, not orders.
- **Checkpoint names are program state.** Renaming `provider-send` in a later deploy makes in-flight jobs send again.
- The handler is at-least-once by design — that's why both the checkpoint _and_ the provider `idempotency-key` are present. Neither alone is enough.
- `installSchema` is never called from application code; the deploy runs the CLI and gates on `schema status --json` (exit 1 = this build refuses the installed schema). For an existing database, substitute `workhorse schema migrate` for `schema install`; `state: "ahead"` is normal mid-rollout, not a failure.

```install
npm install @stablemates/workhorse
npm exec --no -- workhorse schema install
npm exec --no -- workhorse schema status --json
```
