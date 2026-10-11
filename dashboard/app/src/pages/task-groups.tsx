import type {
  DashboardTaskGroup,
  DashboardTaskGroupCounts,
  DashboardTaskGroupDetail,
  DashboardTaskGroupsPage,
  DashboardTaskGroupStateFilter,
} from "@stablemates/workhorse-dashboard-server/wire";
import {
  dashboardPageMax,
  dashboardTaskGroupEventLimit,
  dashboardTaskGroupStateFilters,
} from "@stablemates/workhorse-dashboard-server/wire";
import {
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useRef, useState, type MouseEvent } from "react";
import { useDashboardClient, type TaskGroupsPageData } from "../core.js";
import { useConfirmationActivity } from "../dropdown-activity.js";
import { EmptyState, PageHeader } from "../components/task-list.js";
import { notifyDashboard, notifyFailure } from "../notifications.js";
import { formatExact, formatJson, formatRelative } from "../preferences.js";
import { statusColor } from "../status-colors.js";
import { formatCount } from "../count-format.js";
import { taskGroupsLocationHref, type TaskGroupsLocationState } from "../task-groups-location.js";

/** The navigation a task groups view needs from the shell. */
export interface TaskGroupsNavigation {
  /** The mounted href of a route, for the `href` of a link. */
  href: (path: string) => string;
  /** Follow a link inside the dashboard without a full page load. */
  followLink: (event: MouseEvent<HTMLElement>, path: string) => void;
  /** The route that opens one task in the task drawer. */
  taskPath: (taskId: string) => string;
}

const stateFilterLabels: Record<DashboardTaskGroupStateFilter, string> = {
  all: "All",
  open: "Open",
  sealed: "Sealed",
  finished: "Finished",
};

const callbackLabels: Record<DashboardTaskGroup["callbacks"][number]["kind"], string> = {
  onFinish: "onFinish",
  onSuccess: "onSuccess",
  onFailure: "onFailure",
};

/** One section of the progress bar, in the order the bar draws them. */
export interface TaskGroupProgressSection {
  outcome: "succeeded" | "failed" | "canceled";
  count: number;
  /** The share of all member tasks, from 0 to 100. */
  percent: number;
  color: string;
}

/**
 * The progress bar sections of one group: succeeded, failed, and canceled member tasks.
 *
 * The unfilled part of the bar is the pending member tasks. A group with no member tasks has no
 * sections.
 */
export function taskGroupProgressSections(
  counts: DashboardTaskGroupCounts,
): TaskGroupProgressSection[] {
  if (counts.total === 0) return [];
  return (["succeeded", "failed", "canceled"] as const)
    .map((outcome) => ({
      outcome,
      count: counts[outcome],
      percent: (counts[outcome] / counts.total) * 100,
      color: statusColor(outcome),
    }))
    .filter((section) => section.count > 0);
}

/** A short statement of the progress, such as "2 of 4 finished". */
export function taskGroupProgressLabel(counts: DashboardTaskGroupCounts): string {
  if (counts.total === 0) return "No member tasks";
  const finished = counts.total - counts.pending;
  return `${formatCount(finished)} of ${formatCount(counts.total)} finished`;
}

export function TaskGroupProgress({
  counts,
  size = "md",
}: {
  counts: DashboardTaskGroupCounts;
  size?: "sm" | "md" | "lg";
}) {
  const sections = taskGroupProgressSections(counts);
  return (
    <Stack gap={4} miw={160}>
      <Progress.Root size={size} aria-label={taskGroupProgressLabel(counts)}>
        {sections.map((section) => (
          <Tooltip
            key={section.outcome}
            label={`${formatCount(section.count)} ${section.outcome}`}
            withArrow
          >
            <Progress.Section value={section.percent} color={section.color} />
          </Tooltip>
        ))}
      </Progress.Root>
      <Text size="xs" c="dimmed">
        {taskGroupProgressLabel(counts)}
        {counts.pending > 0 ? ` · ${formatCount(counts.pending)} pending` : ""}
      </Text>
    </Stack>
  );
}

function TaskGroupStateBadges({ group }: { group: DashboardTaskGroup }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Badge variant="light" color={group.state === "finished" ? "gray" : "blue"}>
        {group.state}
      </Badge>
      {group.result ? (
        <Badge variant="light" color={statusColor(group.result)}>
          {group.result}
        </Badge>
      ) : null}
      {group.canceledAt ? (
        <Badge variant="outline" color="gray">
          canceled
        </Badge>
      ) : null}
    </Group>
  );
}

