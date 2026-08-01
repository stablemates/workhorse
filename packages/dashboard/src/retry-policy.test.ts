import { describe, expect, it } from "vitest";
import { describeRetryEventSource, describeRetryPolicy, formatRetryDelay } from "./model.js";

describe("retry policy vocabulary", () => {
  it("never shows a raw stored kind and always keeps exact values available", () => {
    expect(describeRetryPolicy({ type: "fixed", delayMs: 300_000 })).toMatchObject({
      label: "Fixed",
      summary: "Wait 5m before every retry",
      exact: "Fixed delay 300000 ms",
    });
    expect(
      describeRetryPolicy({
        type: "exponential",
        initialDelayMs: 420_000,
        multiplier: 2,
        maxDelayMs: 1_800_000,
      }),
    ).toMatchObject({
      label: "Exponential",
      summary: "7m × 2, capped at 30m",
      exact: "Initial delay 420000 ms; multiplier 2; maximum 1800000 ms",
    });
    expect(
      describeRetryPolicy({
        type: "decorrelated-jitter",
        baseDelayMs: 600_000,
        maxDelayMs: 900_000,
      }),
    ).toMatchObject({
      label: "Decorrelated jitter",
      summary: "10m base, capped at 15m",
      exact: "Base delay 600000 ms; maximum 900000 ms",
    });
  });

  it("explains a missing policy instead of hiding it", () => {
    expect(describeRetryPolicy(null)).toMatchObject({
      label: "Default backoff",
      exact: "No persisted retry policy",
    });
  });

  it("states plainly when a cap removes all variation or growth", () => {
    expect(
      describeRetryPolicy({
        type: "decorrelated-jitter",
        baseDelayMs: 600_000,
        maxDelayMs: 600_000,
      }).summary,
    ).toBe("Held at the 10m cap, so every retry waits the same");
    expect(
      describeRetryPolicy({
        type: "exponential",
        initialDelayMs: 60_000,
        multiplier: 3,
        maxDelayMs: 60_000,
      }).summary,
    ).toBe("Held at the 1m cap from the first retry");
  });

  it("names a manual override separately from the persisted policy", () => {
    const policy = { type: "fixed", delayMs: 300_000 } as const;
    expect(describeRetryEventSource("override", policy).label).toBe("Manual override");
    expect(describeRetryEventSource("policy:fixed", policy).label).toBe("Fixed");
    expect(describeRetryEventSource("legacy-handler", null).label).toBe("Default backoff");
    expect(describeRetryEventSource("lease-recovery-immediate", null).label).toBe(
      "Immediate recovery",
    );
    expect(describeRetryEventSource(null, null).label).toBe("Default backoff");
  });

  it("formats retry delays without inventing precision", () => {
    expect(formatRetryDelay(0)).toBe("0ms");
    expect(formatRetryDelay(100)).toBe("100ms");
    expect(formatRetryDelay(1_500)).toBe("1500ms");
    expect(formatRetryDelay(2_000)).toBe("2s");
    expect(formatRetryDelay(300_000)).toBe("5m");
  });
});
