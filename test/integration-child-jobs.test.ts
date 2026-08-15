import { setTimeout as sleep } from "node:timers/promises";
import { context as otelContext, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import { Worker } from "../src/worker.js";
import { readDashboardJobDetail } from "../packages/dashboard/src/server/read-model.js";
import { dashboardDatabase } from "../packages/dashboard/src/server/sql.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  otelContext.setGlobalContextManager(contextManager.enable());
});

afterAll(() => {
  otelContext.disable();
  contextManager.disable();
});

const underTrace = <T>(traceId: string, spanId: string, operation: () => Promise<T>) =>
  otelContext.with(
    trace.setSpanContext(otelContext.active(), { traceId, spanId, traceFlags: 1 }),
    operation,
  );

describe("child jobs", () => {
  it("creates one linked child and suspends its active parent atomically", async () => {
    const parentId = await queue.enqueue("parent", { orderId: "order-1" });
    const parent = await queue.claim("parent-worker");
    expect(parent?.id).toBe(parentId);

    const created = await queue.createChild(parent!, "parent-worker", "charge", "charge-card", {
      amount: 42,
    });

    expect(created).toMatchObject({
      status: "created",
      child: {
        parentJobId: parentId,
        name: "charge",
        type: "charge-card",
        result: null,
      },
    });
    await expect(queue.getJob(parentId)).resolves.toMatchObject({
      state: "blocked",
      childJobIds: [created.child.childJobId],
      parentJobId: null,
    });
    await expect(queue.getJob(created.child.childJobId)).resolves.toMatchObject({
      state: "ready",
      childJobIds: [],
      parentJobId: parentId,
    });
    await expect(queue.getChildLineage(parentId)).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          parentJobId: parentId,
          childJobId: created.child.childJobId,
          name: "charge",
        }),
      ],
      truncated: false,
    });
    const listed = await queue.listJobs({ states: ["blocked", "ready"] });
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: parentId, childJobIds: [created.child.childJobId] }),
        expect.objectContaining({ id: created.child.childJobId, parentJobId: parentId }),
      ]),
    );
    await expect(
      readDashboardJobDetail(dashboardDatabase(pool), created.child.childJobId),
    ).resolves.toMatchObject({
      childLineage: {
        records: [
          expect.objectContaining({
            parentJobId: parentId,
            childJobId: created.child.childJobId,
          }),
        ],
        truncated: false,
      },
    });
  });

  it("replays a handler after child success and joins the retained result", async () => {
    const parentId = await queue.enqueue("checkout", { orderId: "order-2" }, { queue: "parents" });
    let activations = 0;
    const worker = new Worker(queue, { queue: "parents", workerId: "joining-parent-worker" });
    worker.handle("checkout", async (_payload, context) => {
      activations += 1;
      const charge = await context.runChild<{ amount: number }, { receiptId: string }>(
        "charge",
        "charge-card",
        { amount: 42 },
        { queue: "children" },
      );
      return { receiptId: charge.receiptId };
    });

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(parentId)).resolves.toMatchObject({ state: "blocked" });
    const lineage = await queue.getChildLineage(parentId);
    const childId = lineage.records[0]!.childJobId;
    const child = await queue.claim("child-worker", { queue: "children" });
    expect(child?.id).toBe(childId);
    expect(await queue.complete(child!, "child-worker", { receiptId: "receipt-1" })).toBe(true);

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(parentId)).resolves.toMatchObject({
      state: "succeeded",
      result: { receiptId: "receipt-1" },
    });
    expect(activations).toBe(2);
    await expect(queue.getChildLineage(parentId)).resolves.toMatchObject({
      records: [expect.objectContaining({ joinedAt: expect.any(Date) })],
    });
    const timeline = await queue.getJobTimeline(parentId, { limit: 100 });
    expect(timeline.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "event", eventType: "child_created" }),
        expect.objectContaining({ kind: "event", eventType: "child_joined" }),
      ]),
    );
  });

  it("rolls back the child, lineage, and parent suspension with a caller transaction", async () => {
    const parentId = await queue.enqueue("transactional-parent", null);
    const parent = await queue.claim("transactional-parent-worker");
    const client = await pool.connect();
    let rolledBackChildId: string;
    try {
      await client.query("BEGIN");
      const transactionalQueue = new Queue(client);
      const created = await transactionalQueue.createChild(
        parent!,
        "transactional-parent-worker",
        "only-child",
        "transactional-child",
        null,
      );
      rolledBackChildId = created.child.childJobId;
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    await expect(queue.getJob(parentId)).resolves.toMatchObject({ state: "active" });
    await expect(queue.getJob(rolledBackChildId!)).resolves.toBeNull();
    await expect(queue.getChildLineage(parentId)).resolves.toEqual({
      records: [],
      truncated: false,
    });
  });

  it("rejects a stale fence without creating a child", async () => {
    const parentId = await queue.enqueue("stale-parent", null, { maxAttempts: 2 });
    const stale = await queue.claim("stale-parent-worker", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired(100, 0)).toBe(1);

    await expect(
      queue.createChild(stale!, "stale-parent-worker", "child", "stale-child", null),
    ).rejects.toMatchObject({ name: "ChildLeaseLostError", parentJobId: parentId });
    await expect(queue.getChildLineage(parentId)).resolves.toEqual({
      records: [],
      truncated: false,
    });
  });

  it("rolls back child creation when the parent lease expires during the transition", async () => {
    const parentId = await queue.enqueue("expiring-transition-parent", null);
    const parent = await queue.claim("expiring-transition-worker", { leaseMs: 100 });
    await pool.query(`
      CREATE FUNCTION workhorse.test_delay_child_link() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.2);
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER test_delay_child_link
      BEFORE INSERT ON workhorse.job_child
      FOR EACH ROW EXECUTE FUNCTION workhorse.test_delay_child_link()
    `);
    try {
      await expect(
        queue.createChild(
          parent!,
          "expiring-transition-worker",
          "child",
          "orphan-candidate",
          null,
        ),
      ).rejects.toMatchObject({ name: "ChildLeaseLostError", parentJobId: parentId });
    } finally {
      await pool.query(`
        DROP TRIGGER test_delay_child_link ON workhorse.job_child;
        DROP FUNCTION workhorse.test_delay_child_link()
      `);
    }

    await expect(queue.getChildLineage(parentId)).resolves.toEqual({
      records: [],
      truncated: false,
    });
    const children = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workhorse.job WHERE job_type = 'orphan-candidate'`,
    );
    expect(children.rows[0]?.count).toBe("0");
  });

  it("keeps a trace-less parent child request stable across active handler traces", async () => {
    const parentId = await queue.enqueue("trace-stable-parent", null);
    const firstParent = await queue.claim("trace-stable-worker");
    const created = await underTrace(
      "11111111111111111111111111111111",
      "1111111111111111",
      () => queue.createChild(firstParent!, "trace-stable-worker", "child", "trace-child", null),
    );
    const child = await queue.claim("trace-child-worker");
    expect(await queue.complete(child!, "trace-child-worker", { value: 1 })).toBe(true);
    const resumed = await queue.claim("trace-stable-worker");
    expect(resumed?.id).toBe(parentId);

    await expect(
      underTrace("22222222222222222222222222222222", "2222222222222222", () =>
        queue.createChild(resumed!, "trace-stable-worker", "child", "trace-child", null),
      ),
    ).resolves.toMatchObject({
      status: "completed",
      child: { childJobId: created.child.childJobId, result: { value: 1 } },
    });
  });

  it("preserves a child's scheduled run time", async () => {
    const parentId = await queue.enqueue("scheduled-child-parent", null);
    const parent = await queue.claim("scheduled-child-parent-worker");
    const runAt = new Date(Date.now() + 60_000);
    const created = await queue.createChild(
      parent!,
      "scheduled-child-parent-worker",
      "child",
      "scheduled-child",
      null,
      { runAt },
    );

    await expect(queue.getJob(created.child.childJobId)).resolves.toMatchObject({
      state: "scheduled",
      runAt,
      parentJobId: parentId,
    });
  });

  it("rejects concurrent child calls with the same name but different requests", async () => {
    const parentId = await queue.enqueue("concurrent-child-parent", null, {
      queue: "concurrent-child-parents",
    });
    let conflict: unknown;
    const worker = new Worker(queue, {
      queue: "concurrent-child-parents",
      workerId: "concurrent-child-parent-worker",
    });
    worker.handle("concurrent-child-parent", async (_payload, childContext) => {
      const first = childContext.runChild("child", "concurrent-child", { version: 1 });
      try {
        await childContext.runChild("child", "concurrent-child", { version: 2 });
      } catch (error) {
        conflict = error;
      }
      await first;
      return null;
    });

    expect(await worker.runOnce()).toBe(true);
    expect(conflict).toMatchObject({ name: "ChildConflictError", parentJobId: parentId });
    await expect(queue.getChildLineage(parentId)).resolves.toMatchObject({
      records: [expect.objectContaining({ name: "child" })],
    });
  });

  it("completes a typed handler that does not create a child", async () => {
    const parentId = await queue.enqueue("no-child-parent", { value: 4 }, { queue: "no-child" });
    const worker = new Worker(queue, { queue: "no-child", workerId: "no-child-worker" });
    worker.handle<{ value: number }, { doubled: number }>("no-child-parent", async (payload) => ({
      doubled: payload.value * 2,
    }));

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(parentId)).resolves.toMatchObject({
      state: "succeeded",
      result: { doubled: 8 },
      childJobIds: [],
    });
    const timeline = await queue.getJobTimeline(parentId, { limit: 100 });
    expect(timeline.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "event", eventType: "succeeded" })]),
    );
  });

  it("reuses one joined child across a parent retry", async () => {
    const parentId = await queue.enqueue("retrying-parent", null, {
      queue: "retrying-parents",
      maxAttempts: 2,
    });
    let joinedAttempts = 0;
    const worker = new Worker(queue, {
      queue: "retrying-parents",
      workerId: "retrying-parent-worker",
      retryDelayMs: 0,
    });
    worker.handle("retrying-parent", async (_payload, context) => {
      const result = await context.runChild<null, { value: number }>("one", "retry-child", null, {
        queue: "retry-children",
      });
      joinedAttempts += 1;
      if (joinedAttempts === 1) throw new Error("retry after join");
      return result;
    });

    expect(await worker.runOnce()).toBe(true);
    const childId = (await queue.getChildLineage(parentId)).records[0]!.childJobId;
    const child = await queue.claim("retry-child-worker", { queue: "retry-children" });
    expect(await queue.complete(child!, "retry-child-worker", { value: 7 })).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(parentId)).resolves.toMatchObject({ state: "ready" });
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(parentId)).resolves.toMatchObject({
      state: "succeeded",
      result: { value: 7 },
    });
    expect(await queue.getChildLineage(parentId)).toMatchObject({
      records: [expect.objectContaining({ childJobId: childId })],
    });
    const timeline = await queue.getJobTimeline(parentId, { limit: 100 });
    expect(
      timeline.items.filter((item) => item.kind === "event" && item.eventType === "child_joined"),
    ).toHaveLength(1);
  });

  it("does not resurrect a canceled parent when its child later succeeds", async () => {
    const parentId = await queue.enqueue("cancel-parent", null);
    const parent = await queue.claim("cancel-parent-worker");
    const created = await queue.createChild(
      parent!,
      "cancel-parent-worker",
      "child",
      "cancel-child",
      null,
    );
    await expect(queue.cancel(parentId, { requestedBy: "operator" })).resolves.toMatchObject({
      status: "canceled",
    });
    const child = await queue.claim("cancel-child-worker");
    expect(child?.id).toBe(created.child.childJobId);
    expect(await queue.complete(child!, "cancel-child-worker", null)).toBe(true);
    await expect(queue.getJob(parentId)).resolves.toMatchObject({ state: "canceled" });
  });

  it("replays the same child and rejects changed or second-child requests", async () => {
    const parentId = await queue.enqueue("duplicate-parent", null);
    const firstParent = await queue.claim("duplicate-parent-worker");
    const created = await queue.createChild(
      firstParent!,
      "duplicate-parent-worker",
      "only",
      "duplicate-child",
      { value: 1 },
    );
    const child = await queue.claim("duplicate-child-worker");
    expect(await queue.complete(child!, "duplicate-child-worker", { answer: 1 })).toBe(true);
    const resumed = await queue.claim("duplicate-parent-worker");
    expect(resumed?.id).toBe(parentId);

    await expect(
      queue.createChild(resumed!, "duplicate-parent-worker", "only", "duplicate-child", {
        value: 1,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      child: { childJobId: created.child.childJobId, result: { answer: 1 } },
    });
    await expect(
      queue.createChild(resumed!, "duplicate-parent-worker", "only", "duplicate-child", {
        value: 2,
      }),
    ).rejects.toMatchObject({ name: "ChildConflictError" });
    await expect(
      queue.createChild(resumed!, "duplicate-parent-worker", "second", "duplicate-child", {
        value: 1,
      }),
    ).rejects.toMatchObject({ name: "ChildLimitExceededError" });
    expect((await queue.getChildLineage(parentId)).records).toHaveLength(1);
  });

  it.each([
    ["failed", "failed"],
    ["canceled", "canceled"],
  ] as const)("makes the parent %s when its child is %s", async (childState, parentState) => {
    const parentId = await queue.enqueue(`${childState}-child-parent`, null);
    const parent = await queue.claim(`${childState}-child-parent-worker`);
    const created = await queue.createChild(
      parent!,
      `${childState}-child-parent-worker`,
      "child",
      `${childState}-child`,
      null,
      { maxAttempts: 1 },
    );

    let childOutcome: string;
    if (childState === "failed") {
      const child = await queue.claim("failing-child-worker");
      childOutcome = await queue.fail(child!, "failing-child-worker", new Error("child failed"));
    } else {
      childOutcome = (await queue.cancel(created.child.childJobId)).status;
    }
    expect(childOutcome).toBe(childState);
    await expect(queue.getJob(parentId)).resolves.toMatchObject({ state: parentState });
  });
});
