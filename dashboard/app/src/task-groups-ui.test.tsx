import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import type { DashboardClient } from "@stablemates/workhorse-dashboard-server";
import type {
  DashboardTaskGroup,
  DashboardTaskGroupDetail,
} from "@stablemates/workhorse-dashboard-server/wire";
import {
  defaultTaskGroupsLocation,
  parseTaskGroupsLocation,
  taskGroupsLocationHref,
} from "./task-groups-location.js";

// The page module reaches the dashboard shell, which reads localStorage at import time.
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});
const { DashboardClientContext } = await import("./core.js");
const {
  TaskGroupDetailView,
  TaskGroupsList,
  callbackPendingReason,
  taskGroupProgressLabel,
  taskGroupProgressSections,
} = await import("./pages/task-groups.js");

const groupId = "019a0000-0000-7000-8000-000000000001";
const memberId = "019a0000-0000-7000-8000-000000000002";
const callbackId = "019a0000-0000-7000-8000-000000000003";

function group(overrides: Partial<DashboardTaskGroup> = {}): DashboardTaskGroup {
  return {
    id: groupId,
    state: "sealed",
    result: null,
    counts: { total: 4, succeeded: 2, failed: 1, canceled: 0, pending: 1 },
    createdAt: "2026-10-11T10:00:00.000Z",
    sealedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: null,
    canceledAt: null,
    canceledBy: null,
    cancelReason: null,
    callbacks: [
      { kind: "onFinish", taskId: null },
      { kind: "onSuccess", taskId: null },
      { kind: "onFailure", taskId: null },
    ],
    ...overrides,
  };
}

function detail(overrides: Partial<DashboardTaskGroupDetail> = {}): DashboardTaskGroupDetail {
  return {
    group: group(),
    members: [
      {
        position: 1,
        taskId: memberId,
        queue: "imports",
        taskType: "import.row",
        state: "failed",
        outcome: "failed",
        addedAt: "2026-10-11T10:00:00.000Z",
        countedAt: "2026-10-11T10:01:00.000Z",
      },
    ],
    nextAfter: 1,
    events: [
      {
        id: "019a0000-0000-7000-8000-000000000009",
        type: "sealed",
        details: { total: 4 },
        occurredAt: "2026-10-11T10:00:00.000Z",
      },
    ],
    eventsTruncated: false,
    canCancel: true,
    ...overrides,
  };
}

const navigation = {
  href: (path: string) => `/workhorse${path}`,
  followLink: () => undefined,
  taskPath: (taskId: string) => `/tasks?task=${taskId}`,
};

function render(element: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(DashboardClientContext.Provider, { value: {} as DashboardClient }, element),
    ),
  );
}

describe("task group location", () => {
  it("round-trips a list page and a member page through the address bar", () => {
    const list = { ...defaultTaskGroupsLocation, state: "sealed" as const, page: 3 };
    expect(taskGroupsLocationHref(list)).toBe("/groups?state=sealed&page=3");
    expect(parseTaskGroupsLocation("?state=sealed&page=3")).toEqual(list);

    const member = { ...defaultTaskGroupsLocation, groupId, after: 50 };
    expect(taskGroupsLocationHref(member)).toBe(`/groups?group=${groupId}&after=50`);
    expect(parseTaskGroupsLocation(`?group=${groupId}&after=50`)).toEqual(member);
    expect(taskGroupsLocationHref(defaultTaskGroupsLocation)).toBe("/groups");
  });

  it("drops values that the procedures would refuse", () => {
    expect(parseTaskGroupsLocation("?state=stuck&page=0&pageSize=7&group=nope&after=-1")).toEqual(
      defaultTaskGroupsLocation,
    );
  });
});

describe("task group progress", () => {
  it("draws one section per counted outcome and leaves pending members unfilled", () => {
    const sections = taskGroupProgressSections(group().counts);
    expect(sections.map(({ outcome, percent }) => [outcome, percent])).toEqual([
      ["succeeded", 50],
      ["failed", 25],
    ]);
    expect(taskGroupProgressLabel(group().counts)).toBe("3 of 4 finished");
  });

  it("draws no section for a group with no member tasks", () => {
    const counts = { total: 0, succeeded: 0, failed: 0, canceled: 0, pending: 0 };
    expect(taskGroupProgressSections(counts)).toEqual([]);
    expect(taskGroupProgressLabel(counts)).toBe("No member tasks");
  });

  it("explains why a callback has no task", () => {
    const failed = group({ state: "finished", result: "failed" });
    expect(callbackPendingReason(group(), "onFinish")).toBe(
      "Runs when every member task is finished",
    );
    expect(callbackPendingReason(failed, "onSuccess")).toContain("did not succeed");
  });
});

describe("task group pages", () => {
  it("lists each group with its progress and links to its detail", () => {
    const markup = render(
      createElement(TaskGroupsList, {
        data: { state: "all", page: 1, pageSize: 50, hasMore: false, groups: [group()] },
        location: defaultTaskGroupsLocation,
        navigation,
        navigate: () => undefined,
      }),
    );
    expect(markup).toContain(`/workhorse/groups?group=${groupId}`);
    expect(markup).toContain("3 of 4 finished");
    expect(markup).toContain("1 pending");
  });

  it("stops the pager at the last page the list reads", () => {
    const markup = render(
      createElement(TaskGroupsList, {
        data: { state: "all", page: 100, pageSize: 50, hasMore: true, groups: [group()] },
        location: { ...defaultTaskGroupsLocation, page: 100 },
        navigation,
        navigate: () => undefined,
      }),
    );
    expect(markup).toContain("Page 100, the last page the list reads.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Next page/s);
  });

  it("shows members, callbacks, events, and a cancel action on an unfinished group", () => {
    const markup = render(
      createElement(TaskGroupDetailView, {
        data: detail(),
        location: { ...defaultTaskGroupsLocation, groupId },
        navigation,
        navigate: () => undefined,
        auditActor: "operator",
        reload: async () => undefined,
      }),
    );
    expect(markup).toContain(`/workhorse/tasks?task=${memberId}`);
    expect(markup).toContain("import.row");
    expect(markup).toContain("onFailure");
    expect(markup).toContain("sealed");
    expect(markup).toContain("Cancel group");
  });

  it("offers no cancel where the dashboard cannot cancel", () => {
    const markup = render(
      createElement(TaskGroupDetailView, {
        data: detail({ canCancel: false }),
        location: { ...defaultTaskGroupsLocation, groupId },
        navigation,
        navigate: () => undefined,
        auditActor: "operator",
        reload: async () => undefined,
      }),
    );
    expect(markup).not.toContain("Cancel group");
    expect(markup).toContain("This dashboard cannot cancel task groups.");
  });

  it("links an enqueued callback task and offers no cancel on a finished group", () => {
    const finished = group({
      state: "finished",
      result: "failed",
      finishedAt: "2026-10-11T10:02:00.000Z",
      counts: { total: 4, succeeded: 3, failed: 1, canceled: 0, pending: 0 },
      callbacks: [
        { kind: "onFinish", taskId: callbackId },
        { kind: "onSuccess", taskId: null },
      ],
    });
    const markup = render(
      createElement(TaskGroupDetailView, {
        data: detail({ group: finished, nextAfter: null }),
        location: { ...defaultTaskGroupsLocation, groupId },
        navigation,
        navigate: () => undefined,
        auditActor: "operator",
        reload: async () => undefined,
      }),
    );
    expect(markup).toContain(`/workhorse/tasks?task=${callbackId}`);
    expect(markup).toContain("Not enqueued, because a member task did not succeed");
    expect(markup).not.toContain("Cancel group");
  });
});
