import type { CancelStatus, JobState } from "@workhorse/core";
import type { DashboardDemoJobKind, DashboardDemoScenario } from "../client.js";
import type { DashboardDurabilityPlan, DashboardRunNowStatus } from "../model.js";

export interface DashboardAuditContext {
  actor: string;
  reason: string;
  requestId: string;
  occurredAt?: string;
}

export interface DashboardCancellationAuditContext extends Omit<DashboardAuditContext, "reason"> {
  reason: string | null;
}

export interface DashboardOperator {
  mode: "read-only" | "local";
  enqueueTest?: (
    kind: DashboardDemoJobKind,
    audit: DashboardAuditContext,
    scenario?: DashboardDemoScenario,
  ) => Promise<{ jobId: string }>;
}

export interface DashboardScheduleController {
  setScheduleEnabled?: (
    namespace: string,
    name: string,
    enabled: boolean,
    audit: DashboardAuditContext,
  ) => Promise<{ enabled: boolean }>;
}

export interface DashboardQueueController {
  setQueuePaused?: (
    queueName: string,
    paused: boolean,
    audit: DashboardAuditContext,
  ) => Promise<{ paused: boolean }>;
  purgeQueue?: (
    queueName: string,
    audit: DashboardAuditContext,
  ) => Promise<{ deletedCount: number }>;
}

export interface DashboardCancelTaskResult {
  status: CancelStatus;
  jobId: string;
  state: JobState | null;
  currentAttempt: number | null;
  requestedAt: string | null;
  requestedBy: string | null;
  reason: string | null;
  finishedAt: string | null;
}

export interface DashboardRunNowResult {
  status: DashboardRunNowStatus;
  id: string;
  state: string | null;
  runAt: string | null;
}

export interface DashboardTaskController {
  runTaskNow?: (jobId: string, audit: DashboardAuditContext) => Promise<DashboardRunNowResult>;
  cancelTask?: (
    jobId: string,
    audit: DashboardCancellationAuditContext,
  ) => Promise<DashboardCancelTaskResult>;
}

/**
 * Operator control over the worker fleet.
 *
 * Worker identity and runtime state are read from the durable `workhorse.worker_registry`
 * relation, so the dashboard reports every live worker whether or not it shares a process with
 * the host application. This controller exists only so the host can wrap the pause mutation in
 * its own audit and authorization; omit it for a read-only deployment.
 */
export interface DashboardWorkerController {
  setWorkerPaused?: (
    workerId: string,
    paused: boolean,
    audit: DashboardAuditContext,
  ) => Promise<{ paused: boolean }>;
}

export type DashboardDurabilityProjector = (
  type: string,
  payload: unknown,
) => DashboardDurabilityPlan | null;
