import { describe, expect, it } from "vitest";
import { taskRowActionGroups, type DashboardJobRow, type TaskRowAction } from "./model.js";

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
      "Cancel waiting task…",
    );
  });

  it("refuses to cancel a terminal task and says the outcome is immutable", () => {
    for (const state of ["succeeded", "failed", "canceled"]) {
      const cancel = action(row({ state }), "cancel");
      expect(cancel.unavailable).toContain(state);
      expect(cancel.unavailable).toContain("immutable");
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
    expect(cancel.unavailable).toContain("already requested");
    expect(cancel.label).not.toContain("…");
  });

  it("treats a state it does not know as having nothing to cancel", () => {
    expect(action(row({ state: "unknown" }), "cancel").unavailable).toContain("no live runtime");
  });

  it("offers a worker filter only once a worker has claimed the task", () => {
    expect(action(row(), "filter-worker").unavailable).toContain("No worker");
    expect(action(row({ workerId: "worker-a" }), "filter-worker")).toMatchObject({
      label: "Only worker worker-a",
      unavailable: null,
    });
    // A finished task keeps the worker that ran it, which is still worth filtering by.
    expect(
      action(row({ state: "failed", lastWorkerId: "worker-b" }), "filter-worker"),
    ).toMatchObject({ label: "Only worker worker-b", unavailable: null });
  });

  it("offers to copy args only when the task stored some", () => {
    expect(action(row(), "copy-args").unavailable).toBeNull();
    expect(action(row({ payload: null }), "copy-args").unavailable).toContain("no args");
    // Stored `false` and `0` are real args, not absence.
    expect(action(row({ payload: false }), "copy-args").unavailable).toBeNull();
  });

  it("marks only cancellation as destructive", () => {
    const destructive = taskRowActionGroups(row())
      .flatMap((group) => group.actions)
      .filter((candidate) => candidate.destructive)
      .map((candidate) => candidate.id);
    expect(destructive).toEqual(["cancel"]);
  });
});
