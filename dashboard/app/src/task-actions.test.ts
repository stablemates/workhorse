import { describe, expect, it } from "vitest";
import { taskRowActionGroups, type TaskRowAction } from "./presentation.js";
import type { DashboardJobRow } from "@stablemates/workhorse-dashboard-server/wire";

function row(overrides: Partial<DashboardJobRow> = {}): DashboardJobRow {
  return {
    id: "3f1c0c8e-0000-4000-8000-000000000001",
    queue: "demo",
    type: "demo.report",
    state: "ready",
    attempt: 1,
    maxAttempts: 3,
    retryPolicy: null,
    payload: { orderId: 7 },
    tags: [],
    keyed: false,
    cancellation: null,
    runAt: null,
    workerId: null,
    lastWorkerId: null,
    finishedAt: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    durability: null,
    waitName: null,
    wakeAt: null,
    wait: null,
    ...overrides,
  };
}

function action(job: DashboardJobRow, id: TaskRowAction["id"]): TaskRowAction {
  const found = taskRowActionGroups(job)
    .flatMap((group) => group.actions)
    .find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No action ${id} was offered`);
  return found;
}

/**
 * The row menu is the only place an operator sees a task's available actions without opening it, so
 * what it offers has to follow the task's actual state rather than a static list. These tests pin
 * that mapping, and pin that an unavailable action still explains itself.
 */
describe("task row actions", () => {
  it("offers the same actions for every row so the menu never changes shape", () => {
    const states = ["scheduled", "ready", "active", "succeeded", "failed", "canceled"];
    const shapes = states.map((state) =>
      taskRowActionGroups(row({ state })).map((group) => group.actions.map((a) => a.id)),
    );
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
  });

  it("always explains an action it will not perform", () => {
    const states = ["scheduled", "ready", "active", "succeeded", "failed", "canceled", "unknown"];
    for (const state of states) {
      for (const group of taskRowActionGroups(row({ state }))) {
        for (const candidate of group.actions) {
          if (candidate.unavailable === null) continue;
          expect(candidate.unavailable.endsWith(".")).toBe(true);
          expect(candidate.unavailable).not.toContain("_");
        }
      }
    }
  });

  it("describes canceling an active task as a request, never as a stop", () => {
    const cancel = action(row({ state: "active" }), "cancel");
    expect(cancel.unavailable).toBeNull();
    expect(cancel.destructive).toBe(true);
    expect(cancel.label).toContain("Request cancellation");
  });

  it("names the durable wait a scheduled task is suspended at", () => {
    expect(action(row({ state: "scheduled" }), "cancel").label).toBe("Cancel scheduled task…");
    expect(action(row({ state: "scheduled", waitName: "payment" }), "cancel").label).toBe(
      "Cancel task at wait…",
    );
  });

  it("refuses to cancel a terminal task and says the outcome is immutable", () => {
    for (const state of ["succeeded", "failed", "canceled"]) {
      const cancel = action(row({ state }), "cancel");
      expect(cancel.unavailable).toContain(state);
      expect(cancel.unavailable).toContain("cannot change its outcome");
    }
  });

  it("does not offer to repeat a cancellation that was already requested", () => {
    const cancel = action(
      row({
        state: "active",
        cancellation: { requestedAt: "2026-01-01T00:00:01.000Z", requestedBy: "ops", reason: null },
      }),
      "cancel",
    );
    expect(cancel.unavailable).toContain("already asked");
    expect(cancel.label).not.toContain("…");
  });

  it("treats a state it does not know as having nothing to cancel", () => {
    expect(action(row({ state: "unknown" }), "cancel").unavailable).toContain("no live runtime");
  });

  it("offers a worker filter only once a worker has claimed the task", () => {
    expect(action(row(), "filter-worker").unavailable).toContain("no claim record");
    expect(action(row({ workerId: "worker-a" }), "filter-worker")).toMatchObject({
      label: "Only worker worker-a",
      unavailable: null,
    });
    // A finished task keeps the worker that ran it, which is still worth filtering by.
    expect(
      action(row({ state: "failed", lastWorkerId: "worker-b" }), "filter-worker"),
    ).toMatchObject({ label: "Only worker worker-b", unavailable: null });
  });

  it("offers to copy input only when the task stored some", () => {
    expect(action(row(), "copy-args").unavailable).toBeNull();
    expect(action(row({ payload: null }), "copy-args").unavailable).toContain("no input");
    // Stored `false` and `0` are real input, not absence.
    expect(action(row({ payload: false }), "copy-args").unavailable).toBeNull();
  });

  /**
   * Run now releases a task that is holding a future start time, and only that. These cases pin
   * that the menu never offers it where it would mean something else, and never refuses it silently.
   */
  describe("run now", () => {
    it("offers it for an ordinary future-scheduled task", () => {
      expect(action(row({ state: "scheduled" }), "run-now")).toMatchObject({
        label: "Run now",
        unavailable: null,
        destructive: false,
      });
    });

    it("refuses a task suspended at a durable wait and names the wait", () => {
      const waiting = action(row({ state: "scheduled", waitName: "payment" }), "run-now");
      expect(waiting.unavailable).toContain("payment");
      expect(waiting.unavailable).toContain("durable wait");
      // The reason has to be about the boundary, not about the state being wrong.
      expect(waiting.unavailable).toContain("handler requested");
    });

    it("refuses a wait carried only on the structured wait field", () => {
      const waiting = action(
        row({
          state: "scheduled",
          waitName: null,
          wait: { name: "settlement", wakeAt: "2026-01-02T00:00:00.000Z", mode: "absolute" },
        }),
        "run-now",
      );
      expect(waiting.unavailable).toContain("settlement");
    });

    it("refuses a task that is already queued or running, without calling it an error", () => {
      expect(action(row({ state: "ready" }), "run-now").unavailable).toContain(
        "ready for a worker",
      );
      expect(action(row({ state: "active" }), "run-now").unavailable).toContain("task is running");
    });

    it("refuses a terminal task and names the outcome it holds", () => {
      for (const state of ["succeeded", "failed", "canceled"]) {
        expect(action(row({ state }), "run-now").unavailable).toContain(state);
      }
    });

    it("refuses a task whose cancellation was already requested", () => {
      const pending = action(
        row({
          state: "scheduled",
          cancellation: {
            requestedAt: "2026-01-01T00:00:01.000Z",
            requestedBy: "ops",
            reason: null,
          },
        }),
        "run-now",
      );
      expect(pending.unavailable).toContain("received a cancellation request");
    });

    it("states a host that cannot run tasks early rather than dropping the item", () => {
      const groups = taskRowActionGroups(row({ state: "scheduled" }), { runNow: false });
      const runNow = groups
        .flatMap((group) => group.actions)
        .find((candidate) => candidate.id === "run-now");
      expect(runNow?.unavailable).toContain("does not allow the dashboard");
      expect(runNow?.unavailable).toContain("start time");
      // The menu keeps exactly the same shape whether or not the host supports the action.
      expect(groups.map((group) => group.actions.map((a) => a.id))).toEqual(
        taskRowActionGroups(row({ state: "scheduled" })).map((group) =>
          group.actions.map((a) => a.id),
        ),
      );
    });

    it("never claims to run the handler here and now", () => {
      const states = ["scheduled", "ready", "active", "succeeded", "unknown"];
      for (const state of states) {
        const runNow = action(row({ state }), "run-now");
        const wording = `${runNow.label} ${runNow.unavailable ?? ""}`.toLowerCase();
        for (const overclaim of ["executes", "runs it here", "immediately runs", "force"]) {
          expect(wording).not.toContain(overclaim);
        }
      }
    });
  });

  it("marks only cancellation as destructive", () => {
    const destructive = taskRowActionGroups(row())
      .flatMap((group) => group.actions)
      .filter((candidate) => candidate.destructive)
      .map((candidate) => candidate.id);
    expect(destructive).toEqual(["cancel"]);
  });

  it("offers redrive only for a task that finished as failed", () => {
    expect(action(row({ state: "failed" }), "redrive")).toEqual({
      id: "redrive",
      label: "Redrive as a new task…",
      unavailable: null,
      destructive: false,
    });
    expect(action(row({ state: "succeeded" }), "redrive").unavailable).toContain(
      "this one is succeeded",
    );
    expect(action(row({ state: "active" }), "redrive").unavailable).toContain("has not finished");
  });

  it("offers an application-defined human decision from the stable row menu", () => {
    expect(
      action(
        row({
          humanWait: {
            name: "account-review",
            context: {
              dashboard: { quickAction: { label: "Approve", result: { approved: true } } },
            },
            deadlineAt: "2026-01-02T00:00:00.000Z",
          },
        }),
        "complete-human-wait",
      ),
    ).toMatchObject({ label: "Approve…", unavailable: null, destructive: false });

    expect(action(row(), "complete-human-wait").unavailable).toContain(
      "not waiting for a human decision",
    );
  });
});
