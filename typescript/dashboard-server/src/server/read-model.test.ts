import { describe, expect, it, vi } from "vitest";
import type { DashboardEventDetail, DashboardEventsPage, DashboardTaskDetail } from "../wire.js";
import {
  readDashboardEventDetail,
  readDashboardEvents,
  readDashboardHumanWaits,
  readDashboardQueues,
  readDashboardSettings,
  readDashboardSystem,
  readDashboardTaskDetail,
  readDashboardTaskValue,
  redactDashboardTaskDetailErrorStacks,
} from "./read-model.js";
import type { DashboardDatabase, DashboardSql } from "./sql.js";

describe("dashboard task-detail error redaction", () => {
  it("removes stacks from every worker error surface without changing user data", () => {
    const error = { name: "Error", message: "failed", stack: "/app/worker.ts:42" };
    const detail = {
      childLineage: { records: [{ error }], truncated: false },
      current: {
        runtime: { error },
        outcome: { error, result: { stack: "user result" } },
        error,
      },
      batchExecutions: [{ members: [{ error }] }],
      attempts: [{ error }],
      payload: { stack: "user payload" },
      events: [
        { type: "retry_scheduled", details: { error, delay_ms: 1000, stack: "event key" } },
        { type: "failed", details: { error } },
        { type: "timeout", details: { fence_token: "7", error } },
        { type: "enqueued", details: { tier: "fast" } },
      ],
    } as unknown as DashboardTaskDetail;

    const redacted = redactDashboardTaskDetailErrorStacks(detail);

    expect(redacted.childLineage.records[0]?.error).toEqual({ name: "Error", message: "failed" });
    expect(redacted.current.runtime?.error).toEqual({ name: "Error", message: "failed" });
    expect(redacted.current.outcome?.error).toEqual({ name: "Error", message: "failed" });
    expect(redacted.current.error).toEqual({ name: "Error", message: "failed" });
    expect(redacted.batchExecutions[0]?.members[0]?.error).toEqual({
      name: "Error",
      message: "failed",
    });
    expect(redacted.attempts[0]?.error).toEqual({ name: "Error", message: "failed" });
    expect(redacted.payload).toEqual({ stack: "user payload" });
    expect(redacted.current.outcome?.result).toEqual({ stack: "user result" });
    // Workhorse copies the worker error into the details of the lifecycle event that records
    // the failure, so a host that withholds the attempt's stack has to withhold this copy too.
    expect(redacted.events).toEqual([
      {
        type: "retry_scheduled",
        details: {
          error: { name: "Error", message: "failed" },
          delay_ms: 1000,
          stack: "event key",
        },
      },
      { type: "failed", details: { error: { name: "Error", message: "failed" } } },
      {
        type: "timeout",
        details: { fence_token: "7", error: { name: "Error", message: "failed" } },
      },
      { type: "enqueued", details: { tier: "fast" } },
    ]);
  });
});

describe("dashboard event feed error redaction", () => {
  const error = { name: "Error", message: "failed", stack: "/app/dist/worker.js:42" };

  function database(): DashboardDatabase {
    return {
      execute: vi.fn<() => Promise<{ rows: { result: DashboardEventsPage }[] }>>(async () => ({
        rows: [
          {
            result: {
              events: [
                { kind: "event", type: "failed", details: { error } },
                { kind: "event", type: "retry_scheduled", details: { error, attempt: 1 } },
                { kind: "attempt", type: "failed", details: null },
              ],
            } as unknown as DashboardEventsPage,
          },
        ],
      })),
    } as unknown as DashboardDatabase;
  }

  it("withholds the worker stack a failure event copies when the host redacts", async () => {
    const page = await readDashboardEvents(database(), {}, true);

    expect(page.events).toEqual([
      { kind: "event", type: "failed", details: { error: { name: "Error", message: "failed" } } },
      {
        kind: "event",
        type: "retry_scheduled",
        details: { error: { name: "Error", message: "failed" }, attempt: 1 },
      },
      { kind: "attempt", type: "failed", details: null },
    ]);
  });

  it("returns every event's details as stored when the host does not redact", async () => {
    const page = await readDashboardEvents(database());

    expect(page.events[0]?.details).toEqual({ error });
    expect(page.events[1]?.details).toEqual({ error, attempt: 1 });
  });
});

