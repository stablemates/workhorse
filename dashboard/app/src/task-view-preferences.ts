export const taskChartVisibilityKey = "workhorse-task-chart-visible";
export const taskDrawerWidthKey = "workhorse-task-drawer-width";
export const defaultTaskDrawerWidth = 780;

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The current view still works when the browser disallows persistence.
  }
}

export function readTaskChartVisibility(): boolean {
  return readPreference(taskChartVisibilityKey) !== "false";
}

export function saveTaskChartVisibility(visible: boolean): void {
  savePreference(taskChartVisibilityKey, String(visible));
}

export function readTaskDrawerWidth(): number {
  const value = Number(readPreference(taskDrawerWidthKey));
  return Number.isFinite(value) && value >= 420 ? value : defaultTaskDrawerWidth;
}

export function saveTaskDrawerWidth(width: number): void {
  savePreference(taskDrawerWidthKey, String(Math.round(width)));
}

export function taskDrawerWidthBounds(viewportWidth: number): { min: number; max: number } {
  const max = Math.max(0, viewportWidth - 48);
  return { min: Math.min(420, max), max };
}

export function clampTaskDrawerWidth(width: number, viewportWidth: number): number {
  const { min, max } = taskDrawerWidthBounds(viewportWidth);
  return Math.min(max, Math.max(min, width));
}
