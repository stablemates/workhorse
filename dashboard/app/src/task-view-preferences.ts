import { readStoredValue, storeValue } from "./browser-storage.js";

export const taskChartVisibilityKey = "workhorse-task-chart-visible";
export const taskDrawerWidthKey = "workhorse-task-drawer-width";
export const defaultTaskDrawerWidth = 780;

export function readTaskChartVisibility(): boolean {
  return readStoredValue(taskChartVisibilityKey) !== "false";
}

export function saveTaskChartVisibility(visible: boolean): void {
  storeValue(taskChartVisibilityKey, String(visible));
}

export function readTaskDrawerWidth(): number {
  const value = Number(readStoredValue(taskDrawerWidthKey));
  return Number.isFinite(value) && value >= 420 ? value : defaultTaskDrawerWidth;
}

export function saveTaskDrawerWidth(width: number): void {
  storeValue(taskDrawerWidthKey, String(Math.round(width)));
}

export function taskDrawerWidthBounds(viewportWidth: number): { min: number; max: number } {
  const max = Math.max(0, viewportWidth - 48);
  return { min: Math.min(420, max), max };
}

export function clampTaskDrawerWidth(width: number, viewportWidth: number): number {
  const { min, max } = taskDrawerWidthBounds(viewportWidth);
  return Math.min(max, Math.max(min, width));
}
