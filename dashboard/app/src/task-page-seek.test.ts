import type { DashboardClient } from "@stablemates/workhorse-dashboard-server";
import type {
  DashboardTasksCursorPage,
  DashboardTasksPage,
} from "@stablemates/workhorse-dashboard-server/wire";
import { describe, expect, it, vi } from "vitest";
import { seekDashboardTaskPage } from "./task-page-seek.js";

const cursors = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    priority: 0,
    updatedAt: "2026-09-19T12:00:00.000001Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    priority: 0,
    updatedAt: "2026-09-19T11:00:00.000002Z",
  },
] as const;

function cursorPage(nextCursor: DashboardTasksCursorPage["nextCursor"]): DashboardTasksCursorPage {
  return {
    capturedAt: "2026-09-19T12:00:00.000Z",
    canCompleteHumanWait: false,
    filter: "all",
    queue: null,
    worker: null,
    taskType: null,
    priority: null,
    sort: "updated",
    tags: [],
    search: null,
    page: 1,
    pageSize: 50,
    count: "none",
    total: null,
    nextCursor,
    previousCursor: null,
    tasks: [],
  };
}

describe("legacy task page seeking", () => {
  it("walks to a cursorless third page through bounded cursor requests", async () => {
    const pages = [cursorPage(cursors[0]), cursorPage(null)];
    const tasksCursor = vi.fn<DashboardClient["tasksCursor"]>(async () => pages.shift()!);
    const tasks = vi.fn<DashboardClient["tasks"]>();
    const query = {
      filter: "all" as const,
      queue: null,
      worker: null,
      taskType: null,
      sort: "updated" as const,
      tags: [],
      search: undefined,
      pageSize: 50 as const,
    };

    await expect(seekDashboardTaskPage({ tasks, tasksCursor }, query, 3)).resolves.toEqual(
      cursorPage(null),
    );
    expect(tasksCursor).toHaveBeenCalledTimes(2);
    expect(tasksCursor.mock.calls.map(([request]) => request.cursor)).toEqual([null, cursors[0]]);
    expect(tasksCursor).toHaveBeenCalledWith({
      ...query,
      cursor: null,
      pageSize: 100,
      direction: "next",
      count: "none",
    });
    expect(tasksCursor).toHaveBeenCalledWith({
      ...query,
      cursor: cursors[0],
      direction: "next",
      count: "none",
    });
    expect(tasks).not.toHaveBeenCalled();
  });

  it("preserves the legacy empty-page response when the requested offset is past the selection", async () => {
    const tasksCursor = vi.fn<DashboardClient["tasksCursor"]>(async () => cursorPage(null));
    const legacy = {
      ...cursorPage(null),
      total: 12,
      hasMore: false,
      tasks: [],
    } as DashboardTasksPage;
    const tasks = vi.fn<DashboardClient["tasks"]>(async () => legacy);

    await expect(
      seekDashboardTaskPage(
        { tasks, tasksCursor },
        {
          filter: "all",
          queue: null,
          worker: null,
          taskType: null,
          sort: "updated",
          tags: [],
          search: undefined,
          pageSize: 50,
        },
        3,
      ),
    ).resolves.toBe(legacy);
    expect(tasksCursor).toHaveBeenCalledOnce();
    expect(tasks).toHaveBeenCalledWith({
      filter: "all",
      queue: null,
      worker: null,
      taskType: null,
      sort: "updated",
      tags: [],
      search: undefined,
      pageSize: 50,
      page: 3,
    });
  });
});
