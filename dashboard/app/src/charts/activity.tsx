import type { DashboardTaskFilter } from "@stablemates/workhorse-dashboard-server/wire";
import { BarChart } from "@mantine/charts";
import { Group, Paper, SegmentedControl, Text } from "@mantine/core";
import { useEffect, useState } from "react";
// oxlint-disable-next-line import/no-unassigned-import -- Keep chart CSS in the chart's lazy chunk.
import "./activity.css";
import {
  type ActivityData,
  type ActivityGroupBy,
  type ActivityPeriod,
  activityChartKey,
  activityGroupings,
  activityPeriods,
  activitySeriesColors,
  useDashboardClient,
} from "../core.js";
import { capActivityGroups } from "../presentation-policy.js";
import { displayTimeZone, getDateTimeFormatter } from "../preferences.js";
import type { TaskLocationState } from "../task-location.js";

const activityStatusColors: Record<string, string> = {
  blocked: "yellow.7",
  scheduled: "yellow.6",
  ready: "cyan.6",
  active: "blue.6",
  succeeded: "teal.6",
  failed: "red.6",
  canceled: "gray.6",
};

/** Full-width stacked bar chart of task activity with switchable period and grouping. */
export default function TasksActivityChart({
  filter,
  period,
  groupBy,
  tags,
  queue,
  worker,
  refreshKey,
  updateLocation,
}: {
  filter: DashboardTaskFilter;
  period: ActivityPeriod;
  groupBy: ActivityGroupBy;
  tags: string[];
  queue: string | null;
  worker: string | null;
  refreshKey: object;
  updateLocation: (updates: Partial<TaskLocationState>) => void;
}) {
  const client = useDashboardClient();
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const changePeriod = (value: string) => {
    const next = activityPeriods.includes(value as ActivityPeriod)
      ? (value as ActivityPeriod)
      : "1h";
    localStorage.setItem("workhorse-activity-period", next);
    updateLocation({ period: next });
  };
  const changeGroupBy = (value: string) => {
    const next = activityGroupings.some((grouping) => grouping.value === value)
      ? (value as ActivityGroupBy)
      : "task";
    localStorage.setItem("workhorse-activity-group", next);
    updateLocation({ group: next });
  };

  useEffect(() => {
    let cancelled = false;
    void client
      .activity({ filter, period, groupBy, tags, queue, worker })
      .then((page) => {
        if (!cancelled) setActivity(capActivityGroups(page));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, filter, period, groupBy, tags, queue, worker, refreshKey]);

  const labelFormat = (value: string): string => {
    const date = new Date(value);
    if (period === "7d" || period === "24h") {
      return getDateTimeFormatter({
        month: "short",
        day: "numeric",
        hour: "2-digit",
        timeZone: displayTimeZone ?? undefined,
      }).format(date);
    }
    return getDateTimeFormatter({
      hour: "2-digit",
      minute: "2-digit",
      timeZone: displayTimeZone ?? undefined,
    }).format(date);
  };
  const groups = activity?.groups ?? [];
  const chartData = (activity?.buckets ?? []).map((bucket) => {
    const point: Record<string, string | number> = {
      bucket: labelFormat(bucket.bucketStart),
    };
    for (const group of groups) point[activityChartKey(group)] = bucket.counts[group] ?? 0;
    return point;
  });
  const series = groups.map((group, index) => ({
    name: activityChartKey(group),
    label: group,
    color:
      group === "other"
        ? "gray.5"
        : groupBy === "status"
          ? (activityStatusColors[group] ?? "gray.6")
          : activitySeriesColors[index % activitySeriesColors.length]!,
  }));

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="sm">
        <Text fw={600} size="sm">
          Activity
          <Text span c="dimmed" size="sm">
            {" "}
            · {filter === "all" ? "all tasks" : filter}
          </Text>
        </Text>
        <Group gap="xs">
          <SegmentedControl
            size="xs"
            value={groupBy}
            onChange={changeGroupBy}
            data={activityGroupings}
          />
          <SegmentedControl
            size="xs"
            value={period}
            onChange={changePeriod}
            data={activityPeriods.map((value) => ({ value, label: value }))}
          />
        </Group>
      </Group>
      <BarChart
        h={320}
        data={chartData}
        dataKey="bucket"
        type="stacked"
        series={series}
        withLegend={series.length > 1}
        legendProps={{
          layout: "vertical",
          align: "left",
          verticalAlign: "middle",
          width: 280,
          wrapperStyle: { paddingRight: 16, textAlign: "left" },
        }}
        styles={{
          legend: {
            justifyContent: "flex-start",
            flexDirection: "column",
            alignItems: "flex-start",
          },
          legendItem: { width: "100%", minWidth: 0 },
          legendItemName: {
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          },
        }}
        gridAxis="xy"
        tickLine="y"
        withYAxis
        withTooltip
        barProps={{ radius: 2 }}
        yAxisProps={{ allowDecimals: false, width: 36 }}
        xAxisProps={{ interval: "preserveStartEnd", minTickGap: 24 }}
      />
    </Paper>
  );
}
