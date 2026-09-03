import type { Admin, Queue } from "@stablemates/workhorse";
import type { DeadLetterFilter, Json, RedriveResult } from "@stablemates/workhorse";
import type { DashboardRedriveCursor } from "../wire.js";
import type {
  DashboardAuditContext,
  DashboardCancellationAuditContext,
  DashboardQueueController,
  DashboardRedriveFilter,
  DashboardRedriveResult,
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
  | { kind: "redriveTask"; jobId: string; audit: DashboardAuditContext }
  | {
      kind: "redriveDeadLetters";
      filter: DashboardRedriveFilter;
      limit: number;
      cursor: DashboardRedriveCursor | null;
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
   * Supplies the executor used for one mutation and owns any host-specific transaction or audit work.
   */
  run<T>(
    action: DashboardOperatorAction,
    operation: (clients: { admin: Admin; queue: Queue }) => Promise<T>,
  ): Promise<T>;
  /** Override browser attribution when the host has a trusted configured actor. */
  requestedBy?: string;
}

export interface DashboardOperatorControllers {
  operator: { mode: "writable" };
  queueController: DashboardQueueController;
  taskController: DashboardTaskController;
  workerController: DashboardWorkerController;
}

function isoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function redriveResult(result: RedriveResult): DashboardRedriveResult {
  return { ...result, requestedAt: isoTimestamp(result.requestedAt) };
}

/**
 * Drop the fields a dead-letter selection did not constrain.
 *
 * `Admin.redriveMany` treats an absent key as "no filter" and rejects an empty one, so a view that
 * is filtering by nothing has to send nothing rather than a null or an empty list.
 */
function deadLetterFilter(filter: DashboardRedriveFilter): DeadLetterFilter {
  return {
    ...(filter.queue === null ? {} : { queue: filter.queue }),
    ...(filter.jobType === null ? {} : { type: filter.jobType }),
    ...(filter.tags.length === 0 ? {} : { tags: [...filter.tags] }),
  };
}

/**
 * Build the Admin- and Queue-backed dashboard mutations shared by embedded and standalone hosts.
 *
 * The factory owns client calls and wire projection. The injected runner owns the host's audit and
 * transaction boundary, so an embedded application can keep mutation and audit rows atomic while
 * the standalone CLI can use its already-owned clients directly.
 */
export function createDashboardOperatorControllers(
  options: DashboardOperatorControllerOptions,
): DashboardOperatorControllers {
  const requestedBy = (audit: Pick<DashboardAuditContext, "actor">): string =>
    options.requestedBy ?? audit.actor;

  return {
    operator: { mode: "writable" },
    queueController: {
      setQueuePaused: (queueName, paused, audit) =>
        options.run({ kind: "setQueuePaused", queueName, paused, audit }, async ({ admin }) => {
          if (paused) await admin.pauseQueue(queueName, audit);
          else await admin.resumeQueue(queueName, audit);
          return { paused };
        }),
      purgeQueue: (queueName, audit) =>
        options.run({ kind: "purgeQueue", queueName, audit }, async ({ admin }) => ({
          deletedCount: await admin.purgeQueue(queueName, audit),
        })),
    },
    taskController: {
      runTaskNow: (jobId, audit) =>
        options.run({ kind: "runTaskNow", jobId, audit }, async ({ admin }) => {
          const result = await admin.runTaskNow(jobId, audit);
          return {
            status: result.status,
            id: result.jobId,
            state: result.state,
            runAt: isoTimestamp(result.runAt),
          };
        }),
      cancelTask: (jobId, audit) =>
        options.run({ kind: "cancelTask", jobId, audit }, async ({ queue }) => {
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
          async ({ queue }) => {
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
          async ({ queue }) => {
            const completed = await queue.completeHumanWait(jobId, name, result, {
              idempotencyKey,
              requestedBy: requestedBy(audit),
            });
            const { payload, ...completion } = completed;
            return {
              ...completion,
              result: payload,
              completedAt: isoTimestamp(completed.completedAt),
            };
          },
        ),
      redriveTask: (jobId, audit) =>
        options.run({ kind: "redriveTask", jobId, audit }, async ({ admin }) =>
          redriveResult(await admin.redrive(jobId, { ...audit, actor: requestedBy(audit) })),
        ),
      redriveDeadLetters: (filter, limit, cursor, audit) =>
        options.run(
          { kind: "redriveDeadLetters", filter, limit, cursor, audit },
          async ({ admin }) => {
            const page = await admin.redriveMany(
              deadLetterFilter(filter),
              { ...audit, actor: requestedBy(audit) },
              { limit, ...(cursor === null ? {} : { cursor }) },
            );
            return { results: page.results.map(redriveResult), nextCursor: page.nextCursor };
          },
        ),
    },
    workerController: {
      setWorkerPaused: (workerId, paused, audit) =>
        options.run({ kind: "setWorkerPaused", workerId, paused, audit }, async ({ admin }) => {
          const result = await admin.setWorkerPaused(workerId, paused, {
            ...audit,
            actor: requestedBy(audit),
          });
          if (!result) throw new Error(`Worker ${workerId} is not registered`);
          return { paused: result.paused };
        }),
    },
  };
}
