import { describe, expect, it } from "vitest";
import { createCoalescedRead, type CoalescedReadResult } from "./coalesced-read.js";

/** A read that ends only when the test resolves it, so a test controls how slow it is. */
function slowReads() {
  const pending: Array<{ key: string; resolve: (value: string) => void }> = [];
  return {
    pending,
    read(key: string, value: string) {
      return () =>
        new Promise<string>((resolve) => {
          pending.push({ key, resolve: () => resolve(value) });
        });
    },
  };
}

function setup() {
  const delivered: Array<CoalescedReadResult<string>> = [];
  const reads = slowReads();
  const reader = createCoalescedRead<string>((result) => delivered.push(result));
  return { delivered, reads, reader };
}

async function settle() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("coalesced read", () => {
  it("keeps one read in flight while polls arrive, then shows its rows and reads once more", async () => {
    const { delivered, reads, reader } = setup();
    reader.request("billing", reads.read("billing", "first"));
    // Three polls arrive while the first read is slow.
    reader.request("billing", reads.read("billing", "poll 1"));
    reader.request("billing", reads.read("billing", "poll 2"));
    reader.request("billing", reads.read("billing", "poll 3"));
    expect(reads.pending).toHaveLength(1);

    reads.pending[0]!.resolve("first");
    await settle();
    expect(delivered).toEqual([{ status: "ready", value: "first" }]);
    // One more read follows for the polls, with the newest read function.
    expect(reads.pending).toHaveLength(2);
    reads.pending[1]!.resolve("poll 3");
    await settle();
    expect(delivered.at(-1)).toEqual({ status: "ready", value: "poll 3" });
    expect(reads.pending).toHaveLength(2);
  });

  it("discards the answer for a destination that the operator left", async () => {
    const { delivered, reads, reader } = setup();
    reader.request("billing", reads.read("billing", "billing rows"));
    reader.request("email", reads.read("email", "email rows"));
    // The new destination reads at once.
    expect(reads.pending.map((read) => read.key)).toEqual(["billing", "email"]);
    reads.pending[0]!.resolve("billing rows");
    await settle();
    expect(delivered).toEqual([]);
    reads.pending[1]!.resolve("email rows");
    await settle();
    expect(delivered).toEqual([{ status: "ready", value: "email rows" }]);
  });

  it("reports a failed read and reads again on the next poll", async () => {
    const { delivered, reader } = setup();
    const failure = new Error("HTTP 503");
    reader.request("billing", () => Promise.reject(failure));
    await settle();
    expect(delivered).toEqual([{ status: "failed", error: failure }]);
    reader.request("billing", () => Promise.resolve("rows"));
    await settle();
    expect(delivered.at(-1)).toEqual({ status: "ready", value: "rows" });
  });

  it("discards every answer after close", async () => {
    const { delivered, reads, reader } = setup();
    reader.request("billing", reads.read("billing", "rows"));
    reader.request("billing", reads.read("billing", "poll"));
    reader.close();
    reads.pending[0]!.resolve("rows");
    await settle();
    expect(delivered).toEqual([]);
    expect(reads.pending).toHaveLength(1);
  });
});
