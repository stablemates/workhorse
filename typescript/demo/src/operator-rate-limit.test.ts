import { describe, expect, it } from "vitest";
import {
  demoClientAddress,
  DemoOperatorRateLimiter,
  isDemoOperatorMutation,
} from "./operator-rate-limit.js";

function request(path: string, address = "203.0.113.4", forwardedFor?: string) {
  return {
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    method: "POST",
    socket: { remoteAddress: address },
    url: path,
  } as const;
}

describe("demo operator rate limiting", () => {
  it("recognizes operator procedures under single- and multi-workspace paths", () => {
    expect(isDemoOperatorMutation(request("/rpc/dashboard/purgeQueue"))).toBe(true);
    expect(isDemoOperatorMutation(request("/production/rpc/dashboard/cancelTask"))).toBe(true);
    expect(isDemoOperatorMutation(request("/rpc/dashboard/tasks"))).toBe(false);
    expect(isDemoOperatorMutation({ ...request("/rpc/dashboard/purgeQueue"), method: "GET" })).toBe(
      false,
    );
  });

  it("uses the address appended by the trusted proxy", () => {
    expect(demoClientAddress(request("/", "127.0.0.1", "198.51.100.8, 203.0.113.9"))).toBe(
      "203.0.113.9",
    );
    expect(demoClientAddress(request("/", "127.0.0.1"))).toBe("127.0.0.1");
  });

  it("allows a short burst, isolates clients, and refills tokens", () => {
    const limiter = new DemoOperatorRateLimiter();
    const firstClient = request("/rpc/dashboard/setQueuePaused");

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.check(firstClient, 0)).toBeUndefined();
    }
    expect(limiter.check(firstClient, 0)).toBe(5);
    expect(
      limiter.check(request("/rpc/dashboard/setQueuePaused", "203.0.113.5"), 0),
    ).toBeUndefined();
    expect(limiter.check(firstClient, 2_000)).toBe(3);
    expect(limiter.check(firstClient, 5_000)).toBeUndefined();
  });
});
