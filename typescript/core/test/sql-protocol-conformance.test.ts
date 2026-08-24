import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  ClaimedJob,
  EnqueueRequest,
  JobAttemptOutcome,
  Json,
  Queryable,
} from "../src/index.js";
import {
  assertFixtureValue,
  loadSqlProtocolFixtures,
  assertSqlProtocolCompatible,
  verifySqlProtocolFixtures,
} from "../../../scripts/verify-sql-protocol.js";
import type {
  BatchRuntimeFixture,
  CooperativeCancellationRuntimeFixture,
  ExpirationRuntimeFixture,
  GracefulDrainRuntimeFixture,
  HeartbeatCadenceRuntimeFixture,
  JsonValue,
  LeaseLossRuntimeFixture,
  RuntimeWriteOperation,
  SuspensionReplayRuntimeFixture,
} from "../../../scripts/verify-sql-protocol.js";
import { Admin, Queue, Worker, WORKHORSE_SCHEMA_VERSION } from "../src/index.js";
import { createDatabaseTestHarness } from "./support/db.js";

const compatibilityDatabase = createDatabaseTestHarness(
  new URL("?compatibility", import.meta.url).href,
);
const sqlDatabase = createDatabaseTestHarness(new URL("?sql", import.meta.url).href);
const runtimeDatabase = createDatabaseTestHarness(new URL("?runtime", import.meta.url).href);
const requestDatabase = createDatabaseTestHarness(new URL("?requests", import.meta.url).href);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type RuntimeQueue = Queue & Pick<Admin, keyof Admin>;

function runtimeQueue(database: Queryable): RuntimeQueue {
  const queue = Reflect.construct(Queue, [database]) as Queue;
  const admin = new Admin(database);
  return new Proxy(queue, {
    get(target, property, receiver) {
      if (property in target) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      const value = Reflect.get(admin, property, admin) as unknown;
      return typeof value === "function" ? value.bind(admin) : value;
    },
  }) as RuntimeQueue;
}

async function expectJobStates(
  admin: Admin,
  ids: Map<string, string>,
  expected: Record<string, { state: string; attempt: number }>,
): Promise<void> {
  for (const [key, state] of Object.entries(expected)) {
    const id = ids.get(key);
    expect(id, `runtime fixture has no job named ${key}`).toBeDefined();
    await expect(admin.getJob(id!)).resolves.toMatchObject({
      state: state.state,
      currentAttempt: state.attempt,
    });
  }
}

async function expectAttemptCount(
  database: Queryable,
  jobId: string,
  expected: number,
): Promise<void> {
  const attempts = await database.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE job_id = $1",
    [jobId],
  );
  expect(attempts.rows).toEqual([{ count: expected }]);
}

async function expectAttemptOutcome(
  database: Queryable,
  jobId: string,
  expected: JobAttemptOutcome | JobAttemptOutcome[],
): Promise<void> {
  const attempts = await database.query<{ outcome: JobAttemptOutcome }>(
    "SELECT outcome FROM workhorse.attempt_history WHERE job_id = $1 ORDER BY attempt",
    [jobId],
  );
  const outcomes = Array.isArray(expected) ? expected : [expected];
  expect(attempts.rows).toEqual(outcomes.map((outcome) => ({ outcome })));
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(5);
  }
}

