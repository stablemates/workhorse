import type { ReactNode } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { CodeSample } from "@/components/code-sample";
import { Rule, SectionHeading } from "@/components/primitives";
import { demoUrl, siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: `${siteConfig.name} — ${siteConfig.tagline}` },
  description: siteConfig.description,
  alternates: { canonical: "/" },
};

const enqueueSample = `import { Pool } from "pg";
import { installSchema, Queue } from "@workhorse/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);

const queue = new Queue(pool);

// One client owns the whole boundary: the job commits with your rows,
// and a rollback removes both.
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("INSERT INTO account (id) VALUES ($1)", [accountId]);
  await queue.enqueue("account.provision", { accountId }, {}, client);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}`;

const workerSample = `const worker = new Worker(queue, {
  workerId: "billing-1",
  concurrency: 8,
  scheduleNamespaces: ["billing-production"],
}).handle("invoice.capture", async (payload, { checkpoint, sleep, signal }) => {
  // Immutable evidence: a committed checkpoint never replays after a restart.
  const charge = await checkpoint("provider-charge", async () => {
    return capture(payload.invoiceId, { idempotencyKey: payload.invoiceId });
  });

  // Releases the lease and the worker slot, then resumes in the same attempt.
  await sleep("settlement-window", 60_000);

  signal.throwIfAborted(); // cooperative cancellation
  return charge;
});

await worker.run();`;

