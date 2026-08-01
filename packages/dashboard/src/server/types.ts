import type { CancelStatus, JobState } from "@workhorse/core";
import type { DashboardDemoJobKind, DashboardDemoScenario } from "../client.js";
import type { DashboardDurabilityPlan } from "../model.js";

export interface DashboardAuditContext {
  actor: string;
  reason: string;
  requestId: string;
  occurredAt?: string;
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

export interface DashboardTaskController {
  cancelTask?: (jobId: string, audit: DashboardAuditContext) => Promise<DashboardCancelTaskResult>;
}

export interface DashboardWorkerRuntimeState {
  paused: boolean;
  concurrency: number;
  activeSlots: number;
  draining: boolean;
}

export interface DashboardWorkerController {
  workerStates(): ReadonlyMap<string, DashboardWorkerRuntimeState>;
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