function waitForAbort(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    const onAbort = () => resolve(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function executeBatchRuntimeFixture(
  queue: Queue,
  admin: Admin,
  fixture: BatchRuntimeFixture,
): Promise<void> {
  const queueName = `runtime-${fixture.id}`;
  const ids = new Map<string, string>();
  for (const job of fixture.jobs) {
    ids.set(
      job.key,
      await queue.enqueue(
        fixture.jobType,
        { key: job.key, outcome: job.outcome },
        {
          queue: queueName,
          priority: job.priority,
          maxAttempts: job.maxAttempts,
        },
      ),
    );
  }
  const seen: string[] = [];
  const worker = new Worker(queue, {
    workerId: `runtime-${fixture.id}`,
    queue: queueName,
    concurrency: fixture.concurrency,
    retryDelayMs: 0,
  }).handleBatch<{ key: string; outcome: string }, { attempt: number }>(
    fixture.jobType,
    { maxSize: fixture.batchMaxSize, lingerMs: 100 },
    (items) => {
      seen.push(...items.map((item) => item.payload.key));
      return items.map(({ payload, context }) =>
        payload.outcome === "succeed" || context.job.attempt > 1
          ? { status: "succeeded" as const, result: { attempt: context.job.attempt } }
          : {
              status: "failed" as const,
              error: new Error(`${payload.outcome} on attempt ${context.job.attempt}`),
            },
      );
    },
  );

  await expect(worker.runOnce()).resolves.toBe(true);
  expect(seen).toEqual(fixture.expectedHandlerOrder);
  await expectJobStates(admin, ids, fixture.expectedAfterFirstRun);
  await expect(worker.runOnce()).resolves.toBe(true);
  await expectJobStates(admin, ids, fixture.expectedAfterSecondRun);
}

async function executeSuspensionReplayRuntimeFixture(
  queue: Queue,
  admin: Admin,
  database: Queryable,
  fixture: SuspensionReplayRuntimeFixture,
): Promise<void> {
  const queueName = `runtime-${fixture.id}`;
  const ids = new Map<string, string>();
  ids.set("suspension", await queue.enqueue(fixture.jobType, {}, { queue: queueName }));
  ids.set("following", await queue.enqueue(fixture.followingJobType, {}, { queue: queueName }));
  let handlerRuns = 0;
  let checkpointOperations = 0;
  const seen: string[] = [];
  const worker = new Worker(queue, {
    workerId: `runtime-${fixture.id}`,
    queue: queueName,
    maintenanceIntervalMs: 100,
  })
    .handle(fixture.jobType, async (_payload, context) => {
      handlerRuns += 1;
      seen.push(`suspension:${context.job.attempt}`);
      const prepared = await context.checkpoint(fixture.checkpointName, () => {
        checkpointOperations += 1;
        return { operation: checkpointOperations };
      });
      await context.sleep(fixture.waitName, fixture.waitMs);
      return { prepared, handlerRuns };
    })
    .handle(fixture.followingJobType, (_payload, context) => {
      seen.push(`following:${context.job.attempt}`);
      return { handled: true };
    });

  await expect(worker.runOnce()).resolves.toBe(true);
  await expectJobStates(admin, ids, fixture.expectedAfterSuspension);
  await expectAttemptCount(
    database,
    ids.get("suspension")!,
    fixture.expectedAttemptsAfterSuspension,
  );

  await expect(worker.runOnce()).resolves.toBe(true);
  await expectJobStates(admin, ids, fixture.expectedAfterSlotRelease);

  await sleep(Math.max(110, fixture.waitMs + 80));
  await expect(worker.runOnce()).resolves.toBe(true);
  await expectJobStates(admin, ids, fixture.expectedAfterReplay);
  await expectAttemptCount(database, ids.get("suspension")!, fixture.expectedAttemptsAfterReplay);
  expect(seen).toEqual(fixture.expectedHandlerOrder);
  expect(handlerRuns).toBe(fixture.expectedHandlerRuns);
  expect(checkpointOperations).toBe(fixture.expectedCheckpointOperations);
}

async function executeCooperativeCancellationRuntimeFixture(
  queue: Queue,
  admin: Admin,
  database: Queryable,
  fixture: CooperativeCancellationRuntimeFixture,
): Promise<void> {
  const queueName = `runtime-${fixture.id}`;
  const id = await queue.enqueue(fixture.jobType, {}, { queue: queueName });
  const started = deferred();
  let abortReason: unknown;
  const worker = new Worker(queue, {
    workerId: `runtime-${fixture.id}`,
    queue: queueName,
    leaseMs: fixture.leaseMs,
    heartbeatMs: fixture.heartbeatMs,
  }).handle(fixture.jobType, async (_payload, context) => {
    started.resolve();
    abortReason = await waitForAbort(context.signal);
    throw abortReason;
  });

  const execution = worker.runOnce();
  await started.promise;
  await expect(queue.cancel(id, { reason: fixture.cancelReason })).resolves.toMatchObject({
    status: "cancel_requested",
  });
  await expect(execution).resolves.toBe(true);
  expect(abortReason).toMatchObject({ name: fixture.expectedAbortReason });
  await expect(admin.getJob(id)).resolves.toMatchObject({
    state: fixture.expectedState.state,
    currentAttempt: fixture.expectedState.attempt,
  });
  await expectAttemptOutcome(database, id, fixture.expectedAttemptOutcome);
}

async function executeExpirationRuntimeFixture(
  queue: Queue,
  admin: Admin,
  database: Queryable,
  fixture: ExpirationRuntimeFixture,
): Promise<void> {
  const queueName = `runtime-${fixture.id}`;
  const earlyTimerQueue = new Proxy(queue, {
    get(target, property, receiver) {
      if (property !== "claim") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<Queue["claim"]>) => {
        const claimed = await target.claim(...args);
        if (claimed && fixture.mode === "deadline" && claimed.deadlineAt) {
          claimed.deadlineAt = new Date(claimed.deadlineAt.getTime() - fixture.localClockLeadMs);
        }
        if (claimed && fixture.mode === "execution-timeout" && claimed.attemptTimeoutAt) {
          claimed.attemptTimeoutAt = new Date(
            claimed.attemptTimeoutAt.getTime() - fixture.localClockLeadMs,
          );
        }
        return claimed;
      };
    },
  });
  const expiration = new Date(Date.now() + fixture.durationMs);
  const id = await queue.enqueue(
    fixture.jobType,
    {},
    fixture.mode === "deadline"
      ? { queue: queueName, deadline: expiration, maxAttempts: fixture.maxAttempts }
      : {
          queue: queueName,
          executionTimeoutMs: fixture.durationMs,
          maxAttempts: fixture.maxAttempts,
        },
  );
  const abortReasons: unknown[] = [];
  const worker = new Worker(earlyTimerQueue, {
    workerId: `runtime-${fixture.id}`,
    queue: queueName,
    leaseMs: fixture.leaseMs,
    heartbeatMs: fixture.heartbeatMs,
  }).handle(fixture.jobType, async (_payload, context) => {
    const reason = await waitForAbort(context.signal);
    abortReasons.push(reason);
    throw reason;
  });

  for (const expected of fixture.expectedAfterRuns) {
    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(admin.getJob(id)).resolves.toMatchObject({
      state: expected.state,
      currentAttempt: expected.attempt,
      ...(expected.errorName === undefined ? {} : { error: { name: expected.errorName } }),
    });
  }
  expect(abortReasons).toEqual(
    fixture.expectedAbortReasons.map((name) => expect.objectContaining({ name })),
  );
  await expectAttemptOutcome(database, id, fixture.expectedAttemptOutcomes);
}

async function executeLeaseLossRuntimeFixture(
  queue: Queue,
  admin: Admin,
  database: Queryable,
  fixture: LeaseLossRuntimeFixture,
): Promise<void> {
  const queueName = `runtime-${fixture.id}`;
  const id = await queue.enqueue(
    fixture.jobType,
    {},
    {
      queue: queueName,
      maxAttempts: fixture.maxAttempts,
    },
  );
  const started = deferred();
  let abortMessage: string | undefined;
  const rejectedWrites = new Map<string, string>();
  const worker = new Worker(queue, {
    workerId: `runtime-${fixture.id}`,
    queue: queueName,
    leaseMs: fixture.leaseMs,
    heartbeatMs: fixture.heartbeatMs,
  }).handle(fixture.jobType, async (_payload, context) => {
    started.resolve();
    const reason = await waitForAbort(context.signal);
    abortMessage = reason instanceof Error ? reason.message : String(reason);
    const writes: Array<[RuntimeWriteOperation, () => Promise<unknown>]> = [
      ["setProgress", () => context.setProgress({ tooLate: true })],
      ["checkpoint", () => context.checkpoint("too-late", () => ({ tooLate: true }))],
      ["sleep", () => context.sleep("too-late", 1)],
      ["sleepUntil", () => context.sleepUntil("too-late-until", new Date())],
      ["waitForSignal", () => context.waitForSignal("too-late")],
      ["waitForHuman", () => context.waitForHuman("too-late", { prompt: "too late" })],
      ["runChild", () => context.runChild("too-late", "protocol.child", {})],
      [
        "runChildren",
        () => context.runChildren([{ name: "too-late", type: "protocol.child", payload: {} }]),
      ],
    ];
    for (const [name, write] of writes) {
      try {
        await write();
      } catch (error) {
        rejectedWrites.set(name, error instanceof Error ? error.message : String(error));
      }
    }
    return { tooLate: true };
  });

  const execution = worker.runOnce();
  await started.promise;
  await database.query(
    "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE job_id = $1",
    [id],
  );
  await expect(queue.recoverExpired(100, 0)).resolves.toBe(1);
  await expect(execution).resolves.toBe(true);
  expect(abortMessage).toBe(fixture.expectedAbortMessage);
  expect([...rejectedWrites.keys()]).toEqual(fixture.expectedRejectedWrites);
  expect(fixture.expectedRejectedWrites).toEqual(
    expect.arrayContaining(fixture.portableRejectedWrites),
  );
  expect(new Set(rejectedWrites.values())).toEqual(new Set([fixture.expectedRejectedWriteError]));
  await expect(admin.getJob(id)).resolves.toMatchObject({
    state: fixture.expectedState.state,
    currentAttempt: fixture.expectedState.attempt,
    result: null,
  });
  await expectAttemptOutcome(database, id, fixture.expectedAttemptOutcome);
}

async function executeHeartbeatCadenceRuntimeFixture(
  queue: RuntimeQueue,
  fixture: HeartbeatCadenceRuntimeFixture,
): Promise<void> {
  const queueName = `runtime-${fixture.id}`;
  await queue.enqueue(fixture.jobType, {}, { queue: queueName });
  const handlerStarted = deferred();
  const releaseHandler = deferred();
  const firstHeartbeatStarted = deferred();
  const releaseFirstHeartbeat = deferred();
  let heartbeatCalls = 0;
  let activeHeartbeats = 0;
  let maximumOverlap = 0;
  const delayedHeartbeatQueue = new Proxy(queue, {
    get(target, property, receiver) {
      if (property !== "heartbeatMany") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<Queue["heartbeatMany"]>) => {
        heartbeatCalls += 1;
        activeHeartbeats += 1;
        maximumOverlap = Math.max(maximumOverlap, activeHeartbeats);
        try {
          if (heartbeatCalls === 1) {
            firstHeartbeatStarted.resolve();
            await releaseFirstHeartbeat.promise;
          }
          return await target.heartbeatMany(...args);
        } finally {
          activeHeartbeats -= 1;
        }
      };
    },
  });
  const worker = new Worker(delayedHeartbeatQueue, {
    workerId: `runtime-${fixture.id}`,
    queue: queueName,
    leaseMs: fixture.leaseMs,
    heartbeatMs: fixture.heartbeatMs,
  }).handle(fixture.jobType, async () => {
    handlerStarted.resolve();
    await releaseHandler.promise;
    return null;
  });

  const execution = worker.runOnce();
  try {
    await handlerStarted.promise;
    await firstHeartbeatStarted.promise;
    await sleep(fixture.heartbeatMs * 3);
    expect(heartbeatCalls).toBe(fixture.expectedCallsWhileBlocked);
    releaseFirstHeartbeat.resolve();
    await waitForCondition(
      () => heartbeatCalls >= fixture.expectedMinimumCallsBeforeSettlement,
      `${fixture.id} did not schedule the next heartbeat after the first settled`,
    );
    expect(maximumOverlap).toBe(fixture.expectedMaximumOverlap);
    releaseHandler.resolve();
    await expect(execution).resolves.toBe(true);
    const callsAtSettlement = heartbeatCalls;
    await sleep(fixture.heartbeatMs * 3);
    expect(heartbeatCalls).toBe(callsAtSettlement);
  } finally {
    releaseFirstHeartbeat.resolve();
    releaseHandler.resolve();
    await execution.catch(() => undefined);
  }
}

