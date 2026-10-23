import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, installSchema, Queue, Worker } from "../../core/src/index.js";
import { databaseName, localDatabaseUrl } from "../../core/src/local-database.js";
import { createDatabaseTestHarness, ensureTestDatabase } from "../../core/test/support/db.js";
import { createDashboardHost } from "../src/server/host.js";
import { createDashboardOperatorControllers } from "../src/server/operator-controllers.js";
import type { DashboardRouter } from "../src/server/router.js";

/**
 * Runs the SQL of "Database roles" in `docs/architecture/operations.md` as written, on a scratch
 * database, and proves what each role can and cannot do. The docs and this test share one source:
 * a change to a documented grant changes what this test runs.
 */
const sections = rolesSections();
const sourceUrl = localDatabaseUrl("test");
const canCreateRoles = await probeCreateRole(sourceUrl);
if (!canCreateRoles && process.env.CI) {
  throw new Error(
    "The database user of DATABASE_URL_TEST cannot create roles, so the database role test cannot run in CI",
  );
}
const skipReason =
  "skipped: the database user of DATABASE_URL_TEST has neither SUPERUSER nor CREATEROLE, and CI is not set";
if (!canCreateRoles) process.stderr.write(`database-roles-integration.test.ts ${skipReason}\n`);

describe.skipIf(!canCreateRoles)("documented database roles", () => {
  const harness = createDatabaseTestHarness(import.meta.url, { poolOwner: "caller" });
  const name = databaseName(harness.databaseUrl);
  const suffix = randomBytes(4).toString("hex");
  const role = (base: string): string => `${base}_${suffix}`;
  const owner = role("workhorse_owner");
  const reader = role("workhorse_dashboard_read");
  const writer = role("workhorse_dashboard_write");
  const workerRole = role("workhorse_worker");
  const password = randomUUID();
  const pools: Pool[] = [];
  let administrator: Pool;

  function personalize(sql: string): string {
    return sql
      .replace(/\bworkhorse_(owner|dashboard_read|dashboard_write|worker)\b/g, (match) =>
        role(match),
      )
      .replace(/\bON DATABASE app\b/g, `ON DATABASE "${name}"`);
  }

  function connect(user: string): Pool {
    const url = new URL(harness.databaseUrl);
    url.username = user;
    url.password = password;
    const pool = new Pool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    return pool;
  }

  beforeAll(async () => {
    await ensureTestDatabase(sourceUrl, name);
    administrator = new Pool({ connectionString: harness.databaseUrl, max: 2 });
    await administrator.query(personalize(sections.create));
    for (const user of [owner, reader, writer, workerRole]) {
      await administrator.query(`ALTER ROLE ${user} PASSWORD '${password}'`);
    }
    const ownerPool = connect(owner);
    await installSchema(ownerPool);
    await ownerPool.query(personalize(sections.read));
    await ownerPool.query(personalize(sections.write));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await administrator?.end();
    await harness.pool.end();
    await harness.teardown();
    const cluster = new Pool({ connectionString: sourceUrl, max: 1 });
    try {
      for (const user of [workerRole, writer, reader, owner]) {
        await cluster.query(`DROP ROLE IF EXISTS ${user}`);
      }
    } finally {
      await cluster.end();
    }
  }, 120_000);

  it("lets the read-only role serve every dashboard read", async () => {
    const seeded = await seed(connect(owner));
    const client = dashboardClient(connect(reader));
    const dashboard = client.dashboard;

    await expect(dashboard.taskCounts()).resolves.toMatchObject({ all: expect.any(Number) });
    await expect(dashboard.tasks({})).resolves.toBeTruthy();
    await expect(dashboard.tasksCursor({})).resolves.toBeTruthy();
    await expect(dashboard.taskFacets()).resolves.toBeTruthy();
    await expect(dashboard.activity({})).resolves.toBeTruthy();
    const events = await dashboard.events({});
    expect(events.events.length).toBeGreaterThan(0);
    await expect(dashboard.eventDetail({ id: events.events[0]!.id })).resolves.toBeTruthy();
    await expect(dashboard.cron()).resolves.toBeTruthy();
    await expect(dashboard.queues()).resolves.toBeTruthy();
    await expect(dashboard.system({})).resolves.toBeTruthy();
    await expect(dashboard.workers()).resolves.toBeTruthy();
    await expect(dashboard.settings()).resolves.toBeTruthy();
    await expect(
      dashboard.previewRetentionPolicy({ definition: { taskEventRetentionDays: 7 } }),
    ).resolves.toBeTruthy();
    await expect(dashboard.humanWaits()).resolves.toBeTruthy();
    for (const id of [seeded.failed, seeded.waiting]) {
      await expect(dashboard.taskDetail({ id })).resolves.toMatchObject({ identity: { id } });
    }
    await expect(dashboard.taskValue({ id: seeded.failed, kind: "payload" })).resolves.toBeTruthy();
    await expect(
      dashboard.checkpointValue({ id: seeded.failed, name: "fetch" }),
    ).resolves.toBeTruthy();
    await expect(dashboard.taskGroups({})).resolves.toBeTruthy();
    await expect(dashboard.taskGroupDetail({ id: seeded.group })).resolves.toBeTruthy();
  });

  it("rejects each write of the read-only role in PostgreSQL", async () => {
    const seeded = await seed(connect(owner));
    const readPool = connect(reader);
    const failures: unknown[] = [];
    const writable = dashboardClient(readPool, { writable: true, failures }).dashboard;

    // The dashboard is writable, so only PostgreSQL stops these actions.
    await expect(
      writable.setQueuePaused({ queue: seeded.queue, paused: true, audit: audit() }),
    ).rejects.toThrow("Internal server error");
    await expect(writable.cancelTask({ id: seeded.waiting, audit: audit() })).rejects.toThrow(
      "Internal server error",
    );
    await expect(writable.redriveTask({ id: seeded.failed, audit: audit() })).rejects.toThrow(
      "Internal server error",
    );
    expect(failures).toHaveLength(3);
    for (const failure of failures) expect(failure).toMatchObject({ code: "42501" });
    await expectInsufficientPrivilege(new Queue(readPool).enqueue("roles.denied", {}));
    await expectInsufficientPrivilege(
      new Admin(readPool).pauseQueue(seeded.queue, { ...audit(), requestId: randomUUID() }),
    );
    await expectInsufficientPrivilege(
      readPool.query("UPDATE workhorse.task SET payload = '{}'::jsonb"),
    );
    await expectInsufficientPrivilege(readPool.query("DELETE FROM workhorse.task_event"));
    await expectInsufficientPrivilege(
      readPool.query("SELECT workhorse.create_history_day_v1(current_date + 30)"),
    );

    const ownerPool = connect(owner);
    const paused = await ownerPool.query<{ paused: boolean }>(
      "SELECT coalesce(bool_or(paused), false) AS paused FROM workhorse.queue_control WHERE queue_name = $1",
      [seeded.queue],
    );
    expect(paused.rows[0]!.paused).toBe(false);
  });

  it("lets the writable role change queue and task state", async () => {
    const seeded = await seed(connect(owner));
    const writePool = connect(writer);
    const dashboard = dashboardClient(writePool, { writable: true }).dashboard;

    await expect(
      dashboard.setQueuePaused({ queue: seeded.queue, paused: true, audit: audit() }),
    ).resolves.toEqual({ paused: true });
    await expect(
      dashboard.setQueuePaused({ queue: seeded.queue, paused: false, audit: audit() }),
    ).resolves.toEqual({ paused: false });
    await expect(
      dashboard.redriveTask({ id: seeded.failed, audit: audit() }),
    ).resolves.toBeTruthy();
    await expect(
      dashboard.cancelTask({ id: seeded.waiting, audit: audit() }),
    ).resolves.toBeTruthy();
    await expect(
      dashboard.purgeQueue({ queue: seeded.queue, audit: audit() }),
    ).resolves.toBeTruthy();
    const writeQueue = new Queue(writePool);
    const queueName = `roles-${randomUUID()}`;
    const id = await writeQueue.enqueue("roles.enqueued", {}, { queue: queueName });
    const claimed = await writeQueue.claim(`roles-writer-${suffix}`, { queue: queueName });
    expect(claimed?.id).toBe(id);
    expect(await writeQueue.complete(claimed!, `roles-writer-${suffix}`, { done: true })).toBe(
      true,
    );
    // The installation prepares the first history days, so the gap shows on a later day.
    await expect(prepareLaterHistoryDays(writePool)).resolves.toMatchObject({
      error: { code: "42501" },
    });
  });

  it("lets the worker role process a task and run maintenance", async () => {
    const workerPool = connect(workerRole);
    const queue = new Queue(workerPool);
    const queueName = `roles-${randomUUID()}`;
    const id = await queue.enqueue("roles.work", { value: 1 }, { queue: queueName });
    const worker = new Worker(queue, {
      workerId: `roles-worker-${suffix}`,
      queues: [queueName],
    }).handle("roles.work", async (payload: { value: number }) => ({ doubled: payload.value * 2 }));
    expect(await worker.runOnce()).toBe(true);
    await expect(new Admin(workerPool).getTask(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { doubled: 2 },
    });
    await expect(queue.runMaintenance()).resolves.toEqual(expect.any(Array));
    const prepared = await prepareLaterHistoryDays(workerPool);
    expect(prepared.error).toBeNull();
    expect(prepared.rows_affected).toBeGreaterThan(0);

    // A partition that the worker creates belongs to the owner, so the grants can run again.
    const ownerPool = connect(owner);
    const owners = await ownerPool.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(relowner) AS owner
         FROM pg_class
        WHERE relnamespace = 'workhorse'::regnamespace AND relkind IN ('r', 'p', 'v', 'S')`,
    );
    expect(owners.rows).toEqual([{ owner }]);
    await ownerPool.query(personalize(sections.read));
    await ownerPool.query(personalize(sections.write));
  });

  /** One failed task with a checkpoint, one task in a human wait, and one task group. */
  async function seed(ownerPool: Pool): Promise<{
    queue: string;
    failed: string;
    waiting: string;
    group: string;
  }> {
    const queueName = `roles-${randomUUID()}`;
    const queue = new Queue(ownerPool);
    const failed = await queue.enqueue(
      "roles.fail",
      { secret: "x" },
      { queue: queueName, maxAttempts: 1 },
    );
    const waiting = await queue.enqueue("roles.wait", {}, { queue: queueName });
    const worker = new Worker(queue, { workerId: `roles-seed-${suffix}`, queues: [queueName] })
      .handle("roles.fail", async (_payload, context) => {
        await context.checkpoint("fetch", () => ({ fetched: true }));
        throw new Error("planned failure");
      })
      .handle("roles.wait", async (_payload, context) =>
        context.waitForHuman("approval", { question: "approve?" }),
      );
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([{ type: "roles.member", payload: {}, options: { queue: queueName } }]),
    );
    return { queue: queueName, failed, waiting, group: group.id };
  }
});

function dashboardClient(
  database: Pool,
  options: { writable?: boolean; failures?: unknown[] } = {},
): RouterClient<DashboardRouter> {
  const queue = new Queue(database);
  const admin = new Admin(database);
  const controllers = options.writable
    ? createDashboardOperatorControllers({
        run: async (_action, operation) => {
          try {
            return await operation({ admin, queue });
          } catch (error) {
            options.failures?.push(error);
            throw error;
          }
        },
      })
    : {};
  const host = createDashboardHost({
    database,
    path: "/",
    authorize: () => ({ actor: "roles-test" }),
    ...controllers,
  });
  return createORPCClient(
    new RPCLink({
      url: "http://dashboard.test/rpc",
      fetch: async (request) => {
        const headers = new Headers(request.headers);
        headers.set("origin", "http://dashboard.test");
        return (
          (await host.handle(new Request(request, { headers }))) ??
          new Response(null, { status: 404 })
        );
      },
    }),
  );
}

function audit() {
  return { actor: "roles-test", reason: "role test", requestId: randomUUID() };
}

/** Run history partition preparation as if the date were 30 days later. */
async function prepareLaterHistoryDays(
  pool: Pool,
): Promise<{ rows_affected: number; error: { code: string } | null }> {
  const result = await pool.query<{ rows_affected: number; error: { code: string } | null }>(
    "SELECT rows_affected, error FROM workhorse.prepare_history_partitions_v1(true, clock_timestamp() + interval '30 days')",
  );
  return result.rows[0]!;
}

async function expectInsufficientPrivilege(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: "42501" });
}

/** The SQL blocks of "Database roles", keyed by the subsection that holds each one. */
function rolesSections(): { create: string; read: string; write: string } {
  const page = readFileSync(
    new URL("../../../docs/architecture/operations.md", import.meta.url),
    "utf8",
  );
  const section = page.split(/^## Database roles$/m)[1]?.split(/^## /m)[0];
  if (section === undefined) throw new Error('operations.md has no "Database roles" section');
  const block = (heading: string): string => {
    const part = section.split(new RegExp(`^### ${heading}$`, "m"))[1]?.split(/^### /m)[0];
    const sql = part?.match(/```sql\n([\s\S]*?)```/)?.[1];
    if (sql === undefined) throw new Error(`"${heading}" in operations.md has no SQL block`);
    return sql;
  };
  return {
    create: block("Create the roles"),
    read: block("Read-only dashboard role"),
    write: block("Writable dashboard role"),
  };
}

async function probeCreateRole(url: string): Promise<boolean> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await pool.query<{ allowed: boolean }>(
      "SELECT rolsuper OR rolcreaterole AS allowed FROM pg_roles WHERE rolname = current_user",
    );
    return result.rows[0]?.allowed === true;
  } finally {
    await pool.end();
  }
}
