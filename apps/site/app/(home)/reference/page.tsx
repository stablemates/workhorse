import type { Metadata } from "next";
import Link from "next/link";
import { CodeSample } from "@/components/code-sample";
import { Rule, SectionHeading, SpecRow } from "@/components/primitives";

export const metadata: Metadata = {
  title: "API reference",
  description:
    "The Workhorse public surface: Queue, Worker, the worker process runner, schema installation, and the error types each operation can raise.",
  alternates: { canonical: "/reference" },
};

const surface = [
  {
    id: "queue",
    title: "Queue",
    lede: "The durable protocol client. Every method is a single PostgreSQL statement or transaction, so it is safe to call from a request handler, a worker, or a deployment step.",
    entries: [
      {
        term: "enqueue(type, payload, options?, client?)",
        body: "Creates one ready or scheduled job. Passing an active PoolClient commits the job with your own writes. Options carry queue, tags, runAt, maxAttempts, retryPolicy, deadline, execution timeout, and idempotency.",
      },
      {
        term: "enqueueMany(requests, client?)",
        body: "Batches many enqueue requests into one statement. A material idempotency mismatch rolls back the entire batch rather than partially accepting it.",
      },
      {
        term: "cancel(jobId, options?)",
        body: "Cancels queued, scheduled, and durable-wait jobs immediately. An active job records one cancellation request that the owning attempt observes on its AbortSignal.",
      },
      {
        term: "getJob(jobId)",
        body: "Returns the authoritative snapshot for one identity, including persisted retry policy, attempt counters, and terminal outcome when present.",
      },
      {
        term: "listJobs(query?)",
        body: "Cursor-based cross-state listing over a dedicated operator projection. Payload is omitted by default and supports top-level redaction plus a byte ceiling.",
      },
      {
        term: "getJobTimeline(jobId, options?)",
        body: "Merges retained lifecycle events and closed attempts into one latest-first cursor stream, capped at 1,000 rows per page.",
      },
      {
        term: "listDeadLetters(query?)",
        body: "Pages terminal failures from the cold outcome relation on a stable (finishedAt, jobId) cursor, filtered by queue, type, tags, error name, or completion window.",
      },
      {
        term: "redrive(jobId, options)",
        body: "Creates a new ready job linked to the failed source. Requires actor, reason, and request identity; copies only safe fields and never copies checkpoints, waits, or attempts.",
      },
      {
        term: "redriveMany(filter, request, options?)",
        body: "Bounded bulk redrive over at most 1,000 oldest matching failures, with dryRun and a cursor for advancing a backlog.",
      },
      {
        term: "getRedriveLineage(jobId)",
        body: "Returns bounded retained redrive edges and reports whether traversal was truncated by retention.",
      },
      {
        term: "syncSchedules(namespace, definitions)",
        body: "Deploy-time synchronization of declarative recurring jobs. Definitions omitted from the namespace are disabled atomically in the target database.",
      },
      {
        term: "syncRetentionPolicy(policy)",
        body: "Persists one database-wide retention policy so every worker applies identical windows and per-pass bounds.",
      },
    ],
  },
  {
    id: "worker",
    title: "Worker",
    lede: "An in-process runtime that claims, executes, heartbeats, and finalizes work. Concurrency is per instance; scheduling and maintenance run on the same process with advisory-lock coordination.",
    entries: [
      {
        term: "new Worker(queue, options)",
        body: "Options include workerId, concurrency (1–100), scheduleNamespaces, lease and heartbeat cadences, the registry refresh interval, activity notifications, a retryDelayMs override, failpoints, and maintenance callbacks.",
      },
      {
        term: "handle(type, handler)",
        body: "Registers a typed handler. The context supplies checkpoint, sleep, sleepUntil, signal, attempt metadata, and the fence generation that owns the attempt.",
      },
      {
        term: "run() / runOnce() / stop()",
        body: "run() polls until stopped, runOnce() performs one claim pass, and stop() synchronously blocks new claims. Await the existing run() promise to know active handlers have drained.",
      },
      {
        term: "pause() / resume()",
        body: "Process-local claim control. Neither interrupts an active handler. A local resume() cannot clear an operator pause requested through the registry, which is why runtimeState() reports locallyPaused and remotelyPaused separately.",
      },
      {
        term: "queue.listWorkers() / queue.setWorkerPaused(id, paused, options?)",
        body: "Every worker announces itself in workhorse.worker_registry and refreshes its runtime state, so an operator process elsewhere can list the fleet and request a cooperative, durable pause with bounded attribution. The registry is never read by the claim path.",
      },
      {
        term: "runtimeState() / maintenanceTelemetry()",
        body: "Local inspection of concurrency, active slots, paused and draining flags, plus per-phase maintenance rows, durations, lock skips, and errors.",
      },
    ],
  },
  {
    id: "handler-context",
    title: "Handler context",
    lede: "The second argument to every handler. These are the only durable primitives available inside an attempt.",
    entries: [
      {
        term: "checkpoint(name, fn)",
        body: "Immutable named evidence. A committed checkpoint is replayed instead of re-executed after a retry or durable wait, and is fenced against stale workers.",
      },
      {
        term: "sleep(name, ms) / sleepUntil(name, date)",
        body: "Commits a named PostgreSQL timer, releases the lease and worker slot, then restarts the handler in the same logical attempt. The target is a not-before boundary, not an exact alarm.",
      },
      {
        term: "getProgress() / setProgress(value)",
        body: "Bounded latest-value operational projection, fenced to the owning attempt and rate limited to one changed write per 100 ms. It is observability, not a restart boundary.",
      },
      {
        term: "getCheckpoint(name) / getWait(name)",
        body: "Read a persisted restart boundary or a named durable wait from this activation's snapshot, without executing user code.",
      },
      {
        term: "job",
        body: "The claimed job: id, type, payload, attempt, maxAttempts, retryPolicy, deadlineAt, executionTimeoutMs, attemptTimeoutAt, fenceToken, and leaseExpiresAt.",
      },
      {
        term: "signal",
        body: "An AbortSignal that fires for cooperative cancellation, exceeded deadlines, and exceeded execution timeouts. JavaScript is never forcibly preempted.",
      },
    ],
  },
  {
    id: "process",
    title: "Worker processes",
    lede: "A dedicated process runner for production topologies, with bounded graceful shutdown and optional probes.",
    entries: [
      {
        term: "defineWorkerProcess(definition)",
        body: "Declares the workers, queues, and handlers a process owns, so the same definition can be started programmatically or by the CLI.",
      },
      {
        term: "runWorkerProcess / startWorkerProcess",
        body: "runWorkerProcess owns signals and resolves after drain; startWorkerProcess returns a handle for tests and embedded hosts.",
      },
      {
        term: "workhorse worker",
        body: "The packaged CLI entry point. Honors SIGTERM and SIGINT with a bounded drain and can expose readiness and liveness probes.",
      },
    ],
  },
  {
    id: "schema",
    title: "Schema",
    lede: "Installation and compatibility helpers. The schema is plain SQL and requires no PostgreSQL extension.",
    entries: [
      {
        term: "installSchema(pool)",
        body: "Installs the canonical schema into a clean database, including time-partitioned history and the current UTC day plus three future daily partitions. Upgrades require an explicit migration path.",
      },
      {
        term: "assertSchemaCompatible(pool)",
        body: "Fails fast when the connected database is older or newer than the client expects, instead of silently issuing incompatible statements.",
      },
      {
        term: "readSchemaVersion(pool) / WORKHORSE_SCHEMA_VERSION",
        body: "Reads the installed version and exposes the version this client was built against, for deployment gating.",
      },
    ],
  },
];

