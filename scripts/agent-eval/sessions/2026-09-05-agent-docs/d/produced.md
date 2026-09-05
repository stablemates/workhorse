I read the README, `llms.txt`, the agent guide, and the enqueue, workers, durable-execution, retries, worker-processes, installation, API, contracts, idempotency, examples, and rate-limits pages. Here is the complete integration.

## What this adds

Workhorse enqueues through **your existing transaction**, so the confirmation job and the order row commit or roll back together — no outbox table, no lost job. Delivery is at-least-once, so the send is wrapped in a `checkpoint` _and_ carries a provider idempotency key (the docs are explicit that a crash can land between the effect and the checkpoint commit — only the provider closes that last gap).

---

### 1. `src/workhorse/contracts.ts` — job type, payload shape, and PII redaction

```ts
/**
 * One place that owns the job type name, its payload/result shapes, and the
 * contract registry. Both the web tier (enqueue validation) and the worker
 * (result validation) must load the SAME registry.
 */

export const ORDER_CONFIRMATION_JOB = "order.confirmation.send";

/** Queue name. Workers claim per-queue, and the rate-limit policy is keyed by it. */
export const EMAIL_QUEUE = "emails";

export interface OrderConfirmationPayload {
  orderId: string;
  /** Recipient address. Declared sensitive below so operator views never show it. */
  email: string;
  total: number;
  currency: string;
}

export interface OrderConfirmationResult {
  orderId: string;
  providerMessageId: string;
  sentAt: string;
}

/**
 * Contracts are versioned because jobs outlive deployments: a job stores the
 * version selected when PostgreSQL accepted it, and a worker finishing an old
 * job loads that old document. To change the shape, ADD a version, move
 * `currentVersion` to it, and keep the old one configured until no live or
 * redrivable job can still carry it.
 *
 * `sensitivePayloadKeys` names top-level fields that PostgreSQL strips from job
 * lookup, listing, dead letters, and the dashboard — the handler still receives
 * the raw value, because it needs the address to do its work. It also scrubs
 * those fields out of handler error details before tracing or persistence.
 */
export const workhorseContracts = {
  [ORDER_CONFIRMATION_JOB]: {
    currentVersion: "v1",
    versions: {
      v1: {
        payloadSchema: {
          type: "object",
          required: ["orderId", "email", "total", "currency"],
          properties: {
            orderId: { type: "string" },
            email: { type: "string" },
            total: { type: "number" },
            currency: { type: "string" },
          },
        },
        resultSchema: {
          type: "object",
          required: ["orderId", "providerMessageId"],
          properties: {
            orderId: { type: "string" },
            providerMessageId: { type: "string" },
            sentAt: { type: "string" },
          },
        },
        sensitivePayloadKeys: ["email"],
      },
    },
  },
};
```

---

### 2. `src/workhorse/client.ts` — the producer side, wired into the app you already have

```ts
import { Admin, Pool, Queue, assertSchemaCompatible } from "@stablemates/workhorse";
import { EMAIL_QUEUE, workhorseContracts } from "./contracts.js";

/**
 * If your app already owns a `pg` Pool, delete this and import that one instead —
 * Workhorse takes any `Queryable` and never closes a connection you supply.
 * Use the Pool re-exported by the package so there is exactly one `pg` in play.
 */
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Third constructor argument carries the contract registry. */
export const queue = new Queue(pool, EMAIL_QUEUE, { contracts: workhorseContracts });
export const admin = new Admin(pool, EMAIL_QUEUE, { contracts: workhorseContracts });

/**
 * Call once while the web process boots, before it serves traffic.
 *
 * `assertSchemaCompatible` VERIFIES — it never creates anything. Installing the
 * schema on the runtime path is one of the documented mistakes: every replica
 * races to install and version skew becomes a startup failure under load
 * instead of a deployment failure. The schema is installed by a deploy step.
 */
export async function startWorkhorse(): Promise<void> {
  await assertSchemaCompatible(pool); // throws SchemaCompatibilityError; `.code` names the reason
  await queue.syncContracts();
}
```

---

