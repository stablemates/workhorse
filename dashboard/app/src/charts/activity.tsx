import type { DashboardTaskFilter } from "@stablemates/workhorse-dashboard-server/wire";
import { BarChart } from "@mantine/charts";
import { Alert, Button, Center, Group, Loader, Paper, SegmentedControl, Text } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  Rectangle,
  matchByDataKey,
  type BarProps,
  type BarShapeProps,
  type TooltipContentProps,
} from "recharts";
import {
  type ActivityGroupBy,
  type ActivityPeriod,
  activityGroupings,
  activityPeriods,
  useDashboardClient,
} from "../core.js";
import { activityChartModel, type ActivityChartModel } from "../presentation-policy.js";
import { displayTimeZone, formatExact, getDateTimeFormatter } from "../preferences.js";
import { storeValue } from "../browser-storage.js";
import { formatCount } from "../count-format.js";
import type { TaskLocationState } from "../task-location.js";
import { createPageCache } from "../page-cache.js";
import { createRefreshRequests } from "../refresh-requests.js";
import { DashboardMutationFeedContext } from "../mutation-observer.js";
import { PendingResults } from "../pending-results.js";
import {
  activityStatusColor,
  activityStatusOrder,
  categoricalSeriesColor,
  categoricalSeriesColors,
  overflowSeriesVariable,
  type ActivityStatus,
} from "./palette.js";
import { ChartTooltip, chartRow, isTopOfStack } from "./chart-tooltip.js";
import {
  chartTransitionMs,
  useChartSeriesAnimation,
  type ChartSeriesAnimation,
} from "./chart-motion.js";

/** The parameters of one activity query. */
interface ActivityQuery {
  filter: DashboardTaskFilter;
  period: ActivityPeriod;
  groupBy: ActivityGroupBy;
  tags: readonly string[];
  queue: string | null;
  worker: string | null;
}

/** The newest activity a query produced, keyed by that query. */
export interface ActivitySuccess {
  key: string;
  /** The period and grouping of this answer. The axis labels and series colors read them. */
  period: ActivityPeriod;
  groupBy: ActivityGroupBy;
  model: ActivityChartModel;
  /** When the browser received this result, for the stale notice. */
  receivedAt: string;
}

/** The newest failed request, keyed by the query it asked. */
export interface ActivityFailure {
  key: string;
}

/**
 * What the chart shows.
 *
 * `ready` with `pending` keeps the bars of the previous query on screen while the controls name a
 * new one. The bars dim and are busy, and the new answer moves them to their new values.
 */
export type ActivityView =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; shown: ActivitySuccess; pending: boolean }
  | { kind: "stale"; shown: ActivitySuccess };

/**
 * What the chart may show for the query its controls name.
 *
 * `shown` is the newest answer that the chart has: the answer for this query if it exists, or the
 * answer for the previous query. Until the new answer arrives, the previous bars stay on screen as
 * pending, so a click on a period or a grouping never replaces the chart with a loader. A failed
 * refresh of the same query keeps its bars and says they are stale. A failed load of a new query
 * shows the error, because the previous bars do not answer it.
 */
export function activityView(
  key: string,
  shown: ActivitySuccess | null,
  failure: ActivityFailure | null,
): ActivityView {
  const failed = failure?.key === key;
  if (shown === null) return failed ? { kind: "error" } : { kind: "loading" };
  if (shown.key !== key)
    return failed ? { kind: "error" } : { kind: "ready", shown, pending: true };
  return failed ? { kind: "stale", shown } : { kind: "ready", shown, pending: false };
}

/** Identify one activity query, so a result can be matched to the controls that asked for it. */
export function activityQueryKey(query: ActivityQuery): string {
  return JSON.stringify([
    query.filter,
    query.period,
    query.groupBy,
    query.tags,
    query.queue,
    query.worker,
  ]);
}

/**
 * The chart key of one series: the grouping and the label, the same for every answer.
 *
 * Recharts matches a bar to its previous bar by this key, so a series that stays keeps its bars
 * and moves them. The label is encoded, because Recharts reads a dot in a key as a path.
 */
export function activitySeriesKey(
  groupBy: ActivityGroupBy,
  series: { label: string; overflow: boolean },
): string {
  if (series.overflow) return `${groupBy}#other`;
  return `${groupBy}:${encodeURIComponent(series.label).replaceAll(".", "%2E")}`;
}

