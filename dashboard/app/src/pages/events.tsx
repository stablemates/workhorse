import type {
  DashboardEventDetail,
  DashboardEventRow,
  DashboardEventsPage,
  DashboardEventsWindow,
} from "@workhorse/dashboard-server/wire";
import { isEventTypeFilter, type EventsLocationState } from "../events-location.js";
import { dashboardAttemptOutcomes, dashboardJobEventTypes } from "../presentation.js";
import {
  Badge,
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
  Tooltip,
} from "@mantine/core";
import { MultiSelect, Select } from "../dropdown-activity.js";
import { type ReactNode } from "react";
import { JsonValue, boundaryEventPresentation } from "../components/task-detail-overview.js";
import {
  EmptyState,
  PageHeader,
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
  if (type === "timeout") return "red";
  if (type === "retry") return "orange";
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
 * Rows come from `job_event` and `attempt_history`, never from the PostgreSQL notification
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
  const eventFacets = useTaskFacets({
    queue: query.queue,
    worker: null,
    jobType: query.jobType,
    tags: [],
  });
  const queueOptions = includeSelectedOption(eventFacets.facets.queues, query.queue);
  const typeOptions = includeSelectedOption(eventFacets.facets.jobTypes, query.jobType);
  const eventTypeOptions = includeSelectedOptions(
    uniqueSorted([...dashboardJobEventTypes, ...dashboardAttemptOutcomes]),
    query.types,
  );
  const retentionNote = [
    data.retention.jobEventDays === null
      ? "lifecycle events are retained indefinitely"
      : `lifecycle events are retained for ${data.retention.jobEventDays} days`,
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
      <PageHeader
        title="Events"
        description="See what happened across all tasks, with the newest records first."
      />
      <Paper withBorder p="md">
        <Group gap="md" align="flex-end" wrap="wrap">
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
            value={query.jobType}
            onChange={(value) => filter({ jobType: value })}
            onDropdownOpen={eventFacets.load}
            rightSection={eventFacets.loading ? <Loader size={14} /> : undefined}
            nothingFoundMessage={facetMessage ?? "No task types found"}
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
        </Group>
      </Paper>
      {/* Queue and task filters are matched against the job a history row points at. History
          outlives the job it describes, so rows whose job has already been retained away can only
          be reached with those filters cleared. */}
      {data.events.length === 0 ? (
        <EmptyState>
          Workhorse recorded no matching events in the last {query.window}. Retention limits
          available history: {retentionNote}.
        </EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing={6} horizontalSpacing="md" miw={1100}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={150} style={{ whiteSpace: "nowrap" }}>
                    When
                  </Table.Th>
                  <Table.Th w={190} style={{ whiteSpace: "nowrap" }}>
                    Event
                  </Table.Th>
                  <Table.Th w={90} style={{ whiteSpace: "nowrap" }}>
                    ID
                  </Table.Th>
                  <Table.Th style={{ whiteSpace: "nowrap" }}>Task</Table.Th>
                  <Table.Th w={140} style={{ whiteSpace: "nowrap" }}>
                    Queue
                  </Table.Th>
                  <Table.Th w={80} ta="right" style={{ whiteSpace: "nowrap" }}>
                    Attempt
                  </Table.Th>
                  <Table.Th w={160} style={{ whiteSpace: "nowrap" }}>
                    Worker
                  </Table.Th>
                  <Table.Th w={110} ta="right" style={{ whiteSpace: "nowrap" }}>
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
        This feed stays complete when notifications are missed because Workhorse reads durable
        history. Retention limits its depth: {retentionNote}. Open a task to see its complete
        timeline.
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
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          inspectEvent(event);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Inspect ${event.type.replaceAll("_", " ")} event for ${event.jobType ?? event.jobId}`}
      style={{ cursor: "pointer" }}
    >
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Tooltip label={formatExact(event.occurredAt)} withArrow>
          <Text size="sm">{formatRelative(event.occurredAt)}</Text>
        </Tooltip>
      </Table.Td>
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Group gap={6} wrap="nowrap">
          <Badge color={eventTypeColor(event.type)} variant="light" style={{ flexShrink: 0 }}>
            {event.type.replaceAll("_", " ")}
          </Badge>
          {/* Which table the row came from is worth stating: an attempt row is a closed attempt
              with a measured duration, a lifecycle row is a transition the queue recorded. */}
          {event.kind === "attempt" ? (
            <Badge color="gray" variant="outline" size="xs" style={{ flexShrink: 0 }}>
              attempt
            </Badge>
          ) : null}
        </Group>
      </Table.Td>
      {/* The identifier is abbreviated to the prefix a person actually reads, with the whole value
          on the title so it stays copyable in full from the drawer the click opens. */}
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Code
          fz="xs"
          c="blue"
          title={event.jobId}
          style={{
            background: "transparent",
            paddingBlock: 0,
            paddingInline: 0,
          }}
        >
          {event.jobId.slice(0, 8)}
        </Code>
      </Table.Td>
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Text size="sm">{event.jobType ?? "—"}</Text>
      </Table.Td>
      <Table.Td style={{ whiteSpace: "nowrap" }}>
        <Text size="sm">
          {event.queue ?? (
            <Text component="span" c="dimmed" fz="xs">
              Task deleted
            </Text>
          )}
        </Text>
      </Table.Td>
      <Table.Td ta="right" style={{ whiteSpace: "nowrap" }}>
        <Text size="sm">{event.attempt ?? "—"}</Text>
      </Table.Td>
      <Table.Td style={{ whiteSpace: "nowrap", maxWidth: 160 }}>
        <Text size="sm" truncate>
          {event.workerId ?? "—"}
        </Text>
      </Table.Td>
      <Table.Td ta="right" style={{ whiteSpace: "nowrap" }}>
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
  const taskId =
    event.jobType === null ? (
      <Code>{event.jobId}</Code>
    ) : (
      <Text
        component="a"
        href={taskLinkHref(event.jobId)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open task ${event.jobId} in a new window`}
      >
        <Code>{event.jobId}</Code>
      </Text>
    );
  const fields: Array<[string, ReactNode]> = [
    ["Event", event.type.replaceAll("_", " ")],
    ["Source", event.kind === "event" ? "Lifecycle" : "Attempt history"],
    ["Occurred", formatExact(event.occurredAt)],
    ["Task", event.jobType ?? "Retained away"],
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
