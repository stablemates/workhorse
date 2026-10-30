import type { ReactNode } from "react";
import { formatCount } from "../count-format.js";

/** One series of a chart, with the color its marks use. */
export interface ChartTooltipSeries {
  id: string;
  label: string;
  color: string;
}

/** The fields of one chart data row, read without trusting the shape Recharts passes back. */
export function chartRow(row: unknown): Map<string, unknown> {
  return new Map(typeof row === "object" && row !== null ? Object.entries(row) : []);
}

/**
 * True when no series above `dataKey` has a count in this row. Only that segment of a stacked bar
 * gets round corners: round corners on every segment cut notches, and the bar reads as stripes.
 */
export function isTopOfStack(row: unknown, dataKey: string, stackIds: readonly string[]): boolean {
  const values = chartRow(row);
  const index = stackIds.indexOf(dataKey);
  return stackIds.slice(index + 1).every((id) => !(Number(values.get(id)) > 0));
}

/**
 * The bucket under the pointer: a time header and the total, then each series with a count in
 * the bucket, largest first. A series with no count stays out of the list, so a busy chart gives a
 * short tooltip.
 *
 * The tooltip is a polite live region. When the arrow keys select another bucket, a screen reader
 * reads the whole new bucket one time. The swatches are hidden from it, so each row reads as its
 * label and its count. Recharts adds no live region of its own around custom content.
 */
export function ChartTooltip({
  title,
  values,
  series,
  unit,
  footer,
}: {
  title: string | null;
  values: ReadonlyMap<string, unknown>;
  series: readonly ChartTooltipSeries[];
  /** The noun for the total, singular and plural. */
  unit: { one: string; other: string };
  /** A measure that is not part of the total, such as a line drawn over the bars. */
  footer?: ReactNode;
}) {
  const rows = series
    .map((item) => ({ ...item, count: Number(values.get(item.id)) || 0 }))
    .filter(({ count }) => count > 0)
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  const total = rows.reduce((sum, { count }) => sum + count, 0);
  return (
    <div className="chart-tooltip" role="status" aria-live="polite" aria-atomic="true">
      <div className="chart-tooltip__header">
        <span>{title}</span>
        <span className="chart-tooltip__number">
          {formatCount(total)} {total === 1 ? unit.one : unit.other}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="chart-tooltip__empty">None in this interval</div>
      ) : (
        <ul className="chart-tooltip__rows">
          {rows.map(({ id, label, color, count }) => (
            <li key={id} className="chart-key">
              <span className="chart-key__swatch" style={{ background: color }} aria-hidden />
              <span className="chart-key__label">{label}</span>
              <span className="chart-key__count">{formatCount(count)}</span>
            </li>
          ))}
        </ul>
      )}
      {footer === undefined ? null : <div className="chart-tooltip__footer">{footer}</div>}
    </div>
  );
}
