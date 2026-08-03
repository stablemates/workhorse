import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installSchema, RedriveIdempotencyConflictError } from "@workhorse/core";
import { assertLocalDatabasePurpose, localDatabaseUrl } from "../../../src/local-database.js";
import { createDrizzleAdapter, DrizzleQueryError, drizzleQueryable } from "../src/index.js";

const databaseUrl = localDatabaseUrl("test");
assertLocalDatabasePurpose(databaseUrl, "test");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const db = drizzle({ client: pool });
const adapter = createDrizzleAdapter(db);

beforeAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);
  await pool.query("DROP TABLE IF EXISTS public.workhorse_drizzle_test");
  await pool.query("CREATE TABLE public.workhorse_drizzle_test (value text PRIMARY KEY)");
});

beforeEach(async () => {
  await pool.query(`TRUNCATE public.workhorse_drizzle_test, workhorse.job_event,
    workhorse.attempt_history, workhorse.schedule_occurrence, workhorse.schedule_definition,
    workhorse.job_outcome, workhorse.job_runtime, workhorse.job RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS public.workhorse_drizzle_test");
  await pool.end();
});

describe("Drizzle provider integration", () => {
  it("commits application writes and enqueue in the caller-owned transaction", async () => {
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`INSERT INTO public.workhorse_drizzle_test (value) VALUES (${"committed"})`,
      );
      await adapter.forTransaction(transaction).enqueue("transaction.commit", { committed: true });
    });

    expect((await pool.query("SELECT value FROM public.workhorse_drizzle_test")).rows).toEqual([
      { value: "committed" },
    ]);
    expect((await pool.query("SELECT job_type FROM workhorse.job")).rows).toEqual([
      { job_type: "transaction.commit" },
    ]);
  });

  it("rolls back the enqueue when the caller rolls back its Drizzle transaction", async () => {
    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(
          sql`INSERT INTO public.workhorse_drizzle_test (value) VALUES (${"rolled-back"})`,
        );
        await adapter.forTransaction(transaction).enqueue("transaction.rollback", {
          committed: false,
        });
        throw new Error("rollback requested");
      }),
    ).rejects.toThrow("rollback requested");

    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_drizzle_test"))
        .rows,
    ).toEqual([{ count: 0 }]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows).toEqual(
      [{ count: 0 }],
    );
  });

  it("uses the caller's bounded pool for concurrent operations", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, index) => adapter.queue.enqueue("pooled", { index })),
    );

    expect(new Set(ids).size).toBe(6);
    expect((await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows).toEqual(
      [{ count: 6 }],
    );
  });

  it("normalizes claimed deadline and timeout timestamps to Date values", async () => {
    const deadline = new Date(Date.now() + 60_000);
    await adapter.queue.enqueue(
      "timed",
      { source: "drizzle" },
      { deadline, executionTimeoutMs: 5_000 },
    );

    const claimed = await adapter.queue.claim("drizzle-worker");

    expect(claimed).toMatchObject({ type: "timed", executionTimeoutMs: 5_000 });
    expect(claimed?.deadlineAt).toBeInstanceOf(Date);
    expect(claimed?.attemptTimeoutAt).toBeInstanceOf(Date);
    expect(claimed?.leaseExpiresAt).toBeInstanceOf(Date);
    expect(claimed?.deadlineAt?.getTime()).toBe(deadline.getTime());
  });

  it("maps dead-letter redrive and conflicts through the Drizzle adapter", async () => {
    const sourceJobId = await adapter.queue.enqueue(
      "drizzle-redrive",
      { source: "drizzle" },
      { maxAttempts: 1, executionTimeoutMs: 5_000 },
    );
    const claimed = await adapter.queue.claim("drizzle-redrive-worker");
    expect(claimed?.id).toBe(sourceJobId);
    expect(
      await adapter.queue.fail(claimed!, "drizzle-redrive-worker", new Error("retry me")),
    ).toBe("failed");

    const deadLetters = await adapter.queue.listDeadLetters({ type: "drizzle-redrive" });
    expect(deadLetters.items).toMatchObject([
      {
        jobId: sourceJobId,
        executionTimeoutMs: 5_000,
        finishedAt: expect.any(Date),
        redriveCount: 0,
      },
    ]);

    const request = {
      requestedBy: "drizzle-operator",
      reason: "provider integration",
      requestId: "drizzle-redrive-request",
    };
    const created = await adapter.queue.redrive(sourceJobId, request);
    expect(created).toMatchObject({
      status: "redriven",
      sourceJobId,
      targetJobId: expect.any(String),
      requestedAt: expect.any(Date),
    });
    await expect(adapter.queue.redrive(sourceJobId, request)).resolves.toMatchObject({
      status: "replayed",
      targetJobId: created.targetJobId,
      requestedAt: created.requestedAt,
    });
    await expect(
      adapter.queue.redrive(sourceJobId, { ...request, reason: "different request" }),
    ).rejects.toBeInstanceOf(RedriveIdempotencyConflictError);
    expect(await adapter.queue.getRedriveLineage(sourceJobId)).toMatchObject({
      records: [
        {
          sourceJobId,
          targetJobId: created.targetJobId,
          requestedAt: expect.any(Date),
        },
      ],
      truncated: false,
    });
  });

  it("maps job listings and timelines with bounded payload projections", async () => {
    const deadline = new Date(Date.now() + 60_000);
    const jobId = await adapter.queue.enqueue(
      "drizzle-query",
      { visible: "included", secret: "redacted" },
      {
        queue: "drizzle-query-queue",
        tags: ["provider", "query"],
        maxAttempts: 1,
        deadline,
        executionTimeoutMs: 5_000,
      },
    );
    const claimed = await adapter.queue.claim("drizzle-query-worker", {
      queue: "drizzle-query-queue",
    });
    expect(claimed?.id).toBe(jobId);
    expect(await adapter.queue.fail(claimed!, "drizzle-query-worker", new Error("timeline"))).toBe(
      "failed",
    );

    const omitted = await adapter.queue.listJobs({ type: "drizzle-query" });
    expect(omitted.items).toMatchObject([
      {
        id: jobId,
        queue: "drizzle-query-queue",
        tags: ["provider", "query"],
        state: "failed",
        deadlineAt: expect.any(Date),
        executionTimeoutMs: 5_000,
        runAt: expect.any(Date),
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        payload: null,
        payloadStatus: "omitted",
        payloadBytes: null,
      },
    ]);
    expect(omitted.items[0]!.deadlineAt?.getTime()).toBe(deadline.getTime());

    const included = await adapter.queue.listJobs({
      type: "drizzle-query",
      payload: { include: true, maxBytes: 1_024, redactKeys: ["secret"] },
    });
    expect(included.items[0]).toMatchObject({
      id: jobId,
      payload: { visible: "included" },
      payloadStatus: "included",
      payloadBytes: expect.any(Number),
    });

    const tooLarge = await adapter.queue.listJobs({
      type: "drizzle-query",
      payload: { include: true, maxBytes: 1 },
    });
    expect(tooLarge.items[0]).toMatchObject({
      id: jobId,
      payload: null,
      payloadStatus: "too_large",
      payloadBytes: expect.any(Number),
    });

    const firstTimelinePage = await adapter.queue.getJobTimeline(jobId, { limit: 1 });
    expect(firstTimelinePage.items).toHaveLength(1);
    expect(firstTimelinePage.nextCursor).toMatchObject({
      jobId,
      occurredAt: expect.any(String),
      kind: expect.stringMatching(/^(event|attempt)$/),
      recordId: expect.any(String),
    });
    const secondTimelinePage = await adapter.queue.getJobTimeline(jobId, {
      limit: 100,
      cursor: firstTimelinePage.nextCursor!,
    });
    const timeline = [...firstTimelinePage.items, ...secondTimelinePage.items];
    expect(timeline.some((entry) => entry.kind === "event")).toBe(true);
    const attempt = timeline.find((entry) => entry.kind === "attempt");
    expect(attempt).toMatchObject({
      kind: "attempt",
      attempt: 1,
      fenceToken: expect.any(BigInt),
      workerId: "drizzle-query-worker",
      outcome: "failed",
      startedAt: expect.any(Date),
      claimedAt: expect.any(Date),
      finishedAt: expect.any(Date),
      occurredAt: expect.any(Date),
      error: { name: "Error", message: "timeline" },
    });
    expect(
      timeline.every((entry, index) => {
        const previous = timeline[index - 1];
        return (
          previous === undefined || previous.occurredAt.getTime() >= entry.occurredAt.getTime()
        );
      }),
    ).toBe(true);
  });

  it("preserves PostgreSQL error codes through provider translation", async () => {
    const failure = await drizzleQueryable(db)
      .query("SELECT * FROM workhorse.relation_that_does_not_exist")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DrizzleQueryError);
    expect(failure).toMatchObject({ code: "42P01" });
  });
});
