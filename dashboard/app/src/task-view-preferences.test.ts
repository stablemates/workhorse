import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampTaskDrawerWidth,
  defaultTaskDrawerWidth,
  readTaskChartVisibility,
  readTaskDrawerWidth,
  saveTaskChartVisibility,
  saveTaskDrawerWidth,
  taskChartVisibilityKey,
  taskDrawerWidthKey,
} from "./task-view-preferences.js";

afterEach(() => vi.unstubAllGlobals());

describe("task view preferences", () => {
  it("remembers chart visibility and drawer width independently", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    expect(readTaskChartVisibility()).toBe(true);
    expect(readTaskDrawerWidth()).toBe(defaultTaskDrawerWidth);
    saveTaskChartVisibility(false);
    saveTaskDrawerWidth(915.4);
    expect(readTaskChartVisibility()).toBe(false);
    expect(readTaskDrawerWidth()).toBe(915);
    saveTaskChartVisibility(true);
    expect(values.get(taskChartVisibilityKey)).toBe("true");
    expect(values.get(taskDrawerWidthKey)).toBe("915");
  });

  it.each([null, "", "broken", "NaN", "Infinity", "-1", "200"])(
    "ignores an invalid saved drawer width: %s",
    (value) => {
      vi.stubGlobal("localStorage", { getItem: () => value });
      expect(readTaskDrawerWidth()).toBe(defaultTaskDrawerWidth);
    },
  );

  it("keeps controls usable when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Storage denied");
      },
      setItem: () => {
        throw new Error("Storage denied");
      },
    });
    expect(readTaskChartVisibility()).toBe(true);
    expect(readTaskDrawerWidth()).toBe(defaultTaskDrawerWidth);
    expect(() => saveTaskChartVisibility(false)).not.toThrow();
    expect(() => saveTaskDrawerWidth(900)).not.toThrow();
  });

  it("constrains the drawer to its viewport without overwriting the preferred width", () => {
    expect(clampTaskDrawerWidth(900, 800)).toBe(752);
    expect(clampTaskDrawerWidth(900, 1400)).toBe(900);
    expect(clampTaskDrawerWidth(100, 1400)).toBe(420);
    expect(clampTaskDrawerWidth(900, 360)).toBe(312);
  });
});
