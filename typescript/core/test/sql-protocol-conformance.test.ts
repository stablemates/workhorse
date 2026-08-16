import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ClaimedJob, EnqueueRequest, Json, Queryable } from "../src/index.js";
import {
  loadSqlProtocolFixtures,
  assertSqlProtocolCompatible,
  verifySqlProtocolFixtures,
} from "../../../scripts/verify-sql-protocol.js";
import { Queue, Worker, WORKHORSE_SCHEMA_VERSION } from "../src/index.js";
import { createDatabaseTestHarness } from "./support/db.js";

const compatibilityDatabase = createDatabaseTestHarness(
  new URL("?compatibility", import.meta.url).href,
);
const sqlDatabase = createDatabaseTestHarness(new URL("?sql", import.meta.url).href);
const runtimeDatabase = createDatabaseTestHarness(new URL("?runtime", import.meta.url).href);
const requestDatabase = createDatabaseTestHarness(new URL("?requests", import.meta.url).href);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function expectJobStates(
  queue: Queue,
  ids: Map<string, string>,
  expected: Record<string, { state: string; attempt: number }>,
): Promise<void> {
  for (const [key, state] of Object.entries(expected)) {
    const id = ids.get(key);
    expect(id, `runtime fixture has no job named ${key}`).toBeDefined();
    await expect(queue.getJob(id!)).resolves.toMatchObject({
      state: state.state,
      currentAttempt: state.attempt,
    });
  }
}

async function exerciseQueue<TResult>(
  rows: unknown[],
  operation: (queue: Queue) => Promise<TResult>,
): Promise<{ parameters: readonly unknown[] | undefined; result: TResult }> {
  let parameters: readonly unknown[] | undefined;
  const database: Queryable = {
    async query() {
      parameters = arguments[1];
      return { rows } as never;
    },
  };
  const result = await operation(new Queue(database));
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
        "coalescing",
        "dependencies",
        "children",
        "signals",
        "human-tokens",
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
        await client.query("UPDATE workhorse.schema_version SET version = 37");
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

  it("verifies language-runtime batch formation and independent settlement", async () => {
    await runtimeDatabase.setup();
    try {
      const fixtures = await loadSqlProtocolFixtures(repository);
      const queue = new Queue(runtimeDatabase.pool);
      const coverage = new Set<string>();
      for (const fixture of fixtures.runtime) {
        fixture.covers.forEach((capability) => coverage.add(capability));
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
        await expectJobStates(queue, ids, fixture.expectedAfterFirstRun);
        await expect(worker.runOnce()).resolves.toBe(true);
        await expectJobStates(queue, ids, fixture.expectedAfterSecondRun);
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
        const queue = new Queue(transaction);
        await queue.enqueueMany([fixture.application as EnqueueRequest], transaction);
        expect(serialized).toEqual([fixture.postgres]);

        const accepted = await requestDatabase.pool.query<{
          ordinal: number;
          job_id: string;
          outcome: string;
          reason: string | null;
        }>(
          "SELECT ordinal, job_id, outcome, reason FROM workhorse.enqueue_many_v2($1::jsonb) ORDER BY ordinal",
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
