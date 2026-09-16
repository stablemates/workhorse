import type { DashboardEventDetail } from "@stablemates/workhorse-dashboard-server/wire";
import { Code, Group, Stack, Text } from "@mantine/core";
import { ArrowSquareOut } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { JsonValue } from "./task-detail-overview.js";
import { TaskIdChip } from "./task-detail-relations.js";
import { formatDuration, formatExact } from "../preferences.js";

/**
 * Body of the event detail drawer.
 *
 * The drawer is part of the shell, so this lives outside `pages/events`; importing it from the
 * page would pull the whole events table into the main bundle.
 */
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
