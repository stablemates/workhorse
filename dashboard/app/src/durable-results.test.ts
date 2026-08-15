import { describe, expect, it } from "vitest";
import {
  describeDurableBoundary,
  describeTaskResult,
  readTaskResultEvidence,
} from "./presentation.js";

/**
 * These tests pin what the Task details drawer is allowed to claim about durable results.
 *
 * The drawer is read as evidence: an operator decides whether work actually happened from the
 * words in it. Two claims are dangerous enough to be treated as behaviour rather than copy.
 * First, a task that has not finished must never appear to have produced a result, and a retrying
 * task's latest error must never read as a terminal one. Second, a stage that no future attempt
 * can reach must say so, because "waiting to run" invites an operator to wait for something that
 * will never happen.
 */

describe("durable boundary vocabulary", () => {
  it("reports a stage past a persistent failure as never reached, not as pending", () => {
    const notReached = describeDurableBoundary({
      stepIndex: 2,
      hasCheckpoint: false,
      persistentFailureAfterStepIndex: 1,
    });
    expect(notReached.state).toBe("not-reached");
    expect(notReached.label).toBe("Not reached");
    expect(notReached.summary).toContain("no attempt can reach this stage");
    expect(notReached.summary).not.toMatch(/waiting|pending|yet to run/i);
  });

  it("keeps an ordinary unreached stage pending, so nothing invents a blockage", () => {
    const pending = describeDurableBoundary({
      stepIndex: 2,
      hasCheckpoint: false,
      persistentFailureAfterStepIndex: null,
    });
    expect(pending.state).toBe("pending");
    expect(pending.summary).not.toMatch(/never|cannot/i);
  });

  it("calls the blocking stage blocked while still honouring its stored checkpoint", () => {
    const blocked = describeDurableBoundary({
      stepIndex: 1,
      hasCheckpoint: true,
      persistentFailureAfterStepIndex: 1,
    });
    expect(blocked.state).toBe("blocked");
    expect(blocked.label).toBe("Intentionally blocked between stages");
    expect(blocked.summary).toContain("saved the checkpoint");
  });

  it("never claims a stage was unreached while its checkpoint output exists", () => {
    // Stored evidence always wins over declaration metadata. If a checkpoint exists, the drawer
    // must report it as saved rather than erase it with a plan-level assumption.
    const saved = describeDurableBoundary({
      stepIndex: 3,
      hasCheckpoint: true,
      persistentFailureAfterStepIndex: 1,
    });
    expect(saved.state).toBe("saved");
    expect(saved.summary).toContain("reuses it in every later attempt");
  });

  it("gives every boundary state a label that stands without colour", () => {
    for (const stepIndex of [0, 1, 2]) {
      for (const hasCheckpoint of [true, false]) {
        for (const persistentFailureAfterStepIndex of [null, 0, 1]) {
          const described = describeDurableBoundary({
            stepIndex,
            hasCheckpoint,
            persistentFailureAfterStepIndex,
          });
          expect(described.label.length).toBeGreaterThan(0);
          expect(described.summary.length).toBeGreaterThan(0);
          expect(described.label).not.toContain("_");
        }
      }
    }
  });
});

describe("task result vocabulary", () => {
  it("treats nullable PostgreSQL fields as absent evidence in real drawer-shaped input", () => {
    expect(
      readTaskResultEvidence({
        state: "active",
        outcome: null,
        runtimeError: null,
        currentError: null,
        blockedByPersistentFailure: false,
      }),
    ).toMatchObject({
      description: { label: "No final outcome yet", valueLabel: null },
      value: undefined,
    });
    expect(
      readTaskResultEvidence({
        state: "succeeded",
        outcome: { state: "succeeded", result: null, error: null },
        runtimeError: null,
        currentError: null,
        blockedByPersistentFailure: false,
      }),
    ).toMatchObject({
      description: { label: "Succeeded", valueLabel: null },
      value: undefined,
    });
  });

  it("shows a final result only for a task that actually succeeded", () => {
    const described = describeTaskResult({
      state: "succeeded",
      hasOutcome: true,
      outcomeState: "succeeded",
      hasResultValue: true,
      hasErrorValue: false,
      blockedByPersistentFailure: false,
    });
    expect(described).toMatchObject({
      state: "succeeded",
      label: "Succeeded",
      valueLabel: "Final result",
    });
    expect(described.emptyLabel).toBeNull();
  });

  it("keeps a successful task with no return value value-free instead of showing null as a result", () => {
    const described = describeTaskResult({
      state: "succeeded",
      hasOutcome: true,
      outcomeState: "succeeded",
      hasResultValue: false,
      hasErrorValue: false,
      blockedByPersistentFailure: false,
    });
    expect(described.valueLabel).toBeNull();
    expect(described.emptyLabel).toContain("returned no value");
  });

  it("separates failure from cancellation instead of folding one into the other", () => {
    const failed = describeTaskResult({
      state: "failed",
      hasOutcome: true,
      outcomeState: "failed",
      hasResultValue: false,
      hasErrorValue: true,
      blockedByPersistentFailure: false,
    });
    expect(failed).toMatchObject({
      state: "failed",
      label: "Failed",
      valueLabel: "Terminal error",
    });
    expect(failed.summary).toContain("used every attempt");

    const canceled = describeTaskResult({
      state: "canceled",
      hasOutcome: true,
      outcomeState: "canceled",
      hasResultValue: false,
      hasErrorValue: true,
      blockedByPersistentFailure: false,
    });
    expect(canceled).toMatchObject({ state: "canceled", label: "Canceled" });
    expect(canceled.summary).not.toMatch(/failed/i);
  });

  it("states plainly that a live task has no final outcome yet", () => {
    for (const state of ["ready", "active", "scheduled"]) {
      const described = describeTaskResult({
        state,
        hasOutcome: false,
        outcomeState: null,
        hasResultValue: false,
        hasErrorValue: false,
        blockedByPersistentFailure: false,
      });
      expect(described.state).toBe("pending");
      expect(described.label).toBe("No final outcome yet");
      expect(described.valueLabel).toBeNull();
      expect(described.summary).toContain("has not finished");
    }
  });

  it("labels a scheduled retry's error as an attempt error, never as terminal", () => {
    const described = describeTaskResult({
      state: "scheduled",
      hasOutcome: false,
      outcomeState: null,
      hasResultValue: false,
      hasErrorValue: true,
      blockedByPersistentFailure: true,
    });
    expect(described.state).toBe("pending");
    expect(described.valueLabel).toBe("Latest attempt error");
    expect(described.valueLabel).not.toBe("Terminal error");
    expect(described.summary).toContain("records a final failure after");
    expect(described.summary).not.toMatch(/succeeded|final result/i);
  });
});
