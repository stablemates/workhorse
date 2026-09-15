import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { useState, type ReactNode } from "react";

import { baseOptions } from "@/app/layout.config";
import { type CodeTab, CodeTabs } from "@/components/code-sample";
import {
  BatchDiagram,
  CancellationDiagram,
  CrashDiagram,
  DashboardEmbeddingDiagram,
  DeadLettersDiagram,
  DebounceDiagram,
  DependenciesDiagram,
  ExternalWaitsDiagram,
  FleetOperationsDiagram,
  FlowControlDiagram,
  IdempotencyDiagram,
  RetriesDiagram,
  SchedulesDiagram,
  SleepDiagram,
} from "@/components/landing-diagrams";
import { Rule } from "@/components/primitives";
import { SiteFooter } from "@/components/site-footer";
import { TheDerby } from "@/components/the-derby";
import { integrations } from "@/lib/integrations";
import {
  landingFeatureSnippets,
  landingSupplementalSnippets,
  type LandingFeatureSnippetId,
  type LandingSnippetId,
} from "@/lib/landing-snippets";
import { demoUrl, publisherReference, siteConfig } from "@/lib/site";

/*
 * Snippet sources live in `lib/landing-snippets.ts` and arrive here as
 * build-time-highlighted markup. The rule from that file holds for this one
 * too: verify every claim against the source before writing it.
 */

export const Route = createFileRoute("/")({
  head: () => {
    const title = `${siteConfig.name}: ${siteConfig.tagline}`;

    return {
      meta: [
        { title },
        { name: "description", content: siteConfig.description },
        { property: "og:url", content: siteConfig.url },
        { property: "og:title", content: title },
        { property: "og:description", content: siteConfig.description },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: siteConfig.description },
      ],
      links: [
        { rel: "canonical", href: siteConfig.url },
        // The landing page is where an agent most often starts, and its HTML is
        // about seven times its own text. `scripts/gen-landing-twin.ts` derives
        // the Markdown form from the built page; this link is how an agent
        // finds it without reading the whole page to reach the footer.
        { rel: "alternate", type: "text/markdown", href: `${siteConfig.url}/index.md` },
      ],
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: siteConfig.name,
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Cross-platform",
            description: siteConfig.description,
            url: siteConfig.url,
            image: siteConfig.socialImage,
            codeRepository: siteConfig.github,
            license: "https://www.apache.org/licenses/LICENSE-2.0",
            sameAs: [siteConfig.github, siteConfig.npm, siteConfig.pypi, siteConfig.goModule],
            publisher: publisherReference,
          }),
        },
      ],
    };
  },
  component: HomePage,
});

/**
 * The main exhibit: one scrolling section per feature. The code is the
 * argument; each section pairs it with a small diagram of the guarantee.
 */
interface Feature {
  id: string;
  kicker: string;
  title: string;
  lede: ReactNode;
  snippet: LandingFeatureSnippetId;
  file: string;
  href: string;
  linkLabel: string;
  diagram: ReactNode;
}