/**
 * Keep the palette slot of each series across answers.
 *
 * A series keeps the slot it had before, if no other series on screen holds it. A new series takes
 * the lowest free slot. With no memory, the slots follow the sorted order of the series. The
 * function returns `memory` itself when nothing changes, so the caller can skip a state update.
 */
export function rememberSeriesSlots(
  memory: ReadonlyMap<string, number>,
  keys: readonly string[],
  slotCount: number = categoricalSeriesColors.light.length,
): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  const taken = new Set<number>();
  for (const key of keys) {
    const slot = memory.get(key);
    if (slot !== undefined && !taken.has(slot)) {
      slots.set(key, slot);
      taken.add(slot);
    }
  }
  for (const key of keys) {
    if (slots.has(key)) continue;
    let slot = 0;
    while (taken.has(slot) && slot < slotCount) slot += 1;
    slots.set(key, slot);
    taken.add(slot);
  }
  if ([...slots].every(([key, slot]) => memory.get(key) === slot)) return memory;
  return new Map([...memory, ...slots]);
}

/** The series that left between two answers, which fade out while their bars shrink. */
export function leavingActivitySeries(
  previous: readonly PresentedActivitySeries[],
  next: readonly PresentedActivitySeries[],
): PresentedActivitySeries[] {
  const nextIds = new Set(next.map(({ id }) => id));
  return previous.filter(({ id }) => !nextIds.has(id));
}

/** Recharts pairs a bar with the bar of the previous answer that starts at the same time. */
const matchBucketStart = matchByDataKey("bucketStart");

/**
 * Move the bars of a stack from one answer to the next.
 *
 * A bar that both answers hold moves and resizes. A bar that only the new answer holds grows up
 * from the baseline of its stack, and a bar that only the previous answer holds sinks into it. A
 * whole stack therefore rises or sinks as one, and its segments never float apart.
 */
export const interpolateStackedBars: NonNullable<BarProps["animationInterpolateFn"]> = (
  items,
  progress,
  layout,
) => {
  if (items === null) return [];
  const mix = (from: number, to: number) => from + (to - from) * progress;
  const vertical = layout === "horizontal";
  return items.flatMap((item) => {
    switch (item.status) {
      case "matched":
        return [
          {
            ...item.next,
            x: mix(item.prev.x, item.next.x),
            y: mix(item.prev.y, item.next.y),
            width: mix(item.prev.width, item.next.width),
            height: mix(item.prev.height, item.next.height),
          },
        ];
      case "added": {
        const { next } = item;
        return [
          vertical
            ? { ...next, y: mix(next.stackedBarStart, next.y), height: mix(0, next.height) }
            : { ...next, x: mix(next.stackedBarStart, next.x), width: mix(0, next.width) },
        ];
      }
      case "removed": {
        if (progress >= 1) return [];
        const { prev } = item;
        return [
          vertical
            ? { ...prev, y: mix(prev.y, prev.stackedBarStart), height: mix(prev.height, 0) }
            : { ...prev, x: mix(prev.x, prev.stackedBarStart), width: mix(prev.width, 0) },
        ];
      }
      default: {
        const exhaustive: never = item;
        return exhaustive;
      }
    }
  });
};

/** How long a cached or prefetched answer counts as fresh, so a click shows it without a read. */
const activityFreshMs = 5_000;
/** The hover time before an option prefetches its answer, so a pointer that passes reads nothing. */
const prefetchHoverMs = 80;

function isActivityPeriod(value: string): value is ActivityPeriod {
  return (activityPeriods as readonly string[]).includes(value);
}

function isActivityGroupBy(value: string): value is ActivityGroupBy {
  return activityGroupings.some((grouping) => grouping.value === value);
}

/** The option of a segmented control under an event target, read from its radio input. */
function segmentedOption(target: EventTarget): string | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest(".mantine-SegmentedControl-control");
  return control?.querySelector("input")?.value ?? null;
}

/**
 * The option that keyboard focus reached, or null for focus that a pointer click gave. A pointer
 * already prefetched the option it points at, so only the keyboard reads the adjacent options.
 */
function keyboardFocusedOption(target: EventTarget): string | null {
  return target instanceof Element && target.matches(":focus-visible")
    ? segmentedOption(target)
    : null;
}