async function executeGracefulDrainRuntimeFixture(
  queue: Queue,
  admin: Admin,
  fixture: GracefulDrainRuntimeFixture,
): Promise<void> {
  const queueName = `runtime-${fixture.id}`;
  const ids = await Promise.all(
    Array.from({ length: fixture.jobCount }, (_, sequence) =>
      queue.enqueue(fixture.jobType, { sequence }, { queue: queueName }),
    ),
  );
  const releaseHandlers = deferred();
  const worker = new Worker(queue, {
    workerId: `runtime-${fixture.id}`,
    queue: queueName,
    concurrency: fixture.concurrency,
    pollMs: 0,
    registryIntervalMs: 0,
  }).handle(fixture.jobType, async () => {
    await releaseHandlers.promise;
    return null;
  });

  const running = worker.run();
  try {
    await waitForCondition(
      () => worker.runtimeState().activeSlots === fixture.expectedActiveAtStop,
      `${fixture.id} did not fill its active slots`,
    );
    worker.stop();
    expect(worker.runtimeState()).toMatchObject({
      activeSlots: fixture.expectedActiveAtStop,
      draining: true,
    });
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await sleep(fixture.settleCheckMs);
    expect(settled).toBe(false);
    releaseHandlers.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(worker.runtimeState()).toMatchObject({ activeSlots: 0, draining: false });
    const states = await Promise.all(ids.map(async (id) => (await admin.getJob(id))?.state));
    expect(states.filter((state) => state === "succeeded")).toHaveLength(fixture.expectedSucceeded);
    expect(states.filter((state) => state === "ready")).toHaveLength(fixture.expectedReady);
  } finally {
    worker.stop();
    releaseHandlers.resolve();
    await running.catch(() => undefined);
  }
}

