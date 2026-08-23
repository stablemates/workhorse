/**
 * The second source for `docs/parity.md`.
 *
 * The matrix in that file is prose, and prose rots. This registry restates every cell as data, and
 * `parity-matrix.test.ts` fails when the two disagree — so a capability cannot ship, or be
 * withdrawn, by editing only one of them.
 *
 * A Supported cell carries evidence: a test file in that language, and a pattern that must appear
 * inside it. That is deliberately a weaker claim than "this test proves the capability" — no
 * static check can prove that. It is the strong half of the contract that matters: you cannot mark
 * a cell Supported for a language whose test suite never mentions the thing.
 *
 * An Absent cell carries a reason instead. Recording why keeps a deliberate boundary distinguishable
 * from a gap that is merely open.
 *
 * A Planned cell carries the Plane work item that owns the gap. The document must link that item,
 * so a Planned cell cannot outlive the work it points at without someone noticing.
 */

/** Where a language's tests live, relative to the repository root. */
export const PARITY_TEST_ROOTS = {
  typescript: "typescript/core/test",
  python: "python/tests",
  go: "go",
} as const;

export type ParityLanguage = keyof typeof PARITY_TEST_ROOTS;

/** A test file that must exist, and a pattern that must appear in it. */
export interface ParityEvidence {
  file: string;
  pattern: string;
}

export type ParityCell = ParityEvidence | { absent: string } | { planned: string };

export interface ParityRow {
  /** The capability column, byte for byte as `docs/parity.md` writes it. */
  capability: string;
  typescript: ParityCell;
  python: ParityCell;
  go: ParityCell;
}

/**
 * The public operator surface is reachable through the dashboard, the `workhorse` CLI, and the
 * TypeScript and Python `Admin` clients. WH-357 adds it to the Go SDK.
 */
const pythonAdmin = { file: "test_admin.py", pattern: "admin." } as const;
const goAdmin = { planned: "WH-357" } as const;

export const PARITY_CLIENT_ROWS: readonly ParityRow[] = [
  {
    capability: "Transactional enqueue in a caller-owned tx",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "transaction" },
    python: { file: "test_enqueue.py", pattern: "transaction" },
    go: { file: "queue_test.go", pattern: "Tx" },
  },
  {
    capability: "Atomic batch enqueue",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "enqueueMany" },
    python: { file: "test_enqueue.py", pattern: "enqueue_many" },
    go: { file: "queue_test.go", pattern: "EnqueueMany" },
  },
  {
    capability: "Delayed enqueue (`runAt` / `run_at`)",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "runAt" },
    python: { file: "test_driver_integration.py", pattern: "run_at" },
    go: { file: "queue_test.go", pattern: "RunAt" },
  },
  {
    capability: "Priority",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "priority" },
    python: { file: "test_enqueue.py", pattern: "priority" },
    go: { file: "queue_test.go", pattern: "Priority" },
  },
  {
    capability: "Tags and max attempts",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "maxAttempts" },
    python: { file: "test_enqueue.py", pattern: "max_attempts" },
    go: { file: "queue_test.go", pattern: "MaxAttempts" },
  },
  {
    capability: "Persisted retry policies",
    typescript: { file: "integration-retry-attempt-lifecycle.test.ts", pattern: "retryPolicy" },
    python: { file: "test_enqueue.py", pattern: "retry_policy" },
    go: { file: "queue_test.go", pattern: "RetryPolicy" },
  },
  {
    capability: "Absolute deadlines and execution timeouts",
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "executionTimeoutMs" },
    python: { file: "test_worker.py", pattern: "execution_timeout" },
    go: { file: "queue_test.go", pattern: "ExecutionTimeout" },
  },
  {
    capability: "Enqueue idempotency",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "idempotency" },
    python: { file: "test_enqueue.py", pattern: "idempotency" },
    go: { file: "queue_test.go", pattern: "Idempotency" },
  },
  {
    capability: "Keyed debounce",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "debounce" },
    python: { file: "test_driver_integration.py", pattern: "debounce" },
    go: { file: "queue_test.go", pattern: "Debounce" },
  },
  {
    capability: "Keyed throttle",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "throttle" },
    python: { file: "test_driver_integration.py", pattern: "throttle" },
    go: { file: "queue_test.go", pattern: "Throttle" },
  },
  {
    capability: "Job dependencies with terminal policies",
    typescript: { file: "integration-dependencies.test.ts", pattern: "dependencies" },
    python: { file: "test_driver_integration.py", pattern: "dependencies" },
    go: { file: "queue_test.go", pattern: "Dependencies" },
  },
  {
    capability: "Concurrency keys",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "concurrencyKey" },
    python: { file: "test_enqueue.py", pattern: "concurrency_key" },
    go: { file: "queue_test.go", pattern: "ConcurrencyKey" },
  },
  {
    capability: "Recurring schedule definition sync",
    typescript: { file: "integration-cron-schedules.test.ts", pattern: "syncSchedules" },
    python: { file: "test_schedules.py", pattern: "sync_schedules" },
    go: { file: "queue_test.go", pattern: "SyncSchedules" },
  },
  {
    capability: "Payload and result contracts",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "contracts" },
    python: { file: "test_worker.py", pattern: "test_contract_sync_validates" },
    go: { file: "worker_test.go", pattern: "TestContractSyncValidates" },
  },
  {
    capability: "Compatibility refusal before mutation",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "schema" },
    python: { file: "test_compatibility.py", pattern: "compatib" },
    go: { file: "compatibility_test.go", pattern: "Compatibility" },
  },
  {
    capability: "SQL protocol conformance fixtures executed",
    typescript: { file: "sql-protocol-conformance.test.ts", pattern: "scenarios" },
    python: { file: "test_protocol_conformance.py", pattern: "scenarios" },
    go: { file: "conformance_test.go", pattern: "scenarios" },
  },
];

