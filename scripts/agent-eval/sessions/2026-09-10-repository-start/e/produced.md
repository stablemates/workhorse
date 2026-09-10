I read the library's own docs (its README pointed at `https://workhorse.run/llms.txt` → the agent page, enqueue, workers, durable execution, retries, contracts, idempotency, installation, worker processes) plus the shipped `.d.ts` files for exact signatures. Here is the complete code.

---

### `src/email-provider.ts` (new) — the external HTTP provider client

```ts
/**
 * Minimal client for the transactional email provider's HTTP API.
 *
 * Workhorse delivers jobs at least once, so every call carries a stable
 * `Idempotency-Key` derived from the order. The provider — not the queue — is the
 * only thing that can make a repeated send harmless.
 */

const PROVIDER_URL = process.env.EMAIL_PROVIDER_URL ?? "https://api.email-provider.example";
const REQUEST_TIMEOUT_MS = 10_000;

/** JSON-serializable receipt persisted as the handler's durable checkpoint value. */
export type ProviderReceipt = { messageId: string; acceptedAt: string };

/** The provider is unavailable or rate limited: another attempt may succeed. */
export class ProviderTransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderTransientError";
  }
}

/** The provider refused the message itself (bad address, blocked recipient). */
export class ProviderRejectedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderRejectedError";
    this.status = status;
  }
}

export interface SendConfirmationEmailInput {
  readonly to: string;
  readonly orderId: string;
  /** Stable provider-side deduplication key. Use a domain value, never a random one. */
  readonly idempotencyKey: string;
}

export async function sendConfirmationEmail(
  input: SendConfirmationEmailInput,
  /** The job's AbortSignal: cancellation, deadline, and execution timeout all abort it. */
  jobSignal: AbortSignal,
): Promise<ProviderReceipt> {
  const apiKey = process.env.EMAIL_PROVIDER_API_KEY;
  if (!apiKey) {
    throw new Error("EMAIL_PROVIDER_API_KEY is not configured");
  }

  const signal = AbortSignal.any([jobSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

  let response: Response;
  try {
    response = await fetch(`${PROVIDER_URL}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": input.idempotencyKey,
      },
      body: JSON.stringify({
        to: input.to,
        template: "order-confirmation",
        variables: { orderId: input.orderId },
      }),
    });
  } catch (cause) {
    // A job-level abort (cancel, deadline, execution timeout) must surface unchanged.
    if (jobSignal.aborted) throw cause;
    throw new ProviderTransientError("email provider request failed", { cause });
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new ProviderTransientError(
        `email provider responded ${response.status}: ${detail}`,
      );
    }
    // Permanent rejection. Workhorse has no "do not retry" signal, so this spends the
    // job's attempt budget and then lands in dead letters for an operator to inspect.
    throw new ProviderRejectedError(
      `email provider rejected the message with ${response.status}: ${detail}`,
      response.status,
    );
  }

  const body = (await response.json()) as { id?: string };
  if (!body.id) {
    throw new ProviderTransientError("email provider returned no message id");
  }
  return { messageId: body.id, acceptedAt: new Date().toISOString() };
}
```

---

### `src/jobs/order-confirmation-email.ts` (new) — job identity, payload contract types, handler

```ts
import type { Handler } from "@stablemates/workhorse";

import {
  sendConfirmationEmail,
  type ProviderReceipt,
} from "../email-provider.js";

/** Job type and queue names are durable identifiers: keep them stable across deploys. */
export const ORDER_CONFIRMATION_EMAIL = "order.confirmation-email";
export const EMAIL_QUEUE = "email";
export const ORDER_CONFIRMATION_EMAIL_CONTRACT_VERSION = "v1";

// Declared as type aliases, not interfaces, so they satisfy Workhorse's `Json` constraint.
export type OrderConfirmationEmailPayload = { orderId: string; email: string };
export type OrderConfirmationEmailResult = {
  orderId: string;
  messageId: string;
  acceptedAt: string;
};

