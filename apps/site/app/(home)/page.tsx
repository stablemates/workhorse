import type { ReactNode } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { CodeSample, type CodeTab, CodeTabs } from "@/components/code-sample";
import { Rule, SectionHeading } from "@/components/primitives";
import { demoUrl, siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: `${siteConfig.name} — ${siteConfig.tagline}` },
  description: siteConfig.description,
  alternates: { canonical: "/" },
};

/**
 * The landing page's central exhibit. Each tab is a different phase of the
 * protocol rather than a variation on one call, so the group reads as the
 * whole lifecycle: produce, execute, schedule, operate, deploy.
 */
const tour: readonly CodeTab[] = [
  {
    label: "enqueue",
    file: "checkout.ts",
    note: (
      <>
        One client owns the whole boundary. If the <code>COMMIT</code> never lands, neither the
        account row nor its follow-up work ever existed.
      </>
    ),
    code: `import { Pool } from "pg";
import { installSchema, Queue } from "@workhorse/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);

const queue = new Queue(pool);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("INSERT INTO account (id) VALUES ($1)", [accountId]);

  await queue.enqueue(
    "account.provision",
    { accountId },
    {
      queue: "onboarding",
      tags: [\`tenant:\${tenantId}\`],
      maxAttempts: 10,
      retryPolicy: {
        type: "exponential",
        initialDelayMs: 30_000,
        multiplier: 2,
        maxDelayMs: 900_000,
      },
      // PostgreSQL evaluates both bounds. A paused worker cannot outlive them.
      deadline: new Date(Date.now() + 86_400_000),
      executionTimeoutMs: 120_000,
      // A retained key: replaying this request returns the same job id.
      idempotency: { key: \`provision:\${accountId}\`, scope: \`tenant:\${tenantId}\` },
    },
    client, // <- the job commits with your row
  );

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}`,
  },
  {
    label: "execute",
    file: "worker.ts",
    note: (
      <>
        A committed checkpoint is replayed, never re-executed. A durable sleep gives the lease and
        the worker slot back, then resumes in the same logical attempt.
      </>
    ),
    code: `import { Worker } from "@workhorse/core";

const worker = new Worker(queue, {
  // No workerId: it defaults to <hostname>-<pid>-<random>. The identity owns
  // leases and attempt history, so it must never be shared by two live processes.
  queue: "billing",
  concurrency: 8,
  leaseMs: 30_000,
  scheduleNamespaces: ["billing-production"],
}).handle("invoice.capture", async (payload, ctx) => {
  // Immutable evidence: a committed checkpoint survives retries and restarts.
  const charge = await ctx.checkpoint("provider-charge", () =>
    capture(payload.invoiceId, { idempotencyKey: payload.invoiceId }),
  );

  // Latest-value operational projection, fenced to this attempt.
  await ctx.setProgress({ phase: "settling", chargeId: charge.id });

  // Releases the lease and the slot; the handler restarts here when due.
  await ctx.sleep("settlement-window", 60_000);

  // Cooperative only. JavaScript is never forcibly preempted.
  ctx.signal.throwIfAborted();

  return { chargeId: charge.id, attempt: ctx.job.attempt };
});

await worker.run();`,
  },
  {
    label: "schedule",
    file: "deploy.ts",
    note: (
      <>
        Synchronization is authoritative for its namespace: a name you stop shipping is disabled
        atomically, and a stale revision cannot fire new payloads.
      </>
    ),
    code: `// Run this on every deployment, with the complete list for the namespace.
await queue.syncSchedules("billing-production", [
  {
    name: "daily-invoices",
    schedule: "0 6 * * *", // validated in process before any write
    job: {
      type: "generate-invoices",
      queue: "billing",
      payload: { scope: "daily" },
      maxAttempts: 5,
      retryPolicy: {
        type: "exponential",
        initialDelayMs: 30_000,
        multiplier: 2,
        maxDelayMs: 900_000,
      },
    },
  },
  {
    name: "weekly-digest",
    schedule: "0 9 * * 1",
    job: { type: "digest.send", payload: {} },
  },
]);

// One database-wide retention policy, so every worker applies identical windows.
await queue.syncRetentionPolicy({
  jobIdentityRetentionDays: 180,
  terminalOutcomeRetentionDays: 90,
  jobEventRetentionDays: 90,
  attemptHistoryRetentionDays: 90,
  scheduleOccurrenceRetentionDays: 30,
});`,
  },
  {
    label: "operate",
    file: "incident.ts",
    note: (
      <>
        Redrive requires an actor, a reason, and a request identity. It copies only the safe fields
        and keeps retained lineage back to the failure it replaced.
      </>
    ),
    code: `// Cold relation, separate indexes: reading failures never competes with claims.
const page = await queue.listDeadLetters({
  queue: "billing",
  type: "invoice.capture",
  tags: ["tenant:42"],
  errorName: "CardDeclined",
  finishedAfter: new Date("2026-08-01T00:00:00Z"),
  limit: 100,
});

for (const failure of page.items) {
  await queue.redrive(failure.jobId, {
    requestedBy: "operator@example.com",
    reason: "provider incident resolved",
    requestId: \`incident-2026-08-03:\${failure.jobId}\`,
  });
}

// Cross-state listing with a bounded, redacted payload projection.
const live = await queue.listJobs({
  states: ["active", "scheduled"],
  limit: 100,
  payload: { include: true, maxBytes: 16_384, redactKeys: ["cardNumber"] },
});

const health = await queue.health(); // depth, oldest ready age, expiring leases`,
  },
  {
    label: "deploy",
    file: "workers.config.ts",
    note: (
      <>
        Every worker announces itself in <code>workhorse.worker_registry</code> and refreshes its
        runtime state, so an operator surface in another process can see and pause the fleet.
      </>
    ),
    code: `import { createWorkhorseAdapter, defineWorkerProcess } from "@workhorse/core";
import { Pool } from "pg";

// Run the compiled module with: workhorse worker --config ./dist/worker.js
export default defineWorkerProcess({
  adapter() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (transaction: typeof pool) => transaction,
      close: () => pool.end(),
    });
  },
  workers: [
    {
      options: {
        queue: "billing",
        concurrency: 8,
        registryIntervalMs: 5_000, // fleet heartbeat; 0 opts out
        activityNotifications: true, // coalesced hints for a live dashboard
      },
      configure: (worker) => worker.handle("invoice.capture", captureInvoice),
    },
  ],
  shutdownTimeoutMs: 25_000, // bounded graceful drain on SIGTERM/SIGINT
  probes: { hostname: "0.0.0.0", port: 9090 },
});

// From any other process that can reach the same database. Worker names are
// generated per process incarnation, so an operator resolves them at call time.
for (const entry of await queue.listWorkers()) {
  if (entry.queue !== "billing") continue;
  await queue.setWorkerPaused(entry.workerId, true, {
    requestedBy: "operator",
    reason: "rolling deploy",
  });
}`,
  },
];

