import { describe, expect, it } from "vitest";
import { runOperationalScenarios } from "../benchmarks/scenarios.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool } = createIntegrationTestContext(import.meta.url);

describe("checkpoint replay benchmark scenario", () => {
  it("saves, suspends, and replays each checkpoint count against PostgreSQL", async () => {
    const report = await runOperationalScenarios(pool, {
      scenarios: ["checkpoint-replay"],
      checkpointCounts: [0, 3, 25],
      checkpointReplayPasses: 2,
    });

    const [scenario] = report.scenarios;
    expect(scenario?.name).toBe("checkpoint-replay");
    expect(scenario!.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(scenario!.assertions.map((assertion) => assertion.name)).toEqual(
      expect.arrayContaining([
        "checkpoints25 replay passes issue one list query each",
        "checkpoints25 replay lists return every checkpoint",
        "checkpoints25 replay passes save nothing",
      ]),
    );
    expect(scenario!.metrics).toMatchObject({
      checkpointCounts: "0,3,25",
      replayPasses: 2,
      checkpoints0CheckpointEvents: 0,
      checkpoints3CheckpointEvents: 3,
      checkpoints25CheckpointEvents: 25,
    });
    expect(scenario!.metrics.checkpoints25CheckpointBytes).toBeGreaterThan(
      Number(scenario!.metrics.checkpoints3CheckpointBytes),
    );
    expect(scenario!.metrics.checkpoints25ReplayReadP50Ms).toEqual(expect.any(Number));
  });
});
