import { SQL_STATEMENTS } from "../queue/sql-catalogue.generated.js";
import type { Pool } from "pg";
import { expectOneRow } from "../errors.js";
import { Admin, Queue } from "../index.js";
import type {
  CancelResult,
  DeadLetterPage,
  DeadLetterQuery,
  JobCheckpoint,
  JobListPage,
  JobListQuery,
  JobSnapshot,
  JobTimelinePage,
  JobTimelineQuery,
  JobWait,
  MaintenancePolicy,
  QueueHealth,
  RedriveResult,
  RetentionPolicy,
  WorkerRegistryEntry,
} from "../types.js";
import type { StoredSchedule } from "../queue/cron-schedules.js";
import type { ExternalWaitCursor } from "../queue/external-waits.js";
import type { HumanWaitPage } from "../queue/human-waits.js";
import type { SignalWaitPage } from "../queue/signals.js";

/**
 * A refused administrative operation. The refusal is a safety outcome, not malformed usage, so
 * callers report it and exit 1 rather than the usage exit code.
 */
export class AdminSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminSafetyError";
  }
}

/**
 * Proof that the operator named the connected database explicitly.
 *
 * Only {@link WorkhorseAdminClient.confirmEnvironment} constructs one, so every mutation method can
 * demand the check at compile time. The CLI and the TUI both go through this same gate.
 */
export interface ConfirmedEnvironment {
  readonly database: string;
}

/** Compact per-queue status for operators: dispatch pressure plus the durable pause flag. */
export interface AdminQueueStatus {
  queue: string;
  paused: boolean;
  readyDepth: number;
  scheduledDepth: number;
  activeLeases: number;
  blockedReadyDepth: number;
  oldestReadyAgeMs: number | null;
  concurrencyLimit: number | null;
  concurrencyActive: number;
  rateLimitPerSecond: number | null;
  rateLimitThrottledReadyDepth: number;
}

/**
 * One page of every boundary the fleet is waiting on an outside party to answer.
 *
 * The two kinds page independently because each carries the dashboard's own
 * {@link ExternalWaitCursor}, which is scoped to one list.
 */
export interface AdminExternalWaits {
  human: HumanWaitPage;
  signal: SignalWaitPage;
}

/** Continuation state for one {@link WorkhorseAdminClient.externalWaits} call. */
export interface AdminExternalWaitQuery {
  limit?: number;
  humanCursor?: ExternalWaitCursor;
  signalCursor?: ExternalWaitCursor;
}

export interface AdminMaintenanceState {
  maintenancePolicy: MaintenancePolicy;
  retentionPolicy: RetentionPolicy;
}

export interface AdminCancelRequest {
  requestedBy: string;
  reason?: string;
}

export interface AdminRedriveRequest {
  requestedBy: string;
  reason: string;
  requestId: string;
}

export type AdminControlRequest = AdminRedriveRequest;

/**
 * The administrative surface shared by `workhorse admin` and `workhorse tui`.
 *
 * The client composes the public {@link Admin} operator API with {@link Queue} application
 * controls plus two reads of existing operator tables. Every mutation
 * requires a {@link ConfirmedEnvironment}, so no front end can reach a destructive operation
 * without the explicit-target check.
 */
export class WorkhorseAdminClient {
  readonly admin: Admin;
  readonly queue: Queue;

  constructor(private readonly pool: Pool) {
    this.admin = new Admin(pool);
    this.queue = new Queue(pool);
  }

  /** The connected database's own name, which the environment confirmation must match. */
  async targetDatabase(): Promise<string> {
    const result = await this.pool.query<{ database: string }>(SQL_STATEMENTS["current_database"]);
    return expectOneRow(result, "current_database").database;
  }

  /**
   * Verify that the operator-supplied environment names the connected database.
   *
   * The returned token is the only key that unlocks mutation methods. A mismatch is an
   * {@link AdminSafetyError}: the likely cause is an ambient database URL pointing somewhere the
   * operator did not intend.
   */
  async confirmEnvironment(environment: string): Promise<ConfirmedEnvironment> {
    const database = await this.targetDatabase();
    if (environment !== database) {
      throw new AdminSafetyError(
        `--env "${environment}" does not match the connected database "${database}". ` +
          "Refusing to mutate a database the command did not name.",
      );
    }
    return { database };
  }

  listJobs(query: JobListQuery = {}): Promise<JobListPage> {
    return this.admin.listJobs(query);
  }

  getJob(jobId: string): Promise<JobSnapshot | null> {
    return this.admin.getJob(jobId);
  }

  getJobTimeline(jobId: string, query: JobTimelineQuery = {}): Promise<JobTimelinePage> {
    return this.admin.getJobTimeline(jobId, query);
  }

  listDeadLetters(query: DeadLetterQuery = {}): Promise<DeadLetterPage> {
    return this.admin.listDeadLetters(query);
  }

  listCheckpoints(jobId: string): Promise<JobCheckpoint[]> {
    return this.admin.listCheckpoints(jobId);
  }

  getCheckpoint(jobId: string, name: string): Promise<JobCheckpoint | null> {
    return this.admin.getCheckpoint(jobId, name);
  }

