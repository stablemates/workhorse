import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineExceededError, ExecutionTimeoutError } from "../src/errors.js";
import { TaskAttempt, type TaskAttemptServices } from "../src/task-attempt.js";
import type { TaskExecutionOutcome } from "../src/telemetry.js";
import type { ClaimedTask, ExpireOwnedStatus, HeartbeatStatus } from "../src/types.js";

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
    status?: (status: HeartbeatStatus, sentAt: number) => void;
    removed: number;
  } = { removed: 0 };
  const services: TaskAttemptServices = {
    workerId: "attempt-worker",
    leaseMs: 30_000,
    acknowledgeCancel: vi.fn<TaskAttemptServices["acknowledgeCancel"]>(async () => true),
    expireOwned: vi.fn<TaskAttemptServices["expireOwned"]>(async () => "deadline_exceeded"),
    addHeartbeatLease: (_task, status) => {
      heartbeat.status = status;
      return () => {
        heartbeat.removed += 1;
      };
    },
  };
  return { services, heartbeat };
}

// An expire_owned_v1 answer the test delivers when it chooses.
function deferredExpiry() {
  let resolve!: (status: ExpireOwnedStatus) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ExpireOwnedStatus>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
}

function startAttempt(task = claimedTask(), claimSentAt = performance.now()) {
  const { services, heartbeat } = fakeServices();
  const activation: { outcome: TaskExecutionOutcome } = { outcome: "unknown" };
  const attempt = new TaskAttempt(task, services, activation, claimSentAt);
  return { attempt, services, heartbeat, activation };
}

