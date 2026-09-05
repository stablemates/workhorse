I have what I need — 13 fetches, all reached by following links from the README. Here's the integration.

## What the docs pinned down

- **Transactional enqueue replaces an outbox**: `enqueue(type, payload, options, transaction)` takes the open client as its **fourth** argument, so the order row and the job share one commit ([enqueue](https://workhorse.run/docs/enqueue.md)).
- **Handlers are at-least-once.** The [limitations](https://workhorse.run/docs/limitations.md) page is blunt: PostgreSQL cannot commit an HTTP call with job completion. The prescribed remedy is _both_ a named `checkpoint` **and** a provider idempotency key — the checkpoint makes repeats rare, the provider key makes them harmless.
- **Schema installs from deployment, never at startup** — one of the three named mistakes. Runtimes call `assertSchemaCompatible` instead.
- **Decorrelated jitter** is the documented policy for anything talking to an external service.
- **`sensitivePayloadKeys`** keeps the recipient's address out of dashboards and dead-letter views while the handler still receives it raw.

---

## `src/jobs/contracts.ts` — one contract, shared by producer and worker

```ts
import type { JobTypeContracts } from "@stablemates/workhorse";

export const CONFIRMATION_EMAIL_JOB = "email.order-confirmation" as const;
export const EMAIL_QUEUE = "email" as const;

/** Checkpoint names are durable control flow. Renaming this re-sends live jobs. */
export const SEND_CHECKPOINT = "provider-send" as const;

export interface ConfirmationEmailPayload {
  orderId: string;
  recipientEmail: string;
  customerName: string;
  totalCents: number;
  currency: string;
}

export const contracts: Record<string, JobTypeContracts> = {
  [CONFIRMATION_EMAIL_JOB]: {
    currentVersion: "v1",
    versions: {
      v1: {
        payloadSchema: {
          type: "object",
          required: ["orderId", "recipientEmail", "customerName", "totalCents", "currency"],
          properties: {
            orderId: { type: "string" },
            recipientEmail: { type: "string" },
            customerName: { type: "string" },
            totalCents: { type: "integer" },
            currency: { type: "string" },
          },
        },
        resultSchema: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string" },
            providerMessageId: { type: "string" },
            reason: { type: "string" },
          },
        },
        // Top-level keys stripped from getJob, listJobs, dead letters, and the dashboard.
        // The claimed handler still receives them raw, because it needs them to send.
        sensitivePayloadKeys: ["recipientEmail", "customerName"],
      },
    },
  },
};
```

## `src/jobs/email-provider.ts` — the HTTP client

```ts
/** Retry is worth attempting: timeout, 429, or 5xx. */
export class EmailProviderRetryableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmailProviderRetryableError";
  }
}

/** Retrying cannot help: malformed address, suppressed recipient, bad credentials. */
export class EmailProviderPermanentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EmailProviderPermanentError";
  }
}

export interface SendResult {
  providerMessageId: string;
}

const PROVIDER_URL = process.env.EMAIL_PROVIDER_URL ?? "https://api.example-mail.com/v1/messages";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * `idempotencyKey` is the load-bearing argument. The job may run twice (crash between
 * the send and the checkpoint commit), and this is what makes the second send harmless.
 */
export async function sendConfirmationEmail(
  input: {
    idempotencyKey: string;
    to: string;
    customerName: string;
    orderId: string;
    totalCents: number;
    currency: string;
  },
  options: { signal: AbortSignal },
): Promise<SendResult> {
  // The job's signal aborts on cancellation, deadline, or executionTimeoutMs.
  // The per-request timer bounds one HTTP call inside that larger budget.
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

  let response: Response;
  try {
    response = await fetch(PROVIDER_URL, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.EMAIL_PROVIDER_API_KEY}`,
        "idempotency-key": input.idempotencyKey,
      },
      body: JSON.stringify({
        to: input.to,
        template: "order-confirmation",
        variables: {
          customerName: input.customerName,
          orderId: input.orderId,
          total: (input.totalCents / 100).toFixed(2),
          currency: input.currency,
        },
      }),
    });
  } catch (error) {
    // A job-level abort must propagate untouched so Workhorse records the real reason.
    if (options.signal.aborted) throw error;
    throw new EmailProviderRetryableError(`email provider unreachable: ${String(error)}`);
  }

  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new EmailProviderRetryableError(
      `email provider returned ${response.status}`,
      response.status,
    );
  }
  if (!response.ok) {
    throw new EmailProviderPermanentError(
      `email provider rejected the message with ${response.status}`,
      response.status,
    );
  }

  const body = (await response.json()) as { id?: string };
  if (!body.id) throw new EmailProviderRetryableError("email provider returned no message id");

  // Checkpoint values are size-capped, so store the identifier, not the whole response.
  return { providerMessageId: body.id };
}
```

## `src/jobs/send-confirmation-email.ts` — the handler

```ts
import type { HandlerContext } from "@stablemates/workhorse";
import { SEND_CHECKPOINT, type ConfirmationEmailPayload } from "./contracts.js";
import {
  EmailProviderPermanentError,
  sendConfirmationEmail,
  type SendResult,
} from "./email-provider.js";