/** The three durable primitives available inside an attempt. */
const primitives = [
  {
    name: "checkpoint(name, fn)",
    body: "Runs the operation once and immutably persists its JSON result under the current fenced lease. When the name already exists, the stored value is returned instead of running anything. Reusing a name with a materially different value is a typed conflict, not a silent overwrite.",
    limit: "≤ 1 MiB per value · names immutable per job",
  },
  {
    name: "sleep(name, ms) / sleepUntil(name, date)",
    body: "Commits a named PostgreSQL timer, hands back the lease and the worker slot, and restarts the handler in the same logical attempt once the target is due. A not-before boundary, not an exact alarm.",
    limit: "≤ 365 days · ≤ 1,000 waits per job",
  },
  {
    name: "signal",
    body: "One AbortSignal for cooperative cancellation, an exceeded absolute deadline, and an exceeded per-attempt execution timeout — each with its own error type. JavaScript is never forcibly preempted.",
    limit: "cooperative · fenced acknowledgement",
  },
];

/**
 * The distinction the whole model turns on: which interruptions spend an
 * attempt and which do not. Sourced from /docs/durable-execution and
 * /docs/workers rather than restated from intuition.
 */
const survival: readonly {
  event: string;
  checkpoints: string;
  budget: string;
  consumes?: boolean;
}[] = [
  {
    event: "handler throws",
    checkpoints: "Retained. Completed names replay on the next attempt.",
    budget: "Consumes one attempt, then backs off on the persisted retry policy.",
    consumes: true,
  },
  {
    event: "process killed",
    checkpoints: "Retained. Nothing already committed is rolled back.",
    budget: "Consumes one attempt once the lease expires and recovery closes it.",
    consumes: true,
  },
  {
    event: "rolling deploy",
    checkpoints: "Retained. The drain lets active handlers finish first.",
    budget: "Untouched when the handler completes inside the shutdown deadline.",
  },
  {
    event: "durable wait",
    checkpoints: "Retained and replayed when the handler restarts.",
    budget: "Not consumed. A month-long wait spends no part of the budget.",
  },
  {
    event: "lease lost",
    checkpoints: "Retained. The stale generation is fenced out of every write.",
    budget: "Consumes one attempt; the replacement generation owns the job.",
    consumes: true,
  },
];

