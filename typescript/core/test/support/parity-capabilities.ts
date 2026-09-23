/**
 * The source for the generated language tables in `docs/parity.md`.
 *
 * `scripts/generate-parity-tables.ts` renders every cell from this registry. Its check mode fails
 * when the checked-in document is stale, so a capability cannot ship or be withdrawn by editing
 * prose separately.
 *
 * A Supported cell carries evidence: a test file in that language, and patterns that must appear
 * inside it. That is deliberately a weaker claim than "this test proves the capability" — no
 * static check can prove that. It is the strong half of the contract that matters: you cannot mark
 * a cell Supported for a language whose test suite never mentions the thing.
 *
 * An Absent cell carries a reason instead. Recording why keeps a deliberate boundary distinguishable
 * from a gap that is merely open.
 *
 * A Rust Supported cell is stricter. It names executed evidence instead of a pattern: either
 * `protocol/v1` fixtures, or one test function in a file that `pnpm rust:integration` runs against
 * PostgreSQL. `pnpm parity:check` fails unless each fixture exists and is absent from the Rust
 * runner's expected-unsupported list, or unless the named test exists in an integration target. A
 * Rust cell is therefore Supported only while CI executes and passes its evidence.
 *
 * A Planned cell carries the Ontrack Issue that owns the gap. The generator writes its link into
 * the document, so a Planned cell cannot outlive the work it points at unnoticed.
 */

/** Where a language's tests live, relative to the repository root. */
export const PARITY_TEST_ROOTS = {
  typescript: "typescript/core/test",
  python: "python/tests",
  go: "go",
  rust: "rust",
} as const;

export type ParityLanguage = keyof typeof PARITY_TEST_ROOTS;

/** A test file that must exist, and one or more patterns that must appear in it. */
interface SinglePatternEvidence {
  file: string;
  pattern: string;
}

interface PatternListEvidence {
  file: string;
  patterns: readonly string[];
}

type ParityEvidence = SinglePatternEvidence | PatternListEvidence;
export type ParityCell = ParityEvidence | { absent: string } | { planned: string };

/** `<category>/<fixture id>` keys from `protocol/v1` that the Rust runner executes and passes. */
interface RustFixtureEvidence {
  fixtures: readonly string[];
}

/** A test function, by exact name, in a `rust/tests` target that `pnpm rust:integration` runs. */
interface RustIntegrationTestEvidence {
  file: string;
  test: string;
}

export type RustParityCell =
  | RustFixtureEvidence
  | RustIntegrationTestEvidence
  | { absent: string }
  | { planned: string };

export interface ParityRow {
  /** The capability column, byte for byte as `docs/parity.md` writes it. */
  capability: string;
  typescript: ParityCell;
  python: ParityCell;
  go: ParityCell;
  /** A Rust cell is Supported only with fixtures or an integration test that CI executes. */
  rust?: RustParityCell;
}

/** Where each product operator surface's tests live, relative to the repository root. */
export const PRODUCT_PARITY_TEST_ROOTS = {
  postgresql: "typescript/core/test",
  dashboard: "typescript/dashboard-server",
  cli: "typescript/core/test",
} as const;

export type ProductParityTarget = keyof typeof PRODUCT_PARITY_TEST_ROOTS;

export interface ProductParityRow {
  /** The capability column, byte for byte as `docs/parity.md` writes it. */
  capability: string;
  postgresql: ParityCell;
  dashboard: ParityCell;
  cli: ParityCell;
}

/**
 * The public operator surface is reachable through the dashboard, the `workhorse` CLI, and the
 * TypeScript, Python, and Go `Admin` clients. Each SDK also embeds the dashboard in its own HTTP
 * server, and the embedded backend must pass the shared `dashboard/v1` HTTP fixtures.
 */
const pythonAdmin = { file: "test_admin.py", pattern: "admin." } as const;

