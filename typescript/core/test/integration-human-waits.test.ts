import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  HumanWaitAlreadyWaitingError,
  HumanWaitIdempotencyConflictError,
  HumanWaitLeaseLostError,
  MAX_EXTERNAL_WAIT_VALUE_BYTES,
  Worker,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { queue, admin } = createIntegrationTestContext(import.meta.url);

describe("human waits", () => {
  it("lists actionable human waits through the public read API", async () => {
    const id = await queue.enqueue("human-list", {});
    const worker = new Worker(queue, { workerId: "human-list-worker" }).handle(
      "human-list",
      async (_payload, context) =>
        context.waitForHuman("approval", { prompt: "Approve this account?" }),
    );

    expect(await worker.runOnce()).toBe(true);
    await expect(admin.listHumanWaits()).resolves.toEqual({
      items: [
        {
          jobId: id,
          queue: "default",
          jobType: "human-list",
          name: "approval",
          context: { prompt: "Approve this account?" },
          attempt: 1,
          createdAt: expect.any(Date),
          deadlineAt: expect.any(Date),
        },
      ],
      nextCursor: null,
    });

    await queue.completeHumanWait(
      id,
      "approval",
      { approved: true },
      { idempotencyKey: "human-list-completion", requestedBy: "operator" },
    );
    await expect(admin.listHumanWaits()).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("rejects token names the dashboard would normalize to another identity", async () => {
    const id = await queue.enqueue("human-name", {});
    const claimed = await queue.claim("human-name-worker");
    await expect(
      queue.waitForHuman(claimed!, "human-name-worker", " review ", { prompt: "Review?" }),
    ).rejects.toThrow(/leading or trailing whitespace/);
    await queue.cancel(id);
  });

  it("distinguishes an existing decision from a lost lease", async () => {
    const id = await queue.enqueue("human-concurrent-wait", {});
    const claimed = await queue.claim("human-concurrent-wait-worker");
    const declarations = await Promise.allSettled([
      queue.waitForHuman(claimed!, "human-concurrent-wait-worker", "approval", {
        prompt: "Approve?",
      }),
      queue.waitForHuman(claimed!, "human-concurrent-wait-worker", "approval", {
        prompt: "Approve?",
      }),
    ]);

    expect(declarations).toEqual(
      expect.arrayContaining([
        { status: "fulfilled", value: { status: "waiting", payload: null } },
        { status: "rejected", reason: expect.any(HumanWaitAlreadyWaitingError) },
      ]),
    );
    await queue.cancel(id);
  });

  it("does not let another stale generation conflict with the pending decision owner", async () => {
    const id = await queue.enqueue("human-pending-owner", {});
    const claimed = await queue.claim("human-pending-owner-worker");
    await expect(
      queue.waitForHuman(claimed!, "human-pending-owner-worker", "approval", {
        prompt: "Approve?",
      }),
    ).resolves.toMatchObject({ status: "waiting" });

    await expect(
      queue.waitForHuman(
        { ...claimed!, fenceToken: claimed!.fenceToken + 1n },
        "human-pending-owner-worker",
        "approval",
        { prompt: "Changed prompt" },
      ),
    ).rejects.toBeInstanceOf(HumanWaitLeaseLostError);
    await queue.cancel(id);
  });

  it("releases the lease, retains the operator result, and replays it once", async () => {
    const id = await queue.enqueue("human-approval", { orderId: "order-1" });
    const worker = new Worker(queue, { workerId: "human-approval-worker" }).handle(
      "human-approval",
      async (_payload, context) => {
        const decision = await context.waitForHuman<
          { prompt: string; orderId: string },
          { approved: boolean }
        >("approval", { prompt: "Approve this order?", orderId: "order-1" });
        return { decision };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "scheduled" });

    const request = { idempotencyKey: "operator-request-1", requestedBy: "operator@example.com" };
    const first = await queue.completeHumanWait(id, "approval", { approved: true }, request);
    expect(first).toMatchObject({
      status: "completed",
      payload: { approved: true },
      completedBy: "operator@example.com",
    });
    await expect(
      queue.completeHumanWait(id, "approval", { approved: true }, request),
    ).resolves.toEqual({ ...first, status: "duplicate" });

    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { decision: { approved: true } },
    });
  });

  it("serializes competing completions and preserves accepted audit evidence", async () => {
    const id = await queue.enqueue("human-race", {});
    const worker = new Worker(queue, { workerId: "human-race-worker" }).handle(
      "human-race",
      async (_payload, context) => context.waitForHuman("review", { prompt: "Choose" }),
    );
    expect(await worker.runOnce()).toBe(true);

    const completions = await Promise.all([
      queue.completeHumanWait(
        id,
        "review",
        { choice: "a" },
        {
          idempotencyKey: "choice-a",
          requestedBy: "operator-a",
        },
      ),
      queue.completeHumanWait(
        id,
        "review",
        { choice: "b" },
        {
          idempotencyKey: "choice-b",
          requestedBy: "operator-b",
        },
      ),
    ]);
    expect(completions.map(({ status }) => status)).toEqual(
      expect.arrayContaining(["completed", "already_completed"]),
    );
    expect(completions[0]!.payload).toEqual(completions[1]!.payload);

    const events = (await admin.getJobTimeline(id)).items.filter((item) => item.kind === "event");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "human_wait_completed",
          details: expect.objectContaining({ completed_by: expect.stringMatching(/^operator-/) }),
        }),
        expect.objectContaining({
          eventType: "human_wait_rejected",
          details: expect.objectContaining({ reason: "already_completed" }),
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("choice-a");
    expect(JSON.stringify(events)).not.toContain("choice-b");
  });

  it("rejects a changed retry for the retained idempotency key", async () => {
    const id = await queue.enqueue("human-conflict", {});
    const worker = new Worker(queue, { workerId: "human-conflict-worker" }).handle(
      "human-conflict",
      async (_payload, context) => context.waitForHuman("approval", { prompt: "Approve?" }),
    );
    expect(await worker.runOnce()).toBe(true);
    const request = { idempotencyKey: "same-key", requestedBy: "operator" };
    await queue.completeHumanWait(id, "approval", { approved: true }, request);
    await expect(
      queue.completeHumanWait(id, "approval", { approved: false }, request),
    ).rejects.toBeInstanceOf(HumanWaitIdempotencyConflictError);
  });

  it("rejects an early completion but accepts the same request after the decision exists", async () => {
    const id = await queue.enqueue("human-early", {});
    const request = { idempotencyKey: "early-retry", requestedBy: "operator" };
    await expect(
      queue.completeHumanWait(id, "review", { approved: true }, request),
    ).resolves.toMatchObject({ status: "not_waiting", payload: null });

    const worker = new Worker(queue, { workerId: "human-early-worker" }).handle(
      "human-early",
      async (_payload, context) =>
        context.waitForHuman("review", { prompt: "Review this account?" }),
    );
    expect(await worker.runOnce()).toBe(true);
    await expect(
      queue.completeHumanWait(id, "review", { approved: true }, request),
    ).resolves.toMatchObject({ status: "completed", payload: { approved: true } });
  });

  it("rejects a stale handler generation before it can declare a decision", async () => {
    const id = await queue.enqueue("human-stale", {}, { maxAttempts: 2 });
    const stale = await queue.claim("human-stale-worker", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);

    await expect(
      queue.waitForHuman(stale!, "human-stale-worker", "review", { prompt: "Review?" }),
    ).rejects.toBeInstanceOf(HumanWaitLeaseLostError);
    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "ready", currentAttempt: 2 });
  });

  it("bounds decision context and results before writing them", async () => {
    const id = await queue.enqueue("human-bounds", {});
    const claimed = await queue.claim("human-bounds-worker");
    await expect(
      queue.waitForHuman(claimed!, "human-bounds-worker", "review", {
        data: "x".repeat(MAX_EXTERNAL_WAIT_VALUE_BYTES),
      }),
    ).rejects.toThrow(/at most 65536 bytes/);

    await expect(
      queue.waitForHuman(claimed!, "human-bounds-worker", "review", { prompt: "Review?" }),
    ).resolves.toMatchObject({ status: "waiting" });
    await expect(
      queue.completeHumanWait(
        id,
        "review",
        { data: "x".repeat(MAX_EXTERNAL_WAIT_VALUE_BYTES) },
        { idempotencyKey: "oversized-result", requestedBy: "operator" },
      ),
    ).rejects.toThrow(/at most 65536 bytes/);
    await queue.cancel(id);
  });

  it("replays a completed decision after a later handler failure retries the attempt", async () => {
    const id = await queue.enqueue("human-retry", {}, { maxAttempts: 2 });
    const worker = new Worker(queue, {
      workerId: "human-retry-worker",
      retryDelayMs: 0,
    }).handle("human-retry", async (_payload, context) => {
      const decision = await context.waitForHuman<{ prompt: string }, { approved: boolean }>(
        "review",
        { prompt: "Review?" },
      );
      if (context.job.attempt === 1) throw new Error("fail after completion");
      return decision;
    });
    expect(await worker.runOnce()).toBe(true);
    await queue.completeHumanWait(
      id,
      "review",
      { approved: true },
      { idempotencyKey: "retry-completion", requestedBy: "operator" },
    );
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      currentAttempt: 2,
      result: { approved: true },
    });
  });

  it("cancellation closes a pending decision and fences a late operator", async () => {
    const id = await queue.enqueue("human-canceled", {});
    const worker = new Worker(queue, { workerId: "human-canceled-worker" }).handle(
      "human-canceled",
      async (_payload, context) => context.waitForHuman("review", { prompt: "Review?" }),
    );
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.health()).resolves.toMatchObject({
      externalWaits: {
        pendingHumanDecisions: 1,
        rejectedDeliveries: 0,
        capped: false,
      },
    });

    await expect(queue.cancel(id, { requestedBy: "operator" })).resolves.toMatchObject({
      status: "canceled",
    });
    await expect(
      queue.completeHumanWait(
        id,
        "review",
        { approved: true },
        { idempotencyKey: "late-completion", requestedBy: "late-operator" },
      ),
    ).resolves.toMatchObject({ status: "stale", payload: null });

    const events = (await admin.getJobTimeline(id)).items.filter((item) => item.kind === "event");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "canceled" }),
        expect.objectContaining({
          eventType: "human_wait_rejected",
          details: expect.objectContaining({ reason: "stale", completed_by: "late-operator" }),
        }),
      ]),
    );
    await expect(queue.health()).resolves.toMatchObject({
      externalWaits: { pendingHumanDecisions: 0, rejectedDeliveries: 1, capped: false },
    });
  });

  it("uses the PostgreSQL job deadline as the decision timeout", async () => {
    const id = await queue.enqueue("human-timeout", {}, { deadline: new Date(Date.now() + 100) });
    const worker = new Worker(queue, { workerId: "human-timeout-worker" }).handle(
      "human-timeout",
      async (_payload, context) => context.waitForHuman("review", { prompt: "Review?" }),
    );
    expect(await worker.runOnce()).toBe(true);
    await sleep(130);
    await queue.tick();

    await expect(admin.getJob(id)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "DeadlineExceeded" }),
    });
    await expect(
      queue.completeHumanWait(
        id,
        "review",
        { approved: true },
        { idempotencyKey: "after-timeout", requestedBy: "operator" },
      ),
    ).resolves.toMatchObject({ status: "stale" });
  });

  it("fails an unanswered decision at the caller's shorter timeout", async () => {
    const id = await queue.enqueue("human-custom-timeout", {});
    const worker = new Worker(queue, { workerId: "human-custom-timeout-worker" }).handle(
      "human-custom-timeout",
      async (_payload, context) =>
        context.waitForHuman("review", { prompt: "Review?" }, { timeoutMs: 100 }),
    );
    expect(await worker.runOnce()).toBe(true);
    await sleep(130);
    await queue.tick();

    await expect(admin.getJob(id)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "DeadlineExceeded" }),
    });
  });

  it("serializes cancellation against human completion", async () => {
    const id = await queue.enqueue("human-cancel-race", {});
    const worker = new Worker(queue, { workerId: "human-cancel-race-worker" }).handle(
      "human-cancel-race",
      async (_payload, context) => context.waitForHuman("review", { prompt: "Review?" }),
    );
    expect(await worker.runOnce()).toBe(true);

    const [cancellation, completion] = await Promise.all([
      queue.cancel(id, { requestedBy: "operator" }),
      queue.completeHumanWait(
        id,
        "review",
        { approved: true },
        { idempotencyKey: "racing-completion", requestedBy: "reviewer" },
      ),
    ]);
    expect(cancellation.status).toBe("canceled");
    expect(["completed", "stale"]).toContain(completion.status);
    await expect(admin.getJob(id)).resolves.toMatchObject({ state: "canceled" });
  });
});
