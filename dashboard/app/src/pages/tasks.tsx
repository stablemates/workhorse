import { useTaskActions } from "../task-actions.js";
import { readTaskChartVisibility, saveTaskChartVisibility } from "../task-view-preferences.js";
import {
  dashboardRedriveBatchDefault,
  type DashboardDemoFeature,
  type DashboardTasksPage,
  type DashboardTasksCursorPage,
  type DashboardTaskCounts,
} from "@stablemates/workhorse-dashboard-server/wire";
import {
  taskListingHeadHref,
  taskListingKey,
  taskListingPinned,
  taskPageSizes,
  type TaskLocationState,
} from "../task-location.js";
import { type RunNowFeedback } from "../run-now.js";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import {
  dashboardDemoFeatureExamples,
  describeRedriveSelection,
  redriveAtLeastOnceWarning,
} from "../presentation.js";
import {
  confirmedRedriveBatch,
  redriveSelectionBlocked,
  type RedriveConfirmation,
} from "../redrive-guard.js";
import { notifyFailure, notifyRedriveBatch } from "../notifications.js";
import {
  Box,
  Button,
  Center,
  Code,
  Group,
  Loader,
  Modal,
  Pagination,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  VisuallyHidden,
} from "@mantine/core";
import { Menu } from "../dropdown-activity.js";
import {
  CancelCircleIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  FlashIcon,
  PlayCircleIcon,
  UndoIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DemoTaskKind,
  DurableDemoScenario,
  taskFilters,
  taskHref,
  useDashboardClient,
} from "../core.js";
import { TaskSortSelect, useTaskFacets } from "../components/task-list.js";
import {
  clearedTaskFilters,
  hasTaskFilters,
  TaskChartToggle,
  TaskFilterBar,
  TaskViewControls,
  TaskViewSelect,
} from "../components/task-filter-bar.js";
import { TaskListRow } from "../components/task-row.js";
import { TaskStatusTabs } from "../components/task-status-tabs.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/page-header.js";
import { currentTimeZoneValue, subscribeTimeZone } from "../preferences.js";
import { formatCount } from "../count-format.js";
import { randomUuid } from "../random-uuid.js";
import {
  PendingResults,
  PendingRows,
  ResultsAnnouncement,
  usePagePending,
} from "../pending-results.js";
import { useRowKeyboardNavigation } from "../list-keyboard.js";
import { taskOpenButtonId } from "../task-table-ui.js";

const TasksActivityChart = lazy(() => import("../charts/activity.js"));