/** One row of the runtime state ladder. */
function StateRow({
  state,
  owner,
  note,
  tone = "neutral",
}: {
  state: string;
  owner: string;
  note: string;
  tone?: "neutral" | "active" | "terminal";
}) {
  return (
    <div className="wh-rule grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t px-4 py-3 text-[13px] first:border-t-0 sm:grid-cols-[auto_minmax(0,7rem)_minmax(0,9rem)_1fr] sm:px-5">
      <span
        aria-hidden
        className={
          tone === "active"
            ? "wh-status-dot"
            : tone === "terminal"
              ? "size-2 rounded-full bg-fd-muted-foreground/50"
              : "size-2 rounded-full bg-signal-500/70"
        }
      />
      <span className="font-mono font-medium tracking-tight">{state}</span>
      <span className="font-mono text-[12px] text-fd-muted-foreground">{owner}</span>
      <span className="col-span-3 pl-6 text-fd-muted-foreground sm:col-span-1 sm:pl-0">{note}</span>
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

function Guarantee({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="wh-rule border-t pt-5">
      <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-[14px] leading-relaxed text-fd-muted-foreground">{children}</p>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      {/* ---------- Hero: a runtime relation, not a three-card grid ---------- */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="wh-grid-field pointer-events-none absolute inset-0" />
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-14 sm:pt-20 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,29rem)] lg:items-start lg:gap-14">
            <div>
              <p className="wh-mono-label">PostgreSQL 15+ · no extension · no broker</p>
              <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.06] tracking-[-0.03em] sm:text-[3.25rem]">
                Durable execution that lives in the transaction that created it.
              </h1>
              <p className="mt-6 max-w-2xl text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
                Workhorse is a PostgreSQL-native job protocol. Enqueue commits with your rows,
                PostgreSQL owns claims, fences, deadlines and retries, and every attempt leaves
                immutable evidence you can query later. No Redis, no sidecar scheduler, no second
                source of truth.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/docs"
                  className="inline-flex items-center gap-2 rounded-lg bg-fd-foreground px-4 py-2.5 text-[14px] font-medium text-fd-background transition-colors hover:bg-fd-foreground/85"
                >
                  Read the docs
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

            {/* The real relations and their real states, with the owner of each move. */}
            <div className="wh-panel overflow-hidden rounded-xl">
              <div className="wh-frame-bar flex items-center justify-between px-4 py-2.5 sm:px-5">
                <span className="wh-mono-label">workhorse.job_runtime — live</span>
                <span className="font-mono text-[11px] text-fd-muted-foreground">owner</span>
              </div>
              <div>
                <StateRow
                  state="scheduled"
                  owner="postgres"
                  note="Not before its run_at. Retries and durable waits land here too."
                />
                <StateRow
                  state="ready"
                  owner="your txn"
                  note="Committed with your write, or promoted once due."
                />
                <StateRow
                  state="active"
                  owner="postgres"
                  tone="active"
                  note="Claimed FOR UPDATE SKIP LOCKED with a fence token."
                />
              </div>

              <div className="wh-frame-bar wh-rule flex items-center justify-between border-t px-4 py-2.5 sm:px-5">
                <span className="wh-mono-label">workhorse.job_outcome — cold</span>
                <span className="font-mono text-[11px] text-fd-muted-foreground">immutable</span>
              </div>
              <div>
                <StateRow
                  state="succeeded"
                  owner="cold store"
                  tone="terminal"
                  note="Persisted result plus a finalized attempt row."
                />
                <StateRow
                  state="failed"
                  owner="cold store"
                  tone="terminal"
                  note="Attempt budget exhausted. Redrive is audited and linked."
                />
                <StateRow
                  state="canceled"
                  owner="cold store"
                  tone="terminal"
                  note="Cooperative request materialized exactly once."
                />
              </div>
            </div>
          </div>

          <dl className="mt-14 grid grid-cols-2 gap-y-6 sm:grid-cols-4">
            <Stat value="1" label="Dependency: PostgreSQL 15+" />
            <Stat value="0" label="Extensions required" />
            <Stat value="25" label="Default attempt budget" />
            <Stat value="2" label="Append-only evidence streams" />
          </dl>
        </div>
      </section>

      {/* ---------- Transactional enqueue ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 py-16 lg:px-8">
        <Rule label="01 / enqueue" />
        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:gap-14">
          <SectionHeading
            index="Transactional by construction"
            title="If the row rolls back, the job never existed."
            lede="Pass your active client into enqueue and the job is written by the same transaction as your data. There is no dual write to reconcile, no outbox relay to operate, and no window where a customer row exists without its work."
          />
          <CodeSample code={enqueueSample} title="enqueue.ts" meta="server" />
        </div>
      </section>

      {/* ---------- Handlers ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <Rule label="02 / execute" />
        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,23rem)] lg:gap-14">
          <CodeSample code={workerSample} title="worker.ts" meta="server" />
          <SectionHeading
            index="Durable handlers"
            title="Checkpoints, timer waits, and cooperative cancellation."
            lede="A committed checkpoint is replayed rather than re-executed. A durable sleep gives the lease back so the worker slot is free while a settlement window elapses. Cancellation arrives on the handler's AbortSignal and is acknowledged only by the exact fence generation that owns the attempt."
          />
        </div>
      </section>

      {/* ---------- Guarantees ---------- */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-20 lg:px-8">
        <Rule label="03 / guarantees" />
        <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          <Guarantee title="Fenced ownership">
            Every claim increments a monotonic fence token. A resumed worker whose lease already
            expired cannot complete, fail, checkpoint, or heartbeat over the attempt that replaced
            it.
          </Guarantee>
          <Guarantee title="Database-owned deadlines">
            Absolute enqueue deadlines and per-attempt execution timeouts are evaluated by
            PostgreSQL, so a partitioned or paused worker cannot keep an expired attempt alive.
          </Guarantee>
          <Guarantee title="Immutable history">
            Lifecycle events and finalized attempts are append-only and time-partitioned. Terminal
            outcomes cannot be overwritten by late writers from a stale generation. History is
            retired on a configured retention window, never rewritten.
          </Guarantee>
          <Guarantee title="Deploy-synchronized schedules">
            Recurring jobs are declared in code and synchronized into the target database at deploy
            time. Names omitted from a namespace are disabled atomically, and a stale revision
            cannot fire new payloads.
          </Guarantee>
          <Guarantee title="Audited redrive">
            Dead letters stay in a cold relation. Redrive requires an actor, a reason, and a request
            identity, copies only the safe fields, and keeps retained lineage back to the failure it
            replaced.
          </Guarantee>
          <Guarantee title="Honest at-least-once">
            Delivery is at least once and cancellation is cooperative. Workhorse documents where
            your handler still needs provider idempotency instead of promising exactly-once effects.
          </Guarantee>
        </div>
      </section>

      {/* ---------- Where to go ---------- */}
      <section className="wh-rule border-t">
        <div className="mx-auto grid w-full max-w-6xl gap-px px-5 py-14 sm:grid-cols-3 lg:px-8">
          {[
            {
              href: "/docs/quickstart",
              label: "Quickstart",
              note: "Schema, first job, first worker.",
            },
            {
              href: "/reference",
              label: "API reference",
              note: "Queue, Worker, and process runner surface.",
            },
            {
              href: "/integrations",
              label: "Integrations",
              note: "Drizzle, Hono, and the operator dashboard.",
            },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="group rounded-lg px-4 py-4 transition-colors hover:bg-fd-muted sm:px-5"
            >
              <p className="flex items-center gap-2 text-[15px] font-medium tracking-tight">
                {item.label}
                <span
                  aria-hidden
                  className="wh-accent-text translate-x-0 transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </p>
              <p className="mt-1 text-[14px] text-fd-muted-foreground">{item.note}</p>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
