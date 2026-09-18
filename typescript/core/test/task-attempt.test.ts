import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineExceededError, ExecutionTimeoutError } from "../src/errors.js";
import { TaskAttempt, type TaskAttemptServices } from "../src/task-attempt.js";
import type { TaskExecutionOutcome } from "../src/telemetry.js";
import type { ClaimedTask, HeartbeatStatus } from "../src/types.js";

function claimedTask(overrides: Partial<ClaimedTask> = {}): ClaimedTask {
  return {
    id: "attempt-task",
    queue: "default",
    type: "attempt",
    priority: 0,
    payload: null,
    contractVersion: null,
    resultMaxBytes: 1_048_576,
    redactErrorDetails: false,
    traceContext: null,
    attempt: 1,
    maxAttempts: 1,
    retryPolicy: null,
    deadlineAt: null,
    executionTimeoutMs: null,
    attemptTimeoutAt: null,
    fenceToken: 1n,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    ...overrides,
  };
}

function fakeServices() {
  const heartbeat: {
    status?: (status: HeartbeatStatus) => void;
    error?: (error: unknown) => void;
    removed: number;
  } = { removed: 0 };
  const services: TaskAttemptServices = {
    workerId: "attempt-worker",
    acknowledgeCancel: vi.fn<TaskAttemptServices["acknowledgeCancel"]>(async () => true),
    expireOwned: vi.fn<TaskAttemptServices["expireOwned"]>(async () => "deadline_exceeded"),
    addHeartbeatLease: (_task, status, error) => {
      heartbeat.status = status;
      heartbeat.error = error;
      return () => {
        heartbeat.removed += 1;
      };
    },
  };
  return { services, heartbeat };
}

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
}

function startAttempt(task = claimedTask()) {
  const { services, heartbeat } = fakeServices();
  const activation: { outcome: TaskExecutionOutcome } = { outcome: "unknown" };
  const attempt = new TaskAttempt(task, services, activation);
  return { attempt, services, heartbeat, activation };
}

describe("TaskAttempt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows durable effects while the lease is held and refuses them after it is lost", () => {
    const { attempt, heartbeat } = startAttempt();
    expect(() => attempt.requireLease()).not.toThrow();

    heartbeat.status!("stale");

    expect(attempt.signal.aborted).toBe(true);
    expect(() => attempt.requireLease()).toThrow("Task lease was lost");
    expect(attempt.arbiter.is("lease_expired")).toBe(true);
    expect(heartbeat.removed).toBe(1);
  });

  it("rethrows the abort reason when an expiry ended the attempt", () => {
    const { attempt, heartbeat } = startAttempt();

    heartbeat.status!("timeout_exceeded");

    expect(() => attempt.requireLease()).toThrow(ExecutionTimeoutError);
  });

  it("suspends once, and a later suspension still throws without replacing the outcome", () => {
    const { attempt } = startAttempt();

    const childSuspension = thrownBy(() => attempt.suspend("suspended_for_child"));
    expect(typeof childSuspension).toBe("symbol");
    expect(attempt.arbiter.is("suspended_for_child")).toBe(true);
    expect(attempt.signal.reason).toBe(childSuspension);

    const waitSuspension = thrownBy(() => attempt.suspend("suspended_for_wait"));
    expect(typeof waitSuspension).toBe("symbol");
    expect(waitSuspension).not.toBe(childSuspension);
    expect(attempt.arbiter.is("suspended_for_child")).toBe(true);
    expect(thrownBy(() => attempt.suspendForScheduledWait())).toBeUndefined();
    expect(thrownBy(() => attempt.requireLease())).toBe(childSuspension);
  });

  it("fires the local deadline and asks PostgreSQL to expire ownership", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ deadlineAt: new Date(1_000) }),
    );

    vi.advanceTimersByTime(1_000);
    expect(attempt.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);

    expect(attempt.signal.reason).toBeInstanceOf(DeadlineExceededError);
    expect(heartbeat.removed).toBe(1);
    expect(services.expireOwned).toHaveBeenCalledTimes(1);
    await attempt.settleExpiration();
    expect(attempt.arbiter.is("deadline_exceeded")).toBe(true);
  });

  it("stop cancels the expiration timer and releases the heartbeat lease", () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ attemptTimeoutAt: new Date(1_000) }),
    );

    attempt.stop();
    vi.advanceTimersByTime(10_000);

    expect(attempt.signal.aborted).toBe(false);
    expect(services.expireOwned).not.toHaveBeenCalled();
    expect(heartbeat.removed).toBe(1);
    heartbeat.error!(new Error("late heartbeat failure"));
    expect(attempt.signal.aborted).toBe(false);
  });

  it("records the first execution outcome only", () => {
    const { attempt, activation } = startAttempt();

    attempt.recordFailure("ready");
    attempt.recordFailure("failed");

    expect(activation.outcome).toBe("retry");
    expect(attempt.arbiter.is("failed")).toBe(true);
  });
});