export const PARITY_CLIENT_ROWS: readonly ParityRow[] = [
  {
    capability: "Transactional enqueue in a caller-owned tx",
    rust: {
      file: "enqueue_postgres.rs",
      test: "transactional_enqueue_commits_and_rolls_back_with_the_caller",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "transaction" },
    python: { file: "test_enqueue.py", pattern: "transaction" },
    go: { file: "queue_test.go", pattern: "Tx" },
  },
  {
    capability: "Atomic batch enqueue",
    rust: {
      file: "enqueue_postgres.rs",
      test: "enqueue_many_writes_an_atomic_batch_in_request_order",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "enqueueMany" },
    python: { file: "test_enqueue.py", pattern: "enqueue_many" },
    go: { file: "queue_test.go", pattern: "EnqueueMany" },
  },
  {
    capability: "Delayed enqueue (`runAt` / `run_at`)",
    rust: {
      file: "enqueue_postgres.rs",
      test: "enqueue_persists_run_at_priority_tags_and_max_attempts",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "runAt" },
    python: { file: "test_driver_integration.py", pattern: "run_at" },
    go: { file: "queue_test.go", pattern: "RunAt" },
  },
  {
    capability: "Priority",
    rust: {
      file: "enqueue_postgres.rs",
      test: "enqueue_persists_run_at_priority_tags_and_max_attempts",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "priority" },
    python: { file: "test_enqueue.py", pattern: "priority" },
    go: { file: "queue_test.go", pattern: "Priority" },
  },
  {
    capability: "Tags and max attempts",
    rust: {
      file: "enqueue_postgres.rs",
      test: "enqueue_persists_run_at_priority_tags_and_max_attempts",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "maxAttempts" },
    python: { file: "test_enqueue.py", pattern: "max_attempts" },
    go: { file: "queue_test.go", pattern: "MaxAttempts" },
  },
  {
    capability: "Persisted retry policies",
    rust: {
      file: "enqueue_postgres.rs",
      test: "enqueue_persists_retry_policy_deadline_and_execution_timeout",
    },
    typescript: { file: "integration-retry-attempt-lifecycle.test.ts", pattern: "retryPolicy" },
    python: { file: "test_enqueue.py", pattern: "retry_policy" },
    go: { file: "queue_test.go", pattern: "RetryPolicy" },
  },
  {
    capability: "Absolute deadlines and execution timeouts",
    rust: {
      file: "enqueue_postgres.rs",
      test: "enqueue_persists_retry_policy_deadline_and_execution_timeout",
    },
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "executionTimeoutMs" },
    python: { file: "test_worker.py", pattern: "execution_timeout" },
    go: { file: "queue_test.go", pattern: "ExecutionTimeout" },
  },
  {
    capability: "Enqueue idempotency",
    rust: {
      file: "enqueue_postgres.rs",
      test: "enqueue_idempotency_replays_and_rejects_a_conflicting_request",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "idempotency" },
    python: { file: "test_enqueue.py", pattern: "idempotency" },
    go: { file: "queue_test.go", pattern: "Idempotency" },
  },
  {
    capability: "Keyed debounce",
    rust: {
      file: "enqueue_postgres.rs",
      test: "debounce_replaces_a_pending_task_inside_its_window",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "debounce" },
    python: { file: "test_driver_integration.py", pattern: "debounce" },
    go: { file: "queue_test.go", pattern: "Debounce" },
  },
  {
    capability: "Keyed throttle",
    rust: { file: "enqueue_postgres.rs", test: "throttle_coalesces_requests_inside_its_window" },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "throttle" },
    python: { file: "test_driver_integration.py", pattern: "throttle" },
    go: { file: "queue_test.go", pattern: "Throttle" },
  },
  {
    capability: "Task dependencies with terminal policies",
    rust: {
      file: "enqueue_postgres.rs",
      test: "dependencies_block_a_task_with_its_terminal_policies",
    },
    typescript: { file: "integration-dependencies.test.ts", pattern: "dependencies" },
    python: { file: "test_driver_integration.py", pattern: "dependencies" },
    go: { file: "queue_test.go", pattern: "Dependencies" },
  },
  {
    capability: "Concurrency keys",
    rust: { file: "enqueue_postgres.rs", test: "enqueue_persists_concurrency_key_and_budget" },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "concurrencyKey" },
    python: { file: "test_enqueue.py", pattern: "concurrency_key" },
    go: { file: "queue_test.go", pattern: "ConcurrencyKey" },
  },
  {
    capability: "Concurrency policy management",
    rust: { file: "client_postgres.rs", test: "sync_concurrency_policies_stores_lists_and_prunes" },
    typescript: {
      file: "integration-retention-maintenance.test.ts",
      patterns: ["syncConcurrencyPolicies", "listConcurrencyPolicies"],
    },
    python: {
      file: "test_policies.py",
      patterns: ["sync_concurrency_policies", "list_concurrency_policies"],
    },
    go: {
      file: "policies_test.go",
      patterns: ["SyncConcurrencyPolicies", "ListConcurrencyPolicies"],
    },
  },
  {
    capability: "Rate-limit policy management",
    rust: { file: "client_postgres.rs", test: "sync_rate_limit_policies_stores_lists_and_prunes" },
    typescript: {
      file: "integration-claim-lease-fence.test.ts",
      patterns: ["syncRateLimitPolicies", "listRateLimitPolicies"],
    },
    python: {
      file: "test_policies.py",
      patterns: ["sync_rate_limit_policies", "list_rate_limit_policies"],
    },
    go: {
      file: "policies_test.go",
      patterns: ["SyncRateLimitPolicies", "ListRateLimitPolicies"],
    },
  },
  {
    capability: "Named budget management",
    rust: { file: "client_postgres.rs", test: "sync_budgets_stores_lists_and_prunes" },
    typescript: {
      file: "integration-budgets.test.ts",
      patterns: ["syncBudgets", "listBudgets"],
    },
    python: {
      file: "test_policies.py",
      patterns: ["sync_budgets", "list_budgets"],
    },
    go: {
      file: "policies_test.go",
      patterns: ["SyncBudgets", "ListBudgets"],
    },
  },
  {
    capability: "Recurring schedule definition sync",
    rust: { file: "client_postgres.rs", test: "sync_schedules_stores_and_prunes_definitions" },
    typescript: { file: "integration-cron-schedules.test.ts", pattern: "syncSchedules" },
    python: { file: "test_schedules.py", pattern: "sync_schedules" },
    go: { file: "queue_test.go", pattern: "SyncSchedules" },
  },
  {
    capability: "Payload and result contracts",
    rust: {
      file: "client_postgres.rs",
      test: "sync_contracts_validates_payloads_and_stamps_contract_fields",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "contracts" },
    python: { file: "test_worker.py", pattern: "test_contract_sync_validates" },
    go: { file: "worker_test.go", pattern: "TestContractSyncValidates" },
  },
  {
    capability: "Compatibility refusal before mutation",
    rust: {
      file: "enqueue_postgres.rs",
      test: "incompatible_schema_refuses_before_the_first_write",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "schema" },
    python: { file: "test_compatibility.py", pattern: "compatib" },
    go: { file: "compatibility_test.go", pattern: "Compatibility" },
  },
  {
    capability: "Public startup schema compatibility check",
    rust: {
      fixtures: [
        "compatibility/current",
        "compatibility/schema-newer-inside-major-line",
        "compatibility/served-protocol-undeclared",
        "compatibility/schema-not-installed",
        "compatibility/schema-too-old",
        "compatibility/schema-below-the-dashboard-reads",
        "compatibility/schema-below-the-statement-catalogues",
        "compatibility/schema-no-longer-serves-client",
        "compatibility/client-protocol-too-old",
        "compatibility/client-protocol-too-new",
      ],
    },
    typescript: { file: "schema-installation.test.ts", pattern: "assertSchemaCompatible" },
    python: { file: "test_compatibility.py", pattern: "assert_schema_compatible" },
    go: { file: "compatibility_test.go", pattern: "AssertSchemaCompatible" },
  },
  {
    capability: "SQL protocol conformance fixtures executed",
    rust: {
      fixtures: [
        "interpreter/matcher-semantics",
        "scenarios/successful-batch-lifecycle",
        "scenarios/retry-and-terminal-failure",
        "scenarios/ownership-expiration-and-recovery",
        "scenarios/cancellation",
        "scenarios/timer-wait",
        "scenarios/coalescing-and-structured-errors",
        "scenarios/dependencies",
        "scenarios/children",
        "scenarios/signals",
        "scenarios/queue-health",
        "scenarios/human-tokens",
        "scenarios/contract-definition-sync-and-read",
        "scenarios/batch-claim-admission",
        "scenarios/retention-maintenance",
        "scenarios/unknown-type-release",
      ],
    },
    typescript: { file: "sql-protocol-conformance.test.ts", pattern: "scenarios" },
    python: { file: "test_protocol_conformance.py", pattern: "scenarios" },
    go: { file: "conformance_test.go", pattern: "scenarios" },
  },
  {
    capability: "Enqueue trace-context propagation",
    rust: { file: "enqueue_postgres.rs", test: "enqueue_propagates_the_current_trace_context" },
    typescript: {
      file: "sql-protocol-conformance.test.ts",
      pattern: "trace-propagation",
    },
    python: {
      file: "test_worker_runtime_conformance.py",
      pattern: "trace-propagation",
    },
    go: { file: "runtime_conformance_test.go", pattern: "trace-propagation" },
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
    capability: "Unhandled task type released to its queue",
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "unregistered type" },
    python: { file: "test_worker.py", pattern: "unregistered_type" },
    go: { file: "worker_test.go", pattern: "UnregisteredType" },
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
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "workhorse_tasks" },
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
    typescript: { file: "integration-child-tasks.test.ts", pattern: "child" },
    python: { file: "test_worker_child_tasks.py", pattern: "child" },
    go: { file: "child_tasks_test.go", pattern: "hild" },
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
    capability: "Task lookup, listing, and timeline",
    rust: { file: "admin_postgres.rs", test: "admin_lists_looks_up_and_times_tasks_across_pages" },
    typescript: { file: "integration-operator-reads.test.ts", pattern: "admin.listTasks" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "ListTasks" },
  },
  {
    capability: "Queue health snapshot",
    rust: { file: "client_postgres.rs", test: "health_returns_the_queue_health_snapshot" },
    typescript: { file: "integration-health-snapshots.test.ts", pattern: "health" },
    python: { file: "test_driver_integration.py", pattern: "health" },
    go: { file: "queue_test.go", pattern: "Health" },
  },
  {
    capability: "Cancellation requests",
    rust: { file: "client_postgres.rs", test: "cancel_reports_each_postgres_disposition" },
    typescript: { file: "integration-operator-reads.test.ts", pattern: "cancel" },
    python: { file: "test_worker_runtime_conformance.py", pattern: "cancel" },
    go: { file: "worker_test.go", pattern: "Cancel" },
  },
  {
    capability: "Queue pause, resume, and purge",
    rust: { file: "admin_postgres.rs", test: "admin_pauses_resumes_and_purges_a_queue" },
    typescript: { file: "integration-queue-administration.test.ts", pattern: "admin.purgeQueue" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "PurgeQueue" },
  },
  {
    capability: "Dead-letter listing and redrive",
    rust: { file: "admin_postgres.rs", test: "admin_lists_and_redrives_dead_letters" },
    typescript: { file: "integration-operator-reads.test.ts", pattern: "admin.redrive" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "Redrive" },
  },
  {
    capability: "Checkpoint, wait, and human-decision reads",
    rust: { file: "admin_postgres.rs", test: "admin_reads_checkpoints_waits_and_human_waits" },
    typescript: { file: "integration-human-waits.test.ts", pattern: "admin.listHumanWaits" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "ListHumanWaits" },
  },
  {
    capability: "Durable operator worker pause",
    rust: { file: "admin_postgres.rs", test: "admin_pauses_and_resumes_a_registered_worker" },
    typescript: { file: "integration-worker-registry.test.ts", pattern: "paused" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "SetWorkerPaused" },
  },
  {
    capability: "Embedded dashboard backend",
    typescript: {
      file: "../../dashboard-server/test/conformance.test.ts",
      pattern: "dashboard/v1 HTTP conformance fixtures",
    },
    python: { file: "test_dashboard_conformance.py", pattern: "dashboard/v1/conformance.json" },
    go: {
      file: "dashboard/conformance_test.go",
      pattern: "TestDashboardSatisfiesEverySharedHTTPScenario",
    },
    rust: { planned: "SM-885" },
  },
];

