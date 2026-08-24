import { setTimeout as sleep } from "node:timers/promises";
import { context as otelContext, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import { Worker } from "../src/worker.js";
import { readDashboardJobDetail } from "../../dashboard-server/src/server/read-model.js";
import { dashboardDatabase } from "../../dashboard-server/src/server/sql.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);
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
  it("creates bounded fan-out and joins results by stable child name", async () => {
    const parentId = await queue.enqueue("fan-out-parent", null, { queue: "fan-out-parents" });
    let activations = 0;
    const worker = new Worker(queue, {
      queue: "fan-out-parents",
      workerId: "fan-out-parent-worker",
    });
    worker.handle("fan-out-parent", async (_payload, context) => {
      activations += 1;
      return context.runChildren<{ first: { value: number }; second: { value: number } }>([
        {
          name: "first",
          type: "fan-out-child",
          payload: { value: 1 },
          options: { queue: "fan-out-children" },
        },
        {
          name: "second",
          type: "fan-out-child",
          payload: { value: 2 },
          options: { queue: "fan-out-children" },
        },
      ]);
    });

    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: "blocked" });
    const lineage = await admin.getChildLineage(parentId);
    expect(new Set(lineage.records.map((record) => record.name))).toEqual(
      new Set(["first", "second"]),
    );

    const values = new Map(
      lineage.records.map((record) => [record.childJobId, record.name === "first" ? 1 : 2]),
    );
    for (let index = 0; index < lineage.records.length; index += 1) {
      const child = await queue.claim("fan-out-child-worker", { queue: "fan-out-children" });
      expect(
        await queue.complete(child!, "fan-out-child-worker", {
          value: values.get(child!.id)! * 10,
        }),
      ).toBe(true);
    }

    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(parentId)).resolves.toMatchObject({
      state: "succeeded",
      result: { first: { value: 10 }, second: { value: 20 } },
    });
    expect(activations).toBe(2);
  });

  it("completes an empty fan-out without suspending or replaying the parent", async () => {
    const parentId = await queue.enqueue("empty-fan-out-parent", null, {
      queue: "empty-fan-out-parents",
    });
    let activations = 0;
    const worker = new Worker(queue, {
      queue: "empty-fan-out-parents",
      workerId: "empty-fan-out-worker",
    });
    worker.handle("empty-fan-out-parent", async (_payload, context) => {
      activations += 1;
      return context.runChildren([]);
    });

    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: "succeeded", result: {} });
    expect(activations).toBe(1);
    await expect(admin.getChildLineage(parentId)).resolves.toEqual({
      records: [],
      truncated: false,
    });
  });

  it.each([
    ["failed", "failed"],
    ["canceled", "canceled"],
  ] as const)("makes a fan-out parent %s when one child is %s", async (childState, parentState) => {
    const parentId = await queue.enqueue(`partial-${childState}-parent`, null);
    const parent = await queue.claim(`partial-${childState}-parent-worker`);
    const created = await queue.createChildren(parent!, `partial-${childState}-parent-worker`, [
      { name: "accepted", type: "partial-child", payload: null, options: { maxAttempts: 1 } },
      { name: "rejected", type: "partial-child", payload: null, options: { maxAttempts: 1 } },
    ]);
    expect(created.status).toBe("created");
    const first = await queue.claim("partial-child-worker");
    expect(await queue.complete(first!, "partial-child-worker", { value: "ok" })).toBe(true);
    const second = await queue.claim("partial-child-worker");
    let childOutcome: string;
    if (childState === "failed") {
      childOutcome = await queue.fail(second!, "partial-child-worker", new Error("rejected"));
    } else {
      const request = await queue.cancel(second!.id);
      const acknowledged = await queue.acknowledgeCancel(second!, "partial-child-worker");
      if (request.status !== "cancel_requested" || !acknowledged) {
        throw new Error("active child cancellation was not acknowledged");
      }
      childOutcome = "canceled";
    }
    expect(childOutcome).toBe(childState);
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: parentState });
  });

  it("reuses one joined fan-out across retries and ignores duplicate wakeups", async () => {
    const parentId = await queue.enqueue("retrying-fan-out-parent", null, {
      queue: "retrying-fan-out-parents",
      maxAttempts: 2,
    });
    let joinedAttempts = 0;
    const worker = new Worker(queue, {
      queue: "retrying-fan-out-parents",
      workerId: "retrying-fan-out-worker",
      retryDelayMs: 0,
    });
    worker.handle("retrying-fan-out-parent", async (_payload, context) => {
      const results = await context.runChildren<{ child: { value: number } }>([
        { name: "child", type: "retrying-fan-out-child", payload: null },
      ]);
      joinedAttempts += 1;
      if (joinedAttempts === 1) throw new Error("retry after join");
      return results;
    });

    expect(await worker.runOnce()).toBe(true);
    const child = await queue.claim("retrying-fan-out-child-worker");
    expect(await queue.complete(child!, "retrying-fan-out-child-worker", { value: 7 })).toBe(true);
    await expect(
      pool.query(`SELECT workhorse.release_dependents_v1($1::uuid) AS count`, [child!.id]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(parentId)).resolves.toMatchObject({
      state: "succeeded",
      result: { child: { value: 7 } },
    });
    const timeline = await admin.getJobTimeline(parentId, { limit: 100 });
    expect(
      timeline.items.filter(
        (item) => item.kind === "event" && item.eventType === "children_joined",
      ),
    ).toHaveLength(1);
  });

  it("does not replay a one-child set through the single-child contract", async () => {
    const parentId = await queue.enqueue("one-child-set-parent", null);
    const parent = await queue.claim("one-child-set-parent-worker");
    const created = await queue.createChildren(parent!, "one-child-set-parent-worker", [
      { name: "child", type: "one-child-set-child", payload: null },
    ]);
    expect(created.status).toBe("created");
    const child = await queue.claim("one-child-set-child-worker");
    expect(await queue.complete(child!, "one-child-set-child-worker", { value: 1 })).toBe(true);
    const resumed = await queue.claim("one-child-set-parent-worker");

    await expect(
      queue.createChildren(resumed!, "one-child-set-parent-worker", []),
    ).rejects.toMatchObject({ name: "ChildConflictError", parentJobId: parentId });
    await expect(
      queue.createChild(
        resumed!,
        "one-child-set-parent-worker",
        "child",
        "one-child-set-child",
        null,
      ),
    ).rejects.toMatchObject({ name: "ChildLimitExceededError", parentJobId: parentId });

    const singleParentId = await queue.enqueue("single-contract-parent", null);
    const singleParent = await queue.claim("single-contract-parent-worker");
    const single = await queue.createChild(
      singleParent!,
      "single-contract-parent-worker",
      "child",
      "single-contract-child",
      null,
    );
    const singleChild = await queue.claim("single-contract-child-worker");
    expect(await queue.complete(singleChild!, "single-contract-child-worker", { value: 1 })).toBe(
      true,
    );
    const resumedSingle = await queue.claim("single-contract-parent-worker");
    await expect(
      queue.createChildren(resumedSingle!, "single-contract-parent-worker", [
        { name: "child", type: "single-contract-child", payload: null },
      ]),
    ).rejects.toMatchObject({ name: "ChildConflictError", parentJobId: singleParentId });
    expect(single.status).toBe("created");
  });

  it("attributes a late fan-out failure to the child that failed", async () => {
    const parentId = await queue.enqueue("late-failure-parent", null);
    const parent = await queue.claim("late-failure-parent-worker");
    const created = await queue.createChildren(parent!, "late-failure-parent-worker", [
      { name: "rejected", type: "late-failure-child", payload: null, options: { maxAttempts: 1 } },
      { name: "accepted", type: "late-failure-child", payload: null, options: { maxAttempts: 1 } },
    ]);
    if (created.status !== "created") throw new Error("fan-out was not created");
    const rejected = await queue.claim("late-failure-child-worker");
    expect(await queue.fail(rejected!, "late-failure-child-worker", new Error("rejected"))).toBe(
      "failed",
    );
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: "blocked" });
    const accepted = await queue.claim("late-failure-child-worker");
    expect(await queue.complete(accepted!, "late-failure-child-worker", null)).toBe(true);
    await expect(admin.getJob(parentId)).resolves.toMatchObject({
      state: "failed",
      error: {
        prerequisite_job_id: rejected!.id,
        prerequisite_state: "failed",
        policy_action: "fail",
      },
    });
  });

  it("bounds child count and aggregate joined result size", async () => {
    const oneByteQueue = new Queue(pool, "default", { defaultMaxResultBytes: 1 });
    const oneByteParentId = await oneByteQueue.enqueue("one-byte-empty-parent", null);
    const oneByteParent = await oneByteQueue.claim("one-byte-empty-parent-worker");
    await expect(
      oneByteQueue.createChildren(oneByteParent!, "one-byte-empty-parent-worker", []),
    ).rejects.toMatchObject({
      name: "ChildResultLimitExceededError",
      parentJobId: oneByteParentId,
      resultBytes: 2,
      resultLimitBytes: 1,
    });

    const limitedQueue = new Queue(pool, "default", { defaultMaxResultBytes: 32 });
    const parentId = await limitedQueue.enqueue("limited-fan-out-parent", null);
    const parent = await limitedQueue.claim("limited-fan-out-parent-worker");
    await expect(
      limitedQueue.createChildren(
        parent!,
        "limited-fan-out-parent-worker",
        Array.from({ length: 101 }, (_, index) => ({
          name: `child-${index}`,
          type: "limited-child",
          payload: null,
        })),
      ),
    ).rejects.toMatchObject({ name: "ChildLimitExceededError", parentJobId: parentId });

    const created = await limitedQueue.createChildren(parent!, "limited-fan-out-parent-worker", [
      { name: "first", type: "limited-child", payload: null },
      { name: "second", type: "limited-child", payload: null },
    ]);
    expect(created.status).toBe("created");
    for (let index = 0; index < 2; index += 1) {
      const child = await limitedQueue.claim("limited-child-worker");
      expect(await limitedQueue.complete(child!, "limited-child-worker", "1234567890")).toBe(true);
    }
    const resumed = await limitedQueue.claim("limited-fan-out-parent-worker");
    await expect(
      limitedQueue.createChildren(resumed!, "limited-fan-out-parent-worker", [
        { name: "first", type: "limited-child", payload: null },
        { name: "second", type: "limited-child", payload: null },
      ]),
    ).rejects.toMatchObject({
      name: "ChildResultLimitExceededError",
      parentJobId: parentId,
      resultLimitBytes: 32,
    });
  });

  it("releases parent policy capacity and admits children under their own policy", async () => {
    await queue.syncConcurrencyPolicies("child-policy-test", [
      { queue: "policy-parents", maxActive: 1 },
      { queue: "policy-children", maxActive: 1 },
    ]);
    await queue.syncRateLimitPolicies("child-policy-test", [
      {
        queue: "policy-rate-children",
        rate: { limit: 1, intervalMs: 60_000, burst: 1 },
      },
    ]);
    const parentId = await queue.enqueue("policy-parent", null, { queue: "policy-parents" });
    const siblingId = await queue.enqueue("policy-sibling", null, { queue: "policy-parents" });
    const parent = await queue.claim("policy-parent-worker", { queue: "policy-parents" });
    expect(parent?.id).toBe(parentId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const transactionalQueue = new Queue(client);
      await transactionalQueue.createChildren(parent!, "policy-parent-worker", [
        { name: "rolled-back", type: "policy-child", payload: null },
      ]);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await expect(
      queue.claim("policy-sibling-worker", { queue: "policy-parents" }),
    ).resolves.toBeNull();

    await queue.createChildren(parent!, "policy-parent-worker", [
      { name: "first", type: "policy-child", payload: null, options: { queue: "policy-children" } },
      {
        name: "second",
        type: "policy-child",
        payload: null,
        options: { queue: "policy-children" },
      },
      {
        name: "rate-first",
        type: "policy-child",
        payload: null,
        options: { queue: "policy-rate-children" },
      },
      {
        name: "rate-second",
        type: "policy-child",
        payload: null,
        options: { queue: "policy-rate-children" },
      },
    ]);
    await expect(
      queue.claim("policy-sibling-worker", { queue: "policy-parents" }),
    ).resolves.toMatchObject({
      id: siblingId,
    });
    const first = await queue.claim("policy-child-worker", { queue: "policy-children" });
    expect(first).not.toBeNull();
    await expect(
      queue.claim("other-policy-child-worker", { queue: "policy-children" }),
    ).resolves.toBeNull();
    expect(await queue.complete(first!, "policy-child-worker", null)).toBe(true);
    await expect(
      queue.claim("policy-child-worker", { queue: "policy-children" }),
    ).resolves.not.toBeNull();
    const rateFirst = await queue.claim("policy-rate-child-worker", {
      queue: "policy-rate-children",
    });
    expect(rateFirst).not.toBeNull();
    expect(await queue.complete(rateFirst!, "policy-rate-child-worker", null)).toBe(true);
    await expect(
      queue.claim("policy-rate-child-worker", { queue: "policy-rate-children" }),
    ).resolves.toBeNull();
  });

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
    await expect(admin.getJob(parentId)).resolves.toMatchObject({
      state: "blocked",
      childJobIds: [created.child.childJobId],
      parentJobId: null,
    });
    await expect(admin.getJob(created.child.childJobId)).resolves.toMatchObject({
      state: "ready",
      childJobIds: [],
      parentJobId: parentId,
    });
    await expect(admin.getChildLineage(parentId)).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          parentJobId: parentId,
          childJobId: created.child.childJobId,
          name: "charge",
        }),
      ],
      truncated: false,
    });
    const listed = await admin.listJobs({ states: ["blocked", "ready"] });
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
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: "blocked" });
    const lineage = await admin.getChildLineage(parentId);
    const childId = lineage.records[0]!.childJobId;
    const child = await queue.claim("child-worker", { queue: "children" });
    expect(child?.id).toBe(childId);
    expect(await queue.complete(child!, "child-worker", { receiptId: "receipt-1" })).toBe(true);

    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(parentId)).resolves.toMatchObject({
      state: "succeeded",
      result: { receiptId: "receipt-1" },
    });
    expect(activations).toBe(2);
    await expect(admin.getChildLineage(parentId)).resolves.toMatchObject({
      records: [expect.objectContaining({ joinedAt: expect.any(Date) })],
    });
    const timeline = await admin.getJobTimeline(parentId, { limit: 100 });
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

    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: "active" });
    await expect(admin.getJob(rolledBackChildId!)).resolves.toBeNull();
    await expect(admin.getChildLineage(parentId)).resolves.toEqual({
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
    await expect(admin.getChildLineage(parentId)).resolves.toEqual({
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
        queue.createChild(parent!, "expiring-transition-worker", "child", "orphan-candidate", null),
      ).rejects.toMatchObject({ name: "ChildLeaseLostError", parentJobId: parentId });
    } finally {
      await pool.query(`
        DROP TRIGGER test_delay_child_link ON workhorse.job_child;
        DROP FUNCTION workhorse.test_delay_child_link()
      `);
    }

    await expect(admin.getChildLineage(parentId)).resolves.toEqual({
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
    const created = await underTrace("11111111111111111111111111111111", "1111111111111111", () =>
      queue.createChild(firstParent!, "trace-stable-worker", "child", "trace-child", null),
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

    await expect(admin.getJob(created.child.childJobId)).resolves.toMatchObject({
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
    await expect(admin.getChildLineage(parentId)).resolves.toMatchObject({
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
    await expect(admin.getJob(parentId)).resolves.toMatchObject({
      state: "succeeded",
      result: { doubled: 8 },
      childJobIds: [],
    });
    const timeline = await admin.getJobTimeline(parentId, { limit: 100 });
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
    const childId = (await admin.getChildLineage(parentId)).records[0]!.childJobId;
    const child = await queue.claim("retry-child-worker", { queue: "retry-children" });
    expect(await queue.complete(child!, "retry-child-worker", { value: 7 })).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: "ready" });
    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(parentId)).resolves.toMatchObject({
      state: "succeeded",
      result: { value: 7 },
    });
    expect(await admin.getChildLineage(parentId)).toMatchObject({
      records: [expect.objectContaining({ childJobId: childId })],
    });
    const timeline = await admin.getJobTimeline(parentId, { limit: 100 });
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
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: "canceled" });
  });

  it("settles active-child cancellation once and leaves terminal descendants unchanged", async () => {
    const activeParentId = await queue.enqueue("active-cancel-parent", null);
    const activeParent = await queue.claim("active-cancel-parent-worker");
    const activeCreated = await queue.createChild(
      activeParent!,
      "active-cancel-parent-worker",
      "child",
      "active-cancel-child",
      null,
    );
    const activeChild = await queue.claim("active-cancel-child-worker");
    expect(activeChild?.id).toBe(activeCreated.child.childJobId);

    await expect(queue.cancel(activeChild!.id, { requestedBy: "operator" })).resolves.toMatchObject(
      {
        status: "cancel_requested",
      },
    );
    await expect(admin.getJob(activeParentId)).resolves.toMatchObject({ state: "blocked" });
    expect(await queue.acknowledgeCancel(activeChild!, "active-cancel-child-worker")).toBe(true);
    await expect(admin.getJob(activeParentId)).resolves.toMatchObject({ state: "canceled" });

    const terminalParentId = await queue.enqueue("terminal-cancel-parent", null);
    const terminalParent = await queue.claim("terminal-cancel-parent-worker");
    const terminalCreated = await queue.createChild(
      terminalParent!,
      "terminal-cancel-parent-worker",
      "child",
      "terminal-cancel-child",
      null,
    );
    const terminalChild = await queue.claim("terminal-cancel-child-worker");
    expect(await queue.complete(terminalChild!, "terminal-cancel-child-worker", { value: 1 })).toBe(
      true,
    );
    await expect(
      queue.cancel(terminalCreated.child.childJobId, { requestedBy: "operator" }),
    ).resolves.toMatchObject({ status: "already_terminal", state: "succeeded" });
    await expect(admin.getJob(terminalParentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("retains a canceled parent while its child is live and later reclaims the expired tree", async () => {
    const parentId = await queue.enqueue("retained-cancel-parent", null);
    const parent = await queue.claim("retained-cancel-parent-worker");
    const created = await queue.createChild(
      parent!,
      "retained-cancel-parent-worker",
      "child",
      "retained-cancel-child",
      null,
    );
    await queue.cancel(parentId, { requestedBy: "operator" });
    const expiredAt = new Date("2020-01-01T00:00:00.000Z");
    await pool.query("UPDATE workhorse.job SET created_at = $2 WHERE id = ANY($1::uuid[])", [
      [parentId, created.child.childJobId],
      expiredAt,
    ]);
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = $2, history_through_at = $2
        WHERE job_id = $1::uuid`,
      [parentId, expiredAt],
    );

    await expect(
      pool.query("SELECT workhorse.prune_terminal_jobs_v1($1, $1, $1, 100) AS count", [
        new Date("2021-01-01T00:00:00.000Z"),
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(admin.getChildLineage(parentId)).resolves.toMatchObject({
      records: [expect.objectContaining({ childJobId: created.child.childJobId })],
    });

    expect((await queue.cancel(created.child.childJobId)).status).toBe("canceled");
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = $2, history_through_at = $2
        WHERE job_id = $1::uuid`,
      [created.child.childJobId, expiredAt],
    );
    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = ANY($1::uuid[])", [
      [parentId, created.child.childJobId],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = ANY($1::uuid[])", [
      [parentId, created.child.childJobId],
    ]);
    const firstPass = await pool.query<{ count: number }>(
      "SELECT workhorse.prune_terminal_jobs_v1($1, $1, $1, 100) AS count",
      [new Date("2021-01-01T00:00:00.000Z")],
    );
    const secondPass = await pool.query<{ count: number }>(
      "SELECT workhorse.prune_terminal_jobs_v1($1, $1, $1, 100) AS count",
      [new Date("2021-01-01T00:00:00.000Z")],
    );
    expect(firstPass.rows[0]!.count + secondPass.rows[0]!.count).toBe(2);
    await expect(admin.getJob(parentId)).resolves.toBeNull();
    await expect(admin.getJob(created.child.childJobId)).resolves.toBeNull();
  });

  it("redrives a failed parent into a fresh identity without rewriting its child tree", async () => {
    const parentId = await queue.enqueue("redriven-child-parent", null, { maxAttempts: 1 });
    const parent = await queue.claim("redriven-child-parent-worker");
    const created = await queue.createChild(
      parent!,
      "redriven-child-parent-worker",
      "child",
      "redriven-child",
      null,
      { maxAttempts: 1 },
    );
    const child = await queue.claim("redriven-child-worker");
    expect(await queue.fail(child!, "redriven-child-worker", new Error("child failed"))).toBe(
      "failed",
    );
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: "failed" });

    const redrive = await admin.redrive(parentId, {
      actor: "operator",
      reason: "child dependency repaired",
      requestId: `child-parent-redrive-${parentId}`,
    });
    expect(redrive.status).toBe("redriven");
    const targetId = redrive.targetJobId!;
    await expect(admin.getChildLineage(parentId)).resolves.toMatchObject({
      records: [expect.objectContaining({ childJobId: created.child.childJobId })],
    });
    await expect(admin.getChildLineage(targetId)).resolves.toEqual({
      records: [],
      truncated: false,
    });
    await expect(admin.getRedriveLineage(parentId)).resolves.toMatchObject({
      records: [expect.objectContaining({ sourceJobId: parentId, targetJobId: targetId })],
      truncated: false,
    });
    await expect(readDashboardJobDetail(dashboardDatabase(pool), parentId)).resolves.toMatchObject({
      childLineage: {
        records: [expect.objectContaining({ childJobId: created.child.childJobId })],
      },
      redriveLineage: {
        records: [expect.objectContaining({ sourceJobId: parentId, targetJobId: targetId })],
        truncated: false,
      },
    });
    await expect(readDashboardJobDetail(dashboardDatabase(pool), targetId)).resolves.toMatchObject({
      childLineage: { records: [], truncated: false },
      redriveLineage: {
        records: [expect.objectContaining({ sourceJobId: parentId, targetJobId: targetId })],
        truncated: false,
      },
    });
  });

  it("returns complete dashboard lineage for a child that owns a full child set", async () => {
    const rootId = await queue.enqueue("lineage-root", null);
    const root = await queue.claim("lineage-root-worker");
    const middleResult = await queue.createChild(
      root!,
      "lineage-root-worker",
      "middle",
      "lineage-middle",
      null,
    );
    const middle = await queue.claim("lineage-middle-worker");
    expect(middle?.id).toBe(middleResult.child.childJobId);
    await queue.createChildren(
      middle!,
      "lineage-middle-worker",
      Array.from({ length: 100 }, (_, index) => ({
        name: `leaf-${index}`,
        type: "lineage-leaf",
        payload: { index },
      })),
    );

    const detail = await readDashboardJobDetail(
      dashboardDatabase(pool),
      middleResult.child.childJobId,
    );
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      childLineage: {
        records: expect.arrayContaining([
          expect.objectContaining({
            parentJobId: rootId,
            childJobId: middleResult.child.childJobId,
          }),
        ]),
        truncated: false,
      },
    });
    expect(detail?.childLineage.records).toHaveLength(101);
  });

  it("reports bounded child pressure and retained failure evidence by parent queue", async () => {
    const parentId = await queue.enqueue("observed-child-parent", null, {
      queue: "observed-parents",
    });
    const parent = await queue.claim("observed-child-parent-worker", {
      queue: "observed-parents",
    });
    await queue.createChildren(parent!, "observed-child-parent-worker", [
      { name: "success", type: "observed-child", payload: null, options: { maxAttempts: 1 } },
      { name: "failure", type: "observed-child", payload: null, options: { maxAttempts: 1 } },
    ]);
    await expect(queue.health()).resolves.toMatchObject({
      children: {
        waitingParents: 1,
        pendingChildren: 2,
        unjoinedResults: 0,
        failedParents: 0,
        canceledParents: 0,
        capped: false,
      },
    });

    const first = await queue.claim("observed-child-worker");
    expect(await queue.complete(first!, "observed-child-worker", { value: 1 })).toBe(true);
    const second = await queue.claim("observed-child-worker");
    expect(await queue.fail(second!, "observed-child-worker", new Error("failed"))).toBe("failed");
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: "failed" });
    await expect(queue.health()).resolves.toMatchObject({
      children: {
        waitingParents: 0,
        pendingChildren: 0,
        unjoinedResults: 1,
        failedParents: 1,
        canceledParents: 0,
        capped: false,
      },
    });
    await expect(queue.queueMetricSnapshot()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queue: "observed-parents",
          childWaitingParents: 0,
          childPendingChildren: 0,
          childUnjoinedResults: 1,
          childFailedParents: 1,
          childCanceledParents: 0,
          childCountsCapped: false,
        }),
      ]),
    );
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
    expect((await admin.getChildLineage(parentId)).records).toHaveLength(1);
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
    await expect(admin.getJob(parentId)).resolves.toMatchObject({ state: parentState });
    await expect(admin.getChildLineage(parentId)).resolves.toMatchObject({
      records: [expect.objectContaining({ outcomeState: childState, error: expect.anything() })],
    });
    await expect(readDashboardJobDetail(dashboardDatabase(pool), parentId)).resolves.toMatchObject({
      childLineage: {
        records: [expect.objectContaining({ outcomeState: childState, error: expect.anything() })],
      },
    });
  });
});