const features: readonly Feature[] = [
  {
    id: "checkpoints",
    kicker: "checkpoints",
    title: "Crash mid-task. Finish anyway.",
    lede: (
      <>
        Wrap each completed stage in a named <code>checkpoint</code>. When a retry or restart runs
        the handler again, completed checkpoints return their stored result instead of re-executing.
        Use a provider idempotency key for external effects: a crash can happen after the charge
        succeeds but before its checkpoint is saved.
      </>
    ),
    file: "invoice.ts",
    snippet: "checkpoints",
    href: "/docs/durable-execution",
    linkLabel: "Durable execution",
    diagram: <CrashDiagram />,
  },
  {
    id: "durable-sleep",
    kicker: "durable sleep",
    title: "Sleep for an hour or a month without holding a worker.",
    lede: (
      <>
        TypeScript&apos;s <code>ctx.sleep</code>, Python&apos;s <code>context.sleep</code>, and
        Go&apos;s <code>handler.Sleep</code> commit a named timer in PostgreSQL and give the worker
        slot back. When the timer is due, the handler restarts and its checkpoints replay.
      </>
    ),
    file: "settle-order.ts",
    snippet: "sleep",
    href: "/docs/durable-execution",
    linkLabel: "Checkpoints and durable waits",
    diagram: <SleepDiagram />,
  },
  {
    id: "retries",
    kicker: "retries and deadlines",
    title: "Retry on a policy. Stop at a deadline.",
    lede: (
      <>
        The retry policy is stored with the task and enforced by PostgreSQL, so every worker backs
        off identically. <code>executionTimeoutMs</code>, <code>execution_timeout_ms</code>, and{" "}
        <code>ExecutionTimeoutMS</code> bound one attempt, while the deadline bounds the whole task.
      </>
    ),
    file: "reminder.ts",
    snippet: "retries",
    href: "/docs/retries",
    linkLabel: "Retries",
    diagram: <RetriesDiagram />,
  },
  {
    id: "idempotency",
    kicker: "idempotency",
    title: "Replay the request, get the same task.",
    lede: (
      <>
        Give an enqueue a key and a scope, and replaying it returns the original task id instead of
        creating a duplicate. A replay with a materially different payload raises a typed conflict.
        It never creates a silent second task.
      </>
    ),
    file: "capture.ts",
    snippet: "idempotency",
    href: "/docs/idempotency",
    linkLabel: "Idempotent enqueue",
    diagram: <IdempotencyDiagram />,
  },
  {
    id: "schedules",
    kicker: "schedules",
    title: "Scheduled tasks, no scheduler process.",
    lede: (
      <>
        Declare schedules as code and sync them on every deploy. The sync treats its namespace as
        authoritative. A schedule you stop shipping is disabled atomically. Workers evaluate and
        fire due schedules in-process; there is no separate service to run.
      </>
    ),
    file: "deploy.ts",
    snippet: "schedules",
    href: "/docs/schedules",
    linkLabel: "Schedules",
    diagram: <SchedulesDiagram />,
  },
  {
    id: "flow-control",
    kicker: "flow control",
    title: "Throttle by queue, tenant, or key.",
    lede: (
      <>
        Concurrency and rate-limit policies live in the database, so they bind the whole fleet.
        Tasks supply <code>concurrencyKey</code>, <code>concurrency_key</code>, or{" "}
        <code>ConcurrencyKey</code> to keep one tenant from starving the rest.
      </>
    ),
    file: "policies.ts",
    snippet: "flowControl",
    href: "/docs/concurrency-policies",
    linkLabel: "Concurrency policies",
    diagram: <FlowControlDiagram />,
  },
  {
    id: "dependencies",
    kicker: "dependencies and children",
    title: "Release downstream work only when its inputs settle.",
    lede: (
      <>
        Producers can declare prerequisites, and handlers can create named child tasks then join
        their results. Parents and dependents leave dispatch while they wait, so orchestration uses
        no worker slot and survives every restart.
      </>
    ),
    file: "checkout.ts",
    snippet: "dependencies",
    href: "/docs/task-dependencies",
    linkLabel: "Dependencies and child tasks",
    diagram: <DependenciesDiagram />,
  },
  {
    id: "coalescing",
    kicker: "debounce and throttle",
    title: "Absorb repeated work without hiding what happened.",
    lede: (
      <>
        Debounce replaces a pending payload while updates settle. <code>enqueueWithResult</code>,{" "}
        <code>enqueue_with_result</code>, and <code>EnqueueWithResult</code> return the retained
        task and a typed outcome, so diagnostics show whether Workhorse replaced or coalesced it.
      </>
    ),
    file: "indexing.ts",
    snippet: "coalescing",
    href: "/docs/debounce",
    linkLabel: "Debounce and throttle",
    diagram: <DebounceDiagram />,
  },
  {
    id: "external-waits",
    kicker: "signals and human waits",
    title: "Wait for another system or a person, while holding nothing.",
    lede: (
      <>
        Signals carry application events, while human waits carry stored decision context into an
        authenticated operator surface. Both release the lease, then restart the handler with one
        retained, idempotently delivered result.
      </>
    ),
    file: "approval.ts",
    snippet: "externalWaits",
    href: "/docs/signals",
    linkLabel: "Signals and human waits",
    diagram: <ExternalWaitsDiagram />,
  },
  {
    id: "batch-handlers",
    kicker: "batch handlers",
    title: "Share the provider call, keep every task independent.",
    lede: (
      <>
        A batch handler groups tasks of one type for efficient bulk I/O. Every member keeps its own
        lease, cancellation, retry budget, and result, so one provider response does not collapse
        separate durable identities.
      </>
    ),
    file: "email-worker.ts",
    snippet: "batchHandlers",
    href: "/docs/batch-handlers",
    linkLabel: "Batch handlers",
    diagram: <BatchDiagram />,
  },
  {
    id: "cancellation",
    kicker: "cancellation",
    title: "Cancel work that is already running.",
    lede: (
      <>
        Every handler gets a cancellation primitive: <code>AbortSignal</code>,{" "}
        <code>CancellationToken</code>, or <code>context.Context</code>. Cancel requests, deadlines,
        and execution timeouts all arrive through it, so one check covers all three.
      </>
    ),
    file: "export.ts",
    snippet: "cancellation",
    href: "/docs/cancellation",
    linkLabel: "Cancellation",
    diagram: <CancellationDiagram />,
  },
  {
    id: "dead-letters",
    kicker: "dead letters",
    title: "Failures leave evidence, and redrive leaves an audit trail.",
    lede: (
      <>
        Exhausted tasks land in a cold relation with their error, attempts, and tags. Reading them
        never competes with dispatch. Redrive requires an actor, a reason, and a request id, and
        keeps lineage back to the failure it replaced.
      </>
    ),
    file: "incident.ts",
    snippet: "deadLetters",
    href: "/docs/dead-letters",
    linkLabel: "Dead letters and redrive",
    diagram: <DeadLettersDiagram />,
  },
];

