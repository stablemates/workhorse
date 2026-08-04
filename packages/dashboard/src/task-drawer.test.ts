import { describe, expect, it } from "vitest";
import {
  createLatestRequestGuard,
  taskDrawerBody,
  taskDrawerModelessProps,
  taskDrawerOpened,
} from "./task-drawer.js";

describe("task detail drawer", () => {
  it("is non-modal so the task list behind it stays usable", () => {
    // No overlay and no click-outside close is what keeps a table row behind the panel clickable.
    expect(taskDrawerModelessProps.withOverlay).toBe(false);
    expect(taskDrawerModelessProps.closeOnClickOutside).toBe(false);
    // A locked scroll or a focus trap would make the list unreachable even without an overlay.
    expect(taskDrawerModelessProps.lockScroll).toBe(false);
    expect(taskDrawerModelessProps.trapFocus).toBe(false);
    expect(taskDrawerModelessProps.returnFocus).toBe(false);
    // Escape stays the one keyboard way out of the panel.
    expect(taskDrawerModelessProps.closeOnEscape).toBe(true);
  });

  it("stays open while the next selected task loads", () => {
    const loaded = {
      selectedJobId: "job-1",
      selectedJob: { id: "job-1" },
      jobDetailError: null,
    };
    expect(taskDrawerOpened(loaded.selectedJobId)).toBe(true);
    expect(taskDrawerBody(loaded)).toBe("detail");

    // Selecting another row clears the loaded detail but keeps the drawer open on a loader,
    // so the panel swaps contents in place instead of closing and re-opening.
    const switching = {
      selectedJobId: "job-2",
      selectedJob: null,
      jobDetailError: null,
    };
    expect(taskDrawerOpened(switching.selectedJobId)).toBe(true);
    expect(taskDrawerBody(switching)).toBe("loading");

    expect(taskDrawerBody({ ...switching, selectedJob: { id: "job-2" } })).toBe("detail");
  });

  it("closes only when no task is selected and reports a load failure in place", () => {
    expect(taskDrawerOpened(null)).toBe(false);
    expect(
      taskDrawerBody({
        selectedJobId: null,
        selectedJob: null,
        jobDetailError: null,
      }),
    ).toBe("closed");
    expect(
      taskDrawerBody({
        selectedJobId: "job-3",
        selectedJob: null,
        jobDetailError: "boom",
      }),
    ).toBe("error");
  });
});

describe("latest task detail request guard", () => {
  it("lets a late response from the previously selected task write nothing", () => {
    const guard = createLatestRequestGuard();
    const a = guard.begin();
    const b = guard.begin();

    // B was selected second, so B owns the drawer even though A is still in flight.
    expect(guard.current(b)).toBe(true);
    // A resolving afterwards (detail or error) must not overwrite B.
    expect(guard.current(a)).toBe(false);
  });

  it("invalidates an earlier request even when the same task is clicked twice", () => {
    const guard = createLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    // Matching on the task id alone would let the stale first response win here.
    expect(guard.current(first)).toBe(false);
    expect(guard.current(second)).toBe(true);
  });

  it("abandons every in-flight request when the drawer is closed", () => {
    const guard = createLatestRequestGuard();
    const inFlight = guard.begin();
    guard.cancel();

    expect(guard.current(inFlight)).toBe(false);
  });

  it("keeps only the newest task's detail when responses arrive out of order", async () => {
    const guard = createLatestRequestGuard();
    let drawer: string | null = null;

    const load = async (id: string, detail: Promise<string>) => {
      const ticket = guard.begin();
      const resolved = await detail;
      if (!guard.current(ticket)) return;
      drawer = resolved;
      expect(id).toBe(resolved);
    };

    // Task A is clicked first but its server response arrives last.
    const slowA = Promise.withResolvers<string>();
    const a = load("job-a", slowA.promise);
    const b = load("job-b", Promise.resolve("job-b"));

    await b;
    expect(drawer).toBe("job-b");

    slowA.resolve("job-a");
    await a;
    expect(drawer).toBe("job-b");
  });
});