### 3. `src/orders/create-order.ts` — the enqueue, inside the order transaction

```ts
import { EnqueueIdempotencyConflictError } from "@stablemates/workhorse";
import { pool, queue } from "../workhorse/client.js";
import { ORDER_CONFIRMATION_JOB, type OrderConfirmationPayload } from "../workhorse/contracts.js";

export interface NewOrder {
  id: string;
  email: string;
  total: number;
  currency: string;
  items: string[];
}

/**
 * The order row and the confirmation job share ONE commit. Passing the open
 * transaction client as the fourth argument to `enqueue` is what replaces an
 * outbox: if the insert fails no job exists, and if the enqueue fails no order
 * exists. There is no window where one is visible without the other.
 */
export async function createOrder(order: NewOrder): Promise<{ orderId: string; jobId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── your existing order write, unchanged ────────────────────────────────
    await client.query(
      "INSERT INTO orders (id, email, total, currency, items, status) VALUES ($1, $2, $3, $4, $5, $6)",
      [order.id, order.email, order.total, order.currency, order.items, "new"],
    );

    // ── the new background job, enqueued on the SAME client ─────────────────
    const payload: OrderConfirmationPayload = {
      orderId: order.id,
      email: order.email,
      total: order.total,
      currency: order.currency,
    };

    const jobId = await queue.enqueue(
      ORDER_CONFIRMATION_JOB,
      payload,
      {
        // Attempt budget. Enforced in SQL, so no client config can create extras.
        maxAttempts: 5,

        // Decorrelated jitter is the documented choice for anything talking to
        // an external service: when a thousand jobs fail together, jitter
        // spreads their wake times so the retry wave cannot re-topple a
        // recovering provider. One policy covers BOTH failure paths — a thrown
        // error and a crashed worker's expired lease.
        retryPolicy: { type: "decorrelated-jitter", baseDelayMs: 1_000, maxDelayMs: 60_000 },

        // Bounds ONE attempt's execution. Aborts `context.signal` when it trips.
        executionTimeoutMs: 30_000,

        // A double-clicked "Place order" produces one job, not two emails.
        // Repeated acceptance returns the original job ID and writes nothing.
        // Build the key from the business operation — never a timestamp or a
        // random value, which cannot identify a replay. Your raw key is stored
        // only as a hash, so internal IDs never reach an operator's screen.
        idempotency: { key: `confirmation:${order.id}`, scope: "order-emails" },
      },
      client, // ← the transaction. Everything above is worthless without it.
    );

    await client.query("COMMIT");
    return { orderId: order.id, jobId };
  } catch (error) {
    await client.query("ROLLBACK");
    // Same key reused with materially different work is a bug, not a duplicate:
    // PostgreSQL refuses rather than letting either request silently win.
    if (error instanceof EnqueueIdempotencyConflictError) {
      throw new Error(`Order ${order.id} was already accepted with a different payload`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    client.release();
  }
}
```

> Using Drizzle, Prisma, TypeORM, or Kysely? The fourth argument accepts anything with a pg-compatible `query` method; those packages expose their transaction handle through their own `forTransaction` boundary and give the identical guarantee. That needs one extra package (e.g. `@stablemates/workhorse-drizzle`), not listed below since the plain `pg` path is assumed.

---

### 4. `src/email/provider.ts` — the external HTTP call