/*
 * The Derby interrupts the tour after flow control: by then the reader has
 * seen retries and throttling — the mechanics the race demonstrates — and
 * the dead-letter incident teases the tour's closing feature.
 */
const derbyTourPosition = features.findIndex((feature) => feature.id === "flow-control") + 1;

const operatingNote = (
  <>
    The health check and fleet controls use the same database protocol in every SDK, so an incident
    script can use whichever language your operators already run.
  </>
);

const dashboardNote = (
  <>
    TypeScript, Python, and Go embed the same packaged dashboard through their native HTTP
    interfaces. Each host needs a database connection, with no worker runtime or extra service.
  </>
);

/** Embedded dashboard hosts, one native transport around the same browser application. */
const dashboardTabs: readonly CodeTab[] = [
  {
    label: "typescript",
    file: "app/api/[...workhorse]/route.ts",
    note: dashboardNote,
    snippet: landingSupplementalSnippets.operateDashboard.typescript,
  },
  {
    label: "python",
    file: "dashboard.py",
    note: dashboardNote,
    snippet: landingSupplementalSnippets.operateDashboard.python,
  },
  {
    label: "go",
    file: "dashboard.go",
    note: dashboardNote,
    snippet: landingSupplementalSnippets.operateDashboard.go,
  },
];

/** Operational SDK calls, grouped separately to stay within the six-tab CSS contract. */
const healthFleetTabs: readonly CodeTab[] = [
  {
    label: "health ts",
    file: "monitor.ts",
    note: operatingNote,
    snippet: landingSupplementalSnippets.operateHealth.typescript,
  },
  {
    label: "health py",
    file: "monitor.py",
    note: operatingNote,
    snippet: landingSupplementalSnippets.operateHealth.python,
  },
  {
    label: "health go",
    file: "monitor.go",
    note: operatingNote,
    snippet: landingSupplementalSnippets.operateHealth.go,
  },
  {
    label: "fleet ts",
    file: "pause-fleet.ts",
    note: operatingNote,
    snippet: landingSupplementalSnippets.operateFleet.typescript,
  },
  {
    label: "fleet py",
    file: "pause-fleet.py",
    note: operatingNote,
    snippet: landingSupplementalSnippets.operateFleet.python,
  },
  {
    label: "fleet go",
    file: "pause-fleet.go",
    note: operatingNote,
    snippet: landingSupplementalSnippets.operateFleet.go,
  },
];

/**
 * One tab per ORM adapter with the same transactional guarantee everywhere,
 * in the order `site/integrations.json` gives them. The catalog is the one
 * place an integration is added, so this page cannot list a different set from
 * the docs sidebar or the `/docs/integrations` index.
 */
const ormTabs: readonly CodeTab[] = integrations
  .filter((entry) => entry.landingSnippet)
  .map((entry) => ({
    label: entry.slug,
    file: "signup.ts",
    snippet: entry.landingSnippet as LandingSnippetId,
  }));

