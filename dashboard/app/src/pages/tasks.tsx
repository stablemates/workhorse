import {
  dashboardRedriveBatchDefault,
  type DashboardDemoFeature,
  type DashboardJobRow,
  type DashboardRedriveCursor,
  type DashboardTasksPage,
} from "@stablemates/workhorse-dashboard-server/wire";
import { taskPageSizes, type TaskLocationState, type TaskPageSize } from "../task-location.js";
import { type RunNowFeedback } from "../run-now.js";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  dashboardDemoFeatureExamples,
  describeRedriveSelection,
  humanWaitQuickAction,
  redriveAtLeastOnceWarning,
} from "../presentation.js";
import type { TaskRowActionId } from "../presentation.js";
import {
  notifyDashboard,
  notifyFailure,
  notifyRedrive,
  notifyRedriveBatch,
  notifyRunNow,
} from "../notifications.js";
import {
  Badge,
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
  CheckCircle,
  Clock,
  Lightning,
  ListChecks,
  PlayCircle,
  XCircle,
} from "@phosphor-icons/react";
import { TaskOpenButton } from "../task-table-ui.js";
import { StatusBadge } from "../status-badge.js";
import { DemoJobKind, DurableDemoScenario, taskHref, useDashboardClient } from "../core.js";
import {
  CancelRequestedBadge,
  DurableProgressBadge,
  TaskBlockedBy,
  TaskListingFilters,
  TaskName,
  TaskRowActions,
  TaskStatusDetail,
  TaskTags,
  TaskWaitBadge,
  taskDuration,
  useTaskFacets,
} from "../components/task-list.js";
import { copyToClipboard, formatExact, formatJson, formatRelative } from "../preferences.js";

const TasksActivityChart = lazy(() => import("../charts/activity.js"));

