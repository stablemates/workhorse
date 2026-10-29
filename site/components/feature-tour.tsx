import type { ReactNode } from "react";

import { type CodeTab, isLandingSnippetId, languageTab } from "@/components/code-sample";
import { languageIds, type LanguageId } from "@/components/languages";
import { TextLink } from "@/components/primitives";
import { integrations } from "@/lib/integrations";
import {
  landingFeatureSnippets,
  landingSupplementalSnippets,
  type LandingFeatureSnippetId,
} from "@/lib/landing-snippets";

/*
 * The feature tour of the features page (`src/routes/features.tsx`). Each
 * group has a title, one sentence of context, and its features. A feature is
 * one guarantee as its title, one or two sentences that support it, the API
 * names it uses, and a link to the guide that explains it. The route gives
 * each group its own layout and its one visual: a code sample, a diagram, or
 * dashboard captures.
 *
 * Snippet sources live in `lib/landing-snippets.ts` and arrive as
 * build-time-highlighted markup. The rule from that file holds for this one
 * too: verify every claim against the source before writing it.
 */

/**
 * An API name that a feature uses. `sdks` names the SDKs that spell it this
 * way, when the spelling differs between them.
 */
interface ApiName {
  code: string;
  sdks?: string;
}

interface Feature {
  id: string;
  title: string;
  body: ReactNode;
  api?: readonly ApiName[];
  href: string;
  linkLabel: string;
}

export interface FeatureGroup {
  id: string;
  title: string;
  lede: string;
  features: readonly Feature[];
}

const dashboardNote = (
  <>
    TypeScript, Python, Go, Rust, Ruby, Java, Kotlin, and C# embed the same packaged dashboard
    through their native HTTP interfaces. Each host needs a database connection, with no worker
    runtime or extra service.
  </>
);

/** Embedded dashboard hosts, one native transport around the same browser application. */
const dashboardFiles: Record<LanguageId, string> = {
  typescript: "app/api/[...workhorse]/route.ts",
  python: "dashboard.py",
  go: "dashboard.go",
  rust: "dashboard.rs",
  ruby: "config.ru",
  java: "Dashboard.java",
  kotlin: "Dashboard.kt",
  csharp: "Dashboard.cs",
};

export const dashboardTabs: readonly CodeTab[] = languageIds.map((language) =>
  languageTab(
    language,
    dashboardFiles[language],
    landingSupplementalSnippets.operateDashboard[language],
    dashboardNote,
  ),
);

/**
 * One tab per ORM adapter with the same transactional guarantee everywhere,
 * in the order `site/integrations.json` gives them. The catalog is the one
 * place an integration is added, so this page cannot list a different set from
 * the docs sidebar or the `/docs/integrations` index.
 */
export const ormTabs: readonly CodeTab[] = integrations.flatMap((entry) =>
  entry.landingSnippet !== undefined && isLandingSnippetId(entry.landingSnippet)
    ? [
        {
          label: entry.name,
          language: "typescript",
          logo: false,
          file: "signup.ts",
          snippet: entry.landingSnippet,
        },
      ]
    : [],
);

/** The language tabs of one feature snippet set, with a file name per language. */
export function snippetTabs(snippet: LandingFeatureSnippetId, file: string): readonly CodeTab[] {
  const baseFile = file.replace(/\.ts$/, "");
  // A Java, Kotlin, or C# file takes the name of its class: `settle-order` becomes `SettleOrder`.
  const classFile = baseFile.replace(/(^|-)([a-z])/g, (_match, _dash, letter: string) =>
    letter.toUpperCase(),
  );
  const snippets = landingFeatureSnippets[snippet];
  return [
    languageTab("typescript", file, snippets.typescript),
    ...("python" in snippets &&
    "go" in snippets &&
    "rust" in snippets &&
    "ruby" in snippets &&
    "java" in snippets &&
    "kotlin" in snippets &&
    "csharp" in snippets
      ? [
          languageTab("python", `${baseFile}.py`, snippets.python),
          languageTab("go", `${baseFile}.go`, snippets.go),
          languageTab("rust", `${baseFile.replaceAll("-", "_")}.rs`, snippets.rust),
          languageTab("ruby", `${baseFile.replaceAll("-", "_")}.rb`, snippets.ruby),
          languageTab("java", `${classFile}.java`, snippets.java),
          languageTab("kotlin", `${classFile}.kt`, snippets.kotlin),
          languageTab("csharp", `${classFile}.cs`, snippets.csharp),
        ]
      : []),
  ];
}

/** The checkpoint sample of the durable execution group, in every SDK. */
export const checkpointTabs = snippetTabs("checkpoints", "invoice.ts");

