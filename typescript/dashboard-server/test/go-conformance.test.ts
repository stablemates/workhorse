import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  loadDashboardConformanceFixtures,
  verifyDashboardConformanceFixtures,
  type DashboardConformanceMode,
} from "../../../scripts/verify-dashboard-conformance.js";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const database = createDatabaseTestHarness(import.meta.url);
let server: ChildProcessWithoutNullStreams | undefined;

afterEach(async () => {
  server?.kill("SIGTERM");
  server = undefined;
  await database.teardown();
});

it("passes dashboard/v1 through the Go embedded backend", { timeout: 120_000 }, async () => {
  await database.setup();
  const { fixtures } = await loadDashboardConformanceFixtures(repository);
  server = spawn("go", ["run", "./dashboard/cmd/conformance"], {
    cwd: path.join(repository, "go"),
    env: { ...process.env, DATABASE_URL: database.databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const address = await firstLine(server);
  const report = await verifyDashboardConformanceFixtures(database.pool, repository, {
    async handle(mode: DashboardConformanceMode, request: Request) {
      const headers = new Headers(request.headers);
      headers.set("host", new URL(fixtures.harness.origin).host);
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
    `INSERT INTO workhorse.rate_limit_bucket(
       queue_name,bucket_scope,bucket_key,tokens,refilled_at)
     VALUES ('conformance-demo','queue','',0.5,clock_timestamp()+interval '1 hour')
     ON CONFLICT(queue_name,bucket_scope,bucket_key) DO UPDATE
       SET tokens=excluded.tokens,refilled_at=excluded.refilled_at`,
  );
  const selected = await database.pool.query<{ id: string; current_attempt: number }>(
    `SELECT job.id,runtime.current_attempt FROM workhorse.dashboard_job_v1 job
       JOIN workhorse.dashboard_job_runtime_v1 runtime ON runtime.job_id=job.id
      WHERE job.queue_name='conformance-demo' ORDER BY job.created_at LIMIT 1`,
  );
  const job = selected.rows[0]!;
  await database.pool.query(
    `INSERT INTO workhorse.job_event(job_id,attempt,event_type,details)
     VALUES ($1,$2::integer,'batch_dispatched',jsonb_build_object(
       'batch_id','dashboard-semantic-batch','members',jsonb_build_array(
         jsonb_build_object('job_id',$1::uuid,'attempt',$2::integer))))`,
    [job.id, job.current_attempt],
  );

  await new Promise((resolve) => setTimeout(resolve, 3_100));
  const queues = await rpc(address, fixtures.harness.origin, "queues", null);
  const queue = queues.queues.find((row: { queue: string }) => row.queue === "conformance-demo");
  expect(queue.concurrencyPolicy).toMatchObject({ maxActive: 7, maxActivePerKey: 2 });
  expect(queue.rateLimitPolicy.rate).toEqual({ limit: 10, intervalMs: 1000, burst: 12 });
  expect(queue.rateLimitPolicy.availableTokens).toBe(0.5);

  const detail = await rpc(address, fixtures.harness.origin, "jobDetail", { id: job.id });
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
  const sqlDetail = await rpc(address, fixtures.harness.origin, "jobDetail", { id: job.id }, true);
  expect(sqlDetail.batchExecutions[0]).toMatchObject({ id: "dashboard-semantic-batch" });
  const event = await database.pool.query<{ event_id: string }>(
    `SELECT event_id::text FROM workhorse.dashboard_job_event_v1
      WHERE job_id=$1 AND event_type='batch_dispatched' ORDER BY event_id DESC LIMIT 1`,
    [job.id],
  );
  const sqlEvent = await rpc(
    address,
    fixtures.harness.origin,
    "eventDetail",
    { id: `event:${event.rows[0]!.event_id}` },
    true,
  );
  expect(sqlEvent).toMatchObject({ kind: "event", jobId: job.id });
  await expect(
    rpc(address, fixtures.harness.origin, "settings", null, true),
  ).resolves.toHaveProperty("workers");

  await database.pool.query(
    `WITH job AS (
       INSERT INTO workhorse.job(queue_name,job_type,payload,max_attempts)
       VALUES ('conformance-demo','conformance.retry-summary','{}',3) RETURNING id
     ) INSERT INTO workhorse.job_runtime(job_id,queue_name,state,current_attempt,run_at)
     SELECT id,'conformance-demo','scheduled',2,clock_timestamp()+interval '30 seconds' FROM job`,
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
      host: new URL(origin).host,
      ...(databaseSQL ? { "x-workhorse-executor": "database-sql" } : {}),
    },
    body: JSON.stringify({ json: input }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).json;
}

function firstLine(process: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    process.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(output.slice(0, newline).trim());
    });
    process.once("exit", (code) => reject(new Error(`Go dashboard server exited with ${code}`)));
    process.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
  });
}
