import { describe, expect, it } from "vitest";
import {
  DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS,
  DEMO_REQUEST_BODY_MAX_BYTES,
  demoRequestBodyRejection,
  DemoOperatorMutationGuard,
  type DemoGuardedRequest,
} from "./request-guards.js";

function request(
  method: string,
  url: string,
  headers: DemoGuardedRequest["headers"] = {},
): DemoGuardedRequest {
  return { headers, method, url };
}

describe("demo request body limits", () => {
  it("accepts a declared body within the cap", () => {
    expect(
      demoRequestBodyRejection(
        request("POST", "/rpc/dashboard/enqueueTest", {
          "content-length": String(DEMO_REQUEST_BODY_MAX_BYTES),
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects a declared body over the cap before the body is read", () => {
    expect(
      demoRequestBodyRejection(
        request("POST", "/rpc/dashboard/signalTask", {
          "content-length": String(DEMO_REQUEST_BODY_MAX_BYTES + 1),
        }),
      ),
    ).toBe(413);
    expect(
      demoRequestBodyRejection(
        request("GET", "/production/tasks", { "content-length": "999999999" }),
      ),
    ).toBe(413);
  });

  it("requires a declared length for a streamed body-bearing method", () => {
    expect(
      demoRequestBodyRejection(
        request("POST", "/rpc/dashboard/cancelTask", { "transfer-encoding": "chunked" }),
      ),
    ).toBe(411);
  });

  it("treats a body-bearing method with no framing as empty", () => {
    expect(demoRequestBodyRejection(request("POST", "/rpc/dashboard/enqueueTest"))).toBeUndefined();
    expect(demoRequestBodyRejection(request("GET", "/up"))).toBeUndefined();
  });
});

describe("demo operator mutation concurrency", () => {
  const mutation = () => request("POST", "/rpc/dashboard/purgeQueue");
  const read = () => request("POST", "/rpc/dashboard/tasks");

  it("admits mutations up to the cap, then refuses until a slot frees", () => {
    const guard = new DemoOperatorMutationGuard();
    for (let index = 0; index < DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS; index += 1) {
      expect(guard.tryAcquire(mutation())).toBe(true);
    }
    expect(guard.tryAcquire(mutation())).toBe(false);

    guard.release(mutation());
    expect(guard.tryAcquire(mutation())).toBe(true);
  });

  it("never consumes a slot for reads or non-RPC requests", () => {
    const guard = new DemoOperatorMutationGuard();
    for (let index = 0; index < DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS; index += 1) {
      expect(guard.tryAcquire(mutation())).toBe(true);
    }
    expect(guard.tryAcquire(read())).toBe(true);
    expect(guard.tryAcquire(request("GET", "/assets/index.js"))).toBe(true);
    // A non-mutation that "acquired" must be releasable without corrupting the count.
    guard.release(read());
    guard.release(mutation());
    expect(guard.tryAcquire(mutation())).toBe(true);
  });
});
