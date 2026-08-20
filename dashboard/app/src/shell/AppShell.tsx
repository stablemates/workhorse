import type { DashboardDemoTools, DashboardWorkspaceLink } from "@workhorse/dashboard-server";
import { Menu, useDropdownActivity } from "../dropdown-activity.js";
import {
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Center,
  Divider,
  Drawer,
  Group,
  Loader,
  NavLink,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import {
  ArrowClockwise,
  BookOpenText,
  Buildings,
  CalendarDots,
  CheckCircle,
  GearSix,
  Lightning,
  ListDashes,
  Pulse,
  Robot,
  UserFocus,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  useRefreshBlockingInputCapture,
  useDashboardWindowActivityRefreshBlocker,
} from "../refresh-blockers.js";
import { useMediaQuery } from "@mantine/hooks";
import { useCallback, useLayoutEffect, useRef } from "react";
import { dashboardRefreshIntervalMs, dashboardRefreshIntervals } from "../refresh-policy.js";
import {
  taskDrawerCloseOnEscape,
  taskDrawerFocusChange,
  taskDrawerModelessProps,
  taskDrawerViewportProps,
} from "../task-drawer.js";
import { taskOpenButtonId } from "../task-table-ui.js";
import { WorkhorseBrand, WorkhorseVersion } from "../brand.js";
import { ThemeSchemeSwitch } from "../theme.js";
import { DashboardProps } from "../dashboard.js";
import { useDashboardController } from "./controller.js";
import {
  blockedTaskDescription,
  environmentColor,
  mountedHref,
  taskFilters,
  taskHref,
} from "../core.js";
import { EventDetails } from "../pages/events.js";
import { TaskDetailDrawer } from "../pages/task-detail.js";

/** Header control that switches between the host's workspaces. Renders nothing with one. */
export function DashboardWorkspaceSwitcher({
  workspaces,
  workspace,
}: {
  workspaces: readonly DashboardWorkspaceLink[];
  workspace: string | null;
}) {
  if (workspaces.length < 2 || !workspace) return null;
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Button
          variant="default"
          size="xs"
          leftSection={<Buildings size={14} />}
          aria-label={`Workspace ${workspace}`}
        >
          {workspace}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Workspaces</Menu.Label>
        {workspaces.map((entry) => (
          // A plain link on purpose: each workspace is its own document with its own runtime
          // configuration, so switching is a navigation, not a state change.
          <Menu.Item
            key={entry.name}
            component="a"
            href={`${entry.url}/tasks`}
            disabled={entry.name === workspace}
          >
            {entry.name}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
export function DashboardContent({
  auditActor,
  logoutUrl,
  demoTools,
  basePath,
  workspaces,
  workspace,
}: Required<Pick<DashboardProps, "auditActor">> & {
  logoutUrl: string | null;
  demoTools: DashboardDemoTools | null;
  basePath: string;
  workspaces: readonly DashboardWorkspaceLink[];
  workspace: string | null;
}) {
  useDashboardWindowActivityRefreshBlocker();
  const controller = useDashboardController(auditActor, demoTools, basePath);
  const dropdownOpened = useDropdownActivity();
  const narrowDetailDrawer = useMediaQuery("(max-width: 47.99em)");
  const refreshBlockingInputCapture = useRefreshBlockingInputCapture();
  const previousTaskDrawerId = useRef<string | null>(null);
  const taskDrawerReturnTarget = useRef<HTMLElement | null>(null);
  const {
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
    selectedJobId,
    selectedEventId,
    selectedEvent,
    eventDetailError,
    closeEventDetail,
  } = controller;
  const refreshProgressDuration = dashboardRefreshIntervalMs(refreshInterval);
  const taskDetailDrawerProps = {
    ...taskDrawerViewportProps(narrowDetailDrawer),
    closeOnEscape: taskDrawerCloseOnEscape(dropdownOpened),
  };
  const eventDetailDrawerProps = {
    ...taskDrawerModelessProps,
    closeOnEscape: taskDrawerCloseOnEscape(dropdownOpened),
  };
  useLayoutEffect(() => {
    const focusChange = taskDrawerFocusChange(previousTaskDrawerId.current, selectedJobId);
    previousTaskDrawerId.current = selectedJobId;
    if (focusChange === "none") return;
    if (focusChange === "trigger") {
      taskDrawerReturnTarget.current?.focus();
      return;
    }
    if (selectedJobId === null) return;

    const trigger = document.getElementById(taskOpenButtonId(selectedJobId));
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
  }, [selectedJobId]);
  const lineageTaskHref = useCallback(
    (id: string) => mountedHref(basePath, taskHref({ ...location, taskId: id })),
    [basePath, location],
  );

  return (
    <AppShell
      {...refreshBlockingInputCapture}
      header={{ height: 64 }}
      navbar={{
        width: 256,
        breakpoint: "sm",
        collapsed: { mobile: !navbarOpened },
      }}
      padding={{ base: "md", sm: "xl" }}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap={0} wrap="nowrap">
            <Group gap="sm" wrap="nowrap" w={{ sm: 240 }}>
              <Burger
                opened={navbarOpened}
                onClick={toggleNavbar}
                hiddenFrom="sm"
                size="sm"
                aria-label="Open or close navigation"
              />
              <WorkhorseBrand />
            </Group>
            <Group
              gap={0}
              wrap="nowrap"
              ml={{ base: "md", sm: "xl" }}
              className="dashboard-refresh-control"
            >
              <Button
                variant="default"
                size="xs"
                w={120}
                leftSection={<ArrowClockwise size={14} />}
                loading={loading}
                onClick={() => {
                  resetRefreshSchedule();
                  void loadPage();
                }}
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
              >
                {resumeCountdown === null ? "Refresh" : `Refresh (${resumeCountdown})`}
              </Button>
              <Menu position="bottom-start" withinPortal>
                <Menu.Target>
                  <Button
                    variant="default"
                    size="xs"
                    w={56}
                    px={6}
                    style={{
                      borderTopLeftRadius: 0,
                      borderBottomLeftRadius: 0,
                      borderLeft: "none",
                    }}
                    aria-label={refreshPauseDescription}
                  >
                    {autoRefreshPaused
                      ? "paused"
                      : refreshInterval === "off"
                        ? "manual"
                        : refreshInterval}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Auto refresh</Menu.Label>
                  {dashboardRefreshIntervals.map((option) => (
                    <Menu.Item
                      key={option.value}
                      onClick={() => changeRefreshInterval(option.value)}
                      rightSection={
                        refreshInterval === option.value ? <CheckCircle size={14} /> : null
                      }
                    >
                      {option.label}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
              {refreshProgressDuration !== null ? (
                <Box
                  key={`${location.route}-${refreshInterval}-${refreshScheduleResetKey}`}
                  className="dashboard-refresh-control__progress"
                  style={{
                    animationDuration: `${refreshProgressDuration}ms`,
                    animationPlayState: autoRefreshPaused ? "paused" : "running",
                  }}
                  aria-hidden
                />
              ) : null}
            </Group>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <ThemeSchemeSwitch />
            {logoutUrl ? (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <Button
                    variant="default"
                    size="xs"
                    leftSection={<UserFocus size={14} />}
                    aria-label={`Signed in as ${auditActor}`}
                  >
                    {auditActor}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Signed in as {auditActor}</Menu.Label>
                  <form action={logoutUrl} method="post">
                    <Menu.Item component="button" type="submit">
                      Sign out
                    </Menu.Item>
                  </form>
                </Menu.Dropdown>
              </Menu>
            ) : null}
            <DashboardWorkspaceSwitcher workspaces={workspaces} workspace={workspace} />
            {environment ? (
              <Badge
                color={environmentColor(environment)}
                variant="light"
                visibleFrom="xs"
                title="Deployment environment"
              >
                {environment}
              </Badge>
            ) : null}
            <Badge
              color={loadState.status === "error" ? "red" : connected ? "teal" : "gray"}
              variant="light"
              leftSection={
                loadState.status === "error" ? (
                  <WarningCircle size={12} />
                ) : (
                  <CheckCircle size={12} />
                )
              }
              visibleFrom="xs"
              role="status"
              aria-label={
                loadState.status === "error"
                  ? "Dashboard disconnected"
                  : connected
                    ? "Dashboard connected"
                    : "Dashboard connecting"
              }
            >
              {loadState.status === "error"
                ? "Disconnected"
                : connected
                  ? "Connected"
                  : "Connecting"}
            </Badge>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md">
        <AppShell.Section grow component={ScrollArea}>
          <Stack gap={2}>
            <Text c="dimmed" fw={600} size="xs" px="sm" mb={4}>
              Tasks
            </Text>
            {taskFilters.map((filter) => {
              const href = taskHref({
                ...location,
                filter: filter.value,
                page: 1,
              });
              const count = taskCounts?.[filter.value];
              const Icon = filter.icon;
              return (
                <NavLink
                  key={filter.value}
                  component="a"
                  href={mountedHref(basePath, href)}
                  active={location.route === "/tasks" && location.filter === filter.value}
                  label={filter.label}
                  title={filter.value === "blocked" ? blockedTaskDescription : undefined}
                  leftSection={<Icon size={18} />}
                  variant="light"
                  rightSection={
                    count === undefined ? null : (
                      <Badge variant="light" color="gray" miw={32}>
                        {count}
                      </Badge>
                    )
                  }
                  onClick={(event) => handleLink(event, href)}
                />
              );
            })}
          </Stack>
          <Divider my="sm" />
          <Stack gap={2}>
            <Text c="dimmed" fw={600} size="xs" px="sm" mb={4}>
              Operations
            </Text>
            <NavLink
              component="a"
              href={mountedHref(basePath, "/events")}
              active={location.route === "/events"}
              label="Events"
              leftSection={<Lightning size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/events")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/cron")}
              active={location.route === "/cron"}
              label="Schedules"
              leftSection={<CalendarDots size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/cron")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/queues")}
              active={location.route === "/queues"}
              label="Queues"
              leftSection={<ListDashes size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/queues")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/system")}
              active={location.route === "/system"}
              label="System health"
              leftSection={<Pulse size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/system")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/workers")}
              active={location.route === "/workers"}
              label="Workers"
              leftSection={<Robot size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/workers")}
            />
            <NavLink
              component="a"
              href={mountedHref(basePath, "/settings")}
              active={location.route === "/settings"}
              label="Settings"
              leftSection={<GearSix size={18} />}
              variant="light"
              onClick={(event) => handleLink(event, "/settings")}
            />
          </Stack>
        </AppShell.Section>
        <AppShell.Section>
          <NavLink
            component="a"
            href="https://workhorse.run/docs"
            label="Documentation"
            leftSection={<BookOpenText size={18} />}
            variant="light"
          />
          <WorkhorseVersion />
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Box w="100%">{content}</Box>
      </AppShell.Main>
      <TaskDetailDrawer
        auditActor={auditActor}
        controller={controller}
        drawerProps={taskDetailDrawerProps}
        taskLinkHref={lineageTaskHref}
      />
      <Drawer
        id="event-detail-drawer"
        opened={selectedEventId !== null}
        onClose={closeEventDetail}
        title={
          <Text component="h2" fw={600} size="lg" my={0}>
            Event details
          </Text>
        }
        position="right"
        closeButtonProps={{ "aria-label": "Close event details" }}
        {...eventDetailDrawerProps}
        classNames={{ content: "task-drawer__content" }}
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