const pipelineSample = `worker.handle("report.publish", async (payload, ctx) => {
  const extracted = await ctx.checkpoint("extract", () =>
    warehouse.extract(payload.month),
  );

  // Lease and slot released for the whole window.
  await ctx.sleep("settle", 15 * 60_000);

  const rendered = await ctx.checkpoint("render", () => renderer.render(extracted));
  const published = await ctx.checkpoint("publish", () => cdn.publish(rendered));

  return published;
});`;

/**
 * The trace of one durable job, from enqueue to result.
 *
 * It is deliberately a single job rather than a state diagram: the point the
 * hero has to land is that a crash and a fifteen-minute wait are ordinary
 * events in one job's life, and that the charge is paid for exactly once
 * across both. Everything shown here is behaviour documented in
 * /docs/durable-execution.
 */
const trace: readonly {
  marker: string;
  event: string;
  detail: string;
  tone?: "run" | "break" | "replay" | "wait" | "done";
}[] = [
  {
    marker: "enqueue",
    event: 'enqueue("report.publish")',
    detail: "Committed by your transaction, alongside your own rows.",
  },
  {
    marker: "attempt 1",
    event: 'checkpoint("extract")',
    detail: "Ran, and committed its result under fence 1.",
    tone: "run",
  },
  {
    marker: "",
    event: "process killed",
    detail: "No completion, no rollback of the checkpoint. The lease simply expires.",
    tone: "break",
  },
  {
    marker: "attempt 2",
    event: 'checkpoint("extract")',
    detail: "Replayed from storage. The warehouse is not queried a second time.",
    tone: "replay",
  },
  {
    marker: "",
    event: 'sleep("settle", 15m)',
    detail: "Lease and worker slot released. The wait consumes no attempt.",
    tone: "wait",
  },
  {
    marker: "",
    event: 'checkpoint("publish")',
    detail: "Handler restarted from its entry point and continued past the wait.",
    tone: "run",
  },
  {
    marker: "outcome",
    event: "succeeded",
    detail: "Result persisted, attempt history closed, evidence queryable.",
    tone: "done",
  },
];

const traceDot: Record<string, string> = {
  run: "bg-signal-500",
  break: "bg-fd-muted-foreground/70",
  replay: "bg-safety-500",
  wait: "bg-signal-300",
  done: "bg-safety-500",
  neutral: "bg-fd-muted-foreground/40",
};

