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
    expect(activityChart).toContain('from "@mantine/charts"');
  });

  it("lets the controller polling clock own activity refreshes", () => {
    expect(activityChart).not.toContain("setInterval");
    expect(activityChart).toContain("refreshKey");
  });

  it("imports only the Mantine component styles used by the shell", () => {
    expect(styles).not.toContain('@import "@mantine/core/styles.css"');
    expect(styles).not.toContain('@import "@mantine/charts/styles.css"');
    expect(styles).toContain('@import "@mantine/core/styles/baseline.css"');
    expect(styles).toContain('@import "@mantine/core/styles/AppShell.css"');
  });
});
