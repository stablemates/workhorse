import type { DashboardClient } from "@stablemates/workhorse-dashboard-server";
import type { DashboardSystemWindow } from "@stablemates/workhorse-dashboard-server/wire";
import type { PageData, PageRoute } from "./core.js";
import type { RefreshRequests } from "./refresh-requests.js";
import { eventsListingKey, type EventsLocationState } from "./events-location.js";
import { taskGroupsListingKey, type TaskGroupsLocationState } from "./task-groups-location.js";
import { taskListingKey, type TaskLocationState } from "./task-location.js";
import { seekDashboardTaskPage } from "./task-page-seek.js";

/**
 * What one page load asks the server for: the route and the parameters that route reads.
 *
 * The task listing, the events feed, and the task groups list each read their own part of the
 * location. The system page reads the time window.
 */
export interface PageRequest {
  route: PageRoute;
  listing: TaskLocationState;
  events: EventsLocationState;
  groups: TaskGroupsLocationState;
  systemWindow: DashboardSystemWindow;
}

/**
 * The identity of a page load.
 *
 * The key holds only the parameters that the route reads. A change to the system window then does
 * not make the task listing look like a different request, and a cached page stays usable.
 */
export function pageRequestKey(request: PageRequest): string {
  const { route } = request;
  if (route === "/tasks") return JSON.stringify([route, taskListingKey(request.listing)]);
  if (route === "/events") return JSON.stringify([route, eventsListingKey(request.events)]);
  if (route === "/groups") return JSON.stringify([route, taskGroupsListingKey(request.groups)]);
  if (route === "/system") return JSON.stringify([route, request.systemWindow]);
  return JSON.stringify([route]);
}

/** Reads the read model of one page from the server. */
export async function fetchPageData(
  client: DashboardClient,
  request: PageRequest,
): Promise<PageData> {
  const { route } = request;
  if (route === "/tasks") {
    const { listing } = request;
    const query = {
      filter: listing.filter,
      queue: listing.queue,
      worker: listing.worker,
      taskType: listing.taskType,
      sort: listing.sort,
      tags: listing.tags,
      search: listing.search ?? undefined,
      pageSize: listing.pageSize,
    };
    return {
      route,
      value:
        listing.page > 1 && !listing.cursor
          ? await seekDashboardTaskPage(client, query, listing.page)
          : await client.tasksCursor({
              ...query,
              cursor: listing.cursor ?? null,
              direction: listing.direction ?? "next",
              count: "none",
            }),
    };
  }
  if (route === "/events") {
    const { events } = request;
    return {
      route,
      value: await client.events({
        window: events.window,
        rangeStart: events.from,
        rangeEnd: events.to,
        page: events.page,
        pageSize: events.pageSize,
        kind: events.kind,
        queue: events.queue,
        taskType: events.taskType,
        types: events.types,
        worker: events.worker,
        search: events.search,
        taskId: events.taskId,
      }),
    };
  }
  if (route === "/groups") {
    const { groups } = request;
    return {
      route,
      value:
        groups.groupId === null
          ? {
              kind: "list",
              list: await client.taskGroups({
                state: groups.state,
                page: groups.page,
                pageSize: groups.pageSize,
              }),
            }
          : {
              kind: "detail",
              detail: await client.taskGroupDetail({
                id: groups.groupId,
                after: groups.after,
                pageSize: groups.pageSize,
              }),
            },
    };
  }
  if (route === "/cron") return { route, value: await client.cron() };
  if (route === "/queues") return { route, value: await client.queues() };
  if (route === "/system") {
    return { route, value: await client.system({ window: request.systemWindow }) };
  }
  if (route === "/settings") return { route, value: await client.settings() };
  return { route: "/workers", value: await client.workers() };
}

/**
 * Read one page and keep its answer under the key of the request that asked for it.
 *
 * The caller takes the request as a value before the read starts. A fresh read can first wait
 * for a read of the same key in flight, and the operator can change the filters during that
 * wait. The read then still sends the filters of its own key, so the cache never keeps the rows
 * of one listing under the key of another. `kept` is false if a mutation made the answer old.
 */
export async function readPage<Data>({
  requests,
  cache,
  request,
  read,
  fresh = false,
}: {
  requests: Pick<RefreshRequests, "run">;
  cache: PageCache<Data>;
  request: PageRequest;
  read: (request: PageRequest) => Promise<Data>;
  fresh?: boolean;
}): Promise<{ data: Data; kept: boolean }> {
  const key = pageRequestKey(request);
  const generation = cache.generation();
  const data = await requests.run(key, () => read(request), fresh);
  return { data, kept: cache.write(key, data, generation) };
}

/** A page answer that the dashboard keeps, and when it arrived. */
interface CachedPage<Data> {
  data: Data;
  /** The ISO time of the answer. A failed refresh states this time as the age of the page. */
  refreshedAt: string;
  /** The same time in milliseconds, to judge if a prefetch is necessary. */
  receivedAt: number;
}

/**
 * The cache holds page data by default. A chart that loads its own read model, such as task
 * activity, keeps its answers in a cache of the same shape and the same rules.
 */
export interface PageCache<Data = PageData> {
  read(key: string): CachedPage<Data> | null;
  /**
   * The count of invalidations so far. A read notes it when it starts, and `write` compares it,
   * so an answer that a mutation made old never enters the cache.
   */
  generation(): number;
  /**
   * Keep the answer of a read that started in `startedIn`. The cache drops the answer and returns
   * false if an invalidation came after the read started.
   */
  write(key: string, data: Data, startedIn: number, now?: number): boolean;
  /** True if the cache has an answer for `key` that is younger than `maxAgeMs`. */
  holdsFresh(key: string, maxAgeMs: number, now?: number): boolean;
  /** Drop every answer, and the answers of the reads that are in flight now. */
  invalidate(): void;
}

/**
 * The last answer of each page load, in memory.
 *
 * A click on a page that the operator saw before, or that the dashboard prefetched, shows this
 * answer at once while a refresh runs. The shell makes one cache for each dashboard client, and
 * each workspace has its own client, so an answer from one workspace never shows in another.
 * The cache keeps the `limit` most recently written answers. A mutation can change what every
 * page shows, so the shell invalidates the cache after each mutation.
 */
export function createPageCache<Data = PageData>(limit = 32): PageCache<Data> {
  const entries = new Map<string, CachedPage<Data>>();
  let generation = 0;
  return {
    read(key) {
      return entries.get(key) ?? null;
    },
    generation() {
      return generation;
    },
    write(key, data, startedIn, now = Date.now()) {
      if (startedIn !== generation) return false;
      entries.delete(key);
      entries.set(key, { data, refreshedAt: new Date(now).toISOString(), receivedAt: now });
      for (const oldest of entries.keys()) {
        if (entries.size <= limit) break;
        entries.delete(oldest);
      }
      return true;
    },
    holdsFresh(key, maxAgeMs, now = Date.now()) {
      const entry = entries.get(key);
      return entry !== undefined && now - entry.receivedAt < maxAgeMs;
    },
    invalidate() {
      generation += 1;
      entries.clear();
    },
  };
}
