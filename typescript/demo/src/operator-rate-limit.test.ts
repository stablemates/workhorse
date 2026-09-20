import { isDashboardMutation } from "@stablemates/workhorse-dashboard/server";
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

// The classifier and the dashboard host must reach the same verdict for every path the host
// dispatches, or a mutation slips past the rate limiter and the concurrency guard. The host names
// a procedure by slicing its workspace prefix off, dropping empty segments, and joining the rest
// with dots; this reproduces exactly that, so the expectation comes from the host's own rule
// rather than from a copy of the classifier's.
function hostVerdict(prefix: string, pathname: string): boolean {
  return isDashboardMutation(pathname.slice(prefix.length).split("/").filter(Boolean).join("."));
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

  it("agrees with the host for plain, trailing-slash and double-slash paths", () => {
    const prefixes = ["/rpc", "/production/rpc", "/staging/rpc"];
    const procedures = ["dashboard/setQueuePaused", "dashboard/purgeQueue", "dashboard/tasks"];
    const shapes = [
      (prefix: string, procedure: string) => `${prefix}/${procedure}`,
      (prefix: string, procedure: string) => `${prefix}/${procedure}/`,
      (prefix: string, procedure: string) => `${prefix}//${procedure}`,
      (prefix: string, procedure: string) => `${prefix}/${procedure}//`,
      (prefix: string, procedure: string) => `${prefix}/${procedure.replace("/", "//")}`,
    ];

    for (const prefix of prefixes) {
      for (const procedure of procedures) {
        for (const shape of shapes) {
          const pathname = shape(prefix, procedure);
          expect({ pathname, mutation: isDemoOperatorMutation(request(pathname)) }).toEqual({
            pathname,
            mutation: hostVerdict(prefix, pathname),
          });
        }
      }
    }
  });

  it("agrees with the host on paths that reach no procedure", () => {
    for (const pathname of [
      "/rpc/dashboard/setQueuePaused/extra",
      "/rpc/extra/dashboard/setQueuePaused",
      "/rpc/dashboard",
      "/rpc/setQueuePaused",
    ]) {
      expect({ pathname, mutation: isDemoOperatorMutation(request(pathname)) }).toEqual({
        pathname,
        mutation: hostVerdict("/rpc", pathname),
      });
    }
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