/** The options next to `value`, which the operator is most likely to choose next. */
function adjacentValues<T>(values: readonly T[], value: T): T[] {
  const index = values.indexOf(value);
  return [values[index - 1], values[index + 1]].filter((one): one is T => one !== undefined);
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
  const mutations = useContext(DashboardMutationFeedContext);
  /** The answers of this chart, so a period or grouping that was seen or prefetched shows at once. */
  const cache = useMemo(() => createPageCache<ActivitySuccess>(24), [client]);
  const requests = useMemo(() => createRefreshRequests(), [client]);
  // A mutation can change every count, so the chart forgets its answers, as the page cache does.
  useEffect(
    () =>
      mutations?.subscribe(() => {
        cache.invalidate();
        requests.forget();
      }),
    [mutations, cache, requests],
  );
  const [success, setSuccess] = useState<ActivitySuccess | null>(null);
  const [failure, setFailure] = useState<ActivityFailure | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const query: ActivityQuery = { filter, period, groupBy, tags, queue, worker };
  const key = activityQueryKey(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const shown = success?.key === key ? success : (cache.read(key)?.data ?? success);
  const view = activityView(key, shown, failure);

  /** Read one query and keep its answer. The cache drops an answer that a mutation made old. */
  const readActivity = (next: ActivityQuery): Promise<ActivitySuccess> => {
    const nextKey = activityQueryKey(next);
    const generation = cache.generation();
    return requests
      .run(nextKey, () =>
        client.activity({ ...next, tags: [...next.tags] }).then((page) => ({
          key: nextKey,
          period: next.period,
          groupBy: next.groupBy,
          model: activityChartModel(page),
          receivedAt: new Date().toISOString(),
        })),
      )
      .then((answer) => {
        cache.write(nextKey, answer, generation);
        return answer;
      });
  };
  const readActivityRef = useRef(readActivity);
  readActivityRef.current = readActivity;

  /** The poll and retry counts of the last read, to tell a new query from a refresh. */
  const lastRead = useRef<{ refreshKey: number; retryCount: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh =
      lastRead.current === null ||
      lastRead.current.refreshKey !== refreshKey ||
      lastRead.current.retryCount !== retryCount;
    lastRead.current = { refreshKey, retryCount };
    // A period that a hover prefetched a moment ago shows its answer already.
    const fresh = cache.read(key);
    if (!refresh && fresh !== null && cache.holdsFresh(key, activityFreshMs)) {
      setSuccess(fresh.data);
      setFailure(null);
      return;
    }
    void readActivityRef
      .current(queryRef.current)
      .then((answer) => {
        if (cancelled) return;
        setSuccess(answer);
        setFailure(null);
      })
      .catch(() => {
        if (!cancelled) setFailure({ key });
      });
    return () => {
      cancelled = true;
    };
  }, [cache, key, refreshKey, retryCount]);

  /**
   * Read the answer for a period or a grouping the operator points at, so a click shows it at once.
   * A query that is fresh in the cache or already in flight is not read again.
   */
  const prefetch = (change: Partial<Pick<ActivityQuery, "period" | "groupBy">>) => {
    const next = { ...query, ...change };
    const nextKey = activityQueryKey(next);
    if (nextKey === key || cache.holdsFresh(nextKey, activityFreshMs) || requests.has(nextKey)) {
      return;
    }
    void readActivity(next).catch(() => undefined);
  };
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    },
    [],
  );
  const prefetchOn = (change: (value: string) => Parameters<typeof prefetch>[0] | null) => ({
    onPointerOver: (event: PointerEvent<HTMLDivElement>) => {
      const value = segmentedOption(event.target);
      const next = value === null ? null : change(value);
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
      if (next === null) return;
      hoverTimer.current = setTimeout(() => prefetch(next), prefetchHoverMs);
    },
    onPointerLeave: () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    },
  });
  const periodPrefetch = prefetchOn((value) =>
    isActivityPeriod(value) ? { period: value } : null,
  );
  const groupPrefetch = prefetchOn((value) =>
    isActivityGroupBy(value) ? { groupBy: value } : null,
  );

  const changePeriod = (value: string) => {
    const next = isActivityPeriod(value) ? value : "1h";
    storeValue("workhorse-activity-period", next);
    updateLocation({ period: next });
  };
  const changeGroupBy = (value: string) => {
    const next = isActivityGroupBy(value) ? value : "task";
    storeValue("workhorse-activity-group", next);
    updateLocation({ group: next });
  };

  const retry = () => setRetryCount((count) => count + 1);
  const groupingValues = activityGroupings.map(({ value }) => value);

  return (
    <Paper p="md" className="panel">
      <Group justify="space-between" mb="sm" gap="xs">
        <Text fw={600} size="sm">
          Activity
          <Text span c="dimmed" size="sm">
            {" "}
            · {filter === "all" ? "all tasks" : filter}
          </Text>
        </Text>
        <Group gap="xs">
          {/* The indicator moves on the click, because the value is the location. The chart
              follows when the answer arrives. Pointing at an option or focusing the control
              reads the nearest answers ahead of the click. */}
          <SegmentedControl
            size="xs"
            aria-label="Group activity by"
            value={groupBy}
            onChange={changeGroupBy}
            data={activityGroupings}
            {...groupPrefetch}
            onFocus={(event: FocusEvent<HTMLDivElement>) => {
              const value = keyboardFocusedOption(event.target);
              if (value === null || !isActivityGroupBy(value)) return;
              for (const one of adjacentValues(groupingValues, value)) prefetch({ groupBy: one });
            }}
          />
          <SegmentedControl
            size="xs"
            aria-label="Activity period"
            value={period}
            onChange={changePeriod}
            data={activityPeriods.map((value) => ({ value, label: value }))}
            {...periodPrefetch}
            onFocus={(event: FocusEvent<HTMLDivElement>) => {
              const value = keyboardFocusedOption(event.target);
              if (value === null || !isActivityPeriod(value)) return;
              for (const one of adjacentValues(activityPeriods, value)) prefetch({ period: one });
            }}
          />
        </Group>
      </Group>
      <ActivityNotice view={view} retry={retry} />
      <ActivityBody view={view} />
    </Paper>
  );
}