/**
 * Handlers run at least once — a crashed worker's lease expires and the job is claimed
 * again. The send lives inside a named checkpoint so a replay reuses the recorded receipt
 * instead of sending twice, and the provider idempotency key closes the remaining window
 * between the send and the checkpoint commit.
 */
export const handleOrderConfirmationEmail: Handler<
  OrderConfirmationEmailPayload,
  OrderConfirmationEmailResult
> = async (payload, context) => {
  const receipt = await context.checkpoint<ProviderReceipt>("provider-send", () =>
    sendConfirmationEmail(
      {
        to: payload.email,
        orderId: payload.orderId,
        idempotencyKey: `order-confirmation:${payload.orderId}`,
      },
      context.signal,
    ),
  );

  return {
    orderId: payload.orderId,
    messageId: receipt.messageId,
    acceptedAt: receipt.acceptedAt,
  };
};
```

---

### `src/jobs/contracts.ts` (new) — payload/result contract shared by producer and worker

```ts
import type { JobTypeContracts } from "@stablemates/workhorse";

import {
  ORDER_CONFIRMATION_EMAIL,
  ORDER_CONFIRMATION_EMAIL_CONTRACT_VERSION,
} from "./order-confirmation-email.js";

/**
 * The producer validates payloads before the durable write; the worker validates the
 * handler's result before completion. `sensitivePayloadKeys` keeps the recipient address
 * out of job lookups, listings, dead letters, and the dashboard, while the claiming
 * handler still receives the raw payload.
 */
export const workhorseContracts: Record<string, JobTypeContracts> = {
  [ORDER_CONFIRMATION_EMAIL]: {
    currentVersion: ORDER_CONFIRMATION_EMAIL_CONTRACT_VERSION,
    versions: {
      [ORDER_CONFIRMATION_EMAIL_CONTRACT_VERSION]: {
        payloadSchema: {
          type: "object",
          required: ["orderId", "email"],
          properties: {
            orderId: { type: "string", minLength: 1 },
            email: { type: "string", minLength: 3 },
          },
          additionalProperties: false,
        },
        resultSchema: {
          type: "object",
          required: ["orderId", "messageId", "acceptedAt"],
        },
        sensitivePayloadKeys: ["email"],
      },
    },
  },
};
```

---

### `src/workhorse.ts` (new) — the producer-side queue and its startup check

```ts
import { assertSchemaCompatible, Queue } from "@stablemates/workhorse";

import { pool } from "./db.js";
import { workhorseContracts } from "./jobs/contracts.js";

/** Producer-side queue client. It reuses the application's existing pg pool. */
export const queue = new Queue(pool, "default", { contracts: workhorseContracts });

/**
 * Call once during application startup, before serving traffic.
 *
 * Runtime processes verify the schema; they never install or migrate it. Schema install
 * and migrate are deployment steps (see the install commands below).
 */
export async function initializeWorkhorse(): Promise<void> {
  await assertSchemaCompatible(pool);
  await queue.syncContracts();
}
```

---

### `src/orders.ts` (modified) — enqueue inside the transaction that writes the order

```ts
import { pool } from "./db.js";
import {
  EMAIL_QUEUE,
  ORDER_CONFIRMATION_EMAIL,
  type OrderConfirmationEmailPayload,
} from "./jobs/order-confirmation-email.js";
import { queue } from "./workhorse.js";

export interface NewOrder {
  readonly id: string;
  readonly email: string;
}

export interface CreatedOrder {
  readonly id: string;
  /** Durable id of the confirmation-email job committed with the order row. */
  readonly confirmationEmailJobId: string;
}

/**
 * Writes the order and its confirmation-email job in one transaction. Passing the
 * transaction client as the fourth argument to `enqueue` is what replaces an outbox:
 * the job and the row commit together, or neither exists.
 */
