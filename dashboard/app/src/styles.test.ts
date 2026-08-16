import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("task drawer control alignment", () => {
  it("lowers help controls from the metadata baseline", () => {
    expect(dashboardSource).toMatch(
      /<ActionIcon[^>]*className="task-drawer__help"[^>]*aria-label=\{`\$\{label\}: \$\{help\}`\}/s,
    );
    expect(styles).toMatch(
      /\.task-drawer__content \.task-drawer__help\s*\{[^}]*position:\s*relative;[^}]*top:\s*2px;/s,
    );
  });

  it("removes inline baseline space from durable step loaders", () => {
    expect(styles).toMatch(
      /\.task-drawer__content \.mantine-Stepper-stepLoader\s*\{[^}]*display:\s*block;/s,
    );
  });
});
