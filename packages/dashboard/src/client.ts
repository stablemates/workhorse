import type {
  DashboardActivityGroupBy,
  DashboardActivityPage,
  DashboardActivityPeriod,
  DashboardCancelStatus,
  DashboardCronPage,
  DashboardJobDetail,
  DashboardQueuesPage,
  DashboardSystemPage,
  DashboardSystemWindow,
  DashboardTaskCounts,
  DashboardTaskFacets,
  DashboardTaskFilter,
  DashboardTasksPage,
  DashboardWorkersPage,
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
  cron(): Promise<DashboardCronPage>;
  queues(): Promise<DashboardQueuesPage>;
  system(input: { window?: DashboardSystemWindow }): Promise<DashboardSystemPage>;
  workers(): Promise<DashboardWorkersPage>;
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
  cancelTask(input: { id: string; audit: DashboardCancellationAuditInput }): Promise<{
    status: DashboardCancelStatus;
    state: string | null;
    finishedAt: string | null;
    requestedAt: string | null;
  }>;
}