export async function createOrder(order: NewOrder): Promise<CreatedOrder> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      "INSERT INTO orders (id, email, status) VALUES ($1, $2, $3)",
      [order.id, order.email, "new"],
    );

    const payload: OrderConfirmationEmailPayload = {
      orderId: order.id,
      email: order.email,
    };

    const confirmationEmailJobId = await queue.enqueue<OrderConfirmationEmailPayload>(
      ORDER_CONFIRMATION_EMAIL,
      payload,
      {
        queue: EMAIL_QUEUE,
        maxAttempts: 5,
        // Decorrelated jitter for anything that talks to an external service: when many
        // jobs fail together, their retries do not arrive as one wave.
        retryPolicy: { type: "decorrelated-jitter", baseDelayMs: 1_000, maxDelayMs: 60_000 },
        executionTimeoutMs: 30_000,
        // A repeated "place order" request converges on the original job instead of
        // creating a second one.
        idempotency: { key: `confirmation:${order.id}`, scope: "order-confirmation" },
      },
      client,
    );

    await client.query("COMMIT");
    return { id: order.id, confirmationEmailJobId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

---

### `src/workhorse.worker.ts` (new) — the dedicated worker process

```ts
import {
  assertSchemaCompatible,
  createWorkhorseAdapter,
  defineWorkerProcess,
  Pool,
} from "@stablemates/workhorse";
import type { PoolClient } from "pg";

import { workhorseContracts } from "./jobs/contracts.js";
import {
  EMAIL_QUEUE,
  handleOrderConfirmationEmail,
  ORDER_CONFIRMATION_EMAIL,
  type OrderConfirmationEmailPayload,
  type OrderConfirmationEmailResult,
} from "./jobs/order-confirmation-email.js";

/**
 * Run with:  workhorse worker --config ./dist/workhorse.worker.js
 *
 * The CLI imports compiled JavaScript — it bundles no TypeScript loader — and adds
 * SIGTERM/SIGINT handling: the first signal stops claims and drains active handlers,
 * a second exits and leaves the remaining leases for PostgreSQL to recover.
 */
export default defineWorkerProcess<PoolClient>({
  async adapter() {
    // This process owns its own pool, closed after the last worker drains.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    await assertSchemaCompatible(pool);
    return createWorkhorseAdapter<PoolClient>({
      database: pool,
      adaptTransaction: (transaction) => transaction,
      defaultQueue: EMAIL_QUEUE,
      queueOptions: { contracts: workhorseContracts },
      close: () => pool.end(),
    });
  },
  workers: [
    {
      options: {
        queues: [EMAIL_QUEUE],
        concurrency: 8,
        leaseMs: 60_000,
      },
      configure(worker) {
        worker.handle<OrderConfirmationEmailPayload, OrderConfirmationEmailResult>(
          ORDER_CONFIRMATION_EMAIL,
          handleOrderConfirmationEmail,
        );
      },
    },
  ],
  shutdownTimeoutMs: 25_000,
  probes: { hostname: "0.0.0.0", port: 9090 },
});
```

---

### `package.json` (add the worker script)

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "worker": "workhorse worker --config ./dist/workhorse.worker.js"
  }
}
```

**Wiring notes**

- Call `initializeWorkhorse()` once at web-process startup (before serving traffic); it asserts schema compatibility and publishes the payload contract. Never install or migrate the schema from a running process.
- Environment: `DATABASE_URL` (already used), plus `EMAIL_PROVIDER_URL` and `EMAIL_PROVIDER_API_KEY` for the worker process.
- Deploy: `npm run build`, run the schema step below, then start the web tier and `npm run worker` (a separate replica set). On later upgrades the deployment step is `npm exec --no -- workhorse schema migrate` followed by `npm exec --no -- workhorse schema status --json`, which exits non-zero if this build would refuse the installed schema.
- A permanently rejected address exhausts the 5 attempts and becomes a dead letter; inspect and replay with `npm exec --no -- workhorse admin`.

```install
npm install
npm exec --no -- workhorse schema install
```
