import {
  dashboardTaskFilters,
  dashboardTaskSorts,
  type DashboardTaskFilter,
  type DashboardTaskSort,
} from "@workhorse-js/dashboard-server/wire";

export const taskPageSizes = [25, 50, 100] as const;
export type TaskPageSize = (typeof taskPageSizes)[number];
export type TaskActivityPeriod = "15m" | "1h" | "6h" | "24h" | "7d";
export type TaskActivityGroup = "queue" | "worker" | "task" | "status";

export interface TaskLocationState {
  filter: DashboardTaskFilter;
  queue: string | null;
  worker: string | null;
  jobType: string | null;
  sort: DashboardTaskSort;
  tags: string[];
  search: string | null;
  page: number;
  pageSize: TaskPageSize;
  period: TaskActivityPeriod;
  group: TaskActivityGroup;
  /**
   * The task whose detail drawer is open, so an opened drawer is part of the shareable URL.
   *
   * It is deliberately separate from the listing parameters: the drawer is a view onto one task,
   * not a narrowing of the list, so copying the URL restores both the same list and the same
   * open task, and closing the drawer leaves every filter and the page number untouched.
   */
  taskId: string | null;
}

const filters = new Set<DashboardTaskFilter>(dashboardTaskFilters);
const sorts = new Set<DashboardTaskSort>(dashboardTaskSorts);

function optionalValue(parameters: URLSearchParams, key: string): string | null {
  return parameters.get(key)?.trim() || null;
}

/**
 * How a change of the open task should enter browser history.
 *
 * Opening the drawer from a closed list is the one step an operator expects Back to undo, so it
 * pushes. Clicking from one task to the next is a swap inside the panel that is already open, and
 * closing is a dismissal, so both replace: otherwise Back would walk the operator through every
 * task they glanced at, and Forward would re-open a panel they deliberately dismissed.
 */
export type TaskDetailNavigation = "push" | "replace";

export function taskDetailNavigation(
  previousTaskId: string | null,
  nextTaskId: string | null,
): TaskDetailNavigation {
  return previousTaskId === null && nextTaskId !== null ? "push" : "replace";
}

export function parseTaskLocation(
  search: string | URLSearchParams,
  defaults: { period?: TaskActivityPeriod; group?: TaskActivityGroup } = {},
): TaskLocationState {
  const parameters =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : search;
  const requestedFilter = optionalValue(parameters, "filter") as DashboardTaskFilter | null;
  const requestedPage = Number(parameters.get("page") ?? "1");
  const requestedPageSize = Number(parameters.get("per") ?? "50");
  const requestedPeriod = optionalValue(parameters, "period") as TaskActivityPeriod | null;
  const requestedGroup = optionalValue(parameters, "group") as TaskActivityGroup | null;
  const requestedSort = optionalValue(parameters, "sort") as DashboardTaskSort | null;
  const tags = (parameters.get("tags") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(
      (tag, index, values) => tag.length > 0 && tag.length <= 100 && values.indexOf(tag) === index,
    )
    .slice(0, 20);
  const requestedTaskId = optionalValue(parameters, "task");

  return {
    filter: requestedFilter && filters.has(requestedFilter) ? requestedFilter : "all",
    queue: optionalValue(parameters, "queue"),
    worker: optionalValue(parameters, "worker"),
    jobType: optionalValue(parameters, "type"),
    sort: requestedSort && sorts.has(requestedSort) ? requestedSort : "updated",
    tags,
    search: optionalValue(parameters, "q"),
    // A hand-edited or truncated id is answered by the drawer's own load error, but an
    // unbounded value would be carried into every link this dashboard builds.
    taskId: requestedTaskId && requestedTaskId.length <= 200 ? requestedTaskId : null,
    page: Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    pageSize: taskPageSizes.includes(requestedPageSize as TaskPageSize)
      ? (requestedPageSize as TaskPageSize)
      : 50,
    period: ["15m", "1h", "6h", "24h", "7d"].includes(requestedPeriod ?? "")
      ? requestedPeriod!
      : (defaults.period ?? "1h"),
    group: ["queue", "worker", "task", "status"].includes(requestedGroup ?? "")
      ? requestedGroup!
      : (defaults.group ?? "task"),
  };
}

export function taskLocationHref(state: TaskLocationState): string {
  const parameters = new URLSearchParams();
  if (state.filter !== "all") parameters.set("filter", state.filter);
  if (state.tags.length > 0) parameters.set("tags", state.tags.join(","));
  if (state.search) parameters.set("q", state.search);
  if (state.queue) parameters.set("queue", state.queue);
  if (state.worker) parameters.set("worker", state.worker);
  if (state.jobType) parameters.set("type", state.jobType);
  if (state.sort !== "updated") parameters.set("sort", state.sort);
  if (state.page > 1) parameters.set("page", String(state.page));
  if (state.pageSize !== 50) parameters.set("per", String(state.pageSize));
  if (state.period !== "1h") parameters.set("period", state.period);
  if (state.group !== "task") parameters.set("group", state.group);
  if (state.taskId) parameters.set("task", state.taskId);
  const query = parameters.toString();
  return query ? `/tasks?${query}` : "/tasks";
}

/**
 * Everything the task listing request depends on, as one comparable string.
 *
 * Opening, switching, and closing the drawer all rewrite the URL, and the list behind the panel
 * must not refetch or flash a loader for any of them. Deriving the fetch from this key rather
 * than from the location object states exactly which parameters are a different list, and leaves
 * the drawer id, the chart period, and the chart grouping out of it.
 */
export function taskListingKey(state: TaskLocationState): string {
  return JSON.stringify([
    state.filter,
    state.queue,
    state.worker,
    state.jobType,
    state.tags,
    state.search,
    state.sort,
    state.page,
    state.pageSize,
  ]);
}