```ts
/**
 * The provider client. Nothing Workhorse-specific lives here except the
 * idempotency key it accepts — keep it that way so it stays testable.
 */

/** Transient: worth another attempt. */
export class EmailProviderRetryableError extends Error {
  override name = "EmailProviderRetryableError";
}

/** Permanent (malformed address, rejected content): retrying cannot help. */
export class EmailProviderPermanentError extends Error {
  override name = "EmailProviderPermanentError";
}

export interface SendConfirmationInput {
  to: string;
  orderId: string;
  total: number;
  currency: string;
  /** Sent to the provider so a repeat of the SAME send is deduplicated there. */
  idempotencyKey: string;
  /** The handler's AbortSignal — aborts on cancellation, deadline, or timeout. */
  signal: AbortSignal;
}

export async function sendConfirmationEmail(
  input: SendConfirmationInput,
): Promise<{ providerMessageId: string; sentAt: string }> {
  // Bound this individual HTTP call, but still honour the job-level signal.
  const timeout = AbortSignal.timeout(15_000);
  const signal = AbortSignal.any([input.signal, timeout]);

  let response: Response;
  try {
    response = await fetch(`${process.env.EMAIL_PROVIDER_URL}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.EMAIL_PROVIDER_API_KEY}`,
        // The provider-side guarantee. This is the half a checkpoint cannot cover.
        "idempotency-key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: input.to,
        template: "order-confirmation",
        variables: {
          orderId: input.orderId,
          total: input.total,
          currency: input.currency,
        },
      }),
    });
  } catch (cause) {
    // Job cancellation / deadline / execution timeout: let it propagate so the
    // queue records the real reason instead of a provider error.
    if (input.signal.aborted) throw input.signal.reason;
    throw new EmailProviderRetryableError(`Email provider unreachable: ${String(cause)}`, {
      cause,
    });
  }

  if (response.status === 429 || response.status >= 500) {
    throw new EmailProviderRetryableError(`Email provider returned ${response.status}`);
  }
  if (!response.ok) {
    throw new EmailProviderPermanentError(
      `Email provider rejected order ${input.orderId} with ${response.status}`,
    );
  }

  const body = (await response.json()) as { id: string };
  return { providerMessageId: body.id, sentAt: new Date().toISOString() };
}
```

---

### 5. `src/jobs/send-order-confirmation.ts` — the handler

```ts
import { sendConfirmationEmail } from "../email/provider.js";
import type { OrderConfirmationPayload, OrderConfirmationResult } from "../workhorse/contracts.js";

/**
 * Structural view of the HandlerContext the worker passes in — the members this
 * handler actually uses. Swap in the SDK's exported context type if you prefer.
 */
type JobContext = {
  job: { id: string; attempt: number };
  signal: AbortSignal;
  checkpoint<T>(name: string, operation: () => Promise<T> | T): Promise<T>;
};

/**
 * A handler restarts FROM THE TOP after any retry, crash, or durable wait —
 * there is no saved JavaScript stack to resume. Two layers keep one email one
 * email:
 *
 *  1. `checkpoint` persists the send's result under a name. A later activation
 *     replays the stored value instead of calling the provider again.
 *  2. The provider idempotency key covers the honest gap: a checkpoint commits
 *     AFTER its operation finishes, so a process that dies in between runs the
 *     send once more. The checkpoint makes repeats rare; the key makes them
 *     harmless.
 *
 * The checkpoint name is durable control flow. Renaming "provider-send" in a
 * later deploy creates a DIFFERENT boundary, and in-flight jobs will re-send.
 */
export async function sendOrderConfirmation(
  payload: OrderConfirmationPayload,
  context: JobContext,
): Promise<OrderConfirmationResult> {
  const receipt = await context.checkpoint("provider-send", () =>
    sendConfirmationEmail({
      to: payload.email,
      orderId: payload.orderId,
      total: payload.total,
      currency: payload.currency,
      // Stable across every attempt of this order — that is the whole point.
      // Derive it from the domain ID, never from the attempt number.
      idempotencyKey: `order-confirmation:${payload.orderId}`,
      signal: context.signal,
    }),
  );

  // Returned value becomes the job's durable outcome and is validated against
  // `resultSchema`. An invalid result is a failed attempt, not a committed
  // success — so keep this shape in step with the contract.
  return {
    orderId: payload.orderId,
    providerMessageId: receipt.providerMessageId,
    sentAt: receipt.sentAt,
  };
}
```

> **On permanent failures:** a thrown `EmailProviderPermanentError` still spends the attempt budget and lands in dead letters after five tries. That is the documented terminal path — inspect with `admin.listDeadLetters()` and replay with `admin.redrive*` once the cause is fixed. The recorded error _name_ is filterable, so `{ errorName: "EmailProviderRetryableError" }` redrives only the outage batch. If the extra attempts bother you, enqueue permanent-failure-prone types with a smaller `maxAttempts`.

