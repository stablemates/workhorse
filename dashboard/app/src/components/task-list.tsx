import { taskStatusColors } from "../status-colors.js";
import { StatusLabel } from "../status-badge.js";
import type {
  DashboardCancellationRequest,
  DashboardTaskRow,
  DashboardTaskFacets,
  DashboardTasksPage,
  DashboardTasksCursorPage,
} from "@stablemates/workhorse-dashboard-server/wire";
import {
  ActionIcon,
  Badge,
  Box,
  Center,
  Code,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  describeCancellationRequest,
  describeRetryPolicy,
  taskRowActionGroups,
} from "../presentation.js";
import {
  ArrowCounterClockwise,
  CheckCircle,
  Clock,
  Copy,
  DotsThreeVertical,
  FunnelSimple,
  Info,
  Lightning,
  MagnifyingGlass,
  PlayCircle,
  Prohibit,
  UserFocus,
} from "@phosphor-icons/react";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { type TaskLocationState } from "../task-location.js";
import { Menu, MultiSelect, Select } from "../dropdown-activity.js";
import type {
  TaskActionTarget,
  TaskRowActionCapabilities,
  TaskRowActionId,
} from "../presentation.js";
import {
  formatClock,
  formatDuration,
  formatExact,
  formatRelative,
  useElapsed,
} from "../preferences.js";
import { useDashboardClient } from "../core.js";

export function DurableProgressBadge({ task }: { task: DashboardTaskRow }) {
  if (!task.durability) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Badge
      size="xs"
      variant="light"
      color="violet"
      tt="none"
      title={`${task.durability.completedSteps} of ${task.durability.totalSteps} durable steps completed`}
      role="progressbar"
      aria-label="Durable steps completed"
      aria-valuemin={0}
      aria-valuemax={task.durability.totalSteps}
      aria-valuenow={task.durability.completedSteps}
    >
      {task.durability.completedSteps}/{task.durability.totalSteps}
    </Badge>
  );
}
/** Trim a `queue.` prefix from a task type since the queue has its own column. */
export function taskDisplayName(type: string, queue: string): string {
  return type.startsWith(`${queue}.`) ? type.slice(queue.length + 1) : type;
}
/**
 * Pending cooperative cancellation on a live task.
 *
 * The wording never promises the handler stopped: it says the request was made and that the task
 * is still running until the handler observes the signal. The badge text carries that meaning on
 * its own, so the neutral colour is decoration.
 */
