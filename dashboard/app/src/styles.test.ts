import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(
  new URL("./components/help-button.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const drawerStyles = readFileSync(new URL("./components/task-drawer.css", import.meta.url), "utf8");
const taskDetailStyles = readFileSync(new URL("./pages/task-detail.css", import.meta.url), "utf8");

describe("task drawer control alignment", () => {
  it("lowers help controls from the metadata baseline", () => {
    expect(dashboardSource).toMatch(
      /<ActionIcon[^>]*className="task-drawer__help"[^>]*aria-label=\{`\$\{label\}: \$\{help\}`\}/s,
    );
    expect(drawerStyles).toMatch(
      /\.task-drawer__content \.task-drawer__meta-value \.task-drawer__help\s*\{[^}]*position:\s*relative;[^}]*top:\s*3px;/s,
    );
  });

  it("removes inline baseline space from durable step loaders", () => {
    expect(styles).toMatch(
      /\.task-drawer__content \.mantine-Stepper-stepLoader\s*\{[^}]*display:\s*block;/s,
    );
  });

  it("keeps the compact task panel scale above the shared drawer scale", () => {
    // `styles.css` imports the task detail sheet before its own `.task-drawer__content` rule, so
    // the compact rule must win by specificity. Both rules set the same text variables.
    const compactScale =
      /(^|\n)\.task-drawer__content\.task-drawer__content--task\s*\{[^}]*--mantine-font-size-sm:\s*0\.8125rem;/;
    expect(taskDetailStyles).toMatch(compactScale);
    expect(taskDetailStyles).not.toMatch(/(^|\n)\.task-drawer__content--task\s*\{/);
    expect(styles).toMatch(/(^|\n)\.task-drawer__content\s*\{[^}]*--mantine-font-size-sm:/);
    expect(styles.indexOf('@import "./pages/task-detail.css";')).toBeLessThan(
      styles.search(/(^|\n)\.task-drawer__content\s*\{/),
    );
  });
});
