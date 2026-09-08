import type { DashboardTaskFilter } from "@stablemates/workhorse-dashboard-server/wire";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { color, Group, Paper, SegmentedControl, Text } from "../ui/index.js";
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
      <div className="activity-chart" role="img" aria-label={`Task activity grouped by ${groupBy}`}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="bucket"
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <YAxis
              allowDecimals={false}
              width={36}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              cursor={{ fill: "var(--muted)" }}
            />
            {series.length > 1 ? <Legend wrapperStyle={{ fontSize: 11, paddingTop: 16 }} /> : null}
            {series.map((entry) => (
              <Bar
                key={entry.name}
                dataKey={entry.name}
                name={entry.label}
                stackId="activity"
                fill={color(entry.color)}
                radius={2}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Paper>
  );
}
