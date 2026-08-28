import type { ReactNode } from "react";

/*
 * Static concept diagrams for the landing page, one per feature section. Pure
 * HTML and CSS. Like the code samples, they ship no client JavaScript. Every
 * identifier a diagram names must appear in the matching snippet in
 * `lib/landing-snippets.ts`, which is itself verified against the API surface.
 */

/** Shared framed panel so all diagrams read as one family. */
function Diagram({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="wh-panel mt-4 overflow-hidden rounded-xl">
      <div className="wh-frame-bar px-4 py-2">
        <span className="wh-mono-label">{label}</span>
      </div>
      <div className="overflow-x-auto px-4 py-4 sm:px-5">{children}</div>
    </div>
  );
}

type Tone = "run" | "good" | "off" | "wait";

const pipTone: Record<Tone, string> = {
  run: "bg-signal-500",
  good: "bg-safety-500",
  off: "bg-fd-muted-foreground/50",
  wait: "bg-fd-muted-foreground/50",
};

function Pip({ tone }: { tone: Tone }) {
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${pipTone[tone]}`} />;
}

const chipTone = {
  line: "wh-rule border bg-fd-muted/50",
  good: "border-safety-500/35 bg-safety-500/10 text-safety-600 dark:text-safety-400",
  accent: "border-signal-500/35 bg-signal-500/10 text-signal-700 dark:text-signal-300",
  ghost: "wh-rule border border-dashed text-fd-muted-foreground",
} as const;

function Chip({ tone = "line", children }: { tone?: keyof typeof chipTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] leading-none tracking-tight ${chipTone[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A hairline connector between chips, optionally tipped with an arrowhead.
 * Horizontal only; hide or shrink it when a row wraps.
 */
function Wire({ className = "w-5", arrow = false }: { className?: string; arrow?: boolean }) {
  return (
    <span aria-hidden className={`wh-rule relative h-px shrink-0 border-t ${className}`}>
      {arrow ? (
        <span className="wh-rule absolute -top-[4px] right-0 size-[7px] rotate-45 border-r border-t" />
      ) : null}
    </span>
  );
}

/** A wire with a small mono caption above it, for labelled transitions. */
function LabeledWire({ label, className = "w-16" }: { label: string; className?: string }) {
  return (
    <span className="flex shrink-0 flex-col items-center gap-1 px-1.5">
      <span className="wh-mono-label">{label}</span>
      <Wire className={className} arrow />
    </span>
  );
}

/* ---------- Connected stepper ---------- */

interface StepperStep {
  title: string;
  detail: string;
  tone: Tone;
}

const nodeTone: Record<Tone, string> = {
  run: "border-signal-500 text-signal-600 dark:text-signal-400",
  good: "border-safety-500 text-safety-600 dark:text-safety-400",
  off: "border-fd-muted-foreground/50 border-dashed text-fd-muted-foreground",
  wait: "border-fd-muted-foreground/50 border-dashed text-fd-muted-foreground",
};

/**
 * Numbered nodes joined by one continuous line: vertical on small screens,
 * horizontal from `sm` up. The last step draws no trailing line, so the rail
 * visibly starts and ends with the story.
 */
function Stepper({ steps }: { steps: readonly StepperStep[] }) {
  return (
    <ol className="flex flex-col sm:flex-row">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <li
            key={step.title + index}
            className={`flex gap-3 sm:block ${last ? "sm:shrink" : "pb-4 sm:flex-1 sm:pb-0"}`}
          >
            <div className="flex flex-col items-center sm:w-full sm:flex-row">
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 bg-(--wh-panel) font-mono text-[11px] font-medium leading-none ${nodeTone[step.tone]}`}
              >
                {index + 1}
              </span>
              {last ? null : (
                <span
                  aria-hidden
                  className="wh-rule mt-1 w-px flex-1 border-l sm:mx-1.5 sm:mt-0 sm:h-px sm:w-auto sm:border-l-0 sm:border-t"
                />
              )}
            </div>
            <div className="min-w-0 sm:mt-2 sm:pr-4">
              <p className="font-mono text-[13px] font-medium tracking-tight">{step.title}</p>
              <p className="mt-0.5 text-[12.5px] leading-snug text-fd-muted-foreground">
                {step.detail}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- 01 · transactional enqueue ---------- */

