import { describe, expect, it } from "vitest";
import {
  cancelResultAppliesTo,
  clearPendingCancel,
  createLatestRequestGuard,
  taskDrawerBody,
  taskDrawerCloseOnEscape,
  taskDrawerModelessProps,
  taskDrawerOpened,
  taskDrawerSync,
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

  it("lets Escape close only the top interaction layer", () => {
    expect(taskDrawerCloseOnEscape(true)).toBe(false);
    expect(taskDrawerCloseOnEscape(false)).toBe(true);
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

describe("late cancellation result ownership", () => {
  it("writes the result only while the drawer still shows that task", () => {
    expect(cancelResultAppliesTo("job-a", "job-a")).toBe(true);
    // The operator clicked task B while A's cancellation was still in flight.
    expect(cancelResultAppliesTo("job-a", "job-b")).toBe(false);
    // Closing the drawer discards the result rather than re-opening the panel.
    expect(cancelResultAppliesTo("job-a", null)).toBe(false);
  });

  it("keeps a late failure for the previous task out of the newly selected task's panel", () => {
    let selected: string | null = "job-a";
    let shownError: string | null = null;

    const settleCancel = (id: string, message: string) => {
      if (!cancelResultAppliesTo(id, selected)) return;
      shownError = message;
    };

    // Cancellation of A is requested, then B is selected before the server answers.
    selected = "job-b";
    settleCancel("job-a", "Unable to cancel the task");
    expect(shownError).toBe(null);

    // B's own failure is still reported, so the guard silences staleness and nothing else.
    settleCancel("job-b", "boom");
    expect(shownError).toBe("boom");
  });

  it("clears the pending flag only for the task whose cancellation settled", () => {
    // The flag is a single slot holding at most one task id, so a late settle clearing it
    // unconditionally would unstick the spinner of a cancellation that is still running.
    expect(clearPendingCancel("job-b", "job-a")).toBe("job-b");
    expect(clearPendingCancel("job-a", "job-a")).toBe(null);
    expect(clearPendingCancel(null, "job-a")).toBe(null);
  });
});

describe("reconciling the drawer with the URL", () => {
  it("opens, switches, and closes to match the address bar", () => {
    // A deep link or a reload arrives with no drawer showing yet.
    expect(taskDrawerSync("job-a", null)).toBe("open");
    // Clicking another row, and Back or Forward between two tasks, both swap in place.
    expect(taskDrawerSync("job-b", "job-a")).toBe("open");
    // Removing the task parameter, whether by the close button or by Back, closes the panel.
    expect(taskDrawerSync(null, "job-a")).toBe("close");
  });

  it("does nothing when the drawer already agrees with the URL", () => {
    // This runs on every render of the controller, so re-rendering for an unrelated reason (a
    // poll landing, a filter changing) must not restart the load or discard one in flight.
    expect(taskDrawerSync("job-a", "job-a")).toBe("none");
    expect(taskDrawerSync(null, null)).toBe("none");
  });

  it("never reloads the task the drawer is already showing, however often it is asked", () => {
    let shown: string | null = null;
    const loads: string[] = [];
    const reconcile = (requested: string | null) => {
      const sync = taskDrawerSync(requested, shown);
      if (sync === "close") shown = null;
      else if (sync === "open") {
        shown = requested;
        loads.push(requested!);
      }
    };

    reconcile("job-a");
    // Three unrelated re-renders while the same task is open.
    reconcile("job-a");
    reconcile("job-a");
    reconcile("job-a");
    expect(loads).toEqual(["job-a"]);

    // Back to the list, then Forward to the same task, is a genuine open again.
    reconcile(null);
    reconcile("job-a");
    expect(loads).toEqual(["job-a", "job-a"]);
    expect(shown).toBe("job-a");
  });
});
