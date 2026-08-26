import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const controllerSource = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");

describe("sidebar task counts", () => {
  it("loads counts on the task route during initial and background refreshes", () => {
    expect(controllerSource).not.toContain('if (location.route !== "/tasks") void loadTaskCounts');
    expect(controllerSource.match(/void loadTaskCounts\([^;]*\);/g)).toEqual([
      "void loadTaskCounts();",
      "void loadTaskCounts({ background: true });",
    ]);
  });
});
