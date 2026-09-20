import { randomUUID } from "node:crypto";
import { Admin, Queue } from "@stablemates/workhorse";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";
import { DEMO_QUEUE, DEMO_SCHEDULE_NAMESPACE } from "../src/constants.js";
import {
  DEMO_OPERATOR_RECONCILE_INTERVAL_MS,
  reconcileDemoOperatorDefaults,
  reconciliationRestoredAnything,
} from "../src/operator-reconciler.js";

const database = createDatabaseTestHarness(import.meta.url);
const audit = { actor: "visitor", reason: "demonstrating an operator control", requestId: "req-1" };

const WORKER_ID = "demo-reconciler-worker";
const SCHEDULE_NAME = "demo-reconciler-schedule";

let admin: Admin;
let queue: Queue;

beforeAll(async () => {
  await database.setup();
  admin = new Admin(database.pool, DEMO_QUEUE);
  queue = new Queue(database.pool, DEMO_QUEUE);
});

afterAll(async () => {
  await database.teardown();
});

beforeEach(async () => {
  await database.reset();
  await queue.registerWorker({
    workerId: WORKER_ID,
    instanceId: randomUUID(),
    hostname: "demo-host",
    pid: 1234,
    queue: DEMO_QUEUE,
    concurrency: 1,
    activeSlots: 0,
    draining: false,
  });
  await queue.syncSchedules(DEMO_SCHEDULE_NAMESPACE, [
    {
      name: SCHEDULE_NAME,
      schedule: "* * * * *",
      task: { type: "demo-reconciler-task", queue: DEMO_QUEUE, payload: { source: "test" } },
    },
  ]);
});

async function workerIsPaused(): Promise<boolean> {
  const entry = (await admin.listWorkers()).find((worker) => worker.workerId === WORKER_ID);
  return entry?.paused ?? false;
}

async function queueIsPaused(): Promise<boolean> {
  const result = await database.pool.query<{ paused: boolean }>(
    "SELECT paused FROM workhorse.queue_control WHERE queue_name = $1",
    [DEMO_QUEUE],
  );
  return result.rows[0]?.paused ?? false;
}

async function scheduleIsPaused(): Promise<boolean> {
  const result = await database.pool.query<{ paused: boolean }>(
    `SELECT paused FROM workhorse.schedule_definition
      WHERE namespace = $1 AND schedule_name = $2`,
    [DEMO_SCHEDULE_NAMESPACE, SCHEDULE_NAME],
  );
  return result.rows[0]?.paused ?? false;
}

describe("demo operator reconciliation", () => {
  it("restores the default within a bounded interval", () => {
    // The interval is the promise DEPLOYMENT.md makes to a visitor who pauses something, so it
    // stays short enough to be a demo and long enough to observe what the control did.
    expect(DEMO_OPERATOR_RECONCILE_INTERVAL_MS).toBe(15 * 60_000);
  });

  it("resumes a worker a visitor paused", async () => {
    await admin.setWorkerPaused(WORKER_ID, true, audit);
    expect(await workerIsPaused()).toBe(true);

    const reconciliation = await reconcileDemoOperatorDefaults(database.pool);

    expect(reconciliation.resumedWorkers).toEqual([WORKER_ID]);
    expect(await workerIsPaused()).toBe(false);
  });

  it("resumes a queue a visitor paused", async () => {
    await admin.pauseQueue(DEMO_QUEUE, audit);
    expect(await queueIsPaused()).toBe(true);

    const reconciliation = await reconcileDemoOperatorDefaults(database.pool);

    expect(reconciliation.resumedQueues).toContain(DEMO_QUEUE);
    expect(await queueIsPaused()).toBe(false);
  });

  it("resumes a schedule a visitor paused", async () => {
    await database.pool.query(
      "SELECT workhorse.set_schedule_paused_v1($1::text, $2::text, true, $3::text, $4::text)",
      [DEMO_SCHEDULE_NAMESPACE, SCHEDULE_NAME, audit.actor, audit.reason],
    );
    expect(await scheduleIsPaused()).toBe(true);

    const reconciliation = await reconcileDemoOperatorDefaults(database.pool);

    expect(reconciliation.resumedSchedules).toEqual([
      `${DEMO_SCHEDULE_NAMESPACE}/${SCHEDULE_NAME}`,
    ]);
    expect(await scheduleIsPaused()).toBe(false);
  });

  it("reverts an overridden retention window to the application's value", async () => {
    const before = await queue.getRetentionPolicy();
    // Shorten rather than lengthen: the schema bounds each history window by task identity, so a
    // longer one would fail the policy's own check rather than exercise the revert.
    await queue.overrideRetentionPolicy({ taskEventRetentionDays: 1 });
    const overridden = await queue.getRetentionPolicy();
    expect(overridden.provenance.taskEventRetentionDays.source).toBe("operator");

    const reconciliation = await reconcileDemoOperatorDefaults(database.pool);

    expect(reconciliation.revertedRetentionSettings).toContain("taskEventRetentionDays");
    const after = await queue.getRetentionPolicy();
    expect(after.provenance.taskEventRetentionDays.source).toBe("application");
    expect(after.taskEventRetentionDays).toBe(before.taskEventRetentionDays);
  });

  it("reverts an overridden maintenance setting to the application's value", async () => {
    const before = await queue.getMaintenancePolicy();
    await queue.overrideMaintenancePolicy({ timezone: "Pacific/Chatham" });
    expect((await queue.getMaintenancePolicy()).provenance.timezone.source).toBe("operator");

    const reconciliation = await reconcileDemoOperatorDefaults(database.pool);

    expect(reconciliation.revertedMaintenanceSettings).toContain("timezone");
    const after = await queue.getMaintenancePolicy();
    expect(after.provenance.timezone.source).toBe("application");
    expect(after.timezone).toBe(before.timezone);
  });

  it("restores every drifted default in one pass", async () => {
    await admin.setWorkerPaused(WORKER_ID, true, audit);
    await admin.pauseQueue(DEMO_QUEUE, audit);
    await queue.overrideRetentionPolicy({ statisticsRetentionDays: 400 });

    const reconciliation = await reconcileDemoOperatorDefaults(database.pool);

    expect(reconciliationRestoredAnything(reconciliation)).toBe(true);
    expect(await workerIsPaused()).toBe(false);
    expect(await queueIsPaused()).toBe(false);
    expect((await queue.getRetentionPolicy()).provenance.statisticsRetentionDays.source).toBe(
      "application",
    );
  });

  it("writes nothing when no visitor changed anything", async () => {
    const reconciliation = await reconcileDemoOperatorDefaults(database.pool);

    expect(reconciliation).toEqual({
      resumedWorkers: [],
      resumedQueues: [],
      resumedSchedules: [],
      revertedRetentionSettings: [],
      revertedMaintenanceSettings: [],
    });
    expect(reconciliationRestoredAnything(reconciliation)).toBe(false);
  });

  it("is idempotent, so a second pass finds nothing left to restore", async () => {
    await admin.setWorkerPaused(WORKER_ID, true, audit);

    await reconcileDemoOperatorDefaults(database.pool);
    const second = await reconcileDemoOperatorDefaults(database.pool);

    expect(reconciliationRestoredAnything(second)).toBe(false);
  });
});