/** Operator capabilities implemented by PostgreSQL and exposed through product surfaces. */
export const PRODUCT_PARITY_ROWS: readonly ProductParityRow[] = [
  {
    capability: "Task lookup, listing, and timeline",
    postgresql: {
      file: "integration-operator-reads.test.ts",
      patterns: ["list_tasks_v1", "list_task_timeline_v1"],
    },
    dashboard: { file: "test/conformance.test.ts", pattern: "verifyDashboardConformanceFixtures" },
    cli: { file: "integration-admin-cli.test.ts", patterns: ["tasks", "timeline"] },
  },
  {
    capability: "Queue health snapshot",
    postgresql: { file: "integration-health-snapshots.test.ts", pattern: "queue.health" },
    dashboard: { file: "test/conformance.test.ts", pattern: "verifyDashboardConformanceFixtures" },
    cli: { file: "integration-admin-cli.test.ts", pattern: "queues" },
  },
  {
    capability: "Cancellation requests",
    postgresql: { file: "integration-claim-lease-fence.test.ts", pattern: "cancel_v1" },
    dashboard: { file: "src/server/operator-controllers.test.ts", pattern: "cancelTask" },
    cli: { file: "integration-admin-cli.test.ts", pattern: "cancel" },
  },
  {
    capability: "Queue pause and resume",
    postgresql: {
      file: "integration-queue-administration.test.ts",
      patterns: ["pauseQueue", "resumeQueue"],
    },
    dashboard: {
      file: "src/server/operator-controllers.test.ts",
      patterns: ["pauseQueue", "resumeQueue"],
    },
    cli: { file: "integration-admin-cli.test.ts", patterns: ["pause", "resume"] },
  },
  {
    capability: "Queue purge",
    postgresql: { file: "integration-queue-administration.test.ts", pattern: "purgeQueue" },
    dashboard: { file: "src/server/operator-controllers.test.ts", pattern: "purgeQueue" },
    cli: { file: "integration-admin-cli.test.ts", pattern: "purge" },
  },
  {
    capability: "Dead-letter listing",
    postgresql: { file: "integration-operator-reads.test.ts", pattern: "list_dead_letters_v1" },
    dashboard: { file: "test/conformance.test.ts", pattern: "verifyDashboardConformanceFixtures" },
    cli: { file: "integration-admin-cli.test.ts", pattern: "failures" },
  },
  {
    capability: "Redrive",
    postgresql: { file: "integration-operator-reads.test.ts", pattern: "redrive_v1" },
    dashboard: { file: "src/server/operator-controllers.test.ts", pattern: "redriveDeadLetters" },
    cli: { file: "integration-admin-cli.test.ts", pattern: "redrive" },
  },
  {
    capability: "Checkpoint, wait, and human-decision reads",
    postgresql: {
      file: "integration-human-waits.test.ts",
      patterns: ["listHumanWaits", "human wait"],
    },
    dashboard: { file: "test/human-wait-integration.test.ts", pattern: "humanWaits" },
    cli: { file: "integration-admin-cli.test.ts", patterns: ["checkpoints", "external-waits"] },
  },
  {
    capability: "Durable operator worker pause",
    postgresql: { file: "integration-worker-registry.test.ts", pattern: "setWorkerPaused" },
    dashboard: { file: "src/server/operator-controllers.test.ts", pattern: "setWorkerPaused" },
    cli: {
      file: "integration-admin-cli.test.ts",
      patterns: ["pause-worker", "resume-worker"],
    },
  },
];

