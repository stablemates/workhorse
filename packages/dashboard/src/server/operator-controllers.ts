import type { Queue } from "@workhorse/core";
import type { Json } from "@workhorse/core";
import type {
  DashboardAuditContext,
  DashboardCancellationAuditContext,
  DashboardQueueController,
  DashboardTaskController,
  DashboardWorkerController,
} from "./types.js";

export type DashboardOperatorAction =
  | {
      kind: "setQueuePaused";
      queueName: string;
      paused: boolean;
      audit: DashboardAuditContext;
    }
  | { kind: "purgeQueue"; queueName: string; audit: DashboardAuditContext }
  | { kind: "runTaskNow"; jobId: string; audit: DashboardAuditContext }
  | { kind: "cancelTask"; jobId: string; audit: DashboardCancellationAuditContext }
  | {
      kind: "signalTask";
      jobId: string;
      name: string;
      payload: Json;
      idempotencyKey: string;
      audit: DashboardAuditContext;
    }
  | {
      kind: "completeHumanWait";
      jobId: string;
      name: string;
      result: Json;
      idempotencyKey: string;
      audit: DashboardAuditContext;
    }
  | {
      kind: "setWorkerPaused";
      workerId: string;
      paused: boolean;
      audit: DashboardAuditContext;
    };

export interface DashboardOperatorControllerOptions {
  /**
   * Supplies the Queue used for one mutation and owns any host-specific transaction or audit work.
   */
  run<T>(action: DashboardOperatorAction, operation: (queue: Queue) => Promise<T>): Promise<T>;
  /** Override browser attribution when the host has a trusted configured actor. */
  requestedBy?: string;
}

export interface DashboardOperatorControllers {
  operator: { mode: "local" };
  queueController: DashboardQueueController;
  taskController: DashboardTaskController;
  workerController: DashboardWorkerController;
}

function isoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * Build the Queue-backed dashboard mutations shared by embedded and standalone hosts.
 *
 * The factory owns Queue calls and wire projection. The injected runner owns the host's audit and
 * transaction boundary, so an embedded application can keep mutation and audit rows atomic while
 * the standalone CLI can use its already-owned Queue directly.
 */
export function createDashboardOperatorControllers(
  options: DashboardOperatorControllerOptions,
): DashboardOperatorControllers {
  const requestedBy = (audit: Pick<DashboardAuditContext, "actor">): string =>
    options.requestedBy ?? audit.actor;

  return {
    operator: { mode: "local" },
    queueController: {
      setQueuePaused: (queueName, paused, audit) =>
        options.run({ kind: "setQueuePaused", queueName, paused, audit }, async (queue) => {
          if (paused) await queue.pauseQueue(queueName);
          else await queue.resumeQueue(queueName);
          return { paused };
        }),
      purgeQueue: (queueName, audit) =>
        options.run({ kind: "purgeQueue", queueName, audit }, async (queue) => ({
          deletedCount: await queue.purgeQueue(queueName),
        })),
    },
    taskController: {
      runTaskNow: (jobId, audit) =>
        options.run({ kind: "runTaskNow", jobId, audit }, async (queue) => {
          const result = await queue.runTaskNow(jobId);
          return {
            status: result.status,
            id: result.jobId,
            state: result.state,
            runAt: isoTimestamp(result.runAt),
          };
        }),
      cancelTask: (jobId, audit) =>
        options.run({ kind: "cancelTask", jobId, audit }, async (queue) => {
          const result = await queue.cancel(jobId, {
            requestedBy: requestedBy(audit),
            reason: audit.reason ?? undefined,
          });
          return {
            status: result.status,
            jobId: result.jobId,
            state: result.state,
            currentAttempt: result.currentAttempt,
            requestedAt: isoTimestamp(result.requestedAt),
            requestedBy: result.requestedBy,
            reason: result.reason,
            finishedAt: isoTimestamp(result.finishedAt),
          };
        }),
      signalTask: (jobId, name, payload, idempotencyKey, audit) =>
        options.run(
          { kind: "signalTask", jobId, name, payload, idempotencyKey, audit },
          async (queue) => {
            const result = await queue.sendSignal(jobId, name, payload, {
              idempotencyKey,
              requestedBy: requestedBy(audit),
            });
            return {
              ...result,
              deliveredAt: isoTimestamp(result.deliveredAt),
            };
          },
        ),
      completeHumanWait: (jobId, name, result, idempotencyKey, audit) =>
        options.run(
          { kind: "completeHumanWait", jobId, name, result, idempotencyKey, audit },
          async (queue) => {
            const completed = await queue.completeHumanWait(jobId, name, result, {
              idempotencyKey,
              completedBy: requestedBy(audit),
            });
            return { ...completed, completedAt: isoTimestamp(completed.completedAt) };
          },
        ),
    },
    workerController: {
      setWorkerPaused: (workerId, paused, audit) =>
        options.run({ kind: "setWorkerPaused", workerId, paused, audit }, async (queue) => {
          const result = await queue.setWorkerPaused(workerId, paused, {
            requestedBy: requestedBy(audit),
            reason: audit.reason,
          });
          if (!result) throw new Error(`Worker ${workerId} is not registered`);
          return { paused: result.paused };
        }),
    },
  };
}
