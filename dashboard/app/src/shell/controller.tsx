import { readStoredValue, storeValue } from "../browser-storage.js";
import { createRefreshRequests } from "../refresh-requests.js";
import {
  createDashboardPollingClock,
  createDashboardRefreshResumePolicy,
  dashboardRefreshIntervalMs,
  dashboardRefreshIntervals,
  defaultDashboardRefreshInterval,
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
  useContext,
  useEffect,
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
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
import {
  createLatestRequestGuard,
  taskDetailKeepsShownDetail,
  taskDrawerOpened,
  taskDrawerSync,
} from "../task-drawer.js";
import {
  defaultEventsLocation,
  eventsLocationHref,
  type EventsLocationState,
} from "../events-location.js";
import {
  parseTaskLocation,
  taskCursorSpent,
  taskDetailNavigation,
  taskListingHeadHref,
  taskListingPinned,
  taskLocationHref,
} from "../task-location.js";
import { notifyDashboard, notifyEnqueueTest, notifyFailure } from "../notifications.js";
import type { MaintenancePolicyDefinition, MaintenancePolicySetting } from "@stablemates/workhorse";
import { requestRunNow, type RunNowFeedback } from "../run-now.js";
import { Button, Center, Loader, Stack, Text } from "@mantine/core";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DemoTaskKind,
  LoadState,
  PageRoute,
  mountedHref,
  parseLocation,
  readLocation,
  readStoredSystemWindow,
  systemWindowStorageKey,
  systemWindows,
  taskHref,
  useDashboardClient,
} from "../core.js";
import {
  failedLoadState,
  readyLoadState,
  readyTaskCounts,
  startedLoadState,
} from "../render-identity.js";
import { subscribeTimeZone } from "../preferences.js";
import type { DemoTaskOptions } from "../pages/tasks.js";
import {
  createPageCache,
  fetchPageData,
  pageRequestKey,
  readPage,
  type PageRequest,
} from "../page-cache.js";
import { createForegroundLoads } from "../foreground-load.js";
import { createPageLoadClaims } from "../page-load-claims.js";
import { PageAnswerContext, PagePendingContext, pagePending } from "../pending-results.js";
import { DashboardMutationFeedContext } from "../mutation-observer.js";
import { createDashboardRouter } from "../dashboard-routing.js";
import { createDashboardRefreshController } from "../dashboard-refresh-controller.js";
import { useMutationInFlight } from "../mutation-in-flight.js";
import { formatCount } from "../count-format.js";
import { describeQueueTier, describeTierSwitch } from "../queue-tier.js";
import { randomUuid } from "../random-uuid.js";
import { scheduleKey } from "../presentation-policy.js";

/**
 * A route page whose chunk loads on first use, or earlier when `preload` runs.
 *
 * The dashboard preloads each page chunk while the browser is idle, so a later click renders the
 * page in the same commit. A page that mounts before its chunk arrives suspends as a lazy
 * component. Each mount keeps the component it started with, so a chunk that arrives later does
 * not remount a page that is on screen.
 */
function preloadablePage<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  let loaded: ComponentType<Props> | null = null;
  let pending: Promise<ComponentType<Props>> | null = null;
  const preload = (): Promise<ComponentType<Props>> => {
    pending ??= load().then(
      (component) => (loaded = component),
      (cause: unknown) => {
        // A failed chunk request can succeed later, so the next use asks again.
        pending = null;
        throw cause;
      },
    );
    return pending;
  };
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));
  function Page(props: Props) {
    const [Component] = useState<ComponentType<Props>>(() => loaded ?? Lazy);
    return <Component {...props} />;
  }
  return { Page, preload };
}

const tasksPage = preloadablePage(() =>
  import("../pages/tasks.js").then((module) => module.TasksPage),
);
const eventsPage = preloadablePage(() =>
  import("../pages/events.js").then((module) => module.EventsPage),
);
const taskGroupsPage = preloadablePage(() =>
  import("../pages/task-groups.js").then((module) => module.TaskGroupsPage),
);
const cronPage = preloadablePage(() =>
  import("../pages/schedules.js").then((module) => module.CronPage),
);
const queuesPage = preloadablePage(() =>
  import("../pages/queues.js").then((module) => module.QueuesPage),
);
const systemPage = preloadablePage(() =>
  import("../pages/overview.js").then((module) => module.SystemPage),
);
const workersPage = preloadablePage(() =>
  import("../pages/workers.js").then((module) => module.WorkersPage),
);
const settingsPage = preloadablePage(() =>
  import("../pages/settings/index.js").then((module) => module.SettingsPage),
);
const TasksPage = tasksPage.Page;
const EventsPage = eventsPage.Page;
const TaskGroupsPage = taskGroupsPage.Page;
const CronPage = cronPage.Page;
const QueuesPage = queuesPage.Page;
const SystemPage = systemPage.Page;
const WorkersPage = workersPage.Page;
const SettingsPage = settingsPage.Page;

