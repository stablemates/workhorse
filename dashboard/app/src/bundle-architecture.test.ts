import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build, type Rolldown, type UserConfig } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import dashboardViteConfig from "../vite.config.js";

type OutputChunk = Rolldown.OutputChunk;

const controller = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");
const taskList = readFileSync(new URL("./components/task-list.tsx", import.meta.url), "utf8");
const activityChart = readFileSync(new URL("./charts/activity.tsx", import.meta.url), "utf8");
const tasksPage = readFileSync(new URL("./pages/tasks.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const appShell = readFileSync(new URL("./shell/AppShell.tsx", import.meta.url), "utf8");

describe("dashboard bundle boundaries", () => {
  it("keeps route pages and the activity chart behind dynamic imports", () => {
    expect(controller.match(/lazy\(\(\) =>\s*import\(/g)).toHaveLength(8);
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

/** The npm package that owns a module, or `undefined` for application and virtual modules. */
function packageOf(moduleId: string): string | undefined {
  const match =
    /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/](?!.*[\\/]node_modules[\\/])/.exec(
      moduleId,
    );
  return match?.[1]?.replaceAll("\\", "/");
}

/** The npm packages whose modules a chunk holds. */
function packagesIn(item: OutputChunk): Set<string> {
  return new Set(Object.keys(item.modules).flatMap((id) => packageOf(id) ?? []));
}

const chartOnlyPackages = [
  "@mantine/charts",
  "@reduxjs/toolkit",
  "d3-scale",
  "d3-shape",
  "react-is",
  "react-redux",
  "recharts",
  "redux",
  "victory-vendor",
];

describe("dashboard vendor chunks in the production build", () => {
  let chunks: readonly OutputChunk[] = [];

  beforeAll(async () => {
    // Vite's own config loader imports the workspace packages through Node, which cannot load
    // their TypeScript source. Vitest can, so the test imports the real config and passes it in.
    // Vitest sets NODE_ENV to `test`, which keeps the development branches of React packages.
    // The packaged bundle builds with `production`, so the test does too.
    vi.stubEnv("NODE_ENV", "production");
    const config: UserConfig = dashboardViteConfig;
    const output = (await build({
      ...config,
      configFile: false,
      root: fileURLToPath(new URL("../browser", import.meta.url)),
      logLevel: "silent",
      build: { ...config.build, write: false },
    })) as Rolldown.RolldownOutput;
    chunks = output.output.filter((item): item is OutputChunk => item.type === "chunk");
  }, 120_000);

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const chunk = (name: string): OutputChunk => {
    const found = chunks.filter((item) => item.name === name);
    expect(found, `exactly one ${name} chunk`).toHaveLength(1);
    return found[0]!;
  };
  const eagerClosure = (entry: OutputChunk): Set<string> => {
    const seen = new Set<string>();
    const visit = (fileName: string): void => {
      if (seen.has(fileName)) return;
      seen.add(fileName);
      chunks.find((item) => item.fileName === fileName)?.imports.forEach(visit);
    };
    visit(entry.fileName);
    return seen;
  };

  it("puts React, React DOM, and the scheduler in the react chunk and nowhere else", () => {
    expect([...packagesIn(chunk("react"))].toSorted()).toEqual(["react", "react-dom", "scheduler"]);
    for (const item of chunks.filter((candidate) => candidate.name !== "react")) {
      for (const name of ["react", "react-dom", "scheduler"]) {
        expect(packagesIn(item).has(name), `${item.fileName} holds ${name}`).toBe(false);
      }
    }
  });

  it("keeps each other vendor chunk to its own libraries", () => {
    expect([...packagesIn(chunk("icons"))]).toEqual(["@phosphor-icons/react"]);
    const mantine = packagesIn(chunk("mantine"));
    expect(mantine).toContain("@mantine/core");
    expect(mantine).toContain("@mantine/hooks");
    expect(packagesIn(chunk("notifications"))).toContain("@mantine/notifications");
    for (const name of ["mantine", "icons", "notifications"]) {
      const packages = packagesIn(chunk(name));
      for (const chartPackage of chartOnlyPackages) {
        expect(packages.has(chartPackage), `${name} holds ${chartPackage}`).toBe(false);
      }
    }
  });

  it("keeps chart-only libraries in the chart chunk, outside the eager entry imports", () => {
    const charts = chunk("mantine-charts");
    const chartPackages = packagesIn(charts);
    for (const chartPackage of chartOnlyPackages) expect(chartPackages).toContain(chartPackage);
    for (const item of chunks.filter((candidate) => candidate !== charts)) {
      for (const chartPackage of chartOnlyPackages) {
        expect(packagesIn(item).has(chartPackage), `${item.fileName} holds ${chartPackage}`).toBe(
          false,
        );
      }
    }
    const entries = chunks.filter((item) => item.isEntry);
    expect(entries).toHaveLength(1);
    expect(eagerClosure(entries[0]!).has(charts.fileName)).toBe(false);
  });

  it("keeps application modules out of the vendor chunks", () => {
    for (const name of ["react", "mantine", "icons", "notifications", "mantine-charts"]) {
      const applicationModules = Object.keys(chunk(name).modules).filter(
        (id) => packageOf(id) === undefined,
      );
      expect(applicationModules, `${name} application modules`).toEqual([]);
    }
  });
});
