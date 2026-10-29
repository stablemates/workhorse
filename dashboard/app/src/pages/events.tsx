import { dangerTextColor, taskStatusColors } from "../status-colors.js";
import { StatusLabel } from "../status-badge.js";
import { TaskTableId } from "../components/task-table-id.js";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  DashboardEventRow,
  DashboardEventsPage,
  DashboardEventsWindow,
} from "@stablemates/workhorse-dashboard-server/wire";
import {
  dashboardAttemptOutcomes,
  dashboardPageMax,
  dashboardTaskEventTypes,
} from "@stablemates/workhorse-dashboard-server/wire";
import {
  eventsListingKey,
  isEventTypeFilter,
  type EventsLocationState,
} from "../events-location.js";
import { eventDetailSummary, eventsWindowOptions } from "../event-presentation.js";
import {
  Box,
  Button,
  Group,
  Loader,
  Pagination,
  SegmentedControl,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { MultiSelect, Select } from "../dropdown-activity.js";
import { useEffect, useRef, useState } from "react";
import { boundaryEventPresentation } from "../components/task-detail-overview.js";
import {
  includeSelectedOption,
  includeSelectedOptions,
  useTaskFacets,
} from "../components/task-list.js";
import { EmptyState } from "../components/empty-state.js";
import { keepFocusOnRemoval } from "../components/task-filter-bar.js";
import { Page, PageHeader, TablePanel } from "../components/page-header.js";
import { formatDuration, formatExact, formatRelative } from "../preferences.js";
import { formatCount } from "../count-format.js";
import {
  PendingResults,
  PendingRows,
  ResultsAnnouncement,
  usePagePending,
} from "../pending-results.js";
import { useRowKeyboardNavigation } from "../list-keyboard.js";

/** The scroll region of the events table, which holds the rows that the keyboard moves through. */
const eventTableSelector = "[role='region'][aria-label='Events table']";

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
export function uniqueSorted(values: Array<string | null>): string[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

function padDateTimePart(part: number): string {
  return String(part).padStart(2, "0");
}

/** Format an instant for the browser's local `datetime-local` control. */
export function dateTimeLocalValue(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.getFullYear()}-${padDateTimePart(date.getMonth() + 1)}-${padDateTimePart(date.getDate())}T${padDateTimePart(date.getHours())}:${padDateTimePart(date.getMinutes())}`;
}

export type ParsedEventRange = { from: string; to: string } | { error: string };

/** Turn the picker values into the UTC instants sent to the events procedure. */
export function parseEventRange(fromValue: string, toValue: string): ParsedEventRange {
  if (!fromValue || !toValue) return { error: "Choose both a start and end time." };
  const from = new Date(fromValue);
  const to = new Date(toValue);
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) {
    return { error: "Enter a valid start and end time." };
  }
  if (from >= to) return { error: "The end time must be after the start time." };
  return { from: from.toISOString(), to: to.toISOString() };
}
/**
 * The custom range that continues the feed past the last page the server accepts.
 *
 * The range end is exclusive, so it normally sits one millisecond after the oldest event shown.
 * Events at that instant that the last page did not reach stay in the new range, at the cost of
 * showing the ones it did reach again. When that end would not move the range back, every page
 * shares one instant, so the range ends at that instant and `skipsTies` says the rest of it is
 * passed over. Returns null when the range holds nothing older.
 */
export function continueEventsRange(
  range: { rangeStart: string; rangeEnd: string },
  oldestShownAt: string,
): { from: string; to: string; skipsTies: boolean } | null {
  const oldest = Date.parse(oldestShownAt);
  const overlapping = oldest + 1;
  const skipsTies = overlapping >= Date.parse(range.rangeEnd);
  const to = skipsTies ? oldest : overlapping;
  if (to <= Date.parse(range.rangeStart)) return null;
  return { from: range.rangeStart, to: new Date(to).toISOString(), skipsTies };
}
/**
 * Remove the search and every filter, also the task filter. The time window and the custom range
 * stay.
 *
 * The search field writes its text to the URL 300 ms after the last keystroke. Its draft must
 * clear with the filters, or that write puts the search back after the clear.
 */
export function clearEventFilters({
  query,
  setQuery,
  setSearchDraft,
}: {
  query: EventsLocationState;
  setQuery: (next: EventsLocationState) => void;
  setSearchDraft: (draft: string | null) => void;
}): void {
  setSearchDraft(null);
  setQuery({
    ...query,
    search: null,
    queue: null,
    taskType: null,
    worker: null,
    types: [],
    taskId: null,
    page: 1,
    eventId: null,
  });
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
  // A source, range, filter, or pager change keeps these rows, dimmed, until the new rows arrive.
  const pending = usePagePending();
  const [searchDraft, setSearchDraft] = useState<string | null>(null);
  // The task filter remove button and Clear filters leave the page with their filter, so keyboard
  // focus moves to the search.
  const searchField = useRef<HTMLInputElement>(null);
  const [customRangeOpen, setCustomRangeOpen] = useState(query.from !== null);
  const [fromDraft, setFromDraft] = useState(() =>
    query.from === null ? "" : dateTimeLocalValue(query.from),
  );
  const [toDraft, setToDraft] = useState(() =>
    query.to === null ? "" : dateTimeLocalValue(query.to),
  );
  const [rangeError, setRangeError] = useState<string | null>(null);
  // ArrowDown, ArrowUp, j, and k move through the events, and through the drawer while it is open.
  useRowKeyboardNavigation({
    list: () => document.querySelector<HTMLElement>(eventTableSelector),
    rowSelector: ".task-table__open",
    panel: {
      id: "event-detail-drawer",
      ids: data.events.map((event) => event.id),
      openId: query.eventId,
      open: (id) => {
        const event = data.events.find((one) => one.id === id);
        if (event !== undefined) inspectEvent(event);
      },
      rowControl: (id) =>
        document.querySelector<HTMLElement>(
          `${eventTableSelector} [data-event-id="${CSS.escape(id)}"]`,
        ),
    },
  });
  useEffect(() => {
    if (searchDraft === null) return;
    const timer = setTimeout(() => {
      const search = searchDraft.trim() || null;
      if (search !== query.search) setQuery({ ...query, search, page: 1, eventId: null });
      setSearchDraft(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft, query, setQuery]);
  useEffect(() => {
    if (query.from === null || query.to === null) {
      setCustomRangeOpen(false);
      return;
    }
    setCustomRangeOpen(true);
    setFromDraft(dateTimeLocalValue(query.from));
    setToDraft(dateTimeLocalValue(query.to));
    setRangeError(null);
  }, [query.from, query.to]);
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
  // The feed reports the total it proved rather than a count over the whole window, so the pager
  // gains one page while more remain and settles on the real last page once it is reached. It
  // stops at the last page the server accepts, and the note below offers the rest another way.
  const totalPages = Math.min(dashboardPageMax, Math.max(1, Math.ceil(data.total / data.pageSize)));
  const beyondLastPage = data.total > dashboardPageMax * data.pageSize;
  const oldestShown = data.page === dashboardPageMax ? data.events.at(-1) : undefined;
  const continuation =
    oldestShown === undefined ? null : continueEventsRange(data, oldestShown.occurredAt);
  const pagination = (label: string) =>
    totalPages > 1 ? (
      <Pagination
        // The pager moves on the click. The rows follow when they arrive.
        value={Math.min(pending ? query.page : data.page, totalPages)}
        onChange={(page) => setQuery({ ...query, page, eventId: null })}
        total={totalPages}
        size="xs"
        aria-label={label}
        style={{ "--pagination-control-size": "calc(1.875rem * var(--mantine-scale))" }}
      />
    ) : null;
  const pageSizeSelector = (label: string) => (
    <Select
      size="xs"
      w={76}
      allowDeselect={false}
      data={["25", "50", "100"]}
      value={String(query.pageSize)}
      onChange={(value) =>
        filter({
          pageSize: Number(value ?? 50) as EventsLocationState["pageSize"],
        })
      }
      aria-label={label}
    />
  );
  const facetMessage = eventFacets.loading ? "Loading filters…" : eventFacets.error;
  const rangeDescription =
    query.from !== null && query.to !== null
      ? `between ${formatExact(query.from)} and ${formatExact(query.to)}`
      : `in the last ${query.window}`;

  const filtered =
    query.search !== null ||
    query.queue !== null ||
    query.taskType !== null ||
    query.worker !== null ||
    query.types.length > 0 ||
    query.taskId !== null;
  const customRange = customRangeOpen ? (
    <div className="page-toolbar__group" role="group" aria-label="Custom time range">
      <TextInput
        size="xs"
        type="datetime-local"
        label="From"
        value={fromDraft}
        onChange={(event) => {
          setFromDraft(event.currentTarget.value);
          setRangeError(null);
        }}
      />
      <TextInput
        size="xs"
        type="datetime-local"
        label="To"
        value={toDraft}
        onChange={(event) => {
          setToDraft(event.currentTarget.value);
          setRangeError(null);
        }}
      />
      <Button
        size="xs"
        onClick={() => {
          const range = parseEventRange(fromDraft, toDraft);
          if ("error" in range) {
            setRangeError(range.error);
            return;
          }
          setRangeError(null);
          filter(range);
        }}
      >
        Apply range
      </Button>
      {rangeError === null ? null : (
        <Text c={dangerTextColor} size="xs" role="alert" pb={6}>
          {rangeError}
        </Text>
      )}
    </div>
  ) : null;

  return (
    <Page>
      <PageHeader
        title="Events"
        description="Lifecycle transitions and attempt outcomes from durable history, newest first."
      />
      <div className="panel panel--padded events-controls">
        <div className="page-toolbar" role="group" aria-label="Event scope">
          <div className="page-toolbar__group">
            <Box>
              <Text c="dimmed" fw={500} size="xs" mb={4}>
                Source
              </Text>
              <SegmentedControl
                size="xs"
                value={query.kind}
                data={eventsKindOptions}
                onChange={(value) => filter({ kind: value as EventsLocationState["kind"] })}
              />
            </Box>
            <Box>
              <Text c="dimmed" fw={500} size="xs" mb={4}>
                Time range
              </Text>
              <SegmentedControl
                size="xs"
                value={customRangeOpen ? "custom" : query.window}
                data={[...eventsWindowOptions, { value: "custom", label: "Custom" }]}
                onChange={(value) => {
                  if (value === "custom") {
                    setCustomRangeOpen(true);
                    setRangeError(null);
                    if (!fromDraft || !toDraft) {
                      const to = new Date();
                      to.setSeconds(0, 0);
                      const from = new Date(to.valueOf() - 60 * 60 * 1000);
                      setFromDraft(dateTimeLocalValue(from));
                      setToDraft(dateTimeLocalValue(to));
                    }
                    return;
                  }
                  setCustomRangeOpen(false);
                  setRangeError(null);
                  filter({
                    window: value as DashboardEventsWindow,
                    from: null,
                    to: null,
                  });
                }}
              />
            </Box>
          </div>
          <div className="page-toolbar__group page-toolbar__end">
            {pagination("Events pagination above table")}
            {pageSizeSelector("Events per page above table")}
          </div>
        </div>
        {customRange}
        <div className="page-toolbar" role="group" aria-label="Event filters">
          {query.taskId === null ? null : (
            <Box>
              <Text c="dimmed" fw={500} size="xs" mb={4}>
                Task
              </Text>
              <Button
                size="xs"
                variant="default"
                title={query.taskId}
                aria-label={`Remove task filter ${query.taskId}`}
                rightSection={<HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden />}
                onClick={(event) => {
                  keepFocusOnRemoval({
                    removed: event.currentTarget,
                    active: document.activeElement,
                    target: searchField.current,
                  });
                  filter({ taskId: null });
                }}
              >
                {query.taskId.slice(0, 8)}
              </Button>
            </Box>
          )}
          <TextInput
            size="xs"
            ref={searchField}
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
        </div>
      </div>
      {/* Queue and task filters are matched against the task a history row points at. History
          outlives the task it describes, so rows whose task has already been retained away can only
          be reached with those filters cleared. */}
      <ResultsAnnouncement
        requestKey={eventsListingKey(query)}
        pending={pending}
        count={data.events.length}
        message={
          data.events.length === 0
            ? "No events match these filters."
            : `The table shows ${formatCount(data.events.length)} ${data.events.length === 1 ? "event" : "events"}.`
        }
      />
      <PendingResults pending={pending} requestKey={eventsListingKey(query)}>
        {data.events.length === 0 ? (
          <EmptyState
            title={filtered ? "No events match these filters" : "No events in this time range"}
            action={
              filtered ? (
                <Button
                  size="xs"
                  variant="default"
                  onClick={(event) => {
                    keepFocusOnRemoval({
                      removed: event.currentTarget,
                      active: document.activeElement,
                      target: searchField.current,
                    });
                    clearEventFilters({ query, setQuery, setSearchDraft });
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          >
            Workhorse recorded no matching events {rangeDescription}. Retention limits available
            history: {retentionNote}.
          </EmptyState>
        ) : (
          <TablePanel label="Events table">
            <Table
              highlightOnHover
              className="data-table dashboard-table dashboard-table--events"
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
                  <Table.Th className="event-table__col--attempt data-table__metric">
                    Attempt
                  </Table.Th>
                  <Table.Th className="event-table__col--duration data-table__metric">
                    Duration
                  </Table.Th>
                  <Table.Th w={280}>Detail</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <PendingRows>
                  {data.events.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      inspectEvent={inspectEvent}
                      selected={query.eventId === event.id}
                    />
                  ))}
                </PendingRows>
              </Table.Tbody>
            </Table>
          </TablePanel>
        )}
      </PendingResults>
      <div className="page-toolbar">
        <div className="page-toolbar__group">
          {pagination("Events pagination below table")}
          {pageSizeSelector("Events per page below table")}
        </div>
        {/* Pages are offsets into a list whose head keeps moving, so say so rather than let an
            operator wonder why a row they were reading moved down a page. */}
        {totalPages > 1 && data.page > 1 ? (
          <p className="page-footnote">
            When the dashboard refreshes, new events can move rows between pages.
          </p>
        ) : null}
      </div>
      {beyondLastPage ? (
        <Group gap="xs" wrap="wrap">
          <Text size="xs">
            The pager reaches the newest {formatCount(dashboardPageMax * data.pageSize)} events.
            {oldestShown === undefined
              ? ` Narrow the window or filters, or open page ${dashboardPageMax} to continue with older events.`
              : continuation === null
                ? " Narrow the window or filters to see the rest."
                : " Narrow the window or filters, or continue with the events older than this page."}
            {continuation?.skipsTies && oldestShown
              ? ` Every page shares ${formatExact(oldestShown.occurredAt)}, so continuing skips the rest of that instant's events.`
              : null}
          </Text>
          {continuation === null ? null : (
            <Button
              size="xs"
              variant="light"
              onClick={() => filter({ from: continuation.from, to: continuation.to })}
            >
              Continue with older events
            </Button>
          )}
        </Group>
      ) : null}
      <p className="page-footnote">
        A task completion can record both a lifecycle transition and an attempt outcome. Use Source
        to view either separately. This feed stays complete when notifications are missed because
        Workhorse reads durable history. Retention limits its depth: {retentionNote}. Open a task to
        see its complete timeline.
      </p>
    </Page>
  );
}
/**
 * The id of the button that opens an event. Event ids are unique across the merged feed, so the
 * id is unique on the page, and the pending results keep focus on it when the rows change.
 */