---

### 6. `src/workhorse.worker.ts` — the worker process

```ts
import {
  Pool,
  assertSchemaCompatible,
  createWorkhorseAdapter,
  defineWorkerProcess,
} from "@stablemates/workhorse";
import { sendOrderConfirmation } from "./jobs/send-order-confirmation.js";
import { EMAIL_QUEUE, ORDER_CONFIRMATION_JOB, workhorseContracts } from "./workhorse/contracts.js";

/** One process, one pool. The adapter's `close` shuts it down after the last drain. */
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// Verify, never install. Fails the process before it claims anything.
await assertSchemaCompatible(pool);

export default defineWorkerProcess({
  adapter() {
    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (transaction: typeof pool) => transaction,
      close: () => pool.end(),
      // Workers validate handler results against the same registry the
      // producer validates payloads against.
      queueOptions: { contracts: workhorseContracts },
    });
  },
  workers: [
    {
      options: {
        queues: [EMAIL_QUEUE],
        // Simultaneous handlers in THIS worker. Replicas multiply it; if the
        // fleet must share one budget use a concurrency policy instead.
        concurrency: 8,
      },
      configure(worker) {
        worker.handle(ORDER_CONFIRMATION_JOB, sendOrderConfirmation);
      },
    },
  ],
  // First SIGTERM stops claims and drains active jobs; keep this shorter than
  // your platform's termination window. Anything not drained in time keeps its
  // lease in PostgreSQL, and fenced recovery hands it to another worker.
  shutdownTimeoutMs: 25_000,
  // /livez while the process exists, /readyz until draining begins — so a
  // rolling deploy stops routing to a process on its way out. Not app ingress:
  // it exposes no job data, no metrics, no mutations.
  probes: { hostname: "0.0.0.0", port: 9090 },
});
```

Run it (against **compiled** output — the CLI bundles no TypeScript loader):

```bash
workhorse worker --config ./dist/workhorse.worker.js
```

---

### 7. `src/workhorse/deploy.ts` — deploy-time policy sync

```ts
import { Pool, Queue, installSchema } from "@stablemates/workhorse";
import { EMAIL_QUEUE } from "./contracts.js";

/**
 * Run from your deploy pipeline, not from an application process.
 * Equivalent to `workhorse schema install` if you prefer the CLI.
 */
export async function deployWorkhorse(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await installSchema(pool); // first deploy only; later releases: migrateSchema(pool)

    /**
     * Email providers cap send rate. A concurrency limit cannot express that —
     * 60 jobs that each finish in 100ms sail through a maxActive of 5. This is
     * a token bucket PostgreSQL owns, so every worker replica draws from the
     * same budget and no clock skew can mint capacity.
     *
     * Tokens are never refunded and every RETRY start spends a fresh one, so
     * size the limit for attempts, not for jobs.
     */
    await new Queue(pool).syncRateLimitPolicies("app", [
      {
        queue: EMAIL_QUEUE,
        rate: { limit: 60, intervalMs: 60_000, burst: 10 },
      },
    ]);
  } finally {
    await pool.end();
  }
}
```

---

### Wiring checklist

1. `startWorkhorse()` on web boot — before serving traffic.
2. Replace your order-creation path with `createOrder`, or move your existing insert into the same `BEGIN`/`COMMIT` and add the one `queue.enqueue(..., client)` line.
3. Deploy the worker as its own replica set running the `workhorse worker` command above, with `/readyz` as its readiness probe.
4. Env: `DATABASE_URL`, `EMAIL_PROVIDER_URL`, `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM`.

Requires Node.js 22 or 24, an ESM project, and PostgreSQL 15–18. The connecting role must be able to create the `workhorse` schema and its tables, indexes, partitions, and functions. On later releases, swap `schema install` for `schema migrate` — inside a major line a migration only adds, so a rolling deploy meets a schema ahead of it and keeps working.

```install
npm install @stablemates/workhorse
npm exec --no -- workhorse schema install
npm exec --no -- workhorse schema status --json
```