const errorSample = `import {
  CancellationRequestedError,
  CheckpointConflictError,
  CheckpointLeaseLostError,
  DeadlineExceededError,
  EnqueueIdempotencyConflictError,
  ExecutionTimeoutError,
  RedriveIdempotencyConflictError,
  WaitConflictError,
  WaitLeaseLostError,
  WaitLimitExceededError,
} from "@workhorse/core";

try {
  await queue.enqueue("invoice.capture", payload, {
    idempotency: { key: "capture:inv-1", scope: "tenant-42" },
  });
} catch (error) {
  if (error instanceof EnqueueIdempotencyConflictError) {
    // The key exists with a materially different request. The whole
    // statement or batch was rolled back; nothing was partially accepted.
    console.error(error.details);
  }
  throw error;
}`;

export default function ReferencePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-14 lg:px-8">
      <p className="wh-mono-label">Reference</p>
      <h1 className="mt-4 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
        The complete public surface, and what each call promises.
      </h1>
      <p className="mt-5 max-w-3xl text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
        Workhorse exposes a small protocol on purpose. Every operation below is executed by
        PostgreSQL, so the same guarantees hold from any client that speaks the protocol. Prose
        descriptions live here; the exact type signatures ship with the package and are checked by
        your compiler.
      </p>

      <nav
        aria-label="Reference sections"
        className="wh-rule mt-8 flex flex-wrap gap-x-5 gap-y-2 border-y py-3"
      >
        {surface.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="font-mono text-[12.5px] text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            {section.title}
          </a>
        ))}
        <a
          href="#errors"
          className="font-mono text-[12.5px] text-fd-muted-foreground transition-colors hover:text-fd-foreground"
        >
          Errors
        </a>
      </nav>

      <div className="mt-14 space-y-16">
        {surface.map((section, index) => (
          <section key={section.id} id={section.id} className="scroll-mt-24">
            <SectionHeading
              index={`${String(index + 1).padStart(2, "0")} / ${section.id}`}
              title={section.title}
              lede={section.lede}
            />
            <dl className="wh-panel mt-7 overflow-hidden rounded-xl">
              {section.entries.map((entry) => (
                <SpecRow key={entry.term} term={entry.term}>
                  {entry.body}
                </SpecRow>
              ))}
            </dl>
          </section>
        ))}

        <section id="errors" className="scroll-mt-24">
          <SectionHeading
            index="06 / errors"
            title="Structured failures, not string matching."
            lede="Conflicts, lost leases, and exceeded bounds are distinct error types carrying safe diagnostic details. Raw idempotency keys are never persisted or echoed; errors expose a bounded preview and a key digest instead."
          />
          <div className="mt-7">
            <CodeSample code={errorSample} title="errors.ts" meta="server" />
          </div>
        </section>
      </div>

      <Rule />

      <div className="mt-8 flex flex-wrap gap-6">
        <Link href="/docs" className="wh-link-underline text-[14px] font-medium">
          Conceptual documentation
        </Link>
        <Link href="/integrations" className="wh-link-underline text-[14px] font-medium">
          Drizzle, Hono, and dashboard packages
        </Link>
      </div>
    </div>
  );
}