const deployTabs: readonly CodeTab[] = [
  {
    label: "typescript",
    file: "workhorse.worker.ts",
    snippet: landingSupplementalSnippets.deploy.typescript,
  },
  {
    label: "python",
    file: "worker.py",
    snippet: landingSupplementalSnippets.deploy.python,
  },
  {
    label: "go",
    file: "worker.go",
    snippet: landingSupplementalSnippets.deploy.go,
  },
];

/**
 * The core and the telemetry adapter are not integrations and have no catalog
 * entry. Everything else comes from `site/integrations.json`, in its order, so
 * this list cannot name a different set of packages from the docs.
 */
const packages = [
  {
    name: "@stablemates/workhorse",
    body: "Queue, Worker, schema installation, the worker-process runtime, and the CLI.",
    href: "/docs/api",
  },
  {
    name: "@stablemates/workhorse-otel",
    body: "Connects core telemetry to host-owned OpenTelemetry providers.",
    href: "/docs/operations",
  },
  ...integrations
    .filter((entry) => entry.package)
    .map((entry) => ({
      name: entry.package as string,
      body: entry.summary,
      href: `/docs/${entry.slug}`,
    })),
];

function FeatureSection({ feature, index }: { feature: Feature; index: number }) {
  const baseFile = feature.file.replace(/\.ts$/, "");
  const snippets = landingFeatureSnippets[feature.snippet];
  const tabs: readonly CodeTab[] = [
    { label: "typescript", file: feature.file, snippet: snippets.typescript },
    ...("python" in snippets && "go" in snippets
      ? [
          { label: "python", file: `${baseFile}.py`, snippet: snippets.python },
          { label: "go", file: `${baseFile}.go`, snippet: snippets.go },
        ]
      : []),
  ];
  return (
    <section id={feature.id} className="wh-rule scroll-mt-24 border-t py-14">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14">
        <div>
          <p className="inline-flex items-center gap-2 rounded-sm border wh-rule bg-fd-muted/40 px-2.5 py-1 font-mono text-[11.5px] uppercase tracking-[0.12em] text-fd-muted-foreground">
            <span className="text-(--wh-accent)">{String(index + 1).padStart(2, "0")}</span>
            <span aria-hidden className="h-3 w-px bg-(--wh-rule)" />
            {feature.kicker}
          </p>
          <h2 className="mt-4 text-balance text-2xl font-semibold leading-snug tracking-tight sm:text-[27px]">
            {feature.title}
          </h2>
          <p className="mt-3 text-pretty text-[16px] leading-relaxed text-fd-muted-foreground [&_code]:font-mono [&_code]:text-[14px] [&_code]:text-fd-foreground">
            {feature.lede}
          </p>
          <p className="mt-4">
            <a href={feature.href} className="wh-link-underline text-[15px] font-medium">
              {feature.linkLabel} →
            </a>
          </p>
        </div>
        <div className="min-w-0">
          <CodeTabs name={`feature-${feature.id}`} tabs={tabs} />
          {feature.diagram}
        </div>
      </div>
    </section>
  );
}

function HeroActions() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <a
        href="/docs/quickstart"
        className="inline-flex items-center gap-2 rounded-md bg-brand-700 px-5 py-2.5 text-[15px] font-medium text-white shadow-sm transition-colors hover:bg-brand-800 dark:bg-brand-600 dark:hover:bg-brand-700"
      >
        Build your first worker
      </a>
      <a
        href={demoUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-2 rounded-md border border-brand-700/30 bg-(--wh-panel) px-5 py-2.5 text-[15px] font-medium text-brand-800 shadow-sm transition-colors hover:border-brand-700/60 hover:bg-brand-50 dark:border-brand-300/25 dark:text-brand-200 dark:hover:border-brand-300/50 dark:hover:bg-brand-500/10"
      >
        <span className="wh-status-dot" aria-hidden />
        Live demo
      </a>
    </div>
  );
}

/**
 * The first view is a work ledger. A schema grid sits behind the copy, the
 * position line sits centered in one unbroken row, and a table of task rows
 * rolls slowly beneath it: the product's own evidence rather than a picture
 * of it. The headline's size follows the viewport so it never
 * wraps, from a phone to a wide monitor.
 */