export async function handleConfirmationEmail(
  payload: ConfirmationEmailPayload,
  context: HandlerContext,
) {
  try {
    // First activation performs the send and persists the receipt.
    // Every later activation replays the stored value without calling the provider.
    const sent = (await context.checkpoint(SEND_CHECKPOINT, () =>
      sendConfirmationEmail(
        {
          // Stable across every attempt of this order, so a duplicate POST collapses
          // at the provider even if we die before the checkpoint commits.
          idempotencyKey: `order-confirmation:${payload.orderId}`,
          to: payload.recipientEmail,
          customerName: payload.customerName,
          orderId: payload.orderId,
          totalCents: payload.totalCents,
          currency: payload.currency,
        },
        { signal: context.signal },
      ),
    )) as SendResult;

    return { status: "sent", providerMessageId: sent.providerMessageId };
  } catch (error) {
    if (error instanceof EmailProviderPermanentError) {
      // Deliberate: settle instead of throwing. Workhorse has no "fail without retry"
      // primitive, so throwing here would burn the whole attempt budget on a provider
      // that already told us the message is unsendable. The outcome stays durable
      // evidence, readable through Admin.getJob.
      console.error("confirmation email permanently rejected", {
        orderId: payload.orderId,
        status: error.status,
      });
      return { status: "rejected", reason: `provider_${error.status}` };
    }
    throw error; // Retryable and unknown errors spend an attempt and back off.
  }
}
```

## `src/queue/workhorse.ts` — producer wiring

```ts
import { Admin, Pool, Queue, assertSchemaCompatible } from "@stablemates/workhorse";
import { contracts } from "../jobs/contracts.js";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const queue = new Queue(pool, "default", { contracts });
export const admin = new Admin(pool);

/** Call once during API startup, before serving traffic. */
export async function startWorkhorse(): Promise<void> {
  // Verify the schema; never install it from a runtime process.
  await assertSchemaCompatible(pool);
  await queue.syncContracts();
}
```

## `src/orders/create-order.ts` — the enqueue, alongside the existing write

```ts
import { EMAIL_QUEUE, CONFIRMATION_EMAIL_JOB } from "../jobs/contracts.js";
import { pool, queue } from "../queue/workhorse.js";

export interface NewOrder {
  id: string;
  customerEmail: string;
  customerName: string;
  totalCents: number;
  currency: string;
  items: string[];
}

