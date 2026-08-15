import type { ReactNode } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { CodeSample, type CodeTab, CodeTabs } from "@/components/code-sample";
import { Rule } from "@/components/primitives";
import { demoUrl, siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: `${siteConfig.name} — ${siteConfig.tagline}` },
  description: siteConfig.description,
  alternates: { canonical: "/" },
};

/* -------------------------------------------------------------------------
 * Every snippet on this page is verified against the current API surface:
 * `Queue` in typescript/core/src/queue.ts, `Worker` and `HandlerContext` in typescript/core/src/worker.ts,
 * option types in typescript/core/src/types.ts, and the adapter/dashboard package READMEs.
 * Change the source, change the snippet — never the other way around.
 * ---------------------------------------------------------------------- */

const heroCode = `import { Pool } from "pg";
import { installSchema, Queue, Worker } from "@workhorse/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);

const queue = new Queue(pool);
await queue.enqueue("email.welcome", { to: "ada@example.com" });

const worker = new Worker(queue, { concurrency: 4 }).handle(
  "email.welcome",
  async ({ to }) => ({ deliveredTo: to }),
);

await worker.run();`;

/**
 * The main exhibit: one scrolling section per feature, each led by a real,
 * runnable example. Prose stays short — the code is the argument.
 */
interface Feature {
  id: string;
  index: string;
  title: string;
  lede: ReactNode;
  code: string;
  file: string;
  href: string;
  linkLabel: string;
  after?: ReactNode;
}

