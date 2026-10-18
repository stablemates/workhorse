import { describe, expect, it } from "vitest";
import { heartbeatRoundBoundMs } from "../src/heartbeat-round.js";

describe("heartbeat round bound", () => {
  it("is three quarters of the interval from 200 ms, and the interval up to 50 ms", () => {
    expect(heartbeatRoundBoundMs(10)).toBe(10);
    expect(heartbeatRoundBoundMs(40)).toBe(40);
    expect(heartbeatRoundBoundMs(50)).toBe(50);
    expect(heartbeatRoundBoundMs(66)).toBe(50);
    expect(heartbeatRoundBoundMs(69)).toBe(51);
    expect(heartbeatRoundBoundMs(200)).toBe(150);
    expect(heartbeatRoundBoundMs(10_000)).toBe(7_500);
  });

  it("leaves a renewal margin after one timed-out round with the defaults", () => {
    const leaseMs = 30_000;
    const heartbeatMs = leaseMs / 3;
    expect(2 * heartbeatMs + heartbeatRoundBoundMs(heartbeatMs)).toBeLessThan(leaseMs);
  });
});
