import { MantineProvider } from "@mantine/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardTaskDetail } from "@stablemates/workhorse-dashboard-server/wire";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

/**
 * The task drawer shows a section only when the task has content for it. These tests pin that a
 * task that did not use a feature gets no empty section for it, and that the facts the drawer
 * moved out of sight are still in it.
 */

type Runtime = NonNullable<DashboardTaskDetail["current"]["runtime"]>;
type Outcome = NonNullable<DashboardTaskDetail["current"]["outcome"]>;

function task(
  overrides: {
    identity?: Partial<DashboardTaskDetail["identity"]>;
    runtime?: Partial<Runtime> | null;
    outcome?: Partial<Outcome> | null;
  } & Partial<Omit<DashboardTaskDetail, "identity">> = {},
): DashboardTaskDetail {
  const { identity, runtime = null, outcome = null, ...rest } = overrides;
  return {
    tags: [],
    humanWait: null,
    canCompleteHumanWait: false,
    identity: {
      id: "0f6c2a4e-1111-4222-8333-944455556666",
      queue: "billing",
      type: "invoice.charge",
      priority: 0,
      state: "succeeded",
      createdAt: "2026-10-27T12:00:00.000Z",
      retryPolicy: {
        type: "exponential",
        initialDelayMs: 2_000,
        multiplier: 2,
        maxDelayMs: 30_000,
      },
      maxAttempts: 3,
      deadlineAt: null,
      executionTimeoutMs: null,
      concurrencyKey: null,
      prerequisiteTaskId: null,
      prerequisiteTaskIds: [],
      dependencyPolicy: null,
      dependencyReleasedAt: null,
      blockedReason: null,
      ...identity,
    },
    dependencyLineage: { records: [], truncated: false },
    childLineage: { records: [], truncated: false },
    redriveLineage: { records: [], truncated: false },
    concurrencyPolicy: null,
    signalWait: null,
    canSignal: false,
    payload: { amount: 4900 },
    payloadBytes: 16,
    payloadOmitted: false,
    progress: null,
    durability: null,
    current: {
      runtime:
        runtime === null
          ? null
          : {
              state: "active",
              attempt: 1,
              runAt: "2026-10-27T12:00:00.000Z",
              readyAt: null,
              workerId: "billing-3a41e",
              fenceToken: "42",
              acquiredAt: "2026-10-27T12:00:01.000Z",
              heartbeatAt: null,
              expiresAt: null,
              waitName: null,
              attemptStartedAt: "2026-10-27T12:00:01.000Z",
              cancellation: null,
              error: null,
              ...runtime,
            },
      outcome:
        outcome === null
          ? null
          : {
              state: "succeeded",
              attempt: 1,
              finishedAt: "2026-10-27T12:00:02.000Z",
              result: { charged: 4900 },
              resultBytes: 18,
              resultOmitted: false,
              error: null,
              ...outcome,
            },
      error: null,
    },
    batchExecutions: [],
    attempts: [],
    checkpoints: [],
    waits: [],
    events: [],
    truncated: { attempts: false, checkpoints: false, waits: false, events: false },
    ...rest,
  } as DashboardTaskDetail;
}

function render(element: ReactElement): string {
  return renderToStaticMarkup(createElement(MantineProvider, null, element)).replace(
    /<style[^>]*>[\s\S]*?<\/style>/g,
    "",
  );
}

const failedAttempt = {
  attempt: 1,
  workerId: "api-7f9c2",
  outcome: "retry",
  startedAt: "2026-10-27T12:00:01.000Z",
  claimedAt: "2026-10-27T12:00:01.000Z",
  finishedAt: "2026-10-27T12:00:02.000Z",
  durationMs: 900,
  executionMs: 893,
  elapsedMs: 900,
  error: { name: "Error", message: "HTTP 410 Gone" },
};

