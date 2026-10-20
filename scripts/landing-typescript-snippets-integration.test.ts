import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import ts from "typescript";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as workhorse from "../typescript/core/src/index.js";
import { Admin, Pool, Queue, Worker } from "../typescript/core/src/index.js";
import type { Json, TaskSnapshot, WorkerOptions } from "../typescript/core/src/index.js";
import { landingSnippetLanguages, landingSnippets } from "../site/lib/landing-snippets.js";
import type { LandingSnippetId } from "../site/lib/landing-snippets.js";
import { createDatabaseTestHarness } from "../typescript/core/test/support/db.js";

// The TypeScript landing snippets are fragments: they use names such as `queue`, `worker`, and
// `orderId` that the page does not declare. This test transpiles each snippet, gives it those
// names, and runs it on a scratch database, so a snippet that sends a value PostgreSQL refuses
// fails here. The Python, Go, and Rust snippets run in the tests of their own language.

// Snippets that this test does not run, and why.
const notRun: Partial<Record<LandingSnippetId, string>> = {
  ormDrizzle:
    "needs drizzle-orm and an account table definition; typescript/adapter-conformance runs the adapter's transactional enqueue",
  ormPrisma:
    "needs a generated Prisma client; typescript/adapter-conformance runs the adapter's transactional enqueue",
  ormTypeorm:
    "needs typeorm and an Account entity; typescript/adapter-conformance runs the adapter's transactional enqueue",
  ormKysely:
    "needs kysely and an account table; typescript/adapter-conformance runs the adapter's transactional enqueue",
};

const waitMs = 15_000;

const harness = createDatabaseTestHarness(import.meta.url);
const queue = new Queue(harness.pool);
const admin = new Admin(harness.pool);
const tested = new Set<string>();

beforeAll(harness.setup);
beforeEach(harness.reset);
afterAll(harness.teardown);

type Bindings = Record<string, unknown>;

/**
 * Runs one snippet with `bindings` for its free names and `modules` for its imports. Returns the
 * top-level names in `returns` and the snippet's exports.
 */
async function runSnippet(
  id: LandingSnippetId,
  bindings: Bindings,
  options: { modules?: Record<string, object>; returns?: readonly string[] } = {},
): Promise<Record<string, unknown>> {
  tested.add(id);
  const modules: Record<string, object> = {
    "@stablemates/workhorse": workhorse,
    ...options.modules,
  };
  const javascript = ts.transpileModule(landingSnippets[id], {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exported: string[] = [];
  const body = javascript
    .replace(/^import \{([^}]*)\} from "([^"]+)";$/gm, (_line, names: string, module: string) => {
      if (!(module in modules)) throw new Error(`${id} imports ${module}, which the test lacks`);
      return `const {${names.replaceAll(" as ", ": ")}} = __modules[${JSON.stringify(module)}];`;
    })
    .replace(/^export default /m, "__exports.default = ")
    .replace(
      /^export (async )?function (\w+)/gm,
      (_line, async: string | undefined, name: string) => {
        exported.push(name);
        return `${async ?? ""}function ${name}`;
      },
    );
  if (/^\s*(?:import|export)\b/m.test(body))
    throw new Error(`${id} has a module form the test lacks`);
  const names = Object.keys(bindings);
  const tail = [
    ...exported.map((name) => `__exports.${name} = ${name};`),
    `return { ...__exports, ${(options.returns ?? []).join(", ")} };`,
  ].join("\n");
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...source: string[]
  ) => (...values: unknown[]) => Promise<Record<string, unknown>>;
  const run = new AsyncFunction("__modules", "__exports", ...names, `${body}\n${tail}`);
  return run(modules, {}, ...names.map((name) => bindings[name]));
}

/** A worker that claims at once, for `drain`. */
function pollingWorker(queues: readonly string[] = ["default"], options: WorkerOptions = {}) {
  return new Worker(queue, { queues, concurrency: 3, pollMs: 20, ...options });
}