/**
 * The chart, or a placeholder of the same height before the first answer.
 *
 * While a new query loads, the previous bars stay mounted, dimmed and busy. No loader replaces
 * them, so the panel keeps its size and the new answer can move the bars.
 */
export function ActivityBody({ view }: { view: ActivityView }) {
  if (view.kind === "loading" || view.kind === "error") return <ActivityPlaceholder view={view} />;
  return (
    <PendingResults pending={view.kind === "ready" && view.pending}>
      <ActivityFigure shown={view.shown} />
    </PendingResults>
  );
}

/** One answer as the chart draws it: its legend, and the series of its stack. */
interface ActivityFrame {
  shown: ActivitySuccess;
  legend: PresentedActivitySeries[];
}

/**
 * The legend and the bars of one answer, and the move from the previous answer to it.
 *
 * - A refresh or a new period moves each bar from its previous height. Recharts matches a bar by
 *   its series and its bucket start, so a bucket that both answers hold slides to its new place.
 *   A bucket that only one answer holds grows or shrinks in place.
 * - A series that joins fades in. A series that leaves stays in the stack for one transition with
 *   no count, so its bars shrink and fade out, and then it goes.
 * - A new grouping divides the same tasks in another way, so each bar keeps its total height.
 *   The new chart is drawn at once, and a copy of the previous chart fades out above it.
 *
 * With reduced motion the chart swaps at once.
 */
