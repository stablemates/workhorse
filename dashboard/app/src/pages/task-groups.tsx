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
  Box,
  Button,
  Code,
  Group,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState, type MouseEvent } from "react";
import { useDashboardClient, type TaskGroupsPageData } from "../core.js";
import { EmptyState } from "../components/empty-state.js";
import { Page, PageHeader, PageSection, TablePanel } from "../components/page-header.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { notifyDashboard, notifyFailure } from "../notifications.js";
import { formatExact, formatJson, formatRelative } from "../preferences.js";
import { statusColor } from "../status-colors.js";
import { StatusLabel } from "../status-badge.js";
import { formatCount } from "../count-format.js";
import {
  taskGroupsListingKey,
  taskGroupsLocationHref,
  type TaskGroupsLocationState,
} from "../task-groups-location.js";
import { PendingResults, ResultsAnnouncement, usePagePending } from "../pending-results.js";
import { useRowKeyboardNavigation } from "../list-keyboard.js";
import { randomUuid } from "../random-uuid.js";

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

/**
 * The state of a group as one status label. A finished group shows its result, because the
 * result answers the operator's question. An open or sealed group shows its state.
 */
function TaskGroupStateBadges({ group }: { group: DashboardTaskGroup }) {
  const result = group.state === "finished" ? group.result : null;
  const color =
    result !== null
      ? statusColor(result)
      : group.state === "sealed"
        ? statusColor("active")
        : "gray";
  return (
    <Group gap={6} wrap="nowrap">
      <StatusLabel
        state={group.state}
        text={result ?? group.state}
        label={result === null ? `State: ${group.state}` : `State: finished, result: ${result}`}
        color={color}
      />
      {group.canceledAt ? (
        <Text component="span" size="xs" c="dimmed">
          Canceled
        </Text>
      ) : null}
    </Group>
  );
}

