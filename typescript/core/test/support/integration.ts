import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import {
  Admin,
  type BulkRedriveOptions,
  type BulkRedrivePage,
  type DeadLetterFilter,
  type Json,
  Queue,
  type RedriveRequest,
  type RedriveResult,
  type RetentionPolicyDefinition,
  type WorkerPauseResult,
} from "../../src/index.js";
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

export function createIntegrationTestContext(fileUrl: string) {
  const database = createDatabaseTestHarness(fileUrl, { max: 10 });
  const { databaseUrl, pool } = database;
  const queueClient = new Queue(pool);
  const admin = new Admin(pool);
  // Most lifecycle tests need both application and operator calls. Keep their fixture compact while
  // ensuring every operator call exercises Admin; the public type-contract test uses Queue itself.
  type IntegrationOperatorClient = Omit<
    Admin,
    | "pauseQueue"
    | "purgeQueue"
    | "redrive"
    | "redriveMany"
    | "resumeQueue"
    | "runTaskNow"
    | "setWorkerPaused"
  > & {
    pauseQueue(queueName?: string): Promise<void>;
    purgeQueue(queueName?: string): Promise<number>;
    redrive(jobId: string, request: RedriveRequest): Promise<RedriveResult>;
    redriveMany(
      filter: DeadLetterFilter,
      request: RedriveRequest,
      options?: BulkRedriveOptions,
    ): Promise<BulkRedrivePage>;
    resumeQueue(queueName?: string): Promise<void>;
    runTaskNow(jobId: string): ReturnType<Admin["runTaskNow"]>;
    setWorkerPaused(
      workerId: string,
      paused: boolean,
      request?: { requestedBy?: string; reason?: string },
    ): Promise<WorkerPauseResult | null>;
  };
  const queue = new Proxy(queueClient, {
    get(target, property, receiver) {
      if (property in target) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      const value = Reflect.get(admin, property, admin) as unknown;
      if (typeof value !== "function") return value;
      if (property === "redrive") {
        return (
          jobId: string,
          request: { requestedBy: string; reason: string; requestId: string },
        ) => admin.redrive(jobId, { actor: request.requestedBy, ...request });
      }
      if (property === "redriveMany") {
        return (
          filter: Parameters<Admin["redriveMany"]>[0],
          request: { requestedBy: string; reason: string; requestId: string },
          options: Parameters<Admin["redriveMany"]>[2],
        ) => admin.redriveMany(filter, { actor: request.requestedBy, ...request }, options);
      }
      if (property === "setWorkerPaused") {
        return (
          workerId: string,
          paused: boolean,
          request: { requestedBy?: string; reason?: string } = {},
        ) =>
          admin.setWorkerPaused(workerId, paused, {
            actor: request.requestedBy ?? "integration-test",
            reason: request.reason ?? "integration test",
            requestId: randomUUID(),
          });
      }
      if (property === "pauseQueue" || property === "resumeQueue" || property === "purgeQueue") {
        return (queueName = "default") =>
          (value as (queueName: string, audit: Parameters<Admin["purgeQueue"]>[1]) => unknown).call(
            admin,
            queueName,
            { actor: "integration-test", reason: "integration test", requestId: randomUUID() },
          );
      }
      if (property === "runTaskNow") {
        return (jobId: string) =>
          admin.runTaskNow(jobId, {
            actor: "integration-test",
            reason: "integration test",
            requestId: randomUUID(),
          });
      }
      return value.bind(admin);
    },
  }) as Queue & IntegrationOperatorClient;

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
    createFailedJob,
    databaseUrl,
    defaultRetentionPolicy,
    deferred,
    pool,
    admin,
    queue,
    safeKeyDigest,
    safeKeyPreview,
    waitForDatabaseCondition,
  };
}
