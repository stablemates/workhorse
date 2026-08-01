import type { DashboardTaskFilter } from "./model.js";

export const taskPageSizes = [25, 50, 100] as const;
export type TaskPageSize = (typeof taskPageSizes)[number];
export type TaskActivityPeriod = "15m" | "1h" | "6h" | "24h" | "7d";
export type TaskActivityGroup = "queue" | "worker" | "task" | "status";

export interface TaskLocationState {
  filter: DashboardTaskFilter;
  queue: string | null;
  worker: string | null;
  jobType: string | null;
  tags: string[];
  search: string | null;
  page: number;
  pageSize: TaskPageSize;
  period: TaskActivityPeriod;
  group: TaskActivityGroup;
}

const filters = new Set<DashboardTaskFilter>([
  "all",
  "scheduled",
  "retried",
  "queued",
  "running",
  "completed",
  "discarded",
]);

function optionalValue(parameters: URLSearchParams, key: string): string | null {
  return parameters.get(key)?.trim() || null;
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
  const tags = (parameters.get("tags") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(
      (tag, index, values) => tag.length > 0 && tag.length <= 100 && values.indexOf(tag) === index,
    )
    .slice(0, 20);

  return {
    filter: requestedFilter && filters.has(requestedFilter) ? requestedFilter : "all",
    queue: optionalValue(parameters, "queue"),
    worker: optionalValue(parameters, "worker"),
    jobType: optionalValue(parameters, "type"),
    tags,
    search: optionalValue(parameters, "q"),
    page: Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    pageSize: taskPageSizes.includes(requestedPageSize as TaskPageSize)
      ? (requestedPageSize as TaskPageSize)
      : 50,
    period: ["15m", "1h", "6h", "24h", "7d"].includes(requestedPeriod ?? "")
      ? requestedPeriod!
      : (defaults.period ?? "1h"),
    group: ["queue", "worker", "task", "status"].includes(requestedGroup ?? "")
      ? requestedGroup!
      : (defaults.group ?? "queue"),
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
  if (state.page > 1) parameters.set("page", String(state.page));
  if (state.pageSize !== 50) parameters.set("per", String(state.pageSize));
  if (state.period !== "1h") parameters.set("period", state.period);
  if (state.group !== "queue") parameters.set("group", state.group);
  const query = parameters.toString();
  return query ? `/tasks?${query}` : "/tasks";
}
