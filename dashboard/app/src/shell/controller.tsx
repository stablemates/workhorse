import { createRefreshRequests } from "../refresh-requests.js";
import {
  createDashboardPollingClock,
  createDashboardRefreshResumePolicy,
  dashboardAutoRefreshPaused,
  dashboardRefreshIntervalMs,
  dashboardRefreshIntervals,
  defaultDashboardRefreshInterval,
  discardBackgroundRefresh,
  type DashboardRefreshIntervalValue,
} from "../refresh-policy.js";
import type { DashboardDemoTools } from "@stablemates/workhorse-dashboard-server";
import {
  dashboardRefreshBlockers,
  useRefreshBlocker,
  useRefreshBlockers,
} from "../refresh-blockers.js";
import { useDisclosure } from "@mantine/hooks";
import {
  useCallback,
  useEffect,
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type {
  DashboardEventDetail,
  DashboardEventRow,
  DashboardTaskDetail,
  DashboardSystemWindow,
  DashboardTaskCounts,
} from "@stablemates/workhorse-dashboard-server/wire";
import { createLatestRequestGuard, taskDrawerOpened, taskDrawerSync } from "../task-drawer.js";
import {
  defaultEventsLocation,
  eventsListingKey,
  eventsLocationHref,
  type EventsLocationState,
} from "../events-location.js";
import { taskDetailNavigation, taskListingKey } from "../task-location.js";
import { notifyDashboard, notifyEnqueueTest, notifyFailure } from "../notifications.js";
import type { MaintenancePolicyDefinition, MaintenancePolicySetting } from "@stablemates/workhorse";
import { requestRunNow, type RunNowFeedback } from "../run-now.js";
import { Button, Center, Loader, Stack, Text } from "@mantine/core";
import { WarningCircle } from "@phosphor-icons/react";
import {
  DemoTaskKind,
  LoadState,
  PageData,
  PageRoute,
  mountedHref,
  readLocation,
  readStoredSystemWindow,
  systemWindowStorageKey,
  systemWindows,
  taskHref,
  useDashboardClient,
} from "../core.js";
import { subscribeTimeZone } from "../preferences.js";
import type { DemoTaskOptions } from "../pages/tasks.js";

const TasksPage = lazy(() =>
  import("../pages/tasks.js").then((module) => ({ default: module.TasksPage })),
);
const EventsPage = lazy(() =>
  import("../pages/events.js").then((module) => ({ default: module.EventsPage })),
);
const CronPage = lazy(() =>
  import("../pages/schedules.js").then((module) => ({ default: module.CronPage })),
);
const QueuesPage = lazy(() =>
  import("../pages/queues.js").then((module) => ({ default: module.QueuesPage })),
);
const SystemPage = lazy(() =>
  import("../pages/overview.js").then((module) => ({ default: module.SystemPage })),
);
const WorkersPage = lazy(() =>
  import("../pages/workers.js").then((module) => ({ default: module.WorkersPage })),
);
const SettingsPage = lazy(() =>
  import("../pages/settings/index.js").then((module) => ({ default: module.SettingsPage })),
);

export const refreshStorageKey = "workhorse-auto-refresh";
export function readStoredRefreshInterval(): DashboardRefreshIntervalValue {
  const stored = localStorage.getItem(refreshStorageKey);
  return dashboardRefreshIntervals.some((option) => option.value === stored)
    ? (stored as DashboardRefreshIntervalValue)
    : defaultDashboardRefreshInterval;
}
export function routeTitle(route: PageRoute): string {
  if (route === "/events") return "events";
  if (route === "/cron") return "schedules";
  if (route === "/queues") return "queues";
  if (route === "/system") return "system health";
  if (route === "/workers") return "workers";
  if (route === "/settings") return "settings";
  return "current tasks";
}
export function useDashboardController(
  auditActor: string,
  demoTools: DashboardDemoTools | null,
  basePath: string,
) {
  const client = useDashboardClient();
  const refreshBlockers = useRefreshBlockers();
  const refreshRequests = useMemo(() => createRefreshRequests(), [client]);
  const [navbarOpened, { toggle: toggleNavbar, close: closeNavbar }] = useDisclosure();
  // Timestamps format through module-level displayTimeZone; re-render everything on change.
  const [, setTimeZoneTick] = useState(0);
  useEffect(() => subscribeTimeZone(() => setTimeZoneTick((tick) => tick + 1)), []);
  const [location, setLocation] = useState(() => readLocation(basePath));
  const [loadState, setLoadState] = useState<LoadState>({
    status: "loading",
    data: null,
    error: null,
  });
  const [taskCounts, setTaskCounts] = useState<DashboardTaskCounts | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void client
      .meta()
      .then((meta) => {
        if (!cancelled) setEnvironment(meta.environment);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);
  const [runningDemoTask, setRunningDemoTask] = useState<DemoTaskKind | null>(null);
  const [togglingSchedule, setTogglingSchedule] = useState<string | null>(null);
  const [togglingQueue, setTogglingQueue] = useState<string | null>(null);
  const [purgingQueue, setPurgingQueue] = useState<string | null>(null);
  const [confirmingQueue, setConfirmingQueue] = useState<string | null>(null);
  const [togglingWorker, setTogglingWorker] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  /**
   * The open task is read from the URL rather than held beside it, so a copied or reloaded link
   * restores the same list and the same open drawer, and Back/Forward can only ever agree with
   * what is on screen.
   */
  const selectedTaskId = location.route === "/tasks" ? location.taskId : null;
  useRefreshBlocker(taskDrawerOpened(selectedTaskId), dashboardRefreshBlockers.taskDrawer);
  const selectedEventId = location.route === "/events" ? location.events.eventId : null;
  const [inspectedEvent, setInspectedEvent] = useState<DashboardEventDetail | null>(null);
  const [eventDetailError, setEventDetailError] = useState<string | null>(null);
  const eventDetailRequests = useRef(createLatestRequestGuard());
  const selectedEventIdRef = useRef<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<DashboardTaskDetail | null>(null);
  const [taskDetailError, setTaskDetailError] = useState<string | null>(null);
  /**
   * Which task detail load may still write to the drawer.
   *
   * Clicking task A then task B leaves two requests racing for the same panel, and the slower
   * one is not necessarily the older one, so the drawer only accepts the newest claim.
   */
  const taskDetailRequests = useRef(createLatestRequestGuard());
  /**
   * The task the drawer is showing right now, readable from an async callback.
   *
   * `selectedTaskId` is what renders, but a callback that awaited the server closed over the
   * value from the render that started it, which is exactly the stale answer these guards must
   * not trust. This ref is written at the same moment the selection changes.
   */
  const selectedTaskIdRef = useRef<string | null>(null);
  const [refreshInterval, setRefreshInterval] =
    useState<DashboardRefreshIntervalValue>(readStoredRefreshInterval);
  const [resumeCountdown, setResumeCountdown] = useState<number | null>(null);
  const refreshResumePolicy = useMemo(
    () => createDashboardRefreshResumePolicy(setResumeCountdown),
    [],
  );
  const pollingClock = useMemo(() => createDashboardPollingClock(() => undefined), []);
  const [refreshScheduleResetKey, setRefreshScheduleResetKey] = useState(0);
  const resetRefreshSchedule = useCallback(() => setRefreshScheduleResetKey((key) => key + 1), []);
  const eventsQuery = location.events;
  const [systemWindow, setSystemWindow] = useState<DashboardSystemWindow>(() => {
    const initial = readLocation(basePath);
    return initial.route === "/system" &&
      systemWindows.includes(initial.period as DashboardSystemWindow)
      ? (initial.period as DashboardSystemWindow)
      : readStoredSystemWindow();
  });
  const changeSystemWindow = useCallback(
    (nextWindow: DashboardSystemWindow) => {
      setSystemWindow(nextWindow);
      localStorage.setItem(systemWindowStorageKey, nextWindow);
      const parameters = new URLSearchParams(window.location.search);
      if (nextWindow === "1h") parameters.delete("period");
      else parameters.set("period", nextWindow);
      const query = parameters.toString();
      const href = query ? `/system?${query}` : "/system";
      window.history.pushState(null, "", mountedHref(basePath, href));
      setLocation(readLocation(basePath));
    },
    [basePath],
  );
  const changeRefreshInterval = useCallback((value: DashboardRefreshIntervalValue) => {
    setRefreshInterval(value);
    localStorage.setItem(refreshStorageKey, value);
  }, []);
  const requestId = useRef(0);
  const shouldDiscardBackgroundRefresh = useCallback(
    (background: boolean) => discardBackgroundRefresh(background, refreshBlockers.isBlocked()),
    [refreshBlockers.isBlocked],
  );

  const navigate = useCallback(
    (href: string) => {
      window.history.pushState(null, "", mountedHref(basePath, href));
      setLocation(readLocation(basePath));
      closeNavbar();
    },
    [basePath, closeNavbar],
  );
  const replace = useCallback(
    (href: string) => {
      window.history.replaceState(null, "", mountedHref(basePath, href));
      setLocation(readLocation(basePath));
    },
    [basePath],
  );
  const setEventsQuery = useCallback(
    (next: EventsLocationState) => navigate(eventsLocationHref(next)),
    [navigate],
  );
  const taskEventsHref = useCallback(
    (taskId: string) =>
      mountedHref(basePath, eventsLocationHref({ ...defaultEventsLocation, taskId })),
    [basePath],
  );

  const handleLink = useCallback(
    (event: MouseEvent<HTMLElement>, href: string) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      navigate(href);
    },
    [navigate],
  );

  /**
   * What the task listing request is made of, separated from the rest of the location.
   *
   * Opening, switching, and closing the drawer all rewrite the URL, and the list behind the
   * panel must not refetch or flash a loader for any of them, so the page load is keyed on the
   * listing parameters instead of on the location object.
   */
  const { route } = location;
  const listingKey = taskListingKey(location);
  const listingRef = useRef(location);
  listingRef.current = location;
  // The events feed follows the same shape as the task listing: the request is keyed on a
  // serialized copy of the filters, and the values themselves are read from a ref at send time.
  const eventsKey = eventsListingKey(eventsQuery);
  const eventsRef = useRef(eventsQuery);
  eventsRef.current = eventsQuery;

  const loadPage = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      if (shouldDiscardBackgroundRefresh(background)) return;
      const key = JSON.stringify([route, listingKey, systemWindow, eventsKey]);
      if (background && refreshRequests.has(key)) return;
      const activeRequest = ++requestId.current;
      if (!background) {
        setLoadState((current) => ({
          status: "loading",
          data: current.data,
          error: null,
        }));
      }
      try {
        const data = await refreshRequests.run(
          key,
          async () => {
            let pageData: PageData;
            if (route === "/tasks") {
              const listing = listingRef.current;
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
              pageData = {
                route: "/tasks",
                value:
                  listing.page > 1 && !listing.cursor
                    ? await client.tasks({ ...query, page: listing.page })
                    : await client.tasksCursor({
                        ...query,
                        cursor: listing.cursor ?? null,
                        direction: listing.direction ?? "next",
                        count: "none",
                      }),
              };
            } else if (route === "/events") {
              const events = eventsRef.current;
              pageData = {
                route: "/events",
                value: await client.events({
                  window: events.window,
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
            } else if (route === "/cron") {
              pageData = { route: "/cron", value: await client.cron() };
            } else if (route === "/queues") {
              pageData = { route: "/queues", value: await client.queues() };
            } else if (route === "/system") {
              pageData = {
                route: "/system",
                value: await client.system({ window: systemWindow }),
              };
            } else if (route === "/settings") {
              pageData = { route: "/settings", value: await client.settings() };
            } else {
              pageData = {
                route: "/workers",
                value: await client.workers(),
              };
            }
            return pageData;
          },
          !background,
        );
        if (activeRequest === requestId.current) {
          if (!shouldDiscardBackgroundRefresh(background)) {
            setLoadState({ status: "ready", data, error: null });
          }
        }
      } catch (cause) {
        if (activeRequest === requestId.current) {
          if (!shouldDiscardBackgroundRefresh(background)) {
            setLoadState((current) => ({
              status: "error",
              data: current.data,
              error: cause instanceof Error ? cause.message : "Workhorse could not load this page",
            }));
          }
        }
      }
      // `listingKey` is the dependency the task listing actually has; the values themselves are
      // read from a ref so that a re-render for an unrelated reason cannot send a stale request.
    },
    [
      client,
      route,
      listingKey,
      systemWindow,
      eventsKey,
      shouldDiscardBackgroundRefresh,
      refreshRequests,
    ],
  );

  const loadTaskCounts = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      if (shouldDiscardBackgroundRefresh(background)) return;
      try {
        const counts = await refreshRequests.run("taskCounts", () => client.taskCounts());
        if (!shouldDiscardBackgroundRefresh(background)) setTaskCounts(counts);
      } catch {
        // The active page owns the connection state; keep the last navigation counts on failure.
      }
    },
    [client, shouldDiscardBackgroundRefresh, refreshRequests],
  );

  const toggleSchedule = useCallback(
    async (namespace: string, name: string, enabled: boolean) => {
      const scheduleKey = `${namespace}:${name}`;
      setTogglingSchedule(scheduleKey);
      try {
        await client.setScheduleEnabled({
          kind: "user",
          namespace,
          name,
          enabled,
          audit: {
            actor: auditActor,
            reason: `${enabled ? "Enable" : "Disable"} ${namespace}/${name} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        notifyDashboard({
          title: enabled ? "Schedule enabled" : "Schedule disabled",
          message: enabled
            ? `${scheduleKey} fires again from its next occurrence.`
            : `${scheduleKey} stopped firing. Occurrences already enqueued are untouched.`,
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Schedule not updated", cause, "Workhorse could not update the schedule");
      } finally {
        setTogglingSchedule(null);
      }
    },
    [auditActor, client, loadPage],
  );

  const toggleQueue = useCallback(
    async (queue: string, paused: boolean) => {
      setTogglingQueue(queue);
      try {
        await client.setQueuePaused({
          queue,
          paused,
          audit: {
            actor: auditActor,
            reason: `${paused ? "Pause" : "Resume"} ${queue} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        notifyDashboard({
          title: paused ? "Queue paused" : "Queue resumed",
          message: paused
            ? `${queue} stopped accepting tasks. Active tasks can finish.`
            : `${queue} is dispatching again.`,
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Queue not updated", cause, "Workhorse could not update the queue");
      } finally {
        setTogglingQueue(null);
      }
    },
    [auditActor, client, loadPage],
  );

  const clearQueue = useCallback(
    async (queue: string) => {
      setPurgingQueue(queue);
      try {
        const result = await client.purgeQueue({
          queue,
          audit: {
            actor: auditActor,
            reason: `Clear queued work from ${queue} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        setConfirmingQueue(null);
        notifyDashboard({
          title: "Queue cleared",
          message: `Cleared ${result.deletedCount} queued ${
            result.deletedCount === 1 ? "task" : "tasks"
          } from ${queue}.`,
          tone: result.deletedCount > 0 ? "success" : "neutral",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Queue not cleared", cause, "Workhorse could not clear the queue");
      } finally {
        setPurgingQueue(null);
      }
    },
    [auditActor, client, loadPage],
  );

  const toggleWorker = useCallback(
    async (workerId: string, paused: boolean) => {
      setTogglingWorker(workerId);
      try {
        await client.setWorkerPaused({
          workerId,
          paused,
          audit: {
            actor: auditActor,
            reason: `${paused ? "Pause" : "Resume"} ${workerId} from the dashboard`,
            requestId: crypto.randomUUID(),
          },
        });
        notifyDashboard({
          title: paused ? "Worker paused" : "Worker resumed",
          message: paused
            ? `${workerId} stopped accepting tasks but will finish active tasks. If the process restarts, it resumes automatically.`
            : `${workerId} is accepting tasks again.`,
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Worker not updated", cause, "Workhorse could not update the worker");
      } finally {
        setTogglingWorker(null);
      }
    },
    [auditActor, client, loadPage],
  );

  const saveMaintenanceSettings = useCallback(
    async (definition: Partial<MaintenancePolicyDefinition>) => {
      setSavingSettings(true);
      try {
        await client.overrideMaintenancePolicy({
          definition,
          audit: {
            actor: auditActor,
            reason: "Update maintenance policy from the dashboard",
            requestId: crypto.randomUUID(),
          },
        });
        notifyDashboard({
          title: "Maintenance policy updated",
          message: "Every worker now uses the database-owned policy.",
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure(
          "Maintenance policy not updated",
          cause,
          "Workhorse rejected the maintenance policy",
        );
      } finally {
        setSavingSettings(false);
      }
    },
    [auditActor, client, loadPage],
  );
  const revertMaintenanceSetting = useCallback(
    async (setting: MaintenancePolicySetting) => {
      try {
        await client.revertMaintenancePolicy({
          settings: [setting],
          audit: {
            actor: auditActor,
            reason: `Revert ${setting} to the application default`,
            requestId: crypto.randomUUID(),
          },
        });
        await loadPage();
      } catch (cause) {
        notifyFailure(
          "Setting not reverted",
          cause,
          "Workhorse could not restore the application default",
        );
      }
    },
    [auditActor, client, loadPage],
  );

  /**
   * Show one task in the drawer and load its detail.
   *
   * This is driven by the URL rather than called from the click handler, so a deep link, a
   * reload, and Back all reach the drawer through the same path as a click and cannot disagree
   * with the address bar.
   */
  const showTaskDetail = useCallback(
    async (id: string) => {
      // Claim the drawer before the await, so a later click wins even if this request
      // resolves after it.
      const ticket = taskDetailRequests.current.begin();
      selectedTaskIdRef.current = id;
      setSelectedTask(null);
      setTaskDetailError(null);
      try {
        const detail = await client.taskDetail({ id });
        if (!taskDetailRequests.current.current(ticket)) return;
        setSelectedTask(detail);
      } catch (cause) {
        if (!taskDetailRequests.current.current(ticket)) return;
        setTaskDetailError(
          cause instanceof Error ? cause.message : "Workhorse could not load the task",
        );
      }
    },
    [client],
  );
  const reloadSelectedTask = useCallback(async () => {
    if (selectedTaskIdRef.current) await showTaskDetail(selectedTaskIdRef.current);
  }, [showTaskDetail]);
  const reloadTasks = useCallback(async () => {
    await loadPage();
    await reloadSelectedTask();
  }, [loadPage, reloadSelectedTask]);

  /**
   * Empty the drawer and abandon any detail load still in flight.
   *
   * Without dropping the claim, a request that arrives after the operator closed the panel would
   * set detail or an error and reopen it on a task they already dismissed.
   */
  const clearTaskDetail = useCallback(() => {
    taskDetailRequests.current.cancel();
    selectedTaskIdRef.current = null;
    setSelectedTask(null);
    setTaskDetailError(null);
  }, []);

  /**
   * Move the open task into the address bar; the drawer follows from there.
   *
   * Writing the URL first, and letting one effect reconcile the drawer with it, is what makes
   * every route into the drawer behave alike: a click, a pasted link, a reload, and Back all end
   * as the same `task` parameter. Opening pushes so Back closes the panel, while swapping tasks
   * and closing replace, so history does not fill with every task the operator glanced at.
   */
  const selectTask = useCallback(
    (id: string | null) => {
      if (id === location.taskId) return;
      const href = taskHref({ ...location, taskId: id });
      if (taskDetailNavigation(location.taskId, id) === "push") navigate(href);
      else replace(href);
    },
    [location, navigate, replace],
  );

  const inspectTask = useCallback((id: string) => selectTask(id), [selectTask]);
  const closeTaskDetail = useCallback(() => selectTask(null), [selectTask]);

  const runDemoTask = useCallback(
    async (kind: DemoTaskKind, options: DemoTaskOptions = {}) => {
      const { scenario, feature } = options;
      setRunningDemoTask(kind);
      try {
        if (!demoTools) return;
        const enqueued = await demoTools.enqueueTest({
          kind,
          ...(scenario ? { scenario } : {}),
          ...(feature ? { feature } : {}),
          priority: 0,
          audit: {
            actor: auditActor,
            reason: `Demonstrate the ${feature ?? scenario ?? kind} execution path`,
            requestId: crypto.randomUUID(),
          },
        });
        // A keyed kind may replay to a task that predates this click, so the answer names what
        // happened and offers the task it resolved to rather than only refreshing the listing.
        notifyEnqueueTest(enqueued, { openTask: inspectTask });
        if (location.filter !== "all" || location.page !== 1) navigate("/tasks");
        await loadPage();
      } catch (cause) {
        notifyFailure("Demo task not enqueued", cause, "Workhorse could not enqueue the demo task");
      } finally {
        setRunningDemoTask(null);
      }
    },
    [auditActor, demoTools, inspectTask, loadPage, location.filter, location.page, navigate],
  );
  const inspectEvent = useCallback(
    (event: DashboardEventRow) => {
      const next = { ...location.events, eventId: event.id };
      if (taskDetailNavigation(location.events.eventId, event.id) === "push") {
        navigate(eventsLocationHref(next));
      } else {
        replace(eventsLocationHref(next));
      }
    },
    [location.events, navigate, replace],
  );
  const closeEventDetail = useCallback(() => {
    eventDetailRequests.current.cancel();
    selectedEventIdRef.current = null;
    setInspectedEvent(null);
    setEventDetailError(null);
    replace(eventsLocationHref({ ...location.events, eventId: null }));
  }, [location.events, replace]);

  const showEventDetail = useCallback(
    async (id: string) => {
      const ticket = eventDetailRequests.current.begin();
      selectedEventIdRef.current = id;
      setInspectedEvent(null);
      setEventDetailError(null);
      try {
        const detail = await client.eventDetail({ id });
        if (eventDetailRequests.current.current(ticket)) setInspectedEvent(detail);
      } catch (cause) {
        if (!eventDetailRequests.current.current(ticket)) return;
        setEventDetailError(cause instanceof Error ? cause.message : "Unable to load the event");
      }
    },
    [client],
  );

  /**
   * The single reconciliation between the URL and the drawer.
   *
   * It runs for every way the address can change (click, deep link, reload, popstate) and does
   * nothing when the drawer already shows the requested task, so re-rendering for an unrelated
   * reason cannot restart a load or discard one in flight. Leaving the task list also closes the
   * drawer, because no other route carries a `task` parameter.
   *
   * It is a layout effect because the drawer contents would otherwise be one paint behind the
   * URL: clicking from task A to task B renders once with the new address and A's detail still
   * mounted, showing the operator A's payload, A's outcome, and A's cancel controls under B's
   * heading. Running before paint means no frame ever shows a task the URL no longer names.
   */
  useLayoutEffect(() => {
    const requested = location.route === "/tasks" ? location.taskId : null;
    const sync = taskDrawerSync(requested, selectedTaskIdRef.current);
    if (sync === "close") clearTaskDetail();
    else if (sync === "open") void showTaskDetail(requested!);
  }, [location.route, location.taskId, clearTaskDetail, showTaskDetail]);

  useLayoutEffect(() => {
    const requested = location.route === "/events" ? location.events.eventId : null;
    const sync = taskDrawerSync(requested, selectedEventIdRef.current);
    if (sync === "close") {
      eventDetailRequests.current.cancel();
      selectedEventIdRef.current = null;
      setInspectedEvent(null);
      setEventDetailError(null);
    } else if (sync === "open") {
      void showEventDetail(requested!);
    }
  }, [location.route, location.events.eventId, showEventDetail]);

  /**
   * Release one scheduled task so a worker can claim it now.
   *
   * The reported status is exactly what the server did, so the list can distinguish a task that was
   * actually released from one that was already queued and from one refused because it is parked at
   * a durable wait. The list is reloaded afterwards rather than optimistically edited, because
   * whether the task is now ready is a durable fact this dashboard does not get to guess.
   *
   * Null when the host does not expose the mutation, which the row menu states as the reason the
   * action is unavailable rather than hiding the item.
   */
  const runTaskNow = useMemo(() => {
    if (!client.runTaskNow) return null;
    return async (id: string): Promise<RunNowFeedback> => {
      const feedback = await requestRunNow(client, {
        id,
        auditActor,
        requestId: crypto.randomUUID(),
      });
      // Reloaded on every outcome: a refusal is still a statement about durable state this list
      // should be showing, and a released task has already changed row.
      await loadPage();
      await reloadSelectedTask();
      return feedback;
    };
  }, [auditActor, client, loadPage, reloadSelectedTask]);

  useEffect(() => {
    const onPopState = () => {
      const next = readLocation(basePath);
      setLocation(next);
      if (
        next.route === "/system" &&
        systemWindows.includes(next.period as DashboardSystemWindow)
      ) {
        setSystemWindow(next.period as DashboardSystemWindow);
      }
      closeNavbar();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [closeNavbar]);

  useEffect(() => {
    void loadPage();
    void loadTaskCounts();
  }, [loadPage, loadTaskCounts]);

  const refreshBlocked = refreshBlockers.blocked;
  const previousRefreshBlocked = useRef(refreshBlocked);
  const refreshWasBlocked = previousRefreshBlocked.current;
  useEffect(() => {
    previousRefreshBlocked.current = refreshBlocked;
  }, [refreshBlocked]);
  useEffect(() => {
    refreshResumePolicy.update(refreshBlocked, refreshInterval !== "off");
  }, [refreshBlocked, refreshInterval, refreshResumePolicy]);
  useEffect(() => () => refreshResumePolicy.stop(), [refreshResumePolicy]);
  const autoRefreshPaused = dashboardAutoRefreshPaused(
    refreshBlocked,
    refreshWasBlocked,
    resumeCountdown,
    refreshInterval !== "off",
  );
  const autoRefreshPausedRef = useRef(autoRefreshPaused);
  autoRefreshPausedRef.current = autoRefreshPaused;
  const refreshPauseDescription =
    refreshBlockers.description ??
    (resumeCountdown !== null
      ? `Auto refresh resumes in ${resumeCountdown} seconds`
      : "Auto refresh interval");
  useEffect(() => {
    pollingClock.setRefresh(() => {
      void loadPage({ background: true });
      void loadTaskCounts({ background: true });
    });
  }, [loadPage, loadTaskCounts, pollingClock]);
  useEffect(() => {
    pollingClock.reset(dashboardRefreshIntervalMs(refreshInterval), autoRefreshPausedRef.current);
  }, [location.route, pollingClock, refreshInterval, refreshScheduleResetKey]);
  useEffect(() => pollingClock.setPaused(autoRefreshPaused), [autoRefreshPaused, pollingClock]);
  useEffect(() => () => pollingClock.stop(), [pollingClock]);

  const connected = loadState.status !== "error" && loadState.data !== null;
  const loading = loadState.status === "loading";
  const selectedEvent = inspectedEvent?.id === selectedEventId ? inspectedEvent : null;

  let content: ReactNode;
  if (loading && (!loadState.data || loadState.data.route !== location.route)) {
    content = (
      <Center mih="60vh">
        <Stack align="center" gap="sm">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            Loading {routeTitle(location.route)}…
          </Text>
        </Stack>
      </Center>
    );
  } else if (loadState.status === "error") {
    content = (
      <Center mih="60vh">
        <Stack align="center" gap="sm">
          <WarningCircle size={28} color="var(--mantine-color-red-6)" />
          <Text fw={600}>Workhorse could not load this page.</Text>
          <Text c="dimmed" size="sm">
            {loadState.error}
          </Text>
          <Button variant="light" onClick={() => void loadPage()}>
            Try again
          </Button>
        </Stack>
      </Center>
    );
  } else if (loadState.data?.route === "/tasks") {
    content = (
      <TasksPage
        data={loadState.data.value}
        navigate={navigate}
        replace={replace}
        taskLocation={location}
        runDemoTask={demoTools ? runDemoTask : null}
        runningDemoTask={runningDemoTask}
        inspectTask={inspectTask}
        taskEventsHref={taskEventsHref}
        runTaskNow={runTaskNow}
        auditActor={auditActor}
        reload={reloadTasks}
      />
    );
  } else if (loadState.data?.route === "/events") {
    content = (
      <EventsPage
        data={loadState.data.value}
        query={eventsQuery}
        setQuery={setEventsQuery}
        inspectEvent={inspectEvent}
      />
    );
  } else if (loadState.data?.route === "/cron") {
    content = (
      <CronPage
        data={loadState.data.value}
        togglingSchedule={togglingSchedule}
        setScheduleEnabled={(namespace, name, enabled) =>
          void toggleSchedule(namespace, name, enabled)
        }
      />
    );
  } else if (loadState.data?.route === "/queues") {
    content = (
      <QueuesPage
        data={loadState.data.value}
        togglingQueue={togglingQueue}
        purgingQueue={purgingQueue}
        confirmingQueue={confirmingQueue}
        setQueuePaused={(queue, paused) => void toggleQueue(queue, paused)}
        setConfirmingQueue={setConfirmingQueue}
        purgeQueue={(queue) => void clearQueue(queue)}
      />
    );
  } else if (loadState.data?.route === "/system") {
    content = (
      <SystemPage data={loadState.data.value} setWindow={changeSystemWindow} navigate={navigate} />
    );
  } else if (loadState.data?.route === "/workers") {
    content = (
      <WorkersPage
        data={loadState.data.value}
        togglingWorker={togglingWorker}
        setWorkerPaused={(workerId, paused) => void toggleWorker(workerId, paused)}
      />
    );
  } else if (loadState.data?.route === "/settings") {
    content = (
      <SettingsPage
        data={loadState.data.value}
        saving={savingSettings}
        onSaveMaintenance={saveMaintenanceSettings}
        onRevertMaintenance={revertMaintenanceSetting}
      />
    );
  } else {
    content = null;
  }

  if (content !== null) {
    content = (
      <Suspense
        fallback={
          <Center mih="60vh">
            <Loader size="sm" />
          </Center>
        }
      >
        {content}
      </Suspense>
    );
  }

  return {
    navbarOpened,
    toggleNavbar,
    environment,
    loadState,
    connected,
    loading,
    loadPage,
    refreshInterval,
    autoRefreshPaused,
    resumeCountdown,
    refreshPauseDescription,
    refreshScheduleResetKey,
    resetRefreshSchedule,
    changeRefreshInterval,
    location,
    taskCounts,
    handleLink,
    content,
    navigate,
    runTaskNow,
    selectedTaskId,
    selectedEventId,
    selectedEvent,
    eventDetailError,
    selectedTask,
    taskDetailError,
    reloadSelectedTask,
    inspectTask,
    closeTaskDetail,
    closeEventDetail,
  };
}