export function CancelRequestedBadge({
  cancellation,
}: {
  cancellation: DashboardCancellationRequest | null;
}) {
  const described = describeCancellationRequest(cancellation);
  if (described === null || cancellation === null) return null;
  return (
    <Badge
      size="sm"
      variant="light"
      color="gray"
      leftSection={<Prohibit size={11} weight="bold" />}
      tt="none"
      title={`${described.exact} Requested ${formatExact(cancellation.requestedAt)}.`}
      role="status"
      aria-label={`Cancellation requested. ${described.exact}`}
      style={{ flexShrink: 0 }}
    >
      Cancellation requested
    </Badge>
  );
}
/** One-line, state-specific context so a row explains itself without opening the drawer. */
export function TaskStatusDetail({ task }: { task: DashboardTaskRow }) {
  let detail: string | null = null;
  let exactTime: string | null = null;
  if (task.blockedReason === "prerequisite_pending") {
    detail = `${task.prerequisiteTaskIds.length} unresolved ${task.prerequisiteTaskIds.length === 1 ? "prerequisite" : "prerequisites"}`;
  } else if (task.state === "scheduled" && task.wait) {
    // A durable wait is a scheduled restart boundary, not an owned execution.
    detail = `sleeping until ${formatClock(task.wait.wakeAt)} · ${task.wait.name}`;
    exactTime = formatExact(task.wait.wakeAt);
  } else if (task.state === "scheduled" && task.runAt) {
    detail = `runs ${formatRelative(task.runAt)}`;
    exactTime = formatExact(task.runAt);
    if (task.attempt > 1) detail += ` · ${describeRetryPolicy(task.retryPolicy).label}`;
  } else if (task.state === "active" && task.workerId) detail = `on ${task.workerId}`;
  else if (task.state === "failed" && task.errorMessage) detail = task.errorMessage;
  else if (task.state === "canceled" && task.finishedAt) {
    // Canceled work reads as a deliberate stop, never as an error, even though the stored
    // cancellation envelope lives in the same column a failure would use.
    detail = `canceled ${formatRelative(task.finishedAt)}`;
    exactTime = formatExact(task.finishedAt);
  }
  if (!detail) return null;
  return (
    <Text
      c={task.state === "failed" ? "red.7" : "dimmed"}
      size="xs"
      style={{ overflowWrap: "anywhere" }}
      title={[detail, exactTime].filter(Boolean).join(" · ")}
    >
      {detail}
    </Text>
  );
}
/** The unresolved dependency which keeps a list row outside dispatch. */
export function TaskBlockedBy({ task }: { task: DashboardTaskRow }) {
  if (task.blockedReason !== "prerequisite_pending") {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      <Badge
        size="xs"
        variant="light"
        color="yellow"
        tt="none"
        role="status"
        aria-label="Task blocked: prerequisite pending"
      >
        Prerequisite pending
      </Badge>
      <Text size="xs" c="dimmed" lineClamp={1}>
        <Code fz="xs">{task.prerequisiteTaskIds.join(", ")}</Code>
      </Text>
    </Stack>
  );
}
/** The stable task label, constrained so long types do not widen the listing table. */
export function TaskName({ type, queue }: { type: string; queue: string }) {
  const displayName = taskDisplayName(type, queue);
  return (
    <Text
      fw={600}
      size="sm"
      lh={1.3}
      title={displayName}
      className="task-table__task-name"
      style={{
        flex: 1,
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {displayName}
    </Text>
  );
}
/** Visible task tags, constrained to one discoverable line so they cannot widen a task row. */
export function TaskTagsTooltipContent({ tags }: { tags: readonly string[] }) {
  return (
    <Box component="ul" m={0} pl="md">
      {tags.map((tag, index) => (
        <li key={`${tag}-${index}`}>{tag}</li>
      ))}
    </Box>
  );
}
export function TaskTags({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return <Text c="dimmed">—</Text>;
  return (
    <Tooltip
      label={<TaskTagsTooltipContent tags={tags} />}
      multiline
      withArrow
      events={{ hover: true, focus: true, touch: false }}
    >
      <Group
        gap={4}
        wrap="nowrap"
        tabIndex={0}
        aria-label={`Tags: ${tags.join(", ")}`}
        style={{ overflow: "hidden", whiteSpace: "nowrap" }}
      >
        {tags.map((tag, index) => (
          <Badge
            key={`${tag}-${index}`}
            size="xs"
            variant="light"
            color="gray"
            tt="none"
            style={{ flexShrink: 0 }}
          >
            {tag}
          </Badge>
        ))}
      </Group>
    </Tooltip>
  );
}
/**
 * Badge for a scheduled durable wait. "Waking" means the stored target has passed
 * and the task is eligible for promotion and a fresh claim, not that a worker holds it.
 */
export function TaskWaitBadge({ task }: { task: DashboardTaskRow }) {
  const scheduledWait = task.state === "scheduled" ? task.wait : null;
  const due = useElapsed(scheduledWait?.wakeAt ?? null);
  if (task.signalWait) {
    return (
      <Badge
        size="sm"
        variant="light"
        color="violet"
        leftSection={<Lightning size={11} weight="bold" />}
        tt="none"
        title={`Waiting for signal ${task.signalWait.name} · deadline ${formatExact(task.signalWait.deadlineAt)}`}
        role="status"
        aria-label={`Waiting for signal ${task.signalWait.name}`}
        style={{ flexShrink: 0 }}
      >
        Waiting for signal: {task.signalWait.name}
      </Badge>
    );
  }
  if (task.humanWait) {
    return (
      <Badge
        size="sm"
        variant="light"
        color="violet"
        leftSection={<UserFocus size={11} weight="bold" />}
        tt="none"
        title={`Waiting for decision ${task.humanWait.name} · deadline ${formatExact(task.humanWait.deadlineAt)}`}
        role="status"
        aria-label={`Waiting for decision ${task.humanWait.name}`}
        style={{ flexShrink: 0 }}
      >
        Waiting for decision: {task.humanWait.name}
      </Badge>
    );
  }
  if (!scheduledWait) return null;
  return (
    <Badge
      size="sm"
      variant="light"
      color={due ? "cyan" : "indigo"}
      leftSection={<Clock size={11} weight="bold" />}
      tt="none"
      title={`Durable wait ${scheduledWait.name} · not before ${formatExact(scheduledWait.wakeAt)}`}
      role="status"
      aria-label={`${due ? "Waking" : "Sleeping"} at durable wait ${scheduledWait.name}`}
      style={{ flexShrink: 0 }}
    >
      {due ? "Waking" : "Sleeping"}
    </Badge>
  );
}
/** Wall-clock time from enqueue to terminal outcome, only shown once the task finished. */
export function taskDuration(task: DashboardTaskRow): string | null {
  if (!task.finishedAt) return null;
  const elapsed = new Date(task.finishedAt).getTime() - new Date(task.createdAt).getTime();
  return elapsed >= 0 ? formatDuration(elapsed) : null;
}
export function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <Box>
      <Title order={1}>{title}</Title>
      <Text c="dimmed" mt={4}>
        {description}
      </Text>
    </Box>
  );
}
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Paper withBorder p="xl">
      <Center mih={180}>
        <Stack align="center" gap="xs">
          <ThemeIcon variant="light" color="gray" size="xl" radius="xl">
            <CheckCircle size={22} />
          </ThemeIcon>
          <Text fw={600}>No results</Text>
          <Text c="dimmed" size="sm">
            {children}
          </Text>
        </Stack>
      </Center>
    </Paper>
  );
}
export function includeSelectedOption(values: string[], selected: string | null): string[] {
  return selected && !values.includes(selected) ? [selected, ...values] : values;
}
export function includeSelectedOptions(values: string[], selected: readonly string[]): string[] {
  const available = new Set(values);
  const missing = selected.filter((value) => !available.has(value));
  return missing.length > 0 ? [...missing, ...values] : values;
}
export function useTaskFacets({
  queue,
  worker,
  taskType,
  tags,
}: Pick<DashboardTasksPage, "queue" | "worker" | "taskType" | "tags">) {
  const client = useDashboardClient();
  const [facets, setFacets] = useState<DashboardTaskFacets | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<Promise<void> | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const load = useCallback(() => {
    if (facets || request.current) return;
    const activeGeneration = generation.current;
    setLoading(true);
    setError(null);
    request.current = client
      .taskFacets()
      .then((nextFacets) => {
        if (generation.current === activeGeneration) setFacets(nextFacets);
      })
      .catch(() => {
        if (generation.current === activeGeneration) {
          setError("Workhorse could not load the filters. Reopen this menu to try again.");
        }
      })
      .finally(() => {
        if (generation.current === activeGeneration) {
          request.current = null;
          setLoading(false);
        }
      });
  }, [client, facets]);
  const values = facets ?? { queues: [], workers: [], taskTypes: [], tags: [] };
  return {
    facets: {
      queues: includeSelectedOption(values.queues, queue),
      workers: includeSelectedOption(values.workers, worker),
      taskTypes: includeSelectedOption(values.taskTypes, taskType),
      tags: includeSelectedOptions(values.tags, tags),
    },
    loading,
    error,
    load,
  };
}
export function TaskListingFilters({
  data,
  searchInput,
  setSearchInput,
  taskFacets,
  updateLocation,
}: {
  data: DashboardTasksPage | DashboardTasksCursorPage;
  searchInput: string;
  setSearchInput: (value: string) => void;
  taskFacets: ReturnType<typeof useTaskFacets>;
  updateLocation: (updates: Partial<TaskLocationState>) => void;
}) {
  const nothingFoundMessage = taskFacets.loading ? "Loading filters…" : taskFacets.error;
  return (
    <Group gap="xs" wrap="wrap">
      <TextInput
        size="xs"
        value={searchInput}
        onChange={(event) => setSearchInput(event.currentTarget.value)}
        leftSection={<MagnifyingGlass size={14} />}
        placeholder="Search tasks. Use * as a wildcard."
        aria-label="Search tasks"
        style={{ flex: "1 1 220px" }}
      />
      <MultiSelect
        size="xs"
        data={taskFacets.facets.tags}
        value={data.tags}
        onChange={(tags) => updateLocation({ tags })}
        onDropdownOpen={taskFacets.load}
        placeholder="Any tag"
        aria-label="Filter tasks by tags"
        searchable
        clearable
        rightSection={taskFacets.loading ? <Loader size={14} /> : undefined}
        nothingFoundMessage={nothingFoundMessage ?? "No tags found"}
        maxDropdownHeight={240}
        style={{ flex: "1 1 220px" }}
      />
      {(
        [
          ["Queue", data.queue, taskFacets.facets.queues, "queue"],
          ["Worker", data.worker, taskFacets.facets.workers, "worker"],
          ["Task type", data.taskType, taskFacets.facets.taskTypes, "taskType"],
        ] as const
      ).map(([placeholder, value, values, key]) => (
        <Select
          key={key}
          size="xs"
          data={values}
          value={value}
          onChange={(next) => updateLocation({ [key]: next })}
          onDropdownOpen={taskFacets.load}
          placeholder={placeholder}
          aria-label={`Filter tasks by ${placeholder.toLowerCase()}`}
          searchable
          clearable
          rightSection={taskFacets.loading ? <Loader size={14} /> : undefined}
          nothingFoundMessage={nothingFoundMessage ?? `No ${placeholder.toLowerCase()} found`}
          style={{ flex: "1 1 150px" }}
        />
      ))}
      <Select
        size="xs"
        value={data.sort}
        onChange={(sort) => updateLocation({ sort: sort === "priority" ? "priority" : "updated" })}
        data={[
          { value: "updated", label: "Recently updated" },
          { value: "priority", label: "Highest priority" },
        ]}
        allowDeselect={false}
        aria-label="Sort tasks"
        style={{ flex: "1 1 150px" }}
      />
    </Group>
  );
}
export function taskRowActionIcon(id: TaskRowActionId): ReactNode {
  if (id === "inspect") return <Info size={16} />;
  if (id === "copy-id" || id === "copy-args") return <Copy size={16} />;
  if (id === "cancel") return <Prohibit size={16} />;
  if (id === "run-now") return <PlayCircle size={16} />;
  if (id === "redrive") return <ArrowCounterClockwise size={16} />;
  if (id === "complete-human-wait") return <CheckCircle size={16} />;
  return <FunnelSimple size={16} />;
}
/**
 * The per-row action menu for one task.
 *
 * Which actions apply is decided by `taskRowActionGroups` from the row's own state, so the list and
 * the drawer can never disagree about whether a task is cancelable. An action that does not apply
 * stays in the menu, disabled, with the reason written underneath it: an operator finds out why a
 * finished task cannot be canceled in the place they went to cancel it, rather than from a menu
 * that quietly changes shape from row to row.
 *
 * Cancellation is never applied from here. It opens a confirmation dialog,
 * because cancellation is irreversible and its reason belongs in the audit trail. Running a
 * scheduled task now is applied in place instead: it deliberately releases the task early, shows
 * the mutation in flight, and reports the durable result without claiming the handler ran inline.
 */