const durableExecution: FeatureGroup = {
  id: "durable-execution",
  title: "Durable execution",
  lede: "A handler can stop at any point and continue later. PostgreSQL keeps its progress, its timers, and its waits.",
  features: [
    {
      id: "checkpoints",
      title: "Crash mid-task. Finish anyway.",
      body: (
        <>
          Wrap each completed stage in a named <code>checkpoint</code>. When a retry or restart runs
          the handler again, a completed checkpoint returns its stored result and does not run
          again. A crash can occur after a charge succeeds but before its checkpoint is saved, so
          give external effects a provider idempotency key.
        </>
      ),
      href: "/docs/durable-execution",
      linkLabel: "Durable execution",
    },
    {
      id: "durable-sleep",
      title: "Sleep for an hour or a month without holding a worker.",
      body: "A durable sleep commits a named timer in PostgreSQL and gives the worker slot back. When the timer is due, the handler restarts and its checkpoints replay.",
      api: [
        { code: "ctx.sleep", sdks: "TypeScript" },
        { code: "context.sleep", sdks: "Python, Rust, Ruby" },
        { code: "handler.Sleep", sdks: "Go" },
      ],
      href: "/docs/durable-execution",
      linkLabel: "Checkpoints and durable waits",
    },
    {
      id: "external-waits",
      title: "Wait for another system or a person, while holding nothing.",
      body: "Signals carry application events. Human waits carry stored decision context into an authenticated operator surface. Both release the lease, then restart the handler with one retained result that is delivered idempotently.",
      href: "/docs/signals",
      linkLabel: "Signals and human waits",
    },
    {
      id: "cancellation",
      title: "Cancel work that is already running.",
      body: "Every handler gets a cancellation primitive. Cancel requests, deadlines, and execution timeouts all arrive through it, so one check covers all three.",
      api: [{ code: "AbortSignal" }, { code: "CancellationToken" }, { code: "context.Context" }],
      href: "/docs/cancellation",
      linkLabel: "Cancellation",
    },
  ],
};

const failure: FeatureGroup = {
  id: "failure",
  title: "Retries and failure",
  lede: "PostgreSQL stores the retry policy with the task. A replayed request finds its first task, and a failure that runs out of attempts keeps its evidence.",
  features: [
    {
      id: "retries",
      title: "Retry on a policy. Stop at a deadline.",
      body: "PostgreSQL stores the retry policy with the task and enforces it, so every worker backs off the same way. An execution timeout bounds one attempt, and the deadline bounds the whole task.",
      api: [
        { code: "executionTimeoutMs" },
        { code: "execution_timeout_ms" },
        { code: "ExecutionTimeoutMS" },
      ],
      href: "/docs/retries",
      linkLabel: "Retries",
    },
    {
      id: "idempotency",
      title: "Replay the request, get the same task.",
      body: "Give an enqueue a key and a scope, and a replay returns the original task id instead of a duplicate. A replay with a materially different payload raises a typed conflict. It never creates a silent second task.",
      href: "/docs/idempotency",
      linkLabel: "Idempotent enqueue",
    },
    {
      id: "dead-letters",
      title: "Failures leave evidence, and redrive leaves an audit trail.",
      body: "Exhausted tasks go to a cold relation with their error, attempts, and tags. Reading them never competes with dispatch. Redrive requires an actor, a reason, and a request id, and keeps lineage back to the failure it replaced.",
      href: "/docs/dead-letters",
      linkLabel: "Dead letters and redrive",
    },
  ],
};

const scheduling: FeatureGroup = {
  id: "scheduling",
  title: "Scheduling and flow control",
  lede: "Schedules, limits, and dependencies live in the database, so every worker in the fleet obeys the same rules.",
  features: [
    {
      id: "schedules",
      title: "Scheduled tasks, no scheduler process.",
      body: "Declare schedules as code and sync them on every deploy. The sync treats its namespace as authoritative and atomically disables a schedule that you stop shipping. Workers evaluate and fire due schedules in-process, with no separate service to run.",
      href: "/docs/schedules",
      linkLabel: "Schedules",
    },
    {
      id: "flow-control",
      title: "Throttle by queue, tenant, or key.",
      body: "Concurrency and rate-limit policies live in the database, so they bind the whole fleet. A task supplies a concurrency key to keep one tenant from starving the rest.",
      api: [{ code: "concurrencyKey" }, { code: "concurrency_key" }, { code: "ConcurrencyKey" }],
      href: "/docs/concurrency-policies",
      linkLabel: "Concurrency policies",
    },
    {
      id: "dependencies",
      title: "Release downstream work only when its inputs settle.",
      body: "Producers can declare prerequisites, and handlers can create named child tasks and then join their results. Parents and dependents leave dispatch while they wait, so orchestration uses no worker slot and survives every restart.",
      href: "/docs/task-dependencies",
      linkLabel: "Dependencies and child tasks",
    },
    {
      id: "coalescing",
      title: "Absorb repeated work without hiding what happened.",
      body: "Debounce replaces a pending payload while updates settle. The enqueue result returns the retained task and a typed outcome, so diagnostics show whether Workhorse replaced or coalesced it.",
      api: [
        { code: "enqueueWithResult" },
        { code: "enqueue_with_result" },
        { code: "EnqueueWithResult" },
        { code: "enqueue", sdks: "Rust, Ruby" },
      ],
      href: "/docs/debounce",
      linkLabel: "Debounce and throttle",
    },
    {
      id: "batch-handlers",
      title: "Share the provider call, keep every task independent.",
      body: "A batch handler groups tasks of one type for efficient bulk I/O. Every member keeps its own lease, cancellation, retry budget, and result, so one provider response does not collapse separate durable identities.",
      href: "/docs/batch-handlers",
      linkLabel: "Batch handlers",
    },
  ],
};

