import { describe, expect, it } from "vitest";

// docs/parity.md states the bound: an integer keeps its exact value across the three SDKs only up
// to 2^53 - 1 in magnitude. These tests hold TypeScript to both halves of that statement, so the
// published bound cannot drift away from what the runtime does.

const PORTABLE_INTEGER_BOUND = 9_007_199_254_740_991;

describe("JSON integer semantics", () => {
  it("round-trips every integer inside the portable bound exactly", () => {
    for (const value of [0, 1, -1, 2 ** 31, PORTABLE_INTEGER_BOUND, -PORTABLE_INTEGER_BOUND]) {
      expect(JSON.parse(JSON.stringify({ id: value })).id).toBe(value);
    }
    expect(Number.MAX_SAFE_INTEGER).toBe(PORTABLE_INTEGER_BOUND);
  });

  it("rounds an integer beyond the bound, which is why the bound is documented", () => {
    // A Python client can enqueue this value; PostgreSQL stores it exactly. A TypeScript worker
    // reads it as a double, so the handler sees a different number and no error is raised.
    const decoded = JSON.parse('{"id":9007199254740993}').id;
    expect(decoded).toBe(PORTABLE_INTEGER_BOUND + 1);
    expect(String(decoded)).not.toBe("9007199254740993");
  });
});
