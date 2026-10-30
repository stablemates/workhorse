import { useReducedMotion } from "@mantine/hooks";
import { useEffect, useState } from "react";

/**
 * How long a chart takes to move from one answer to the next.
 *
 * The operator changed a control and watches the bars, so the move is short. A strong ease-out
 * starts fast, which makes the chart feel like it follows the click.
 */
export const chartTransitionMs = 280;
export const chartTransitionEasing = "cubic-bezier(0.23,1,0.32,1)";

/** How a Recharts series animates. */
export interface ChartSeriesAnimation {
  isAnimationActive: boolean;
  animationDuration: number;
  animationEasing: typeof chartTransitionEasing;
}

/**
 * The animation of each chart series.
 *
 * The first paint does not animate, because the bars are not a reveal. Each later answer moves
 * the bars from their previous size to the new one: Recharts matches a bar by its series and its
 * position. With reduced motion the chart swaps to the new answer at once.
 */
export function useChartSeriesAnimation(): ChartSeriesAnimation {
  const reducedMotion = useReducedMotion();
  const [painted, setPainted] = useState(false);
  useEffect(() => setPainted(true), []);
  return {
    isAnimationActive: painted && !reducedMotion,
    animationDuration: chartTransitionMs,
    animationEasing: chartTransitionEasing,
  };
}