export const PARITY_WORKER_ROWS: readonly ParityRow[] = [
  {
    capability: "Claiming and handler execution",
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "claim" },
    python: { file: "test_worker.py", pattern: "handler" },
    go: { file: "worker_test.go", pattern: "Handler" },
  },
  {
    capability: "Bounded worker concurrency",
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "concurrency" },
    python: { file: "test_worker.py", pattern: "concurrency" },
    go: { file: "worker_test.go", pattern: "Concurrency" },
  },
  {
    capability: "Heartbeats, lease recovery, fenced ownership",
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "fence" },
    python: { file: "test_worker.py", pattern: "fence" },
    go: { file: "worker_test.go", pattern: "fence" },
  },
  {
    capability: "Cooperative cancellation delivery",
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "cancel" },
    python: { file: "test_worker.py", pattern: "cancel" },
    go: { file: "worker_test.go", pattern: "ancel" },
  },
  {
    capability: "Notification-assisted dispatch with polling",
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "workhorse_jobs" },
    python: { file: "test_notifications.py", pattern: "notif" },
    go: { file: "notifications_test.go", pattern: "otif" },
  },
  {
    capability: "Durable checkpoints (handler context)",
    typescript: { file: "integration-checkpoints-progress-waits.test.ts", pattern: "checkpoint" },
    python: { file: "test_worker.py", pattern: "checkpoint" },
    go: { file: "worker_test.go", pattern: "heckpoint" },
  },
  {
    capability: "Durable timers (`sleep` / `sleepUntil`)",
    typescript: { file: "integration-checkpoints-progress-waits.test.ts", pattern: "sleep" },
    python: { file: "test_worker.py", pattern: "sleep" },
    go: { file: "worker_test.go", pattern: "Sleep" },
  },
  {
    capability: "Signal and human-decision waits",
    typescript: { file: "integration-signals.test.ts", pattern: "signal" },
    python: { file: "test_worker_external_waits.py", pattern: "signal" },
    go: { file: "external_waits_test.go", pattern: "ignal" },
  },
  {
    capability: "Linked child fan-out and result join",
    typescript: { file: "integration-child-jobs.test.ts", pattern: "child" },
    python: { file: "test_worker_child_jobs.py", pattern: "child" },
    go: { file: "child_jobs_test.go", pattern: "hild" },
  },
  {
    capability: "Latest-value progress reporting",
    typescript: { file: "integration-checkpoints-progress-waits.test.ts", pattern: "progress" },
    python: { file: "test_worker.py", pattern: "progress" },
    go: { file: "worker_test.go", pattern: "Progress" },
  },
  {
    capability: "Batch handler delivery",
    typescript: { file: "integration-batch-handlers.test.ts", pattern: "batch" },
    python: { file: "test_worker.py", pattern: "batch" },
    go: { file: "batch_test.go", pattern: "atch" },
  },
  {
    capability: "Schedule firing (database cron evaluation)",
    typescript: { file: "integration-cron-schedules.test.ts", pattern: "fireSchedule" },
    python: { file: "test_worker_schedules.py", pattern: "schedule" },
    go: { file: "worker_schedules_test.go", pattern: "chedule" },
  },
  {
    capability: "Worker fleet registration and remote pause",
    typescript: { file: "integration-worker-registry.test.ts", pattern: "register" },
    python: { file: "test_worker.py", pattern: "registry_delivers_remote_pause" },
    go: { file: "worker_test.go", pattern: "RegistryDeliversRemotePause" },
  },
  {
    capability: "Graceful stop and signal drain",
    typescript: { file: "worker-process.test.ts", pattern: "drain" },
    python: { file: "test_worker_process.py", pattern: "drain" },
    go: { file: "worker_process_test.go", pattern: "rain" },
  },
  {
    capability: "Retention maintenance participation",
    typescript: { file: "integration-retention-maintenance.test.ts", pattern: "retain" },
    python: { file: "test_worker.py", pattern: "participates_in_slow_maintenance" },
    go: { file: "worker_test.go", pattern: "ParticipatesInSlowMaintenance" },
  },
  {
    capability: "OpenTelemetry tracing and metrics",
    typescript: { file: "telemetry.test.ts", pattern: "span" },
    python: { file: "test_worker_telemetry.py", pattern: "span" },
    go: { file: "telemetry_test.go", pattern: "pan" },
  },
  {
    capability: "Shared runtime fixtures executed",
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "runtime" },
    python: { file: "test_worker_runtime_conformance.py", pattern: "runtime" },
    go: { file: "runtime_conformance_test.go", pattern: "untime" },
  },
];