describe("dashboard event-detail error redaction", () => {
  const attemptError = { name: "Error", message: "failed", stack: "/app/dist/worker.js:42" };

  function database(
    result: Partial<DashboardEventDetail> = { kind: "attempt", error: attemptError, details: null },
  ): DashboardDatabase {
    return {
      execute: vi.fn<() => Promise<{ rows: { result: DashboardEventDetail }[] }>>(async () => ({
        rows: [{ result: result as DashboardEventDetail }],
      })),
    } as unknown as DashboardDatabase;
  }

  it("withholds the persisted attempt stack a redacting host withholds from task detail", async () => {
    const detail = await readDashboardEventDetail(database(), "attempt:id", true);

    expect(detail?.error).toEqual({ name: "Error", message: "failed" });
  });

  it("returns the whole persisted error when the host does not redact", async () => {
    const detail = await readDashboardEventDetail(database(), "attempt:id");

    expect(detail?.error).toEqual(attemptError);
  });

  it("withholds the worker stack a lifecycle event's details copy when the host redacts", async () => {
    const event = { kind: "event", type: "failed", error: null } as const;

    const redacted = await readDashboardEventDetail(
      database({ ...event, details: { error: attemptError } }),
      "event:id",
      true,
    );
    const revealed = await readDashboardEventDetail(
      database({ ...event, details: { error: attemptError } }),
      "event:id",
    );

    expect(redacted?.details).toEqual({ error: { name: "Error", message: "failed" } });
    expect(revealed?.details).toEqual({ error: attemptError });
  });
});

function capturingDatabase(): { database: DashboardDatabase; inputs: () => unknown[] } {
  const execute = vi.fn<(query: DashboardSql) => Promise<{ rows: { result: unknown }[] }>>(
    async () => ({ rows: [{ result: null }] }),
  );
  return {
    database: { execute } as unknown as DashboardDatabase,
    inputs: () =>
      execute.mock.calls.map(([query]) => JSON.parse(query.values[0] as string) as unknown),
  };
}

describe("dashboard task value reads", () => {
  it("names the task and the kind the procedure is asked for", async () => {
    const { database: db, inputs } = capturingDatabase();

    await readDashboardTaskValue(db, "task-1", "result");

    expect(inputs()).toEqual([{ id: "task-1", kind: "result" }]);
  });
});

describe("dashboard health pass-through", () => {
  const health = { level: "healthy", pending_human_waits: 42 };

  it("hands the health document the reader returns to the human waits procedure", async () => {
    const { database: db, inputs } = capturingDatabase();

    await readDashboardHumanWaits(db, {} as never, true, false, async () => health);

    expect(inputs()).toEqual([{ canComplete: true, canSignal: false, health }]);
  });

  it("hands the same document to the task detail procedure", async () => {
    const { database: db, inputs } = capturingDatabase();

    await readDashboardTaskDetail(db, "task-1", undefined, undefined, true, async () => health);

    expect(inputs()).toEqual([
      { id: "task-1", canSignal: true, canCompleteHumanWait: false, health },
    ]);
  });

  it("hands the same document to the queues procedure", async () => {
    const { database: db, inputs } = capturingDatabase();

    await readDashboardQueues(db, async () => health);

    expect(inputs()).toEqual([{ health }]);
  });

  it("hands the same document to the settings procedure", async () => {
    const { database: db, inputs } = capturingDatabase();

    await readDashboardSettings(db, true, false, async () => health);

    expect(inputs()).toEqual([{ writable: true, settingsController: false, health }]);
  });

  it("hands the same document to the system procedure", async () => {
    const { database: db, inputs } = capturingDatabase();

    await readDashboardSystem(db, "24h", async () => health);

    expect(inputs()).toEqual([{ window: "24h", health }]);
  });
});