function ActivityFigure({ shown }: { shown: ActivitySuccess }) {
  const reducedMotion = useReducedMotion();
  const animation = useChartSeriesAnimation();
  const [slotMemory, setSlotMemory] = useState<ReadonlyMap<string, number>>(() => new Map());
  const namedKeys = shown.model.series
    .filter(({ overflow }) => !overflow)
    .map((series) => activitySeriesKey(shown.groupBy, series));
  const slots = rememberSeriesSlots(slotMemory, namedKeys);
  if (slots !== slotMemory) setSlotMemory(slots);
  const legend = presentActivitySeries(shown.model, shown.groupBy, slots);

  // The previous answer, the series that left it, and the chart that fades out after a regrouping.
  const [previous, setPrevious] = useState<ActivityFrame>({ shown, legend });
  const [leaving, setLeaving] = useState<PresentedActivitySeries[]>([]);
  const [outgoing, setOutgoing] = useState<ActivityFrame | null>(null);
  if (previous.shown !== shown) {
    setPrevious({ shown, legend });
    if (reducedMotion) {
      setLeaving([]);
      setOutgoing(null);
    } else if (previous.shown.groupBy !== shown.groupBy) {
      setLeaving([]);
      setOutgoing(previous);
    } else {
      const stillLeaving = leaving.filter(({ id }) => !legend.some((one) => one.id === id));
      const left = leavingActivitySeries(previous.legend, legend).filter(
        ({ id }) => !stillLeaving.some((one) => one.id === id),
      );
      setLeaving([...stillLeaving, ...left]);
    }
  }
  useEffect(() => {
    if (leaving.length === 0 && outgoing === null) return;
    const timer = setTimeout(() => {
      setLeaving([]);
      setOutgoing(null);
    }, chartTransitionMs + 40);
    return () => clearTimeout(timer);
  }, [leaving, outgoing]);

  const groupingLabel =
    activityGroupings.find(({ value }) => value === shown.groupBy)?.label.toLowerCase() ??
    shown.groupBy;

  return (
    <figure
      className={
        outgoing === null
          ? "activity-chart-figure chart-motion"
          : "activity-chart-figure chart-motion activity-chart-figure--dissolve"
      }
      aria-label={`Task activity by ${groupingLabel} over the last ${shown.period}`}
    >
      <ActivityPlot
        frame={{ shown, legend }}
        leaving={leaving}
        // Under a fading copy, the new bars are drawn at their full height at once.
        animation={outgoing === null ? animation : { ...animation, isAnimationActive: false }}
      />
      {outgoing === null ? null : (
        <div
          key={`${outgoing.shown.key}:${outgoing.shown.receivedAt}`}
          className="activity-chart__outgoing"
          aria-hidden
          inert
        >
          <ActivityPlot
            frame={outgoing}
            leaving={[]}
            animation={{ ...animation, isAnimationActive: false }}
          />
        </div>
      )}
    </figure>
  );
}

/** The legend and the stacked bars of one answer. */
function ActivityPlot({
  frame: { shown, legend },
  leaving,
  animation,
}: {
  frame: ActivityFrame;
  leaving: readonly PresentedActivitySeries[];
  animation: ChartSeriesAnimation;
}) {
  const keyOf = new Map(
    shown.model.series.map((series) => [series.id, activitySeriesKey(shown.groupBy, series)]),
  );
  const leavingIds = new Set(leaving.map(({ id }) => id));
  const chartData = shown.model.buckets.map((bucket) => {
    const row: Record<string, string | number> = {
      bucket: formatBucketLabel(bucket.bucketStart, shown.period),
      bucketStart: bucket.bucketStart,
    };
    for (const { id } of leaving) row[id] = 0;
    for (const [id, value] of Object.entries(bucket.values)) {
      const seriesKey = keyOf.get(id);
      if (seriesKey !== undefined) row[seriesKey] = value;
    }
    return row;
  });
  // Recharts stacks the first series at the baseline, and the legend lists the top segment first.
  // A series that leaves sits at the baseline, so the series that join grow over it.
  // oxlint-disable-next-line unicorn/no-array-reverse -- ES2022 lacks Array.prototype.toReversed.
  const stack = [...leaving, ...[...legend].reverse()];
  const stackIds = stack.map(({ id }) => id);

  return (
    <div className="activity-chart">
      {/* Another query, such as another status view, draws a new legend in place. A kept item that
          moved to a new row read as a jump. A refresh of the same query keeps every item. */}
      <ActivityLegend key={shown.key} series={legend} />
      <BarChart
        className="activity-chart__plot"
        h={320}
        data={chartData}
        dataKey="bucket"
        type="stacked"
        series={stack.map(({ id, color }) => ({ name: id, color }))}
        gridAxis="xy"
        tickLine="y"
        withYAxis
        withTooltip
        tooltipAnimationDuration={0}
        tooltipProps={{
          offset: 16,
          cursor: { fill: "var(--workhorse-neutral-3)", stroke: "none" },
          wrapperStyle: { zIndex: 3, pointerEvents: "none" },
          content: ({ active, payload }: TooltipContentProps<number, string>) => {
            const values = chartRow(payload?.[0]?.payload);
            const start = values.get("bucketStart");
            return active && values.size > 0 ? (
              <ChartTooltip
                title={typeof start === "string" ? formatBucketStart(start) : null}
                values={values}
                series={legend}
                unit={{ one: "task", other: "tasks" }}
              />
            ) : null;
          },
        }}
        valueFormatter={formatCount}
        // A new answer moves each bar from its previous height, so a poll changes only the bars
        // whose counts changed, and a new period moves the buckets that both periods hold.
        barProps={(item) => ({
          ...animation,
          animationMatchBy: matchBucketStart,
          animationInterpolateFn: interpolateStackedBars,
          className: leavingIds.has(item.name)
            ? "chart-series chart-series--leaving"
            : "chart-series",
          shape: (props: BarShapeProps) => (
            <Rectangle
              {...props}
              radius={isTopOfStack(props.payload, item.name, stackIds) ? [3, 3, 0, 0] : 0}
            />
          ),
        })}
        yAxisProps={{ allowDecimals: false, width: 44 }}
        xAxisProps={{ interval: "preserveStartEnd", minTickGap: 24 }}
      />
    </div>
  );
}

