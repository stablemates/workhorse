import { useTaskActions } from "../task-actions.js";
import { readTaskChartVisibility, saveTaskChartVisibility } from "../task-view-preferences.js";
import {
  dashboardRedriveBatchDefault,
  type DashboardDemoFeature,
  type DashboardRedriveCursor,
  type DashboardTasksPage,
  type DashboardTasksCursorPage,
} from "@stablemates/workhorse-dashboard-server/wire";
import { taskPageSizes, type TaskLocationState, type TaskPageSize } from "../task-location.js";
import { type RunNowFeedback } from "../run-now.js";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  dashboardDemoFeatureExamples,
  describeRedriveSelection,
  redriveAtLeastOnceWarning,
} from "../presentation.js";
import { notifyFailure, notifyRedriveBatch } from "../notifications.js";
import {
  Badge,
  Box,
  Button,
  Center,
  Code,
  Divider,
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
import { Menu, Select } from "../dropdown-activity.js";
import {
  ArrowCounterClockwise,
  ChartBar,
  CheckCircle,
  Clock,
  Lightning,
  ListChecks,
  PlayCircle,
  XCircle,
} from "@phosphor-icons/react";
import { TaskOpenButton } from "../task-table-ui.js";
import { TaskTableId } from "../components/task-table-id.js";
import { DemoTaskKind, DurableDemoScenario, taskHref, useDashboardClient } from "../core.js";
import {
  DurableProgressBadge,
  TaskListingFilters,
  TaskName,
  TaskEnqueueBadge,
  TaskRowActions,
  TaskTags,
  TaskStatusIndicators,
  taskDuration,
  useTaskFacets,
} from "../components/task-list.js";
import {
  currentTimeZoneValue,
  formatExact,
  formatRelative,
  subscribeTimeZone,
} from "../preferences.js";

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
}) {
  const client = useDashboardClient();
  const [chartVisible, setChartVisible] = useState(readTaskChartVisibility);
  useSyncExternalStore(subscribeTimeZone, currentTimeZoneValue, currentTimeZoneValue);
  const [searchDraft, setSearchDraft] = useState<string | null>(null);
  // A filtered redrive walks a backlog one page at a time. The cursor is what the previous page
  // reported, so confirming again continues rather than redriving the same page a second time.
  const [redrivingSelection, setRedrivingSelection] = useState<{
    cursor: DashboardRedriveCursor | null;
    redriven: number;
    running: boolean;
  } | null>(null);
  const searchInput = searchDraft ?? taskLocation.search ?? "";
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
  /**
   * Redrive one bounded page of the dead letters this listing selects.
   *
   * The page the server reports carries where the next one starts, so confirming again continues
   * through the backlog. A request that failed keeps the cursor it started from, because whatever
   * it did or did not redrive, the page it was asked for is still the page to ask for next.
   */
  const redriveSelected = async () => {
    if (!client.redriveDeadLetters || redrivingSelection === null) return;
    const { cursor, redriven } = redrivingSelection;
    setRedrivingSelection({ cursor, redriven, running: true });
    try {
      const batch = await client.redriveDeadLetters({
        queue: redriveSelection.queue,
        taskType: redriveSelection.taskType,
        tags: redriveSelection.tags,
        limit: dashboardRedriveBatchDefault,
        cursor,
        audit: {
          actor: auditActor,
          reason: `Redrive ${redriveSelection.selected} from the task list`,
          requestId: crypto.randomUUID(),
        },
      });
      notifyRedriveBatch({ results: batch.results, moreRemain: batch.nextCursor !== null });
      const total = redriven + batch.results.filter((one) => one.status === "redriven").length;
      if (batch.nextCursor === null) setRedrivingSelection(null);
      else setRedrivingSelection({ cursor: batch.nextCursor, redriven: total, running: false });
      await reload();
    } catch (cause) {
      notifyFailure(
        "Dead letters not redriven",
        cause,
        "Workhorse could not redrive the selection",
      );
      setRedrivingSelection({ cursor, redriven, running: false });
    }
  };
  const totalPages = Math.max(1, Math.ceil((data.total ?? 0) / data.pageSize));
  const pagination =
    "nextCursor" in data ? (
      <Group gap="xs" aria-label="Tasks pagination">
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
        value={Math.min(data.page, totalPages)}
        onChange={(page) => navigate(taskHref({ ...locationState, page }))}
        total={totalPages}
        size="xs"
        aria-label="Tasks pagination"
      />
    );
  const enqueueTestTask = (kind: DemoTaskKind, options?: DemoTaskOptions) =>
    runDemoTask?.(kind, options);

  return (
    <Stack gap="xl">
      {taskActions.confirmations}
      <Modal
        opened={redrivingSelection !== null}
        onClose={() => setRedrivingSelection(null)}
        title="Redrive these dead letters"
        centered
      >
        <Text size="sm" mb="sm">
          Workhorse redrives at most {dashboardRedriveBatchDefault} dead letters at a time, oldest
          failure first, and reports where the next batch starts. {redriveAtLeastOnceWarning}
        </Text>
        <Code block>{redriveSelection.selected}</Code>
        {redrivingSelection && redrivingSelection.redriven > 0 ? (
          <Text size="sm" mt="sm">
            {redrivingSelection.redriven} redriven so far, and more still match this filter.
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
            onClick={() => void redriveSelected()}
          >
            {redrivingSelection && redrivingSelection.redriven > 0
              ? "Redrive the next batch"
              : `Redrive up to ${dashboardRedriveBatchDefault}`}
          </Button>
        </Group>
      </Modal>
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
              filter={data.filter}
              period={locationState.period}
              groupBy={locationState.group}
              tags={data.tags}
              queue={data.queue}
              worker={data.worker}
              refreshKey={data}
              updateLocation={updateLocation}
            />
          </Suspense>
        </Box>
      ) : null}
      <Paper withBorder>
        <Stack gap="xs" p="md">
          <TaskListingFilters
            data={data}
            searchInput={searchInput}
            setSearchInput={setSearchDraft}
            taskFacets={taskFacets}
            updateLocation={updateLocation}
          />
          <Group justify="flex-end" wrap="wrap">
            <Button
              variant="default"
              size="xs"
              mr="auto"
              leftSection={<ChartBar size={16} />}
              aria-expanded={chartVisible}
              aria-controls="task-activity-chart"
              onClick={() => {
                const visible = !chartVisible;
                setChartVisible(visible);
                saveTaskChartVisibility(visible);
              }}
            >
              {chartVisible ? "Hide chart" : "Show chart"}
            </Button>
            <Group gap="xs" wrap="wrap">
              {data.filter === "discarded" ? (
                <Button
                  variant="default"
                  size="xs"
                  radius="xl"
                  leftSection={<ArrowCounterClockwise size={16} />}
                  disabled={redriveSelection.unavailable !== null || data.tasks.length === 0}
                  title={
                    redriveSelection.unavailable ??
                    (data.tasks.length === 0
                      ? "This listing shows no dead letter, so there is nothing to redrive."
                      : `Redrive ${redriveSelection.selected}`)
                  }
                  onClick={() =>
                    setRedrivingSelection({ cursor: null, redriven: 0, running: false })
                  }
                >
                  Redrive these dead letters
                </Button>
              ) : null}
              {runDemoTask ? (
                <Menu position="bottom-start" withinPortal>
                  <Menu.Target>
                    <Button
                      variant="default"
                      size="xs"
                      radius="xl"
                      leftSection={<PlayCircle size={16} />}
                      loading={runningDemoTask !== null}
                    >
                      Enqueue test task
                    </Button>
                  </Menu.Target>
                  {/* The feature list makes this menu taller than small screens; it scrolls. */}
                  <Menu.Dropdown style={{ maxHeight: "min(560px, 80vh)", overflowY: "auto" }}>
                    <Menu.Label>Test outcome</Menu.Label>
                    <Menu.Item
                      leftSection={<CheckCircle size={16} />}
                      onClick={() => void enqueueTestTask("success")}
                    >
                      Succeed
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<ArrowCounterClockwise size={16} />}
                      onClick={() => void enqueueTestTask("retry")}
                    >
                      Fail once, then retry
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<ListChecks size={16} />}
                      onClick={() =>
                        void enqueueTestTask("durable", { scenario: "order-fulfillment" })
                      }
                    >
                      Durable · order fulfillment · 4 steps
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<ListChecks size={16} />}
                      onClick={() =>
                        void enqueueTestTask("durable", { scenario: "customer-onboarding" })
                      }
                    >
                      Durable · customer onboarding · 3 steps
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<ListChecks size={16} />}
                      onClick={() =>
                        void enqueueTestTask("durable", { scenario: "report-publication" })
                      }
                    >
                      Durable · report publication · 3 steps
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<Clock size={16} />}
                      onClick={() => void enqueueTestTask("timer")}
                    >
                      Durable wait · named timer boundary
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<XCircle size={16} />}
                      color="red"
                      onClick={() => void enqueueTestTask("failure")}
                    >
                      Terminal failure
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<ArrowCounterClockwise size={16} />}
                      onClick={() => void enqueueTestTask("redrive")}
                    >
                      Redrive newest dead letter
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<Clock size={16} />}
                      onClick={() => void enqueueTestTask("long-running")}
                    >
                      Long-running · 20s
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Label>Enqueue behavior</Menu.Label>
                    <Menu.Item
                      leftSection={<Lightning size={16} />}
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
                          leftSection={<Lightning size={16} />}
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
                          leftSection={<Lightning size={16} />}
                          onClick={() => void enqueueTestTask("feature", { feature })}
                        >
                          {label}
                        </Menu.Item>
                      ))}
                  </Menu.Dropdown>
                </Menu>
              ) : null}
              <Select
                size="xs"
                w={76}
                value={String(data.pageSize)}
                data={taskPageSizes.map((size) => ({
                  value: String(size),
                  label: String(size),
                }))}
                onChange={(value) =>
                  updateLocation({
                    pageSize: Number(value ?? 50) as TaskPageSize,
                  })
                }
                allowDeselect={false}
                aria-label="Tasks per page"
              />
              {pagination}
            </Group>
          </Group>
        </Stack>
        <Divider />
        <ScrollArea
          className="task-table-viewport"
          type="auto"
          offsetScrollbars="x"
          viewportProps={{ tabIndex: 0, role: "region", "aria-label": "Tasks table" }}
        >
          <Table
            striped
            highlightOnHover
            verticalSpacing={6}
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
              {data.tasks.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={10}>
                    <Center mih={120}>
                      <Text c="dimmed" size="sm">
                        No tasks match this filter.
                      </Text>
                    </Center>
                  </Table.Td>
                </Table.Tr>
              ) : (
                data.tasks.map((task) => (
                  <Table.Tr
                    key={task.id}
                    onClick={() => inspectTask(task.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <Table.Td className="task-table__col--actions">
                      <TaskRowActions
                        task={task}
                        eventsHref={taskEventsHref(task.id)}
                        onAction={runRowAction}
                        capabilities={{
                          runNow: runTaskNow !== null,
                          completeHumanWait: data.canCompleteHumanWait,
                        }}
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
                      />
                    </Table.Td>
                    <Table.Td className="task-table__col--id">
                      <TaskTableId id={task.id} />
                    </Table.Td>
                    <Table.Td className="task-table__col--status">
                      <TaskStatusIndicators task={task} />
                    </Table.Td>
                    <Table.Td className="task-table__col--queue">
                      <Text size="sm" c="dimmed" title={task.queue}>
                        {task.queue}
                      </Text>
                    </Table.Td>
                    <Table.Td className="task-table__col--task">
                      <TaskOpenButton
                        taskId={task.id}
                        taskType={task.type}
                        onOpen={() => inspectTask(task.id)}
                      >
                        <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                          <TaskName type={task.type} queue={task.queue} />
                          <TaskEnqueueBadge task={task} />
                          {task.priority > 0 ? (
                            <Badge
                              size="xs"
                              variant="light"
                              color="orange"
                              tt="none"
                              title={`Priority ${task.priority}; higher-priority ready tasks are claimed first.`}
                            >
                              P{task.priority}
                            </Badge>
                          ) : null}
                        </Group>
                      </TaskOpenButton>
                    </Table.Td>
                    <Table.Td className="task-table__col--tags">
                      <TaskTags tags={task.tags} />
                    </Table.Td>
                    <Table.Td className="task-table__col--steps" ta="right">
                      <DurableProgressBadge task={task} />
                    </Table.Td>
                    <Table.Td className="task-table__col--attempt" ta="right">
                      <Text
                        size="sm"
                        c={task.attempt > 1 ? "yellow.8" : undefined}
                        fw={task.attempt > 1 ? 600 : undefined}
                      >
                        {task.attempt}/{task.maxAttempts}
                      </Text>
                    </Table.Td>
                    <Table.Td className="task-table__col--duration" ta="left">
                      <Text size="sm" c="dimmed">
                        {taskDuration(task) ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td className="task-table__col--updated" ta="left">
                      <Text size="sm" title={formatExact(task.updatedAt)} c="dimmed">
                        {formatRelative(task.updatedAt)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        <Divider />
        <Group justify="flex-end" p="md">
          {pagination}
        </Group>
      </Paper>
    </Stack>
  );
});
