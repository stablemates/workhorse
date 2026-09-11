import { describe, expect, it, vi } from "vitest";
import type { DashboardEventDetail, DashboardTaskDetail } from "../wire.js";
import { readDashboardEventDetail, redactDashboardTaskDetailErrorStacks } from "./read-model.js";
import type { DashboardDatabase } from "./sql.js";

describe("dashboard task-detail error redaction", () => {
  it("removes stacks from every worker error surface without changing user data", () => {
    const error = { name: "Error", message: "failed", stack: "/app/worker.ts:42" };
    const detail = {
      childLineage: { records: [{ error }], truncated: false },
      current: {
        runtime: { error },
        outcome: { error },
        error,
        result: { stack: "user result" },
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
    expect(redacted.current.result).toEqual({ stack: "user result" });
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