async function exerciseQueue<TResult>(
  rows: unknown[],
  operation: (queue: RuntimeQueue) => Promise<TResult>,
): Promise<{ parameters: readonly unknown[] | undefined; result: TResult }> {
  let parameters: readonly unknown[] | undefined;
  const database: Queryable = {
    async query() {
      parameters = arguments[1];
      return { rows } as never;
    },
  };
  const result = await operation(runtimeQueue(database));
  return { parameters, result };
}

const adapterJob: ClaimedJob<Json> = {
  id: "00000000-0000-4000-8000-000000000001",
  queue: "protocol-adapter",
  type: "protocol.adapter",
  priority: 70,
  payload: { value: 1 },
  contractVersion: null,
  resultMaxBytes: 1_048_576,
  redactErrorDetails: false,
  traceContext: null,
  attempt: 1,
  maxAttempts: 2,
  retryPolicy: { type: "fixed", delayMs: 0 },
  deadlineAt: null,
  executionTimeoutMs: null,
  attemptTimeoutAt: null,
  fenceToken: 17n,
  leaseExpiresAt: new Date("2030-01-01T00:00:30.000Z"),
};

describe("SQL protocol conformance fixtures", () => {
  it("declare the stable protocol, compatibility range, and complete lifecycle coverage", async () => {
    const fixtures = await loadSqlProtocolFixtures(repository);

    expect(fixtures.manifest).toMatchObject({
      formatVersion: 1,
      protocolVersion: 1,
      schema: {
        installedVersion: WORKHORSE_SCHEMA_VERSION,
        minimumVersion: WORKHORSE_SCHEMA_VERSION,
        maximumVersion: WORKHORSE_SCHEMA_VERSION,
      },
      supportedClientProtocol: { minimumVersion: 1, maximumVersion: 1 },
      views: [
        expect.objectContaining({ name: "dashboard_signal_wait_v1" }),
        expect.objectContaining({ name: "dashboard_human_wait_v1" }),
      ],
    });
    expect(new Set(fixtures.manifest.coverage)).toEqual(
      new Set([
        "enqueue",
        "claim",
        "heartbeat",
        "completion",
        "failure",
        "cancellation",
        "retry",
        "checkpoint",
        "timer-wait",
        "batch-handling",
        "durable-wait-suspension",
        "worker-slot-release",
        "single-attempt-replay",
        "checkpoint-replay",
        "cooperative-cancellation-delivery",
        "deadline-settlement",
        "execution-timeout-settlement",
        "database-authoritative-expiration",
        "lease-loss-fencing",
        "non-overlapping-heartbeats",
        "graceful-drain",
        "coalescing",
        "dependencies",
        "children",
        "signals",
        "human-tokens",
        "retention-maintenance",
      ]),
    );
    expect(fixtures.compatibility).toContainEqual(
      expect.objectContaining({ id: "current", compatible: true }),
    );
    expect(fixtures.compatibility.filter((fixture) => !fixture.compatible)).toHaveLength(5);
  });

  it("refuses incompatible schemas and client protocols before mutation", async () => {
    await compatibilityDatabase.setup();
    const fixtures = await loadSqlProtocolFixtures(repository);
    try {
      await expect(
        assertSqlProtocolCompatible(compatibilityDatabase.pool, fixtures.manifest, 2),
      ).rejects.toMatchObject({
        name: "SqlProtocolCompatibilityError",
        code: "client-protocol-too-new",
      });
      const client = await compatibilityDatabase.pool.connect();
      try {
        await client.query("BEGIN");
        // Below the supported minimum, which is 1 now that the baseline was reset.
        await client.query("UPDATE workhorse.schema_version SET version = 0");
        await expect(
          assertSqlProtocolCompatible(client, fixtures.manifest, 1),
        ).rejects.toMatchObject({
          name: "SqlProtocolCompatibilityError",
          code: "schema-too-old",
        });
        const jobs = await client.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM workhorse.job",
        );
        expect(jobs.rows).toEqual([{ count: 0 }]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    } finally {
      await compatibilityDatabase.teardown();
    }
  });

  it("verifies canonical requests, results, transitions, and structured errors through PostgreSQL", async () => {
    await sqlDatabase.setup();
    try {
      const report = await verifySqlProtocolFixtures(sqlDatabase.pool, repository);
      expect(report.coverage).toEqual(
        new Set(
          report.manifest.coverage.filter(
            (capability) => !report.manifest.runtimeCoverage.includes(capability),
          ),
        ),
      );
      expect(report.scenarios).toBeGreaterThan(0);
      expect(report.steps).toBeGreaterThan(report.scenarios);
    } finally {
      await sqlDatabase.teardown();
    }
  });

  it("verifies language-runtime behavior through the shared fixtures", async () => {
    await runtimeDatabase.setup();
    try {
      const fixtures = await loadSqlProtocolFixtures(repository);
      const queue = runtimeQueue(runtimeDatabase.pool);
      const admin = new Admin(runtimeDatabase.pool);
      const coverage = new Set<string>();
      for (const fixture of fixtures.runtime) {
        fixture.covers.forEach((capability) => coverage.add(capability));
        switch (fixture.kind) {
          case "batch":
            await executeBatchRuntimeFixture(queue, admin, fixture);
            break;
          case "suspension-replay":
            await executeSuspensionReplayRuntimeFixture(
              queue,
              admin,
              runtimeDatabase.pool,
              fixture,
            );
            break;
          case "cooperative-cancellation":
            await executeCooperativeCancellationRuntimeFixture(
              queue,
              admin,
              runtimeDatabase.pool,
              fixture,
            );
            break;
          case "expiration":
            await executeExpirationRuntimeFixture(queue, admin, runtimeDatabase.pool, fixture);
            break;
          case "lease-loss":
            await executeLeaseLossRuntimeFixture(queue, admin, runtimeDatabase.pool, fixture);
            break;
          case "heartbeat-cadence":
            await executeHeartbeatCadenceRuntimeFixture(queue, fixture);
            break;
          case "graceful-drain":
            await executeGracefulDrainRuntimeFixture(queue, admin, fixture);
        }
      }
      expect(coverage).toEqual(new Set(fixtures.manifest.runtimeCoverage));
    } finally {
      await runtimeDatabase.teardown();
    }
  });

  it("keeps the manifest, scenarios, and TypeScript SQL contract in sync", async () => {
    const fixtures = await loadSqlProtocolFixtures(repository);
    const queueSources = await Promise.all(
      fixtures.manifest.typescriptContractSources.map((source) =>
        readFile(path.join(repository, source), "utf8"),
      ),
    );
    const contract = queueSources.join("\n");
    const normalizedContract = contract.replace(/\s+/g, " ");
    const scenarioContract = fixtures.scenarios
      .flatMap(({ steps }) => steps.map(({ sql }) => sql))
      .join("\n");
    const intentionallyUnpinnedSqlFunctions = new Set<string>();
    const pinnedFunctions = new Set(fixtures.manifest.functions.map(({ name }) => name));
    const pinnedViews = new Set(fixtures.manifest.views.map(({ name }) => name));
    const contractFunctions = new Set(
      [...contract.matchAll(/workhorse\.([a-z0-9_]+_v\d+)\s*\(/g)].map((match) => match[1]!),
    );
    const contractViews = new Set(
      [...contract.matchAll(/FROM workhorse\.(dashboard_[a-z0-9_]+_v\d+)/g)].map(
        (match) => match[1]!,
      ),
    );

    expect(
      [...contractFunctions].filter(
        (functionName) =>
          !pinnedFunctions.has(functionName) &&
          !intentionallyUnpinnedSqlFunctions.has(functionName),
      ),
      "TypeScript SQL contract functions are absent from the language-neutral manifest",
    ).toEqual([]);

    expect(
      [...contractViews].filter((viewName) => !pinnedViews.has(viewName)),
      "TypeScript SQL contract views are absent from the language-neutral manifest",
    ).toEqual([]);

    for (const { name: functionName, arity, contract: callContract } of fixtures.manifest
      .functions) {
      expect(
        scenarioContract,
        `${functionName} has no language-neutral conformance scenario`,
      ).toContain(`workhorse.${functionName}(`);
      expect(contract, `${functionName} is absent from the TypeScript SQL contract`).toContain(
        `workhorse.${functionName}`,
      );
      const call = contract.match(new RegExp(`workhorse\\.${functionName}\\(([^)]*)\\)`, "m"))?.[1];
      expect(call, `${functionName} has no inspectable TypeScript call`).toBeDefined();
      const placeholders = [...(call ?? "").matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      expect(Math.max(...placeholders), `${functionName} parameter arity drifted`).toBe(arity);
      expect(
        normalizedContract,
        `${functionName} TypeScript projection or casts drifted`,
      ).toContain(callContract);
    }

    for (const { name: viewName, contract: readContract } of fixtures.manifest.views) {
      expect(
        scenarioContract,
        `${viewName} has no language-neutral conformance scenario`,
      ).toContain(`FROM workhorse.${viewName}`);
      expect(contract, `${viewName} is absent from the TypeScript SQL contract`).toContain(
        `FROM workhorse.${viewName}`,
      );
      expect(normalizedContract, `${viewName} TypeScript projection drifted`).toContain(
        readContract,
      );
    }
  });

  it("pins TypeScript request serialization to the language-neutral contract", async () => {
    const fixtures = await loadSqlProtocolFixtures(repository);
    await requestDatabase.setup();
    try {
      for (const fixture of fixtures.requests) {
        let serialized: unknown;
        const transaction: Queryable = {
          async query() {
            serialized = JSON.parse(String(arguments[1]?.[0]));
            return {
              rows: [{ ordinal: 1, job_id: fixture.id, outcome: "accepted", reason: null }],
            } as never;
          },
        };
        const queue = runtimeQueue(transaction);
        await queue.enqueueMany([fixture.application as EnqueueRequest], transaction);
        assertFixtureValue(
          [fixture.postgres],
          serialized as JsonValue,
          `${fixture.id}.postgres`,
          new Map(),
        );

        const accepted = await requestDatabase.pool.query<{
          ordinal: number;
          job_id: string;
          outcome: string;
          reason: string | null;
        }>(
          "SELECT ordinal, job_id, outcome, reason FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal",
          [JSON.stringify(serialized)],
        );
        expect(accepted.rows).toEqual([
          { ordinal: 1, job_id: expect.any(String), outcome: "accepted", reason: null },
        ]);
        const stored = await requestDatabase.pool.query(
          "SELECT queue_name, job_type, payload, priority, concurrency_key, max_attempts, retry_policy, tags FROM workhorse.dashboard_job_v1 WHERE id = $1::uuid",
          [accepted.rows[0]!.job_id],
        );
        expect(stored.rows).toEqual([
          {
            queue_name: fixture.postgres.queue,
            job_type: fixture.postgres.type,
            payload: fixture.postgres.payload,
            priority: fixture.postgres.priority,
            concurrency_key: fixture.postgres.concurrencyKey,
            max_attempts: fixture.postgres.maxAttempts,
            retry_policy: fixture.postgres.retryPolicy,
            tags: fixture.postgres.tags,
          },
        ]);
      }
    } finally {
      await requestDatabase.teardown();
    }
  });

  it("binds and maps every TypeScript lifecycle adapter at the SQL boundary", async () => {
    const workerId = "protocol-worker";
    const occurredAt = "2030-01-01T00:00:00.000Z";
    const claimed = await exerciseQueue(
      [
        {
          job_id: adapterJob.id,
          job_type: adapterJob.type,
          priority: adapterJob.priority,
          payload: adapterJob.payload,
          contract_version: null,
          result_max_bytes: adapterJob.resultMaxBytes,
          redact_error_details: false,
          trace_context: null,
          attempt: 1,
          max_attempts: 2,
          retry_policy: adapterJob.retryPolicy,
          deadline_at: null,
          execution_timeout_ms: null,
          attempt_timeout_at: null,
          fence_token: "17",
          lease_expires_at: adapterJob.leaseExpiresAt,
        },
      ],
      (queue) => queue.claim(workerId, { queue: adapterJob.queue, leaseMs: 45_000 }),
    );
    expect(claimed.parameters).toEqual([adapterJob.queue, workerId, 45_000]);
    expect(claimed.result).toEqual(adapterJob);

    const heartbeat = await exerciseQueue([{ status: "accepted" }], (queue) =>
      queue.heartbeatStatus(adapterJob, workerId, 45_000),
    );
    expect(heartbeat).toEqual({
      parameters: [adapterJob.id, workerId, "17", 45_000],
      result: "accepted",
    });

    const cancellation = await exerciseQueue(
      [
        {
          status: "canceled",
          state: "canceled",
          current_attempt: 1,
          requested_at: occurredAt,
          requested_by: "operator",
          reason: "fixture",
          finished_at: occurredAt,
        },
      ],
      (queue) => queue.cancel(adapterJob.id, { requestedBy: "operator", reason: "fixture" }),
    );
    expect(cancellation.parameters).toEqual([adapterJob.id, "operator", "fixture"]);
    expect(cancellation.result).toMatchObject({
      jobId: adapterJob.id,
      currentAttempt: 1,
      requestedBy: "operator",
      finishedAt: occurredAt,
    });

    const completion = await exerciseQueue([{ accepted: true }], (queue) =>
      queue.complete(adapterJob, workerId, { done: true }),
    );
    expect(completion).toEqual({
      parameters: [adapterJob.id, workerId, "17", '{"done":true}'],
      result: true,
    });

    const failure = await exerciseQueue([{ state: "ready" }], (queue) =>
      queue.fail(adapterJob, workerId, new Error("retry me"), 0),
    );
    expect(failure.parameters?.slice(0, 3)).toEqual([adapterJob.id, workerId, "17"]);
    expect(JSON.parse(String(failure.parameters?.[3]))).toMatchObject({
      name: "Error",
      message: "retry me",
    });
    expect(failure.parameters?.[4]).toBe(0);
    expect(failure.result).toBe("ready");

    const checkpoint = await exerciseQueue(
      [
        {
          status: "saved",
          checkpoint_value: { step: 1 },
          attempt: 1,
          fence_token: "17",
          worker_id: workerId,
          created_at: occurredAt,
        },
      ],
      (queue) => queue.saveCheckpoint(adapterJob, workerId, "prepared", { step: 1 }),
    );
    expect(checkpoint.parameters).toEqual([
      adapterJob.id,
      workerId,
      "17",
      "prepared",
      '{"step":1}',
    ]);
    expect(checkpoint.result).toMatchObject({
      jobId: adapterJob.id,
      name: "prepared",
      value: { step: 1 },
      fenceToken: 17n,
    });

    const wait = await exerciseQueue(
      [
        {
          status: "scheduled",
          wait_name: "pause",
          mode: "relative",
          duration_ms: "60000",
          requested_wake_at: null,
          wake_at: occurredAt,
          attempt: 1,
          fence_token: "17",
          worker_id: workerId,
          created_at: occurredAt,
        },
      ],
      (queue) => queue.scheduleWait(adapterJob, workerId, "pause", { durationMs: 60_000 }),
    );
    expect(wait.parameters).toEqual([adapterJob.id, workerId, "17", "pause", "60000", null]);
    expect(wait.result).toMatchObject({
      status: "scheduled",
      wait: { jobId: adapterJob.id, name: "pause", durationMs: 60_000, fenceToken: 17n },
    });

    const children = await exerciseQueue(
      [
        {
          status: "created",
          children: [
            {
              childJobId: "00000000-0000-4000-8000-000000000002",
              name: "only",
              type: "protocol.child",
              createdAt: occurredAt,
              joinedAt: null,
            },
          ],
          results: null,
          result_bytes: null,
          result_limit_bytes: adapterJob.resultMaxBytes,
        },
      ],
      (queue) =>
        queue.createChildren(adapterJob, workerId, [
          {
            name: "only",
            type: "protocol.child",
            payload: { value: 2 },
            options: { runAt: new Date(occurredAt) },
          },
        ]),
    );
    expect(children.parameters?.slice(0, 3)).toEqual([adapterJob.id, workerId, "17"]);
    expect(JSON.parse(String(children.parameters?.[3]))).toEqual([
      {
        name: "only",
        request: expect.objectContaining({
          queue: "default",
          type: "protocol.child",
          payload: { value: 2 },
          runAt: occurredAt,
        }),
      },
    ]);
    expect(children.result).toMatchObject({
      status: "created",
      children: [{ parentJobId: adapterJob.id, name: "only", type: "protocol.child" }],
    });

    const signalWait = await exerciseQueue([{ status: "waiting", payload: null }], (queue) =>
      queue.waitForSignal(adapterJob, workerId, "approval"),
    );
    expect(signalWait).toEqual({
      parameters: [adapterJob.id, workerId, "17", "approval", null],
      result: { status: "waiting", payload: null },
    });
    const signalSend = await exerciseQueue(
      [
        {
          status: "delivered",
          payload: { approved: true },
          delivered_at: occurredAt,
          delivered_by: "service",
        },
      ],
      (queue) =>
        queue.sendSignal(
          adapterJob.id,
          "approval",
          { approved: true },
          {
            idempotencyKey: "signal-key",
            requestedBy: "service",
          },
        ),
    );
    expect(signalSend.parameters).toEqual([
      adapterJob.id,
      "approval",
      '{"approved":true}',
      "signal-key",
      "service",
    ]);
    expect(signalSend.result).toMatchObject({
      status: "delivered",
      payload: { approved: true },
      deliveredBy: "service",
    });

    const humanWait = await exerciseQueue([{ status: "waiting", result: null }], (queue) =>
      queue.waitForHuman(adapterJob, workerId, "review", { question: "Ship?" }),
    );
    expect(humanWait).toEqual({
      parameters: [adapterJob.id, workerId, "17", "review", '{"question":"Ship?"}', null],
      result: { status: "waiting", payload: null },
    });
    const humanComplete = await exerciseQueue(
      [
        {
          status: "completed",
          result: { approved: true },
          completed_at: occurredAt,
          completed_by: "operator",
        },
      ],
      (queue) =>
        queue.completeHumanWait(
          adapterJob.id,
          "review",
          { approved: true },
          {
            idempotencyKey: "human-key",
            requestedBy: "operator",
          },
        ),
    );
    expect(humanComplete.parameters).toEqual([
      adapterJob.id,
      "review",
      '{"approved":true}',
      "human-key",
      "operator",
    ]);
    expect(humanComplete.result).toMatchObject({
      status: "completed",
      payload: { approved: true },
      completedBy: "operator",
    });
  });
});
