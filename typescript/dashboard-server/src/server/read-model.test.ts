import { describe, expect, it, vi } from "vitest";
import type { DashboardEventDetail, DashboardTaskDetail } from "../wire.js";
import {
  readDashboardEventDetail,
  readDashboardHumanWaits,
  readDashboardQueues,
  readDashboardSettings,
  readDashboardSystem,
  readDashboardTaskDetail,
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
      events: [{ details: { error } }],
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
    expect(redacted.events).toEqual([{ details: { error } }]);
  });
});

describe("dashboard event-detail error redaction", () => {
  const attemptError = { name: "Error", message: "failed", stack: "/app/dist/worker.js:42" };

  function database(): DashboardDatabase {
    return {
      execute: vi.fn<() => Promise<{ rows: { result: DashboardEventDetail }[] }>>(async () => ({
        rows: [
          {
            result: {
              kind: "attempt",
              error: attemptError,
              details: null,
            } as unknown as DashboardEventDetail,
          },
        ],
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