describe("TaskAttempt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows durable effects while the lease is held and refuses them after it is lost", () => {
    const { attempt, heartbeat } = startAttempt();
    expect(() => attempt.requireLease()).not.toThrow();

    heartbeat.status!("stale", Date.now());

    expect(attempt.signal.aborted).toBe(true);
    expect(() => attempt.requireLease()).toThrow("Task lease was lost");
    expect(attempt.arbiter.is("lease_expired")).toBe(true);
    expect(heartbeat.removed).toBe(1);
  });

  it("rethrows the abort reason when an expiry ended the attempt", () => {
    const { attempt, heartbeat } = startAttempt();

    heartbeat.status!("timeout_exceeded", Date.now());

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

  it("fires the local deadline and aborts once PostgreSQL confirms the expiry", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ deadlineAt: new Date(1_000) }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt.signal.aborted).toBe(false);
    expect(services.expireOwned).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(services.expireOwned).toHaveBeenCalledTimes(1);
    expect(attempt.signal.reason).toBeInstanceOf(DeadlineExceededError);
    expect(heartbeat.removed).toBe(1);
    await attempt.settleExpiration();
    expect(attempt.arbiter.is("deadline_exceeded")).toBe(true);
  });

  it("measures the attempt timeout from database time when the worker clock runs ahead", async () => {
    // PostgreSQL claimed the task at its time 0 and granted a 10-second timeout. The worker's
    // wall clock reads 5 seconds later than the database's.
    vi.useFakeTimers({ now: 5_000 });
    const { attempt, services } = startAttempt(
      claimedTask({ attemptTimeoutAt: new Date(10_000), leaseExpiresAt: new Date(30_000) }),
    );
    const startedAt = performance.now();
    vi.mocked(services.expireOwned).mockImplementation(async () =>
      performance.now() - startedAt > 10_000 ? "timeout_exceeded" : "not_due",
    );

    await vi.advanceTimersByTimeAsync(5_001);
    expect(attempt.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(attempt.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    expect(attempt.signal.reason).toBeInstanceOf(ExecutionTimeoutError);
    await attempt.settleExpiration();
    expect(attempt.arbiter.is("attempt_timeout")).toBe(true);
  });

  it("keeps the handler running on not_due and asks PostgreSQL again", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ attemptTimeoutAt: new Date(1_000) }),
    );
    const answers: ExpireOwnedStatus[] = ["not_due", "not_due", "timeout_exceeded"];
    vi.mocked(services.expireOwned).mockImplementation(async () => answers.shift()!);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(services.expireOwned).toHaveBeenCalledTimes(1);
    expect(attempt.signal.aborted).toBe(false);
    expect(heartbeat.removed).toBe(0);
    expect(() => attempt.requireLease()).not.toThrow();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(services.expireOwned).toHaveBeenCalledTimes(3);
    expect(attempt.signal.reason).toBeInstanceOf(ExecutionTimeoutError);
    expect(heartbeat.removed).toBe(1);
  });

  it("stops asking PostgreSQL once another outcome wins", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services } = startAttempt(claimedTask({ attemptTimeoutAt: new Date(1_000) }));
    vi.mocked(services.expireOwned).mockImplementation(async () => "not_due");

    await vi.advanceTimersByTimeAsync(1_001);
    attempt.arbiter.submit("completed");
    attempt.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(services.expireOwned).toHaveBeenCalledTimes(1);
    expect(attempt.signal.aborted).toBe(false);
    await attempt.settleExpiration();
  });

  it("stops asking PostgreSQL once the attempt stops without an outcome", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services } = startAttempt(claimedTask({ attemptTimeoutAt: new Date(1_000) }));
    vi.mocked(services.expireOwned).mockImplementation(async () => "not_due");

    await vi.advanceTimersByTimeAsync(1_001);
    attempt.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(services.expireOwned).toHaveBeenCalledTimes(1);
    await attempt.settleExpiration();
  });

  it("keeps asking after a heartbeat reports the expiry that PostgreSQL first called not_due", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ deadlineAt: new Date(1_000) }),
    );
    const answers: ExpireOwnedStatus[] = ["not_due", "deadline_exceeded"];
    vi.mocked(services.expireOwned).mockImplementation(async () => answers.shift()!);

    await vi.advanceTimersByTimeAsync(1_001);
    heartbeat.status!("deadline_exceeded", performance.now());
    expect(attempt.signal.reason).toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(1_000);
    await attempt.settleExpiration();

    expect(services.expireOwned).toHaveBeenCalledTimes(2);
    expect(attempt.arbiter.is("deadline_exceeded")).toBe(true);
  });

  it("reports the confirmed deadline when a heartbeat answers stale before the expiry answer", async () => {
    // expire_owned_v1 commits the deadline, a heartbeat evaluated after that commit finds no
    // active row, and its stale answer arrives before expire_owned_v1's own answer.
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ deadlineAt: new Date(1_000) }),
    );
    const expiry = deferredExpiry();
    vi.mocked(services.expireOwned).mockReturnValue(expiry.promise);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(services.expireOwned).toHaveBeenCalledTimes(1);
    heartbeat.status!("stale", performance.now());
    expect(attempt.signal.aborted).toBe(false);
    expect(heartbeat.removed).toBe(1);

    expiry.resolve("deadline_exceeded");
    await attempt.settleExpiration();
    await vi.advanceTimersByTimeAsync(0);

    expect(attempt.signal.reason).toBeInstanceOf(DeadlineExceededError);
    expect(attempt.arbiter.is("deadline_exceeded")).toBe(true);
  });

  it("reports the confirmed attempt timeout when a heartbeat answers stale before the expiry answer", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ attemptTimeoutAt: new Date(1_000) }),
    );
    const expiry = deferredExpiry();
    vi.mocked(services.expireOwned).mockReturnValue(expiry.promise);

    await vi.advanceTimersByTimeAsync(1_001);
    heartbeat.status!("stale", performance.now());
    expiry.resolve("timeout_exceeded");
    await attempt.settleExpiration();
    await vi.advanceTimersByTimeAsync(0);

    expect(attempt.signal.reason).toBeInstanceOf(ExecutionTimeoutError);
    expect(attempt.arbiter.is("attempt_timeout")).toBe(true);
  });

  it("reports a lost lease when the expiry in flight also finds the task gone", async () => {
    // Another worker recovered the task. Both the heartbeat and expire_owned_v1 answer stale.
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ deadlineAt: new Date(1_000) }),
    );
    const expiry = deferredExpiry();
    vi.mocked(services.expireOwned).mockReturnValue(expiry.promise);

    await vi.advanceTimersByTimeAsync(1_001);
    heartbeat.status!("stale", performance.now());
    expiry.resolve("stale");
    await attempt.settleExpiration();
    await vi.advanceTimersByTimeAsync(0);

    expect(() => attempt.requireLease()).toThrow("Task lease was lost");
    expect(attempt.arbiter.is("lease_expired")).toBe(true);
  });

  it("reports a lost lease when the expiry in flight fails after a heartbeat answered stale", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ deadlineAt: new Date(1_000) }),
    );
    const expiry = deferredExpiry();
    vi.mocked(services.expireOwned).mockReturnValue(expiry.promise);

    await vi.advanceTimersByTimeAsync(1_001);
    heartbeat.status!("stale", performance.now());
    expiry.reject(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(services.expireOwned).toHaveBeenCalledTimes(1);
    expect(() => attempt.requireLease()).toThrow("Task lease was lost");
    expect(attempt.arbiter.is("lease_expired")).toBe(true);
  });

  it("ends the lease window when the expiry in flight never answers after a stale heartbeat", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services, heartbeat } = startAttempt(
      claimedTask({ deadlineAt: new Date(1_000) }),
    );
    vi.mocked(services.expireOwned).mockReturnValue(deferredExpiry().promise);

    await vi.advanceTimersByTimeAsync(1_001);
    heartbeat.status!("stale", performance.now());
    await vi.advanceTimersByTimeAsync(28_998);
    expect(attempt.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(attempt.arbiter.is("lease_expired")).toBe(true);
    expect(() => attempt.requireLease()).toThrow("No heartbeat was accepted within the task lease");
  });

  it("keeps the handler running when PostgreSQL cannot be asked, and asks again", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services } = startAttempt(claimedTask({ deadlineAt: new Date(1_000) }));
    vi.mocked(services.expireOwned)
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue("deadline_exceeded");

    await vi.advanceTimersByTimeAsync(1_001);
    expect(attempt.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(services.expireOwned).toHaveBeenCalledTimes(2);
    expect(attempt.signal.reason).toBeInstanceOf(DeadlineExceededError);
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
    heartbeat.status!("accepted", Date.now());
    vi.advanceTimersByTime(60_000);
    expect(attempt.signal.aborted).toBe(false);
  });

  it("aborts as lease_expired once no renewal has been accepted for one lease", () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt } = startAttempt();

    vi.advanceTimersByTime(29_999);
    expect(attempt.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);

    expect(attempt.arbiter.is("lease_expired")).toBe(true);
    expect(thrownBy(() => attempt.requireLease())).toBeInstanceOf(Error);
  });

  it("extends the lease window from the send time of each accepted heartbeat", () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, heartbeat } = startAttempt();

    vi.advanceTimersByTime(20_000);
    heartbeat.status!("accepted", 15_000);
    vi.advanceTimersByTime(24_999);
    expect(attempt.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);

    expect(attempt.arbiter.is("lease_expired")).toBe(true);
  });

  it("ends the lease window on time when the worker clock jumps backward", () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt } = startAttempt();

    vi.setSystemTime(-60_000);
    vi.advanceTimersByTime(30_000);

    expect(attempt.arbiter.is("lease_expired")).toBe(true);
  });

  it("fires the attempt timeout on time when the worker clock jumps backward", async () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, services } = startAttempt(claimedTask({ attemptTimeoutAt: new Date(1_000) }));
    vi.mocked(services.expireOwned).mockResolvedValue("timeout_exceeded");

    vi.setSystemTime(-60_000);
    await vi.advanceTimersByTimeAsync(1_001);

    expect(services.expireOwned).toHaveBeenCalledTimes(1);
    expect(attempt.signal.reason).toBeInstanceOf(ExecutionTimeoutError);
  });

  it("ends the lease window at once when the claim answer arrives a full lease late", () => {
    vi.useFakeTimers({ now: 0 });
    vi.advanceTimersByTime(30_000);
    const { attempt } = startAttempt(claimedTask(), 0);

    expect(attempt.arbiter.is("lease_expired")).toBe(true);
    expect(() => attempt.requireLease()).toThrow("No heartbeat was accepted within the task lease");
  });

  it("ends the lease window at once when a heartbeat answer arrives a full lease late", () => {
    vi.useFakeTimers({ now: 0 });
    const { attempt, heartbeat } = startAttempt();

    vi.advanceTimersByTime(29_000);
    heartbeat.status!("accepted", 0);
    expect(attempt.arbiter.is("lease_expired")).toBe(false);
    vi.advanceTimersByTime(500);
    heartbeat.status!("accepted", -1_000);

    expect(attempt.arbiter.is("lease_expired")).toBe(true);
  });

  it("records the first execution outcome only", () => {
    const { attempt, activation } = startAttempt();

    attempt.recordFailure("ready");
    attempt.recordFailure("failed");

    expect(activation.outcome).toBe("retry");
    expect(attempt.arbiter.is("failed")).toBe(true);
  });
});