/** The three tables, in the order `docs/parity.md` prints them. */
export const PARITY_TABLES: readonly (readonly ParityRow[])[] = [
  PARITY_CLIENT_ROWS,
  PARITY_WORKER_ROWS,
  PARITY_OPERATOR_ROWS,
];

/**
 * A runtime default, with the source line that sets it.
 *
 * A capability cell answers whether a language can do something. A default cell answers what it
 * does when the caller says nothing, which is the value an operator actually runs. Pinning the
 * source keeps the published number from outliving the constant behind it.
 */
interface ParityDefaultCell {
  /** The value column, byte for byte as `docs/parity.md` writes it. */
  value: string;
  /** A source file, relative to the repository root. */
  file: string;
  /** Text that must appear in that file, proving the value is still the one in force. */
  pattern: string;
}

export interface ParityDefaultRow {
  /** The setting column, byte for byte as `docs/parity.md` writes it. */
  setting: string;
  typescript: ParityDefaultCell | { absent: string };
  python: ParityDefaultCell | { absent: string };
  go: ParityDefaultCell | { absent: string };
  rust?: ParityDefaultCell | { absent: string } | { planned: string };
}

/**
 * The worker runtime defaults, for the generated table in `docs/parity.md`.
 *
 * Three runtimes that agree on every capability can still behave differently out of the box, and a
 * reader comparing them has no way to see that from the capability tables. Every divergence below
 * is deliberate and recorded rather than discovered during an incident.
 */
