import type { Metadata } from "next";
import Link from "next/link";
import { CodeSample } from "@/components/code-sample";
import { SectionHeading } from "@/components/primitives";
import { demoUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Demo",
  description:
    "Run the Workhorse demo locally or open the hosted instance: transactional enqueue, workers, retries, failures, recurring jobs, durable checkpoints, and the operator dashboard.",
  alternates: { canonical: "/demo" },
};

const localCode = `git clone https://github.com/stablemates/workhorse
cd workhorse
pnpm install

# Recreates the purpose-guarded workhorse_demo database, installs the
# schema, builds the runtime, starts the worker, and serves the dashboard.
pnpm demo

# Then open http://workhorse.localhost:43155/tasks`;

const seedCode = `# Start with an empty console instead of seeded evidence.
SEED_DEMO_DATA=false pnpm demo

# Point the demo at a different database.
WORKHORSE_DEMO_DATABASE_URL=postgres://... pnpm demo`;

const walkthrough = [
  {
    step: "01",
    title: "Enqueue inside a transaction",
    body: "Create an order in the demo app. The order row and its job commit together, so a rolled-back order never leaves orphaned work behind.",
  },
  {
    step: "02",
    title: "Watch a claim take ownership",
    body: "The task drawer shows the claiming worker, the attempt number, and the fence token. A second worker cannot write over that generation.",
  },
  {
    step: "03",
    title: "Fail something on purpose",
    body: "Three seeded jobs fail persistently at configured stage boundaries and retry at roughly 5, 7, and 10 minutes. Their earlier checkpoints are never re-executed.",
  },
  {
    step: "04",
    title: "Inspect immutable evidence",
    body: "Each attempt keeps its own finalized row, and the merged timeline interleaves lifecycle events with closed attempts, latest first.",
  },
  {
    step: "05",
    title: "Cancel active work",
    body: "Cancellation reaches the handler's AbortSignal. The demo handlers observe it, settle promptly, and record exactly one canceled attempt.",
  },
  {
    step: "06",
    title: "Redrive a dead letter",
    body: "Redrive requires an actor, a reason, and a request identity. The original failure stays immutable and the new job keeps retained lineage back to it.",
  },
];

export default function DemoPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-14 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start lg:gap-14">
        <div>
          <p className="wh-mono-label">Demo</p>
          <h1 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Watch the protocol behave under failure.
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
            The demo is the honest version of a benchmark: a working service that enqueues
            transactionally, retries on a persisted policy, fails on purpose, and exposes every
            attempt through the operator dashboard. Nothing in it is mocked.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href={demoUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-lg bg-fd-foreground px-4 py-2.5 text-[14px] font-medium text-fd-background transition-colors hover:bg-fd-foreground/85"
            >
              <span className="wh-status-dot" aria-hidden />
              Open the hosted demo
            </a>
            <Link
              href="/docs/quickstart"
              className="wh-rule inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[14px] font-medium transition-colors hover:bg-fd-muted"
            >
              Build it yourself
            </Link>
          </div>

          <p className="mt-5 font-mono text-[12px] text-fd-muted-foreground">{demoUrl}</p>
        </div>

        <div className="wh-panel overflow-hidden rounded-xl">
          <div className="wh-frame-bar px-5 py-2.5">
            <span className="wh-mono-label">What the instance runs</span>
          </div>
          <dl className="divide-y divide-[color:var(--wh-rule)]">
            {[
              ["Database", "PostgreSQL 15+, no extension"],
              ["Runtime", "Node 22+, one Hono process"],
              ["Workers", "In-process, advisory-lock coordinated"],
              ["Scheduler", "Worker-owned cron, no sidecar"],
              ["Dashboard", "@workhorse/dashboard, injected client"],
              ["Seed data", "Successful, retried, and failing jobs"],
            ].map(([term, value]) => (
              <div key={term} className="flex items-baseline justify-between gap-4 px-5 py-3">
                <dt className="wh-mono-label">{term}</dt>
                <dd className="text-right text-[13.5px] text-fd-muted-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <section className="mt-16">
        <SectionHeading
          index="01 / walkthrough"
          title="Six things worth doing once you are in."
          lede="The seeded data exists so failure paths are populated immediately. You do not have to wait for something to break to see how it is recorded."
        />
        <ol className="mt-8 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
          {walkthrough.map((item) => (
            <li key={item.step} className="wh-rule border-t pt-4">
              <p className="wh-mono-label">{item.step}</p>
              <h3 className="mt-2 text-[15px] font-semibold tracking-tight">{item.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-fd-muted-foreground">
                {item.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-16 grid gap-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-14">
        <SectionHeading
          index="02 / local"
          title="Run it on your own machine."
          lede="One command recreates the purpose-guarded demo database, installs the schema, builds the runtime, starts the worker, and serves the dashboard from source. Destructive tooling verifies the _demo suffix and refuses remote hosts."
        />
        <div className="space-y-4">
          <CodeSample code={localCode} lang="bash" title="terminal" />
          <CodeSample code={seedCode} lang="bash" title="overrides" />
        </div>
      </section>

      <section className="wh-panel mt-16 rounded-xl p-6 sm:p-8">
        <p className="wh-mono-label">Read this before drawing conclusions</p>
        <p className="mt-3 max-w-3xl text-[14.5px] leading-relaxed text-fd-muted-foreground">
          The demo demonstrates semantics, not throughput. Small runs are smoke tests.
          Publication-grade performance evidence needs larger retained history horizons,
          production-shaped payloads, stable hardware, reference systems, and preserved raw results,
          all of which the benchmark runbook spells out.
        </p>
        <div className="mt-6">
          <Link href="/docs" className="wh-link-underline text-[14px] font-medium">
            Benchmarking runbook and limitations
          </Link>
        </div>
      </section>
    </div>
  );
}