async function task(taskId: string): Promise<TaskSnapshot> {
  const snapshot = await admin.getTask(taskId);
  if (snapshot === null) throw new Error(`task ${taskId} does not exist`);
  return snapshot;
}

async function until<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await sleep(20);
  }
}

/** Runs `worker` once at a time until the task reaches `state`. */
async function drain(worker: Worker, taskId: string, state: string): Promise<TaskSnapshot> {
  return until(async () => {
    const snapshot = await task(taskId);
    if (snapshot.state === state) return snapshot;
    await worker.runOnce();
    return undefined;
  }, `task ${taskId} to reach ${state}`);
}

/** Waits until a task of `type` reaches `state`, and returns it. */
async function taskOfType(type: string, state: string): Promise<TaskSnapshot> {
  return until(async () => {
    const row = await harness.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM workhorse.task WHERE task_type = $1",
      [type],
    );
    const id = row.rows[0]?.id;
    if (id === undefined) return undefined;
    const snapshot = await task(id);
    return snapshot.state === state ? snapshot : undefined;
  }, `a ${type} task in ${state}`);
}

/** Modules whose `Pool` and `Worker` record what a snippet builds, so a test can close them. */
function recordingModules() {
  const pools: Pool[] = [];
  const workers: Worker[] = [];
  class RecordedPool extends Pool {
    constructor(...options: ConstructorParameters<typeof Pool>) {
      super(...options);
      pools.push(this);
    }
  }
  class RecordedWorker extends Worker {
    constructor(owner: Queue, options: WorkerOptions = {}) {
      super(owner, { ...options, pollMs: 20 });
      workers.push(this);
    }
  }
  return {
    modules: {
      "@stablemates/workhorse": { ...workhorse, Pool: RecordedPool, Worker: RecordedWorker },
    },
    pools,
    workers,
    process: { env: { DATABASE_URL: harness.databaseUrl } },
  };
}