export interface DemoJobOptions {
  scenario?: DurableDemoScenario;
  feature?: DashboardDemoFeature;
}
export function TasksPage({
  data,
  navigate,
  runDemoJob,
  runningDemoJob,
  inspectJob,
  replace,
  taskLocation,
  runTaskNow,
  auditActor,
  reload,
}: {
  data: DashboardTasksPage;
  navigate: (href: string) => void;
  replace: (href: string) => void;
  taskLocation: TaskLocationState;
  runDemoJob: ((kind: DemoJobKind, options?: DemoJobOptions) => Promise<void>) | null;
  runningDemoJob: DemoJobKind | null;
  inspectJob: (id: string, options?: { confirmCancel?: boolean }) => void;
  /**
   * Release one scheduled task, or null when the host cannot. Null is passed through to the menu
   * as a stated reason rather than removing the item.
   */
  runTaskNow: ((id: string) => Promise<RunNowFeedback>) | null;
  auditActor: string;
  reload: () => Promise<void>;
}) {
  const client = useDashboardClient();
  const [searchDraft, setSearchDraft] = useState<string | null>(null);
  // The one row action that is applied here rather than in the drawer. What it reported goes to
  // the notification system, so only the in-flight row is state this page has to hold.
  const [runningNowJobId, setRunningNowJobId] = useState<string | null>(null);
  const [completingHumanWaitJobId, setCompletingHumanWaitJobId] = useState<string | null>(null);
  const [confirmingHumanWait, setConfirmingHumanWait] = useState<{
    jobId: string;
    waitName: string;
    quickAction: NonNullable<ReturnType<typeof humanWaitQuickAction>>;
  } | null>(null);
  const [confirmingRedrive, setConfirmingRedrive] = useState<DashboardJobRow | null>(null);
  const [redrivingJobId, setRedrivingJobId] = useState<string | null>(null);
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
      const href = taskHref({ ...locationState, page: 1, ...updates });
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
  /**
   * Apply one row action.
   *
   * Only the two clipboard actions finish here. Filtering goes through the same location update the
   * filter controls use, so the URL stays the single description of what this list is showing, and
   * cancellation opens the drawer instead of acting, because an irreversible action is confirmed
   * with a reason before it is applied.
   */
  const runRowAction = useCallback(
    (id: TaskRowActionId, job: DashboardJobRow) => {
      if (id === "inspect") return inspectJob(job.id);
      if (id === "cancel") return inspectJob(job.id, { confirmCancel: true });
      if (id === "complete-human-wait") {
        const wait = job.humanWait;
        const quickAction = wait ? humanWaitQuickAction(wait.context) : null;
        if (!wait || !quickAction || !data.canCompleteHumanWait || completingHumanWaitJobId) return;
        setConfirmingHumanWait({ jobId: job.id, waitName: wait.name, quickAction });
        return;
      }
      if (id === "run-now") {
        if (runTaskNow === null || runningNowJobId !== null) return;
        setRunningNowJobId(job.id);
        void runTaskNow(job.id)
          .then((feedback) => notifyRunNow(feedback, { openTask: inspectJob }))
          .finally(() => setRunningNowJobId(null));
        return;
      }
      if (id === "redrive") {
        if (job.state !== "failed" || redrivingJobId !== null) return;
        setConfirmingRedrive(job);
        return;
      }
      if (id === "filter-type") return updateLocation({ jobType: job.type });
      if (id === "filter-queue") return updateLocation({ queue: job.queue });
      if (id === "filter-worker") {
        const worker = job.workerId ?? job.lastWorkerId;
        if (worker !== null) updateLocation({ worker });
        return;
      }
      const copying = id === "copy-id" ? "Task ID" : "Input";
      void copyToClipboard(id === "copy-id" ? job.id : formatJson(job.payload)).then((failure) =>
        notifyDashboard({
          // One id for both clipboard actions: copying twice is one running answer, not a stack.
          id: "workhorse-task-clipboard",
          title: failure ? `${copying} not copied` : `${copying} copied`,
          message: failure ?? `${copying} copied to the clipboard.`,
          tone: failure ? "failure" : "neutral",
        }),
      );
    },
    [
      completingHumanWaitJobId,
      data.canCompleteHumanWait,
      inspectJob,
      redrivingJobId,
      runTaskNow,
      runningNowJobId,
      updateLocation,
    ],
  );
  const completeHumanWait = async () => {
    if (!confirmingHumanWait || !data.canCompleteHumanWait) return;
    const { jobId, waitName, quickAction } = confirmingHumanWait;
    setCompletingHumanWaitJobId(jobId);
    try {
      const completion = await client.completeHumanWait({
        id: jobId,
        name: waitName,
        result: quickAction.result,
        idempotencyKey: crypto.randomUUID(),
        audit: {
          actor: auditActor,
          reason: `${quickAction.label} human wait ${waitName} from the task list`,
          requestId: crypto.randomUUID(),
        },
      });
      notifyDashboard({
        title: completion.status === "completed" ? "Decision completed" : "Decision unchanged",
        message: `${waitName}: ${completion.status}`,
        tone: completion.status === "completed" ? "success" : "neutral",
      });
      setConfirmingHumanWait(null);
      await reload();
    } catch (cause) {
      notifyFailure("Decision not completed", cause, "Workhorse rejected the human decision");
    } finally {
      setCompletingHumanWaitJobId(null);
    }
  };
  const redriveSelection = describeRedriveSelection(data);
  /**
   * Redrive one dead letter, then refresh the listing.
   *
   * The result is reported from what the server said rather than guessed, because whether a failure
   * produced a fresh copy or replayed one it had already produced is a durable fact this dashboard
   * does not get to decide.
   */
  const redriveTask = async (job: DashboardJobRow) => {
    if (!client.redriveTask) return;
    setRedrivingJobId(job.id);
    try {
      const result = await client.redriveTask({
        id: job.id,
        audit: {
          actor: auditActor,
          reason: `Redrive dead letter ${job.id} from the task list`,
          requestId: crypto.randomUUID(),
        },
      });
      notifyRedrive(result, { openTask: inspectJob });
      setConfirmingRedrive(null);
      await reload();
    } catch (cause) {
      notifyFailure("Task not redriven", cause, "Workhorse could not redrive the task");
    } finally {
      setRedrivingJobId(null);
    }
  };
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
        jobType: redriveSelection.jobType,
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
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pagination = (
    <Pagination
      value={Math.min(data.page, totalPages)}
      onChange={(page) => navigate(taskHref({ ...locationState, page }))}
      total={totalPages}
      size="xs"
      aria-label="Tasks pagination"
    />
  );
  const enqueueTestTask = (kind: DemoJobKind, options?: DemoJobOptions) =>
    runDemoJob?.(kind, options);

  return (
    <Stack gap="xl">
      <Modal
        opened={confirmingHumanWait !== null}
        onClose={() => setConfirmingHumanWait(null)}
        title={
          confirmingHumanWait
            ? `Confirm ${confirmingHumanWait.quickAction.label}`
            : "Confirm decision"
        }
        centered
      >
        <Text size="sm" mb="sm">
          The first accepted result resumes the handler and cannot be replaced. Confirm the result
          before completing this decision.
        </Text>
        {confirmingHumanWait ? (
          <Code block>{confirmingHumanWait.quickAction.formatted}</Code>
        ) : null}
        <Group justify="flex-end" mt="lg">
          <Button
            variant="default"
            disabled={completingHumanWaitJobId !== null}
            onClick={() => setConfirmingHumanWait(null)}
          >
            Cancel
          </Button>
          <Button
            loading={completingHumanWaitJobId !== null}
            onClick={() => void completeHumanWait()}
          >
            Confirm decision
          </Button>
        </Group>
      </Modal>
      <Modal
        opened={confirmingRedrive !== null}
        onClose={() => setConfirmingRedrive(null)}
        title="Redrive this dead letter"
        centered
      >
        <Text size="sm" mb="sm">
          {redriveAtLeastOnceWarning}
        </Text>
        {confirmingRedrive ? (
          <Code
            block
          >{`${confirmingRedrive.type} in ${confirmingRedrive.queue}\n${confirmingRedrive.id}`}</Code>
        ) : null}
        <Group justify="flex-end" mt="lg">
          <Button
            variant="default"
            disabled={redrivingJobId !== null}
            onClick={() => setConfirmingRedrive(null)}
          >
            Cancel
          </Button>
          <Button
            loading={redrivingJobId !== null}
            onClick={() => void (confirmingRedrive && redriveTask(confirmingRedrive))}
          >
            Redrive as a new task
          </Button>
        </Group>
      </Modal>
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
            <Group gap="xs" wrap="wrap">
              {data.filter === "discarded" ? (
                <Button
                  variant="default"
                  size="xs"
                  radius="xl"
                  leftSection={<ArrowCounterClockwise size={16} />}
                  disabled={redriveSelection.unavailable !== null || data.jobs.length === 0}
                  title={
                    redriveSelection.unavailable ??
                    (data.jobs.length === 0
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
              {runDemoJob ? (
                <Menu position="bottom-start" withinPortal>
                  <Menu.Target>
                    <Button
                      variant="default"
                      size="xs"
                      radius="xl"
                      leftSection={<PlayCircle size={16} />}
                      loading={runningDemoJob !== null}
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
                      leftSection={<CheckCircle size={16} />}
                      onClick={() => void enqueueTestTask("idempotent")}
                    >
                      Reuse one task for repeat requests
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
                    <Menu.Label>Feature examples</Menu.Label>
                    {dashboardDemoFeatureExamples.map(({ feature, label }) => (
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
        <ScrollArea type="auto">
          <Table
            striped
            highlightOnHover
            verticalSpacing={6}
            horizontalSpacing="sm"
            aria-label="Tasks matching the current filters"
            className="task-table"
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th className="task-table__col--id">ID</Table.Th>
                <Table.Th className="task-table__col--queue">Queue</Table.Th>
                <Table.Th className="task-table__col--task" w={260}>
                  Task
                </Table.Th>
                <Table.Th className="task-table__col--tags" miw={180}>
                  Tags
                </Table.Th>
                <Table.Th className="task-table__col--status" miw={280}>
                  Status
                </Table.Th>
                <Table.Th className="task-table__col--blocked" miw={180}>
                  Blocked by
                </Table.Th>
                <Table.Th className="task-table__col--steps" ta="right">
                  Steps
                </Table.Th>
                <Table.Th className="task-table__col--attempt" ta="right">
                  Attempt
                </Table.Th>
                <Table.Th className="task-table__col--duration" ta="right">
                  Duration
                </Table.Th>
                <Table.Th className="task-table__col--updated" ta="right">
                  Updated
                </Table.Th>
                <Table.Th className="task-table__col--actions" w={44}>
                  <VisuallyHidden>Actions</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.jobs.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={11}>
                    <Center mih={120}>
                      <Text c="dimmed" size="sm">
                        No tasks match this filter.
                      </Text>
                    </Center>
                  </Table.Td>
                </Table.Tr>
              ) : (
                data.jobs.map((job) => (
                  <Table.Tr
                    key={job.id}
                    onClick={() => inspectJob(job.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <Table.Td className="task-table__col--id">
                      <Code
                        fz="xs"
                        title={job.id}
                        style={{
                          background: "transparent",
                          paddingBlock: 0,
                          paddingInline: 0,
                        }}
                      >
                        {job.id.slice(0, 8)}
                      </Code>
                    </Table.Td>
                    <Table.Td className="task-table__col--queue">
                      <Text size="sm" c="dimmed">
                        {job.queue}
                      </Text>
                    </Table.Td>
                    <Table.Td className="task-table__col--task" w={260}>
                      <TaskOpenButton
                        jobId={job.id}
                        taskType={job.type}
                        onOpen={() => inspectJob(job.id)}
                      >
                        <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                          <TaskName type={job.type} queue={job.queue} />
                          {job.keyed ? (
                            <Badge
                              size="xs"
                              variant="light"
                              color="violet"
                              tt="none"
                              title="Workhorse accepted this task with an idempotency key. If the same request repeats during retention, Workhorse returns this task again."
                            >
                              Keyed
                            </Badge>
                          ) : null}
                          {job.priority > 0 ? (
                            <Badge
                              size="xs"
                              variant="light"
                              color="orange"
                              tt="none"
                              title={`Priority ${job.priority}; higher-priority ready tasks are claimed first.`}
                            >
                              P{job.priority}
                            </Badge>
                          ) : null}
                        </Group>
                      </TaskOpenButton>
                    </Table.Td>
                    <Table.Td className="task-table__col--tags">
                      <TaskTags tags={job.tags} />
                    </Table.Td>
                    <Table.Td className="task-table__col--status">
                      <Group className="task-table__status" gap="xs" wrap="nowrap">
                        <StatusBadge state={job.state} />
                        <CancelRequestedBadge cancellation={job.cancellation} />
                        <TaskWaitBadge job={job} />
                        <TaskStatusDetail job={job} />
                      </Group>
                    </Table.Td>
                    <Table.Td className="task-table__col--blocked">
                      <TaskBlockedBy job={job} />
                    </Table.Td>
                    <Table.Td className="task-table__col--steps" ta="right">
                      <DurableProgressBadge job={job} />
                    </Table.Td>
                    <Table.Td className="task-table__col--attempt" ta="right">
                      <Text
                        size="sm"
                        c={job.attempt > 1 ? "yellow.8" : undefined}
                        fw={job.attempt > 1 ? 600 : undefined}
                      >
                        {job.attempt}/{job.maxAttempts}
                      </Text>
                    </Table.Td>
                    <Table.Td className="task-table__col--duration" ta="right">
                      <Text size="sm" c="dimmed">
                        {taskDuration(job) ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td className="task-table__col--updated" ta="right">
                      <Text size="sm" title={formatExact(job.updatedAt)} c="dimmed">
                        {formatRelative(job.updatedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td className="task-table__col--actions">
                      <TaskRowActions
                        job={job}
                        onAction={runRowAction}
                        capabilities={{
                          runNow: runTaskNow !== null,
                          completeHumanWait: data.canCompleteHumanWait,
                        }}
                        pendingAction={
                          completingHumanWaitJobId === job.id
                            ? "complete-human-wait"
                            : redrivingJobId === job.id
                              ? "redrive"
                              : runningNowJobId === job.id
                                ? "run-now"
                                : null
                        }
                      />
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
}
