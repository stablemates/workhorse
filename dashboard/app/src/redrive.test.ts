import { describe, expect, it } from "vitest";
import {
  describeRedriveBatch,
  describeRedriveOutcome,
  describeRedriveSelection,
  redriveAtLeastOnceWarning,
  redriveOutcomeTone,
} from "./presentation.js";

function listing(overrides: Partial<Parameters<typeof describeRedriveSelection>[0]> = {}) {
  return {
    filter: "discarded" as const,
    queue: null,
    jobType: null,
    worker: null,
    priority: null,
    search: null,
    tags: [],
    ...overrides,
  };
}

describe("dead-letter selection", () => {
  it("names every filter a bulk redrive would apply", () => {
    expect(describeRedriveSelection(listing()).selected).toBe("every dead letter");
    expect(
      describeRedriveSelection(
        listing({ queue: "billing", jobType: "invoice.charge", tags: ["eu", "retryable"] }),
      ).selected,
    ).toBe("every dead letter in queue billing of type invoice.charge tagged eu, retryable");
  });

  it("refuses a listing narrowed by a filter the redrive cannot express", () => {
    // Redriving these would act on tasks the operator is not looking at.
    for (const narrowed of [{ worker: "worker-1" }, { priority: 5 }, { search: "invoice" }]) {
      expect(describeRedriveSelection(listing(narrowed)).unavailable).toContain(
        "queue, task type, and tags",
      );
    }
    expect(
      describeRedriveSelection(listing({ worker: "worker-1", search: "x" })).unavailable,
    ).toContain("worker and search filter");
    expect(describeRedriveSelection(listing()).unavailable).toBeNull();
  });

  it("offers no selection outside the listing that shows dead letters", () => {
    expect(describeRedriveSelection(listing({ filter: "all" })).unavailable).toContain(
      "Only the discarded listing",
    );
  });
});

describe("redrive wording", () => {
  it("states the at-least-once consequence before anything runs", () => {
    expect(redriveAtLeastOnceWarning).toContain("at-least-once execution");
    expect(redriveAtLeastOnceWarning).toContain("happens again");
  });

  it("never describes a redrive as resuming or repairing the failure", () => {
    const statuses = ["redriven", "replayed", "eligible", "not_failed", "not_found"] as const;
    for (const status of statuses) {
      const described = describeRedriveOutcome(status, { state: "succeeded" });
      expect(described.label).not.toContain(status);
      // "retry policy" is a field the copy inherits; resuming or repairing is what redrive is not.
      expect(`${described.summary} ${described.exact}`).not.toMatch(/resum|repair/i);
    }
    expect(describeRedriveOutcome("redriven").exact).toContain("runs again");
    expect(describeRedriveOutcome("not_failed", { state: "canceled" }).summary).toContain(
      "this task is canceled",
    );
  });

  it("treats only a fresh copy as a change", () => {
    expect(redriveOutcomeTone("redriven")).toBe("success");
    expect(redriveOutcomeTone("replayed")).toBe("neutral");
    expect(redriveOutcomeTone("not_found")).toBe("neutral");
  });
});

describe("filtered redrive results", () => {
  const redriven = { status: "redriven" as const };

  it("counts what the page did rather than reporting its size", () => {
    const described = describeRedriveBatch(
      [redriven, redriven, { status: "replayed" }, { status: "not_failed" }],
      false,
    );

    expect(described.label).toBe("Redrove 2 tasks");
    expect(described.summary).toContain("1 task had already been redriven");
    expect(described.summary).toContain("1 task was no longer a dead letter");
    expect(described.tone).toBe("success");
  });

  it("says whether the filter still selects more, so a bounded page is not read as the end", () => {
    expect(describeRedriveBatch([redriven], true).exact).toContain("redrive again to continue");
    expect(describeRedriveBatch([redriven], false).exact).toContain("No dead letter matching");
  });

  it("reports an empty selection as having enqueued nothing", () => {
    const described = describeRedriveBatch([], false);

    expect(described.label).toBe("Nothing to redrive");
    expect(described.tone).toBe("neutral");
  });
});
