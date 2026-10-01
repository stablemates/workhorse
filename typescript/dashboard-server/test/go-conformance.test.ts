import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  loadDashboardConformanceFixtures,
  verifyDashboardConformanceFixtures,
  type DashboardConformanceMode,
} from "../../../scripts/verify-dashboard-conformance.js";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const database = createDatabaseTestHarness(import.meta.url);
let scope: Scope | undefined;

beforeEach(() => {
  scope = new Scope();
});

afterEach(async () => {
  const failures = await scope!.close();
  scope = undefined;
  await database.teardown();
  if (failures.length > 0) throw new AggregateError(failures, "Go conformance cleanup failed");
});

it("passes dashboard/v1 through the Go embedded backend", { timeout: 120_000 }, async () => {
  // A test that times out keeps running after afterEach, so it owns resources through its scope.
  const owner = scope!;
  await database.setup();
  const { fixtures } = await loadDashboardConformanceFixtures(repository);
  const directory = await mkdtemp(path.join(tmpdir(), "workhorse-go-conformance-"));
  await owner.own(() => rm(directory, { recursive: true, force: true }));
  // `go run` exits on SIGTERM without forwarding it, so spawn the built server to signal it directly.
  const binary = path.join(directory, "conformance");
  await build(owner, binary, directory);
  owner.assertOpen();
  // The server exits when stdin closes, which also covers a runner that dies before afterEach.
  const server = spawn(binary, [], {
    env: { ...process.env, DATABASE_URL: database.databaseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await owner.own(() => stopServer(server));
  const address = await firstLine(server);
  const report = await verifyDashboardConformanceFixtures(database.pool, repository, {
    async handle(mode: DashboardConformanceMode, request: Request) {
      const headers = new Headers(request.headers);
      headers.set("x-workhorse-conformance-host", new URL(request.url).host);
      headers.set("x-workhorse-conformance-mode", mode);
      const response = await fetch(`http://${address}${new URL(request.url).pathname}`, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
      });
      return response;
    },
  });
  expect(report.exchanges).toBeGreaterThan(0);

  await database.pool.query(
    `INSERT INTO workhorse.concurrency_policy(queue_name,namespace,max_active,max_active_per_key)
       VALUES ('conformance-demo','dashboard-test',7,2)
       ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
         max_active=excluded.max_active,max_active_per_key=excluded.max_active_per_key`,
  );
  await database.pool.query(
    `INSERT INTO workhorse.rate_limit_policy(
       queue_name,namespace,rate_limit,rate_interval_ms,rate_burst,
       per_key_limit,per_key_interval_ms,per_key_burst)
     VALUES ('conformance-demo','dashboard-test',10,1000,12,3,2000,4)
     ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
       rate_limit=excluded.rate_limit,rate_interval_ms=excluded.rate_interval_ms,
       rate_burst=excluded.rate_burst,per_key_limit=excluded.per_key_limit,
       per_key_interval_ms=excluded.per_key_interval_ms,per_key_burst=excluded.per_key_burst`,
  );
  await database.pool.query(
    `INSERT INTO workhorse.admission_shard(queue_name,shard,tokens,refilled_at)
     VALUES ('conformance-demo',0,0.5,clock_timestamp()+interval '1 hour')
     ON CONFLICT(queue_name,shard) DO UPDATE
       SET tokens=excluded.tokens,refilled_at=excluded.refilled_at`,
  );
  const selected = await database.pool.query<{ id: string; current_attempt: number }>(
    `SELECT task.id,runtime.current_attempt FROM workhorse.dashboard_task_v1 task
       JOIN workhorse.dashboard_task_runtime_v1 runtime ON runtime.task_id=task.id
      WHERE task.queue_name='conformance-demo' ORDER BY task.created_at LIMIT 1`,
  );
  const task = selected.rows[0]!;
  await database.pool.query(
    `INSERT INTO workhorse.task_event(task_id,attempt,event_type,details)
     VALUES ($1,$2::integer,'batch_dispatched',jsonb_build_object(
       'batch_id','dashboard-semantic-batch','members',jsonb_build_array(
         jsonb_build_object('task_id',$1::uuid,'attempt',$2::integer))))`,
    [task.id, task.current_attempt],
  );

  await new Promise((resolve) => {
    setTimeout(resolve, 3_100);
  });
  const queues = await rpc(address, fixtures.harness.origin, "queues", null);
  const queue = queues.queues.find((row: { queue: string }) => row.queue === "conformance-demo");
  expect(queue.concurrencyPolicy).toMatchObject({ maxActive: 7, maxActivePerKey: 2 });
  expect(queue.rateLimitPolicy.rate).toEqual({ limit: 10, intervalMs: 1000, burst: 12 });
  expect(queue.rateLimitPolicy.availableTokens).toBe(0.5);

  const detail = await rpc(address, fixtures.harness.origin, "taskDetail", { id: task.id });
  expect(detail.concurrencyPolicy).toMatchObject({ maxActive: 7, maxActivePerKey: 2 });
  expect(detail.batchExecutions[0]).toMatchObject({ id: "dashboard-semantic-batch" });

  const sqlQueues = await rpc(address, fixtures.harness.origin, "queues", null, true);
  expect(
    sqlQueues.queues.find((row: { queue: string }) => row.queue === "conformance-demo")
      .rateLimitPolicy.availableTokens,
  ).toBe(0.5);
  const sqlFacets = await rpc(address, fixtures.harness.origin, "taskFacets", null, true);
  expect(Array.isArray(sqlFacets.queues)).toBe(true);
  expect(Array.isArray(sqlFacets.workers)).toBe(true);
  const sqlDetail = await rpc(
    address,
    fixtures.harness.origin,
    "taskDetail",
    { id: task.id },
    true,
  );
  expect(sqlDetail.batchExecutions[0]).toMatchObject({ id: "dashboard-semantic-batch" });
  const event = await database.pool.query<{ event_id: string }>(
    `SELECT event_id::text FROM workhorse.dashboard_task_event_v1
      WHERE task_id=$1 AND event_type='batch_dispatched'
      ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
    [task.id],
  );
  const sqlEvent = await rpc(
    address,
    fixtures.harness.origin,
    "eventDetail",
    { id: `event:${event.rows[0]!.event_id}` },
    true,
  );
  expect(sqlEvent).toMatchObject({ kind: "event", taskId: task.id });
  await expect(
    rpc(address, fixtures.harness.origin, "settings", null, true),
  ).resolves.toHaveProperty("workers");

  await database.pool.query(
    `WITH task AS (
       INSERT INTO workhorse.task(queue_name,task_type,payload,max_attempts)
       VALUES ('conformance-demo','conformance.retry-summary','{}',3) RETURNING id
     ) INSERT INTO workhorse.task_runtime(task_id,queue_name,state,current_attempt,run_at)
     SELECT id,'conformance-demo','scheduled',2,clock_timestamp()+interval '30 seconds' FROM task`,
  );
  const system = await rpc(address, fixtures.harness.origin, "system", { window: "1h" });
  expect(system.retryStorm.buckets[0].count).toBeGreaterThanOrEqual(1);
  expect(system.retryStorm.topTypes[0].count).toBeGreaterThanOrEqual(1);
});

async function rpc(
  address: string,
  origin: string,
  procedure: string,
  input: unknown,
  databaseSQL = false,
) {
  const response = await fetch(`http://${address}/workhorse/rpc/dashboard/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-workhorse-conformance-host": new URL(origin).host,
      ...(databaseSQL ? { "x-workhorse-executor": "database-sql" } : {}),
    },
    body: JSON.stringify({ json: input }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).json;
}

/** Cleanups for one test, run newest first; a resource created after close is released at once. */
class Scope {
  readonly #cleanups: (() => Promise<unknown>)[] = [];
  #closed = false;

  assertOpen() {
    if (this.#closed) throw new Error("The test was torn down before it finished starting");
  }

  async own(cleanup: () => Promise<unknown>) {
    if (!this.#closed) {
      this.#cleanups.push(cleanup);
      return;
    }
    await cleanup();
    this.assertOpen();
  }

  async close() {
    this.#closed = true;
    const failures: unknown[] = [];
    for (const cleanup of this.#cleanups.splice(0).toReversed()) {
      await cleanup().catch((error: unknown) => failures.push(error));
    }
    return failures;
  }
}

async function build(owner: Scope, binary: string, directory: string) {
  // The go command compiles in child processes, so it leads its own process group to be stopped whole.
  const child = spawn("go", ["build", "-o", binary, "./dashboard/cmd/conformance"], {
    cwd: path.join(repository, "go"),
    detached: true,
    env: { ...process.env, GOTMPDIR: directory },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  let done = false;
  const finished = settled(child).finally(() => {
    done = true;
  });
  await owner.own(async () => {
    if (child.pid !== undefined && !done) process.kill(-child.pid, "SIGKILL");
    await finished;
  });
  const code = await finished;
  if (code !== 0) throw new Error(`go build exited with ${code}: ${errors.trim()}`);
}

/** Resolves once the process and every holder of its stderr are gone, or it never started. */
function settled(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
}

async function stopServer(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  // A handler stuck in a query can hold graceful shutdown open, so bound it.
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
  }
}

function firstLine(process: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    process.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(output.slice(0, newline).trim());
    });
    process.once("exit", (code) =>
      reject(new Error(`Go dashboard server exited with ${code}: ${errors.trim()}`)),
    );
    process.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
  });
}
