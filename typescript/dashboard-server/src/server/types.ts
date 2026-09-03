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
  DashboardRedriveCursor,
  DashboardRedriveStatus,
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

/** What PostgreSQL did with one dead letter, projected for the wire. */
export interface DashboardRedriveResult {
  status: DashboardRedriveStatus;
  sourceJobId: string;
  targetJobId: string | null;
  sourceState: JobState | null;
  targetState: JobState | null;
  requestedAt: string | null;
}

/**
 * Which dead letters a filtered redrive selects.
 *
 * The fields are the dead-letter view's own filters, so an operator redrives exactly the selection
 * they are looking at. A null or empty field is not a filter, and every supplied tag must be
 * present on a task for it to be selected.
 */
export interface DashboardRedriveFilter {
  queue: string | null;
  jobType: string | null;
  tags: readonly string[];
}

/** One bounded page of a filtered redrive, oldest failure first. */
export interface DashboardRedriveBatch {
  results: DashboardRedriveResult[];
  /**
   * Where the next page of the same filter starts, or null when the selection is exhausted.
   *
   * Redriving a dead letter leaves the source failed, so the same filter selects it again. Only
   * continuing from this cursor advances through a backlog; repeating the request without one
   * would redrive the same page a second time.
   */
  nextCursor: DashboardRedriveCursor | null;
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
  /**
   * Enqueue one retained terminal failure again as a fresh task.
   *
   * The source failure is never edited, so the result names both identities and the operator can
   * follow the audited lineage edge PostgreSQL wrote between them.
   */
  redriveTask?: (jobId: string, audit: DashboardAuditContext) => Promise<DashboardRedriveResult>;
  /** Redrive a bounded page of the dead letters one filter selects. */
  redriveDeadLetters?: (
    filter: DashboardRedriveFilter,
    limit: number,
    cursor: DashboardRedriveCursor | null,
    audit: DashboardAuditContext,
  ) => Promise<DashboardRedriveBatch>;
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
