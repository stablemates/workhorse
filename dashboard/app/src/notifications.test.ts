import { toast } from "sonner";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { notifyDashboard, notifyFailure, notifyRunNow } from "./notifications.js";

function shown() {
  return toast.getToasts();
}

/**
 * These tests pin what the notification system promises an operator, rather than how it looks.
 *
 * Every operator result in this dashboard is now reported in one place, so a result that is
 * silently swallowed is a result the operator never gets: there is no banner left behind to read.
 */
describe("dashboard notifications", () => {
  beforeEach(() => toast.dismiss());

  it("replaces the previous answer for a repeated action instead of swallowing it", () => {
    // Repeated actions must replace stale feedback rather than disappear or duplicate it.
    notifyDashboard({ id: "clipboard", title: "Task id copied", message: "first" });
    notifyDashboard({ id: "clipboard", title: "Args copied", message: "second" });

    const current = shown();
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ id: "clipboard", title: "Args copied" });
  });

  it("stacks results that are about different things", () => {
    notifyDashboard({ title: "Queue paused", message: "demo stopped dispatching." });
    notifyDashboard({ title: "Worker paused", message: "worker-1 stopped claiming." });
    expect(shown()).toHaveLength(2);
  });

  it("announces a failure as an alert and a refusal politely", () => {
    notifyFailure("Task not canceled", new Error("Connection lost"), "Unable to cancel the task");
    notifyRunNow(
      {
        jobId: "job-1",
        status: "waiting",
        described: {
          label: "Suspended at a wait",
          summary: "This task is suspended at a durable wait",
          exact: "The task is parked at a durable wait boundary its handler asked for.",
        },
        failure: null,
      },
      { openTask: () => undefined },
    );

    const [failure, refusal] = shown();
    expect(failure).toMatchObject({ title: "Task not canceled" });
    expect(refusal).toMatchObject({ title: "Suspended at a wait" });
    expect(renderToStaticMarkup(failure!.description as React.ReactNode)).toContain('role="alert"');
    expect(renderToStaticMarkup(refusal!.description as React.ReactNode)).toContain(
      'role="status"',
    );
  });

  it("keeps a failure on screen longer than a result that is merely acknowledged", () => {
    notifyDashboard({
      title: "Queue cleared",
      message: "Cleared 3 waiting tasks.",
      tone: "success",
    });
    notifyFailure("Queue not cleared", new Error("Permission denied"), "Unable to clear the queue");

    const [success, failure] = shown();
    expect(Number(failure!.duration)).toBeGreaterThan(Number(success!.duration));
  });

  it("reports a transport failure with the cause the server gave", () => {
    notifyRunNow(
      { jobId: "job-1", status: null, described: null, failure: "Job not found" },
      { openTask: () => undefined },
    );
    expect(shown()[0]).toMatchObject({ title: "Task not run now" });
  });
});