describe("task drawer header", () => {
  it("names the wait a task is in, in the words the task list uses", async () => {
    const { taskDisplayStatus } = await import("./components/task-detail-summary.js");
    expect(taskDisplayStatus(task({ identity: { state: "failed" } }))).toMatchObject({
      text: "Failed",
      label: "Status: failed",
    });
    expect(
      taskDisplayStatus(
        task({
          identity: { state: "scheduled" },
          humanWait: { name: "approve-refund", context: null, deadlineAt: "2026-10-28T00:00:00Z" },
        }),
      ),
    ).toMatchObject({
      text: "Waiting for decision",
      label: "Waiting for decision: approve-refund",
    });
    expect(
      taskDisplayStatus(
        task({
          identity: { state: "scheduled" },
          runtime: { state: "scheduled", waitName: "cool" },
        }),
      ).text,
    ).toBe("Durable wait");
  });

  it("shows the state, the copyable id, the queue, and the actions slot", async () => {
    const { TaskDetailHeader } = await import("./components/task-detail-summary.js");
    const html = render(
      createElement(TaskDetailHeader, {
        task: task(),
        heading: createElement("h3", null, "invoice.charge"),
        actions: createElement("button", { type: "button" }, "Actions"),
      }),
    );
    expect(html).toContain("Status: succeeded");
    expect(html).toContain('title="0f6c2a4e-1111-4222-8333-944455556666"');
    expect(html).toContain(">0f6c2a4e<");
    expect(html).toContain('aria-label="Copy task id"');
    expect(html).toContain("billing");
    expect(html).toContain(">Actions<");
    expect(html).not.toContain("mantine-Badge-root");
  });
});

/** The drawer links of a dashboard mounted at `/workhorse`. */
const pageNavigation = {
  href: (path: string) => `/workhorse${path}`,
  followLink: () => undefined,
};