function Hero() {
  return (
    <section className="wh-hero relative overflow-hidden">
      <div aria-hidden className="wh-hero-grid pointer-events-none absolute inset-0" />
      <div className="relative mx-auto flex w-full max-w-7xl flex-col items-center px-5 pt-16 text-center sm:pt-24 lg:px-8">
        <h1 className="text-balance text-[clamp(1.75rem,2.5vw,2.5rem)] font-semibold sm:whitespace-nowrap leading-[1.08] tracking-[-0.035em]">
          Harness <span className="wh-accent-text">the Postgres you already run.</span>
        </h1>
        <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-fd-muted-foreground sm:text-lg">
          Durable tasks and fleet-wide concurrency control, run by the database you already trust.
          No broker, no scheduler, nothing else to keep alive.
        </p>
        <div className="mt-8 flex justify-center">
          <HeroActions />
        </div>
      </div>
      <Ledger />
      <div className="relative mx-auto w-full max-w-7xl px-5 pb-6 pt-6 lg:px-8">
        <p className="mx-auto max-w-3xl text-center font-mono text-[11.5px] uppercase tracking-[0.12em] text-fd-muted-foreground sm:whitespace-nowrap">
          PostgreSQL coordinates claims, retries, waits, schedules, and recovery
        </p>
      </div>
    </section>
  );
}

/**
 * Rows for the hero ledger. The data is fixed so the server and the browser
 * render the same markup; the states and timings are the shapes a real queue
 * shows, not a live feed.
 */
const ledgerRows = [
  ["a41f09c2", "billing", "invoice.finalize", "succeeded", "1/1", "184 ms"],
  ["9be27d10", "notifications", "email.send", "succeeded", "2/5", "402 ms"],
  ["c07d3e55", "billing", "settle-order", "sleeping", "1/3", "until 09:00"],
  ["3f8a61b9", "indexing", "search.reindex", "running", "1/1", "2.1 s"],
  ["e2c4907a", "exports", "report.csv", "retried", "3/5", "backoff 40 s"],
  ["71d5b3ce", "notifications", "sms.send", "succeeded", "1/1", "96 ms"],
  ["b8e01f4d", "approvals", "refund.review", "waiting", "1/1", "for a person"],
  ["58c9a2e7", "billing", "capture", "succeeded", "1/1", "231 ms"],
  ["d63f7b08", "webhooks", "stripe.deliver", "succeeded", "2/8", "318 ms"],
  ["0a9e4c61", "indexing", "search.reindex", "waiting", "1/1", "on parent"],
  ["f47b2d93", "exports", "report.pdf", "dead letter", "5/5", "redrive ready"],
  ["2c15e8a4", "billing", "invoice.finalize", "succeeded", "1/1", "177 ms"],
  ["6ed0b97f", "schedules", "nightly.rollup", "running", "1/1", "14.8 s"],
  ["93a7c1e2", "notifications", "email.send", "succeeded", "1/1", "388 ms"],
] as const;

type LedgerState = (typeof ledgerRows)[number][3];

const ledgerStateClass: Record<LedgerState, string> = {
  succeeded: "wh-ledger-ok",
  running: "wh-ledger-live",
  sleeping: "wh-ledger-idle",
  retried: "wh-ledger-warn",
  waiting: "wh-ledger-idle",
  "dead letter": "wh-ledger-dead",
};

/**
 * A table of task rows rolling upward behind a fade at both edges. It is
 * decoration, so it is hidden from assistive technology and from the
 * Markdown twin, and it holds still under reduced motion.
 */
