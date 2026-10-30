import { taskListingHeadHref, taskListingPinned } from "../task-location.js";
import type { DashboardDemoTools } from "@stablemates/workhorse-dashboard-server";
import type { DashboardWorkspaceLink } from "@stablemates/workhorse-dashboard-server/server";
import { useDropdownActivity } from "../dropdown-activity.js";
import { Alert, AppShell, Box, Center, Drawer, Loader, Text } from "@mantine/core";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useRefreshBlockingInputCapture,
  useDashboardWindowActivityRefreshBlocker,
} from "../refresh-blockers.js";
import { useMediaQuery } from "@mantine/hooks";
import { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  taskDrawerCloseOnEscape,
  taskDrawerFocusChange,
  taskDrawerModelessProps,
  taskDrawerViewportProps,
} from "../task-drawer.js";
import { taskOpenButtonId } from "../task-table-ui.js";
import type { DashboardProps } from "../dashboard-root.js";
import { routeHeading, useDashboardController } from "./controller.js";
import { mountedHref, taskHref } from "../core.js";
import { EventDetails } from "../components/event-details.js";
import { formatClock, formatExact } from "../preferences.js";
import { firstConnected, focusPageHeading, usePageHeadingFocus } from "../page-focus.js";
import { Tooltip } from "../ui.js";
import {
  AccountMenu,
  AppearanceToggle,
  ConnectionIndicator,
  dashboardConnectionStatus,
  EnvironmentIndicator,
  namesDeploymentEnvironment,
  NavigationToggle,
  RefreshControl,
} from "./HeaderControls.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { useSidebarSlide } from "./sidebar-motion.js";
import {
  DashboardNavigationDrawer,
  DashboardSidebar,
  dashboardSidebarWidth,
  navigationShortcut,
  onApplePlatform,
  useNavigationShortcut,
  useSidebarCollapsed,
} from "./Sidebar.js";

/** The page area: the skip link and the page heading focus move here. */
const mainContentId = "dashboard-main";
/** The navigation region that the header toggle opens and closes. */
const navigationId = "dashboard-navigation";

/**
 * The first focusable element on the page. It lets a keyboard user go past the header and the
 * navigation to the page content. It shows only while it has focus.
 */
export function SkipToContentLink({ targetId }: { targetId: string }) {
  return (
    <a
      className="dashboard-skip-link"
      href={`#${targetId}`}
      // Focus moves from a script, because a fragment in the address bar would reach the router.
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(targetId)?.focus();
      }}
    >
      Skip to main content
    </a>
  );
}

/**
 * Says that the page shows retained data after a refresh failed.
 *
 * The page stays so the operator keeps what they were reading, and this states how old it is, so
 * old data does not read as current. The shell keeps the live region mounted and fills it, so a
 * screen reader announces the warning when it appears, not on each failed poll.
 */
export function PageRefreshWarning({ error, refreshedAt }: { error: string; refreshedAt: string }) {
  return (
    <Alert
      // The live region around it announces the change; an alert role would interrupt.
      role="none"
      color="orange"
      variant="light"
      icon={<HugeiconsIcon icon={AlertCircleIcon} size={18} />}
      title="Refresh failed"
      mb="md"
    >
      <Text size="sm">
        This page shows data from the last successful refresh at{" "}
        <time dateTime={refreshedAt} title={formatExact(refreshedAt)}>
          {formatClock(refreshedAt)}
        </time>
        . It can be out of date.
      </Text>
      <Text size="sm" c="dimmed" mt={4} style={{ overflowWrap: "anywhere" }}>
        {error}
      </Text>
    </Alert>
  );
}

/**
 * The task drawer, fetched the first time an operator opens one.
 *
 * It is the largest view in the dashboard and nothing shows it until a task is picked, so the
 * first paint of the listing should not wait for it. Once fetched it stays mounted, because a
 * drawer that unmounted on close would cut its own closing animation.
 */
const TaskDetailDrawer = lazy(() =>
  import("../pages/task-detail.js").then((module) => ({ default: module.TaskDetailDrawer })),
);

/**
 * Reports the moment the drawer's chunk has arrived and its panel is in the document.
 *
 * The shell moves focus into the drawer when a task opens, and on the first open the panel is
 * still being fetched when that would run. This commits with the drawer, so the shell can place
 * focus once there is something to place it in.
 */
function TaskDrawerPresence({ onPresent }: { onPresent: () => void }) {
  useLayoutEffect(onPresent, [onPresent]);
  return null;
}

