import { describe, expect, it } from "vitest";
import {
  activityStatusColors,
  categoricalSeriesColors,
  chartColorVariables,
  overflowSeriesColor,
} from "./palette.js";

function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrast(left: string, right: string): number {
  const light = Math.max(luminance(left), luminance(right));
  const dark = Math.min(luminance(left), luminance(right));
  return (light + 0.05) / (dark + 0.05);
}

/** The chart panels: `neutral-2` of each color scheme. */
const panels = { light: "#fbfbfb", dark: "#202020" } as const;

describe("chart palette", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`gives every ${mode} series at least 3:1 on the ${mode} panel`, () => {
      const colors = [
        ...categoricalSeriesColors[mode],
        overflowSeriesColor[mode],
        ...Object.values(activityStatusColors[mode]),
      ];
      const failing = colors.filter((color) => contrast(color, panels[mode]) < 3);
      expect(failing).toEqual([]);
    });
  }

  it("writes a variable for each slot, the overflow series, and each task state", () => {
    const variables = chartColorVariables("dark");
    expect(variables["--workhorse-series-1"]).toBe(categoricalSeriesColors.dark[0]);
    expect(variables["--workhorse-series-other"]).toBe(overflowSeriesColor.dark);
    expect(variables["--workhorse-chart-failed"]).toBe(activityStatusColors.dark.failed);
    expect(variables["--workhorse-chart-retry"]).toBe(activityStatusColors.dark.blocked);
  });
});
