import type { DashboardTaskFilter } from "@stablemates/workhorse-dashboard-server/wire";
import { BarChart } from "@mantine/charts";
import { Alert, Button, Center, Group, Loader, Paper, SegmentedControl, Text } from "@mantine/core";
import { useEffect, useState, type ReactNode } from "react";
// oxlint-disable-next-line import/no-unassigned-import -- Keep chart CSS in the chart's lazy chunk.
import "./activity.css";
import {
  type ActivityGroupBy,
  type ActivityPeriod,
  activityGroupings,
  activityPeriods,
  activitySeriesColors,
  useDashboardClient,
} from "../core.js";
import { activityChartModel, type ActivityChartModel } from "../presentation-policy.js";
import { displayTimeZone, formatExact, getDateTimeFormatter } from "../preferences.js";
import { formatCount } from "../count-format.js";
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

/** The newest activity a query produced, keyed by that query. */
export interface ActivitySuccess {
  key: string;
  model: ActivityChartModel;
  /** When the browser received this result, for the stale notice. */
  receivedAt: string;
}

/** The newest failed request, keyed by the query it asked. */
export interface ActivityFailure {
  key: string;
}

export type ActivityView =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; model: ActivityChartModel }
  | { kind: "stale"; model: ActivityChartModel; receivedAt: string };

/**
 * What the chart may show for the query its controls name.
 *
 * A result belongs to the query that produced it. When the controls name another query, the old
 * bars would sit under labels that no longer describe them, so the chart shows loading instead.
 * A failed refresh of the same query keeps its bars and says they are stale.
 */
export function activityView(
  key: string,
  success: ActivitySuccess | null,
  failure: ActivityFailure | null,
): ActivityView {
  const failed = failure?.key === key;
  if (success?.key !== key) return failed ? { kind: "error" } : { kind: "loading" };
  return failed
    ? { kind: "stale", model: success.model, receivedAt: success.receivedAt }
    : { kind: "ready", model: success.model };
}

/** Identify one activity query, so a result can be matched to the controls that asked for it. */
export function activityQueryKey(query: {
  filter: DashboardTaskFilter;
  period: ActivityPeriod;
  groupBy: ActivityGroupBy;
  tags: readonly string[];
  queue: string | null;
  worker: string | null;
}): string {
  return JSON.stringify([
    query.filter,
    query.period,
    query.groupBy,
    query.tags,
    query.queue,
    query.worker,
  ]);
}

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
  refreshKey: number;
  updateLocation: (updates: Partial<TaskLocationState>) => void;
}) {
  const client = useDashboardClient();
  const [success, setSuccess] = useState<ActivitySuccess | null>(null);
  const [failure, setFailure] = useState<ActivityFailure | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const key = activityQueryKey({ filter, period, groupBy, tags, queue, worker });
  const view = activityView(key, success, failure);
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
        if (cancelled) return;
        setSuccess({
          key,
          model: activityChartModel(page),
          receivedAt: new Date().toISOString(),
        });
        setFailure(null);
      })
      .catch(() => {
        if (!cancelled) setFailure({ key });
      });
    return () => {
      cancelled = true;
    };
  }, [client, key, filter, period, groupBy, tags, queue, worker, refreshKey, retryCount]);

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
  const retry = () => setRetryCount((count) => count + 1);
  const model = view.kind === "ready" || view.kind === "stale" ? view.model : null;
  const chartData = (model?.buckets ?? []).map((bucket) =>
    Object.assign({ bucket: labelFormat(bucket.bucketStart) }, bucket.values),
  );
  const series = (model?.series ?? []).map(({ id, label, overflow }, index) => ({
    name: id,
    label,
    color: overflow
      ? "gray.5"
      : groupBy === "status"
        ? (activityStatusColors[label] ?? "gray.6")
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
      <ActivityNotice view={view} retry={retry} />
      {model === null ? (
        <ActivityPlaceholder view={view} />
      ) : (
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
          valueFormatter={formatCount}
          // Each poll re-reads this chart's series, and an animated redraw would replay every bar
          // from zero on data the operator was already reading.
          barProps={{ radius: 2, isAnimationActive: false }}
          yAxisProps={{ allowDecimals: false, width: 44 }}
          xAxisProps={{ interval: "preserveStartEnd", minTickGap: 24 }}
        />
      )}
    </Paper>
  );
}

/** Say why the chart is missing or old, and offer to ask again. */
export function ActivityNotice({ view, retry }: { view: ActivityView; retry: () => void }) {
  if (view.kind !== "error" && view.kind !== "stale") return null;
  const message: ReactNode =
    view.kind === "error"
      ? "Workhorse could not load activity for these filters."
      : `Workhorse could not refresh activity. These bars are from ${formatExact(view.receivedAt)}.`;
  return (
    <Alert color={view.kind === "error" ? "red" : "yellow"} mb="sm" role="alert" p="xs">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="sm">{message}</Text>
        <Button size="xs" variant="light" onClick={retry}>
          Retry
        </Button>
      </Group>
    </Alert>
  );
}

/** Hold the chart's height while no result for the current query exists. */
function ActivityPlaceholder({ view }: { view: ActivityView }) {
  return (
    <Center h={320} aria-busy={view.kind === "loading"}>
      {view.kind === "loading" ? (
        <Group gap="xs">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            Loading activity…
          </Text>
        </Group>
      ) : (
        <Text c="dimmed" size="sm">
          No activity to show.
        </Text>
      )}
    </Center>
  );
}