/** One series as the legend and the tooltip show it. */
export interface PresentedActivitySeries {
  id: string;
  label: string;
  color: string;
  total: number;
}

function isActivityStatus(label: string): label is ActivityStatus {
  return (activityStatusOrder as readonly string[]).includes(label);
}

/**
 * Give each series its chart key, color, and total, in legend order: the top segment of a bar
 * first.
 *
 * A task state has its semantic color, and the states keep one fixed order. Other groups take the
 * palette slots in `slots`, keyed by `activitySeriesKey`. Without `slots`, they take the slots in
 * the order of their sorted labels, which the model gives. "Other" is gray and sits at the
 * baseline.
 */
export function presentActivitySeries(
  model: ActivityChartModel,
  groupBy: ActivityGroupBy,
  slots: ReadonlyMap<string, number> = new Map(),
): PresentedActivitySeries[] {
  const total = (id: string) =>
    model.buckets.reduce((sum, bucket) => sum + (bucket.values[id] ?? 0), 0);
  if (groupBy === "status") {
    // An unknown state goes on top, above the known states.
    const rank = (label: string) =>
      isActivityStatus(label) ? activityStatusOrder.indexOf(label) : activityStatusOrder.length;
    return (
      model.series
        .map((series) => ({
          id: activitySeriesKey(groupBy, series),
          label: series.label,
          color: isActivityStatus(series.label)
            ? activityStatusColor(series.label)
            : overflowSeriesVariable,
          total: total(series.id),
        }))
        // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
        .sort((left, right) => rank(right.label) - rank(left.label))
    );
  }
  return model.series.map((series, index) => {
    const id = activitySeriesKey(groupBy, series);
    return {
      id,
      label: series.label,
      color: series.overflow
        ? overflowSeriesVariable
        : categoricalSeriesColor(slots.get(id) ?? index),
      total: total(series.id),
    };
  });
}

/** Series names in the text color, a color square, and the total of each series. */
function ActivityLegend({ series }: { series: readonly PresentedActivitySeries[] }) {
  return (
    <ul className="activity-chart__legend" aria-label="Series totals">
      {series.map(({ id, label, color, total }) => (
        <li key={id} className="chart-key">
          <span className="chart-key__swatch" style={{ background: color }} aria-hidden />
          <span className="chart-key__label" title={label}>
            {label}
          </span>
          <span className="chart-key__count">{formatCount(total)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The axis label of a bucket. A long period names the day, and a short one names the minute. */
function formatBucketLabel(value: string, period: ActivityPeriod): string {
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
}

function formatBucketStart(value: string): string {
  return getDateTimeFormatter({
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: displayTimeZone ?? undefined,
  }).format(new Date(value));
}

/** Say why the chart is missing or old, and offer to ask again. */
export function ActivityNotice({ view, retry }: { view: ActivityView; retry: () => void }) {
  if (view.kind !== "error" && view.kind !== "stale") return null;
  const message: ReactNode =
    view.kind === "error"
      ? "Workhorse could not load activity for these filters."
      : `Workhorse could not refresh activity. These bars are from ${formatExact(view.shown.receivedAt)}.`;
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

/** Hold the chart's height while no result exists yet. */
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