describe("task drawer properties", () => {
  it("names the attempt the table shows, and marks it when it has not started", async () => {
    const { TaskProperties } = await import("./components/task-detail-summary.js");
    const html = render(
      createElement(TaskProperties, {
        navigation: pageNavigation,
        task: task({
          identity: { state: "blocked", maxAttempts: 25 },
          runtime: { state: "blocked", attempt: 1, attemptStartedAt: null, workerId: null },
        }),
      }),
    );
    expect(html).toContain(">1 of 25<");
    expect(html).toContain("not started");
    expect(html).toContain("0 of 25 attempts used");
  });

  it("does not mark an attempt that runs now", async () => {
    const { TaskProperties } = await import("./components/task-detail-summary.js");
    const html = render(
      createElement(TaskProperties, {
        task: task({ identity: { state: "active" }, runtime: { state: "active", attempt: 2 } }),
      }),
    );
    expect(html).toContain(">2 of 3<");
    expect(html).not.toContain("not started");
  });

  it("marks the attempt of a task canceled before its first claim as not started", async () => {
    const { TaskProperties } = await import("./components/task-detail-summary.js");
    const html = render(
      createElement(TaskProperties, {
        navigation: pageNavigation,
        task: task({
          identity: { state: "canceled", maxAttempts: 25 },
          outcome: { state: "canceled", attempt: 1, result: null },
          events: [{ id: "0", attempt: null, type: "enqueued", details: {}, occurredAt: "x" }],
        }),
      }),
    );
    expect(html).toContain(">1 of 25<");
    expect(html).toContain("not started");
    expect(html).toContain("0 of 25 attempts used");
  });

  it("shows tags as a list and leaves out rows the task has no value for", async () => {
    const { TaskProperties } = await import("./components/task-detail-summary.js");
    const html = render(
      createElement(TaskProperties, {
        navigation: pageNavigation,
        task: task({ tags: ["plan:free", "region:eu"], outcome: {} }),
      }),
    );
    expect(html).toContain("<li>plan:free</li>");
    expect(html).toContain("Finished");
    expect(html).not.toContain("Worker");
    expect(html).not.toContain("Decision");
  });

  it("links a member task to its task group and shows the position and the group state", async () => {
    const { TaskProperties } = await import("./components/task-detail-summary.js");
    const groupId = "019a2b3c-4d5e-7f60-8a71-b2c3d4e5f607";
    const html = render(
      createElement(TaskProperties, {
        navigation: pageNavigation,
        task: task({ group: { id: groupId, position: 1204, state: "sealed" } }),
      }),
    );
    expect(html).toContain(">Group<");
    expect(html).toContain(`href="/workhorse/groups?group=${groupId}"`);
    expect(html).toContain(`title="${groupId}"`);
    expect(html).toContain('aria-label="Task group 019a2b3c"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^]*?<\/svg>019a2b3c<\/a>/);
    expect(html).toContain("member 1,204 · sealed");
  });

  it("shows no group row for a task that is not a member", async () => {
    const { TaskProperties } = await import("./components/task-detail-summary.js");
    const notMember = render(
      createElement(TaskProperties, { navigation: pageNavigation, task: task({ group: null }) }),
    );
    // A database below schema 90 returns no group key at all.
    const olderSchema = render(
      createElement(TaskProperties, { navigation: pageNavigation, task: task() }),
    );
    for (const html of [notMember, olderSchema]) {
      expect(html).not.toContain(">Group<");
      expect(html).not.toContain("/groups");
    }
  });
});

describe("task drawer sections", () => {
  it("omits progress and interim results that the task never reported", async () => {
    const { TaskProgress, TaskCheckpoints } = await import("./components/task-detail-overview.js");
    expect(render(createElement(TaskProgress, { task: task() }))).toBe("");
    expect(render(createElement(TaskCheckpoints, { task: task() }))).toBe("");
  });

  it("omits the outcome of a task that has not finished and has no attempt error", async () => {
    const { TaskOutcome } = await import("./components/task-detail-overview.js");
    const html = render(
      createElement(TaskOutcome, { task: task({ identity: { state: "active" }, runtime: {} }) }),
    );
    expect(html).toBe("");
  });

  it("titles a terminal error as an error and keeps its explanation behind help", async () => {
    const { TaskOutcome } = await import("./components/task-detail-overview.js");
    const html = render(
      createElement(TaskOutcome, {
        task: task({
          identity: { state: "failed" },
          outcome: { state: "failed", result: null, error: { message: "HTTP 410 Gone" } },
        }),
      }),
    );
    expect(html).toContain(">Error</h3>");
    expect(html).toContain("HTTP 410 Gone");
    expect(html).toContain('data-tone="error"');
    expect(html).toContain("The task used every attempt and failed");
    expect(html).not.toContain("mantine-Badge-root");
  });

  it("lists each attempt with its outcome and the message of its error", async () => {
    const { TaskAttempts } = await import("./components/task-detail-summary.js");
    const html = render(
      createElement(TaskAttempts, {
        task: task({
          attempts: [
            failedAttempt,
            { ...failedAttempt, attempt: 2, outcome: "succeeded", error: null },
          ],
        }),
      }),
    );
    expect(html).toContain("Attempt 1");
    expect(html).toContain("Retried");
    expect(html).toContain("Status: retry");
    expect(html).toContain("HTTP 410 Gone");
    expect(html).toContain("Details and error");
    expect(html).toContain("Logical start");
    expect(html).toContain("Final claim");
    expect(html).toContain("Attempt 2");
    expect(html).toContain("Status: succeeded");
  });

  it("shows the attempt that runs now, and nothing for a task with no attempt", async () => {
    const { TaskAttempts } = await import("./components/task-detail-summary.js");
    const running = render(
      createElement(TaskAttempts, { task: task({ identity: { state: "active" }, runtime: {} }) }),
    );
    expect(running).toContain("Running");
    expect(running).toContain("billing-3a41e");
    expect(render(createElement(TaskAttempts, { task: task() }))).toBe("");
  });

  it("keeps the retry policy and time limits in the closed policy disclosure", async () => {
    const { TaskExecutionPolicy } = await import("./components/task-detail-summary.js");
    const html = render(createElement(TaskExecutionPolicy, { task: task() }));
    expect(html).toMatch(/^<details/);
    expect(html).not.toMatch(/^<details[^>]*open/);
    expect(html).toContain("Exponential retry · no time limits");
    expect(html).toContain("Retry policy");
    expect(html).toContain("None set");
  });
});

describe("attempts used", () => {
  it("counts from the runtime, so a capped or empty history does not change the total", async () => {
    const { attemptsUsed } = await import("./components/task-detail-summary.js");
    // The 12th attempt runs, and task detail carries only the newest attempts.
    expect(attemptsUsed(task({ runtime: { attempt: 12 }, attempts: [] }))).toBe(12);
    // A retry raised the attempt to 12 before its claim, so 11 attempts are used.
    const waiting = { state: "scheduled", attempt: 12, attemptStartedAt: null, workerId: null };
    expect(attemptsUsed(task({ runtime: waiting }))).toBe(11);
    // A durable wait inside an attempt still counts that attempt.
    const sleeping = { state: "scheduled", attempt: 2, waitName: "nap", workerId: null };
    expect(attemptsUsed(task({ runtime: sleeping }))).toBe(2);
    // A new task waits for its first claim.
    const fresh = { state: "ready", attempt: 1, attemptStartedAt: null, workerId: null };
    expect(attemptsUsed(task({ runtime: fresh }))).toBe(0);
  });

  it("counts from the outcome, and a task canceled before its claim used none", async () => {
    const { attemptsUsed, TaskProperties } = await import("./components/task-detail-summary.js");
    // A fast-tier task can finish with no recorded attempt.
    expect(attemptsUsed(task({ outcome: { attempt: 2 }, attempts: [] }))).toBe(2);
    const canceled = { state: "canceled", attempt: 1 };
    const claimed = { id: "1", attempt: 1, type: "claimed", details: {}, occurredAt: "x" };
    expect(attemptsUsed(task({ outcome: canceled, events: [claimed] }))).toBe(1);
    // The kept enqueue event shows that the history is present and holds no claim.
    const enqueued = { id: "0", attempt: null, type: "enqueued", details: {}, occurredAt: "x" };
    const neverClaimed = task({ outcome: canceled, events: [enqueued] });
    expect(attemptsUsed(neverClaimed)).toBe(0);
    const html = render(
      createElement(TaskProperties, { task: neverClaimed, navigation: pageNavigation }),
    );
    expect(html).toContain("not started");
  });

  it("does not count a retry that a cancel during its backoff stopped", async () => {
    const { attemptsUsed, TaskProperties } = await import("./components/task-detail-summary.js");
    // Attempt 1 fails. The operator cancels during the backoff, so attempt 2 never starts.
    const claimed = { id: "1", attempt: 1, type: "claimed", details: {}, occurredAt: "x" };
    const canceled = task({
      outcome: { state: "canceled", attempt: 2 },
      attempts: [failedAttempt],
      events: [claimed],
    });
    expect(attemptsUsed(canceled)).toBe(1);
    const html = render(
      createElement(TaskProperties, { task: canceled, navigation: pageNavigation }),
    );
    expect(html).toContain("not started");
    expect(html).toContain("1 of 3 attempts used");
    // A cancel while attempt 2 ran counts attempt 2.
    const running = { ...claimed, id: "2", attempt: 2 };
    const canceledWhileRunning = task({
      outcome: { state: "canceled", attempt: 2 },
      attempts: [failedAttempt],
      events: [claimed, running],
    });
    expect(attemptsUsed(canceledWhileRunning)).toBe(2);
    expect(
      render(
        createElement(TaskProperties, { task: canceledWhileRunning, navigation: pageNavigation }),
      ),
    ).not.toContain("not started");
    // The attempt row of a canceled attempt 2 is also evidence, with no claimed event.
    const closedByCancel = task({
      outcome: { state: "canceled", attempt: 2 },
      attempts: [failedAttempt, { ...failedAttempt, attempt: 2, outcome: "canceled" }],
    });
    expect(attemptsUsed(closedByCancel)).toBe(2);
  });

  it("reports the count as unknown when retention removed the history of the task", async () => {
    const { attemptsUsed, TaskProperties } = await import("./components/task-detail-summary.js");
    const unknown = "The attempt history is no longer kept";
    // Attempt 1 fails, the operator cancels during the backoff, and retention removes all history.
    // A cancel during attempt 2 leaves the same rows, so the count is not known.
    const cleaned = task({ outcome: { state: "canceled", attempt: 2 }, attempts: [], events: [] });
    expect(attemptsUsed(cleaned)).toBeNull();
    const html = render(
      createElement(TaskProperties, { task: cleaned, navigation: pageNavigation }),
    );
    expect(html).toContain("2 of 3");
    expect(html).not.toContain("not started");
    expect(html).toContain(unknown);
    // The operator cancels attempt 1 while it runs, and retention removes all history.
    const canceledFirst = task({ outcome: { state: "canceled", attempt: 1 } });
    expect(attemptsUsed(canceledFirst)).toBeNull();
    const first = render(
      createElement(TaskProperties, { task: canceledFirst, navigation: pageNavigation }),
    );
    expect(first).toContain("1 of 3");
    expect(first).not.toContain("not started");
    expect(first).toContain(unknown);
    // A truncated section holds only its newest rows, so it cannot prove that attempt 2 did not run.
    const claimed = { id: "1", attempt: 1, type: "claimed", details: {}, occurredAt: "x" };
    const truncated = task({
      outcome: { state: "canceled", attempt: 2 },
      attempts: [failedAttempt],
      events: [claimed],
      truncated: { attempts: true, checkpoints: false, waits: false, events: true },
    });
    expect(attemptsUsed(truncated)).toBeNull();
    // A truncated events section cannot prove that attempt 1 had no claim.
    const enqueued = { id: "0", attempt: null, type: "enqueued", details: {}, occurredAt: "x" };
    const truncatedFirst = task({
      outcome: { state: "canceled", attempt: 1 },
      events: [enqueued],
      truncated: { attempts: false, checkpoints: false, waits: false, events: true },
    });
    expect(attemptsUsed(truncatedFirst)).toBeNull();
  });
});
