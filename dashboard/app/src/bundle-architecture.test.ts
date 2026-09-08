import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const controller = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");
const taskList = readFileSync(new URL("./components/task-list.tsx", import.meta.url), "utf8");
const activityChart = readFileSync(new URL("./charts/activity.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("dashboard bundle boundaries", () => {
  it("keeps route pages and the activity chart behind dynamic imports", () => {
    expect(controller.match(/lazy\(\(\) =>\s*import\(/g)).toHaveLength(7);
    expect(taskList).not.toContain("@mantine/charts");
    expect(activityChart).toContain('from "recharts"');
  });

  it("lets the controller polling clock own activity refreshes", () => {
    expect(activityChart).not.toContain("setInterval");
    expect(activityChart).toContain("refreshKey");
  });

  it("uses Tailwind and neutral theme tokens without Mantine styles", () => {
    expect(styles).not.toContain("@mantine/");
    expect(styles).toContain('@import "tailwindcss"');
    expect(styles).toMatch(/--color-background:\s*var\(--background\)/);
  });
});
