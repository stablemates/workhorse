import type {
  MaintenancePolicyDefinition,
  MaintenancePolicySetting,
  RetentionPolicyDefinition,
  RetentionPolicySetting,
  RetentionPolicyImpact,
} from "@workhorse/core";
import type {
  DashboardActivityGroupBy,
  DashboardActivityPage,
  DashboardActivityPeriod,
  DashboardCancelStatus,
  DashboardCronPage,
  DashboardEventDetail,
  DashboardEventKind,
  DashboardEventsPage,
  DashboardEventsWindow,
  DashboardJobDetail,
  DashboardQueuesPage,
  DashboardRunNowStatus,
  DashboardSystemPage,
  DashboardSystemWindow,
  DashboardTaskCounts,
  DashboardTaskFacets,
  DashboardTaskFilter,
  DashboardTasksPage,
  DashboardWorkersPage,
  DashboardSettingsPage,
} from "./model.js";
import type { TaskPageSize } from "./task-location.js";

export interface DashboardAuditInput {
  actor: string;
  reason: string;
  requestId: string;
}

export interface DashboardCancellationAuditInput extends Omit<DashboardAuditInput, "reason"> {
  reason?: string | null;
}

export type DashboardDemoJobKind =
  | "success"
  | "retry"
  | "durable"
  | "timer"
  | "failure"
  | "idempotent"
  | "long-running";

export type DashboardDemoScenario =
  | "order-fulfillment"
  | "customer-onboarding"
  | "report-publication";

/** Optional demo-only actions. Production hosts can omit this capability entirely. */
export interface DashboardDemoTools {
  enqueueTest(input: {
    kind: DashboardDemoJobKind;
    scenario?: DashboardDemoScenario;
    audit: DashboardAuditInput;
  }): Promise<unknown>;
}

/**
 * Transport-neutral boundary consumed by the React dashboard.
 *
 * Applications can implement this interface with oRPC, fetch, GraphQL, an Electron bridge, or any
 * other JavaScript transport. The dashboard package never imports the demo server or its router.
 */
export interface DashboardClient {
  meta(): Promise<{ environment: string }>;
  taskCounts(): Promise<DashboardTaskCounts>;
  tasks(input: {
    filter?: DashboardTaskFilter;
    queue?: string | null;
    page?: number;
    worker?: string | null;
    jobType?: string | null;
    tags?: string[];
    search?: string;
    pageSize?: TaskPageSize;
  }): Promise<DashboardTasksPage>;
  taskFacets(): Promise<DashboardTaskFacets>;
  activity(input: {
    filter?: DashboardTaskFilter;
    period?: DashboardActivityPeriod;
    groupBy?: DashboardActivityGroupBy;
    tags?: string[];
    queue?: string | null;
    worker?: string | null;
  }): Promise<DashboardActivityPage>;
  /** Fleet-wide append-only history, newest first, bounded by a window and paged by offset. */
  events(input: {
    window?: DashboardEventsWindow;
    page?: number;
    pageSize?: 25 | 50 | 100;
    kind?: DashboardEventKind | "all";
    queue?: string | null;
    jobType?: string | null;
    types?: string[];
    jobId?: string | null;
  }): Promise<DashboardEventsPage>;
  /** One durable history record, independent of its current position in the moving feed. */
  eventDetail(input: { id: string }): Promise<DashboardEventDetail>;
  cron(): Promise<DashboardCronPage>;
  queues(): Promise<DashboardQueuesPage>;
  system(input: { window?: DashboardSystemWindow }): Promise<DashboardSystemPage>;
  workers(): Promise<DashboardWorkersPage>;
  settings(): Promise<DashboardSettingsPage>;
  previewRetentionPolicy(input: {
    definition: Partial<RetentionPolicyDefinition>;
  }): Promise<RetentionPolicyImpact>;
  jobDetail(input: { id: string }): Promise<DashboardJobDetail>;
  setScheduleEnabled(input: {
    kind: "user";
    namespace: string;
    name: string;
    enabled: boolean;
    audit: DashboardAuditInput;
  }): Promise<unknown>;
  setQueuePaused(input: {
    queue: string;
    paused: boolean;
    audit: DashboardAuditInput;
  }): Promise<unknown>;
  purgeQueue(input: {
    queue: string;
    audit: DashboardAuditInput;
  }): Promise<{ deletedCount: number }>;
  setWorkerPaused(input: {
    workerId: string;
    paused: boolean;
    audit: DashboardAuditInput;
  }): Promise<unknown>;
  overrideMaintenancePolicy(input: {
    definition: Partial<MaintenancePolicyDefinition>;
    audit: DashboardAuditInput;
  }): Promise<void>;
  revertMaintenancePolicy(input: {
    settings: MaintenancePolicySetting[];
    audit: DashboardAuditInput;
  }): Promise<void>;
  overrideRetentionPolicy(input: {
    definition: Partial<RetentionPolicyDefinition>;
    audit: DashboardAuditInput;
  }): Promise<void>;
  revertRetentionPolicy(input: {
    settings: RetentionPolicySetting[];
    audit: DashboardAuditInput;
  }): Promise<void>;
  cancelTask(input: { id: string; audit: DashboardCancellationAuditInput }): Promise<{
    status: DashboardCancelStatus;
    state: string | null;
    finishedAt: string | null;
    requestedAt: string | null;
  }>;
  /**
   * Release one scheduled task so a worker can claim it now.
   *
   * This moves only that task's own start time forward. It does not execute the handler in this
   * request, and for a task a recurring schedule created it leaves the schedule's next occurrence
   * exactly where it was. A task suspended at a durable wait is refused with `waiting`, because
   * that boundary belongs to the handler that asked for it.
   *
   * Optional, because a host that cannot mutate task scheduling should be able to omit it rather
   * than implement a method that always throws. The dashboard keeps the action visible but disabled
   * and explains that the connected host does not support it.
   */
  runTaskNow?(input: { id: string; audit: DashboardAuditInput }): Promise<{
    status: DashboardRunNowStatus;
    id: string;
    state: string | null;
    runAt: string | null;
  }>;
}
