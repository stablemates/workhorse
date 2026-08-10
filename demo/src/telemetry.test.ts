import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("demo telemetry preload", () => {
  it("places the tsx watch subcommand before Node preload options", async () => {
    const manifest = JSON.parse(await readFile(resolve("demo/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts["dev:server"]).toContain(
      "tsx watch --require ./telemetry.cjs src/index.ts",
    );
    expect(manifest.scripts["dev:worker"]).toContain(
      "tsx watch --require ./telemetry.cjs src/worker-main.ts",
    );
  });
});