export async function createOrder(order: NewOrder): Promise<{ orderId: string; jobId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO orders (id, customer_email, total_cents, currency, items, status)
       VALUES ($1, $2, $3, $4, $5, 'new')`,
      [order.id, order.customerEmail, order.totalCents, order.currency, order.items],
    );

    // The fourth argument is the whole point: this job commits with the order row,
    // or rolls back with it. There is no window where one exists without the other.
    const jobId = await queue.enqueue(
      CONFIRMATION_EMAIL_JOB,
      {
        orderId: order.id,
        recipientEmail: order.customerEmail,
        customerName: order.customerName,
        totalCents: order.totalCents,
        currency: order.currency,
      },
      {
        queue: EMAIL_QUEUE,
        maxAttempts: 6,
        // Documented preference for external services: jitter spreads the retry wave
        // so a recovering provider is not knocked over again.
        retryPolicy: { type: "decorrelated-jitter", baseDelayMs: 2_000, maxDelayMs: 300_000 },
        executionTimeoutMs: 60_000,
        // A retried API call reusing this order id converges on the original job.
        // An identical replay returns the same job id; a materially different payload
        // under the same key throws EnqueueIdempotencyConflictError.
        idempotency: { key: `order-confirmation:${order.id}`, scope: "orders" },
        tags: [`order:${order.id}`],
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

## `src/workhorse.worker.ts` — the worker process

```ts
import {
  Pool,
  assertSchemaCompatible,
  createWorkhorseAdapter,
  defineWorkerProcess,
} from "@stablemates/workhorse";
import { CONFIRMATION_EMAIL_JOB, EMAIL_QUEUE, contracts } from "./jobs/contracts.js";
import { handleConfirmationEmail } from "./jobs/send-confirmation-email.js";

export default defineWorkerProcess({
  adapter() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

    // Verify, never install. A refusal throws SchemaCompatibilityError and the
    // process exits before claiming any job.
    void assertSchemaCompatible(pool);

    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (transaction: typeof pool) => transaction,
      close: () => pool.end(),
      // The worker validates handler results against the same versioned documents.
      queueOptions: { contracts },
    });
  },
  workers: [
    {
      options: { queues: [EMAIL_QUEUE], concurrency: 8, leaseMs: 60_000 },
      configure(worker) {
        worker.handle(CONFIRMATION_EMAIL_JOB, handleConfirmationEmail);
      },
    },
  ],
  // Keep this below your platform's termination window.
  shutdownTimeoutMs: 25_000,
  probes: { hostname: "0.0.0.0", port: 9090 },
});
```

Run it against **compiled** output — the CLI bundles no TypeScript loader:

```bash
workhorse worker --config ./dist/workhorse.worker.js
```

`/livez` and `/readyz` are served on port 9090; readiness drops the moment drain begins, so a rolling deploy stops routing to a process on its way out.

## `package.json` — ESM, Node 22 or 24

```json
{
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "deploy:schema": "workhorse schema migrate && workhorse schema status --json",
    "worker": "workhorse worker --config ./dist/workhorse.worker.js"
  },
  "dependencies": { "@stablemates/workhorse": "^0.1.0" }
}
```

---

### Two things to know before this goes load-bearing

**A permanent provider rejection settles the job as `rejected` rather than failing it.** Workhorse exposes no documented "fail without retry" primitive — the attempt budget is enforced in SQL and no client config can shortcut it. Throwing on a 422 would mean six pointless POSTs across ten minutes for an address the provider already refused. If you'd rather have these surface in `Admin.listDeadLetters` for operator triage, rethrow instead and accept the wasted attempts.

**Workhorse is 0.x public beta.** A minor release may change behaviour, so read the changelog before upgrading. Migrations are ordered and additive within a major line, so a running deployment upgrades in place — it will not ask you to recreate the database.

For an existing database, `schema install` refuses anything already versioned; run `workhorse schema migrate` from your deploy step instead, then gate the rollout on `workhorse schema status --json` exiting 0.

```install
npm install @stablemates/workhorse
npm exec --no -- workhorse schema install
```
