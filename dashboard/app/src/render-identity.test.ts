import { describe, expect, it } from "vitest";

import type {
  DashboardTaskRow,
  DashboardTaskCounts,
} from "@stablemates/workhorse-dashboard-server/wire";
import type { LoadState, PageData } from "./core.js";
import { readyLoadState, readyTaskCounts, sameStructure } from "./render-identity.js";
import type { TaskListRowProps } from "./components/task-row.js";

// The row pulls in the preferences module, which reads stored settings as it loads.
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});
const { sameTaskRow } = await import("./components/task-row.js");

function taskRow(overrides: Partial<DashboardTaskRow> = {}): DashboardTaskRow {
  return {
    id: "3f1c0c8e-0000-4000-8000-000000000001",
    queue: "billing",
    type: "billing.invoice.issue",
    priority: 0,
    state: "completed",
    blockedReason: null,
    prerequisiteTaskIds: [],
    attempt: 1,
    maxAttempts: 5,
    retryPolicy: null,
    tags: ["weekly"],
    keyed: false,
    cancellation: null,
    runAt: null,
    workerId: null,
    lastWorkerId: "worker-1",
    finishedAt: "2026-09-20T12:00:00.000Z",
    errorMessage: null,
    createdAt: "2026-09-20T11:59:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    durability: { completedSteps: 3, totalSteps: 3 },
    waitName: null,
    wakeAt: null,
    wait: null,
    signalWait: null,
    humanWait: null,
    ...overrides,
  };
}

const openTask = (_id: string) => undefined;
const runAction = () => undefined;

function rowProps(overrides: Partial<TaskListRowProps> = {}): TaskListRowProps {
  return {
    task: taskRow(),
    eventsHref: "/dashboard/events?task=3f1c0c8e-0000-4000-8000-000000000001",
    onOpen: openTask,
    onAction: runAction,
    canRunNow: true,
    canCompleteHumanWait: false,
    pendingAction: null,
    shownAt: Date.parse("2026-09-20T13:00:00.000Z"),
    timeZone: "UTC",
    ...overrides,
  };
}

function tasksPage(tasks: DashboardTaskRow[]): PageData {
  return {
    route: "/tasks",
    value: {
      tasks,
      filter: "all",
      sort: "updated",
      page: 1,
      pageSize: 50,
      total: tasks.length,
      canCompleteHumanWait: false,
    },
  } as PageData;
}

describe("structural comparison", () => {
  it("reports no change for an answer that repeats the last one", () => {
    expect(sameStructure(taskRow(), taskRow())).toBe(true);
  });

  it("reports a change for a differing field, an added key, and a reordered list", () => {
    expect(sameStructure(taskRow(), taskRow({ attempt: 2 }))).toBe(false);
    expect(sameStructure({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameStructure(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("compares functions by reference, because two closures cannot be shown to agree", () => {
    expect(sameStructure(openTask, openTask)).toBe(true);
    expect(
      sameStructure(
        () => undefined,
        () => undefined,
      ),
    ).toBe(false);
  });
});

describe("what a poll writes to the shell", () => {
  it("keeps the state object when the page repeats, so setState commits nothing", () => {
    const current: LoadState = { status: "ready", data: tasksPage([taskRow()]), error: null };

    expect(readyLoadState(current, tasksPage([taskRow()]))).toBe(current);
  });

  it("keeps the page it already holds when only the load status moved on", () => {
    const data = tasksPage([taskRow()]);
    const current: LoadState = { status: "loading", data, error: null };
    const next = readyLoadState(current, tasksPage([taskRow()]));

    expect(next.status).toBe("ready");
    expect(next.data).toBe(data);
  });

  it("takes the new page when the answer changed", () => {
    const current: LoadState = { status: "ready", data: tasksPage([taskRow()]), error: null };
    const changed = tasksPage([taskRow({ attempt: 2 })]);

    expect(readyLoadState(current, changed)).not.toBe(current);
    expect(readyLoadState(current, changed).data).toBe(changed);
  });

  it("keeps the counts object when the totals repeat", () => {
    const current = { all: 12, running: 2 } as unknown as DashboardTaskCounts;
    const repeated = { all: 12, running: 2 } as unknown as DashboardTaskCounts;
    const moved = { all: 13, running: 2 } as unknown as DashboardTaskCounts;

    expect(readyTaskCounts(current, repeated)).toBe(current);
    expect(readyTaskCounts(current, moved)).toBe(moved);
  });
});

describe("what a poll makes a task row redraw", () => {
  it("commits nothing when the poll re-decoded the same row", () => {
    expect(sameTaskRow(rowProps(), rowProps())).toBe(true);
  });

  it("redraws a row whose task changed", () => {
    expect(sameTaskRow(rowProps(), rowProps({ task: taskRow({ state: "failed" }) }))).toBe(false);
    expect(
      sameTaskRow(rowProps(), rowProps({ task: taskRow({ tags: ["weekly", "retry"] }) })),
    ).toBe(false);
  });

  it("redraws a row whose action started or finished", () => {
    expect(sameTaskRow(rowProps(), rowProps({ pendingAction: "cancel" }))).toBe(false);
  });

  it("redraws a row whose menu gained an action the host now offers", () => {
    expect(sameTaskRow(rowProps(), rowProps({ canRunNow: false }))).toBe(false);
    expect(sameTaskRow(rowProps(), rowProps({ canCompleteHumanWait: true }))).toBe(false);
  });

  it("ignores a clock that moved without changing what the row says", () => {
    const hourLater = Date.parse("2026-09-20T13:00:30.000Z");

    expect(sameTaskRow(rowProps(), rowProps({ shownAt: hourLater }))).toBe(true);
  });

  it("redraws a row whose age label moved on", () => {
    const nextHour = Date.parse("2026-09-20T14:00:00.000Z");

    expect(sameTaskRow(rowProps(), rowProps({ shownAt: nextHour }))).toBe(false);
  });

  it("redraws every row when the operator changes the display time zone", () => {
    expect(sameTaskRow(rowProps(), rowProps({ timeZone: "Europe/Berlin" }))).toBe(false);
  });
});