  listWaits(jobId: string): Promise<JobWait[]> {
    return this.admin.listWaits(jobId);
  }

  getWait(jobId: string, name: string): Promise<JobWait | null> {
    return this.admin.getWait(jobId, name);
  }

  /**
   * Both external-wait lists, fleet-wide, in one round trip.
   *
   * A stalled durable handler is waiting either on a person or on a signal, and an operator
   * asking "what is the fleet waiting on" wants both answers at once.
   */
  async externalWaits(query: AdminExternalWaitQuery = {}): Promise<AdminExternalWaits> {
    const [human, signal] = await Promise.all([
      this.admin.listHumanWaits({ limit: query.limit, cursor: query.humanCursor }),
      this.admin.listSignalWaits({ limit: query.limit, cursor: query.signalCursor }),
    ]);
    return { human, signal };
  }

  /**
   * Per-queue dispatch pressure merged with the durable pause flag.
   *
   * A paused queue with no live jobs still appears, so an operator can always see and release an
   * old pause.
   */
  async queues(): Promise<AdminQueueStatus[]> {
    const [snapshots, control] = await Promise.all([
      this.admin.queueMetricSnapshot(),
      this.pool.query<{ queue_name: string; paused: boolean }>(SQL_STATEMENTS["queue_control"]),
    ]);
    const pausedByQueue = new Map(control.rows.map((row) => [row.queue_name, row.paused]));
    const statuses = new Map<string, AdminQueueStatus>();
    for (const snapshot of snapshots) {
      statuses.set(snapshot.queue, {
        queue: snapshot.queue,
        paused: pausedByQueue.get(snapshot.queue) ?? false,
        readyDepth: snapshot.readyDepth,
        scheduledDepth: snapshot.scheduledDepth,
        activeLeases: snapshot.activeLeases,
        blockedReadyDepth: snapshot.blockedReadyDepth,
        oldestReadyAgeMs: snapshot.oldestReadyAgeMs,
        concurrencyLimit: snapshot.concurrencyLimit,
        concurrencyActive: snapshot.concurrencyActive,
        rateLimitPerSecond: snapshot.rateLimitPerSecond,
        rateLimitThrottledReadyDepth: snapshot.rateLimitThrottledReadyDepth,
      });
    }
    for (const [queueName, paused] of pausedByQueue) {
      if (!paused || statuses.has(queueName)) continue;
      statuses.set(queueName, {
        queue: queueName,
        paused: true,
        readyDepth: 0,
        scheduledDepth: 0,
        activeLeases: 0,
        blockedReadyDepth: 0,
        oldestReadyAgeMs: null,
        concurrencyLimit: null,
        concurrencyActive: 0,
        rateLimitPerSecond: null,
        rateLimitThrottledReadyDepth: 0,
      });
    }
    return [...statuses.values()].toSorted((left, right) => left.queue.localeCompare(right.queue));
  }

  /**
   * Enabled recurring schedules. Without explicit namespaces, every persisted namespace is
   * listed.
   */
  async schedules(namespaces?: readonly string[]): Promise<StoredSchedule[]> {
    let targets = namespaces;
    if (targets === undefined || targets.length === 0) {
      const result = await this.pool.query<{ namespace: string }>(
        SQL_STATEMENTS["schedule_definition"],
      );
      targets = result.rows.map((row) => row.namespace);
    }
    return this.admin.schedules(targets);
  }

  workers(): Promise<WorkerRegistryEntry[]> {
    return this.admin.listWorkers();
  }

  health(): Promise<QueueHealth> {
    return this.admin.health();
  }

  async maintenance(): Promise<AdminMaintenanceState> {
    const [maintenancePolicy, retentionPolicy] = await Promise.all([
      this.admin.getMaintenancePolicy(),
      this.admin.getRetentionPolicy(),
    ]);
    return { maintenancePolicy, retentionPolicy };
  }

  cancel(
    environment: ConfirmedEnvironment,
    jobId: string,
    request: AdminCancelRequest,
  ): Promise<CancelResult> {
    void environment;
    return this.queue.cancel(jobId, request);
  }

  redrive(
    environment: ConfirmedEnvironment,
    jobId: string,
    request: AdminRedriveRequest,
  ): Promise<RedriveResult> {
    void environment;
    return this.admin.redrive(jobId, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
  }

  async pauseQueue(
    environment: ConfirmedEnvironment,
    queueName: string,
    request: AdminControlRequest,
  ): Promise<void> {
    void environment;
    await this.admin.pauseQueue(queueName, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
  }

  async resumeQueue(
    environment: ConfirmedEnvironment,
    queueName: string,
    request: AdminControlRequest,
  ): Promise<void> {
    void environment;
    await this.admin.resumeQueue(queueName, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
  }

  /** Deletes one queue's non-active jobs and answers how many rows went. */
  purgeQueue(
    environment: ConfirmedEnvironment,
    queueName: string,
    request: AdminControlRequest,
  ): Promise<number> {
    void environment;
    return this.admin.purgeQueue(queueName, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
  }
}