function Ledger() {
  const rows = [...ledgerRows, ...ledgerRows];
  return (
    <div aria-hidden className="wh-ledger relative mx-auto mt-14 w-full max-w-4xl px-5 sm:mt-16">
      <div className="wh-ledger-head grid gap-x-4 border-b px-3 pb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-fd-muted-foreground">
        <span>task</span>
        <span>queue</span>
        <span>type</span>
        <span>state</span>
        <span className="text-right">attempt</span>
        <span className="text-right">took</span>
      </div>
      <div className="wh-ledger-window overflow-hidden">
        <div className="wh-ledger-roll">
          {rows.map(([id, queue, type, state, attempt, took], index) => (
            <div
              key={`${id}-${index}`}
              className="wh-ledger-row grid items-center gap-x-4 border-b px-3 py-2 font-mono text-[12px]"
            >
              <span className="text-fd-muted-foreground">{id}</span>
              <span>{queue}</span>
              <span className="truncate">{type}</span>
              <span className={`flex items-center gap-1.5 ${ledgerStateClass[state]}`}>
                <span aria-hidden className="wh-ledger-dot" />
                {state}
              </span>
              <span className="text-right text-fd-muted-foreground">{attempt}</span>
              <span className="whitespace-nowrap text-right text-fd-muted-foreground">{took}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const demoScreenshots = [
  {
    src: "/screenshots/demo-tasks.png",
    alt: "Workhorse dashboard task activity chart and task table",
    label: "Task activity",
  },
  {
    src: "/screenshots/demo-events.png",
    alt: "Workhorse event stream with task lifecycle events and operational details",
    label: "Events",
  },
  {
    src: "/screenshots/demo-health.png",
    alt: "Workhorse system health dashboard with queue backlog and retry metrics",
    label: "System health",
  },
  {
    src: "/screenshots/demo-queues.png",
    alt: "Workhorse queues dashboard with per-queue status, concurrency limits, and rate budgets",
    label: "Queues",
  },
  {
    src: "/screenshots/demo-workers.png",
    alt: "Workhorse worker fleet with queue assignments, capacity, and recent results",
    label: "Workers",
  },
  {
    src: "/screenshots/demo-schedules.png",
    alt: "Workhorse schedule list with expressions, destinations, and recent runs",
    label: "Schedules",
  },
] as const;

function DemoCarousel() {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeScreenshot = demoScreenshots[activeIndex] ?? demoScreenshots[0];
  const selectRelative = (offset: number) => {
    setActiveIndex(
      (current) => (current + offset + demoScreenshots.length) % demoScreenshots.length,
    );
  };

  return (
    <div
      className="min-w-0"
      role="region"
      aria-roledescription="carousel"
      aria-label="Workhorse dashboard screenshots"
    >
      <figure className="wh-frame overflow-hidden">
        <img
          src={activeScreenshot.src}
          alt={activeScreenshot.alt}
          className="aspect-[2/1] w-full object-cover object-top"
        />
        <figcaption className="wh-frame-bar flex flex-wrap items-center justify-between gap-2 border-t wh-rule px-4 py-2">
          <span aria-live="polite" className="font-mono text-xs text-fd-muted-foreground">
            <span className="sr-only">
              Screenshot {activeIndex + 1} of {demoScreenshots.length}:{" "}
            </span>
            {activeScreenshot.label}
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center" role="group" aria-label="Choose a screenshot">
              {demoScreenshots.map((screenshot, index) => (
                <button
                  key={screenshot.src}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  aria-label={`Show ${screenshot.label} screenshot`}
                  aria-current={index === activeIndex ? "true" : undefined}
                  className="group inline-flex size-7 items-center justify-center rounded-sm"
                >
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-fd-muted-foreground/35 transition-colors group-aria-[current=true]:bg-(--wh-accent)"
                  />
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => selectRelative(-1)}
                aria-label="Previous screenshot"
                className="inline-flex size-7 items-center justify-center rounded-sm border wh-rule text-sm text-fd-muted-foreground transition-colors hover:border-(--wh-accent) hover:text-fd-foreground"
              >
                ←
              </button>
              <span className="min-w-9 text-center font-mono text-[11px] text-fd-muted-foreground">
                {activeIndex + 1}/{demoScreenshots.length}
              </span>
              <button
                type="button"
                onClick={() => selectRelative(1)}
                aria-label="Next screenshot"
                className="inline-flex size-7 items-center justify-center rounded-sm border wh-rule text-sm text-fd-muted-foreground transition-colors hover:border-(--wh-accent) hover:text-fd-foreground"
              >
                →
              </button>
            </div>
          </div>
        </figcaption>
      </figure>
    </div>
  );
}

function DemoScreenshots() {
  return (
    <section className="mx-auto w-full max-w-7xl px-5 py-12 lg:px-8">
      <Rule label="the operator view" />
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14">
        <div>
          <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight sm:text-[27px]">
            See the queue before it becomes an incident.
          </h2>
          <p className="mt-3 text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
            The embeddable dashboard exposes task activity, queue pressure, schedules, retries, and
            worker health from the same PostgreSQL protocol.
          </p>
          <p className="mt-5">
            <a
              href={demoUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="wh-link-underline text-[15px] font-medium"
            >
              Explore the live demo →
            </a>
          </p>
        </div>
        <DemoCarousel />
      </div>
    </section>
  );
}

function Tile({ href, label, note }: { href: string; label: string; note: string }) {
  return (
    <a
      href={href}
      className="group rounded-md border wh-rule bg-(--wh-panel) px-4 py-4 transition-colors hover:border-(--wh-accent) sm:px-5"
    >
      <p className="flex items-center gap-2 text-[16px] font-medium tracking-tight">
        {label}
        <span
          aria-hidden
          className="wh-accent-text translate-x-0 transition-transform group-hover:translate-x-0.5"
        >
          →
        </span>
      </p>
      <p className="mt-1 text-[15px] text-fd-muted-foreground">{note}</p>
    </a>
  );
}

function DerbySection() {
  return (
    <section id="derby" className="mx-auto w-full max-w-7xl scroll-mt-24 px-5 py-10 lg:px-8">
      <Rule label="the derby" />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-10">
        <div>
          <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight sm:text-[27px]">
            Pick your horse. Watch the queue race.
          </h2>
          <p className="mt-3 text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
            Back a worker and see if it drains its queue first. A retry can cost the lead, a
            throttle can close the gap, and the game log shows how each race turns.
          </p>
          <p className="mt-4">
            <a href="/docs/dead-letters" className="wh-link-underline text-[15px] font-medium">
              Dead letters and redrive →
            </a>
          </p>
        </div>
        <TheDerby />
      </div>
    </section>
  );
}

function ClosingCall() {
  return (
    <section className="mx-auto w-full max-w-7xl px-5 pb-20 lg:px-8">
      <div className="relative overflow-hidden rounded-lg bg-brand-950 px-6 py-16 text-center sm:py-20">
        <div aria-hidden className="wh-band-grid pointer-events-none absolute inset-0" />
        <div className="relative flex flex-col items-center">
          <h2 className="text-balance text-3xl font-semibold leading-tight tracking-[-0.02em] text-ink-50 sm:text-4xl">
            Your database is already the queue.
          </h2>
          <p className="mt-4 max-w-xl text-pretty text-[16px] leading-relaxed text-brand-200/90">
            Install the schema, enqueue a task inside a transaction, and inspect every transition in
            the dashboard.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href="/docs/quickstart"
              className="inline-flex items-center gap-2 rounded-md bg-ink-50 px-5 py-2.5 text-[15px] font-medium text-ink-900 shadow-sm transition-colors hover:bg-white"
            >
              Build your first worker
            </a>
            <a
              href="/docs"
              className="inline-flex items-center gap-2 rounded-md border border-white/25 px-5 py-2.5 text-[15px] font-medium text-white transition-colors hover:border-white/50 hover:bg-white/10"
            >
              Read the docs
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function HomePage() {
  return (
    <div className="flex flex-1 flex-col">
      <HomeLayout {...baseOptions} className="flex-1">
        <Hero />
        <DemoScreenshots />

        {/* ---------- Feature tour: one real example per feature ---------- */}
        <div className="mx-auto w-full max-w-7xl px-5 lg:px-8">
          <Rule label="the feature tour" />
          {features.slice(0, derbyTourPosition).map((feature, index) => (
            <FeatureSection key={feature.id} feature={feature} index={index} />
          ))}
        </div>

        {/* ---------- The Derby: a playable intermission mid-tour ---------- */}
        <DerbySection />

        <div className="mx-auto w-full max-w-7xl px-5 lg:px-8">
          {features.slice(derbyTourPosition).map((feature, index) => (
            <FeatureSection key={feature.id} feature={feature} index={index + derbyTourPosition} />
          ))}
        </div>

        {/* ---------- Embedded dashboard ---------- */}
        <section className="mx-auto w-full max-w-7xl px-5 py-16 lg:px-8">
          <Rule label="embedded dashboard" />
          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14">
            <div>
              <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight sm:text-[27px]">
                Bring the operator view into your application.
              </h2>
              <p className="mt-3 text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
                Each SDK serves the same browser application through its native HTTP interface. Your
                application keeps authentication, origin, and database ownership.
              </p>
              <p className="mt-4">
                <a href="/docs/dashboard" className="wh-link-underline text-[15px] font-medium">
                  Embedded dashboard →
                </a>
              </p>
            </div>
            <div className="min-w-0">
              <CodeTabs name="dashboard-host" tabs={dashboardTabs} />
              <DashboardEmbeddingDiagram />
            </div>
          </div>
        </section>

        {/* ---------- Health and fleet operations ---------- */}
        <section className="mx-auto w-full max-w-7xl px-5 pb-16 lg:px-8">
          <Rule label="health and fleet" />
          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14">
            <div>
              <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight sm:text-[27px]">
                Operate from anywhere PostgreSQL reaches.
              </h2>
              <p className="mt-3 text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
                Health reads queue verdicts, while fleet controls pause workers through audited
                requests. Use the SDK your operators already run.
              </p>
              <p className="mt-4">
                <a href="/docs/operations" className="wh-link-underline text-[15px] font-medium">
                  Operations →
                </a>
              </p>
            </div>
            <div className="min-w-0">
              <CodeTabs name="health-fleet" tabs={healthFleetTabs} />
              <FleetOperationsDiagram />
            </div>
          </div>
        </section>

        {/* ---------- ORM adapters ---------- */}
        <section className="mx-auto w-full max-w-7xl px-5 pb-16 lg:px-8">
          <Rule label="bring your ORM" />
          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14">
            <div>
              <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight sm:text-[27px]">
                The same guarantee inside your ORM's transaction.
              </h2>
              <p className="mt-3 text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
                Each adapter is a separate package that turns your ORM's transaction object into the
                queue's database protocol. The account row and its follow-up task either commit or
                roll back together.
              </p>
              <p className="mt-4">
                <a href="/docs/integrations" className="wh-link-underline text-[15px] font-medium">
                  Integration guides →
                </a>
              </p>
            </div>
            <div className="min-w-0">
              <CodeTabs name="orm" tabs={ormTabs} meta="typescript" />
            </div>
          </div>
        </section>

        {/* ---------- Deploying workers ---------- */}
        <section className="mx-auto w-full max-w-7xl px-5 pb-16 lg:px-8">
          <Rule label="deploying" />
          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14">
            <div>
              <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight sm:text-[27px]">
                One config file is a production worker.
              </h2>
              <p className="mt-3 text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
                TypeScript, Python, and Go connect process signals to bounded drain and fleet
                registration. Active handlers finish before the supervisor replaces the process.
              </p>
              <p className="mt-4">
                <a
                  href="/docs/worker-processes"
                  className="wh-link-underline text-[15px] font-medium"
                >
                  Worker processes →
                </a>
              </p>
            </div>
            <div className="min-w-0">
              <CodeTabs name="deploy" tabs={deployTabs} />
            </div>
          </div>
        </section>

        {/* ---------- Packages ---------- */}
        <section className="mx-auto w-full max-w-7xl px-5 pb-16 lg:px-8">
          <Rule label="packages" />
          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-14">
            <div>
              <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight sm:text-[27px]">
                The core keeps one dependency.
              </h2>
              <p className="mt-3 text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
                Every integration is its own package, so adopting an ORM adapter or the dashboard
                never adds that ecosystem to the core. None of them hide the transaction from you.
              </p>
            </div>
            <dl className="wh-panel overflow-hidden rounded-md">
              {packages.map((pkg) => (
                <a
                  key={pkg.name}
                  href={pkg.href}
                  className="wh-rule grid gap-1.5 border-t px-5 py-4 transition-colors first:border-t-0 hover:bg-brand-50/60 sm:grid-cols-[minmax(0,13rem)_1fr] sm:gap-8 dark:hover:bg-brand-500/5"
                >
                  <dt className="font-mono text-[14px] font-medium tracking-tight text-brand-700 dark:text-brand-300">
                    {pkg.name}
                  </dt>
                  <dd className="text-[15px] leading-relaxed text-fd-muted-foreground">
                    {pkg.body}
                  </dd>
                </a>
              ))}
            </dl>
          </div>
        </section>

        {/* ---------- Where to go ---------- */}
        <section className="wh-rule border-t">
          <div className="mx-auto grid w-full max-w-7xl gap-px px-5 py-14 sm:grid-cols-3 lg:px-8">
            <Tile
              href="/docs/quickstart"
              label="Quickstart"
              note="Install the schema, enqueue the first task, and run a worker."
            />
            <Tile
              href="/docs/api"
              label="API reference"
              note="Queue, Worker, and the process runner surface."
            />
            <Tile
              href="/docs/examples"
              label="Examples"
              note="End-to-end patterns you can paste into a service."
            />
          </div>
        </section>

        {/* ---------- Closing call ---------- */}
        <ClosingCall />

        <SiteFooter />
      </HomeLayout>
    </div>
  );
}