export function DashboardContent({
  auditActor,
  logoutUrl,
  demoTools,
  basePath,
  workspaces,
  workspace,
  workhorseVersion,
  workhorseRevision,
}: Required<Pick<DashboardProps, "auditActor">> & {
  logoutUrl: string | null;
  demoTools: DashboardDemoTools | null;
  basePath: string;
  workspaces: readonly DashboardWorkspaceLink[];
  workspace: string | null;
  workhorseVersion: string | undefined;
  workhorseRevision: string | undefined;
}) {
  useDashboardWindowActivityRefreshBlocker();
  const controller = useDashboardController(auditActor, demoTools, basePath);
  const dropdownOpened = useDropdownActivity();
  const narrowDetailDrawer = useMediaQuery("(max-width: 47.99em)");
  // Below the `sm` breakpoint the navigation is a drawer over the page; above it, a sidebar that
  // the same toggle collapses to a rail and expands again. The rail choice is stored.
  const narrowNavigation = narrowDetailDrawer;
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  const refreshBlockingInputCapture = useRefreshBlockingInputCapture();
  const previousTaskDrawerId = useRef<string | null>(null);
  const mainContent = useRef<HTMLElement | null>(null);
  const pageContent = useRef<HTMLDivElement | null>(null);
  const headerStart = useRef<HTMLDivElement | null>(null);
  const sidebarPanel = useRef<HTMLDivElement | null>(null);
  const taskDrawerReturnTarget = useRef<HTMLElement | null>(null);
  const {
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
    refreshPauseDescription,
    resetRefreshSchedule,
    changeRefreshInterval,
    location,
    handleLink,
    content,
    selectedTaskId,
    selectedEventId,
    selectedEvent,
    eventDetailError,
    closeEventDetail,
  } = controller;
  /**
   * Whether this session has ever asked for a task drawer.
   *
   * It latches rather than following the selection, so the drawer's chunk is fetched once and the
   * panel stays mounted to animate itself closed. A deep link that names a task arrives with the
   * selection already set, so it mounts in the same render rather than one paint later.
   */
  const [taskDrawerRequested, setTaskDrawerRequested] = useState(false);
  if (selectedTaskId !== null && !taskDrawerRequested) setTaskDrawerRequested(true);
  const [taskDrawerPresent, setTaskDrawerPresent] = useState(false);
  const markTaskDrawerPresent = useCallback(() => setTaskDrawerPresent(true), []);
  const taskDetailDrawerProps = {
    ...taskDrawerViewportProps(narrowDetailDrawer),
    closeOnEscape: taskDrawerCloseOnEscape(dropdownOpened),
  };
  const eventDetailDrawerProps = {
    ...taskDrawerModelessProps,
    closeOnEscape: taskDrawerCloseOnEscape(dropdownOpened),
  };
  useLayoutEffect(() => {
    // On the first open the panel is still being fetched. Leave the transition unconsumed so
    // this runs again with something to focus rather than skipping the move entirely.
    if (selectedTaskId !== null && !taskDrawerPresent) return;
    const previousTaskId = previousTaskDrawerId.current;
    const focusChange = taskDrawerFocusChange(previousTaskId, selectedTaskId);
    previousTaskDrawerId.current = selectedTaskId;
    if (focusChange === "none") return;
    if (focusChange === "trigger") {
      // A refresh can replace or remove the row that opened the drawer, for example after Retry
      // in a list that filters out the new state. Then focus goes to the row's new element, or to
      // the page heading.
      const opener = firstConnected([
        taskDrawerReturnTarget.current,
        previousTaskId === null ? null : document.getElementById(taskOpenButtonId(previousTaskId)),
      ]);
      if (opener) opener.focus();
      else focusPageHeading(mainContent.current);
      return;
    }
    if (selectedTaskId === null) return;

    const trigger = document.getElementById(taskOpenButtonId(selectedTaskId));
    const drawer = document.getElementById("task-detail-drawer");
    const activeElement = document.activeElement;
    if (trigger instanceof HTMLElement) {
      taskDrawerReturnTarget.current = trigger;
    } else if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      !drawer?.contains(activeElement)
    ) {
      taskDrawerReturnTarget.current = activeElement;
    }
    document.getElementById("task-detail-drawer-close")?.focus();
  }, [selectedTaskId, taskDrawerPresent]);
  usePageHeadingFocus(location.route, shownRoute, mainContent);
  // The sidebar, the page, and the header title slide on one clock instead of a layout each frame.
  const captureSlide = useSidebarSlide(sidebarCollapsed, {
    panel: sidebarPanel,
    followers: [pageContent, headerStart],
  });
  const toggleNavigation = narrowNavigation
    ? toggleNavbar
    : () => {
        captureSlide();
        setSidebarCollapsed(!sidebarCollapsed);
      };
  // Command-B or Control-B does what the header toggle does, and the toggle names the shortcut.
  useNavigationShortcut(toggleNavigation);
  const shortcut = useMemo(() => navigationShortcut(onApplePlatform()), []);
  const sidebarProps = {
    location,
    basePath,
    onNavigate: handleLink,
    onPrefetch: (href: string) => void prefetchPage(href),
    workspaceControl: <WorkspaceSwitcher workspaces={workspaces} workspace={workspace} />,
    version: workhorseVersion,
    revision: workhorseRevision,
  };
  const lineageTaskHref = useCallback(
    (id: string) => mountedHref(basePath, taskHref({ ...location, taskId: id })),
    [basePath, location],
  );
  const drawerPageNavigation = useMemo(
    () => ({ href: (path: string) => mountedHref(basePath, path), followLink: handleLink }),
    [basePath, handleLink],
  );

  return (
    <AppShell
      {...refreshBlockingInputCapture}
      layout="alt"
      header={{ height: 56 }}
      // The page padding changes in one step. `useSidebarSlide` animates the change with
      // transforms, because an animated padding lays out the page on every frame.
      transitionDuration={0}
      data-sidebar={sidebarCollapsed ? "rail" : "panel"}
      navbar={{
        width: dashboardSidebarWidth[sidebarCollapsed ? "collapsed" : "expanded"],
        breakpoint: "sm",
        // Narrow windows show the navigation in a drawer instead.
        collapsed: { mobile: true },
      }}
      padding={{ base: "md", sm: "lg" }}
    >
      <SkipToContentLink targetId={mainContentId} />
      <AppShell.Header>
        {/* The right padding tracks the main-area padding so the last header item lines up with
            the content's right edge. */}
        <div className="dashboard-header">
          <div className="dashboard-header__left" ref={headerStart}>
            <NavigationToggle
              expanded={narrowNavigation ? navbarOpened : !sidebarCollapsed}
              onToggle={toggleNavigation}
              controls={navigationId}
              shortcut={shortcut}
            />
            <span className="dashboard-header__section">{routeHeading(location.route)}</span>
          </div>
          <Tooltip.Provider>
            <div className="dashboard-header__controls">
              <RefreshControl
                loading={loading}
                onRefresh={() => {
                  resetRefreshSchedule();
                  void loadPage();
                }}
                interval={refreshInterval}
                onIntervalChange={changeRefreshInterval}
                paused={autoRefreshPaused}
                pauseDescription={refreshPauseDescription}
                firstPageHref={
                  location.route === "/tasks" && taskListingPinned(location)
                    ? mountedHref(basePath, taskListingHeadHref(location))
                    : null
                }
                onFirstPage={(event) => handleLink(event, taskListingHeadHref(location))}
              />
              {environment && namesDeploymentEnvironment(environment) ? (
                <EnvironmentIndicator environment={environment} />
              ) : null}
              <ConnectionIndicator status={dashboardConnectionStatus(loadState)} />
              <AppearanceToggle />
              {logoutUrl ? <AccountMenu actor={auditActor} logoutUrl={logoutUrl} /> : null}
            </div>
          </Tooltip.Provider>
        </div>
      </AppShell.Header>

      <AppShell.Navbar className="dashboard-navbar" id={navigationId} ref={sidebarPanel}>
        <DashboardSidebar {...sidebarProps} collapsed={sidebarCollapsed} />
      </AppShell.Navbar>
      <DashboardNavigationDrawer
        {...sidebarProps}
        opened={navbarOpened}
        onOpenChange={(opened) => {
          if (opened !== navbarOpened) toggleNavbar();
        }}
      />

      <AppShell.Main
        className="dashboard-main"
        id={mainContentId}
        ref={mainContent}
        // The skip link moves focus here from a script; it does not join the tab order.
        tabIndex={-1}
      >
        <Box w="100%" ref={pageContent}>
          <div role="status" aria-atomic="true">
            {loadState.status === "stale" ? (
              <PageRefreshWarning error={loadState.error} refreshedAt={loadState.refreshedAt} />
            ) : null}
          </div>
          {content}
        </Box>
      </AppShell.Main>
      {taskDrawerRequested ? (
        <Suspense fallback={null}>
          <TaskDrawerPresence onPresent={markTaskDrawerPresent} />
          <TaskDetailDrawer
            auditActor={auditActor}
            controller={controller}
            drawerProps={taskDetailDrawerProps}
            taskLinkHref={lineageTaskHref}
            pageNavigation={drawerPageNavigation}
          />
        </Suspense>
      ) : null}
      <Drawer
        id="event-detail-drawer"
        opened={selectedEventId !== null}
        onClose={closeEventDetail}
        title="Event details"
        position="right"
        closeButtonProps={{ "aria-label": "Close event details" }}
        {...eventDetailDrawerProps}
        classNames={{ content: "task-drawer__content", title: "task-drawer__title" }}
      >
        {eventDetailError ? (
          <Text c="red" size="sm">
            {eventDetailError}
          </Text>
        ) : selectedEvent ? (
          <EventDetails event={selectedEvent} taskLinkHref={lineageTaskHref} />
        ) : (
          <Center mih={200}>
            <Loader size="sm" />
          </Center>
        )}
      </Drawer>
    </AppShell>
  );
}