const features: readonly Feature[] = [
  {
    id: "transactional-enqueue",
    index: "01 / transactional enqueue",
    title: "The job commits with your data — or not at all.",
    lede: (
      <>
        Pass your open transaction as the last argument and the job becomes one more row in it. If
        the order rolls back, the job was never enqueued. No outbox table, no relay process, no
        two-phase anything.
      </>
    ),
    file: "create-order.ts",
    code: `const client = await pool.connect();
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
    href: "/docs/enqueue",
    linkLabel: "Enqueue and transactions",
  },
  {
    id: "checkpoints",
    index: "02 / checkpoints",
    title: "Crash mid-job. Finish anyway.",
    lede: (
      <>
        Wrap each completed stage in a named <code>checkpoint</code>. When a retry or restart runs
        the handler again, completed checkpoints return their stored result instead of re-executing
        — the customer is charged once, no matter how many times the process dies.
      </>
    ),
    file: "invoice.ts",
    code: `worker.handle("invoice.issue", async (payload, ctx) => {
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
    href: "/docs/durable-execution",
    linkLabel: "Durable execution",
    after: <CrashTrace />,
  },
  {
    id: "durable-sleep",
    index: "03 / durable sleep",
    title: "Sleep for an hour — or a month — and hold nothing.",
    lede: (
      <>
        <code>ctx.sleep</code> commits a named timer in PostgreSQL and gives the worker slot back.
        When the timer is due, the handler restarts from the top and its checkpoints replay, so the
        wait costs no memory, no worker slot, and no retry attempt.
      </>
    ),
    file: "settle-order.ts",
    code: `worker.handle("order.settle", async (payload, ctx) => {
  const order = await ctx.checkpoint("place", () =>
    placeOrder(payload),
  );

  // Slot released here. The process can restart, deploy, or die.
  await ctx.sleep("settlement-window", 60 * 60 * 1000);

  await confirm(order.id);
  return { orderId: order.id };
});`,
    href: "/docs/durable-execution",
    linkLabel: "Checkpoints and durable waits",
  },
  {
    id: "retries",
    index: "04 / retries and deadlines",
    title: "Retry on a policy. Stop at a deadline.",
    lede: (
      <>
        The retry policy is stored with the job and enforced by PostgreSQL, so every worker backs
        off identically. An absolute <code>deadline</code> bounds the whole job, and{" "}
        <code>executionTimeoutMs</code> bounds any single attempt — a stuck worker cannot keep an
        expired attempt alive.
      </>
    ),
    file: "reminder.ts",
    code: `await queue.enqueue(
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
    href: "/docs/retries",
    linkLabel: "Retries",
  },
  {
    id: "idempotency",
    index: "05 / idempotency",
    title: "Replay the request, get the same job.",
    lede: (
      <>
        Give an enqueue a key and a scope, and replaying it returns the original job id instead of
        creating a duplicate. A replay with a materially different payload raises a typed conflict —
        never a silent second job.
      </>
    ),
    file: "capture.ts",
    code: `const jobId = await queue.enqueue(
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
    href: "/docs/idempotency",
    linkLabel: "Idempotent enqueue",
  },
  {
    id: "schedules",
    index: "06 / schedules",
    title: "Cron jobs, no scheduler process.",
    lede: (
      <>
        Declare schedules as code and sync them on every deploy. The sync is authoritative for its
        namespace — a schedule you stop shipping is disabled atomically. Workers evaluate and fire
        due schedules in-process; there is no separate service to run.
      </>
    ),
    file: "deploy.ts",
    code: `// Run on every deployment with the complete list.
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
    href: "/docs/schedules",
    linkLabel: "Schedules",
  },
  {
    id: "flow-control",
    index: "07 / flow control",
    title: "Throttle by queue, tenant, or key.",
    lede: (
      <>
        Concurrency and rate-limit policies live in the database, so they bind the whole fleet, not
        one process. Cap active jobs per queue, cap them per <code>concurrencyKey</code> to keep one
        tenant from starving the rest, and rate-limit calls to a fragile provider.
      </>
    ),
    file: "policies.ts",
    code: `await queue.syncConcurrencyPolicies("workers", [
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
    href: "/docs/concurrency-policies",
    linkLabel: "Concurrency policies",
  },
  {
    id: "cancellation",
    index: "08 / cancellation",
    title: "Cancel work that is already running.",
    lede: (
      <>
        Every handler gets an <code>AbortSignal</code>. A cancel request, an exceeded deadline, and
        an exceeded execution timeout all arrive on it, so one check covers all three — and it plugs
        straight into <code>fetch</code> and everything else that takes a signal.
      </>
    ),
    file: "export.ts",
    code: `worker.handle("rows.export", async (payload, ctx) => {
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
    href: "/docs/cancellation",
    linkLabel: "Cancellation",
  },
  {
    id: "dead-letters",
    index: "09 / dead letters",
    title: "Failures leave evidence, and redrive leaves an audit trail.",
    lede: (
      <>
        Exhausted jobs land in a cold relation with their error, attempts, and tags — reading them
        never competes with dispatch. Redrive requires an actor, a reason, and a request id, and
        keeps lineage back to the failure it replaced.
      </>
    ),
    file: "incident.ts",
    code: `const page = await queue.listDeadLetters({
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
    href: "/docs/dead-letters",
    linkLabel: "Dead letters and redrive",
  },
];

/** Operating surfaces, shown as one tab group: dashboard, health, fleet. */
const operateTabs: readonly CodeTab[] = [
  {
    label: "dashboard",
    file: "app/api/[...workhorse]/route.ts",
    note: (
      <>
        The dashboard mounts on any Fetch-native framework — Next.js, Hono, SvelteKit — with only a
        database connection. No worker runtime, no extra service.
      </>
    ),
    code: `import { createDashboardHost } from "@workhorse/dashboard/server";

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
  },
  {
    label: "health",
    file: "monitor.ts",
    note: (
      <>
        One call returns queue depth, oldest ready age, expiring leases, and a graded status with
        machine-readable reasons — ready to wire into your existing alerting.
      </>
    ),
    code: `const health = await queue.health();

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
  },
  {
    label: "fleet",
    file: "pause-fleet.ts",
    note: (
      <>
        Every worker registers itself in the database, so any process that reaches PostgreSQL can
        list the fleet and request a cooperative, durable pause.
      </>
    ),
    code: `for (const entry of await queue.listWorkers()) {
  if (entry.queue !== "billing") continue;

  await queue.setWorkerPaused(entry.workerId, true, {
    requestedBy: "operator@example.com",
    reason: "rolling deploy",
  });
}`,
  },
];

/** One tab per ORM adapter — the same transactional guarantee everywhere. */
const ormTabs: readonly CodeTab[] = [
  {
    label: "drizzle",
    file: "signup.ts",
    code: `import { createDrizzleAdapter } from "@workhorse/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle({ client: pool });
const workhorse = createDrizzleAdapter(db);

await db.transaction(async (tx) => {
  await tx.insert(account).values({ id: accountId, email });
  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId,
  });
});`,
  },
  {
    label: "prisma",
    file: "signup.ts",
    code: `import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@workhorse/prisma";

const prisma = new PrismaClient();
const workhorse = createPrismaAdapter(prisma);

await prisma.$transaction(async (tx) => {
  const account = await tx.account.create({ data: { email } });
  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId: account.id,
  });
});`,
  },
  {
    label: "typeorm",
    file: "signup.ts",
    code: `import { createTypeOrmAdapter } from "@workhorse/typeorm";

const workhorse = createTypeOrmAdapter(dataSource);

await dataSource.transaction(async (manager) => {
  const account = await manager.save(Account, { email });
  await workhorse.forTransaction(manager).enqueue("account.created", {
    accountId: account.id,
  });
});`,
  },
  {
    label: "kysely",
    file: "signup.ts",
    code: `import { createKyselyAdapter } from "@workhorse/kysely";

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
  },
];

const deployCode = `// workhorse.worker.ts — run with: workhorse worker --config ./dist/worker.js
import { createWorkhorseAdapter, defineWorkerProcess } from "@workhorse/core";
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
});`;

const packages = [
  {
    name: "@workhorse/core",
    body: "Queue, Worker, schema installation, the worker-process runtime, and the CLI.",
    href: "/reference",
  },
  {
    name: "@workhorse/dashboard",
    body: "The embeddable React operator UI and its framework-neutral server host.",
    href: "/docs/dashboard",
  },
  {
    name: "@workhorse/drizzle",
    body: "Adapts Drizzle databases and caller-owned transactions.",
    href: "/docs/drizzle",
  },
  {
    name: "@workhorse/prisma",
    body: "Adapts Prisma clients and interactive transactions.",
    href: "/docs/prisma",
  },
  {
    name: "@workhorse/typeorm",
    body: "Adapts TypeORM data sources and transactional entity managers.",
    href: "/docs/typeorm",
  },
  {
    name: "@workhorse/kysely",
    body: "Adapts Kysely databases and transaction executors.",
    href: "/docs/kysely",
  },
];

/** The compact failure timeline: what the checkpoints example actually buys. */
const crashTrace = [
  { event: 'checkpoint("charge")', detail: "ran — result committed", tone: "run" },
  { event: "process killed", detail: "lease expires; nothing rolls back", tone: "break" },
  {
    event: 'checkpoint("charge")',
    detail: "replayed from storage — not charged again",
    tone: "replay",
  },
  { event: "succeeded", detail: "result persisted, history queryable", tone: "done" },
] as const;

const crashDot: Record<string, string> = {
  run: "bg-signal-500",
  break: "bg-fd-muted-foreground/70",
  replay: "bg-safety-500",
  done: "bg-safety-500",
};

function CrashTrace() {
  return (
    <div className="wh-panel mt-4 overflow-hidden rounded-xl">
      <div className="wh-frame-bar px-4 py-2">
        <span className="wh-mono-label">the same job, through a crash</span>
      </div>
      <ol className="flex flex-col gap-0 px-4 py-2 sm:flex-row sm:items-center sm:gap-0 sm:px-5">
        {crashTrace.map((step, index) => (
          <li key={step.event + index} className="flex items-center py-1.5 sm:flex-1 sm:py-2">
            <span
              aria-hidden
              className={`mr-2.5 size-[7px] shrink-0 rounded-full ${crashDot[step.tone]}`}
            />
            <span className="min-w-0">
              <span className="block truncate font-mono text-[12px] font-medium tracking-tight">
                {step.event}
              </span>
              <span className="block text-[12px] leading-snug text-fd-muted-foreground">
                {step.detail}
              </span>
            </span>
            {index < crashTrace.length - 1 ? (
              <span aria-hidden className="wh-rule mx-3 hidden h-px flex-1 border-t sm:block" />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function FeatureSection({ feature }: { feature: Feature }) {
  return (
    <section id={feature.id} className="wh-rule border-t py-14">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:gap-14">
        <div>
          <p className="wh-mono-label">{feature.index}</p>
          <h2 className="mt-3 text-balance text-[22px] font-semibold leading-snug tracking-tight sm:text-2xl">
            {feature.title}
          </h2>
          <p className="mt-3 text-pretty text-[14.5px] leading-relaxed text-fd-muted-foreground [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-fd-foreground">
            {feature.lede}
          </p>
          <p className="mt-4">
            <Link href={feature.href} className="wh-link-underline text-[13.5px] font-medium">
              {feature.linkLabel} →
            </Link>
          </p>
        </div>
        <div className="min-w-0">
          <CodeSample code={feature.code} title={feature.file} meta="typescript" />
          {feature.after}
        </div>
      </div>
    </section>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden className="wh-grid-field pointer-events-none absolute inset-0" />
      <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-14 sm:pt-20 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-center lg:gap-14">
          <div>
            <p className="wh-mono-label">PostgreSQL 15+ · no broker · no extension</p>
            <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.06] tracking-[-0.03em] sm:text-[3.25rem]">
              Durable background jobs in{" "}
              <span className="wh-accent-text">the Postgres you already run.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
              Enqueue in the same transaction as your data. Checkpoint work so a crash never repeats
              a charge. Sleep for a month without holding a worker slot. One database owns the jobs,
              the schedules, the evidence — and there is no second system to operate.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/docs/quickstart"
                className="inline-flex items-center gap-2 rounded-lg bg-fd-foreground px-4 py-2.5 text-[14px] font-medium text-fd-background transition-colors hover:bg-fd-foreground/85"
              >
                Start in five minutes
              </Link>
              <a
                href={demoUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="wh-rule inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[14px] font-medium transition-colors hover:bg-fd-muted"
              >
                <span className="wh-status-dot" aria-hidden />
                Open the live demo
              </a>
            </div>

            <p className="mt-5 font-mono text-[12.5px] text-fd-muted-foreground">
              <span className="wh-accent-text">$</span> npm install @workhorse/core pg
            </p>
          </div>

          <div className="min-w-0">
            <CodeSample code={heroCode} title="app.ts" meta="the whole setup" />
          </div>
        </div>

        <dl className="mt-14 grid grid-cols-2 gap-y-6 sm:grid-cols-4">
          <Stat value="1" label="Dependency: PostgreSQL 15+" />
          <Stat value="0" label="Brokers, relays, or sidecars" />
          <Stat value="0" label="PostgreSQL extensions" />
          <Stat value="6" label="Packages, one guarantee" />
        </dl>
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="wh-rule border-l pl-4">
      <dt className="font-mono text-[22px] font-medium tracking-tight tabular-nums">{value}</dt>
      <dd className="mt-0.5 text-[13px] text-fd-muted-foreground">{label}</dd>
    </div>
  );
}

function Tile({ href, label, note }: { href: string; label: string; note: string }) {
  return (
    <Link
      href={href}
      className="group rounded-lg px-4 py-4 transition-colors hover:bg-fd-muted sm:px-5"
    >
      <p className="flex items-center gap-2 text-[15px] font-medium tracking-tight">
        {label}
        <span
          aria-hidden
          className="wh-accent-text translate-x-0 transition-transform group-hover:translate-x-0.5"
        >
          →
        </span>
      </p>
      <p className="mt-1 text-[14px] text-fd-muted-foreground">{note}</p>
    </Link>
  );
}

export default function HomePage() {
  return (
    <>
      <Hero />

      {/* ---------- Feature tour: one real example per feature ---------- */}
      <div className="mx-auto w-full max-w-6xl px-5 lg:px-8">
        <Rule label="the feature tour" />
        {features.map((feature) => (
          <FeatureSection key={feature.id} feature={feature} />
        ))}
      </div>

      {/* ---------- Operating ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 py-16 lg:px-8">
        <Rule label="10 / operating" />
        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:gap-14">
          <div>
            <h2 className="text-balance text-[22px] font-semibold leading-snug tracking-tight sm:text-2xl">
              Operate from anywhere PostgreSQL reaches.
            </h2>
            <p className="mt-3 text-pretty text-[14.5px] leading-relaxed text-fd-muted-foreground">
              The dashboard, the health check, and fleet control are all reads and writes against
              the same database — mount them in the app you already deploy, or run them from a
              one-off script during an incident.
            </p>
            <p className="mt-4">
              <Link href="/docs/operations" className="wh-link-underline text-[13.5px] font-medium">
                Operations →
              </Link>
            </p>
          </div>
          <div className="min-w-0">
            <CodeTabs name="operate" tabs={operateTabs} meta="typescript" />
          </div>
        </div>
      </section>

      {/* ---------- ORM adapters ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <Rule label="11 / bring your ORM" />
        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:gap-14">
          <div>
            <h2 className="text-balance text-[22px] font-semibold leading-snug tracking-tight sm:text-2xl">
              The same guarantee inside your ORM's transaction.
            </h2>
            <p className="mt-3 text-pretty text-[14.5px] leading-relaxed text-fd-muted-foreground">
              Each adapter is a separate package that turns your ORM's transaction object into the
              queue's database protocol. The account row and its follow-up job still commit — or
              roll back — together.
            </p>
            <p className="mt-4">
              <Link href="/integrations" className="wh-link-underline text-[13.5px] font-medium">
                All integrations →
              </Link>
            </p>
          </div>
          <div className="min-w-0">
            <CodeTabs name="orm" tabs={ormTabs} meta="typescript" />
          </div>
        </div>
      </section>

      {/* ---------- Deploying workers ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <Rule label="12 / deploying" />
        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:gap-14">
          <div>
            <h2 className="text-balance text-[22px] font-semibold leading-snug tracking-tight sm:text-2xl">
              One config file is a production worker.
            </h2>
            <p className="mt-3 text-pretty text-[14.5px] leading-relaxed text-fd-muted-foreground">
              <code className="font-mono text-[13px] text-fd-foreground">workhorse worker</code>{" "}
              runs your handlers with graceful drain on SIGTERM, readiness and liveness probes, and
              fleet registration — the parts of a worker process everyone rewrites badly under
              deadline.
            </p>
            <p className="mt-4">
              <Link
                href="/docs/worker-processes"
                className="wh-link-underline text-[13.5px] font-medium"
              >
                Worker processes →
              </Link>
            </p>
          </div>
          <div className="min-w-0">
            <CodeSample code={deployCode} title="workhorse.worker.ts" meta="typescript" />
          </div>
        </div>
      </section>

      {/* ---------- Packages ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <Rule label="13 / packages" />
        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:gap-14">
          <div>
            <h2 className="text-balance text-[22px] font-semibold leading-snug tracking-tight sm:text-2xl">
              The core keeps one dependency.
            </h2>
            <p className="mt-3 text-pretty text-[14.5px] leading-relaxed text-fd-muted-foreground">
              Every integration is its own package, so adopting an ORM adapter or the dashboard
              never adds that ecosystem to the core. None of them hide the transaction from you.
            </p>
          </div>
          <dl className="wh-panel overflow-hidden rounded-xl">
            {packages.map((pkg) => (
              <Link
                key={pkg.name}
                href={pkg.href}
                className="wh-rule grid gap-1.5 border-t px-5 py-4 transition-colors first:border-t-0 hover:bg-fd-muted sm:grid-cols-[minmax(0,13rem)_1fr] sm:gap-8"
              >
                <dt className="font-mono text-[13px] font-medium tracking-tight">{pkg.name}</dt>
                <dd className="text-[14px] leading-relaxed text-fd-muted-foreground">{pkg.body}</dd>
              </Link>
            ))}
          </dl>
        </div>
      </section>

      {/* ---------- Where to go ---------- */}
      <section className="wh-rule border-t">
        <div className="mx-auto grid w-full max-w-6xl gap-px px-5 py-14 sm:grid-cols-3 lg:px-8">
          <Tile
            href="/docs/quickstart"
            label="Quickstart"
            note="Schema, first job, first worker — in five minutes."
          />
          <Tile
            href="/reference"
            label="API reference"
            note="Queue, Worker, and the process runner surface."
          />
          <Tile
            href="/examples"
            label="Examples"
            note="End-to-end patterns you can paste into a service."
          />
        </div>
      </section>
    </>
  );
}