function Timestamp({ value }: { value: string | null }) {
  if (value === null)
    return (
      <Text c="dimmed" size="sm">
        —
      </Text>
    );
  return (
    <Text size="sm" c="dimmed" title={formatExact(value)}>
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
  // A state or pager change keeps these rows, dimmed, until the new rows arrive.
  const pending = usePagePending();
  const groupPath = (groupId: string) =>
    taskGroupsLocationHref({ ...location, groupId, after: null });
  // ArrowDown, ArrowUp, j, and k move through the group links. Enter opens the group.
  useRowKeyboardNavigation({
    list: () => document.querySelector("[role='region'][aria-label='Task groups table']"),
    rowSelector: ".task-group-row__link",
    panel: null,
  });
  return (
    <Page>
      <PageHeader
        title="Task groups"
        description="A task group tracks a set of tasks as one unit. When every member task is finished, Workhorse enqueues the callbacks of the group."
      />
      <div className="page-toolbar">
        <SegmentedControl
          size="xs"
          aria-label="Task group state"
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
      </div>
      <ResultsAnnouncement
        requestKey={taskGroupsListingKey(location)}
        pending={pending}
        count={data.groups.length}
        message={
          data.groups.length === 0
            ? "No task groups match this state."
            : `The table shows ${formatCount(data.groups.length)} task ${data.groups.length === 1 ? "group" : "groups"}.`
        }
      />
      <PendingResults pending={pending} requestKey={taskGroupsListingKey(location)}>
        {data.groups.length === 0 ? (
          location.state === "all" ? (
            <EmptyState title="No task groups">
              An application creates a task group when it enqueues a set of tasks as one unit.
            </EmptyState>
          ) : (
            <EmptyState
              title={`No ${location.state} task groups`}
              action={
                <Button
                  size="xs"
                  variant="default"
                  onClick={() =>
                    navigate(taskGroupsLocationHref({ ...location, state: "all", page: 1 }))
                  }
                >
                  Show all task groups
                </Button>
              }
            >
              No task group is {location.state} now. Other states can still hold groups.
            </EmptyState>
          )
        ) : (
          <TablePanel label="Task groups table">
            <Table highlightOnHover className="data-table" miw={760}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Group</Table.Th>
                  <Table.Th>State</Table.Th>
                  <Table.Th>Progress</Table.Th>
                  <Table.Th className="data-table__metric">Failed</Table.Th>
                  <Table.Th className="data-table__metric">Canceled</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Finished</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.groups.map((group) => (
                  <Table.Tr
                    key={group.id}
                    className="task-group-row"
                    onClick={(event) => {
                      // A click on the group link or another control acts on that control.
                      if (
                        (event.target as HTMLElement).closest("a, button, input, .status-label")
                      ) {
                        return;
                      }
                      const path = groupPath(group.id);
                      if (event.metaKey || event.ctrlKey) {
                        window.open(navigation.href(path), "_blank", "noopener");
                        return;
                      }
                      navigate(path);
                    }}
                  >
                    <Table.Td>
                      <Anchor
                        className="task-group-row__link"
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
                    <Table.Td className="data-table__metric">
                      {formatCount(group.counts.failed)}
                    </Table.Td>
                    <Table.Td className="data-table__metric">
                      {formatCount(group.counts.canceled)}
                    </Table.Td>
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
          </TablePanel>
        )}
      </PendingResults>
      <nav className="page-pager" aria-label="Task group pages">
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
      </nav>
    </Page>
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
  // A member pager change keeps these rows, dimmed, until the new rows arrive.
  const pending = usePagePending();
  const { group } = data;
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [canceling, setCanceling] = useState(false);
  const cancelInFlight = useRef(false);
  const reasonInput = useRef<HTMLInputElement>(null);
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
        audit: { actor: auditActor, reason: reason.trim(), requestId: randomUuid() },
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
    <Page>
      <Anchor
        className="task-group__back"
        href={navigation.href(listPath)}
        onClick={(event) => navigation.followLink(event, listPath)}
        size="sm"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} aria-hidden />
        All task groups
      </Anchor>
      <PageHeader
        title="Task group"
        titleAside={<TaskGroupStateBadges group={group} />}
        description={<Code className="task-group__id">{group.id}</Code>}
        actions={
          group.state === "finished" ? undefined : !data.canCancel ? (
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
          )
        }
      />
      <section className="panel panel--padded task-group__summary" aria-label="Progress">
        <TaskGroupProgress counts={group.counts} size="lg" />
        <SimpleGrid cols={{ base: 2, sm: 5 }} spacing="md">
          {(["total", "succeeded", "failed", "canceled", "pending"] as const).map((name) => (
            <Stack key={name} gap={0}>
              <Text size="xs" c="dimmed" tt="capitalize">
                {name}
              </Text>
              <Text fw={600} className="task-group__count">
                {formatCount(group.counts[name])}
              </Text>
            </Stack>
          ))}
        </SimpleGrid>
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
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
      </section>

      <PageSection id="task-group-callbacks" title="Callbacks">
        {group.callbacks.length === 0 ? (
          <EmptyState title="No callbacks">
            This group enqueues no task when it finishes.
          </EmptyState>
        ) : (
          <TablePanel label="Callbacks table">
            <Table className="data-table">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={140}>Callback</Table.Th>
                  <Table.Th>Task</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {group.callbacks.map((callback) => (
                  <Table.Tr key={callback.kind}>
                    <Table.Td>
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
          </TablePanel>
        )}
      </PageSection>

      <PageSection id="task-group-members" title="Member tasks">
        <PendingResults pending={pending} requestKey={taskGroupsListingKey(location)}>
          {data.members.length === 0 ? (
            <EmptyState title="No member tasks">
              {location.after === null
                ? "This group has no member tasks."
                : "No member tasks follow this position."}
            </EmptyState>
          ) : (
            <TablePanel label="Member tasks table">
              <Table highlightOnHover className="data-table" miw={760}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th className="data-table__metric">#</Table.Th>
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
                    <Table.Tr
                      key={member.taskId}
                      className="task-group-row"
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest("a, button, input")) return;
                        const path = navigation.taskPath(member.taskId);
                        if (event.metaKey || event.ctrlKey) {
                          window.open(navigation.href(path), "_blank", "noopener");
                          return;
                        }
                        navigate(path);
                      }}
                    >
                      <Table.Td className="data-table__metric">{member.position}</Table.Td>
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
                      <Table.Td>
                        {member.taskType ?? (
                          <Text c="dimmed" size="sm">
                            deleted
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {member.queue ?? (
                          <Text c="dimmed" size="sm">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {member.state ? (
                          <StatusLabel state={member.state} />
                        ) : (
                          <Text c="dimmed" size="sm">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {member.outcome ? (
                          <StatusLabel state={member.outcome} />
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
            </TablePanel>
          )}
        </PendingResults>
        <nav className="page-pager" aria-label="Member task pages">
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
        </nav>
      </PageSection>

      <PageSection
        id="task-group-events"
        title="Events"
        description={
          data.eventsTruncated
            ? `This list shows the newest ${dashboardTaskGroupEventLimit} events of the group.`
            : undefined
        }
      >
        <TablePanel label="Task group events table">
          <Table className="data-table task-group__events">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={200}>Event</Table.Th>
                <Table.Th w={140}>When</Table.Th>
                <Table.Th>Details</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.events.map((event) => (
                <Table.Tr key={event.id}>
                  <Table.Td>
                    <Code>{event.type}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Timestamp value={event.occurredAt} />
                  </Table.Td>
                  <Table.Td>
                    <Code block>{formatJson(event.details)}</Code>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TablePanel>
      </PageSection>

      <ConfirmDialog
        open={confirming}
        title="Cancel this task group?"
        tone="danger"
        confirmLabel="Cancel group"
        cancelLabel="Keep group"
        pending={canceling}
        confirmDisabled={reason.trim() === ""}
        initialFocus={reasonInput}
        onCancel={() => {
          if (!cancelInFlight.current) setConfirming(false);
        }}
        onConfirm={() => void cancelGroup()}
      >
        <Code block>{group.id}</Code>
        <p>
          Workhorse seals this group, so no task can join it. Then it cancels each member task that
          is not finished. An active member task stops when its handler observes the cancellation.
          The group finishes with the result failed, and its onFinish and onFailure callbacks run.
          You cannot undo a cancellation.
        </p>
        <Box>
          <TextInput
            ref={reasonInput}
            required
            label="Reason"
            description="Workhorse records this reason in the group events."
            placeholder="Why are you canceling this task group?"
            value={reason}
            maxLength={2_000}
            disabled={canceling}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </Box>
      </ConfirmDialog>
    </Page>
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
