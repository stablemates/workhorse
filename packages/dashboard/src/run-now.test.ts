import { createORPCClient } from "@orpc/client";
import { describe, expect, it } from "vitest";
import type { DashboardClient } from "./client.js";
import { describeRunNowOutcome, runNowOutcomeTone, type DashboardRunNowStatus } from "./model.js";
import { requestRunNow } from "./run-now.js";

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

  /**
   * Three of these statuses are the server deliberately leaving a task alone. Reporting them in the
   * colour of a failure would send an operator to investigate a fault that does not exist.
   */
  it("reserves the failure tone for requests that never reached a decision", () => {
    expect(runNowOutcomeTone("released")).toBe("success");
    for (const status of ["already_ready", "not_scheduled", "waiting", "not_found"] as const) {
      expect(runNowOutcomeTone(status)).toBe("neutral");
    }
  });

  it("describes a release as queueing the task, not as running it", () => {
    const described = describeRunNowOutcome("released");
    expect(described.summary).toContain("start time to now");
    expect(described.exact).toContain("after the next claim");
    // The distinction between releasing and executing is the whole point of the wording.
    expect(described.exact).toContain("rather than running the handler here");
  });

  it("states that a recurring schedule keeps its own next occurrence", () => {
    // The one thing an operator is most likely to assume wrongly: that this shifted the cron.
    expect(describeRunNowOutcome("released").exact).toContain("next occurrence");
  });

  it("reports an already-queued task as a no-op rather than a failure", () => {
    const described = describeRunNowOutcome("already_ready");
    expect(described.summary).toContain("already ready");
    expect(described.summary).toContain("changed nothing");
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
    expect(described.summary).toContain("could not find this task");
    expect(described.summary).toContain("released nothing");
    expect(described.exact).toContain("Retention");
  });

  /**
   * The packaged browser client is an oRPC proxy whose every property read is another segment of a
   * procedure path. A reference lifted off it and invoked with `call` or `bind` therefore addresses
   * `dashboard.runTaskNow.call`, which no router serves: the request 404s, the operator reads "Not
   * found", and the task stays scheduled. TypeScript cannot see the difference, because the proxy
   * satisfies the method type either way, so the request path is asserted here against a real
   * client rather than a hand-written stub.
   */
  it("addresses the runTaskNow procedure itself through a real oRPC client", async () => {
    const calls: { path: readonly string[]; input: unknown }[] = [];
    const client = createORPCClient<{
      dashboard: DashboardClient;
    }>({
      call(path, input) {
        calls.push({ path, input });
        return Promise.resolve({ status: "released", id: "job", state: "ready", runAt: null });
      },
    }).dashboard;

    const feedback = await requestRunNow(client, {
      id: "1e3d0f4a-2a1d-4f4f-9a6d-6d5c2b7f0f11",
      auditActor: "operator",
      requestId: "request-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toEqual(["dashboard", "runTaskNow"]);
    expect(calls[0]!.input).toMatchObject({
      id: "1e3d0f4a-2a1d-4f4f-9a6d-6d5c2b7f0f11",
      audit: { actor: "operator", requestId: "request-1" },
    });
    expect(feedback).toMatchObject({ failure: null });
    expect(feedback.described?.label).toBe("Released to the queue");
  });

  it("reports a rejected request as a failure sentence rather than a silent no-op", async () => {
    const client = createORPCClient<{ dashboard: DashboardClient }>({
      call() {
        return Promise.reject(new Error("Job not found"));
      },
    }).dashboard;

    await expect(
      requestRunNow(client, { id: "job", auditActor: "operator", requestId: "request-2" }),
    ).resolves.toMatchObject({ jobId: "job", described: null, failure: "Job not found" });
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
