import { taskStatusColors } from "../status-colors.js";
import { StatusLabel } from "../status-badge.js";
import { TaskTableId } from "../components/task-table-id.js";
import { TaskIdChip } from "../components/task-detail-relations.js";
import type {
  DashboardEventDetail,
  DashboardEventRow,
  DashboardEventsPage,
  DashboardEventsWindow,
} from "@stablemates/workhorse-dashboard-server/wire";
import {
  dashboardAttemptOutcomes,
  dashboardTaskEventTypes,
} from "@stablemates/workhorse-dashboard-server/wire";
import { isEventTypeFilter, type EventsLocationState } from "../events-location.js";
import {
  Box,
  Code,
  Group,
  Loader,
  Pagination,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { MultiSelect, Select } from "../dropdown-activity.js";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { JsonValue, boundaryEventPresentation } from "../components/task-detail-overview.js";
import {
  EmptyState,
  includeSelectedOption,
  includeSelectedOptions,
  useTaskFacets,
} from "../components/task-list.js";
import { eventsWindowOptions } from "./overview.js";
import { formatDuration, formatExact, formatRelative } from "../preferences.js";

export const eventsKindOptions = [
  { value: "all", label: "All" },
  { value: "event", label: "Lifecycle" },
  { value: "attempt", label: "Attempts" },
];
/**
 * Colour for one history row, keyed on what the row says happened.
 *
 * `succeeded` and `failed` name both a lifecycle event and an attempt outcome, which is why this
 * reads the type alone and not the source table.
 */
export function eventTypeColor(type: string): string {
  const lifecycle = boundaryEventPresentation[type];
  if (lifecycle !== undefined) return lifecycle.color;
  if (type === "timeout") return taskStatusColors.failed;
  if (type === "retry") return taskStatusColors.scheduled;
  return "gray";
}
/** One-line rendering of an event payload, for a table cell that cannot hold formatted JSON. */
export function eventDetailSummary(details: unknown): string | null {
  if (details === null || details === undefined) return null;
  if (typeof details !== "object") return String(details);
  const entries = Object.entries(details as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join(" · ");
}
export function uniqueSorted(values: Array<string | null>): string[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}
/**
 * The fleet-wide feed of durable lifecycle history.
 *
 * Rows come from `task_event` and `attempt_history`, never from the PostgreSQL notification
 * channels. Those channels carry only a queue name, are coalesced by both the worker and the
 * dashboard's listener, and are dropped while nothing is listening — a feed built from them would
 * be both uninformative and quietly incomplete.
 *
 * The feed is a window, not a paginated log. It updates in place while an operator watches, and a
 * cursor walking backwards through a list whose head keeps moving is not something anyone should
 * have to reason about. One task's complete history is in its own timeline in the task drawer.
 */
export function EventsPage({
  data,
  query,
  setQuery,
  inspectEvent,
}: {
  data: DashboardEventsPage;
  query: EventsLocationState;
  setQuery: (next: EventsLocationState) => void;
  inspectEvent: (event: DashboardEventRow) => void;
}) {
  const [searchDraft, setSearchDraft] = useState<string | null>(null);
  useEffect(() => {
    if (searchDraft === null) return;
    const timer = setTimeout(() => {
      const search = searchDraft.trim() || null;
      if (search !== query.search) setQuery({ ...query, search, page: 1, eventId: null });
      setSearchDraft(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft, query, setQuery]);
  const eventFacets = useTaskFacets({
    queue: query.queue,
    worker: query.worker,
    taskType: query.taskType,
    tags: [],
  });
  const queueOptions = includeSelectedOption(eventFacets.facets.queues, query.queue);
  const workerOptions = includeSelectedOption(eventFacets.facets.workers, query.worker);
  const typeOptions = includeSelectedOption(eventFacets.facets.taskTypes, query.taskType);
  const eventTypeOptions = includeSelectedOptions(
    uniqueSorted([...dashboardTaskEventTypes, ...dashboardAttemptOutcomes]),
    query.types,
  );
  const retentionNote = [
    data.retention.taskEventDays === null
      ? "lifecycle events are retained indefinitely"
      : `lifecycle events are retained for ${data.retention.taskEventDays} days`,
    data.retention.attemptHistoryDays === null
      ? "attempt history is retained indefinitely"
      : `attempt history is retained for ${data.retention.attemptHistoryDays} days`,
  ].join(", ");
  // Any change to what is being asked for returns to the first page: page 4 of the old filter
  // addresses nothing in the new result set.
  const filter = (next: Partial<EventsLocationState>) =>
    setQuery({ ...query, ...next, page: 1, eventId: null });
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const facetMessage = eventFacets.loading ? "Loading filters…" : eventFacets.error;

  return (
    <Stack gap="xl">
      <Paper withBorder p="md">
        <Group gap="md" align="flex-end" wrap="wrap">
          <TextInput
            size="xs"
            label="Search"
            placeholder="Task ID, name, event, or error"
            w={260}
            value={searchDraft ?? query.search ?? ""}
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
            maxLength={200}
          />
          <Select
            size="xs"
            label="Queue"
            placeholder="Any queue"
            clearable
            searchable
            w={180}
            data={queueOptions}
            value={query.queue}
            onChange={(value) => filter({ queue: value })}
            onDropdownOpen={eventFacets.load}
            rightSection={eventFacets.loading ? <Loader size={14} /> : undefined}
            nothingFoundMessage={facetMessage ?? "No queues found"}
          />
          <Select
            size="xs"
            label="Task type"
            placeholder="Any type"
            clearable
            searchable
            w={200}
            data={typeOptions}
            value={query.taskType}
            onChange={(value) => filter({ taskType: value })}
            onDropdownOpen={eventFacets.load}
            rightSection={eventFacets.loading ? <Loader size={14} /> : undefined}
            nothingFoundMessage={facetMessage ?? "No task types found"}
          />
          <Select
            size="xs"
            label="Worker"
            placeholder="Any worker"
            clearable
            searchable
            w={200}
            data={workerOptions}
            value={query.worker}
            onChange={(worker) => filter({ worker })}
            onDropdownOpen={eventFacets.load}
            nothingFoundMessage={facetMessage ?? "No workers found"}
          />
          <MultiSelect
            size="xs"
            label="Event"
            placeholder={query.types.length === 0 ? "Any event" : undefined}
            clearable
            searchable
            w={260}
            data={eventTypeOptions}
            value={query.types}
            onChange={(value) => filter({ types: value.filter(isEventTypeFilter) })}
          />
          <Select
            size="xs"
            label="Rows"
            w={100}
            allowDeselect={false}
            data={["25", "50", "100"]}
            value={String(query.pageSize)}
            onChange={(value) =>
              filter({
                pageSize: Number(value ?? 50) as EventsLocationState["pageSize"],
              })
            }
          />
          <Group ms="auto" gap="md" align="flex-end" justify="flex-end" wrap="wrap">
            <Box>
              <Text c="dimmed" fw={600} size="xs" mb={4}>
                Window
              </Text>
              <SegmentedControl
                size="xs"
                value={query.window}
                data={[...eventsWindowOptions]}
                onChange={(value) => filter({ window: value as DashboardEventsWindow })}
              />
            </Box>
            <Box>
              <Text c="dimmed" fw={600} size="xs" mb={4}>
                Source
              </Text>
              <SegmentedControl
                size="xs"
                value={query.kind}
                data={eventsKindOptions}
                onChange={(value) => filter({ kind: value as EventsLocationState["kind"] })}
              />
            </Box>
          </Group>
        </Group>
      </Paper>
      {/* Queue and task filters are matched against the task a history row points at. History
          outlives the task it describes, so rows whose task has already been retained away can only
          be reached with those filters cleared. */}
      {data.events.length === 0 ? (
        <EmptyState>
          Workhorse recorded no matching events in the last {query.window}. Retention limits
          available history: {retentionNote}.
        </EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea
            type="auto"
            offsetScrollbars="x"
            viewportProps={{ tabIndex: 0, role: "region", "aria-label": "Events table" }}
          >
            <Table
              highlightOnHover
              verticalSpacing={6}
              horizontalSpacing="md"
              className="dashboard-table dashboard-table--events"
              miw={1100}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th className="event-table__col--id">Task ID</Table.Th>
                  <Table.Th className="event-table__col--status">Event</Table.Th>
                  <Table.Th className="event-table__col--when">When</Table.Th>
                  <Table.Th className="event-table__col--queue">Queue</Table.Th>
                  <Table.Th
                    className="event-table__col--task"
                    w={416}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    Task
                  </Table.Th>
                  <Table.Th w={160} style={{ whiteSpace: "nowrap" }}>
                    Worker
                  </Table.Th>
                  <Table.Th className="event-table__col--attempt" ta="right">
                    Attempt
                  </Table.Th>
                  <Table.Th className="event-table__col--duration" ta="right">
                    Duration
                  </Table.Th>
                  <Table.Th w={280}>Detail</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.events.map((event) => (
                  <EventRow key={event.id} event={event} inspectEvent={inspectEvent} />
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}
      {totalPages > 1 ? (
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Pagination
            value={Math.min(data.page, totalPages)}
            onChange={(page) => setQuery({ ...query, page, eventId: null })}
            total={totalPages}
            size="xs"
            aria-label="Events pagination"
          />
          {/* Pages are offsets into a list whose head keeps moving, so say so rather than let an
              operator wonder why a row they were reading moved down a page. */}
          {data.page > 1 ? (
            <Text c="dimmed" size="xs">
              When the dashboard refreshes, new events can move rows between pages.
            </Text>
          ) : null}
        </Group>
      ) : null}
      <Text c="dimmed" size="xs">
        A task completion can record both a lifecycle transition and an attempt outcome. Use Source
        to view either separately. This feed stays complete when notifications are missed because
        Workhorse reads durable history. Retention limits its depth: {retentionNote}. Open a task to
        see its complete timeline.
      </Text>
    </Stack>
  );
}
export function EventRow({
  event,
  inspectEvent,
}: {
  event: DashboardEventRow;
  inspectEvent: (event: DashboardEventRow) => void;
}) {
  const detail = event.errorMessage ?? eventDetailSummary(event.details);
  return (
    <Table.Tr
      onClick={() => inspectEvent(event)}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.target !== keyboardEvent.currentTarget) return;
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          inspectEvent(event);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Inspect ${event.type.replaceAll("_", " ")} event for ${event.taskType ?? event.taskId}`}
      style={{ cursor: "pointer" }}
    >
      <Table.Td className="event-table__col--id">
        <TaskTableId id={event.taskId} />
      </Table.Td>
      <Table.Td className="event-table__col--status">
        <StatusLabel
          state={event.type}
          text={`${event.kind === "attempt" ? "Attempt" : "Task"} ${event.type.replaceAll("_", " ")}`}
          color={eventTypeColor(event.type)}
        />
      </Table.Td>
      <Table.Td className="event-table__col--when">
        <Tooltip label={formatExact(event.occurredAt)} withArrow>
          <Text size="sm">{formatRelative(event.occurredAt)}</Text>
        </Tooltip>
      </Table.Td>
      <Table.Td className="event-table__col--queue">
        <Text size="sm" c="dimmed" title={event.queue ?? "Task deleted"}>
          {event.queue ?? "Task deleted"}
        </Text>
      </Table.Td>
      <Table.Td className="event-table__col--task">
        <Text
          size="sm"
          title={event.taskType ?? "Task deleted"}
          style={{ overflowWrap: "anywhere" }}
        >
          {event.taskType ?? "—"}
        </Text>
      </Table.Td>
      <Table.Td style={{ whiteSpace: "nowrap", maxWidth: 160 }}>
        <Text size="sm" truncate title={event.workerId ?? undefined}>
          {event.workerId ?? "—"}
        </Text>
      </Table.Td>
      <Table.Td className="event-table__col--attempt" ta="right">
        <Text size="sm">{event.attempt ?? "—"}</Text>
      </Table.Td>
      <Table.Td className="event-table__col--duration" ta="right">
        <Text size="sm">{formatDuration(event.durationMs)}</Text>
      </Table.Td>
      <Table.Td style={{ maxWidth: 280 }}>
        {detail ? (
          <Tooltip label={detail} withArrow multiline maw={480}>
            <Text size="xs" c={event.errorMessage ? "red" : "dimmed"} truncate>
              {detail}
            </Text>
          </Tooltip>
        ) : (
          <Text c="dimmed" fz="xs">
            —
          </Text>
        )}
      </Table.Td>
    </Table.Tr>
  );
}
export function EventDetails({
  event,
  taskLinkHref,
}: {
  event: DashboardEventDetail;
  taskLinkHref: (id: string) => string;
}) {
  const taskId = (
    <Group gap="xs" wrap="nowrap">
      <TaskIdChip id={event.taskId} />
      {event.taskType !== null ? (
        <Text
          component="a"
          href={taskLinkHref(event.taskId)}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open task ${event.taskId}`}
          aria-label={`Open task ${event.taskId} in a new window`}
        >
          <ArrowSquareOut size={14} aria-hidden />
        </Text>
      ) : null}
    </Group>
  );
  const fields: Array<[string, ReactNode]> = [
    [
      "Event",
      `${event.kind === "attempt" ? "Attempt" : "Task"} ${event.type.replaceAll("_", " ")}`,
    ],
    ["Source", event.kind === "event" ? "Lifecycle" : "Attempt history"],
    ["Occurred", formatExact(event.occurredAt)],
    ["Task", event.taskType ?? "Retained away"],
    ["Task ID", taskId],
    ["Queue", event.queue ?? "Retained away"],
    ["Attempt", event.attempt ?? "—"],
    ["Worker", event.workerId ?? "—"],
    ["Fence token", event.fenceToken ?? "—"],
    ["Started", event.startedAt ? formatExact(event.startedAt) : "—"],
    ["Claimed", event.claimedAt ? formatExact(event.claimedAt) : "—"],
    ["Finished", event.finishedAt ? formatExact(event.finishedAt) : "—"],
    ["Duration", formatDuration(event.durationMs)],
    ["Record ID", <Code key="record-id">{event.recordId}</Code>],
  ];
  return (
    <Stack gap="lg">
      <Stack gap={8}>
        {fields.map(([label, value]) => (
          <Group key={label} justify="space-between" align="flex-start" wrap="nowrap">
            <Text c="dimmed" size="sm">
              {label}
            </Text>
            <Text component="div" size="sm" ta="right" style={{ overflowWrap: "anywhere" }}>
              {value}
            </Text>
          </Group>
        ))}
      </Stack>
      {event.error !== null ? (
        <JsonValue
          label="Error"
          value={event.error}
          emptyLabel="This attempt finished without an error."
          copyLabel="the attempt error"
        />
      ) : null}
      <JsonValue
        label="Details"
        value={event.details}
        emptyLabel="This event was recorded without details."
        copyLabel="the event details"
      />
    </Stack>
  );
}
