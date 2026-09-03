import type {
  CancelStatus,
  HumanWaitCompletionStatus,
  Json,
  JobState,
  MaintenancePolicyDefinition,
  MaintenancePolicySetting,
  RetentionPolicyDefinition,
  RetentionPolicySetting,
  SignalDeliveryStatus,
} from "@stablemates/workhorse";
import type {
  DashboardDemoFeature,
  DashboardDemoJobKind,
  DashboardDemoScenario,
  DashboardDurabilityPlan,
  DashboardRunNowStatus,
} from "../wire.js";

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
  mode: "read-only" | "writable";
  enqueueTest?: (
    kind: DashboardDemoJobKind,
    audit: DashboardAuditContext,
    scenario?: DashboardDemoScenario,
    priority?: number,
    feature?: DashboardDemoFeature,
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

export interface DashboardSignalTaskResult {
  status: SignalDeliveryStatus;
  jobId: string;
  name: string;
  payload: Json | null;
  deliveredAt: string | null;
  deliveredBy: string | null;
}

export interface DashboardCompleteHumanWaitResult {
  status: HumanWaitCompletionStatus;
  jobId: string;
  name: string;
  result: Json | null;
  completedAt: string | null;
  completedBy: string | null;
}

export interface DashboardTaskController {
  runTaskNow?: (jobId: string, audit: DashboardAuditContext) => Promise<DashboardRunNowResult>;
  cancelTask?: (
    jobId: string,
    audit: DashboardCancellationAuditContext,
  ) => Promise<DashboardCancelTaskResult>;
  signalTask?: (
    jobId: string,
    name: string,
    payload: Json,
    idempotencyKey: string,
    audit: DashboardAuditContext,
  ) => Promise<DashboardSignalTaskResult>;
  completeHumanWait?: (
    jobId: string,
    name: string,
    result: Json,
    idempotencyKey: string,
    audit: DashboardAuditContext,
  ) => Promise<DashboardCompleteHumanWaitResult>;
}

/**
 * Operator control over the worker fleet.
 *
 * Worker identity and runtime state are read through `workhorse.dashboard_worker_registry_v1`
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

export interface DashboardSettingsController {
  overrideMaintenancePolicy(
    definition: Partial<MaintenancePolicyDefinition>,
    audit: DashboardAuditContext,
  ): Promise<void>;
  revertMaintenancePolicy(
    settings: readonly MaintenancePolicySetting[],
    audit: DashboardAuditContext,
  ): Promise<void>;
  overrideRetentionPolicy(
    definition: Partial<RetentionPolicyDefinition>,
    audit: DashboardAuditContext,
  ): Promise<void>;
  revertRetentionPolicy(
    settings: readonly RetentionPolicySetting[],
    audit: DashboardAuditContext,
  ): Promise<void>;
}

export type DashboardDurabilityProjector = (
  type: string,
  payload: unknown,
) => DashboardDurabilityPlan | null;
