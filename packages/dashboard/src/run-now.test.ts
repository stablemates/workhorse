import { describe, expect, it } from "vitest";
import { describeRunNowOutcome, type DashboardRunNowStatus } from "./model.js";

const statuses: DashboardRunNowStatus[] = [
  "released",
  "already_ready",
  "not_scheduled",
  "waiting",
  "not_found",
];

/**
 * These tests pin the promises the run-now copy is allowed to make.
 *
 * Running a scheduled task now moves that one task's start time forward. It does not execute the
 * handler in the request, it does not grant an extra attempt, and it does not touch the next
 * occurrence of a recurring schedule that created the task. Wording that implied otherwise would
 * send an operator to reconcile something that never happened, so the honesty of each sentence is
 * treated as behaviour and asserted rather than left to review.
 */
describe("run-now vocabulary", () => {
  it("never shows a raw status string", () => {
    for (const status of statuses) {
      const described = describeRunNowOutcome(status);
      expect(described.label).not.toContain("_");
      expect(described.label).not.toBe(status);
      expect(described.summary.length).toBeGreaterThan(0);
      expect(described.exact.length).toBeGreaterThan(0);
    }
  });

  it("describes a release as queueing the task, not as running it", () => {
    const described = describeRunNowOutcome("released");
    expect(described.summary).toContain("moved to now");
    expect(described.exact).toContain("A worker claims");
    // The distinction between releasing and executing is the whole point of the wording.
    expect(described.exact).toContain("rather than running the handler here");
  });

  it("states that a recurring schedule keeps its own next occurrence", () => {
    // The one thing an operator is most likely to assume wrongly: that this shifted the cron.
    expect(describeRunNowOutcome("released").exact).toContain("next occurrence");
  });

  it("reports an already-queued task as a no-op rather than a failure", () => {
    const described = describeRunNowOutcome("already_ready");
    expect(described.summary).toContain("nothing needed to change");
    expect(described.exact).toContain("left exactly as it was");
    expect(described.label.toLowerCase()).not.toContain("error");
  });

  it("explains a refused durable wait in terms of the handler that asked for it", () => {
    const described = describeRunNowOutcome("waiting");
    expect(described.summary).toContain("durable wait");
    expect(described.exact).toContain("its handler asked for");
    expect(described.exact).toContain("left exactly as it was");
  });

  it("names the state that makes a task ineligible, and reads cleanly without one", () => {
    expect(describeRunNowOutcome("not_scheduled", { state: "succeeded" }).summary).toContain(
      "succeeded",
    );
    expect(describeRunNowOutcome("not_scheduled").summary).not.toContain("undefined");
    expect(describeRunNowOutcome("not_scheduled").summary).toContain("nothing was released");
  });

  it("explains a missing task rather than reporting a silent success", () => {
    const described = describeRunNowOutcome("not_found");
    expect(described.summary).toContain("nothing was released");
    expect(described.exact).toContain("retention");
  });

  it("never overclaims what running a task now does", () => {
    for (const status of statuses) {
      const described = describeRunNowOutcome(status);
      const wording = `${described.label} ${described.summary} ${described.exact}`.toLowerCase();
      for (const overclaim of [
        "force",
        "instantly",
        "guarantee",
        "retry budget",
        "reschedule",
        "skips the",
      ]) {
        expect(wording).not.toContain(overclaim);
      }
    }
  });
});
