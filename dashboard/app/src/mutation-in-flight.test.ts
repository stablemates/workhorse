import { describe, expect, it } from "vitest";
import { createMutationInFlight } from "./mutation-in-flight.js";

describe("mutation in-flight tracker", () => {
  it("exposes the active key and clears it after completion", () => {
    const tracker = createMutationInFlight<string>();
    expect(tracker.value).toBeNull();
    tracker.start("queues");
    expect(tracker.value).toBe("queues");
    tracker.stop();
    expect(tracker.value).toBeNull();
  });
});