export interface DemoTaskOptions {
  scenario?: DurableDemoScenario;
  feature?: DashboardDemoFeature;
}
// Opening a menu updates the shell's refresh state, but does not change this listing.
export const TasksPage = memo(function TasksPage({
  data,
  navigate,
  runDemoTask,
  runningDemoTask,
  inspectTask,
  taskEventsHref,
  replace,
  taskLocation,
  runTaskNow,
  auditActor,
  reload,
  activityPollTick,
  taskCounts,
  statusNavigation,
}: {
  data: DashboardTasksPage | DashboardTasksCursorPage;
  navigate: (href: string) => void;
  replace: (href: string) => void;
  taskLocation: TaskLocationState;
  runDemoTask: ((kind: DemoTaskKind, options?: DemoTaskOptions) => Promise<void>) | null;
  runningDemoTask: DemoTaskKind | null;
  inspectTask: (id: string) => void;
  taskEventsHref: (id: string) => string;
  /**
   * Release one scheduled task, or null when the host cannot. Null is passed through to the menu
   * as a stated reason rather than removing the item.
   */
  runTaskNow: ((id: string) => Promise<RunNowFeedback>) | null;
  auditActor: string;
  reload: () => Promise<void>;
  activityPollTick: number;
  /** Counts for each status view, or null before they load. */
  taskCounts: Partial<DashboardTaskCounts> | null;
  /** How the status views link: a mounted href, and a click handler for in-app navigation. */
  statusNavigation: {
    href: (path: string) => string;
    followLink: (event: MouseEvent<HTMLElement>, path: string) => void;
  };
}) {
  const client = useDashboardClient();
  // A status, filter, sort, or pager change keeps these rows, dimmed, until the new rows arrive.
  const pending = usePagePending();
  const [chartVisible, setChartVisible] = useState(readTaskChartVisibility);
  const timeZone = useSyncExternalStore(
    subscribeTimeZone,
    currentTimeZoneValue,
    currentTimeZoneValue,
  );
  // Rows read one instant rather than the clock, so the whole page agrees on how old its work is.
  const shownAt = Date.now();
  const [searchDraft, setSearchDraft] = useState<string | null>(null);
  // A filtered redrive walks a backlog one page at a time. The cursor is what the previous page
  // reported, so confirming again continues rather than redriving the same page a second time.
  // The selection is the one the dialog showed when it opened, so later results cannot change it.
  const [redrivingSelection, setRedrivingSelection] = useState<RedriveConfirmation | null>(null);
  const searchInput = searchDraft ?? taskLocation.search ?? "";
  const taskTable = useRef<HTMLDivElement | null>(null);
  // ArrowDown, ArrowUp, j, and k move through the rows, and through the drawer while it is open.
  useRowKeyboardNavigation({
    list: () => taskTable.current,
    rowSelector: ".task-table__open",
    panel: {
      id: "task-detail-drawer",
      ids: data.tasks.map((task) => task.id),
      openId: taskLocation.taskId,
      open: inspectTask,
      rowControl: (id) => document.getElementById(taskOpenButtonId(id)),
    },
  });
  const taskFacets = useTaskFacets(data);
  const locationState: TaskLocationState = taskLocation;
  const updateLocation = useCallback(
    (updates: Partial<TaskLocationState>, useReplace = false) => {
      const href = taskHref({
        ...locationState,
        page: 1,
        cursor: null,
        direction: "next",
        ...updates,
      });
      if (useReplace) replace(href);
      else navigate(href);
    },
    [locationState, navigate, replace],
  );
  useEffect(() => {
    if (searchDraft === null) return;
    const timer = setTimeout(() => {
      const search = searchDraft.trim() || null;
      if (search !== taskLocation.search) updateLocation({ search }, true);
      setSearchDraft(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft, taskLocation.search, updateLocation]);
  const taskActions = useTaskActions({
    canCompleteHumanWait: data.canCompleteHumanWait,
    inspectTask,
    runTaskNow,
    auditActor,
    reload,
    updateLocation,
  });
  const {
    runRowAction,
    completingHumanWaitTaskId,
    redrivingTaskId,
    runningNowTaskId,
    cancelingTaskId,
  } = taskActions;
  const redriveSelection = describeRedriveSelection(data);
  const redriveBlocked = redriveSelectionBlocked({
    selection: redriveSelection,
    shownTasks: data.tasks.length,
    pending,
  });
  /**
   * Redrive one bounded page of the dead letters this listing selects.
   *
   * The page the server reports carries where the next one starts, so confirming again continues
   * through the backlog. A request that failed keeps the cursor it started from, because whatever
   * it did or did not redrive, the page it was asked for is still the page to ask for next.
   * The request uses only the selection that the dialog shows, and none while new results load.
   */
  const redriveSelected = async () => {
    const request = confirmedRedriveBatch(redrivingSelection, pending);
    if (!client.redriveDeadLetters || redrivingSelection === null || request === null) return;
    const { selection, cursor, redriven } = redrivingSelection;
    setRedrivingSelection({ selection, cursor, redriven, running: true });
    try {
      const batch = await client.redriveDeadLetters({
        queue: request.queue,
        taskType: request.taskType,
        tags: request.tags,
        limit: dashboardRedriveBatchDefault,
        cursor: request.cursor,
        audit: {
          actor: auditActor,
          reason: `Redrive ${request.selected} from the task list`,
          requestId: randomUuid(),
        },
      });
      notifyRedriveBatch({ results: batch.results, moreRemain: batch.nextCursor !== null });
      const total = redriven + batch.results.filter((one) => one.status === "redriven").length;
      if (batch.nextCursor === null) setRedrivingSelection(null);
      else
        setRedrivingSelection({
          selection,
          cursor: batch.nextCursor,
          redriven: total,
          running: false,
        });
      await reload();
    } catch (cause) {
      notifyFailure(
        "Dead letters not redriven",
        cause,
        "Workhorse could not redrive the selection",
      );
      setRedrivingSelection({ selection, cursor, redriven, running: false });
    }
  };
  // Offset pages report the total they proved rather than a count over every matching task, so the
  // pager gains one page while more remain and settles on the real last page once it is reached.
  const totalPages = Math.max(1, Math.ceil((data.total ?? 0) / data.pageSize));
  const pinned = taskListingPinned(locationState);
  /**
   * What a page other than the first costs the operator.
   *
   * A pinned page neither follows new tasks nor refreshes, so the pager says so at every width,
   * next to the control that returns to the first page.
   */
  const pinnedNotice = pinned ? (
    <Text
      size="xs"
      c="dimmed"
      title="This page is anchored, so it neither follows new tasks nor auto refreshes. Return to the first page to follow the list again."
    >
      Not following new tasks
    </Text>
  ) : null;
  const pagination =
    "nextCursor" in data ? (
      <Group gap="xs" aria-label="Tasks pagination" role="navigation">
        <Button
          size="xs"
          variant={pinned ? "default" : "subtle"}
          disabled={!pinned}
          title="Return to the first page, so the list follows new work again"
          onClick={() => navigate(taskListingHeadHref(locationState))}
        >
          First
        </Button>
        <Button
          size="xs"
          variant="subtle"
          disabled={!data.previousCursor}
          onClick={() =>
            navigate(
              taskHref({
                ...locationState,
                page: 1,
                cursor: data.previousCursor,
                direction: "previous",
              }),
            )
          }
        >
          Previous
        </Button>
        <Button
          size="xs"
          variant="subtle"
          disabled={!data.nextCursor}
          onClick={() =>
            navigate(
              taskHref({ ...locationState, page: 1, cursor: data.nextCursor, direction: "next" }),
            )
          }
        >
          Next
        </Button>
      </Group>
    ) : (
      <Pagination
        // The pager moves on the click. The rows follow when they arrive.
        value={Math.min(pending ? locationState.page : data.page, totalPages)}
        onChange={(page) => navigate(taskHref({ ...locationState, page }))}
        total={totalPages}
        size="sm"
        aria-label="Tasks pagination"
      />
    );
  const pageable =
    pinned ||
    ("nextCursor" in data ? Boolean(data.nextCursor || data.previousCursor) : totalPages > 1);
  const filtered = hasTaskFilters(locationState);
  const clearFilters = () => {
    setSearchDraft(null);
    updateLocation(clearedTaskFilters);
  };
  const viewLabel = taskFilters.find((one) => one.value === data.filter)?.label ?? "All tasks";
  const enqueueTestTask = (kind: DemoTaskKind, options?: DemoTaskOptions) =>
    runDemoTask?.(kind, options);

  return (
    <Stack gap={16}>
      {taskActions.confirmations}
      <Modal
        opened={redrivingSelection !== null}
        onClose={() => setRedrivingSelection(null)}
        title="Redrive these dead letters"
        centered
      >
        <Text size="sm" mb="sm">
          Workhorse redrives at most {formatCount(dashboardRedriveBatchDefault)} dead letters at a
          time, oldest failure first, and reports where the next batch starts.{" "}
          {redriveAtLeastOnceWarning}
        </Text>
        <Code block>{redrivingSelection?.selection.selected}</Code>
        {redrivingSelection && redrivingSelection.redriven > 0 ? (
          <Text size="sm" mt="sm">
            {formatCount(redrivingSelection.redriven)} redriven so far, and more still match this
            filter.
          </Text>
        ) : null}
        <Group justify="flex-end" mt="lg">
          <Button
            variant="default"
            disabled={redrivingSelection?.running === true}
            onClick={() => setRedrivingSelection(null)}
          >
            {redrivingSelection && redrivingSelection.redriven > 0 ? "Stop here" : "Cancel"}
          </Button>
          <Button
            loading={redrivingSelection?.running === true}
            disabled={pending}
            title={pending ? "Wait for the new results to load." : undefined}
            onClick={() => void redriveSelected()}
          >
            {redrivingSelection && redrivingSelection.redriven > 0
              ? "Redrive the next batch"
              : `Redrive up to ${formatCount(dashboardRedriveBatchDefault)}`}
          </Button>
        </Group>
      </Modal>
      <PageHeader
        title="Tasks"
        // The status row names the current view, and the Blocked tab explains itself in a tooltip.
        // The header keeps one height for every view, so the list below it does not move.
        inlineActions
        actions={
          data.filter === "discarded" || runDemoTask ? (
            <>
              {data.filter === "discarded" ? (
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<HugeiconsIcon icon={UndoIcon} size={16} />}
                  disabled={redriveBlocked !== null}
                  title={redriveBlocked ?? `Redrive ${redriveSelection.selected}`}
                  onClick={() => {
                    if (redriveBlocked !== null) return;
                    setRedrivingSelection({
                      selection: redriveSelection,
                      cursor: null,
                      redriven: 0,
                      running: false,
                    });
                  }}
                  // A phone shows the short label, so the action fits on the title line.
                  aria-label="Redrive these dead letters"
                >
                  <span className="tasks-redrive__long">Redrive these dead letters</span>
                  <span className="tasks-redrive__short" aria-hidden="true">
                    Redrive
                  </span>
                </Button>
              ) : null}
              {runDemoTask ? (
                <Menu position="bottom-start" withinPortal>
                  <Menu.Target>
                    <Button
                      variant="default"
                      size="xs"
                      leftSection={<HugeiconsIcon icon={PlayCircleIcon} size={16} />}
                      loading={runningDemoTask !== null}
                    >
                      Enqueue test task
                    </Button>
                  </Menu.Target>
                  {/* The feature list makes this menu taller than small screens; it scrolls. */}
                  <Menu.Dropdown style={{ maxHeight: "min(560px, 80vh)", overflowY: "auto" }}>
                    <Menu.Label>Test outcome</Menu.Label>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={CheckmarkCircle02Icon} size={16} />}
                      onClick={() => void enqueueTestTask("success")}
                    >
                      Succeed
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={UndoIcon} size={16} />}
                      onClick={() => void enqueueTestTask("retry")}
                    >
                      Fail once, then retry
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={CheckListIcon} size={16} />}
                      onClick={() =>
                        void enqueueTestTask("durable", { scenario: "order-fulfillment" })
                      }
                    >
                      Durable · order fulfillment · 4 steps
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={CheckListIcon} size={16} />}
                      onClick={() =>
                        void enqueueTestTask("durable", { scenario: "customer-onboarding" })
                      }
                    >
                      Durable · customer onboarding · 3 steps
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={CheckListIcon} size={16} />}
                      onClick={() =>
                        void enqueueTestTask("durable", { scenario: "report-publication" })
                      }
                    >
                      Durable · report publication · 3 steps
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={Clock01Icon} size={16} />}
                      onClick={() => void enqueueTestTask("timer")}
                    >
                      Durable wait · named timer boundary
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={CancelCircleIcon} size={16} />}
                      color="red"
                      onClick={() => void enqueueTestTask("failure")}
                    >
                      Terminal failure
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={UndoIcon} size={16} />}
                      onClick={() => void enqueueTestTask("redrive")}
                    >
                      Redrive newest dead letter
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={Clock01Icon} size={16} />}
                      onClick={() => void enqueueTestTask("long-running")}
                    >
                      Long-running · 20s
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Label>Enqueue behavior</Menu.Label>
                    <Menu.Item
                      leftSection={<HugeiconsIcon icon={FlashIcon} size={16} />}
                      onClick={() => void enqueueTestTask("idempotent")}
                    >
                      Idempotency · reuse one task for repeat requests
                    </Menu.Item>
                    {dashboardDemoFeatureExamples
                      .filter(
                        ({ feature }) =>
                          feature === "keyed-debounce" || feature === "keyed-throttle",
                      )
                      .map(({ feature, label }) => (
                        <Menu.Item
                          key={feature}
                          leftSection={<HugeiconsIcon icon={FlashIcon} size={16} />}
                          onClick={() => void enqueueTestTask("feature", { feature })}
                        >
                          {label}
                        </Menu.Item>
                      ))}
                    <Menu.Divider />
                    <Menu.Label>Feature examples</Menu.Label>
                    {dashboardDemoFeatureExamples
                      .filter(
                        ({ feature }) =>
                          feature !== "keyed-debounce" && feature !== "keyed-throttle",
                      )
                      .map(({ feature, label }) => (
                        <Menu.Item
                          key={feature}
                          leftSection={<HugeiconsIcon icon={FlashIcon} size={16} />}
                          onClick={() => void enqueueTestTask("feature", { feature })}
                        >
                          {label}
                        </Menu.Item>
                      ))}
                  </Menu.Dropdown>
                </Menu>
              ) : null}
            </>
          ) : undefined
        }
      />
      <TaskStatusTabs
        location={locationState}
        taskCounts={taskCounts}
        href={statusNavigation.href}
        followLink={statusNavigation.followLink}
      />
      <Group justify="space-between" align="flex-start" gap="xs" wrap="wrap">
        <Box style={{ flex: "1 1 480px", minWidth: 0 }}>
          <TaskFilterBar
            selection={locationState}
            searchInput={searchInput}
            setSearchInput={setSearchDraft}
            taskFacets={taskFacets}
            updateLocation={updateLocation}
            onClearFilters={clearFilters}
          />
        </Box>
        <TaskViewControls>
          <TaskSortSelect
            sort={pending ? locationState.sort : data.sort}
            updateLocation={updateLocation}
          />
          <TaskViewSelect
            label="Tasks per page"
            value={String(pending ? locationState.pageSize : data.pageSize)}
            options={taskPageSizes.map((size) => ({
              value: String(size),
              label: `${size} per page`,
            }))}
            onChange={(value) => {
              const pageSize = taskPageSizes.find((size) => String(size) === value);
              if (pageSize !== undefined) updateLocation({ pageSize });
            }}
            width={136}
          />
          <TaskChartToggle
            visible={chartVisible}
            onChange={(visible) => {
              setChartVisible(visible);
              saveTaskChartVisibility(visible);
            }}
          />
        </TaskViewControls>
      </Group>
      {chartVisible ? (
        <Box id="task-activity-chart">
          <Suspense
            fallback={
              <Paper withBorder p="md">
                <Center h={320}>
                  <Loader size="sm" />
                </Center>
              </Paper>
            }
          >
            <TasksActivityChart
              filter={locationState.filter}
              period={locationState.period}
              groupBy={locationState.group}
              tags={locationState.tags}
              queue={locationState.queue}
              worker={locationState.worker}
              refreshKey={activityPollTick}
              updateLocation={updateLocation}
            />
          </Suspense>
        </Box>
      ) : null}
      <ResultsAnnouncement
        requestKey={taskListingKey(locationState)}
        pending={pending}
        count={data.tasks.length}
        message={
          data.tasks.length === 0
            ? "No tasks match this view."
            : `The table shows ${formatCount(data.tasks.length)} ${data.tasks.length === 1 ? "task" : "tasks"}.`
        }
      />
      <PendingResults pending={pending} requestKey={taskListingKey(locationState)}>
        <Paper withBorder ref={taskTable}>
          <ScrollArea
            className="task-table-viewport"
            type="auto"
            offsetScrollbars="x"
            viewportProps={{ tabIndex: 0, role: "region", "aria-label": "Tasks table" }}
          >
            <Table
              highlightOnHover
              verticalSpacing={8}
              horizontalSpacing="sm"
              aria-label="Tasks matching the current filters"
              className="dashboard-table task-table"
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th className="task-table__col--actions" w={44}>
                    <VisuallyHidden>Actions</VisuallyHidden>
                  </Table.Th>
                  <Table.Th className="task-table__col--id">Task ID</Table.Th>
                  <Table.Th className="task-table__col--status">Status</Table.Th>
                  <Table.Th className="task-table__col--queue">Queue</Table.Th>
                  <Table.Th className="task-table__col--task">Task</Table.Th>
                  <Table.Th className="task-table__col--tags">Tags</Table.Th>
                  <Table.Th className="task-table__col--steps" ta="right">
                    Steps
                  </Table.Th>
                  <Table.Th className="task-table__col--attempt" ta="right">
                    Attempt
                  </Table.Th>
                  <Table.Th className="task-table__col--duration" ta="left">
                    Duration
                  </Table.Th>
                  <Table.Th className="task-table__col--updated" ta="left">
                    Updated
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <PendingRows>
                  {data.tasks.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={10}>
                        <TasksEmptyState
                          filtered={filtered}
                          pinned={pinned}
                          viewLabel={viewLabel}
                          onClearFilters={clearFilters}
                        />
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    data.tasks.map((task) => (
                      <TaskListRow
                        key={task.id}
                        task={task}
                        eventsHref={taskEventsHref(task.id)}
                        onOpen={inspectTask}
                        onAction={runRowAction}
                        canRunNow={runTaskNow !== null}
                        canCompleteHumanWait={data.canCompleteHumanWait}
                        pendingAction={
                          cancelingTaskId === task.id
                            ? "cancel"
                            : completingHumanWaitTaskId === task.id
                              ? "complete-human-wait"
                              : redrivingTaskId === task.id
                                ? "redrive"
                                : runningNowTaskId === task.id
                                  ? "run-now"
                                  : null
                        }
                        selected={taskLocation.taskId === task.id}
                        shownAt={shownAt}
                        timeZone={timeZone}
                      />
                    ))
                  )}
                </PendingRows>
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      </PendingResults>
      {/* A single page has nowhere to go, so the pager only shows when it can move the list. */}
      <Group justify="space-between" gap="xs" wrap="wrap" mt={-4}>
        {pinnedNotice ?? <TaskKeyboardHint />}
        {pageable ? <Box ml="auto">{pagination}</Box> : null}
      </Group>
    </Stack>
  );
});

