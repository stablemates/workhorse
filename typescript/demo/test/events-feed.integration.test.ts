/**
 * The dashboard events feed, and the waits and dependencies whose history it shows.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import { createLocalOperator, DEMO_HUMAN_WAIT_NAME, DEMO_SIGNAL_NAME } from "../src/app.js";
import { demoFeatureShowcaseFamily } from "../src/feature-showcase.js";
import { createDemoIntegrationSuite } from "./support/demo-integration.js";

const {
  createTestApplication,
  dashboardClient,
  database,
  enqueueDemoTest,
  pool,
  showcaseTestPayload,
  taskResult,
  waitFor,
  waitForTaskState,
} = createDemoIntegrationSuite(import.meta.url);

/**
 * The events feed is the only dashboard surface that reads the append-only history directly, and
 * the only one whose correctness question is "does it show what actually happened". These tests run
 * real work through a real worker and then assert the feed against it, rather than against fixtures.
 */
describe("Workhorse dashboard events feed", () => {
  it("merges lifecycle events and closed attempts for work a worker really ran", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const { taskId } = await enqueueDemoTest("success");
      const page = await waitFor(
        () => client.dashboard.events({ window: "1h", pageSize: 100 }),
        (value) =>
          value.events.some(
            (event) =>
              event.taskId === taskId && event.kind === "attempt" && event.type === "succeeded",
          ),
      );

      const rows = page.events.filter((event) => event.taskId === taskId);
      // Both history tables reach the same feed, and the row says which one it came from.
      expect(rows.map((event) => `${event.kind}:${event.type}`)).toEqual(
        expect.arrayContaining(["event:enqueued", "attempt:succeeded"]),
      );
      // The task identity is joined in, so a feed row names the task rather than only its uuid.
      for (const row of rows) {
        expect(row.queue).toBe("demo");
        expect(row.taskType).toMatch(/^demo\./);
      }
      const attempt = rows.find((event) => event.kind === "attempt")!;
      expect(attempt.workerId).toEqual(expect.any(String));
      expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
      expect(attempt.attempt).toBe(1);
      // Drawer links address the history record itself, so they remain valid after a moving feed
      // pushes the row onto another page.
      const detail = await client.dashboard.eventDetail({ id: attempt.id });
      expect(detail).toMatchObject(attempt);
      expect(detail.startedAt).toEqual(expect.any(String));
      expect(detail.claimedAt).toEqual(expect.any(String));
      expect(detail.finishedAt).toEqual(expect.any(String));

      // Newest first, with lifecycle and attempt rows interleaved by time rather than by table.
      const timestamps = page.events.map((event) => Date.parse(event.occurredAt));
      expect(
        timestamps.every((value, index) => index === 0 || timestamps[index - 1]! >= value),
      ).toBe(true);
    } finally {
      await workhorse.stop();
    }
  });

  it("filters by source table, event type, and the queue the task belongs to", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const { taskId } = await enqueueDemoTest("success");
      await waitFor(
        () => client.dashboard.events({ window: "1h", pageSize: 100, kind: "attempt" }),
        (value) => value.events.some((event) => event.taskId === taskId),
      );

      const attempts = await client.dashboard.events({
        window: "1h",
        pageSize: 100,
        kind: "attempt",
      });
      expect(attempts.events.length).toBeGreaterThan(0);
      expect(attempts.events.every((event) => event.kind === "attempt")).toBe(true);

      const enqueues = await client.dashboard.events({
        window: "1h",
        pageSize: 100,
        types: ["enqueued"],
      });
      expect(enqueues.events.length).toBeGreaterThan(0);
      expect(enqueues.events.every((event) => event.type === "enqueued")).toBe(true);

      // Queue and task filters are matched through the task the history row points at.
      expect(
        (await client.dashboard.events({ window: "1h", pageSize: 100, queue: "demo" })).events
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await client.dashboard.events({ window: "1h", pageSize: 100, queue: "not-a-queue" }))
          .events,
      ).toEqual([]);
      expect(
        (await client.dashboard.events({ window: "1h", pageSize: 100, taskId })).events.every(
          (event) => event.taskId === taskId,
        ),
      ).toBe(true);
    } finally {
      await workhorse.stop();
    }
  });

  it("loads complete structured attempt errors for the event drawer", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const { taskId } = await enqueueDemoTest("retry");
      const page = await waitFor(
        () => client.dashboard.events({ window: "1h", pageSize: 100, taskId }),
        (value) =>
          value.events.some((event) => event.kind === "attempt" && event.errorMessage !== null),
      );
      const attempt = page.events.find(
        (event) => event.kind === "attempt" && event.errorMessage !== null,
      )!;
      const detail = await client.dashboard.eventDetail({ id: attempt.id });
      expect(detail.error).not.toBeNull();
      expect(detail.errorMessage).toBe(attempt.errorMessage);
      expect(detail.startedAt).toEqual(expect.any(String));
      expect(detail.claimedAt).toEqual(expect.any(String));
      expect(detail.finishedAt).toEqual(expect.any(String));
    } finally {
      await workhorse.stop();
    }
  });

  it("pages through a busy window and reports retention depth", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      // Enough work that the window certainly holds more than one page, so the paging assertions
      // below are about the feed rather than about how fast the fleet drained.
      for (let index = 0; index < 20; index += 1) await enqueueDemoTest("success");
      await waitFor(
        () => client.dashboard.events({ window: "1h", pageSize: 100, count: "exact" }),
        (value) => value.total > 50,
      );
      // Stop writing before comparing two pages: fresh rows arriving between the reads shift every
      // offset behind them, which would show up as an overlap that has nothing to do with paging.
      await workhorse.stop();

      const first = await client.dashboard.events({ window: "1h", pageSize: 25, page: 1 });
      const second = await client.dashboard.events({ window: "1h", pageSize: 25, page: 2 });
      expect(first.page).toBe(1);
      expect(second.page).toBe(2);
      expect(first.events).toHaveLength(25);
      expect(second.events).toHaveLength(25);
      // Each page reports the rows it read plus the one that shows another page exists.
      expect(first).toMatchObject({ total: 26, hasMore: true });
      expect(second).toMatchObject({ total: 51, hasMore: true });
      // A later page continues the ordering rather than repeating what the page above it showed.
      const shown = new Set(first.events.map((event) => event.id));
      expect(second.events.filter((event) => shown.has(event.id))).toEqual([]);
      expect(second.events[0]!.occurredAt <= first.events.at(-1)!.occurredAt).toBe(true);

      const full = await client.dashboard.events({ window: "1h", pageSize: 100, count: "exact" });
      expect(full.total).toBeGreaterThan(50);
      expect(full.windowSeconds).toBe(3_600);
      // Depth is bounded by retention, so the page carries the policy rather than leaving an
      // operator to infer it from a feed that simply stops.
      const policy = await pool.query<{ days: number | null }>(
        "SELECT task_event_retention_days AS days FROM workhorse.retention_policy WHERE singleton",
      );
      expect(full.retention.taskEventDays).toBe(policy.rows[0]?.days ?? null);
    } finally {
      await workhorse.stop();
    }
  });

  it("excludes work that finished before the requested window", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const { taskId } = await enqueueDemoTest("success");
      await waitFor(
        () => client.dashboard.events({ window: "15m", pageSize: 100, taskId }),
        (value) => value.events.some((event) => event.kind === "attempt"),
      );
      // Stop the fleet before rewriting history: a worker still claiming work would write fresh
      // rows for this task after the aging update and the window assertion would race it.
      await workhorse.stop();

      // Age the history past the shortest window without touching the clock the queue runs on.
      await pool.query(
        "UPDATE workhorse.task_event SET occurred_at = occurred_at - interval '20 minutes' WHERE task_id = $1",
        [taskId],
      );
      await pool.query(
        "UPDATE workhorse.attempt_history SET occurred_at = occurred_at - interval '20 minutes' WHERE task_id = $1",
        [taskId],
      );

      expect(
        (await client.dashboard.events({ window: "15m", pageSize: 100, taskId })).events,
      ).toEqual([]);
      expect(
        (await client.dashboard.events({ window: "1h", pageSize: 100, taskId })).events.length,
      ).toBeGreaterThan(0);
    } finally {
      await workhorse.stop();
    }
  });

  it("releases and cancels dependents according to their prerequisite outcomes", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("task-dependencies");

    const releasedPrerequisite = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("task-dependencies", "test-release", "success", { role: "prerequisite" }),
      { maxAttempts: 1 },
    );
    const releasedDependent = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("task-dependencies", "test-release", "success", { role: "dependent" }),
      {
        maxAttempts: 1,
        dependencies: {
          prerequisiteTaskIds: [releasedPrerequisite],
          onSuccess: "release",
          onFailure: "fail",
          onCancellation: "cancel",
        },
      },
    );
    const failingPrerequisite = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("task-dependencies", "test-cancel", "always-fail", {
        role: "prerequisite",
      }),
      { maxAttempts: 1 },
    );
    const canceledDependent = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("task-dependencies", "test-cancel", "success", { role: "dependent" }),
      {
        maxAttempts: 1,
        dependencies: {
          prerequisiteTaskIds: [failingPrerequisite],
          onSuccess: "release",
          onFailure: "cancel",
          onCancellation: "cancel",
        },
      },
    );
    workhorse.start();

    try {
      await waitForTaskState(workhorse.context.admin, releasedDependent, "succeeded");
      await waitForTaskState(workhorse.context.admin, canceledDependent, "canceled");
      const lineage = await workhorse.context.admin.getDependencyLineage(releasedDependent);
      expect(lineage.records).toMatchObject([
        {
          dependentTaskId: releasedDependent,
          prerequisiteTaskId: releasedPrerequisite,
          resolution: "release",
        },
      ]);
    } finally {
      await workhorse.stop();
    }
  });

  it("joins named children and retains their results for the suspended parent", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("child-workflows");

    const parentTaskId = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("child-workflows", "test-fan-out", "fan-out-join", { childCount: 2 }),
      { maxAttempts: 1 },
    );
    workhorse.start();

    try {
      await waitForTaskState(workhorse.context.admin, parentTaskId, "succeeded");
      expect(await taskResult(parentTaskId)).toMatchObject({
        scenario: "test-fan-out",
        childCount: 2,
        children: {
          "shard-1": {
            status: "succeeded",
            result: { step: "shard-1", completedOnAttempt: 1 },
          },
          "shard-2": {
            status: "succeeded",
            result: { step: "shard-2", completedOnAttempt: 1 },
          },
        },
      });
      const lineage = await workhorse.context.admin.getChildLineage(parentTaskId);
      expect(lineage.records).toHaveLength(2);
      expect(lineage.records.every((record) => record.outcomeState === "succeeded")).toBe(true);
    } finally {
      await workhorse.stop();
    }
  });

  it("resumes a signal wait when its companion sender task delivers", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("signals");

    const waiterTaskId = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("signals", "test-handoff", "signal-handoff", {
        waitTimeoutMs: 60_000,
      }),
      { maxAttempts: 1 },
    );
    workhorse.start();

    try {
      await waitForTaskState(workhorse.context.admin, waiterTaskId, "succeeded");
      expect(await taskResult(waiterTaskId)).toMatchObject({
        scenario: "test-handoff",
        behavior: "signal-handoff",
        signal: { scenario: "test-handoff", sentBy: "showcase-sender" },
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("lists a pending operator signal wait and resumes it on delivery", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("signals");

    const waiterTaskId = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("signals", "test-operator", "signal-operator", {
        waitTimeoutMs: 60_000,
      }),
      { maxAttempts: 1 },
    );
    workhorse.start();

    try {
      await waitFor(
        () => workhorse.context.admin.listSignalWaits(),
        (page) => page.items.some((wait) => wait.taskId === waiterTaskId),
        1_600,
      );
      const delivery = await queue.sendSignal(
        waiterTaskId,
        DEMO_SIGNAL_NAME,
        { approved: true },
        { idempotencyKey: "test-operator-signal", requestedBy: "integration-test" },
      );
      expect(delivery.status).toBe("delivered");
      await waitForTaskState(workhorse.context.admin, waiterTaskId, "succeeded");
      expect(await taskResult(waiterTaskId)).toMatchObject({ signal: { approved: true } });
    } finally {
      await workhorse.stop();
    }
  });

  it("completes a pending human decision and resumes the suspended handler", async () => {
    const { app, workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("human-decisions");

    const taskId = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("human-decisions", "test-approval", "human-pending", {
        waitTimeoutMs: 60_000,
      }),
      { maxAttempts: 1 },
    );
    workhorse.start();

    try {
      const pending = await waitFor(
        () => workhorse.context.admin.listHumanWaits(),
        (page) => page.items.some((wait) => wait.taskId === taskId),
        1_600,
      );
      expect(pending.items.find((wait) => wait.taskId === taskId)).toMatchObject({
        name: DEMO_HUMAN_WAIT_NAME,
        context: {
          scenario: "test-approval",
          dashboard: {
            quickAction: { label: "Approve", result: { approved: true } },
          },
        },
      });
      const waiting = await dashboardClient(app).dashboard.tasks({
        filter: "waiting",
        page: 1,
        pageSize: 25,
      });
      expect(waiting).toMatchObject({
        filter: "waiting",
        total: 1,
        tasks: [{ id: taskId, state: "scheduled", waitName: DEMO_HUMAN_WAIT_NAME }],
      });
      const completion = await queue.completeHumanWait(
        taskId,
        DEMO_HUMAN_WAIT_NAME,
        { approved: true, note: "looks good" },
        { idempotencyKey: "test-human-decision", requestedBy: "integration-test" },
      );
      expect(completion.status).toBe("completed");
      await waitForTaskState(workhorse.context.admin, taskId, "succeeded");
      expect(await taskResult(taskId)).toMatchObject({
        scenario: "test-approval",
        decision: { approved: true, note: "looks good" },
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("settles batch digest members independently within one invocation", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("batch-handlers");

    const [succeedingTaskId, failingTaskId] = await queue.enqueueMany([
      {
        type: family.taskType,
        payload: showcaseTestPayload("batch-handlers", "test-batch", "batch-member", {
          memberIndex: 1,
        }),
        options: { maxAttempts: 1 },
      },
      {
        type: family.taskType,
        payload: showcaseTestPayload("batch-handlers", "test-batch", "batch-member", {
          memberIndex: 2,
          shouldFail: true,
        }),
        options: { maxAttempts: 1 },
      },
    ]);

    workhorse.start();
    try {
      await waitForTaskState(workhorse.context.admin, succeedingTaskId!, "succeeded");
      await waitForTaskState(workhorse.context.admin, failingTaskId!, "failed");
      expect(await taskResult(succeedingTaskId!)).toMatchObject({
        scenario: "test-batch",
        memberIndex: 1,
        digestId: expect.any(String),
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("captures the contract version, rejects an invalid result, and reports a payload refusal", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("payload-contracts");

    const acceptedTaskId = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("payload-contracts", "test-accepted", "contract-valid", {
        invoiceId: "INV-test-accepted",
      }),
      { maxAttempts: 1 },
    );
    const rejectedResultTaskId = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("payload-contracts", "test-rejected", "contract-result-invalid", {
        invoiceId: "INV-test-rejected",
      }),
      { maxAttempts: 1 },
    );
    const probeTaskId = await queue.enqueue(
      family.taskType,
      showcaseTestPayload("payload-contracts", "test-probe", "contract-payload-probe", {
        invoiceId: "INV-test-probe",
      }),
      { maxAttempts: 1 },
    );
    await expect(
      queue.enqueue(
        family.taskType,
        showcaseTestPayload("payload-contracts", "test-refused", "contract-valid"),
      ),
    ).rejects.toThrow(/contract/i);

    workhorse.start();
    try {
      await waitForTaskState(workhorse.context.admin, acceptedTaskId, "succeeded");
      expect(await taskResult(acceptedTaskId)).toMatchObject({
        approved: true,
        invoiceId: "INV-test-accepted",
        contractVersion: "v1",
      });
      await waitForTaskState(workhorse.context.admin, rejectedResultTaskId, "failed");
      const failure = await pool.query<{ message: string }>(
        "SELECT error->>'message' AS message FROM workhorse.task_outcome WHERE task_id = $1",
        [rejectedResultTaskId],
      );
      expect(failure.rows[0]!.message).toMatch(/contract/i);
      await waitForTaskState(workhorse.context.admin, probeTaskId, "succeeded");
      expect(await taskResult(probeTaskId)).toMatchObject({
        approved: true,
        probedRejection: { name: "TaskContractValidationError" },
      });
    } finally {
      await workhorse.stop();
    }
  });
});
