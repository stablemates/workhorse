import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { HumanWaitIdempotencyConflictError, Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { queue } = createIntegrationTestContext(import.meta.url);

describe("human waits", () => {
  it("rejects token names the dashboard would normalize to another identity", async () => {
    const id = await queue.enqueue("human-name", {});
    const claimed = await queue.claim("human-name-worker");
    await expect(
      queue.waitForHuman(claimed!, "human-name-worker", " review ", { prompt: "Review?" }),
    ).rejects.toThrow(/leading or trailing whitespace/);
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
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "scheduled" });

    const request = { idempotencyKey: "operator-request-1", completedBy: "operator@example.com" };
    const first = await queue.completeHumanWait(id, "approval", { approved: true }, request);
    expect(first).toMatchObject({
      status: "completed",
      result: { approved: true },
      completedBy: "operator@example.com",
    });
    await expect(
      queue.completeHumanWait(id, "approval", { approved: true }, request),
    ).resolves.toEqual({ ...first, status: "duplicate" });

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({
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
          completedBy: "operator-a",
        },
      ),
      queue.completeHumanWait(
        id,
        "review",
        { choice: "b" },
        {
          idempotencyKey: "choice-b",
          completedBy: "operator-b",
        },
      ),
    ]);
    expect(completions.map(({ status }) => status)).toEqual(
      expect.arrayContaining(["completed", "already_completed"]),
    );
    expect(completions[0]!.result).toEqual(completions[1]!.result);

    const events = (await queue.getJobTimeline(id)).items.filter((item) => item.kind === "event");
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
    const request = { idempotencyKey: "same-key", completedBy: "operator" };
    await queue.completeHumanWait(id, "approval", { approved: true }, request);
    await expect(
      queue.completeHumanWait(id, "approval", { approved: false }, request),
    ).rejects.toBeInstanceOf(HumanWaitIdempotencyConflictError);
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
        { idempotencyKey: "late-completion", completedBy: "late-operator" },
      ),
    ).resolves.toMatchObject({ status: "stale", result: null });

    const events = (await queue.getJobTimeline(id)).items.filter((item) => item.kind === "event");
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

    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "DeadlineExceeded" }),
    });
    await expect(
      queue.completeHumanWait(
        id,
        "review",
        { approved: true },
        { idempotencyKey: "after-timeout", completedBy: "operator" },
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

    await expect(queue.getJob(id)).resolves.toMatchObject({
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
        { idempotencyKey: "racing-completion", completedBy: "reviewer" },
      ),
    ]);
    expect(cancellation.status).toBe("canceled");
    expect(["completed", "stale"]).toContain(completion.status);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "canceled" });
  });
});