export function TaskRowActions({
  task,
  onAction,
  capabilities,
  pendingAction,
  showOpenDetails = true,
}: {
  task: TaskActionTarget;
  onAction: (id: TaskRowActionId, task: TaskActionTarget) => void;
  capabilities: TaskRowActionCapabilities;
  /** The action currently in flight for this row, so its item can show it rather than look idle. */
  pendingAction: TaskRowActionId | null;
  showOpenDetails?: boolean;
}) {
  const groups = taskRowActionGroups(task, capabilities);
  return (
    <Menu
      blocksRefresh
      position="bottom-start"
      withinPortal
      shadow="md"
      width={280}
      transitionProps={{ duration: 0 }}
    >
      <Menu.Target>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label={`Actions for task ${task.id}`}
          className="task-table__action-trigger"
          loading={pendingAction !== null}
          // The row itself opens the drawer on click, which is not what opening this menu means.
          onClick={(event) => event.stopPropagation()}
        >
          <DotsThreeVertical size={16} weight="bold" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
        {groups.map((group, index) => (
          <Fragment key={group.label}>
            {index > 0 ? <Menu.Divider /> : null}
            <Menu.Label>{group.label}</Menu.Label>
            {group.actions.map((action) => {
              if (action.id === "inspect" && !showOpenDetails) return null;
              const pending = pendingAction === action.id;
              return (
                <Menu.Item
                  key={action.id}
                  leftSection={pending ? <Loader size={14} /> : taskRowActionIcon(action.id)}
                  color={action.destructive && action.unavailable === null ? "red" : undefined}
                  disabled={action.unavailable !== null || pendingAction !== null}
                  onClick={() => onAction(action.id, task)}
                >
                  <Text size="sm" lh={1.3}>
                    {action.label}
                  </Text>
                  {action.unavailable === null ? null : (
                    <Text size="xs" c="dimmed" lh={1.3} mt={2} style={{ whiteSpace: "normal" }}>
                      {action.unavailable}
                    </Text>
                  )}
                </Menu.Item>
              );
            })}
          </Fragment>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

export function TaskStatusIndicators({ task }: { task: DashboardTaskRow }) {
  const waiting = task.signalWait
    ? {
        text: "Waiting for signal",
        label: `Waiting for signal: ${task.signalWait.name}`,
        color: taskStatusColors.signalWait,
        timing: `Deadline ${formatExact(task.signalWait.deadlineAt)}`,
      }
    : task.humanWait
      ? {
          text: "Waiting for decision",
          label: `Waiting for decision: ${task.humanWait.name}`,
          color: taskStatusColors.humanWait,
          timing: `Deadline ${formatExact(task.humanWait.deadlineAt)}`,
        }
      : task.state === "scheduled" && task.wait
        ? {
            text: "Durable wait",
            label: `Durable wait: ${task.wait.name}`,
            color: taskStatusColors.durableWait,
            timing: `Wake at ${formatExact(task.wait.wakeAt)}`,
          }
        : null;
  return (
    <Group gap={4} wrap="nowrap">
      <StatusLabel
        state={waiting ? "waiting" : task.state}
        text={waiting?.text}
        color={waiting?.color}
        label={
          waiting?.label ??
          `Status: ${task.state}${task.errorMessage ? `. ${task.errorMessage}` : ""}`
        }
      >
        <Stack gap={4}>
          <Text
            size="sm"
            tt={waiting ? undefined : "capitalize"}
            style={{ overflowWrap: "anywhere" }}
          >
            {waiting?.label ?? task.state}
          </Text>
          {waiting ? (
            <>
              <Text size="xs">{waiting.timing}</Text>
              <Text size="xs">Status: {task.state}</Text>
            </>
          ) : (
            <TaskStatusDetail task={task} />
          )}
          {task.blockedReason ? (
            <Text size="xs">Blocked by: {task.prerequisiteTaskIds.join(", ")}</Text>
          ) : null}
          {task.finishedAt ? (
            <Text size="xs">
              Finished {formatRelative(task.finishedAt)} · {formatExact(task.finishedAt)}
            </Text>
          ) : null}
        </Stack>
      </StatusLabel>
      {task.cancellation ? (
        <StatusLabel
          state="cancel_requested"
          label={`Cancellation requested: ${task.cancellation.reason}`}
        >
          <CancelRequestedBadge cancellation={task.cancellation} />
        </StatusLabel>
      ) : null}
    </Group>
  );
}

/** Keep older hosts readable while newer listings identify the accepted keyed mode. */
export function TaskEnqueueBadge({
  task,
}: {
  task: Pick<DashboardTaskRow, "keyed" | "enqueueMode">;
}) {
  const modes = {
    idempotency: {
      label: "Idempotency",
      color: "violet",
      description:
        "Matching requests reuse this task while the key is retained. Different requests with the same key are rejected.",
    },
    debounce: {
      label: "Debounce",
      color: "grape",
      description:
        "Repeated requests replace this task while it is pending within the debounce window.",
    },
    throttle: {
      label: "Throttle",
      color: "cyan",
      description:
        "Matching requests reuse the first task within the throttle window. Different requests with the same key are rejected.",
    },
  };
  const mode = task.enqueueMode ? modes[task.enqueueMode] : undefined;
  if (!mode && !task.keyed) return null;
  return (
    <Badge
      size="xs"
      variant="light"
      color={mode?.color ?? "violet"}
      tt="none"
      title={
        mode?.description ??
        "This task uses a scoped key. Open task details to see its enqueue mode."
      }
    >
      {mode?.label ?? "Keyed"}
    </Badge>
  );
}