describe("TypeScript landing snippets", () => {
  it("hero enqueues and completes a welcome email", async () => {
    const recorded = recordingModules();
    const running = runSnippet("hero", { process: recorded.process }, recorded);

    const snapshot = await taskOfType("email.welcome", "succeeded");
    for (const worker of recorded.workers) worker.stop();
    await running;
    await Promise.all(recorded.pools.map((pool) => pool.end()));

    expect(snapshot.result).toEqual({ deliveredTo: "ada@example.com" });
  });

  it("languageTypeScript enqueues a welcome email", async () => {
    const recorded = recordingModules();
    await runSnippet("languageTypeScript", { process: recorded.process }, recorded);
    await Promise.all(recorded.pools.map((pool) => pool.end()));

    const snapshot = await taskOfType("email.welcome", "ready");
    expect(snapshot.payload).toEqual({ to: "ada@example.com" });
  });

  it("enqueue commits the order and its task together", async () => {
    await harness.pool.query(
      "CREATE TABLE IF NOT EXISTS orders (id text PRIMARY KEY, total bigint)",
    );
    await runSnippet("enqueue", { pool: harness.pool, queue, orderId: "order-1", total: 42 });

    const order = await harness.pool.query(
      "SELECT total::int AS total FROM orders WHERE id = 'order-1'",
    );
    expect(order.rows).toEqual([{ total: 42 }]);
    const snapshot = await taskOfType("order.confirm", "ready");
    expect(snapshot.payload).toEqual({ orderId: "order-1" });
  });

  it("checkpoints complete an invoice", async () => {
    const worker = pollingWorker();
    const emails: unknown[] = [];
    await runSnippet("checkpoints", {
      worker,
      payments: { charge: async (amount: number) => ({ id: `ch_${amount}` }) },
      renderInvoice: async (chargeId: string) => ({ chargeId }),
      sendEmail: async (to: string, pdf: Json) => emails.push([to, pdf]),
    });
    const taskId = await queue.enqueue("invoice.issue", { amount: 5, email: "ada@example.com" });

    const snapshot = await drain(worker, taskId, "succeeded");

    expect(snapshot.result).toEqual({ chargeId: "ch_5" });
    expect(emails).toEqual([["ada@example.com", { chargeId: "ch_5" }]]);
  });

  it("sleep suspends the settlement", async () => {
    const worker = pollingWorker();
    await runSnippet("sleep", {
      worker,
      placeOrder: async (payload: { orderId: string }) => ({ id: payload.orderId }),
      confirm: async () => undefined,
    });
    const taskId = await queue.enqueue("order.settle", { orderId: "order-1" });

    const snapshot = await drain(worker, taskId, "scheduled");

    expect(new Date(snapshot.runAt).getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
  });

  it("retries store the retry policy", async () => {
    const kickoffTime = new Date(Date.now() + 2 * 60 * 60_000);
    await runSnippet("retries", { queue, matchId: "match-1", kickoffTime });

    const snapshot = await taskOfType("match.reminder", "ready");
    expect(snapshot.retryPolicy).toEqual({
      type: "exponential",
      initialDelayMs: 1_000,
      multiplier: 2,
      maxDelayMs: 60_000,
    });
    expect([snapshot.maxAttempts, snapshot.executionTimeoutMs]).toEqual([5, 30_000]);
  });

  it("idempotency returns the same task twice", async () => {
    const first = await runSnippet("idempotency", { queue }, { returns: ["taskId"] });
    const second = await runSnippet("idempotency", { queue }, { returns: ["taskId"] });

    expect(second.taskId).toBe(first.taskId);
    expect((await task(first.taskId as string)).queue).toBe("billing");
  });

  it("schedules sync the schedule and build a worker", async () => {
    const { worker } = await runSnippet("schedules", { queue, Worker }, { returns: ["worker"] });

    expect(worker).toBeInstanceOf(Worker);
    const schedule = await harness.pool.query(
      `SELECT cron_expression, task_type FROM workhorse.schedule_definition
        WHERE namespace = 'billing' AND schedule_name = 'nightly-invoice-run'`,
    );
    expect(schedule.rows).toEqual([
      { cron_expression: "0 2 * * *", task_type: "invoices.generate" },
    ]);
  });

  it("flowControl stores its policies and enqueues mail", async () => {
    await runSnippet("flowControl", { queue, messageId: "msg-1", tenantId: "acme" });

    const concurrency = await harness.pool.query(
      "SELECT max_active, max_active_per_key FROM workhorse.concurrency_policy WHERE queue_name = 'mail'",
    );
    const rate = await harness.pool.query(
      `SELECT rate_limit, rate_interval_ms, rate_burst FROM workhorse.rate_limit_policy
        WHERE queue_name = 'provider-api'`,
    );
    expect(concurrency.rows).toEqual([{ max_active: 20, max_active_per_key: 2 }]);
    expect(rate.rows).toEqual([{ rate_limit: 100, rate_interval_ms: 1_000, rate_burst: 200 }]);
    const snapshot = await taskOfType("mail.send", "ready");
    expect([snapshot.queue, snapshot.concurrencyKey]).toEqual(["mail", "tenant:acme"]);
  });

  it("dependencies block the confirmation and join a child", async () => {
    const worker = pollingWorker(["default", "payments"]);
    await runSnippet("dependencies", { queue, worker, orderId: "order-1" });
    const inventory = await taskOfType("inventory.reserve", "ready");
    const confirmation = await taskOfType("order.confirm", "blocked");
    expect(confirmation.prerequisiteTaskIds).toEqual([inventory.id]);

    worker.handle("payment.capture", async (capture) => ({ captured: capture }));
    const taskId = await queue.enqueue("order.fulfill", { id: "order-1" });
    const snapshot = await drain(worker, taskId, "succeeded");

    expect(snapshot.result).toEqual({ receipt: { captured: { orderId: "order-1" } } });
  });

  it("coalescing keeps the latest revision", async () => {
    const logged: unknown[] = [];
    await runSnippet("coalescing", {
      queue,
      documentId: "doc-1",
      quietPeriodMs: 60_000,
      logger: { info: (...values: unknown[]) => logged.push(values) },
    });

    expect(logged).toEqual([["accepted", "replaced"]]);
    const snapshot = await taskOfType("search.reindex", "scheduled");
    expect(snapshot.payload).toEqual({ documentId: "doc-1", revision: 2 });
  });

  it("externalWaits resume with the scan and the review", async () => {
    const worker = pollingWorker();
    const taskId = await queue.enqueue("release.publish", { id: "v1" });
    const scanResult = { clean: true, deliveryId: "scan-1" };
    const deliveries: unknown[] = [];
    // PostgreSQL delivers a signal only to a task that waits for it. In the snippet the scanner
    // sends the scan later, so the test lets the task reach its wait before the call goes through.
    const scanner = {
      sendSignal: async (...signal: Parameters<Queue["sendSignal"]>) => {
        await drain(worker, taskId, "scheduled");
        deliveries.push(await queue.sendSignal(...signal));
      },
    };
    await runSnippet("externalWaits", { worker, queue: scanner, taskId, scanResult });

    expect(deliveries).toMatchObject([{ status: "delivered" }]);
    await drain(worker, taskId, "scheduled");
    await queue.completeHumanWait(
      taskId,
      "release-approval",
      { approved: true },
      {
        idempotencyKey: "review-1",
        requestedBy: "landing-test",
      },
    );
    const snapshot = await drain(worker, taskId, "succeeded");

    expect(snapshot.result).toEqual({ published: true });
  });

  it("batchHandlers complete each task with its delivery", async () => {
    const worker = pollingWorker();
    await runSnippet("batchHandlers", {
      worker,
      batchSize: 3,
      batchLingerMs: 50,
      provider: {
        sendMany: async (payloads: { to: string }[]) =>
          payloads.map(({ to }) =>
            to.startsWith("bounce") ? { error: "bounced" } : { id: `sent:${to}` },
          ),
      },
    });
    const sent = await queue.enqueue("email.send", { to: "ada@example.com" });
    const bounced = await queue.enqueue(
      "email.send",
      { to: "bounce@example.com" },
      { maxAttempts: 1 },
    );

    expect((await drain(worker, sent, "succeeded")).result).toBe("sent:ada@example.com");
    expect((await drain(worker, bounced, "failed")).state).toBe("failed");
  });

  it("cancellation cancels the export and runs the next one", async () => {
    const worker = pollingWorker();
    const rows = { rows: [{ id: 1 }, { id: 2 }] };
    const taskId = await queue.enqueue("rows.export", rows);
    const uploaded: unknown[] = [];
    await runSnippet("cancellation", {
      worker,
      queue,
      taskId,
      upload: async (row: Json, { signal }: { signal: AbortSignal }) => {
        expect(signal.aborted).toBe(false);
        uploaded.push(row);
      },
    });

    const canceled = await task(taskId);
    expect(canceled.state).toBe("canceled");
    expect(canceled.error).toMatchObject({
      requested_by: "operator@example.com",
      reason: "customer withdrew the request",
    });
    const next = await queue.enqueue("rows.export", rows);
    expect((await drain(worker, next, "succeeded")).result).toEqual({ stopped: false });
    expect(uploaded).toEqual(rows.rows);
  });

  it("deadLetters redrive the declined billing task", async () => {
    const worker = pollingWorker(["billing"]);
    worker.handle("invoice.capture", async () => {
      const error = new Error("the card was declined");
      error.name = "CardDeclined";
      throw error;
    });
    const taskId = await queue.enqueue("invoice.capture", {}, { queue: "billing", maxAttempts: 1 });
    await drain(worker, taskId, "failed");

    await runSnippet("deadLetters", { pool: harness.pool, Admin });

    // A redrive leaves the failed task as it is and enqueues a copy of it.
    expect((await task(taskId)).state).toBe("failed");
    const copy = await harness.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM workhorse.task WHERE task_type = 'invoice.capture' AND id <> $1",
      [taskId],
    );
    const copied = await task(copy.rows[0]!.id);
    expect([copied.queue, copied.state]).toEqual(["billing", "ready"]);
  });

  it("operateDashboard serves an operator and refuses a stranger", async () => {
    // A computed URL keeps the dashboard server source out of the scripts type check, which
    // does not include that project.
    const serverUrl = new URL(
      "../typescript/dashboard-server/src/server/index.ts",
      import.meta.url,
    );
    const server = (await import(serverUrl.href)) as object;
    const { GET } = await runSnippet(
      "operateDashboard",
      {
        pool: harness.pool,
        isAdmin: (request: Request) => request.headers.get("x-admin") === "ada",
      },
      { modules: { "@stablemates/workhorse-dashboard/server": server } },
    );
    const get = GET as (request: Request) => Promise<Response>;

    const operator = await get(
      new Request("http://localhost/workhorse", { headers: { "x-admin": "ada" } }),
    );
    const stranger = await get(new Request("http://localhost/workhorse"));
    const elsewhere = await get(new Request("http://localhost/elsewhere"));

    expect([401, 403]).not.toContain(operator.status);
    expect(operator.status).toBeLessThan(500);
    expect(stranger.status).toBe(403);
    expect(elsewhere.status).toBe(404);
  });

  it("operateHealth reads health and live tasks", async () => {
    await queue.enqueue("email.send", {});
    const warnings: unknown[] = [];
    const { health, live } = await runSnippet(
      "operateHealth",
      {
        pool: harness.pool,
        Admin,
        console: { warn: (...values: unknown[]) => warnings.push(values) },
      },
      { returns: ["health", "live"] },
    );

    expect(health).toMatchObject({ status: { level: expect.any(String) } });
    expect(live).toMatchObject({ items: [] });
    expect(warnings.length).toBe(
      (health as { status: { reasons: unknown[] } }).status.reasons.length,
    );
  });

  it("operateFleet pauses only billing workers", async () => {
    const workers = ["billing", "email"].map(
      (name) => new Worker(queue, { queue: name, workerId: `${name}-worker`, pollMs: 20 }),
    );
    const running = workers.map((worker) => worker.run());
    try {
      await until(
        async () => ((await admin.listWorkers()).length === 2 ? true : undefined),
        "both workers to register",
      );

      await runSnippet("operateFleet", { pool: harness.pool, Admin });

      const paused = (await admin.listWorkers())
        .map((entry) => [entry.workerId, entry.paused])
        .toSorted();
      expect(paused).toEqual([
        ["billing-worker", true],
        ["email-worker", false],
      ]);
    } finally {
      for (const worker of workers) worker.stop();
      await Promise.all(running);
    }
  });

  it("deploy defines a worker process that sends email", async () => {
    const recorded = recordingModules();
    const { default: definition } = await runSnippet(
      "deploy",
      { process: recorded.process },
      {
        modules: {
          ...recorded.modules,
          "./tasks.js": {
            sendEmail: async (email: { to: string }) => ({ sent: email.to }),
            generateReport: async () => ({ generated: true }),
          },
        },
      },
    );
    await queue.enqueue("email.send", { to: "ada@example.com" });
    const signals = new EventEmitter();

    const running = workhorse.runWorkerProcess(definition as workhorse.WorkerProcessDefinition, {
      signalSource: signals,
      forceExit: (code) => {
        throw new Error(`the worker process exited with ${code}`);
      },
    });
    const snapshot = await taskOfType("email.send", "succeeded");
    signals.emit("SIGTERM");
    await running;

    expect(snapshot.result).toEqual({ sent: "ada@example.com" });
  });

  it("runs every TypeScript snippet or records why it cannot", () => {
    const typeScript = Object.keys(landingSnippets).filter(
      (id) => landingSnippetLanguages[id as LandingSnippetId] === undefined,
    );
    for (const id of typeScript) {
      expect(tested.has(id) !== id in notRun, `${id} must run or name a reason`).toBe(true);
    }
  });
});
