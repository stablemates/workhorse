/**
 * Every snippet on the landing page, as source strings.
 *
 * `scripts/gen-landing-code.ts` highlights these at build time into
 * `.source/landing-code.json`, which `components/code-sample.tsx` renders as
 * static markup — the landing page ships no client JavaScript for code.
 *
 * Every snippet is verified against the current API surface: `Queue` in
 * typescript/core/src/queue.ts, `Worker` and `HandlerContext` in
 * typescript/core/src/worker.ts, and option types in
 * typescript/core/src/types.ts. Change the source, change the snippet — never
 * the other way around.
 */
export const landingSnippets = {
  hero: `import { Pool } from "pg";
import { installSchema, Queue, Worker } from "@workhorse-js/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);

const queue = new Queue(pool);
await queue.enqueue("email.welcome", { to: "ada@example.com" });

const worker = new Worker(queue, { concurrency: 4 }).handle(
  "email.welcome",
  async ({ to }) => ({ deliveredTo: to }),
);

await worker.run();`,

  enqueue: `const client = await pool.connect();
try {
  await client.query("BEGIN");

  await client.query(
    "INSERT INTO orders (id, total) VALUES ($1, $2)",
    [orderId, total],
  );

  // Same transaction: the job exists exactly when the order does.
  await queue.enqueue("order.confirm", { orderId }, {}, client);

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}`,

  checkpoints: `worker.handle("invoice.issue", async (payload, ctx) => {
  // Runs once. Every later activation replays the stored result.
  const charge = await ctx.checkpoint("charge", () =>
    payments.charge(payload.amount),
  );

  const pdf = await ctx.checkpoint("render", () =>
    renderInvoice(charge.id),
  );

  await sendEmail(payload.email, pdf);
  return { chargeId: charge.id };
});`,

  sleep: `worker.handle("order.settle", async (payload, ctx) => {
  const order = await ctx.checkpoint("place", () =>
    placeOrder(payload),
  );

  // Slot released here. The process can restart, deploy, or die.
  await ctx.sleep("settlement-window", 60 * 60 * 1000);

  await confirm(order.id);
  return { orderId: order.id };
});`,

  retries: `await queue.enqueue(
  "match.reminder",
  { matchId },
  {
    // Pointless after kickoff, whatever else happens.
    deadline: kickoffTime,
    // Any single attempt is stuck after 30 seconds.
    executionTimeoutMs: 30_000,
    maxAttempts: 5,
    retryPolicy: {
      type: "exponential",
      initialDelayMs: 1_000,
      multiplier: 2,
      maxDelayMs: 60_000,
    },
  },
);`,

  idempotency: `const jobId = await queue.enqueue(
  "invoice.capture",
  { invoiceId: "inv-1" },
  {
    queue: "billing",
    idempotency: {
      key: "capture:inv-1",
      scope: "tenant-42",
      ttlMs: 86_400_000,
    },
  },
);

// The retried webhook, the double-clicked button, the replayed
// message: all of them get the same jobId back.`,

  schedules: `// Run on every deployment with the complete list.
await queue.syncSchedules(
  "billing",
  [
    {
      name: "nightly-invoice-run",
      schedule: "0 2 * * *",
      job: { type: "invoices.generate", payload: {} },
    },
  ],
  { prune: true }, // names not in the list are disabled
);

// Any worker in the namespace fires due schedules itself.
const worker = new Worker(queue, {
  scheduleNamespaces: ["billing"],
});`,

  flowControl: `await queue.syncConcurrencyPolicies("workers", [
  // At most 20 mail jobs active; at most 2 per tenant.
  { queue: "mail", maxActive: 20, maxActivePerKey: 2 },
]);

await queue.syncRateLimitPolicies("workers", [
  {
    queue: "provider-api",
    rate: { limit: 100, intervalMs: 1_000, burst: 200 },
  },
]);

await queue.enqueue(
  "mail.send",
  { messageId },
  { queue: "mail", concurrencyKey: \`tenant:\${tenantId}\` },
);`,

  dependencies: `const inventoryId = await queue.enqueue(
  "inventory.reserve",
  { orderId },
);

await queue.enqueue(
  "order.confirm",
  { orderId },
  {
    dependencies: {
      prerequisiteJobIds: [inventoryId],
      onSuccess: "release",
      onFailure: "cancel",
      onCancellation: "cancel",
    },
  },
);

worker.handle("order.fulfill", async (order, ctx) => {
  const receipt = await ctx.runChild(
    "charge",
    "payment.capture",
    { orderId: order.id },
    { queue: "payments" },
  );
  return { receipt };
});`,

  coalescing: `const options = {
  debounce: {
    key: documentId,
    scope: "search-index",
    windowMs: quietPeriodMs,
    schedule: "reset",
  },
} as const;

const first = await queue.enqueueWithResult(
  "search.reindex",
  { documentId, revision: 1 },
  options,
);
const latest = await queue.enqueueWithResult(
  "search.reindex",
  { documentId, revision: 2 },
  options,
);

logger.info(first.outcome, latest.outcome);
// accepted, then replaced while the job remains pending`,

  externalWaits: `worker.handle("release.publish", async (release, ctx) => {
  const scan = await ctx.waitForSignal("security-scan");

  const review = await ctx.waitForHuman(
    "release-approval",
    { releaseId: release.id, scan },
  );

  return { published: review.approved };
});

await queue.sendSignal(jobId, "security-scan", scanResult, {
  idempotencyKey: scanResult.deliveryId,
  requestedBy: "security-scanner",
});`,

  batchHandlers: `worker.handleBatch(
  "email.send",
  { maxSize: batchSize, lingerMs: batchLingerMs },
  async (items) => {
    const sent = await provider.sendMany(
      items.map(({ payload }) => payload),
    );

    return sent.map((delivery) =>
      delivery.error
        ? { status: "failed", error: delivery.error }
        : { status: "succeeded", result: delivery.id },
    );
  },
);`,

  cancellation: `worker.handle("rows.export", async (payload, ctx) => {
  for (const row of payload.rows) {
    // Stop between items…
    if (ctx.signal.aborted) return { stopped: true };

    // …and mid-request.
    await upload(row, { signal: ctx.signal });
  }
  return { stopped: false };
});

// From an API route, a CLI, an operator script:
await queue.cancel(jobId, {
  requestedBy: "operator@example.com",
  reason: "customer withdrew the request",
});`,

  deadLetters: `const page = await queue.listDeadLetters({
  queue: "billing",
  errorName: "CardDeclined",
});

for (const failure of page.items) {
  await queue.redrive(failure.jobId, {
    requestedBy: "operator@example.com",
    reason: "provider incident resolved",
    requestId: \`incident-2026-08-03:\${failure.jobId}\`,
  });
}`,

  operateDashboard: `import { createDashboardHost } from "@workhorse-js/dashboard/server";

const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  authorize: (request) => isAdmin(request),
});

export async function GET(request: Request) {
  return (
    (await host.handle(request)) ??
    new Response("Not found", { status: 404 })
  );
}`,

  operateHealth: `const health = await queue.health();

if (health.status.level !== "healthy") {
  for (const reason of health.status.reasons) {
    console.warn(reason.code, reason.observed);
  }
}

// Cross-state listing on a dedicated projection: reading it
// never slows dispatch down.
const live = await queue.listJobs({
  states: ["active", "scheduled"],
  limit: 100,
});`,

  operateFleet: `for (const entry of await queue.listWorkers()) {
  if (entry.queue !== "billing") continue;

  await queue.setWorkerPaused(entry.workerId, true, {
    requestedBy: "operator@example.com",
    reason: "rolling deploy",
  });
}`,

  ormDrizzle: `import { createDrizzleAdapter } from "@workhorse-js/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle({ client: pool });
const workhorse = createDrizzleAdapter(db);

await db.transaction(async (tx) => {
  await tx.insert(account).values({ id: accountId, email });
  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId,
  });
});`,

  ormPrisma: `import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@workhorse-js/prisma";

const prisma = new PrismaClient();
const workhorse = createPrismaAdapter(prisma);

await prisma.$transaction(async (tx) => {
  const account = await tx.account.create({ data: { email } });
  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId: account.id,
  });
});`,

  ormTypeorm: `import { createTypeOrmAdapter } from "@workhorse-js/typeorm";

const workhorse = createTypeOrmAdapter(dataSource);

await dataSource.transaction(async (manager) => {
  const account = await manager.save(Account, { email });
  await workhorse.forTransaction(manager).enqueue("account.created", {
    accountId: account.id,
  });
});`,

  ormKysely: `import { createKyselyAdapter } from "@workhorse-js/kysely";

const workhorse = createKyselyAdapter(database);

await database.transaction().execute(async (tx) => {
  const account = await tx
    .insertInto("account")
    .values({ email })
    .returning("id")
    .executeTakeFirstOrThrow();

  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId: account.id,
  });
});`,

  deploy: `// workhorse.worker.ts — run with: workhorse worker --config ./dist/worker.js
import { createWorkhorseAdapter, defineWorkerProcess } from "@workhorse-js/core";
import { Pool } from "pg";
import { generateReport, sendEmail } from "./jobs.js";

export default defineWorkerProcess({
  adapter() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (tx) => tx,
      close: () => pool.end(),
    });
  },
  workers: [
    {
      options: { concurrency: 8 },
      configure: (worker) =>
        worker.handle("email.send", sendEmail).handle("report.generate", generateReport),
    },
  ],
  shutdownTimeoutMs: 25_000, // bounded graceful drain on SIGTERM
});`,
} as const;

export type LandingSnippetId = keyof typeof landingSnippets;
