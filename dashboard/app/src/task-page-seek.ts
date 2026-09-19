import type { DashboardClient } from "@stablemates/workhorse-dashboard-server";
import type {
  DashboardTasksCursorPage,
  DashboardTasksPage,
} from "@stablemates/workhorse-dashboard-server/wire";

type CursorRequest = Parameters<DashboardClient["tasksCursor"]>[0];
type CursorQuery = Omit<CursorRequest, "count" | "cursor" | "direction">;

/** Resolve a legacy page-number link through the bounded keyset listing. */
export async function seekDashboardTaskPage(
  client: Pick<DashboardClient, "tasks" | "tasksCursor">,
  query: CursorQuery,
  page: number,
): Promise<DashboardTasksPage | DashboardTasksCursorPage> {
  let cursor: CursorRequest["cursor"] = null;
  const requestedPageSize = query.pageSize ?? 50;
  let rowsToSkip = (page - 1) * requestedPageSize;

  while (rowsToSkip > 0) {
    const pageSize = (rowsToSkip >= 100 ? 100 : rowsToSkip >= 50 ? 50 : 25) as NonNullable<
      CursorRequest["pageSize"]
    >;
    const result = await client.tasksCursor({
      ...query,
      pageSize,
      cursor,
      direction: "next",
      count: "none",
    });
    // The requested offset is past the selection. The selection is now proven smaller than the
    // offset, so the legacy query preserves its exact empty-page response without a large scan.
    if (result.nextCursor === null) return client.tasks({ ...query, page });
    cursor = result.nextCursor;
    rowsToSkip -= pageSize;
  }

  return client.tasksCursor({
    ...query,
    cursor,
    direction: "next",
    count: "none",
  });
}