export const PARITY_OPERATOR_ROWS: readonly ParityRow[] = [
  {
    capability: "Job lookup, listing, and timeline",
    typescript: { file: "integration-operator-reads.test.ts", pattern: "admin.listJobs" },
    python: pythonAdmin,
    go: goAdmin,
  },
  {
    capability: "Queue health snapshot",
    typescript: { file: "integration-health-snapshots.test.ts", pattern: "health" },
    python: { file: "test_driver_integration.py", pattern: "health" },
    go: { file: "queue_test.go", pattern: "Health" },
  },
  {
    capability: "Cancellation requests",
    typescript: { file: "integration-operator-reads.test.ts", pattern: "cancel" },
    python: { file: "test_worker_runtime_conformance.py", pattern: "cancel" },
    go: { file: "worker_test.go", pattern: "Cancel" },
  },
  {
    capability: "Queue pause, resume, and purge",
    typescript: { file: "integration-queue-administration.test.ts", pattern: "admin.purgeQueue" },
    python: pythonAdmin,
    go: goAdmin,
  },
  {
    capability: "Dead-letter listing and redrive",
    typescript: { file: "integration-operator-reads.test.ts", pattern: "admin.redrive" },
    python: pythonAdmin,
    go: goAdmin,
  },
  {
    capability: "Checkpoint, wait, and human-decision reads",
    typescript: { file: "integration-human-waits.test.ts", pattern: "admin.listHumanWaits" },
    python: pythonAdmin,
    go: goAdmin,
  },
  {
    capability: "Durable operator worker pause",
    typescript: { file: "integration-worker-registry.test.ts", pattern: "paused" },
    python: pythonAdmin,
    go: goAdmin,
  },
];

/** The three tables, in the order `docs/parity.md` prints them. */
export const PARITY_TABLES: readonly (readonly ParityRow[])[] = [
  PARITY_CLIENT_ROWS,
  PARITY_WORKER_ROWS,
  PARITY_OPERATOR_ROWS,
];