/** The keys that move through the list. A phone has no keyboard, so it does not show there. */
function TaskKeyboardHint() {
  return (
    <p className="task-keyboard-hint" aria-hidden="true">
      <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>J</kbd> <kbd>K</kbd> to move, <kbd>Enter</kbd> to open,{" "}
      <kbd>Esc</kbd> to close
    </p>
  );
}

/**
 * What an empty listing means, said specifically.
 *
 * A filtered list that matches nothing offers to clear the filters. A pinned page that is empty
 * points back to the first page, because the tasks it held moved on. An empty status view says
 * that no task is in that state now, which is not a failure.
 */
function TasksEmptyState({
  filtered,
  pinned,
  viewLabel,
  onClearFilters,
}: {
  filtered: boolean;
  pinned: boolean;
  viewLabel: string;
  onClearFilters: () => void;
}) {
  const [title, description] = filtered
    ? [
        "No tasks match these filters",
        "Change the search or a filter, or clear them to see every task in this view.",
      ]
    : pinned
      ? [
          "No tasks on this page",
          "The tasks this page held have moved. Return to the first page to see the newest tasks.",
        ]
      : viewLabel === "All tasks"
        ? ["No tasks yet", "Tasks show here when an application enqueues work."]
        : [`No ${viewLabel.toLowerCase()} tasks`, "No task is in this state now."];
  return (
    <EmptyState
      framed={false}
      title={title}
      action={
        filtered ? (
          <Button variant="default" size="xs" onClick={onClearFilters}>
            Clear filters
          </Button>
        ) : undefined
      }
    >
      {description}
    </EmptyState>
  );
}
