import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Admin, Pool, Queue, Worker, type Queryable } from "@stablemates/workhorse";
import { Stripe } from "stripe";

export const STRIPE_API_VERSION = "2026-09-30.endive";
export const MAX_BODY_BYTES = 262_144;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 5_000;
export const QUEUE_NAME = "stripe-invoices";
export const TASK_TYPE = "stripe.invoice-paid";

const stripe = new Stripe("sk_test_offline_signing_only", { apiVersion: STRIPE_API_VERSION });

export type StripeScope = {
  accountId: string;
  livemode: boolean;
  signingSecrets: readonly string[];
};

export type PaidInvoiceReference = {
  accountId: string;
  livemode: boolean;
  eventId: string;
  eventCreated: number;
  invoiceId: string;
  customerId: string;
};

export class IngressError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IngressError(400, "Invalid snapshot event");
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,200}$`).test(value)) {
    throw new IngressError(400, "Invalid reference");
  }
  return value;
}

function validateScope(scope: StripeScope): void {
  identifier(scope.accountId, "acct");
  if (
    typeof scope.livemode !== "boolean" ||
    scope.signingSecrets.length < 1 ||
    scope.signingSecrets.length > 2 ||
    scope.signingSecrets.some((secret) => !/^whsec_[A-Za-z0-9_]{1,200}$/.test(secret))
  ) {
    throw new Error("Configure an account, mode, and one or two endpoint signing secrets");
  }
}

export function verifyInvoice(
  rawBody: Buffer,
  signature: string,
  scope: StripeScope,
): PaidInvoiceReference | null {
  validateScope(scope);
  if (rawBody.length > MAX_BODY_BYTES) throw new IngressError(413, "Payload too large");
  let verified: unknown;
  for (const secret of scope.signingSecrets) {
    try {
      verified = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        secret,
        SIGNATURE_TOLERANCE_SECONDS,
      );
      break;
    } catch {
      continue;
    }
  }
  if (verified === undefined) throw new IngressError(400, "Invalid or stale signature");
  const event = record(verified);
  if (event.account !== scope.accountId || event.livemode !== scope.livemode) {
    throw new IngressError(403, "Unauthorized Stripe scope");
  }
  if (event.object !== "event" || event.api_version !== STRIPE_API_VERSION) {
    throw new IngressError(400, "Unsupported snapshot event version");
  }
  if (event.type !== "invoice.paid") return null;
  const invoice = record(record(event.data).object);
  if (
    invoice.object !== "invoice" ||
    invoice.status !== "paid" ||
    !Number.isSafeInteger(event.created) ||
    (event.created as number) <= 0 ||
    invoice.livemode !== scope.livemode
  ) {
    throw new IngressError(400, "Unsupported paid invoice");
  }
  return {
    accountId: scope.accountId,
    livemode: scope.livemode,
    eventId: identifier(event.id, "evt"),
    eventCreated: event.created as number,
    invoiceId: identifier(invoice.id, "in"),
    customerId: identifier(invoice.customer, "cus"),
  };
}

export async function installStripeRecipe(database: Queryable): Promise<void> {
  await database.query(`
    CREATE SCHEMA IF NOT EXISTS stripe_recipe;
    CREATE TABLE IF NOT EXISTS stripe_recipe.inbox (
      id uuid PRIMARY KEY,
      account_id text NOT NULL,
      livemode boolean NOT NULL,
      event_id text NOT NULL,
      event_created bigint NOT NULL,
      invoice_id text NOT NULL,
      customer_id text NOT NULL,
      fingerprint text NOT NULL,
      task_id uuid,
      accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      fulfilled_at timestamptz,
      UNIQUE (account_id, livemode, event_id)
    );
    CREATE TABLE IF NOT EXISTS stripe_recipe.invoice_grant (
      account_id text NOT NULL,
      livemode boolean NOT NULL,
      invoice_id text NOT NULL,
      customer_id text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (account_id, livemode, invoice_id)
    );
    CREATE TABLE IF NOT EXISTS stripe_recipe.entitlement (
      account_id text NOT NULL,
      livemode boolean NOT NULL,
      customer_id text NOT NULL,
      paid_invoice_credits bigint NOT NULL CHECK (paid_invoice_credits > 0),
      PRIMARY KEY (account_id, livemode, customer_id)
    )
  `);
}

export async function acceptInvoiceInTransaction(
  transaction: Queryable,
  reference: PaidInvoiceReference,
): Promise<{ inboxId: string; taskId: string; duplicate: boolean }> {
  const fingerprint = createHash("sha256").update(JSON.stringify(reference)).digest("hex");
  const inserted = await transaction.query<{ id: string }>(
    `INSERT INTO stripe_recipe.inbox
       (id, account_id, livemode, event_id, event_created, invoice_id, customer_id, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id, livemode, event_id) DO NOTHING RETURNING id`,
    [
      randomUUID(),
      reference.accountId,
      reference.livemode,
      reference.eventId,
      reference.eventCreated,
      reference.invoiceId,
      reference.customerId,
      fingerprint,
    ],
  );
  const inboxId = inserted.rows[0]?.id;
  if (inboxId === undefined) {
    const existing = await transaction.query<{ id: string; task_id: string; fingerprint: string }>(
      `SELECT id, task_id, fingerprint FROM stripe_recipe.inbox
       WHERE account_id = $1 AND livemode = $2 AND event_id = $3`,
      [reference.accountId, reference.livemode, reference.eventId],
    );
    const previous = existing.rows[0];
    if (!previous?.task_id || previous.fingerprint !== fingerprint) {
      throw new IngressError(409, "Conflicting event reference");
    }
    return { inboxId: previous.id, taskId: previous.task_id, duplicate: true };
  }
  const taskId = await new Queue(transaction, QUEUE_NAME).enqueue(
    TASK_TYPE,
    { inboxId },
    {
      idempotency: {
        key: reference.eventId,
        scope: `stripe:${reference.accountId}:${reference.livemode ? "live" : "test"}`,
        ttlMs: 86_400_000,
      },
      maxAttempts: 5,
      retryPolicy: { type: "fixed", delayMs: 1_000 },
    },
  );
  await transaction.query("UPDATE stripe_recipe.inbox SET task_id = $2 WHERE id = $1", [
    inboxId,
    taskId,
  ]);
  return { inboxId, taskId, duplicate: false };
}

async function inTransaction<Result>(
  pool: Pool,
  operation: (transaction: Queryable) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '3s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL synchronous_commit = on");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function acceptInvoice(pool: Pool, reference: PaidInvoiceReference) {
  return inTransaction(pool, (transaction) => acceptInvoiceInTransaction(transaction, reference));
}

export function fulfillInvoice(pool: Pool, inboxId: string): Promise<{ granted: boolean }> {
  return inTransaction(pool, async (transaction) => {
    const result = await transaction.query<{
      account_id: string;
      livemode: boolean;
      invoice_id: string;
      customer_id: string;
    }>("SELECT * FROM stripe_recipe.inbox WHERE id = $1 FOR UPDATE", [inboxId]);
    const invoice = result.rows[0];
    if (!invoice) throw new Error("Unknown Stripe inbox reference");
    const values = [invoice.account_id, invoice.livemode, invoice.invoice_id, invoice.customer_id];
    const grant = await transaction.query(
      `INSERT INTO stripe_recipe.invoice_grant (account_id, livemode, invoice_id, customer_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, livemode, invoice_id) DO NOTHING RETURNING invoice_id`,
      values,
    );
    const granted = grant.rows.length === 1;
    if (granted) {
      await transaction.query(
        `INSERT INTO stripe_recipe.entitlement
           (account_id, livemode, customer_id, paid_invoice_credits)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (account_id, livemode, customer_id) DO UPDATE
           SET paid_invoice_credits = stripe_recipe.entitlement.paid_invoice_credits + 1`,
        [invoice.account_id, invoice.livemode, invoice.customer_id],
      );
    } else {
      const previous = await transaction.query<{ customer_id: string }>(
        `SELECT customer_id FROM stripe_recipe.invoice_grant
         WHERE account_id = $1 AND livemode = $2 AND invoice_id = $3`,
        values.slice(0, 3),
      );
      if (previous.rows[0]?.customer_id !== invoice.customer_id) {
        throw new Error("Invoice customer changed; operator reconciliation required");
      }
    }
    await transaction.query(
      "UPDATE stripe_recipe.inbox SET fulfilled_at = COALESCE(fulfilled_at, clock_timestamp()) WHERE id = $1",
      [inboxId],
    );
    return { granted };
  });
}

export function stripeWorker(pool: Pool): Worker {
  return new Worker(new Queue(pool, QUEUE_NAME), { concurrency: 2 }).handle<{ inboxId: string }>(
    TASK_TYPE,
    ({ inboxId }) => fulfillInvoice(pool, inboxId),
  );
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      request.off("data", receive);
      request.off("end", complete);
      request.off("error", fail);
      request.off("aborted", abort);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(new IngressError(400, "Incomplete request"));
    const receive = (bytes: Buffer) => {
      length += bytes.length;
      if (length > MAX_BODY_BYTES) {
        fail(new IngressError(413, "Payload too large"));
      } else {
        chunks.push(bytes);
      }
    };
    const complete = () => {
      cleanup();
      resolve(Buffer.concat(chunks, length));
    };
    request.on("data", receive);
    request.once("end", complete);
    request.once("error", fail);
    request.once("aborted", abort);
  });
}

export function stripeIngress(pool: Pool, scope: StripeScope) {
  validateScope(scope);
  let activeRequests = 0;
  const server = createServer(async (request, response) => {
    request.on("error", () => undefined);
    if (request.method !== "POST" || request.url !== "/stripe/invoice-paid") {
      response.writeHead(404).end();
      return;
    }
    if (activeRequests >= 32) {
      response.setHeader("Connection", "close");
      response.writeHead(503).end();
      request.resume();
      return;
    }
    activeRequests += 1;
    const deadline = setTimeout(() => {
      if (!response.headersSent) response.writeHead(408).end(() => request.destroy());
    }, REQUEST_TIMEOUT_MS);
    try {
      const signature = request.headers["stripe-signature"];
      if (
        typeof signature !== "string" ||
        request.headers["content-type"]?.split(";")[0] !== "application/json" ||
        (request.headers["content-encoding"] !== undefined &&
          request.headers["content-encoding"] !== "identity")
      ) {
        throw new IngressError(400, "Expected signed uncompressed JSON");
      }
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
        throw new IngressError(413, "Payload too large");
      }
      const reference = verifyInvoice(await readRawBody(request), signature, scope);
      if (reference === null) {
        response.writeHead(200).end("ignored");
      } else {
        await acceptInvoice(pool, reference);
        if (!response.headersSent) response.writeHead(200).end("accepted");
      }
    } catch (error) {
      if (!response.headersSent) {
        response.setHeader("Connection", "close");
        response.writeHead(error instanceof IngressError ? error.status : 503).end();
      }
      request.resume();
    } finally {
      clearTimeout(deadline);
      activeRequests -= 1;
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  return server;
}

export async function verifyOffline(pool: Pool) {
  const secret = "whsec_offline_fixture_only";
  const scope = { accountId: "acct_offline", livemode: false, signingSecrets: [secret] };
  const payload = JSON.stringify({
    id: "evt_offline",
    object: "event",
    account: scope.accountId,
    livemode: false,
    api_version: STRIPE_API_VERSION,
    type: "invoice.paid",
    created: Math.floor(Date.now() / 1_000),
    data: {
      object: {
        id: "in_offline",
        object: "invoice",
        customer: "cus_offline",
        status: "paid",
        livemode: false,
      },
    },
  });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const reference = verifyInvoice(Buffer.from(payload), signature, scope);
  if (!reference) throw new Error("Expected paid invoice");
  await installStripeRecipe(pool);
  const accepted = await acceptInvoice(pool, reference);
  const replay = await acceptInvoice(pool, reference);
  await stripeWorker(pool).runOnce();
  const task = await new Admin(pool).getTask(accepted.taskId);
  const retry = await fulfillInvoice(pool, accepted.inboxId);
  const entitlement = await pool.query<{ paid_invoice_credits: string }>(
    "SELECT paid_invoice_credits FROM stripe_recipe.entitlement WHERE customer_id = 'cus_offline'",
  );
  if (
    task?.state !== "succeeded" ||
    replay.taskId !== accepted.taskId ||
    retry.granted ||
    entitlement.rows[0]?.paid_invoice_credits !== "1"
  ) {
    throw new Error("Offline durable acceptance verification failed");
  }
  return { status: "verified", taskId: accepted.taskId, outboundCalls: 0 };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 1_000 });
  const mode = process.argv[2];
  if (mode === "--verify" || mode === "setup") {
    try {
      const result =
        mode === "--verify" ? await verifyOffline(pool) : await installStripeRecipe(pool);
      if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      await pool.end();
    }
  } else if (mode === "ingress") {
    const livemode = process.env.STRIPE_LIVEMODE;
    if (livemode !== "true" && livemode !== "false") throw new Error("STRIPE_LIVEMODE is required");
    const server = stripeIngress(pool, {
      accountId: process.env.STRIPE_ACCOUNT_ID ?? "",
      livemode: livemode === "true",
      signingSecrets: (process.env.STRIPE_WEBHOOK_SECRETS ?? "").split(","),
    });
    server.listen(Number(process.env.PORT ?? 4242), "127.0.0.1");
    const stop = () => server.close(() => void pool.end());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else if (mode === "worker") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    try {
      await stripeWorker(pool).run(controller.signal);
    } finally {
      await pool.end();
    }
  } else {
    await pool.end();
    throw new Error("Use setup, ingress, worker, or --verify");
  }
}