function Timestamp({ value }: { value: string | null }) {
  if (value === null) return <Text c="dimmed">—</Text>;
  return (
    <Text size="sm" title={formatExact(value)}>
      {formatRelative(value)}
    </Text>
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function TaskGroupsList({
  data,
  location,
  navigation,
  navigate,
}: {
  data: DashboardTaskGroupsPage;
  location: TaskGroupsLocationState;
  navigation: TaskGroupsNavigation;
  navigate: (href: string) => void;
}) {
  const groupPath = (groupId: string) =>
    taskGroupsLocationHref({ ...location, groupId, after: null });
  return (
    <Stack gap="lg">
      <PageHeader
        title="Task groups"
        description="A task group tracks a set of tasks as one unit. When every member task is finished, Workhorse enqueues the callbacks of the group."
      />
      <Group justify="space-between">
        <SegmentedControl
          value={location.state}
          data={dashboardTaskGroupStateFilters.map((value) => ({
            value,
            label: stateFilterLabels[value],
          }))}
          onChange={(value) =>
            navigate(
              taskGroupsLocationHref({
                ...location,
                state: value as DashboardTaskGroupStateFilter,
                page: 1,
              }),
            )
          }
        />
      </Group>
      {data.groups.length === 0 ? (
        <EmptyState>
          {location.state === "all"
            ? "No task groups exist."
            : `No ${location.state} task groups exist.`}
        </EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Group</Table.Th>
                  <Table.Th>State</Table.Th>
                  <Table.Th>Progress</Table.Th>
                  <Table.Th>Failed</Table.Th>
                  <Table.Th>Canceled</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Finished</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.groups.map((group) => (
                  <Table.Tr key={group.id}>
                    <Table.Td>
                      <Anchor
                        href={navigation.href(groupPath(group.id))}
                        onClick={(event) => navigation.followLink(event, groupPath(group.id))}
                        ff="monospace"
                        size="sm"
                        title={group.id}
                      >
                        {shortId(group.id)}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      <TaskGroupStateBadges group={group} />
                    </Table.Td>
                    <Table.Td>
                      <TaskGroupProgress counts={group.counts} size="sm" />
                    </Table.Td>
                    <Table.Td>{formatCount(group.counts.failed)}</Table.Td>
                    <Table.Td>{formatCount(group.counts.canceled)}</Table.Td>
                    <Table.Td>
                      <Timestamp value={group.createdAt} />
                    </Table.Td>
                    <Table.Td>
                      <Timestamp value={group.finishedAt} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}
      <Group justify="flex-end" gap="xs">
        <Button
          variant="default"
          size="xs"
          disabled={data.page <= 1}
          onClick={() => navigate(taskGroupsLocationHref({ ...location, page: data.page - 1 }))}
        >
          Previous page
        </Button>
        <Text size="sm" c="dimmed">
          {data.hasMore && data.page >= dashboardPageMax
            ? `Page ${data.page}, the last page the list reads. Filter by state to see other groups.`
            : `Page ${data.page}`}
        </Text>
        <Button
          variant="default"
          size="xs"
          disabled={!data.hasMore || data.page >= dashboardPageMax}
          onClick={() => navigate(taskGroupsLocationHref({ ...location, page: data.page + 1 }))}
        >
          Next page
        </Button>
      </Group>
    </Stack>
  );
}

/** Why a callback has no task yet, from the state and the result of its group. */
export function callbackPendingReason(
  group: DashboardTaskGroup,
  kind: DashboardTaskGroup["callbacks"][number]["kind"],
): string {
  if (group.state !== "finished") return "Runs when every member task is finished";
  if (kind === "onSuccess" && group.result === "failed") {
    return "Not enqueued, because a member task did not succeed";
  }
  if (kind === "onFailure" && group.result === "succeeded") {
    return "Not enqueued, because every member task succeeded";
  }
  return "Not enqueued. The group events tell why.";
}

export function TaskGroupDetailView({
  data,
  location,
  navigation,
  navigate,
  auditActor,
  reload,
}: {
  data: DashboardTaskGroupDetail;
  location: TaskGroupsLocationState;
  navigation: TaskGroupsNavigation;
  navigate: (href: string) => void;
  auditActor: string;
  reload: () => Promise<void>;
}) {
  const client = useDashboardClient();
  const { group } = data;
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [canceling, setCanceling] = useState(false);
  const cancelInFlight = useRef(false);
  useConfirmationActivity(confirming);
  const listPath = taskGroupsLocationHref({ ...location, groupId: null, after: null });
  const memberPage = (after: number | null) =>
    navigate(taskGroupsLocationHref({ ...location, after }));
  const previousAfter =
    location.after === null ? null : Math.max(location.after - location.pageSize, 0) || null;

  const cancelGroup = async () => {
    if (cancelInFlight.current || reason.trim() === "") return;
    cancelInFlight.current = true;
    setCanceling(true);
    try {
      const canceled = await client.cancelTaskGroup({
        id: group.id,
        audit: { actor: auditActor, reason: reason.trim(), requestId: crypto.randomUUID() },
      });
      notifyDashboard({
        title: canceled.state === "finished" ? "Task group finished" : "Task group canceled",
        message:
          canceled.state === "finished"
            ? `Group ${shortId(group.id)} is finished with the result ${canceled.result ?? "unknown"}.`
            : `Workhorse canceled the member tasks of group ${shortId(group.id)}. Active member tasks stop when their handlers observe the cancellation.`,
        tone: "success",
      });
      setConfirming(false);
      setReason("");
    } catch (cause) {
      notifyFailure("Task group not canceled", cause, "Workhorse could not cancel the task group");
      return;
    } finally {
      cancelInFlight.current = false;
      setCanceling(false);
    }
    try {
      await reload();
    } catch (cause) {
      notifyFailure(
        "Task group refresh failed",
        cause,
        "The cancellation completed, but the dashboard could not refresh",
      );
    }
  };

  return (
    <Stack gap="lg">
      <Anchor
        href={navigation.href(listPath)}
        onClick={(event) => navigation.followLink(event, listPath)}
        size="sm"
      >
        ← All task groups
      </Anchor>
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={1}>Task group</Title>
          <Code>{group.id}</Code>
        </Stack>
        <Group gap="sm">
          <TaskGroupStateBadges group={group} />
          {group.state === "finished" ? null : !data.canCancel ? (
            <Text size="sm" c="dimmed">
              This dashboard cannot cancel task groups.
            </Text>
          ) : (
            <Button
              color="red"
              variant="light"
              onClick={() => {
                setReason("");
                setConfirming(true);
              }}
            >
              Cancel group
            </Button>
          )}
        </Group>
      </Group>
      <Paper withBorder p="md">
        <Stack gap="md">
          <TaskGroupProgress counts={group.counts} size="lg" />
          <SimpleGrid cols={{ base: 2, sm: 5 }}>
            {(["total", "succeeded", "failed", "canceled", "pending"] as const).map((name) => (
              <Stack key={name} gap={0}>
                <Text size="xs" c="dimmed" tt="capitalize">
                  {name}
                </Text>
                <Text fw={600}>{formatCount(group.counts[name])}</Text>
              </Stack>
            ))}
          </SimpleGrid>
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            {(
              [
                ["Created", group.createdAt],
                ["Sealed", group.sealedAt],
                ["Finished", group.finishedAt],
                ["Canceled", group.canceledAt],
              ] as const
            ).map(([label, value]) => (
              <Stack key={label} gap={0}>
                <Text size="xs" c="dimmed">
                  {label}
                </Text>
                <Timestamp value={value} />
              </Stack>
            ))}
          </SimpleGrid>
          {group.canceledAt ? (
            <Text size="sm">
              {group.canceledBy} canceled this group: {group.cancelReason}
            </Text>
          ) : null}
          {group.state === "open" ? (
            <Text size="sm" c="dimmed">
              This group is open. It cannot finish until the application seals it.
            </Text>
          ) : null}
        </Stack>
      </Paper>

      <Stack gap="xs">
        <Title order={3}>Callbacks</Title>
        {group.callbacks.length === 0 ? (
          <Text size="sm" c="dimmed">
            This group has no callbacks.
          </Text>
        ) : (
          <Paper withBorder>
            <Table verticalSpacing="xs">
              <Table.Tbody>
                {group.callbacks.map((callback) => (
                  <Table.Tr key={callback.kind}>
                    <Table.Td w={140}>
                      <Code>{callbackLabels[callback.kind]}</Code>
                    </Table.Td>
                    <Table.Td>
                      {callback.taskId ? (
                        <Anchor
                          href={navigation.href(navigation.taskPath(callback.taskId))}
                          onClick={(event) =>
                            navigation.followLink(event, navigation.taskPath(callback.taskId!))
                          }
                          ff="monospace"
                          size="sm"
                        >
                          {callback.taskId}
                        </Anchor>
                      ) : (
                        <Text size="sm" c="dimmed">
                          {callbackPendingReason(group, callback.kind)}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        )}
      </Stack>

      <Stack gap="xs">
        <Title order={3}>Member tasks</Title>
        {data.members.length === 0 ? (
          <Text size="sm" c="dimmed">
            {location.after === null
              ? "This group has no member tasks."
              : "No member tasks follow this position."}
          </Text>
        ) : (
          <Paper withBorder>
            <ScrollArea>
              <Table verticalSpacing="xs" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>#</Table.Th>
                    <Table.Th>Task</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th>Queue</Table.Th>
                    <Table.Th>State</Table.Th>
                    <Table.Th>Counted outcome</Table.Th>
                    <Table.Th>Added</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.members.map((member) => (
                    <Table.Tr key={member.taskId}>
                      <Table.Td>{member.position}</Table.Td>
                      <Table.Td>
                        <Anchor
                          href={navigation.href(navigation.taskPath(member.taskId))}
                          onClick={(event) =>
                            navigation.followLink(event, navigation.taskPath(member.taskId))
                          }
                          ff="monospace"
                          size="sm"
                          title={member.taskId}
                        >
                          {shortId(member.taskId)}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>{member.taskType ?? <Text c="dimmed">deleted</Text>}</Table.Td>
                      <Table.Td>{member.queue ?? <Text c="dimmed">—</Text>}</Table.Td>
                      <Table.Td>
                        {member.state ? (
                          <Badge variant="light" color={statusColor(member.state)}>
                            {member.state}
                          </Badge>
                        ) : (
                          <Text c="dimmed">—</Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {member.outcome ? (
                          <Badge variant="outline" color={statusColor(member.outcome)}>
                            {member.outcome}
                          </Badge>
                        ) : (
                          <Text size="sm" c="dimmed">
                            pending
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Timestamp value={member.addedAt} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          </Paper>
        )}
        <Group justify="flex-end" gap="xs">
          <Button
            variant="default"
            size="xs"
            disabled={location.after === null}
            onClick={() => memberPage(previousAfter)}
          >
            Previous page
          </Button>
          <Button
            variant="default"
            size="xs"
            disabled={data.nextAfter === null}
            onClick={() => memberPage(data.nextAfter)}
          >
            Next page
          </Button>
        </Group>
      </Stack>

      <Stack gap="xs">
        <Title order={3}>Events</Title>
        {data.eventsTruncated ? (
          <Text size="sm" c="dimmed">
            This list shows the newest {dashboardTaskGroupEventLimit} events of the group.
          </Text>
        ) : null}
        <Paper withBorder>
          <Table verticalSpacing="xs">
            <Table.Tbody>
              {data.events.map((event) => (
                <Table.Tr key={event.id}>
                  <Table.Td w={180}>
                    <Badge variant="light" color="gray">
                      {event.type}
                    </Badge>
                  </Table.Td>
                  <Table.Td w={140}>
                    <Timestamp value={event.occurredAt} />
                  </Table.Td>
                  <Table.Td>
                    <Code block>{formatJson(event.details)}</Code>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      </Stack>

      <Modal
        opened={confirming}
        onClose={() => {
          if (!cancelInFlight.current) setConfirming(false);
        }}
        title="Cancel this task group?"
        centered
        closeOnClickOutside={!canceling}
        closeOnEscape={!canceling}
        withCloseButton={!canceling}
      >
        <Code block mb="sm">
          {group.id}
        </Code>
        <Text size="sm" mb="sm">
          Workhorse seals this group, so no task can join it. Then it cancels each member task that
          is not finished. An active member task stops when its handler observes the cancellation.
          The group finishes with the result failed, and its onFinish and onFailure callbacks run.
          You cannot undo a cancellation.
        </Text>
        <TextInput
          data-autofocus
          required
          label="Reason"
          description="Workhorse records this reason in the group events."
          placeholder="Why are you canceling this task group?"
          value={reason}
          maxLength={2_000}
          disabled={canceling}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="default" disabled={canceling} onClick={() => setConfirming(false)}>
            Keep group
          </Button>
          <Button
            color="red"
            loading={canceling}
            disabled={reason.trim() === ""}
            onClick={() => void cancelGroup()}
          >
            Cancel group
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}

export function TaskGroupsPage({
  data,
  location,
  navigation,
  navigate,
  auditActor,
  reload,
}: {
  data: TaskGroupsPageData;
  location: TaskGroupsLocationState;
  navigation: TaskGroupsNavigation;
  navigate: (href: string) => void;
  auditActor: string;
  reload: () => Promise<void>;
}) {
  return data.kind === "list" ? (
    <TaskGroupsList
      data={data.list}
      location={location}
      navigation={navigation}
      navigate={navigate}
    />
  ) : (
    <TaskGroupDetailView
      data={data.detail}
      location={location}
      navigation={navigation}
      navigate={navigate}
      auditActor={auditActor}
      reload={reload}
    />
  );
}