export function EnqueueDiagram() {
  return (
    <Diagram label="one transaction, one fate">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-0">
        <div className="wh-rule shrink-0 rounded-lg border border-dashed px-3.5 py-3">
          <p className="wh-mono-label">begin … commit</p>
          <div className="mt-2.5 flex flex-col gap-1.5">
            <Chip>INSERT INTO orders</Chip>
            <Chip>enqueue(&quot;order.confirm&quot;)</Chip>
          </div>
        </div>
        <Wire className="hidden flex-1 sm:block sm:min-w-5" arrow />
        <div className="flex shrink-0 flex-col gap-2.5 sm:pl-2">
          <p className="flex items-center gap-2.5 text-[13px]">
            <Pip tone="good" />
            <span className="font-mono font-medium tracking-tight">COMMIT</span>
            <span className="text-fd-muted-foreground">the order and its job appear together</span>
          </p>
          <p className="flex items-center gap-2.5 text-[13px]">
            <Pip tone="off" />
            <span className="font-mono font-medium tracking-tight">ROLLBACK</span>
            <span className="text-fd-muted-foreground">
              neither exists, so nothing needs cleanup
            </span>
          </p>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- 02 · checkpoints ---------- */

const crashSteps: readonly StepperStep[] = [
  {
    title: 'checkpoint("charge")',
    tone: "run",
    detail: "runs, and the result commits with the job",
  },
  { title: "process killed", tone: "off", detail: "lease expires; nothing rolls back" },
  {
    title: 'checkpoint("charge")',
    tone: "good",
    detail: "replays the stored result without another charge",
  },
  { title: "succeeded", tone: "good", detail: "result persisted, history queryable" },
];

export function CrashDiagram() {
  return (
    <Diagram label="the same job, through a crash">
      <Stepper steps={crashSteps} />
    </Diagram>
  );
}

/* ---------- 03 · durable sleep ---------- */

export function SleepDiagram() {
  const label = "text-[12.5px] leading-snug text-fd-muted-foreground";
  return (
    <Diagram label='ctx.sleep("settlement-window"), to scale'>
      <div className="flex min-w-[26rem] items-start gap-2">
        <div className="flex-[1.5]">
          <div className="h-1.5 rounded-full bg-signal-500/80" />
          <p className={`mt-2 ${label}`}>handler runs</p>
        </div>
        <div className="flex-[7]">
          <div className="flex h-1.5 items-center">
            <div className="wh-rule w-full border-t-2 border-dashed" />
          </div>
          <p className={`mt-2 ${label}`}>
            asleep in a PostgreSQL timer row with zero worker slots held
          </p>
        </div>
        <div className="flex-[2]">
          <div className="h-1.5 rounded-full bg-safety-500/80" />
          <p className={`mt-2 ${label}`}>restarts, checkpoints replay</p>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- 04 · retries and deadlines ---------- */

export function RetriesDiagram() {
  return (
    <Diagram label="exponential backoff, bounded twice">
      <div className="flex items-center">
        <Chip>try 1</Chip>
        <Wire className="w-3" />
        <Chip>+1s</Chip>
        <Wire className="w-6" />
        <Chip>+2s</Chip>
        <Wire className="w-12" />
        <Chip>+4s</Chip>
        <Wire className="w-5" />
        <span
          aria-hidden
          className="mx-2 h-8 w-0.5 shrink-0 rounded-full bg-signal-500"
          title="deadline"
        />
        <div className="flex flex-col gap-1">
          <span className="wh-mono-label">deadline: kickoff</span>
          <Chip tone="ghost">remaining attempts never run</Chip>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- 05 · idempotency ---------- */

function IdempotencyRow({
  cause,
  effect,
  tone,
}: {
  cause: string;
  effect: string;
  tone: keyof typeof chipTone;
}) {
  return (
    <div className="flex items-center gap-0">
      <span className="w-48 shrink-0 text-[13.5px] text-fd-muted-foreground">{cause}</span>
      <Wire className="w-5 flex-none sm:flex-1" arrow />
      <span className="pl-2">
        <Chip tone={tone}>{effect}</Chip>
      </span>
    </div>
  );
}

export function IdempotencyDiagram() {
  return (
    <Diagram label='key "capture:inv-1" · scope "tenant-42"'>
      <div className="flex min-w-[24rem] flex-col gap-2.5">
        <IdempotencyRow cause="first enqueue" effect="job created" tone="good" />
        <IdempotencyRow cause="webhook retried" effect="same jobId returned" tone="good" />
        <IdempotencyRow
          cause="replayed with a changed payload"
          effect="EnqueueIdempotencyConflictError"
          tone="accent"
        />
      </div>
    </Diagram>
  );
}

/* ---------- 06 · schedules ---------- */

export function SchedulesDiagram() {
  return (
    <Diagram label="the deployed list is the source of truth">
      <div className="flex flex-col gap-2.5">
        <p className="flex items-center gap-2.5 text-[13px]">
          <Pip tone="good" />
          <span className="font-mono font-medium tracking-tight">nightly-invoice-run</span>
          <span className="font-mono text-fd-muted-foreground">0 2 * * *</span>
          <span className="text-fd-muted-foreground">in the list and synced</span>
        </p>
        <p className="flex items-center gap-2.5 text-[13px]">
          <Pip tone="off" />
          <span className="font-mono font-medium tracking-tight line-through opacity-60">
            legacy-report
          </span>
          <span className="text-fd-muted-foreground">
            no longer shipped, then pruned and disabled atomically
          </span>
        </p>
      </div>
    </Diagram>
  );
}

/* ---------- 07 · flow control ---------- */

/** A slot inside a tenant's cap: filled while a job is active. */
function Slot({ filled = false }: { filled?: boolean }) {
  return (
    <span
      aria-hidden
      className={`h-3.5 w-7 rounded-[4px] ${filled ? "bg-signal-500/75" : "wh-rule border border-dashed"}`}
    />
  );
}

/** A job waiting on the queue side of the admission gate. */
function WaitingDot() {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-full border border-dashed border-fd-muted-foreground/60"
    />
  );
}

/**
 * The admission gate, drawn as one dashed vertical rule: jobs queue on the
 * left, the per-key slots sit on the right, and nothing crosses while the
 * key's slots are full. Rows keep zero vertical gap so the gate is unbroken.
 */
export function FlowControlDiagram() {
  const gate = "wh-rule border-l-2 border-dashed pl-4";
  return (
    <Diagram label='queue "mail" · maxActivePerKey: 2'>
      <div className="min-w-[30rem]">
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,15rem)] items-center">
          <span />
          <span className="wh-mono-label pb-2 pr-4 text-right">waiting</span>
          <span className={`wh-mono-label pb-2 ${gate}`}>active · cap 2</span>

          <span className="py-2 font-mono text-[13px] tracking-tight">tenant:acme</span>
          <span className="flex items-center justify-end gap-1.5 py-2 pr-4">
            <WaitingDot />
            <WaitingDot />
          </span>
          <span className={`flex items-center gap-1.5 py-2 ${gate}`}>
            <Slot filled />
            <Slot filled />
            <span className="pl-1.5 text-[12.5px] text-fd-muted-foreground">
              full, so two jobs hold at the gate
            </span>
          </span>

          <span className="py-2 font-mono text-[13px] tracking-tight">tenant:bloom</span>
          <span className="py-2 pr-4" />
          <span className={`flex items-center gap-1.5 py-2 ${gate}`}>
            <Slot filled />
            <Slot />
            <span className="pl-1.5 text-[12.5px] text-fd-muted-foreground">room for one more</span>
          </span>
        </div>

        <div className="wh-rule mt-3 flex items-center gap-4 border-t pt-3.5">
          <span className="w-[6.5rem] shrink-0 font-mono text-[13px] tracking-tight">
            provider-api
          </span>
          <span aria-hidden className="flex h-2 w-44 overflow-hidden rounded-full">
            <span className="flex-1 bg-signal-500/75" />
            <span className="flex-1 bg-signal-500/25" />
          </span>
          <span className="text-[12.5px] text-fd-muted-foreground">
            100 per second, bursting to 200
          </span>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- 08 · dependencies and children ---------- */

/** Two square elbows fanning one wire out to a success and a failure branch. */
function ForkWires() {
  return (
    <svg
      width="44"
      height="76"
      viewBox="0 0 44 76"
      fill="none"
      aria-hidden
      className="shrink-0 text-(--wh-rule)"
    >
      <path
        d="M0 38 H14 M14 38 V19 M14 19 H36 M14 38 V57 M14 57 H36"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path d="M31 15 L37 19 L31 23 M31 53 L37 57 L31 61" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/**
 * Row one: the dependent's declared reaction to each way its prerequisite can
 * settle. Row two: a parent suspending on a child and joining its result.
 */
export function DependenciesDiagram() {
  return (
    <Diagram label="dispatch releases only settled work">
      <div className="flex flex-col gap-5">
        <div className="flex items-center">
          <Chip>inventory.reserve</Chip>
          <ForkWires />
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <span className="wh-mono-label">succeeds</span>
              <Chip tone="good">order.confirm released</Chip>
            </div>
            <div className="flex items-center gap-2.5">
              <span className="wh-mono-label">fails</span>
              <Chip tone="ghost">order.confirm canceled</Chip>
            </div>
          </div>
        </div>

        <div className="flex items-center">
          <div className="flex flex-col items-start gap-1.5">
            <Chip>order.fulfill</Chip>
            <span className="text-[12.5px] text-fd-muted-foreground">
              suspends and holds no slot
            </span>
          </div>
          <LabeledWire label='runChild("charge")' className="w-20" />
          <Chip tone="accent">payment.capture</Chip>
          <LabeledWire label="result" className="w-12" />
          <Chip tone="good">receipt joined · resumes</Chip>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- 09 · debounce and throttle ---------- */

export function DebounceDiagram() {
  return (
    <Diagram label='debounce · schedule: "reset"'>
      <div className="flex items-center gap-0">
        <div className="shrink-0">
          <div className="flex items-center gap-1.5">
            {[0, 1, 2, 3].map((burst) => (
              <span key={burst} aria-hidden className="size-2 rounded-full bg-signal-500/40" />
            ))}
            <span aria-hidden className="size-2 rounded-full bg-signal-500" />
          </div>
          <p className="mt-2 text-[12.5px] text-fd-muted-foreground">
            five edits, one quiet window
          </p>
        </div>
        <Wire className="mx-4 w-10" arrow />
        <div className="shrink-0">
          <Chip tone="good">one pending job · latest payload</Chip>
          <p className="mt-2 font-mono text-[12.5px] text-fd-muted-foreground">
            outcome: &quot;accepted&quot;, then &quot;replaced&quot;
          </p>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- 10 · signals and human waits ---------- */

const waitSteps: readonly StepperStep[] = [
  {
    title: 'waitForSignal("security-scan")',
    tone: "wait",
    detail: "lease released, so the job holds nothing",
  },
  {
    title: "scan delivered once",
    tone: "run",
    detail: "idempotencyKey absorbs redelivery",
  },
  {
    title: 'waitForHuman("release-approval")',
    tone: "wait",
    detail: "decision context stored for the operator",
  },
  { title: "resumes with the answer", tone: "good", detail: "review.approved, exactly once" },
];

export function ExternalWaitsDiagram() {
  return (
    <Diagram label="two waits, zero slots held">
      <Stepper steps={waitSteps} />
    </Diagram>
  );
}

/* ---------- 11 · batch handlers ---------- */

export function BatchDiagram() {
  return (
    <Diagram label="one provider call, four leases">
      <div className="flex items-center gap-0">
        <div className="flex shrink-0 flex-col gap-1.5">
          {[1, 2, 3, 4].map((job) => (
            <Chip key={job}>email.send #{job}</Chip>
          ))}
        </div>
        <Wire className="mx-3 w-8" arrow />
        <Chip tone="accent">provider.sendMany(…)</Chip>
        <Wire className="mx-3 w-8" arrow />
        <div className="flex shrink-0 flex-col gap-2">
          {[1, 2, 3].map((job) => (
            <p key={job} className="flex items-center gap-2 text-[13px]">
              <Pip tone="good" />
              <span className="font-mono tracking-tight">#{job} succeeded</span>
            </p>
          ))}
          <p className="flex items-center gap-2 text-[13px]">
            <Pip tone="run" />
            <span className="font-mono tracking-tight">#4 failed</span>
            <span className="text-fd-muted-foreground">retries alone</span>
          </p>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- 12 · cancellation ---------- */

const cancelSteps: readonly StepperStep[] = [
  {
    title: "queue.cancel(jobId)",
    tone: "run",
    detail: "requestedBy and reason are recorded",
  },
  {
    title: "ctx.signal.aborted",
    tone: "run",
    detail: "deadline and timeout arrive on the same signal",
  },
  {
    title: "upload stops mid-request",
    tone: "good",
    detail: "fetch aborts; the job ends as canceled",
  },
];

export function CancellationDiagram() {
  return (
    <Diagram label="one signal, three causes">
      <Stepper steps={cancelSteps} />
    </Diagram>
  );
}

/* ---------- 13 · dead letters ---------- */

export function DeadLettersDiagram() {
  return (
    <Diagram label="the failure keeps its evidence">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[13px] tracking-tight">
          <span className="font-medium">invoice.capture</span>
          <span className="text-signal-600 dark:text-signal-400">CardDeclined</span>
          <span className="text-fd-muted-foreground">attempts exhausted</span>
          <span className="text-fd-muted-foreground">queue: billing</span>
        </div>
        <div className="flex items-center">
          <div className="flex flex-col items-start">
            <span className="wh-mono-label">redrive · requestedBy + reason + requestId</span>
            <Wire className="mt-1 w-56" />
          </div>
          <Wire className="w-4" arrow />
          <Chip tone="good">new job · lineage kept</Chip>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- Embedded dashboard ---------- */

export function DashboardEmbeddingDiagram() {
  return (
    <Diagram label="three hosts, one operator surface">
      <div className="flex min-w-[34rem] items-center gap-0">
        <div className="flex shrink-0 flex-col gap-1.5">
          <Chip>TypeScript · Fetch</Chip>
          <Chip>Python · WSGI</Chip>
          <Chip>Go · net/http</Chip>
        </div>
        <Wire className="mx-3 w-8" arrow />
        <Chip tone="accent">dashboard/v1</Chip>
        <Wire className="mx-3 w-8" arrow />
        <div className="shrink-0">
          <Chip tone="good">one React operator UI</Chip>
          <p className="mt-2 text-[12.5px] text-fd-muted-foreground">
            shared PostgreSQL reads and controls
          </p>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- Health and fleet operations ---------- */

export function FleetOperationsDiagram() {
  return (
    <Diagram label="read, decide, control">
      <div className="flex min-w-[38rem] items-center gap-0">
        <div className="shrink-0">
          <Chip>Queue.health()</Chip>
          <p className="mt-2 text-[12.5px] text-fd-muted-foreground">database-owned reasons</p>
        </div>
        <LabeledWire label="verdict" className="w-12" />
        <div className="shrink-0">
          <Chip tone="accent">incident script</Chip>
          <p className="mt-2 text-[12.5px] text-fd-muted-foreground">TypeScript, Python, or Go</p>
        </div>
        <LabeledWire label="audited request" className="w-16" />
        <div className="shrink-0">
          <Chip tone="good">fleet paused</Chip>
          <p className="mt-2 text-[12.5px] text-fd-muted-foreground">
            workers refresh registry state
          </p>
        </div>
      </div>
    </Diagram>
  );
}
