import { dashboardAttemptOutcomes, dashboardJobEventTypes } from "./presentation.js";
import type {
  DashboardEventKind,
  DashboardEventsWindow,
  DashboardEventTypeFilter,
} from "@stablemates/workhorse-dashboard-server/wire";

const eventPageSizes = [25, 50, 100] as const;
type EventPageSize = (typeof eventPageSizes)[number];
type EventsKindFilter = DashboardEventKind | "all";

export interface EventsLocationState {
  window: DashboardEventsWindow;
  page: number;
  pageSize: EventPageSize;
  kind: EventsKindFilter;
  queue: string | null;
  jobType: string | null;
  types: DashboardEventTypeFilter[];
  /** The history record shown in the drawer, encoded as `kind:recordId`. */
  eventId: string | null;
}

export const defaultEventsLocation: EventsLocationState = {
  window: "1h",
  page: 1,
  pageSize: 50,
  kind: "all",
  queue: null,
  jobType: null,
  types: [],
  eventId: null,
};

const windows = new Set<DashboardEventsWindow>(["15m", "1h", "6h", "24h"]);
const kinds = new Set<EventsKindFilter>(["all", "event", "attempt"]);
const eventTypes = new Set<string>([...dashboardJobEventTypes, ...dashboardAttemptOutcomes]);

/**
 * True when a value names an event type or attempt outcome the feed can filter by.
 *
 * The browser widgets and the query string both hand back plain strings, and this is where such a
 * string becomes a filter the client is allowed to send.
 */
export function isEventTypeFilter(value: string): value is DashboardEventTypeFilter {
  return eventTypes.has(value);
}

function optionalValue(parameters: URLSearchParams, key: string): string | null {
  return parameters.get(key)?.trim() || null;
}

export function parseEventsLocation(search: string | URLSearchParams): EventsLocationState {
  const parameters =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : search;
  const requestedWindow = optionalValue(parameters, "window") as DashboardEventsWindow | null;
  const requestedKind = optionalValue(parameters, "source") as EventsKindFilter | null;
  const requestedPage = Number(parameters.get("page") ?? "1");
  const requestedPageSize = Number(parameters.get("per") ?? "50");
  const requestedEventId = optionalValue(parameters, "event");
  const types = (parameters.get("events") ?? "")
    .split(",")
    .map((type) => type.trim())
    .filter(
      (type, index, values): type is DashboardEventTypeFilter =>
        isEventTypeFilter(type) && values.indexOf(type) === index,
    );

  return {
    window: requestedWindow && windows.has(requestedWindow) ? requestedWindow : "1h",
    kind: requestedKind && kinds.has(requestedKind) ? requestedKind : "all",
    queue: optionalValue(parameters, "queue"),
    jobType: optionalValue(parameters, "type"),
    types,
    page: Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    pageSize: eventPageSizes.includes(requestedPageSize as EventPageSize)
      ? (requestedPageSize as EventPageSize)
      : 50,
    eventId:
      requestedEventId && /^(event|attempt):\d+$/.test(requestedEventId) ? requestedEventId : null,
  };
}

export function eventsLocationHref(state: EventsLocationState): string {
  const parameters = new URLSearchParams();
  if (state.window !== "1h") parameters.set("window", state.window);
  if (state.kind !== "all") parameters.set("source", state.kind);
  if (state.queue) parameters.set("queue", state.queue);
  if (state.jobType) parameters.set("type", state.jobType);
  if (state.types.length > 0) parameters.set("events", state.types.join(","));
  if (state.page > 1) parameters.set("page", String(state.page));
  if (state.pageSize !== 50) parameters.set("per", String(state.pageSize));
  if (state.eventId) parameters.set("event", state.eventId);
  const query = parameters.toString();
  return query ? `/events?${query}` : "/events";
}

/** Drawer selection is deliberately excluded so opening a row does not reload the listing. */
export function eventsListingKey(state: EventsLocationState): string {
  return JSON.stringify([
    state.window,
    state.page,
    state.pageSize,
    state.kind,
    state.queue,
    state.jobType,
    state.types,
  ]);
}
