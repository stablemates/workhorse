import { describe, expect, it } from "vitest";
import type { DashboardJobDetail } from "../wire.js";
import { redactDashboardJobDetailErrorStacks } from "./read-model.js";

describe("dashboard job-detail error redaction", () => {
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
    } as unknown as DashboardJobDetail;

    const redacted = redactDashboardJobDetailErrorStacks(detail);

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