/** The chunk of each route page, so navigation can fetch it before the click. */
const pageChunks = {
  "/tasks": tasksPage.preload,
  "/events": eventsPage.preload,
  "/groups": taskGroupsPage.preload,
  "/cron": cronPage.preload,
  "/queues": queuesPage.preload,
  "/system": systemPage.preload,
  "/workers": workersPage.preload,
  "/settings": settingsPage.preload,
} as const satisfies Record<PageRoute, () => Promise<unknown>>;

/** The sidebar destinations, in the order the dashboard prefetches them after the first load. */
const prefetchedRoutes: readonly PageRoute[] = [
  "/tasks",
  "/events",
  "/groups",
  "/cron",
  "/queues",
  "/workers",
  "/system",
  "/settings",
];

/**
 * A prefetch skips a page whose cached answer is younger than this. A pointer that moves over
 * the sidebar then does not send a request for each row it crosses.
 */
const prefetchFreshMs = 5_000;

/** Runs `work` when the browser is idle, or after a short delay where idle callbacks do not exist. */
function whenIdle(work: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(work, { timeout: 2_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(work, 300);
  return () => window.clearTimeout(handle);
}

interface PageLoadOptions {
  /** A poll. It writes nothing while a refresh blocker holds. */
  background?: boolean;
  /** The load after the location changed. It can use a prefetch answer. */
  navigation?: boolean;
}

/** What a load that decided to write nothing hands back. */
const applyNothing = () => undefined;

export const refreshStorageKey = "workhorse-auto-refresh";
export function readStoredRefreshInterval(): DashboardRefreshIntervalValue {
  const stored = readStoredValue(refreshStorageKey);
  return dashboardRefreshIntervals.some((option) => option.value === stored)
    ? (stored as DashboardRefreshIntervalValue)
    : defaultDashboardRefreshInterval;
}
export function routeTitle(route: PageRoute): string {
  if (route === "/events") return "events";
  if (route === "/groups") return "task groups";
  if (route === "/cron") return "schedules";
  if (route === "/queues") return "queues";
  if (route === "/system") return "system health";
  if (route === "/workers") return "workers";
  if (route === "/settings") return "settings";
  return "current tasks";
}
/** The page name, as the navigation shows it. */
export function routeHeading(route: PageRoute): string {
  if (route === "/events") return "Events";
  if (route === "/groups") return "Task groups";
  if (route === "/cron") return "Schedules";
  if (route === "/queues") return "Queues";
  if (route === "/system") return "System health";
  if (route === "/workers") return "Workers";
  if (route === "/settings") return "Settings";
  return "Tasks";
}
/** The document title names the page, so browser tabs and history entries tell pages apart. */
export function documentTitle(route: PageRoute): string {
  return `${routeHeading(route)} · Workhorse`;
}
/**
 * The route that the page area shows, or null while it shows the loading screen.
 *
 * Right after navigation the page area can still show the previous page for one render. Focus
 * placement waits until this names the route in the URL, so it does not focus a heading that is
 * about to go.
 */
export function pageContentRoute(
  loadState: LoadState,
  loading: boolean,
  route: PageRoute,
): PageRoute | null {
  if (loading && (!loadState.data || loadState.data.route !== route)) return null;
  if (loadState.status === "error") return loadState.route;
  return loadState.data?.route ?? null;
}
export function useDashboardController(
  auditActor: string,
  demoTools: DashboardDemoTools | null,
  basePath: string,
) {
  const client = useDashboardClient();
  const mutations = useContext(DashboardMutationFeedContext);
  const refreshBlockers = useRefreshBlockers();
  const router = useMemo(() => createDashboardRouter(basePath), [basePath]);
  const refreshController = useMemo(
    () => createDashboardRefreshController(refreshBlockers.isBlocked),
    [refreshBlockers.isBlocked],
  );
  const refreshRequests = useMemo(() => createRefreshRequests(), [client]);
  /** The last answer of each page load. Each client is one workspace, so each has its own. */
  const pageCache = useMemo(() => createPageCache(), [client]);
  /**
   * After each mutation, drop the cached pages and stop sharing the reads in flight. No view then
   * shows the state from before the change, whichever page or drawer sent the mutation.
   */
  useEffect(
    () =>
      mutations?.subscribe(() => {
        pageCache.invalidate();
        refreshRequests.forget();
      }),
    [mutations, pageCache, refreshRequests],
  );
  const [navbarOpened, { toggle: toggleNavbar, close: closeNavbar }] = useDisclosure();
  // Timestamps format through module-level displayTimeZone; re-render everything on change.
  const [, setTimeZoneTick] = useState(0);
  useEffect(() => subscribeTimeZone(() => setTimeZoneTick((tick) => tick + 1)), []);
  const [location, setLocation] = useState(() => router.read());
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
  const runningDemoTask = useMutationInFlight<DemoTaskKind>();
  const togglingSchedule = useMutationInFlight<string>();
  const togglingQueue = useMutationInFlight<string>();
  const purgingQueue = useMutationInFlight<string>();
  const changingQueueTier = useMutationInFlight<string>();
  const [confirmingQueue, setConfirmingQueue] = useState<string | null>(null);
  const togglingWorker = useMutationInFlight<string>();
  const savingSettings = useMutationInFlight<boolean>();
  /**
   * The open task is read from the URL rather than held beside it, so a copied or reloaded link
   * restores the same list and the same open drawer, and Back/Forward can only ever agree with
   * what is on screen.
   */
  const selectedTaskId = location.route === "/tasks" ? location.taskId : null;
  useRefreshBlocker(taskDrawerOpened(selectedTaskId), dashboardRefreshBlockers.taskDrawer);
  /**
   * A page the operator pinned stops following the list, so auto refresh stops with it.
   *
   * Tasks are ordered by update time, so every row a poll would bring news about leaves the pinned
   * window at the same moment: refreshing an anchored page drains it toward empty without ever
   * showing the new work, and an offset page shuffles rows across its boundaries between polls.
   * Manual refresh is unaffected, and returning to the newest page resumes the configured cadence.
   */
  useRefreshBlocker(
    location.route === "/tasks" && taskListingPinned(location),
    dashboardRefreshBlockers.pinnedTaskPage,
  );
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
  const [activityPollTick, setActivityPollTick] = useState(0);
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
      storeValue(systemWindowStorageKey, nextWindow);
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
    storeValue(refreshStorageKey, value);
  }, []);
  const pageLoads = useRef(createPageLoadClaims());
  /**
   * The request that the page data on screen answers, and when it last succeeded.
   *
   * A failed load keeps the page only when the data on screen answers that same request. Data
   * for another listing, another window, or another route is not usable for it.
   */
  const loadedPage = useRef<{ key: string; refreshedAt: string } | null>(null);
  /** The operator's page load that is still in progress, if any. */
  const [foregroundRequest, setForegroundRequest] = useState<number | null>(null);
  const foregroundLoads = useMemo(() => createForegroundLoads(setForegroundRequest), []);
  const shouldDiscardBackgroundRefresh = refreshController.shouldDiscardBackground;

  const navigate = useCallback(
    (href: string) => {
      setLocation(router.push(href));
      closeNavbar();
    },
    [closeNavbar, router],
  );
  const replace = useCallback(
    (href: string) => {
      setLocation(router.replace(href));
    },
    [router],
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
  const taskStatusNavigation = useMemo(
    () => ({ href: (path: string) => mountedHref(basePath, path), followLink: handleLink }),
    [basePath, handleLink],
  );

  /**
   * What the task listing request is made of, separated from the rest of the location.
   *
   * Opening, switching, and closing the drawer all rewrite the URL, and the list behind the
   * panel must not refetch or flash a loader for any of them, so the page load is keyed on the
   * listing parameters instead of on the location object.
   */
  const { route } = location;
  // Declared before the title effect, so it records the host's title before the first change.
  useEffect(() => {
    const hostTitle = document.title;
    return () => {
      document.title = hostTitle;
    };
  }, []);
  useEffect(() => {
    document.title = documentTitle(route);
  }, [route]);
  const listingRef = useRef(location);
  listingRef.current = location;
  // The events feed follows the same shape as the task listing: the request is keyed on a
  // serialized copy of the filters, and the values themselves are read from a ref at send time.
  const eventsRef = useRef(eventsQuery);
  eventsRef.current = eventsQuery;
  // The task groups page follows the same shape: the list filters or the open group and its
  // member page key the request.
  const groupsRef = useRef(location.groups);
  groupsRef.current = location.groups;
  /** The identity of the page load that the location asks for. */
  const pageKey = pageRequestKey({
    route,
    listing: location,
    events: eventsQuery,
    groups: location.groups,
    systemWindow,
  });
  /** The page that the location asks for now, readable from an async callback. */
  const pageKeyRef = useRef(pageKey);
  pageKeyRef.current = pageKey;
  /**
   * Show the cached answer of a page in the same render as the click that asks for it.
   *
   * The page load still runs after this render, and its answer replaces the cached one. If the
   * load fails, the page stays and the warning states the time of the cached answer. With no
   * cached answer, the loading screen shows as before.
   */
  const [shownPageKey, setShownPageKey] = useState(pageKey);
  /**
   * The page whose cached answer is on screen, until the page load replaces it.
   *
   * The new answer can add rows above the cached ones. Keyed rows then slide down, which reads as
   * a jump. `pageAnswer` counts these replacements, so the rows mount again in place instead.
   */
  const cachedAnswerKey = useRef<string | null>(null);
  const [pageAnswer, setPageAnswer] = useState(0);
  if (shownPageKey !== pageKey) {
    setShownPageKey(pageKey);
    const cached = pageCache.read(pageKey);
    cachedAnswerKey.current = cached === null ? null : pageKey;
    if (cached !== null) {
      loadedPage.current = { key: pageKey, refreshedAt: cached.refreshedAt };
      setLoadState((current) => readyLoadState(current, cached.data));
    }
  }

  /**
   * Fetch one page and hand back what applying its answer would do.
   *
   * The work is split from the state it writes so that a poll can settle the page and the
   * navigation counts in one commit. Applying is a plain call, so the caller decides when the
   * screen changes; nothing is written until it makes that call.
   */
  const preparePageLoad = useCallback(
    async ({ background = false, navigation = false }: PageLoadOptions = {}): Promise<
      () => void
    > => {
      if (shouldDiscardBackgroundRefresh(background)) return applyNothing;
      // The request is a value from here on. A Refresh can wait for a read in flight, and a
      // filter change during that wait must not send other filters under this key.
      const request: PageRequest = {
        route,
        listing: listingRef.current,
        events: eventsRef.current,
        groups: groupsRef.current,
        systemWindow,
      };
      const key = pageRequestKey(request);
      if (background && refreshRequests.has(key)) return applyNothing;
      // Each navigation takes a claim, also when the cache serves it, so an answer for the page
      // that the operator left can no longer write.
      const claim = pageLoads.current.claim(key);
      // A page that a prefetch loaded a moment ago needs no other read. The render showed its
      // answer, unless the prefetch wrote it after that render read the cache. Then this
      // navigation shows it.
      if (navigation && pageCache.holdsFresh(key, prefetchFreshMs)) {
        // The cached answer replaces the page that the operator left. A slow read for that page
        // must not keep Refresh busy on this one.
        if (!background) foregroundLoads.supersede();
        const cached = pageCache.read(key);
        if (cached === null || loadedPage.current?.key === key) return applyNothing;
        return () => {
          if (!pageLoads.current.holds(claim, pageKeyRef.current)) return;
          loadedPage.current = { key, refreshedAt: cached.refreshedAt };
          setLoadState((current) => readyLoadState(current, cached.data));
        };
      }
      const activeRequest = claim.id;
      // The answer is judged against the listing that asked for it. While a pager click is in
      // flight the page on screen is still the one the operator left, and its own first-page
      // report must not be read as an answer about the cursor now in the URL.
      const requestedListing = request.listing;
      if (!background) {
        foregroundLoads.start(activeRequest);
        const sameRequest = loadedPage.current?.key === key;
        setLoadState((current) => startedLoadState(current, sameRequest));
      }
      // Every outcome ends this request's spinner, including an answer that a newer request
      // made too late to write.
      const settleForeground = () => {
        if (!background) foregroundLoads.settle(activeRequest);
      };
      try {
        const { data, kept } = await readPage({
          requests: refreshRequests,
          cache: pageCache,
          request,
          read: (sent) => fetchPageData(client, sent),
          // A navigation can use the answer of a prefetch in flight. A refresh after a mutation
          // or a click on Refresh must read again.
          fresh: !background && !navigation,
        });
        // A read that started before a mutation is old. A poll does not show it, and the next
        // poll reads again. An operator's load shows it, because the operator waits for it.
        if (!kept && background) return applyNothing;
        return () => {
          settleForeground();
          if (!pageLoads.current.holds(claim, pageKeyRef.current)) return;
          if (shouldDiscardBackgroundRefresh(background)) return;
          /**
           * Keep the state object when the answer repeats what is on screen.
           *
           * A poll that found no change used to hand the shell a fresh object graph, and every
           * row below it rendered again to draw the same pixels. Comparing structurally means
           * `setState` bails out instead, so an unchanged poll commits nothing.
           */
          setLoadState((current) => readyLoadState(current, data));
          loadedPage.current = { key, refreshedAt: new Date().toISOString() };
          if (!background && cachedAnswerKey.current === key) {
            cachedAnswerKey.current = null;
            setPageAnswer((count) => count + 1);
          }
          /**
           * Release a cursor this answer proved spent.
           *
           * Left in the URL, an anchor the first page no longer needs hands out a link that
           * reloads into a window mid-list as soon as the rows above it change, and it holds
           * auto refresh paused on a list that is following new work again. Replacing rather
           * than pushing keeps Back pointing at wherever the operator came from.
           */
          if (
            data.route === "/tasks" &&
            "previousCursor" in data.value &&
            taskCursorSpent(requestedListing, data.value)
          ) {
            replace(taskListingHeadHref(requestedListing));
          }
        };
      } catch (cause) {
        return () => {
          settleForeground();
          if (!pageLoads.current.holds(claim, pageKeyRef.current)) return;
          if (shouldDiscardBackgroundRefresh(background)) return;
          const error =
            cause instanceof Error ? cause.message : "Workhorse could not load this page";
          const retained = loadedPage.current?.key === key ? loadedPage.current : null;
          setLoadState((current) => failedLoadState(current, { route, error }, retained));
        };
      }
      // `pageKey` is the dependency the page load actually has; the values themselves are read
      // from a ref when the load starts, so that a re-render for an unrelated reason cannot send
      // a stale request.
    },
    [
      client,
      route,
      pageKey,
      systemWindow,
      replace,
      shouldDiscardBackgroundRefresh,
      refreshRequests,
      pageCache,
      foregroundLoads,
    ],
  );

  const loadPage = useCallback(
    async (options: PageLoadOptions = {}) => {
      (await preparePageLoad(options))();
    },
    [preparePageLoad],
  );

  const prepareTaskCounts = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<() => void> => {
      if (shouldDiscardBackgroundRefresh(background)) return applyNothing;
      try {
        const counts = await refreshRequests.run("taskCounts", () => client.taskCounts());
        return () => {
          if (shouldDiscardBackgroundRefresh(background)) return;
          setTaskCounts((current) => readyTaskCounts(current, counts));
        };
      } catch {
        // The active page owns the connection state; keep the last navigation counts on failure.
        return applyNothing;
      }
    },
    [client, shouldDiscardBackgroundRefresh, refreshRequests],
  );

  const loadTaskCounts = useCallback(
    async (options: { background?: boolean } = {}) => {
      (await prepareTaskCounts(options))();
    },
    [prepareTaskCounts],
  );

  /**
   * Settle one poll: the page and the navigation counts land together.
   *
   * The two requests go out at the same moment, so the poll waits for the slower of them rather
   * than for their sum. Applying both answers in one continuation means React commits once, where
   * writing each answer as it arrived rendered the whole shell twice per tick.
   */
  const refreshEverything = useCallback(async () => {
    const [applyPage, applyCounts] = await Promise.all([
      preparePageLoad({ background: true }),
      prepareTaskCounts({ background: true }),
    ]);
    applyPage();
    applyCounts();
  }, [preparePageLoad, prepareTaskCounts]);

  const toggleSchedule = useCallback(
    async (namespace: string, name: string, paused: boolean) => {
      togglingSchedule.start(scheduleKey({ kind: "user", namespace, name }));
      try {
        await client.setSchedulePaused({
          kind: "user",
          namespace,
          name,
          paused,
          audit: {
            actor: auditActor,
            reason: `${paused ? "Pause" : "Resume"} ${namespace}/${name} from the dashboard`,
            requestId: randomUuid(),
          },
        });
        notifyDashboard({
          title: paused ? "Schedule paused" : "Schedule resumed",
          message: paused
            ? `${namespace}/${name} stopped firing and stays paused across deploys. Occurrences already enqueued are untouched.`
            : `${namespace}/${name} can fire again when its deployment configuration is enabled.`,
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Schedule not updated", cause, "Workhorse could not update the schedule");
      } finally {
        togglingSchedule.stop();
      }
    },
    [auditActor, client, loadPage, togglingSchedule],
  );

  const toggleQueue = useCallback(
    async (queue: string, paused: boolean) => {
      togglingQueue.start(queue);
      try {
        await client.setQueuePaused({
          queue,
          paused,
          audit: {
            actor: auditActor,
            reason: `${paused ? "Pause" : "Resume"} ${queue} from the dashboard`,
            requestId: randomUuid(),
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
        togglingQueue.stop();
      }
    },
    [auditActor, client, loadPage, togglingQueue],
  );

  const clearQueue = useCallback(
    async (queue: string) => {
      purgingQueue.start(queue);
      try {
        const result = await client.purgeQueue({
          queue,
          audit: {
            actor: auditActor,
            reason: `Clear queued work from ${queue} from the dashboard`,
            requestId: randomUuid(),
          },
        });
        setConfirmingQueue(null);
        notifyDashboard({
          title: "Queue cleared",
          message: `Cleared ${formatCount(result.deletedCount)} queued ${
            result.deletedCount === 1 ? "task" : "tasks"
          } from ${queue}.`,
          tone: result.deletedCount > 0 ? "success" : "neutral",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure("Queue not cleared", cause, "Workhorse could not clear the queue");
      } finally {
        purgingQueue.stop();
      }
    },
    [auditActor, client, loadPage, purgingQueue],
  );

  const setQueueTier = useCallback(
    async (queue: string, tier: "fast" | "full") => {
      if (!client.setQueueTier) return;
      changingQueueTier.start(queue);
      try {
        const result = await client.setQueueTier({
          queue,
          tier,
          audit: {
            actor: auditActor,
            reason: `Move ${queue} to the ${tier} tier from the dashboard`,
            requestId: randomUuid(),
          },
        });
        notifyDashboard({
          id: `queue-tier-${queue}`,
          ...describeTierSwitch(queue, tier, result.status),
        });
        if (result.status === "set") await loadPage();
      } catch (cause) {
        notifyFailure("Queue tier not changed", cause, "Workhorse could not change the queue tier");
      } finally {
        changingQueueTier.stop();
      }
    },
    [auditActor, client, loadPage, changingQueueTier],
  );

  const setQueueHistory = useCallback(
    async (queue: string, change: { recordAttempts?: boolean; recordClaims?: boolean }) => {
      if (!client.setQueueHistory) return;
      changingQueueTier.start(queue);
      try {
        const result = await client.setQueueHistory({
          queue,
          ...change,
          audit: {
            actor: auditActor,
            reason: `Change the history of ${queue} from the dashboard`,
            requestId: randomUuid(),
          },
        });
        notifyDashboard({
          id: `queue-history-${queue}`,
          title: "Queue history changed",
          message: describeQueueTier({ tier: "fast", ...result }).title,
          tone: "success",
        });
        await loadPage();
      } catch (cause) {
        notifyFailure(
          "Queue history not changed",
          cause,
          "Workhorse could not change the queue history",
        );
      } finally {
        changingQueueTier.stop();
      }
    },
    [auditActor, client, loadPage, changingQueueTier],
  );

  const toggleWorker = useCallback(
    async (workerId: string, paused: boolean) => {
      togglingWorker.start(workerId);
      try {
        await client.setWorkerPaused({
          workerId,
          paused,
          audit: {
            actor: auditActor,
            reason: `${paused ? "Pause" : "Resume"} ${workerId} from the dashboard`,
            requestId: randomUuid(),
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
        togglingWorker.stop();
      }
    },
    [auditActor, client, loadPage, togglingWorker],
  );

  const saveMaintenanceSettings = useCallback(
    async ({
      definition,
      onSaved,
    }: {
      definition: Partial<MaintenancePolicyDefinition>;
      onSaved(): void;
    }) => {
      savingSettings.start(true);
      try {
        await client.overrideMaintenancePolicy({
          definition,
          audit: {
            actor: auditActor,
            reason: "Update maintenance policy from the dashboard",
            requestId: randomUuid(),
          },
        });
        onSaved();
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
        savingSettings.stop();
      }
    },
    [auditActor, client, loadPage, savingSettings],
  );
  const revertMaintenanceSetting = useCallback(
    async (setting: MaintenancePolicySetting) => {
      try {
        await client.revertMaintenancePolicy({
          settings: [setting],
          audit: {
            actor: auditActor,
            reason: `Revert ${setting} to the application default`,
            requestId: randomUuid(),
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
      // A reload of the task on screen keeps its detail mounted, so the drawer keeps its scroll
      // position, its field text, and keyboard focus. Only another task empties the drawer.
      if (!taskDetailKeepsShownDetail(selectedTaskIdRef.current, id)) setSelectedTask(null);
      selectedTaskIdRef.current = id;
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
      runningDemoTask.start(kind);
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
            requestId: randomUuid(),
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
        runningDemoTask.stop();
      }
    },
    [
      auditActor,
      demoTools,
      inspectTask,
      loadPage,
      location.filter,
      location.page,
      navigate,
      runningDemoTask,
    ],
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
        requestId: randomUuid(),
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
    void loadPage({ navigation: true });
    void loadTaskCounts();
  }, [loadPage, loadTaskCounts]);

  /**
   * Load the chunk and the read model of the page behind `href` into the cache, without showing
   * them. A click on that page then renders at once. A failure leaves the cache as it was, and
   * the page load after the click reports it.
   */
  const prefetchPage = useCallback(
    async (href: string): Promise<void> => {
      const url = new URL(href, window.location.origin);
      const target = parseLocation(url.pathname, url.search);
      const chunk = pageChunks[target.route]().catch(() => undefined);
      const request: PageRequest = {
        route: target.route,
        listing: target,
        events: target.events,
        groups: target.groups,
        systemWindow,
      };
      const key = pageRequestKey(request);
      if (pageCache.holdsFresh(key, prefetchFreshMs) || refreshRequests.has(key)) {
        await chunk;
        return;
      }
      const generation = pageCache.generation();
      try {
        const data = await refreshRequests.run(key, () => fetchPageData(client, request));
        pageCache.write(key, data, generation);
      } catch {
        // The page load after a click reports the failure.
      }
      await chunk;
    },
    [client, pageCache, refreshRequests, systemWindow],
  );
  const prefetchPageRef = useRef(prefetchPage);
  prefetchPageRef.current = prefetchPage;
  /**
   * After the first page shows, prefetch every sidebar destination while the browser is idle.
   * The requests go one at a time, so the prefetch does not compete with the page on screen.
   */
  const hasPageData = loadState.data !== null;
  useEffect(() => {
    if (!hasPageData) return;
    let stopped = false;
    const cancel = whenIdle(() => {
      void (async () => {
        for (const destination of prefetchedRoutes) {
          if (stopped) return;
          await prefetchPageRef.current(destination);
        }
      })();
    });
    return () => {
      stopped = true;
      cancel();
    };
  }, [hasPageData]);

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
  const autoRefreshPaused = refreshController.autoRefreshPaused(
    refreshWasBlocked,
    resumeCountdown,
    refreshInterval,
  );
  const autoRefreshPausedRef = useRef(autoRefreshPaused);
  autoRefreshPausedRef.current = autoRefreshPaused;
  const refreshPauseDescription = refreshController.pauseDescription(
    refreshBlockers.description,
    resumeCountdown,
  );
  useEffect(() => {
    pollingClock.setRefresh(() => {
      if (route === "/tasks") setActivityPollTick((tick) => tick + 1);
      void refreshEverything();
    });
  }, [pollingClock, refreshEverything, route]);
  useEffect(() => {
    pollingClock.reset(dashboardRefreshIntervalMs(refreshInterval), autoRefreshPausedRef.current);
  }, [location.route, pollingClock, refreshInterval, refreshScheduleResetKey]);
  useEffect(() => pollingClock.setPaused(autoRefreshPaused), [autoRefreshPaused, pollingClock]);
  useEffect(() => () => pollingClock.stop(), [pollingClock]);

  const loading = loadState.status === "loading" || foregroundRequest !== null;
  const selectedEvent = inspectedEvent?.id === selectedEventId ? inspectedEvent : null;

  const shownRoute = pageContentRoute(loadState, loading, location.route);
  let content: ReactNode;
  if (shownRoute === null) {
    content = (
      <Center mih="60vh" className="dashboard-page-loading">
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
          <HugeiconsIcon icon={AlertCircleIcon} size={28} color="var(--mantine-color-red-6)" />
          <Text component="h1" fw={600} size="md" my={0}>
            Workhorse could not load this page.
          </Text>
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
        runningDemoTask={runningDemoTask.value}
        inspectTask={inspectTask}
        taskEventsHref={taskEventsHref}
        runTaskNow={runTaskNow}
        auditActor={auditActor}
        reload={reloadTasks}
        activityPollTick={activityPollTick}
        taskCounts={taskCounts}
        statusNavigation={taskStatusNavigation}
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
  } else if (loadState.data?.route === "/groups") {
    content = (
      <TaskGroupsPage
        data={loadState.data.value}
        location={location.groups}
        navigation={{
          href: (path) => mountedHref(basePath, path),
          followLink: handleLink,
          taskPath: (taskId) => taskLocationHref({ ...parseTaskLocation(""), taskId }),
        }}
        navigate={navigate}
        auditActor={auditActor}
        reload={loadPage}
      />
    );
  } else if (loadState.data?.route === "/cron") {
    content = (
      <CronPage
        data={loadState.data.value}
        togglingSchedule={togglingSchedule.value}
        scheduleTasksHref={(queue, taskType) =>
          mountedHref(basePath, taskLocationHref({ ...parseTaskLocation(""), queue, taskType }))
        }
        setSchedulePaused={(namespace, name, paused) =>
          void toggleSchedule(namespace, name, paused)
        }
      />
    );
  } else if (loadState.data?.route === "/queues") {
    content = (
      <QueuesPage
        data={loadState.data.value}
        togglingQueue={togglingQueue.value}
        purgingQueue={purgingQueue.value}
        confirmingQueue={confirmingQueue}
        setQueuePaused={(queue, paused) => void toggleQueue(queue, paused)}
        setConfirmingQueue={setConfirmingQueue}
        purgeQueue={(queue) => void clearQueue(queue)}
        changingQueue={changingQueueTier.value}
        tierCapabilities={{
          canSetTier: Boolean(client.setQueueTier),
          canSetHistory: Boolean(client.setQueueHistory),
        }}
        setQueueTier={(queue, tier) => void setQueueTier(queue, tier)}
        setQueueHistory={(queue, change) => void setQueueHistory(queue, change)}
      />
    );
  } else if (loadState.data?.route === "/system") {
    content = (
      <SystemPage
        data={loadState.data.value}
        requestedWindow={systemWindow}
        setWindow={changeSystemWindow}
        navigate={navigate}
      />
    );
  } else if (loadState.data?.route === "/workers") {
    content = (
      <WorkersPage
        data={loadState.data.value}
        togglingWorker={togglingWorker.value}
        setWorkerPaused={(workerId, paused) => void toggleWorker(workerId, paused)}
      />
    );
  } else if (loadState.data?.route === "/settings") {
    content = (
      <SettingsPage
        data={loadState.data.value}
        saving={savingSettings.value ?? false}
        onSaveMaintenance={saveMaintenanceSettings}
        onRevertMaintenance={revertMaintenanceSetting}
      />
    );
  } else {
    content = null;
  }

  if (content !== null) {
    // A control that asks again in place keeps the previous answer on screen until the new one
    // arrives. The page dims the rows that the answer replaces.
    const contentPending = pagePending(loadState, loadedPage.current?.key ?? null, pageKey);
    content = (
      <PagePendingContext.Provider value={contentPending}>
        <PageAnswerContext.Provider value={pageAnswer}>
          <Suspense
            fallback={
              <Center mih="60vh" className="dashboard-page-loading">
                <Loader size="sm" />
              </Center>
            }
          >
            {content}
          </Suspense>
        </PageAnswerContext.Provider>
      </PagePendingContext.Provider>
    );
  }

  return {
    navbarOpened,
    toggleNavbar,
    environment,
    loadState,
    loading,
    shownRoute,
    loadPage,
    prefetchPage,
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
