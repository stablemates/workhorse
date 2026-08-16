import type { Metadata } from "next";
import Link from "next/link";
import { CodeSample } from "@/components/code-sample";
import { SectionHeading } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Examples",
  description:
    "Worked Workhorse examples: transactional enqueue, durable handlers, schedules, cancellation, audited redrive, and a durable agentic flow.",
  alternates: { canonical: "/examples" },
};

interface Example {
  id: string;
  tag: string;
  title: string;
  lede: string;
  file: string;
  code: string;
  sourceHref?: string;
}

const examples: readonly Example[] = [
  {
    id: "transactional-enqueue",
    tag: "Transactional enqueue",
    title: "Never ship a row without its work",
    lede: "The classic dual-write bug: you insert a user, then enqueue a welcome email, then the process dies in between. Passing the transaction's client removes the window entirely.",
    file: "signup.ts",
    code: `const client = await pool.connect();
try {
  await client.query("BEGIN");

  const { rows } = await client.query(
    "INSERT INTO account (email) VALUES ($1) RETURNING id",
    [email],
  );
  const accountId = rows[0].id;

  // Same transaction. If the insert rolls back, the job never existed.
  await queue.enqueue(
    "account.welcome",
    { accountId, email },
    { queue: "notifications", tags: ["signup"] },
    client,
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
    id: "checkpoints",
    tag: "Durable handlers",
    title: "Charge the card exactly once, even across retries",
    lede: "A checkpoint records immutable evidence that a step completed. After a crash or a durable wait the handler restarts, but committed checkpoints replay their stored value instead of running again. The provider still needs an idempotency key for the crash between the effect and the commit.",
    file: "capture.ts",
    code: `worker.handle("invoice.capture", async (payload, ctx) => {
  const charge = await ctx.checkpoint("provider-charge", async () => {
    // The stable key covers the one window a checkpoint cannot: a crash
    // after the provider call but before the checkpoint commits.
    return provider.capture({
      amount: payload.amount,
      idempotencyKey: \`capture:\${payload.invoiceId}\`,
    });
  });

  // Releases the lease and the worker slot for the whole window.
  await ctx.sleep("settlement-window", 24 * 60 * 60 * 1000);

  return ctx.checkpoint("settlement-check", async () => {
    return provider.settlement(charge.id);
  });
});`,
  },
  {
    id: "recurring",
    tag: "Recurring jobs",
    title: "Schedules that deploy with your code",
    lede: "Schedules are declared in the repository and synchronized into the target database during deployment. Names omitted from the namespace are disabled atomically, so deleting a definition actually stops it firing.",
    file: "deploy.ts",
    code: `// Run this during every deployment, before workers start.
await queue.syncSchedules("billing-production", [
  {
    name: "daily-invoices",
    schedule: "0 6 * * *",
    timezone: "UTC",
    job: {
      type: "generate-invoices",
      queue: "billing",
      payload: { scope: "daily" },
      maxAttempts: 5,
      retryPolicy: {
        type: "exponential",
        initialDelayMs: 30_000,
        multiplier: 3,
        maxDelayMs: 3_600_000,
      },
    },
  },
]);

// The worker that evaluates this namespace's schedules.
const worker = new Worker(queue, {
  scheduleNamespaces: ["billing-production"],
});`,
  },
  {
    id: "bounds",
    tag: "Deadlines and cancellation",
    title: "Stop work that no longer matters",
    lede: "An absolute deadline and a per-attempt execution timeout are both enforced by PostgreSQL, so a partitioned worker cannot keep an expired attempt alive. Cancellation is cooperative: your handler observes the signal and settles promptly.",
    file: "bounds.ts",
    code: `await queue.enqueue(
  "report.render",
  { reportId },
  {
    // The whole job is pointless after this instant.
    deadline: new Date(Date.now() + 15 * 60_000),
    // Any single attempt is pathological past this budget.
    executionTimeoutMs: 110_000,
  },
);

worker.handle("report.render", async (payload, { signal }) => {
  for (const page of pages) {
    // Deadline, execution timeout, and operator cancellation all arrive here.
    signal.throwIfAborted();
    await render(page, { signal });
  }
});

// From an operator surface, with audit attribution.
await queue.cancel(jobId, {
  requestedBy: "operator@example.com",
  reason: "customer withdrew the request",
});`,
  },
  {
    id: "redrive",
    tag: "Dead letters",
    title: "Replay a provider incident, with an audit trail",
    lede: "Terminal failures stay in the cold outcome relation and keep their evidence. Redrive creates a linked new job rather than mutating the failure, and requires an actor, a reason, and a request identity so a retry storm cannot be issued anonymously.",
    file: "redrive.ts",
    code: `const page = await queue.listDeadLetters({
  queue: "billing",
  errorName: "ProviderUnavailable",
  finishedAfter: incidentStart,
});

// Confirm the blast radius before writing anything.
const preview = await queue.redriveMany({
  filter: { queue: "billing", errorName: "ProviderUnavailable" },
  requestedBy: "operator@example.com",
  reason: "provider incident 2026-08-03 resolved",
  requestId: "incident-2026-08-03:billing",
  dryRun: true,
});

console.log(\`\${preview.results.length} of \${page.items.length} eligible\`);

// The same requestId replays the same page instead of duplicating it.
const applied = await queue.redriveMany({
  filter: { queue: "billing", errorName: "ProviderUnavailable" },
  requestedBy: "operator@example.com",
  reason: "provider incident 2026-08-03 resolved",
  requestId: "incident-2026-08-03:billing",
});`,
  },
  {
    id: "agentic-flow",
    tag: "Agentic flow",
    title: "Let tools, cooldowns, and approval survive the process",
    lede: "A model plan becomes a checkpoint, independent tools become child jobs, cooldown becomes a durable timer, and approval becomes a signal. Every boundary releases the lease and restarts safely from retained evidence.",
    file: "agentic-flow.mjs",
    sourceHref:
      "https://github.com/stablemates/workhorse/blob/main/typescript/examples/agentic-flow.mjs",
    code: `worker.handle("agent.run", async ({ prompt, conversationId }, ctx) => {
  const plan = await ctx.checkpoint("plan", () =>
    model.plan(prompt, { idempotencyKey: \`plan:\${ctx.job.id}\` }),
  );

  const tools = await ctx.runChildren(
    plan.tools.map((tool) => ({
      name: tool.id,
      type: "agent.tool",
      payload: tool,
      options: { queue: "tools", concurrencyKey: conversationId },
    })),
  );

  await ctx.sleep("model-cooldown", cooldownMs);
  const approval = await ctx.waitForSignal("approval");
  return { plan, tools, approval };
});`,
  },
];

export default function ExamplesPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-14 lg:px-8">
      <p className="wh-mono-label">Examples</p>
      <h1 className="mt-4 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
        Six complete shapes for work that must survive failure.
      </h1>
      <p className="mt-5 max-w-3xl text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
        Each example is a complete, runnable shape rather than a fragment. They are ordered the way
        a service usually grows: commit safely, make effects idempotent, add schedules, add bounds,
        handle the failures you did not prevent, then compose those boundaries into an agent loop.
      </p>

      <nav
        aria-label="Examples"
        className="wh-rule mt-8 flex flex-wrap gap-x-5 gap-y-2 border-y py-3"
      >
        {examples.map((example) => (
          <a
            key={example.id}
            href={`#${example.id}`}
            className="font-mono text-[12.5px] text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            {example.tag}
          </a>
        ))}
      </nav>

      <div className="mt-14 space-y-16">
        {examples.map((example, index) => (
          <section
            key={example.id}
            id={example.id}
            className="scroll-mt-24 grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-14"
          >
            <SectionHeading
              index={`${String(index + 1).padStart(2, "0")} / ${example.tag}`}
              title={example.title}
              lede={example.lede}
            />
            <div>
              <CodeSample code={example.code} title={example.file} meta="server" />
              {example.sourceHref ? (
                <a
                  href={example.sourceHref}
                  className="wh-link-underline mt-4 inline-block text-[13.5px] font-medium"
                >
                  Open the complete repository example
                </a>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <section className="wh-panel mt-16 rounded-xl p-6 sm:p-8">
        <p className="wh-mono-label">A standing caveat</p>
        <p className="mt-3 max-w-3xl text-[14.5px] leading-relaxed text-fd-muted-foreground">
          Delivery is at least once. Checkpoints, idempotency keys, and audited redrive shrink the
          windows where an effect can repeat, but they do not remove them. Any handler that touches
          an external system still needs provider idempotency, an inbox, or a compensation path.
        </p>
        <div className="mt-6">
          <Link href="/docs" className="wh-link-underline text-[14px] font-medium">
            Read the correctness contract
          </Link>
        </div>
      </section>
    </div>
  );
}