const operate: FeatureGroup = {
  id: "operate",
  title: "Operate",
  lede: "Operators see and control the queue from the same PostgreSQL protocol that the workers use.",
  features: [
    {
      id: "dashboard",
      title: "Bring the operator view into your application.",
      body: "Each SDK serves the same browser application through its native HTTP interface. Your application keeps authentication, origin, and database ownership.",
      href: "/docs/dashboard",
      linkLabel: "Embedded dashboard",
    },
    {
      id: "health-and-fleet",
      title: "Operate from anywhere PostgreSQL reaches.",
      body: "Health reads queue verdicts, and fleet controls pause workers through audited requests. Use the SDK your operators already run.",
      href: "/docs/operations",
      linkLabel: "Operations",
    },
    {
      id: "deploying",
      title: "One config file is a production worker.",
      body: "TypeScript, Python, Go, Rust, Ruby, Java, Kotlin, and C# connect process signals to bounded drain and fleet registration. Active handlers finish before the supervisor replaces the process.",
      href: "/docs/worker-processes",
      linkLabel: "Worker processes",
    },
  ],
};

const integrate: FeatureGroup = {
  id: "integrate",
  title: "Integrate",
  lede: "Workhorse joins the transaction your application already opens, through the ORM you already use.",
  features: [
    {
      id: "orm",
      title: "The same guarantee inside your ORM's transaction.",
      body: "Each adapter is a separate package that turns the transaction object of your ORM into the database protocol of the queue. The account row and its follow-up task either commit or roll back together.",
      href: "/docs/integrations",
      linkLabel: "Integration guides",
    },
  ],
};

/** The groups in page order. The route lays out each one, and the group nav lists them all. */
export const featureGroups = {
  durableExecution,
  failure,
  scheduling,
  operate,
  integrate,
} as const satisfies Record<string, FeatureGroup>;

/**
 * The title and the context sentence of a group. `center` centers both, as
 * the section heads of the landing page do.
 */
export function GroupHead({ group, align }: { group: FeatureGroup; align: "start" | "center" }) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-xl"}>
      <h2 className="wh-ftitle text-balance font-semibold text-wh-fg">{group.title}</h2>
      <p className="mt-4 text-pretty text-ui-m text-wh-muted sm:text-[1.0625rem] sm:leading-7">
        {group.lede}
      </p>
    </div>
  );
}

/**
 * The features of a group, each under a hairline.
 *
 * - `stack`: one column, beside the visual of a split group.
 * - `columns`: one column per feature from 1024 px.
 * - `rows`: one row per feature. The title takes the first column and the
 *   detail the second, on the column lines of the group head and its visual.
 *
 * `children` adds entries to the end of the list.
 */
export function FeatureList({
  features,
  layout,
  className = "",
  children,
}: {
  features: readonly Feature[];
  layout: "stack" | "columns" | "rows";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <ul className={`wh-flist ${className}`} data-layout={layout}>
      {features.map((feature) => (
        <FeatureItem key={feature.id} feature={feature} />
      ))}
      {children}
    </ul>
  );
}

/** One feature: its guarantee, the sentences that support it, its API names, and its guide. */
function FeatureItem({ feature }: { feature: Feature }) {
  return (
    <li id={feature.id} className="wh-feature">
      <h3 className="wh-feature-title">{feature.title}</h3>
      <div className="wh-feature-detail">
        <p className="wh-feature-body">{feature.body}</p>
        {feature.api ? (
          <ul aria-label="API names" className="wh-feature-api">
            {feature.api.map((name) => (
              <li key={`${name.code}-${name.sdks ?? ""}`}>
                {name.sdks ? <span className="wh-feature-sdks">{name.sdks}</span> : null}
                <code>{name.code}</code>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="wh-feature-link">
          <TextLink href={feature.href}>{feature.linkLabel}</TextLink>
        </p>
      </div>
    </li>
  );
}

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
  ...integrations.flatMap((entry) =>
    entry.package
      ? [{ name: entry.package, body: entry.summary, href: `/docs/${entry.slug}` }]
      : [],
  ),
];

/** The entry that introduces the package list, at the end of the feature list of its group. */
export function PackagesEntry() {
  return (
    <li className="wh-feature">
      <h3 className="wh-feature-title">The core keeps one dependency.</h3>
      <div className="wh-feature-detail">
        <p className="wh-feature-body">
          Every integration is its own package, so an ORM adapter or the dashboard never adds that
          ecosystem to the core. None of them hide the transaction from you.
        </p>
      </div>
    </li>
  );
}

/** The package list: the core, the telemetry adapter, and one row per integration package. */
export function PackageList() {
  return (
    <ul aria-label="Packages" className="wh-fpackages">
      {packages.map((pkg) => (
        <li key={pkg.name}>
          <a href={pkg.href} className="wh-fpackage">
            <span className="wh-fpackage-name">{pkg.name}</span>
            <span className="text-ui-s text-wh-muted">{pkg.body}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
