import { describe, expect, it } from "vitest";
import {
  cancelOutcomeTone,
  describeCancelOutcome,
  describeCancellationRequest,
  isTerminalTaskState,
} from "./model.js";

/**
 * These tests pin the promises the cancellation copy is allowed to make.
 *
 * Cancellation is the one operator action here that cannot be undone, and for a running task it is
 * cooperative rather than forced. Wording that overstates it would mislead an operator into
 * believing external effects were stopped or reversed, so the honesty of each sentence is treated
 * as behaviour and asserted, not left to review.
 */
describe("cancellation vocabulary", () => {
  it("never shows a raw status string", () => {
    const statuses = ["canceled", "cancel_requested", "already_terminal", "not_found"] as const;
    for (const status of statuses) {
      const described = describeCancelOutcome(status);
      expect(described.label).not.toContain("_");
      expect(described.label).not.toBe(status);
      expect(described.summary.length).toBeGreaterThan(0);
      expect(described.exact.length).toBeGreaterThan(0);
    }
  });

  /**
   * A notification's colour is read before its sentence is. A task that had already finished, or
   * that no longer exists, was left alone on purpose, so tone must not accuse the operator of a
   * failure they did not cause and cannot fix.
   */
  it("reserves the failure tone for requests that never reached a decision", () => {
    expect(cancelOutcomeTone("canceled")).toBe("success");
    expect(cancelOutcomeTone("cancel_requested")).toBe("success");
    expect(cancelOutcomeTone("already_terminal")).toBe("neutral");
    expect(cancelOutcomeTone("not_found")).toBe("neutral");
  });

  it("describes an unstarted cancellation as immediate and handler-free", () => {
    const described = describeCancelOutcome("canceled");
    expect(described.label).toBe("Canceled");
    expect(described.summary).toContain("before it started");
    expect(described.exact).toContain("No handler ran");
  });

  it("describes an active cancellation as cooperative without promising force", () => {
    const described = describeCancelOutcome("cancel_requested");
    expect(described.summary).toContain("running handler");
    expect(described.summary).toContain("checks the signal");
    // The caveat that already-started external effects can continue must survive any rewording.
    expect(described.exact).toContain("external effects it already started can continue");
    const wording = `${described.label} ${described.summary} ${described.exact}`.toLowerCase();
    for (const overclaim of ["force", "immediately", "instantly", "kill", "exactly once", "undo"]) {
      expect(wording).not.toContain(overclaim);
    }
  });

  it("explains a terminal task in terms of immutability, naming the state it holds", () => {
    const described = describeCancelOutcome("already_terminal", { state: "succeeded" });
    expect(described.summary).toContain("succeeded");
    expect(described.summary).toContain("nothing was canceled");
    expect(described.exact).toContain("immutable");
    // Without a known state the sentence must still read cleanly rather than leaking "undefined".
    expect(describeCancelOutcome("already_terminal").summary).not.toContain("undefined");
  });

  it("explains a missing task rather than reporting a silent success", () => {
    const described = describeCancelOutcome("not_found");
    expect(described.summary).toContain("could not find this task");
    expect(described.summary).toContain("canceled nothing");
    expect(described.exact).toContain("Retention");
  });

  it("keeps a requested cancellation's exact attribution available for a title", () => {
    const described = describeCancellationRequest({
      requestedAt: "2024-05-01T10:00:00.000Z",
      requestedBy: "local-demo",
      reason: "Stuck on a stale upstream",
    });
    expect(described?.label).toBe("Cancellation requested");
    expect(described?.exact).toContain("2024-05-01T10:00:00.000Z");
    expect(described?.exact).toContain("local-demo");
    expect(described?.exact).toContain("Stuck on a stale upstream");
    // The cooperative caveat travels with the attribution instead of being dropped.
    expect(described?.exact).toContain("external effects it already started can continue");
  });

  it("stays readable when a request carries no actor or reason", () => {
    const described = describeCancellationRequest({
      requestedAt: "2024-05-01T10:00:00.000Z",
      requestedBy: null,
      reason: null,
    });
    expect(described?.exact).toContain("2024-05-01T10:00:00.000Z");
    expect(described?.exact).not.toContain("null");
    expect(described?.exact).not.toContain("undefined");
  });

  it("returns nothing for a task with no pending cancellation", () => {
    expect(describeCancellationRequest(null)).toBeNull();
  });

  it("treats canceled as terminal and distinct, never as a live or failed state", () => {
    expect(isTerminalTaskState("canceled")).toBe(true);
    expect(isTerminalTaskState("succeeded")).toBe(true);
    expect(isTerminalTaskState("failed")).toBe(true);
    for (const live of ["scheduled", "ready", "active", "unknown"]) {
      expect(isTerminalTaskState(live)).toBe(false);
    }
    // A canceled task must not be describable as a failure anywhere in its own vocabulary.
    const wording = Object.values(describeCancelOutcome("canceled")).join(" ").toLowerCase();
    expect(wording).not.toContain("fail");
    expect(wording).not.toContain("discard");
  });
});
