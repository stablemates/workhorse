import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { Admin, type Json, Queue, type RetentionPolicyDefinition } from "../../src/index.js";
import { createDatabaseTestHarness } from "./db.js";

const defaultRetentionPolicy: RetentionPolicyDefinition = {
  jobIdentityRetentionDays: 14,
  terminalOutcomeRetentionDays: 14,
  jobEventRetentionDays: 14,
  attemptHistoryRetentionDays: 14,
  scheduleOccurrenceRetentionDays: 14,
  statisticsRetentionDays: 14,
  terminalJobPruneLimit: 1_000,
  historyPartitionsPerPass: 4,
  defaultPartitionRowsPerPass: 10_000,
  occurrenceRowsPerPass: 10_000,
  statisticsRowsPerPass: 10_000,
};

const safeKeyDigest = (scope: string, key: string) =>
  createHash("sha256").update(`${scope}\x1f${key}`, "utf8").digest("hex").slice(0, 12);

const safeKeyPreview = (key: string) => {
  const characters = [...key];
  if (characters.length <= 4) return "•".repeat(characters.length);
  if (characters.length <= 8) {
    return `${characters.slice(0, 2).join("")}…${characters.slice(-2).join("")}`;
  }
  return `${characters.slice(0, 8).join("")}…${characters.slice(-4).join("")}`;
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForDatabaseCondition(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for the expected database state");
}

function adminAudit(reason = "integration test") {
  return {
    actor: "integration-test",
    reason,
    requestId: randomUUID(),
  };
}

export function createIntegrationTestContext(fileUrl: string) {
  const database = createDatabaseTestHarness(fileUrl, { max: 10 });
  const { databaseUrl, pool } = database;
  const queue = new Queue(pool);
  const admin = new Admin(pool);
  async function createFailedJob({
    type,
    queueName = "default",
    payload = {},
    tags = [],
    errorName = "Error",
    deadline,
    executionTimeoutMs,
    retryPolicy,
  }: {
    type: string;
    queueName?: string;
    payload?: Json;
    tags?: string[];
    errorName?: string;
    deadline?: Date;
    executionTimeoutMs?: number;
    retryPolicy?: { type: "fixed"; delayMs: number };
  }): Promise<string> {
    const id = await queue.enqueue(type, payload, {
      queue: queueName,
      tags,
      maxAttempts: 1,
      deadline,
      executionTimeoutMs,
      retryPolicy,
    });
    const job = await queue.claim(`fixture-${type}`, { queue: queueName });
    expect(job?.id).toBe(id);
    const error = new Error(`${type} failed`);
    error.name = errorName;
    expect(await queue.fail(job!, `fixture-${type}`, error)).toBe("failed");
    return id;
  }

  beforeAll(async () => {
    await database.setup();
  });

  beforeEach(async () => {
    await database.reset();
    await pool.query(`UPDATE workhorse.job_stat_state SET
      rolled_up_through = date_bin('1 minute', clock_timestamp(), timestamp with time zone '2000-01-01'),
      last_run_at = NULL, updated_at = clock_timestamp()`);
    await pool.query("ALTER SEQUENCE workhorse.fence_token_seq RESTART WITH 1");
    await queue.syncRetentionPolicy(defaultRetentionPolicy, { force: true });
    await queue.syncMaintenancePolicy(
      {
        timezone: "UTC",
        partitionPreparationIntervalMs: 21_600_000,
        terminalCleanupIntervalMs: 300_000,
        historyRetentionLocalTime: "03:00",
        statisticsRollupIntervalMs: 60_000,
        statisticsGroupLimit: 200,
        statisticsRecomputeBuckets: 2,
      },
      { force: true },
    );
    await pool.query(`UPDATE workhorse.maintenance_state SET
      last_started_at = NULL,
      last_completed_at = NULL,
      last_completed_local_date = NULL,
      history_retained_before = CASE WHEN task_name = 'history_retention'
        THEN date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          - interval '14 days'
        ELSE NULL END,
      updated_at = clock_timestamp()`);
  });

  afterAll(async () => {
    await database.teardown();
  });

  return {
    admin,
    adminAudit,
    createFailedJob,
    databaseUrl,
    defaultRetentionPolicy,
    deferred,
    pool,
    queue,
    safeKeyDigest,
    safeKeyPreview,
    waitForDatabaseCondition,
  };
}
