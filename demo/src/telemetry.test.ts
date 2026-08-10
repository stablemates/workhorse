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

  it("keeps telemetry opt-in at the root demo command", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.demo).not.toContain("WORKHORSE_DEMO_TELEMETRY");
    expect(manifest.scripts["demo:otel"]).toBe(
      "pnpm signoz:up && WORKHORSE_DEMO_TELEMETRY=true pnpm demo",
    );
    expect(manifest.scripts["signoz:up"]).toContain("scripts/signoz-portless.ts add");
    expect(manifest.scripts["signoz:down"]).toContain("scripts/signoz-portless.ts remove");
  });
});