export const PARITY_DEFAULT_ROWS: readonly ParityDefaultRow[] = [
  {
    setting: "Worker concurrency",
    typescript: {
      value: "1",
      file: "typescript/core/src/worker.ts",
      pattern: "options.concurrency ?? 1",
    },
    python: {
      value: "1",
      file: "python/src/workhorse/worker.py",
      pattern: "concurrency: int = 1",
    },
    go: { value: "1", file: "go/worker.go", pattern: "concurrency = 1" },
  },
  {
    setting: "Lease duration",
    typescript: {
      value: "30000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "options.leaseMs ?? 30_000",
    },
    python: {
      value: "30000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "lease_ms: int = 30_000",
    },
    go: {
      value: "30000 ms",
      file: "go/worker.go",
      pattern: "defaultWorkerLease         = 30 * time.Second",
    },
  },
  {
    setting: "Heartbeat interval",
    typescript: {
      value: "Lease duration / 3",
      file: "typescript/core/src/worker.ts",
      pattern: "Math.max(100, Math.floor(this.leaseMs / 3))",
    },
    python: {
      value: "Lease duration / 3",
      file: "python/src/workhorse/worker.py",
      pattern: "max(100, lease_ms // 3)",
    },
    go: { value: "Lease duration / 3", file: "go/worker.go", pattern: "leaseDuration / 3" },
  },
  {
    setting: "Claim poll interval (subscription live)",
    typescript: {
      value: "5000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "DEFAULT_NOTIFICATION_FALLBACK_POLL_MS = 5_000",
    },
    python: {
      value: "5000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "poll_ms if poll_ms is not None else 5_000",
    },
    go: {
      value: "5000 ms",
      file: "go/worker.go",
      pattern: "defaultNotificationPollInterval = maximumEmptyPollInterval",
    },
  },
  {
    setting: "Claim poll interval (polling only)",
    typescript: {
      value: "250 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "DEFAULT_POLL_MS = 250",
    },
    python: {
      value: "250 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "poll_ms if poll_ms is not None else 250",
    },
    go: {
      value: "250 ms",
      file: "go/worker.go",
      pattern: "defaultWorkerPollInterval  = 250 * time.Millisecond",
    },
  },
  {
    setting: "Empty-claim backoff ceiling",
    typescript: {
      value: "5000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "MAX_EMPTY_POLL_MS = 5_000",
    },
    python: {
      value: "5000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "_MAX_EMPTY_POLL_MS = 5_000",
    },
    go: {
      value: "5000 ms",
      file: "go/worker.go",
      pattern: "maximumEmptyPollInterval   = 5 * time.Second",
    },
  },
  {
    setting: "Maintenance tick interval",
    typescript: {
      value: "1000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "options.maintenanceIntervalMs ?? 1_000",
    },
    python: {
      value: "1000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "maintenance_interval_ms: int = 1_000",
    },
    go: {
      value: "1000 ms",
      file: "go/worker.go",
      pattern: "defaultMaintenanceInterval = time.Second",
    },
  },
  {
    setting: "Maintenance routine offer interval",
    typescript: {
      value: "60000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "options.maintenanceRoutinePollMs ?? 60_000",
    },
    python: {
      value: "60000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "maintenance_routine_poll_ms: int = 60_000",
    },
    go: {
      value: "60000 ms",
      file: "go/worker.go",
      pattern: "defaultMaintenanceRoutineInterval = time.Minute",
    },
  },
  {
    setting: "Worker registry interval",
    typescript: {
      value: "5000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "options.registryIntervalMs ?? 5_000",
    },
    python: {
      value: "5000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "registry_interval_ms: int = 5_000",
    },
    go: {
      value: "5000 ms",
      file: "go/worker.go",
      pattern: "defaultRegistryInterval    = 5 * time.Second",
    },
  },
  {
    setting: "Schedule catch-up limit",
    typescript: {
      value: "100",
      file: "typescript/core/src/worker.ts",
      pattern: "options.scheduleCatchupLimit ?? 100",
    },
    python: {
      value: "100",
      file: "python/src/workhorse/worker.py",
      pattern: "schedule_catchup_limit: int = 100",
    },
    go: { value: "100", file: "go/worker.go", pattern: "scheduleCatchupLimit = 100" },
  },
  {
    setting: "Shutdown grace, then",
    typescript: {
      value: "25000 ms, then exit the process",
      file: "typescript/core/src/worker-process.ts",
      pattern: "DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000",
    },
    python: {
      value: "25000 ms, then exit the process",
      file: "python/src/workhorse/worker_process.py",
      pattern: "_DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000",
    },
    go: {
      value: "25000 ms, then abandon the handlers",
      file: "go/worker.go",
      pattern: "defaultShutdownGracePeriod = 25 * time.Second",
    },
  },
  {
    setting: "Handler retry delay override",
    typescript: {
      value: "`retryDelayMs`, unset",
      file: "typescript/core/src/worker.ts",
      pattern: "retryDelayMs",
    },
    python: {
      value: "`retry_delay_ms`, unset",
      file: "python/src/workhorse/worker.py",
      pattern: "retry_delay_ms: int | Callable",
    },
    go: {
      value: "`RetryDelay`, unset",
      file: "go/worker.go",
      pattern: "RetryDelay func(attempt int, task ClaimedTask) *time.Duration",
    },
  },
];
