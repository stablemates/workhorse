import {
  dashboardPageMax,
  dashboardTaskGroupPageSizes,
  dashboardTaskGroupStateFilters,
} from "@stablemates/workhorse-dashboard-server/wire";
import type { DashboardTaskGroupStateFilter } from "@stablemates/workhorse-dashboard-server/wire";

type TaskGroupPageSize = (typeof dashboardTaskGroupPageSizes)[number];

/**
 * What the task groups page shows, as the address bar states it.
 *
 * With `groupId` null the page shows the group list. Otherwise it shows that group, and `after`
 * names the member position the member page starts after. A reload or a copied link thus shows
 * the same list page or the same member page.
 */
export interface TaskGroupsLocationState {
  state: DashboardTaskGroupStateFilter;
  page: number;
  pageSize: TaskGroupPageSize;
  groupId: string | null;
  /** The position of the last member of the previous member page, or null for the first page. */
  after: number | null;
}

export const defaultTaskGroupsLocation: TaskGroupsLocationState = {
  state: "all",
  page: 1,
  pageSize: 50,
  groupId: null,
  after: null,
};

const groupIdentity = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The largest member position, `task_group_member_limit_v1()`. */
const maxMemberPosition = 100_000;

function boundedInteger(value: string | null, minimum: number, maximum: number): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= minimum && number <= maximum ? number : null;
}

/** Read the task groups state from a query string. A value out of range falls back to its default. */
export function parseTaskGroupsLocation(search: string | URLSearchParams): TaskGroupsLocationState {
  const parameters = typeof search === "string" ? new URLSearchParams(search) : search;
  const state = parameters.get("state");
  const pageSize = boundedInteger(parameters.get("pageSize"), 1, 100);
  const groupId = parameters.get("group")?.trim() ?? "";
  return {
    state: dashboardTaskGroupStateFilters.find((value) => value === state) ?? "all",
    page: boundedInteger(parameters.get("page"), 1, dashboardPageMax) ?? 1,
    pageSize: dashboardTaskGroupPageSizes.find((value) => value === pageSize) ?? 50,
    groupId: groupIdentity.test(groupId) ? groupId.toLowerCase() : null,
    after: boundedInteger(parameters.get("after"), 1, maxMemberPosition),
  };
}

/** The route and query string of one task groups state. Default values stay out of the URL. */
export function taskGroupsLocationHref(state: TaskGroupsLocationState): string {
  const parameters = new URLSearchParams();
  if (state.groupId !== null) {
    parameters.set("group", state.groupId);
    if (state.after !== null) parameters.set("after", String(state.after));
  } else {
    if (state.state !== "all") parameters.set("state", state.state);
    if (state.page !== 1) parameters.set("page", String(state.page));
  }
  if (state.pageSize !== 50) parameters.set("pageSize", String(state.pageSize));
  const query = parameters.toString();
  return query ? `/groups?${query}` : "/groups";
}

/** The request key of one task groups state, so the page reloads only when the request changes. */
export function taskGroupsListingKey(state: TaskGroupsLocationState): string {
  return taskGroupsLocationHref(state);
}
