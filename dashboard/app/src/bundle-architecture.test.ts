import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const controller = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");
const taskList = readFileSync(new URL("./components/task-list.tsx", import.meta.url), "utf8");
const activityChart = readFileSync(new URL("./charts/activity.tsx", import.meta.url), "utf8");
const tasksPage = readFileSync(new URL("./pages/tasks.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const appShell = readFileSync(new URL("./shell/AppShell.tsx", import.meta.url), "utf8");

describe("dashboard bundle boundaries", () => {
  it("keeps route pages and the activity chart behind dynamic imports", () => {
    expect(controller.match(/lazy\(\(\) =>\s*import\(/g)).toHaveLength(7);
    expect(taskList).not.toContain("@mantine/charts");
    expect(activityChart).toContain('from "@mantine/charts"');
  });

  it("fetches the task drawer only once an operator opens one", () => {
    expect(appShell).not.toContain('import { TaskDetailDrawer } from "../pages/task-detail.js"');
    expect(appShell).toMatch(/lazy\(\(\) =>\s*import\("\.\.\/pages\/task-detail\.js"\)/);
    // Mounted on first request and kept, so closing the drawer still animates.
    expect(appShell).toContain(
      "if (selectedTaskId !== null && !taskDrawerRequested) setTaskDrawerRequested(true);",
    );
  });

  it("lets the controller polling clock own activity refreshes", () => {
    expect(activityChart).not.toContain("setInterval");
    expect(activityChart).toContain("refreshKey");
    expect(controller).toContain("setActivityPollTick((tick) => tick + 1)");
    expect(controller).toMatch(
      /setActivityPollTick\(\(tick\) => tick \+ 1\);\s*void refreshEverything\(\);/,
    );
    expect(tasksPage).toContain("refreshKey={activityPollTick}");
    expect(tasksPage).not.toContain("refreshKey={data}");
  });

  it("imports only the Mantine component styles used by the shell", () => {
    expect(styles).not.toContain('@import "@mantine/core/styles.css"');
    expect(styles).not.toContain('@import "@mantine/charts/styles.css"');
    expect(styles).toContain('@import "@mantine/core/styles/default-css-variables.css"');
    expect(styles).toContain('@import "@mantine/core/styles/baseline.css"');
    expect(styles).toContain('@import "@mantine/core/styles/AppShell.css"');
  });

  it("loads Mantine base component styles before the components that extend them", () => {
    expect(styles).toContain('@import "@mantine/core/styles/UnstyledButton.css"');
    const unstyledButtonImportIndex = styles.indexOf(
      '@import "@mantine/core/styles/UnstyledButton.css"',
    );

    for (const component of ["Button", "NavLink"]) {
      expect(unstyledButtonImportIndex).toBeLessThan(
        styles.indexOf(`@import "@mantine/core/styles/${component}.css"`),
      );
    }
  });
});