function DurableTrace() {
  return (
    <div className="wh-panel overflow-hidden rounded-xl">
      <div className="wh-frame-bar flex items-center justify-between px-4 py-2.5 sm:px-5">
        <span className="wh-mono-label">one job · one logical attempt budget</span>
        <span className="font-mono text-[11px] text-fd-muted-foreground">trace</span>
      </div>

      <ol className="px-4 py-2 sm:px-5">
        {trace.map((step, index) => (
          <li key={step.event + index} className="grid grid-cols-[4.5rem_auto_1fr] gap-x-3">
            {/* Marker column: only the rows that open a new phase are labelled. */}
            <span className="pt-3 text-right font-mono text-[10.5px] uppercase tracking-[0.1em] text-fd-muted-foreground">
              {step.marker}
            </span>

            {/* The rail. A continuous line with one node per event. */}
            <span aria-hidden className="relative flex w-3 justify-center">
              <span
                className={`absolute inset-y-0 w-px ${
                  index === 0
                    ? "top-4"
                    : index === trace.length - 1
                      ? "bottom-[calc(100%-1rem)]"
                      : ""
                } bg-[var(--wh-rule)]`}
              />
              <span
                className={`relative mt-[0.9rem] size-[7px] shrink-0 rounded-full ${
                  traceDot[step.tone ?? "neutral"]
                } ${step.tone === "break" ? "ring-2 ring-fd-background" : ""}`}
              />
            </span>

            <div className="py-2.5">
              <p className="font-mono text-[12.5px] font-medium tracking-tight">{step.event}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-fd-muted-foreground">
                {step.detail}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <p className="wh-frame-bar wh-rule border-t px-4 py-3 text-[12.5px] leading-relaxed text-fd-muted-foreground sm:px-5">
        Two attempts, one crash, one fifteen-minute wait — and{" "}
        <span className="text-fd-foreground">the warehouse was queried once.</span>
      </p>
    </div>
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

/**
 * The capability matrix. Grouped the way the documentation is grouped, so a
 * reader who scans a band here knows exactly which section to open next.
 */
const capabilities: readonly {
  band: string;
  href: string;
  blurb: string;
  items: readonly { title: string; body: string }[];
}[] = [
  {
    band: "Producing work",
    href: "/docs/enqueue",
    blurb: "Everything that creates work does it inside a transaction you already own.",
    items: [
      {
        title: "Transactional enqueue",
        body: "Pass your active client and the job is written by the same transaction as your data. No dual write, no outbox relay to operate.",
      },
      {
        title: "Atomic batch enqueue",
        body: "Up to 1,000 mixed requests share one classification timestamp, return ids in input order, and roll back together.",
      },
      {
        title: "Retained idempotency",
        body: "A key, a scope, and a TTL. Replaying a request returns the original job; a materially different replay raises a typed conflict instead of accepting half a batch.",
      },
      {
        title: "Persisted retry policy",
        body: "Fixed, exponential, or decorrelated-jitter backoff, validated and normalized by PostgreSQL so every client behaves identically.",
      },
      {
        title: "Database-owned deadlines",
        body: "Absolute enqueue deadlines and per-attempt execution timeouts are evaluated in SQL, so a partitioned worker cannot keep an expired attempt alive.",
      },
      {
        title: "Queues, tags, and controls",
        body: "Named queues with pause, resume, and atomic purge. Up to 20 GIN-indexed tags per job for overlap and containment filters.",
      },
    ],
  },
  {
    band: "Executing work",
    href: "/docs/workers",
    blurb: "The durable primitives available inside an attempt, and who owns each transition.",
    items: [
      {
        title: "Fenced ownership",
        body: "Every claim increments a monotonic fence token. A resumed worker whose lease already expired cannot complete, fail, checkpoint, or heartbeat over the attempt that replaced it.",
      },
      {
        title: "FIFO claims under load",
        body: "Ready work is claimed FOR UPDATE SKIP LOCKED against a monotonic sequence, one statement per claim, with bounded promotion off a selective index.",
      },
      {
        title: "Immutable checkpoints",
        body: "Named restart boundaries up to 1 MiB. A committed checkpoint is replayed rather than re-executed after a retry, a restart, or a durable wait.",
      },
      {
        title: "Lease-releasing timer waits",
        body: "sleep and sleepUntil commit a named PostgreSQL timer, hand the lease and worker slot back, and resume in the same logical attempt — up to 365 days later.",
      },
      {
        title: "Bounded progress",
        body: "Latest-value operational projection, fenced to the owning attempt, rate limited to one changed write per 100 ms, and kept out of the immutable payload and result.",
      },
      {
        title: "Cooperative cancellation",
        body: "Cancellation, deadlines, and execution timeouts all arrive on the handler's AbortSignal, and are acknowledged only by the fence generation that owns the attempt.",
      },
    ],
  },
  {
    band: "Operating",
    href: "/docs/operations",
    blurb: "Evidence you can query, and destructive actions that leave an audit trail.",
    items: [
      {
        title: "Immutable history",
        body: "Append-only lifecycle events and one closed attempt-history row per logical attempt, time-partitioned and retired on a retention window rather than rewritten.",
      },
      {
        title: "Operator reads that never fight dispatch",
        body: "Cursor-based cross-state listing runs on a dedicated projection with its own indexes, with payload omitted by default plus redaction and a byte ceiling.",
      },
      {
        title: "Merged timelines",
        body: "Retained lifecycle events and closed attempts merge into one latest-first cursor stream, so a single read explains what happened to a job.",
      },
      {
        title: "Audited redrive",
        body: "Dead letters stay in the cold relation. Redrive requires an actor, a reason, and a request identity, and keeps retained lineage back to the failure it replaced.",
      },
      {
        title: "Durable worker fleet",
        body: "Workers register and refresh in the database, so an operator process elsewhere can list the fleet and request a cooperative, durable pause.",
      },
      {
        title: "Attribution-safe retention",
        body: "One database-wide policy drives bounded automated retention passes, with per-phase telemetry for rows affected, duration, lock skips, and errors.",
      },
    ],
  },
];

function CapabilityBand({ band }: { band: (typeof capabilities)[number] }) {
  return (
    <section className="wh-rule border-t pt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 className="text-[19px] font-semibold tracking-tight">{band.band}</h3>
        <Link
          href={band.href}
          className="wh-link-underline font-mono text-[12.5px] text-fd-muted-foreground"
        >
          {band.href}
        </Link>
      </div>
      <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-fd-muted-foreground">
        {band.blurb}
      </p>
      <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-3">
        {band.items.map((item) => (
          <div key={item.title} className="wh-cell">
            <h4 className="flex items-baseline gap-2 text-[14.5px] font-medium tracking-tight">
              <span aria-hidden className="wh-pip translate-y-[-2px]" />
              {item.title}
            </h4>
            <p className="mt-2 text-[13.5px] leading-relaxed text-fd-muted-foreground">
              {item.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

const integrations = [
  {
    name: "@workhorse/core",
    body: "Queue, Worker, schema installation, the worker-process runtime, and the CLI.",
    href: "/reference",
  },
  {
    name: "@workhorse/drizzle",
    body: "Adapts Drizzle databases and caller-owned transactions. Your transaction still owns the commit.",
    href: "/docs/drizzle",
  },
  {
    name: "@workhorse/hono",
    body: "Typed middleware, workers started once per process, and an idempotent draining shutdown.",
    href: "/docs/hono",
  },
  {
    name: "@workhorse/dashboard",
    body: "An embeddable React operator UI with an injected, transport-neutral client boundary.",
    href: "/docs/dashboard",
  },
];

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

function Hero(): ReactNode {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden className="wh-grid-field pointer-events-none absolute inset-0" />
      <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-14 sm:pt-20 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,29rem)] lg:items-start lg:gap-14">
          <div>
            <p className="wh-mono-label">PostgreSQL 15+ · no extension · no broker</p>
            <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.06] tracking-[-0.03em] sm:text-[3.25rem]">
              Durable execution that lives in{" "}
              <span className="wh-accent-text">the transaction that created it.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
              Workhorse is a PostgreSQL-native job protocol. Enqueue commits with your rows,
              PostgreSQL owns claims, fences, deadlines and retries, and every attempt leaves
              immutable evidence you can query later. No Redis, no sidecar scheduler, no second
              source of truth.
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
              <span className="wh-accent-text">$</span> npm i @workhorse/core
            </p>
          </div>

          <DurableTrace />
        </div>

        <dl className="mt-14 grid grid-cols-2 gap-y-6 sm:grid-cols-4">
          <Stat value="1" label="Dependency: PostgreSQL 15+" />
          <Stat value="0" label="Extensions required" />
          <Stat value="25" label="Default attempt budget" />
          <Stat value="2" label="Append-only evidence streams" />
        </dl>
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <>
      <Hero />

      {/* ---------- Durable execution ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 py-16 lg:px-8">
        <Rule label="01 / durable execution" />
        <div className="mt-10 max-w-3xl">
          <SectionHeading
            index="The model"
            title="Handlers restart from the top. Chosen boundaries do not."
            lede="There is no persisted JavaScript stack and no deterministic replay runtime to fight. A handler that resumes runs from its entry point again — so Workhorse makes the parts you name durable, and tells you plainly that everything else can execute twice."
          />
        </div>

        <div className="mt-10 grid gap-10 lg:grid-cols-3 lg:gap-12">
          {primitives.map((primitive) => (
            <div key={primitive.name} className="wh-rule border-t pt-5">
              <p className="font-mono text-[13px] font-medium tracking-tight">{primitive.name}</p>
              <p className="mt-2.5 text-[14px] leading-relaxed text-fd-muted-foreground">
                {primitive.body}
              </p>
              <p className="wh-mono-label mt-3">{primitive.limit}</p>
            </div>
          ))}
        </div>

        <div className="mt-14 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-14">
          <div>
            <h3 className="text-[19px] font-semibold tracking-tight">
              What each interruption costs you
            </h3>
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-fd-muted-foreground">
              A durable wait is not a retry. This is the distinction most queues blur, and it is the
              reason a month-long wait costs nothing.
            </p>

            <div className="wh-panel mt-6 overflow-hidden rounded-xl">
              <div className="wh-frame-bar wh-rule hidden border-b px-5 py-2.5 sm:grid sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-6">
                <span className="wh-mono-label">interruption</span>
                <span className="wh-mono-label">checkpoints</span>
                <span className="wh-mono-label">attempt budget</span>
              </div>
              {survival.map((row) => (
                <div
                  key={row.event}
                  className="wh-rule grid gap-1.5 border-t px-5 py-4 first:border-t-0 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-6 sm:border-t"
                >
                  <p className="font-mono text-[12.5px] font-medium tracking-tight">{row.event}</p>
                  <p className="text-[13.5px] leading-relaxed text-fd-muted-foreground">
                    {row.checkpoints}
                  </p>
                  <p className="text-[13.5px] leading-relaxed text-fd-muted-foreground">
                    <span
                      aria-hidden
                      className="wh-pip mr-2 align-middle"
                      data-state={row.consumes ? "partial" : undefined}
                    />
                    {row.budget}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-[19px] font-semibold tracking-tight">A durable pipeline</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-fd-muted-foreground">
              Split long work into idempotent stages, wrap each completed effect in a named
              checkpoint, and put lease-releasing waits between stages that need real time to pass.
            </p>
            <div className="mt-6">
              <CodeSample code={pipelineSample} title="report.publish.ts" meta="typescript" />
            </div>
            <p className="mt-4 text-[13.5px] leading-relaxed text-fd-muted-foreground">
              Assume everything before a wait can execute again, and keep each active stage under
              roughly 110 seconds so rolling deploys stay safe.{" "}
              <Link href="/docs/durable-execution" className="wh-link-underline">
                Durable checkpoints and waits
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* ---------- The protocol, one tab per phase ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <Rule label="02 / the whole lifecycle" />
        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-14">
          <SectionHeading
            index="Five calls, one database"
            title="Produce, execute, schedule, operate, deploy."
            lede="There is no second system to reason about. The same connection that stores your rows stores the work, the evidence, and the schedule — and the same SQL functions enforce the rules for every client."
          />
          <CodeTabs name="tour" tabs={tour} meta="typescript" />
        </div>
      </section>

      {/* ---------- Capability matrix ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <Rule label="03 / what is actually in the box" />
        <div className="mt-10">
          <SectionHeading
            index="Capabilities"
            title="Documented behaviour, not a roadmap."
            lede={
              <>
                Everything below is exposed through the current SQL or TypeScript contract and
                covered by live PostgreSQL integration tests. The repository keeps the authoritative{" "}
                <a
                  href={`${siteConfig.github}/blob/main/docs/features.md`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="wh-link-underline"
                >
                  feature matrix
                </a>
                , including everything that is only partial today.
              </>
            }
          />
        </div>
        <div className="mt-12 space-y-12">
          {capabilities.map((band) => (
            <CapabilityBand key={band.band} band={band} />
          ))}
        </div>
      </section>

      {/* ---------- Packages ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <Rule label="04 / packages" />
        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-14">
          <SectionHeading
            index="Four packages"
            title="The core keeps one dependency."
            lede="Every integration is a separate package, so adopting Drizzle, Hono, or the dashboard never adds a dependency to the protocol itself. None of them hide the transaction."
          />
          <dl className="wh-panel overflow-hidden rounded-xl">
            {integrations.map((pkg) => (
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
            note="Schema, first job, first worker."
          />
          <Tile
            href="/reference"
            label="API reference"
            note="Queue, Worker, and process runner surface."
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