export function eventOpenButtonId(eventId: string): string {
  return `event-open-${eventId}`;
}

export function EventRow({
  event,
  inspectEvent,
  selected = false,
}: {
  event: DashboardEventRow;
  inspectEvent: (event: DashboardEventRow) => void;
  /** True while the event drawer shows this event. */
  selected?: boolean;
}) {
  const detail = event.errorMessage ?? eventDetailSummary(event.details);
  const label = `${event.kind === "attempt" ? "Attempt" : "Task"} ${event.type.replaceAll("_", " ")}`;
  return (
    // The row stays a table row, so assistive technology keeps each cell's column. A pointer
    // click anywhere opens the event; the keyboard and screen readers use the named button.
    <Table.Tr
      onClick={() => inspectEvent(event)}
      style={{ cursor: "pointer" }}
      data-selected={selected || undefined}
    >
      <Table.Td className="event-table__col--id">
        <TaskTableId id={event.taskId} />
      </Table.Td>
      <Table.Td className="event-table__col--status">
        <UnstyledButton
          id={eventOpenButtonId(event.id)}
          className="task-table__open"
          data-event-id={event.id}
          // The name starts from the visible label, so speech input can say what it sees.
          aria-label={`${label} event, inspect for ${event.taskType ?? event.taskId}`}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            inspectEvent(event);
          }}
        >
          <StatusLabel state={event.type} text={label} color={eventTypeColor(event.type)} />
        </UnstyledButton>
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
      <Table.Td className="event-table__col--attempt data-table__metric">
        <Text size="sm">{event.attempt ?? "—"}</Text>
      </Table.Td>
      <Table.Td className="event-table__col--duration data-table__metric">
        <Text size="sm">{formatDuration(event.durationMs)}</Text>
      </Table.Td>
      <Table.Td style={{ maxWidth: 280 }}>
        {detail ? (
          <Tooltip label={detail} withArrow multiline maw={480}>
            <Text size="xs" c={event.errorMessage ? dangerTextColor : "dimmed"} truncate>
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
