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
 * A Ruby Supported cell follows the same rule. It cites `protocol/v1` fixtures that the Ruby
 * conformance runner passes, or one example in a `ruby/spec` file that `pnpm ruby:test` runs. CI runs
 * that suite with `WORKHORSE_REQUIRE_DATABASE=1`, so a cited example cannot skip there.
 *
 * A JVM Supported cell follows the same rule. It cites `protocol/v1` fixtures that the JVM
 * conformance runner passes, or one JUnit test method in a `jvm/workhorse/src/test/java` file that
 * `pnpm jvm:test` runs. CI runs that suite with `WORKHORSE_REQUIRE_DATABASE=1`, so a cited test
 * cannot skip there.
 *
 * A .NET Supported cell follows the same rule. It cites `protocol/v1` fixtures that the .NET
 * conformance runner passes, or one xUnit test method in a test project that `pnpm dotnet:test`
 * runs. CI runs that suite with `CI` set, so a cited database test cannot skip there. A .NET cell
 * can also name the C# implementation beside its test, as a file and a text that it must contain.
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
  ruby: "ruby/spec",
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

/** An example, by its exact `it` description, in a `ruby/spec` file that `pnpm ruby:test` runs. */
interface RubyExampleEvidence {
  file: string;
  example: string;
}

export type RubyParityCell =
  | RustFixtureEvidence
  | RubyExampleEvidence
  | { absent: string }
  | { planned: string };

/** A JUnit test method, by exact name, in a `jvm/workhorse/src/test/java` file. */
interface JvmTestEvidence {
  file: string;
  test: string;
}

export type JvmParityCell = RustFixtureEvidence | JvmTestEvidence | { planned: string };

/**
 * An xUnit test method, by exact name, in a test project that `pnpm dotnet:test` runs. The file is
 * relative to `dotnet/tests`. `implementation` names the C# code that the test proves, as a file
 * relative to the repository root and a text that it must contain.
 */
interface DotnetTestEvidence {
  file: string;
  test: string;
  implementation?: { file: string; pattern: string };
}

/** Several xUnit test methods, when a capability has parts that no one test covers. */
interface DotnetTestListEvidence {
  tests: readonly DotnetTestEvidence[];
}

export type DotnetParityCell =
  | RustFixtureEvidence
  | DotnetTestEvidence
  | DotnetTestListEvidence
  | { planned: string };

export interface ParityRow {
  /** The capability column, byte for byte as `docs/parity.md` writes it. */
  capability: string;
  typescript: ParityCell;
  python: ParityCell;
  go: ParityCell;
  /** A Rust cell is Supported only with fixtures or an integration test that CI executes. */
  rust?: RustParityCell;
  /** The native Ruby SDK. A Ruby cell is Supported only with evidence that CI executes. */
  ruby: RubyParityCell;
  /** The `workhorse` artifact of the JVM SDK. A JVM cell is Supported only with executed evidence. */
  jvm?: JvmParityCell;
  /** The `Workhorse` package of the .NET SDK. A .NET cell is Supported only with executed evidence. */
  dotnet?: DotnetParityCell;
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "EnqueuesInsideACallerTransactionAndRollsBackWithIt",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "enqueuesInsideACallerTransactionThatCommits",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "commits and rolls back a transactional enqueue with the caller",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "EnqueuesAnAtomicBatchInRequestOrder",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "aBatchCommitsAsOneStatement",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "writes an atomic batch in request order with enqueue_many",
    },
    rust: {
      file: "enqueue_postgres.rs",
      test: "enqueue_many_writes_an_atomic_batch_in_request_order",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "enqueueMany" },
    python: { file: "test_enqueue.py", pattern: "enqueue_many" },
    go: { file: "queue_test.go", pattern: "EnqueueMany" },
  },
  {
    capability: "Task groups with completion callbacks",
    dotnet: {
      file: "Workhorse.Tests/Client/QueueTaskGroupTests.cs",
      test: "AFinishedGroupEnqueuesItsCallbackTask",
    },
    jvm: {
      file: "run/workhorse/AdminDatabaseTest.java",
      test: "cancelsAGroupReadsItsEventsAndRepairsACounterThatDrifted",
    },
    ruby: {
      file: "integration/task_group_spec.rb",
      example:
        "creates, adds, and seals in one statement and enqueues the callbacks the result selects",
    },
    rust: {
      file: "task_groups_postgres.rs",
      test: "a_sealed_group_runs_its_callback_after_a_member_adds_a_task",
    },
    typescript: { file: "integration-task-groups.test.ts", pattern: "queue\\.taskGroup\\(" },
    python: { file: "test_task_groups.py", pattern: "\\.task_group\\(" },
    go: { file: "task_groups_test.go", pattern: "\\.TaskGroup\\(" },
  },
  {
    capability: "Delayed enqueue (`runAt` / `run_at`)",
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "StoresDelayPriorityTagsAttemptsPolicyDeadlineTimeoutAndConcurrencyKey",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "storesEveryTaskOption",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "persists run at, priority, tags, and max attempts",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "StoresDelayPriorityTagsAttemptsPolicyDeadlineTimeoutAndConcurrencyKey",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "storesEveryTaskOption",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "persists run at, priority, tags, and max attempts",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "StoresDelayPriorityTagsAttemptsPolicyDeadlineTimeoutAndConcurrencyKey",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "storesEveryTaskOption",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "persists run at, priority, tags, and max attempts",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "StoresDelayPriorityTagsAttemptsPolicyDeadlineTimeoutAndConcurrencyKey",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "storesEveryTaskOption",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "persists the retry policy, deadline, and execution timeout",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "StoresDelayPriorityTagsAttemptsPolicyDeadlineTimeoutAndConcurrencyKey",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "storesEveryTaskOption",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "persists the retry policy, deadline, and execution timeout",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "ReplaysAnIdempotentEnqueueAndRefusesADifferentRequest",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "replaysAnIdempotentEnqueue",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "replays an idempotent enqueue and rejects a conflicting request",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "DebouncesAndThrottlesByKey",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "replacesAPendingTaskInsideItsDebounceWindow",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "replaces a pending task inside its debounce window",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "DebouncesAndThrottlesByKey",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "coalescesRequestsInsideAThrottleWindow",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "coalesces requests inside a throttle window",
    },
    rust: { file: "enqueue_postgres.rs", test: "throttle_coalesces_requests_inside_its_window" },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "throttle" },
    python: { file: "test_driver_integration.py", pattern: "throttle" },
    go: { file: "queue_test.go", pattern: "Throttle" },
  },
  {
    capability: "Task dependencies with terminal policies",
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "BlocksATaskOnItsPrerequisites",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "blocksATaskOnItsDependencies",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "blocks a task on its dependencies with their terminal policies",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
      test: "StoresDelayPriorityTagsAttemptsPolicyDeadlineTimeoutAndConcurrencyKey",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "storesEveryTaskOption",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "persists the concurrency key and budget",
    },
    rust: { file: "enqueue_postgres.rs", test: "enqueue_persists_concurrency_key_and_budget" },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "concurrencyKey" },
    python: { file: "test_enqueue.py", pattern: "concurrency_key" },
    go: { file: "queue_test.go", pattern: "ConcurrencyKey" },
  },
  {
    capability: "Concurrency policy management",
    dotnet: {
      file: "Workhorse.Tests/Client/QueuePolicyTests.cs",
      test: "SyncsAndListsConcurrencyPolicies",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "syncsListsAndPrunesConcurrencyPolicies",
    },
    ruby: {
      file: "integration/client_spec.rb",
      example: "syncs policies and budgets per namespace, pruning what a sync omits",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueuePolicyTests.cs",
      test: "SyncsAndListsRateLimitPolicies",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "syncsListsAndPrunesRateLimitPolicies",
    },
    ruby: {
      file: "integration/client_spec.rb",
      example: "syncs policies and budgets per namespace, pruning what a sync omits",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueuePolicyTests.cs",
      test: "SyncsAndListsBudgetsAndATaskNamesOne",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "syncsListsAndPrunesBudgets",
    },
    ruby: {
      file: "integration/client_spec.rb",
      example: "syncs policies and budgets per namespace, pruning what a sync omits",
    },
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
    dotnet: {
      fixtures: [
        "schedules/recurring-schedule-definition",
        "schedules/minimal-schedule-definition",
        "schedules/contracted-schedule-definition",
      ],
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "syncsAndPrunesScheduleDefinitions",
    },
    ruby: { file: "integration/client_spec.rb", example: "stores and prunes schedule definitions" },
    rust: { file: "client_postgres.rs", test: "sync_schedules_stores_and_prunes_definitions" },
    typescript: { file: "integration-cron-schedules.test.ts", pattern: "syncSchedules" },
    python: { file: "test_schedules.py", pattern: "sync_schedules" },
    go: { file: "queue_test.go", pattern: "SyncSchedules" },
  },
  {
    capability: "Payload and result contracts",
    dotnet: {
      tests: [
        {
          file: "Workhorse.Tests/Client/QueueContractTests.cs",
          test: "ValidatesAndStampsAContractedPayload",
        },
        {
          file: "Workhorse.Tests/WorkerTests.cs",
          test: "AResultThatBreaksItsPayloadContractFailsOneAttemptAndTheWorkerContinues",
        },
      ],
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "validatesAndStampsAContractedPayload",
    },
    ruby: {
      file: "integration/client_spec.rb",
      example: "validates payloads against synced contracts and stamps contract fields",
    },
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
    dotnet: {
      file: "Workhorse.Tests/Client/QueueControlTests.cs",
      test: "RefusesBeforeAMutationWhenTheSchemaIsMissing",
    },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "refusesAnIncompatibleSchemaBeforeAnyMutation",
    },
    ruby: {
      file: "integration/enqueue_spec.rb",
      example: "refuses an incompatible schema before the first write",
    },
    rust: {
      file: "enqueue_postgres.rs",
      test: "incompatible_schema_refuses_before_the_first_write",
    },
    typescript: {
      file: "client-schema-compatibility.test.ts",
      pattern: "refuses a schema below the floor before it sends the mutation",
    },
    python: { file: "test_compatibility.py", pattern: "compatib" },
    go: { file: "compatibility_test.go", pattern: "Compatibility" },
  },
  {
    capability: "Public startup schema compatibility check",
    dotnet: {
      fixtures: [
        "compatibility/current",
        "compatibility/schema-newer-inside-major-line",
        "compatibility/served-protocol-undeclared",
        "compatibility/schema-before-single-child-rename-diagnosis",
        "compatibility/schema-not-installed",
        "compatibility/schema-before-the-fast-tier-contract",
        "compatibility/schema-before-the-governed-drift-repair",
        "compatibility/schema-before-terminal-failure-override",
        "compatibility/schema-before-the-instance-fenced-deregistration",
        "compatibility/schema-before-the-dashboard-retention-preview",
        "compatibility/schema-before-the-one-lease-busy-heartbeat",
        "compatibility/schema-before-busy-heartbeats",
        "compatibility/schema-before-the-fenced-member-add",
        "compatibility/schema-before-checkpoint-input-fingerprints",
        "compatibility/schema-before-the-newest-task-group-events",
        "compatibility/schema-before-task-groups",
        "compatibility/schema-before-the-admission-shards",
        "compatibility/schema-serves-only-older-protocols",
        "compatibility/schema-below-the-statement-catalogues",
        "compatibility/schema-no-longer-serves-client",
        "compatibility/client-protocol-too-old",
        "compatibility/client-protocol-too-new",
      ],
    },
    jvm: {
      fixtures: [
        "compatibility/current",
        "compatibility/schema-newer-inside-major-line",
        "compatibility/served-protocol-undeclared",
        "compatibility/schema-before-single-child-rename-diagnosis",
        "compatibility/schema-not-installed",
        "compatibility/schema-before-the-fast-tier-contract",
        "compatibility/schema-before-the-governed-drift-repair",
        "compatibility/schema-before-terminal-failure-override",
        "compatibility/schema-before-the-fenced-member-add",
        "compatibility/schema-before-checkpoint-input-fingerprints",
        "compatibility/schema-before-the-newest-task-group-events",
        "compatibility/schema-before-task-groups",
        "compatibility/schema-before-the-admission-shards",
        "compatibility/schema-serves-only-older-protocols",
        "compatibility/schema-below-the-statement-catalogues",
        "compatibility/schema-no-longer-serves-client",
        "compatibility/client-protocol-too-old",
        "compatibility/client-protocol-too-new",
      ],
    },
    ruby: {
      fixtures: [
        "compatibility/current",
        "compatibility/schema-newer-inside-major-line",
        "compatibility/served-protocol-undeclared",
        "compatibility/schema-not-installed",
        "compatibility/schema-before-the-fast-tier-contract",
        "compatibility/schema-before-the-governed-drift-repair",
        "compatibility/schema-before-the-admission-shards",
        "compatibility/schema-serves-only-older-protocols",
        "compatibility/schema-below-the-statement-catalogues",
        "compatibility/schema-no-longer-serves-client",
        "compatibility/client-protocol-too-old",
        "compatibility/client-protocol-too-new",
      ],
    },
    rust: {
      fixtures: [
        "compatibility/current",
        "compatibility/schema-newer-inside-major-line",
        "compatibility/served-protocol-undeclared",
        "compatibility/schema-not-installed",
        "compatibility/schema-before-the-fast-tier-contract",
        "compatibility/schema-serves-only-older-protocols",
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
    dotnet: {
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
        "scenarios/fast-tier",
        "scenarios/terminal-failure-override-full",
        "scenarios/terminal-failure-override-fast",
        "scenarios/task-groups",
        "scenarios/worker-deregistration",
      ],
    },
    jvm: {
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
        "scenarios/fast-tier",
        "scenarios/terminal-failure-override-full",
        "scenarios/terminal-failure-override-fast",
        "scenarios/task-groups",
      ],
    },
    ruby: {
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
        "scenarios/fast-tier",
      ],
    },
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
    dotnet: {
      file: "Workhorse.Tests/Telemetry/TelemetryDatabaseTests.cs",
      test: "TheHandlerSpanContinuesTheTraceOfTheEnqueue",
      implementation: {
        file: "dotnet/src/Workhorse/Internal/Telemetry/Instrumentation.cs",
        pattern: "internal static JsonObject? InjectTraceContext()",
      },
    },
    jvm: { fixtures: ["runtime/enqueue-trace-context-reaches-handler"] },
    ruby: { fixtures: ["runtime/enqueue-trace-context-reaches-handler"] },
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
    dotnet: { file: "Workhorse.Tests/WorkerTests.cs", test: "CompletesAHandledTaskWithItsResult" },
    jvm: {
      file: "run/workhorse/WorkerDatabaseTest.java",
      test: "completesATaskAndStoresItsResult",
    },
    ruby: { file: "integration/worker_spec.rb", example: "completes a task and stores its result" },
    rust: { file: "worker_postgres.rs", test: "the_handler_result_reaches_the_task_outcome" },
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "claim" },
    python: { file: "test_worker.py", pattern: "handler" },
    go: { file: "worker_test.go", pattern: "Handler" },
  },
  {
    capability: "Bounded worker concurrency",
    dotnet: {
      file: "Workhorse.Tests/WorkerTests.cs",
      test: "ClaimedTasksNeverExceedTheConcurrency",
    },
    jvm: {
      file: "run/workhorse/WorkerDatabaseTest.java",
      test: "runsAtMostConcurrencyHandlersOnVirtualThreads",
    },
    ruby: {
      fixtures: [
        "runtime/busy-worker-refills-slots-with-overlapping-batched-claims",
        "runtime/budget-admission-holds-across-queues",
      ],
    },
    rust: {
      file: "worker_postgres.rs",
      test: "concurrent_handlers_stay_within_the_concurrency_limit",
    },
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "concurrency" },
    python: { file: "test_worker.py", pattern: "concurrency" },
    go: { file: "worker_test.go", pattern: "Concurrency" },
  },
  {
    capability: "Fast task tier with one outcome row per task",
    dotnet: {
      file: "Workhorse.Tests/WorkerFastTierTests.cs",
      test: "AFastTierTaskLeavesOneOutcomeRowAndNoHistory",
    },
    jvm: {
      file: "run/workhorse/WorkerFastTierDatabaseTest.java",
      test: "runsFastTierTasksAndRecordsOneFastOutcomeRowForEach",
    },
    ruby: {
      file: "integration/worker_fast_tier_spec.rb",
      example: "runs fast-tier tasks and records one fast_task_outcome row for each",
    },
    rust: {
      file: "worker_postgres.rs",
      test: "a_crashed_fast_worker_loses_no_task_and_records_one_outcome_each",
    },
    typescript: { file: "integration-fast-tier.test.ts", pattern: "one outcome each" },
    python: { file: "test_worker_fast_tier.py", pattern: "fast_task_outcome" },
    go: { file: "worker_fast_tier_test.go", pattern: "StaleCompletion" },
  },
  {
    capability: "Fused fast-tier completion and refill claim in slot cohorts",
    dotnet: {
      file: "Workhorse.Tests/WorkerFastTierTests.cs",
      test: "FusedCompletionsRefillTheirCohortWithinTheConcurrency",
    },
    jvm: {
      file: "run/workhorse/WorkerFastTierDatabaseTest.java",
      test: "fusesEachCompletionWithARefillClaimBoundedByItsSlotCohort",
    },
    ruby: {
      file: "integration/worker_fast_tier_spec.rb",
      example: "fuses each completion with a refill claim bounded by its slot cohort",
    },
    rust: {
      file: "worker_postgres.rs",
      test: "an_abandoned_batching_worker_reruns_no_more_tasks_than_its_concurrency",
    },
    typescript: { file: "worker-dispatch.test.ts", pattern: "refills each cohort on its own" },
    python: { file: "test_worker_dispatch.py", pattern: "fused_claims_stay_within_their_cohort" },
    go: {
      file: "worker_dispatch_internal_test.go",
      pattern: "FusedCompletionClaimsOnlyItsCohortsFreeSlots",
    },
  },
  {
    capability: "Unhandled task type released to its queue",
    dotnet: {
      fixtures: [
        "runtime/missing-handler-releases-the-task-with-its-attempt-intact",
        "runtime/a-listening-worker-claims-a-released-task-again-only-after-its-poll-interval",
      ],
    },
    jvm: {
      fixtures: [
        "runtime/missing-handler-releases-the-task-with-its-attempt-intact",
        "runtime/a-listening-worker-claims-a-released-task-again-only-after-its-poll-interval",
      ],
    },
    ruby: {
      fixtures: [
        "runtime/missing-handler-releases-the-task-with-its-attempt-intact",
        "runtime/a-listening-worker-claims-a-released-task-again-only-after-its-poll-interval",
      ],
    },
    rust: {
      fixtures: [
        "runtime/missing-handler-releases-the-task-with-its-attempt-intact",
        "runtime/a-listening-worker-claims-a-released-task-again-only-after-its-poll-interval",
      ],
    },
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "unregistered type" },
    python: { file: "test_worker.py", pattern: "unregistered_type" },
    go: { file: "worker_test.go", pattern: "UnregisteredType" },
  },
  {
    capability: "Heartbeats, lease recovery, fenced ownership",
    dotnet: {
      fixtures: [
        "runtime/heartbeats-never-overlap",
        "runtime/failed-heartbeat-rounds-keep-the-attempt-running",
        "runtime/busy-heartbeat-rounds-retry-and-keep-the-attempt-running",
        "runtime/deadline-settles-after-database-first-heartbeat",
        "runtime/lease-loss-fences-handler-writes",
      ],
    },
    jvm: {
      fixtures: [
        "runtime/heartbeats-never-overlap",
        "runtime/failed-heartbeat-rounds-keep-the-attempt-running",
        "runtime/deadline-settles-after-database-first-heartbeat",
        "runtime/lease-loss-fences-handler-writes",
      ],
    },
    ruby: {
      fixtures: [
        "runtime/heartbeats-never-overlap",
        "runtime/failed-heartbeat-rounds-keep-the-attempt-running",
        "runtime/deadline-settles-after-database-first-heartbeat",
      ],
    },
    rust: {
      fixtures: [
        "runtime/heartbeats-never-overlap",
        "runtime/failed-heartbeat-rounds-keep-the-attempt-running",
        "runtime/deadline-settles-after-database-first-heartbeat",
      ],
    },
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "fence" },
    python: { file: "test_worker.py", pattern: "fence" },
    go: { file: "worker_test.go", pattern: "fence" },
  },
  {
    capability: "Cooperative cancellation delivery",
    dotnet: { fixtures: ["runtime/cooperative-cancellation-reaches-handler"] },
    jvm: { fixtures: ["runtime/cooperative-cancellation-reaches-handler"] },
    ruby: { fixtures: ["runtime/cooperative-cancellation-reaches-handler"] },
    rust: { fixtures: ["runtime/cooperative-cancellation-reaches-handler"] },
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "cancel" },
    python: { file: "test_worker.py", pattern: "cancel" },
    go: { file: "worker_test.go", pattern: "ancel" },
  },
  {
    capability: "Notification-assisted dispatch with polling",
    dotnet: { file: "Workhorse.Tests/WorkerTests.cs", test: "ANotificationWakesAListeningWorker" },
    jvm: {
      file: "run/workhorse/WorkerDatabaseTest.java",
      test: "wakesAnIdleWorkerOnANotificationWellBeforeItsFallbackPoll",
    },
    ruby: {
      file: "integration/worker_runtime_spec.rb",
      example: "wakes an idle worker on a notification well before its fallback poll",
    },
    rust: {
      file: "worker_postgres.rs",
      test: "a_notification_wakes_an_idle_worker_before_its_poll",
    },
    typescript: { file: "integration-enqueue-contracts.test.ts", pattern: "workhorse_tasks" },
    python: { file: "test_notifications.py", pattern: "notif" },
    go: { file: "notifications_test.go", pattern: "otif" },
  },
  {
    capability: "Durable checkpoints (handler context)",
    dotnet: { fixtures: ["runtime/durable-wait-suspension-and-checkpoint-replay"] },
    jvm: { fixtures: ["runtime/durable-wait-suspension-and-checkpoint-replay"] },
    ruby: { fixtures: ["runtime/durable-wait-suspension-and-checkpoint-replay"] },
    rust: { fixtures: ["runtime/durable-wait-suspension-and-checkpoint-replay"] },
    typescript: { file: "integration-checkpoints-progress-waits.test.ts", pattern: "checkpoint" },
    python: { file: "test_worker.py", pattern: "checkpoint" },
    go: { file: "worker_test.go", pattern: "heckpoint" },
  },
  {
    capability: "Checkpoint input check",
    dotnet: {
      file: "Workhorse.Tests/Durable/DurableContextTests.cs",
      test: "ADifferentCheckpointInputFailsTheTaskWithoutRunningTheOperation",
    },
    jvm: {
      file: "run/workhorse/DurableContextDatabaseTest.java",
      test: "aDifferentCheckpointInputFailsTheTaskWithoutRunningTheOperation",
    },
    ruby: {
      file: "integration/worker_spec.rb",
      example:
        "fails the task at once when a replayed checkpoint input differs and keeps the attempt",
    },
    rust: {
      file: "durable_postgres.rs",
      test: "a_changed_checkpoint_input_fails_the_task_on_replay",
    },
    typescript: {
      file: "integration-checkpoints-progress-waits.test.ts",
      pattern: "CheckpointInputConflictError",
    },
    python: {
      file: "test_worker_checkpoint_input.py",
      pattern: "CheckpointInputConflictError",
    },
    go: { file: "checkpoint_input_test.go", pattern: "CheckpointInputConflictError" },
  },
  {
    capability: "Durable timers (`sleep` / `sleepUntil`)",
    dotnet: {
      file: "Workhorse.Tests/Durable/DurableContextTests.cs",
      test: "AnAbsoluteTimerSuspendsUntilItsTimeAndThenReturns",
    },
    jvm: {
      file: "run/workhorse/DurableContextDatabaseTest.java",
      test: "anAbsoluteTimerSuspendsUntilItsTimeAndThenReturns",
    },
    ruby: {
      file: "integration/worker_spec.rb",
      example: "suspends a durable sleep and completes after the wake",
    },
    rust: {
      file: "durable_postgres.rs",
      test: "sleep_suspends_until_its_wake_time_and_a_past_wake_time_returns_at_once",
    },
    typescript: { file: "integration-checkpoints-progress-waits.test.ts", pattern: "sleep" },
    python: { file: "test_worker.py", pattern: "sleep" },
    go: { file: "worker_test.go", pattern: "Sleep" },
  },
  {
    capability: "Signal and human-decision waits",
    dotnet: {
      tests: [
        {
          file: "Workhorse.Tests/Durable/DurableContextTests.cs",
          test: "ASignalWaitSuspendsAndReturnsTheDeliveredPayload",
        },
        {
          file: "Workhorse.Tests/Durable/DurableContextTests.cs",
          test: "AHumanWaitSuspendsAndReturnsTheRecordedDecision",
        },
      ],
    },
    jvm: {
      file: "run/workhorse/DurableContextDatabaseTest.java",
      test: "aSignalWaitSuspendsAndReturnsTheDeliveredPayload",
    },
    ruby: {
      file: "integration/worker_spec.rb",
      example: "resumes a signal wait and a human wait with what was delivered",
    },
    rust: {
      file: "durable_postgres.rs",
      test: "signal_and_human_waits_resume_with_what_was_delivered",
    },
    typescript: { file: "integration-signals.test.ts", pattern: "signal" },
    python: { file: "test_worker_external_waits.py", pattern: "signal" },
    go: { file: "external_waits_test.go", pattern: "ignal" },
  },
  {
    capability: "Linked child fan-out and result join",
    dotnet: {
      file: "Workhorse.Tests/Durable/DurableContextTests.cs",
      test: "RunChildrenReturnsEachOutcomeByName",
    },
    jvm: {
      file: "run/workhorse/DurableContextDatabaseTest.java",
      test: "runChildrenReturnsEachOutcomeByName",
    },
    ruby: {
      file: "integration/worker_spec.rb",
      example: "suspends a parent on its children and joins their results on replay",
    },
    rust: { file: "durable_postgres.rs", test: "run_children_reports_how_each_child_ended" },
    typescript: { file: "integration-child-tasks.test.ts", pattern: "child" },
    python: { file: "test_worker_child_tasks.py", pattern: "child" },
    go: { file: "child_tasks_test.go", pattern: "hild" },
  },
  {
    capability: "Task group reads and adds from a handler",
    dotnet: {
      file: "Workhorse.Tests/Durable/DurableContextTests.cs",
      test: "AMemberTaskReadsItsGroupAndAddsATaskToIt",
    },
    jvm: {
      file: "run/workhorse/DurableContextDatabaseTest.java",
      test: "aMemberTaskReadsItsGroupAndAddsATaskToIt",
    },
    ruby: {
      file: "integration/task_group_spec.rb",
      example: "lets a running member task add tasks after the seal",
    },
    rust: {
      file: "task_groups_postgres.rs",
      test: "a_success_callback_reads_the_counts_of_its_group",
    },
    typescript: { file: "integration-task-groups.test.ts", pattern: "context.taskGroup.add" },
    python: { file: "test_task_groups.py", pattern: "context.task_group.add" },
    go: { file: "task_groups_test.go", pattern: "handler.AddToTaskGroup" },
  },
  {
    capability: "Latest-value progress reporting",
    dotnet: {
      file: "Workhorse.Tests/Durable/DurableContextTests.cs",
      test: "SetProgressStoresTheLatestValueAndANewAttemptReadsIt",
    },
    jvm: {
      file: "run/workhorse/DurableContextDatabaseTest.java",
      test: "setProgressStoresTheLatestValueAndANewAttemptReadsIt",
    },
    ruby: {
      file: "integration/worker_spec.rb",
      example: "round-trips progress and rate-limits a quick change",
    },
    rust: {
      file: "durable_postgres.rs",
      test: "progress_round_trips_and_a_quick_change_is_rate_limited",
    },
    typescript: { file: "integration-checkpoints-progress-waits.test.ts", pattern: "progress" },
    python: { file: "test_worker.py", pattern: "progress" },
    go: { file: "worker_test.go", pattern: "Progress" },
  },
  {
    capability: "Batch handler delivery",
    dotnet: { fixtures: ["runtime/priority-ordered-mixed-batch"] },
    jvm: { fixtures: ["runtime/priority-ordered-mixed-batch"] },
    ruby: { fixtures: ["runtime/priority-ordered-mixed-batch"] },
    rust: { file: "worker_postgres.rs", test: "a_batch_handler_receives_its_members_in_one_call" },
    typescript: { file: "integration-batch-handlers.test.ts", pattern: "batch" },
    python: { file: "test_worker.py", pattern: "batch" },
    go: { file: "batch_test.go", pattern: "atch" },
  },
  {
    capability: "Schedule firing (database cron evaluation)",
    dotnet: {
      file: "Workhorse.Tests/WorkerTests.cs",
      test: "AMaintenancePassFiresTheDueSchedulesOfItsNamespaces",
    },
    jvm: {
      file: "run/workhorse/WorkerDatabaseTest.java",
      test: "firesDueSchedulesInItsNamespacesDuringMaintenance",
    },
    ruby: {
      file: "integration/worker_runtime_spec.rb",
      example: "fires due schedules in its namespaces during maintenance",
    },
    rust: { file: "worker_postgres.rs", test: "maintenance_fires_due_schedules_in_its_namespaces" },
    typescript: { file: "integration-cron-schedules.test.ts", pattern: "fireSchedule" },
    python: { file: "test_worker_schedules.py", pattern: "schedule" },
    go: { file: "worker_schedules_test.go", pattern: "chedule" },
  },
  {
    capability: "Worker fleet registration and remote pause",
    dotnet: {
      file: "Workhorse.Tests/WorkerTests.cs",
      test: "TheWorkerRegistersItselfAndAnOperatorCanPauseIt",
    },
    jvm: {
      file: "run/workhorse/WorkerDatabaseTest.java",
      test: "registersTheWorkerAndStopsClaimingWhileAnOperatorPausesIt",
    },
    ruby: {
      file: "integration/worker_runtime_spec.rb",
      example: "registers the worker process and stops claiming while an operator pauses it",
    },
    rust: {
      file: "worker_postgres.rs",
      test: "an_operator_pause_stops_claims_until_it_is_cleared",
    },
    typescript: { file: "integration-worker-registry.test.ts", pattern: "register" },
    python: { file: "test_worker.py", pattern: "registry_delivers_remote_pause" },
    go: { file: "worker_test.go", pattern: "RegistryDeliversRemotePause" },
  },
  {
    capability: "Graceful stop and signal drain",
    dotnet: {
      file: "Workhorse.Tests/Hosting/HostedWorkerTests.cs",
      test: "AHostRunsAServiceHandlerAndDrainsItOnStop",
    },
    jvm: {
      file: "run/workhorse/WorkerProcessTest.java",
      test: "drainsTheWorkerOnSigtermBeforeTheProcessExits",
    },
    ruby: {
      file: "integration/worker_process_spec.rb",
      example: "drains the running handler on TERM and exits 0",
    },
    rust: { file: "worker_postgres.rs", test: "a_stuck_handler_is_abandoned_when_grace_ends" },
    typescript: { file: "worker-process.test.ts", pattern: "drain" },
    python: { file: "test_worker_process.py", pattern: "drain" },
    go: { file: "worker_process_test.go", pattern: "rain" },
  },
  {
    capability: "Retention maintenance participation",
    dotnet: {
      file: "Workhorse.Tests/WorkerTests.cs",
      test: "AMaintenancePassRunsTheRetentionRoutines",
    },
    jvm: {
      file: "run/workhorse/WorkerDatabaseTest.java",
      test: "runsTerminalStorageMaintenance",
    },
    ruby: {
      file: "integration/worker_runtime_spec.rb",
      example: "runs terminal storage maintenance",
    },
    rust: { file: "worker_postgres.rs", test: "a_worker_runs_terminal_storage_maintenance" },
    typescript: { file: "integration-retention-maintenance.test.ts", pattern: "retain" },
    python: { file: "test_worker.py", pattern: "participates_in_slow_maintenance" },
    go: { file: "worker_test.go", pattern: "ParticipatesInSlowMaintenance" },
  },
  {
    capability: "OpenTelemetry tracing and metrics",
    dotnet: {
      file: "Workhorse.Tests/Telemetry/TelemetryDatabaseTests.cs",
      test: "TheHandlerSpanContinuesTheTraceOfTheEnqueue",
    },
    jvm: {
      file: "run/workhorse/WorkerTelemetryDatabaseTest.java",
      test: "continuesTheEnqueuingTraceInTheHandlerSpanAndRecordsTheSharedMetrics",
    },
    ruby: {
      file: "integration/worker_runtime_spec.rb",
      example: "continues the enqueuing trace in the handler span and records the shared metrics",
    },
    rust: { file: "worker_postgres.rs", test: "worker_metrics_reach_the_global_meter_provider" },
    typescript: { file: "telemetry.test.ts", pattern: "span" },
    python: { file: "test_worker_telemetry.py", pattern: "span" },
    go: { file: "telemetry_test.go", pattern: "pan" },
  },
  {
    capability: "Shared runtime fixtures executed",
    dotnet: {
      fixtures: [
        "runtime/deadline-settles-after-early-local-timer",
        "runtime/deadline-waits-for-database-beyond-retry-budget",
        "runtime/execution-timeout-settles-after-early-local-timer",
        "runtime/empty-polls-back-off-with-jitter",
        "runtime/stop-drains-active-slots-without-new-claims",
        "runtime/busy-worker-refills-slots-with-overlapping-batched-claims",
        "runtime/budget-admission-holds-across-queues",
        "runtime/json-values-survive-the-payload-and-result-round-trip",
        "runtime/failing-maintenance-phase-leaves-the-worker-claiming",
        "runtime/durable-replay-conflicts-are-terminal",
        "runtime/oversized-full-tier-result-fails-through-the-retry-policy",
        "runtime/oversized-fast-tier-result-fails-through-the-retry-policy",
        "runtime/shutdown-cancellation-releases-the-task-without-an-attempt",
        "runtime/shutdown-cancellation-completes-a-task-whose-handler-returns-a-value",
      ],
    },
    jvm: {
      fixtures: [
        "runtime/stop-drains-active-slots-without-new-claims",
        "runtime/budget-admission-holds-across-queues",
        "runtime/empty-polls-back-off-with-jitter",
        "runtime/failing-maintenance-phase-leaves-the-worker-claiming",
        "runtime/json-values-survive-the-payload-and-result-round-trip",
        "runtime/shutdown-cancellation-releases-the-task-without-an-attempt",
        "runtime/shutdown-cancellation-completes-a-task-whose-handler-returns-a-value",
        "runtime/oversized-full-tier-result-fails-through-the-retry-policy",
        "runtime/busy-worker-refills-slots-with-overlapping-batched-claims",
        "runtime/durable-replay-conflicts-are-terminal",
      ],
    },
    ruby: {
      fixtures: [
        "runtime/enqueue-trace-context-reaches-handler",
        "runtime/stop-drains-active-slots-without-new-claims",
        "runtime/budget-admission-holds-across-queues",
        "runtime/empty-polls-back-off-with-jitter",
        "runtime/failing-maintenance-phase-leaves-the-worker-claiming",
        "runtime/json-values-survive-the-payload-and-result-round-trip",
      ],
    },
    rust: {
      fixtures: [
        "runtime/enqueue-trace-context-reaches-handler",
        "runtime/priority-ordered-mixed-batch",
        "runtime/stop-drains-active-slots-without-new-claims",
        "runtime/budget-admission-holds-across-queues",
        "runtime/empty-polls-back-off-with-jitter",
        "runtime/failing-maintenance-phase-leaves-the-worker-claiming",
      ],
    },
    typescript: { file: "integration-claim-lease-fence.test.ts", pattern: "runtime" },
    python: { file: "test_worker_runtime_conformance.py", pattern: "runtime" },
    go: { file: "runtime_conformance_test.go", pattern: "untime" },
  },
];

export const PARITY_OPERATOR_ROWS: readonly ParityRow[] = [
  {
    capability: "Task lookup, listing, and timeline",
    dotnet: {
      file: "Workhorse.Tests/AdminDatabaseTests.cs",
      test: "ListsTasksWithFiltersProjectionAndACursor",
    },
    jvm: {
      file: "run/workhorse/AdminDatabaseTest.java",
      test: "listsTasksWithFiltersProjectionAndACursor",
    },
    ruby: {
      file: "integration/admin_spec.rb",
      example: "lists tasks with filters, projection, and a cursor",
    },
    rust: { file: "admin_postgres.rs", test: "admin_lists_looks_up_and_times_tasks_across_pages" },
    typescript: { file: "integration-operator-reads.test.ts", pattern: "admin.listTasks" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "ListTasks" },
  },
  {
    capability: "Queue health snapshot",
    dotnet: { file: "Workhorse.Tests/Client/QueueControlTests.cs", test: "ReadsTheHealthSnapshot" },
    jvm: {
      file: "run/workhorse/QueueDatabaseTest.java",
      test: "readsTheQueueHealthSnapshot",
    },
    ruby: { file: "integration/client_spec.rb", example: "returns the queue health snapshot" },
    rust: { file: "client_postgres.rs", test: "health_returns_the_queue_health_snapshot" },
    typescript: { file: "integration-health-snapshots.test.ts", pattern: "health" },
    python: { file: "test_driver_integration.py", pattern: "health" },
    go: { file: "queue_test.go", pattern: "Health" },
  },
  {
    capability: "Cancellation requests",
    dotnet: { file: "Workhorse.Tests/Client/QueueControlTests.cs", test: "CancelsAReadyTask" },
    jvm: { file: "run/workhorse/QueueDatabaseTest.java", test: "cancelsATask" },
    ruby: {
      file: "integration/client_spec.rb",
      example: "reports each PostgreSQL cancel disposition",
    },
    rust: { file: "client_postgres.rs", test: "cancel_reports_each_postgres_disposition" },
    typescript: { file: "integration-operator-reads.test.ts", pattern: "cancel" },
    python: { file: "test_worker_runtime_conformance.py", pattern: "cancel" },
    go: { file: "worker_test.go", pattern: "Cancel" },
  },
  {
    capability: "Queue pause, resume, and purge",
    dotnet: { file: "Workhorse.Tests/AdminDatabaseTests.cs", test: "PausesResumesAndPurgesAQueue" },
    jvm: {
      file: "run/workhorse/AdminDatabaseTest.java",
      test: "pausesResumesAndPurgesAQueue",
    },
    ruby: { file: "integration/admin_spec.rb", example: "pauses, resumes, and purges a queue" },
    rust: { file: "admin_postgres.rs", test: "admin_pauses_resumes_and_purges_a_queue" },
    typescript: { file: "integration-queue-administration.test.ts", pattern: "admin.purgeQueue" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "PurgeQueue" },
  },
  {
    capability: "Queue tier and history controls",
    dotnet: {
      file: "Workhorse.Tests/AdminDatabaseTests.cs",
      test: "MovesAQueueBetweenTiersAndSetsItsHistory",
    },
    jvm: {
      file: "run/workhorse/AdminDatabaseTest.java",
      test: "movesAQueueBetweenTiersAndSetsItsHistory",
    },
    ruby: {
      file: "integration/admin_spec.rb",
      example: "moves a queue between tiers and sets its history",
    },
    rust: {
      file: "worker_postgres.rs",
      test: "a_fast_queue_records_attempt_history_only_when_it_opts_in",
    },
    typescript: {
      file: "integration-fast-tier.test.ts",
      patterns: ["admin.setQueueTier", "admin.setQueueHistory"],
    },
    python: {
      file: "test_worker_fast_tier.py",
      patterns: ["admin.set_queue_tier", "admin.set_queue_history"],
    },
    go: {
      file: "worker_fast_tier_test.go",
      patterns: ["admin.SetQueueTier", "admin.SetQueueHistory"],
    },
  },
  {
    capability: "Dead-letter listing and redrive",
    dotnet: {
      file: "Workhorse.Tests/AdminDatabaseTests.cs",
      test: "ListsDeadLettersAndRedrivesOne",
    },
    jvm: {
      file: "run/workhorse/AdminDatabaseTest.java",
      test: "listsDeadLettersAndRedrivesOne",
    },
    ruby: { file: "integration/admin_spec.rb", example: "lists dead letters and redrives one" },
    rust: { file: "admin_postgres.rs", test: "admin_lists_and_redrives_dead_letters" },
    typescript: { file: "integration-operator-reads.test.ts", pattern: "admin.redrive" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "Redrive" },
  },
  {
    capability: "Task group cancel",
    dotnet: {
      file: "Workhorse.Tests/AdminDatabaseTests.cs",
      test: "CancelsAGroupReadsItsEventsAndRepairsACounterThatDrifted",
    },
    jvm: {
      file: "run/workhorse/AdminDatabaseTest.java",
      test: "cancelsAGroupReadsItsEventsAndRepairsACounterThatDrifted",
    },
    ruby: {
      file: "integration/task_group_spec.rb",
      example: "cancels a group, reads its events, and repairs a counter that drifted",
    },
    rust: {
      file: "task_groups_postgres.rs",
      test: "an_operator_cancel_finishes_an_open_group_with_its_failure_callback",
    },
    typescript: { file: "integration-task-groups.test.ts", pattern: "cancelTaskGroup" },
    python: { file: "test_task_groups.py", pattern: "cancel_task_group" },
    go: { file: "task_groups_test.go", pattern: "CancelTaskGroup" },
  },
  {
    capability: "Task group drift listing and repair",
    dotnet: {
      file: "Workhorse.Tests/AdminDatabaseTests.cs",
      test: "CancelsAGroupReadsItsEventsAndRepairsACounterThatDrifted",
    },
    jvm: {
      file: "run/workhorse/AdminDatabaseTest.java",
      test: "cancelsAGroupReadsItsEventsAndRepairsACounterThatDrifted",
    },
    ruby: {
      file: "integration/task_group_spec.rb",
      example: "cancels a group, reads its events, and repairs a counter that drifted",
    },
    rust: { file: "task_groups_postgres.rs", test: "a_drifted_counter_is_listed_and_repaired" },
    typescript: { file: "integration-task-groups.test.ts", pattern: "repairTaskGroupDrift" },
    python: { file: "test_task_groups.py", pattern: "repair_task_group_drift" },
    go: { file: "task_groups_test.go", pattern: "RepairTaskGroupDrift" },
  },
  {
    capability: "Checkpoint, wait, and human-decision reads",
    dotnet: {
      file: "Workhorse.Tests/AdminDatabaseTests.cs",
      test: "ReadsCheckpointsProgressAndWaits",
    },
    jvm: {
      file: "run/workhorse/AdminDatabaseTest.java",
      test: "readsCheckpointsProgressAndWaits",
    },
    ruby: { file: "integration/admin_spec.rb", example: "reads checkpoints, progress, and waits" },
    rust: { file: "admin_postgres.rs", test: "admin_reads_checkpoints_waits_and_human_waits" },
    typescript: { file: "integration-human-waits.test.ts", pattern: "admin.listHumanWaits" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "ListHumanWaits" },
  },
  {
    capability: "Durable operator worker pause",
    dotnet: { file: "Workhorse.Tests/AdminDatabaseTests.cs", test: "ListsWorkersAndPausesOne" },
    jvm: {
      file: "run/workhorse/AdminDatabaseTest.java",
      test: "listsWorkersAndPausesOne",
    },
    ruby: { file: "integration/admin_spec.rb", example: "lists workers and pauses one" },
    rust: { file: "admin_postgres.rs", test: "admin_pauses_and_resumes_a_registered_worker" },
    typescript: { file: "integration-worker-registry.test.ts", pattern: "paused" },
    python: pythonAdmin,
    go: { file: "admin_test.go", pattern: "SetWorkerPaused" },
  },
  {
    capability: "Embedded dashboard backend",
    dotnet: {
      file: "Workhorse.AspNetCore.Tests/DashboardConformanceTests.cs",
      test: "AnswersEverySharedExchangeAndReportsThePoliciesBehindAQueue",
    },
    jvm: {
      file: "run/workhorse/dashboard/DashboardConformanceTest.java",
      test: "answersEverySharedExchangeAndReportsThePoliciesBehindAQueue",
    },
    ruby: {
      file: "integration/dashboard_conformance_spec.rb",
      example: "answers every shared exchange and reports the policies behind a queue",
    },
    typescript: {
      file: "../../dashboard-server/test/conformance.test.ts",
      pattern: "dashboard/v1 HTTP conformance fixtures",
    },
    python: { file: "test_dashboard_conformance.py", pattern: "dashboard/v1/conformance.json" },
    go: {
      file: "dashboard/conformance_test.go",
      pattern: "TestDashboardSatisfiesEverySharedHTTPScenario",
    },
    rust: {
      file: "dashboard_conformance.rs",
      test: "dashboard_satisfies_every_shared_http_scenario",
    },
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
  {
    capability: "Task group listing, detail, and cancel",
    postgresql: {
      file: "integration-task-group-shards.test.ts",
      patterns: ["dashboard_task_groups_v1", "listTaskGroupMembers", "cancelTaskGroup"],
    },
    // `test/conformance.test.ts` runs these shared fixtures but never names a task group, so the
    // cell cites the fixtures that exercise the three procedures.
    dashboard: {
      file: "../../dashboard/v1/conformance.json",
      patterns: [
        '"procedure": "taskGroups"',
        '"procedure": "taskGroupDetail"',
        '"procedure": "cancelTaskGroup"',
      ],
    },
    cli: {
      file: "integration-admin-cli.test.ts",
      patterns: ['"task-groups"', '"task-group"', '"cancel-task-group"'],
    },
  },
];

/**
 * An Active Job cell says whether a job enqueued through the adapter reaches a native capability.
 *
 * A cell the adapter reaches is Planned until the adapter ships, then Supported with Ruby evidence.
 * A native-only cell records why `perform` cannot reach the capability. `limit` names a partial
 * reach, such as a typed job whose payload passes its contract while no result is stored.
 */
export type ActiveJobParityCell =
  | ((RustFixtureEvidence | RubyExampleEvidence | { planned: string }) & { limit?: string })
  | { nativeOnly: string };

export interface ActiveJobParityRow {
  /** A Client or Worker row's capability, byte for byte. */
  capability: string;
  defaultJob: ActiveJobParityCell;
  typedJob: ActiveJobParityCell;
}

const activeJobSpec = "integration/active_job_spec.rb";
const noContext = { nativeOnly: "`perform` receives no handler context" } as const;
const noOption = { nativeOnly: "Active Job has no option for it" } as const;
const noWaiting = { nativeOnly: "Active Job has no model of one job waiting on another" } as const;

/**
 * The Client and Worker rows an Active Job job can reach, from ADR 0075's native-only table.
 *
 * The Ruby column above describes the native SDK. This table describes a Rails application that
 * enqueues through `ActiveJob::QueueAdapters::StablematesWorkhorseAdapter` instead.
 */
export const ACTIVE_JOB_PARITY_ROWS: readonly ActiveJobParityRow[] = [
  ...(
    [
      [
        "Transactional enqueue in a caller-owned tx",
        "commits and rolls back a perform_later of either format with the caller's Active Record transaction",
      ],
      [
        "Atomic batch enqueue",
        "enqueues perform_all_later jobs of both formats in one batch and records enqueue_error on an invalid priority",
      ],
      [
        "Delayed enqueue (`runAt` / `run_at`)",
        "sets run_at from set(wait:) and set(wait_until:) for both formats",
      ],
      [
        "Priority",
        "passes queue_as and priority through for both formats and refuses an out-of-range priority",
      ],
      [
        "Tags and max attempts",
        "tags each task with its job class and job ID and applies workhorse_options",
      ],
      ["Concurrency keys", "sets a concurrency key from a String or a lambda over the job"],
      ["Enqueue trace-context propagation", "records the enqueuing trace context for both formats"],
      ["Claiming and handler execution", "runs a default job and a typed job through the worker"],
      [
        "Bounded worker concurrency",
        "runs no more jobs of either format at once than the worker's concurrency",
      ],
      [
        "Heartbeats, lease recovery, fenced ownership",
        "reruns a job of either format whose worker died mid-perform",
      ],
      [
        "Graceful stop and signal drain",
        "drains a running job of either format when the worker stops",
      ],
    ] as const
  ).map(([capability, example]) => {
    const evidence = { file: activeJobSpec, example };
    return { capability, defaultJob: evidence, typedJob: evidence };
  }),
  {
    capability: "Payload and result contracts",
    defaultJob: { nativeOnly: "a default job's payload is Active Job's own serialization" },
    typedJob: {
      file: activeJobSpec,
      example: "applies the payload contract synced for a typed task type at enqueue",
      limit: "Payload only",
    },
  },
  ...["Persisted retry policies", "Absolute deadlines and execution timeouts"].map(
    (capability) => ({ capability, defaultJob: noOption, typedJob: noOption }),
  ),
  ...["Enqueue idempotency", "Keyed debounce", "Keyed throttle"].map((capability) => ({
    capability,
    defaultJob: { nativeOnly: "`retry_job` re-enqueues the same `job_id`" },
    typedJob: noOption,
  })),
  {
    capability: "Task groups with completion callbacks",
    defaultJob: {
      file: activeJobSpec,
      example: "makes the jobs enqueued inside a task group block its member tasks",
    },
    typedJob: {
      file: activeJobSpec,
      example: "makes the jobs enqueued inside a task group block its member tasks",
    },
  },
  {
    capability: "Task dependencies with terminal policies",
    defaultJob: noWaiting,
    typedJob: noWaiting,
  },
  {
    capability: "Recurring schedule definition sync",
    defaultJob: { nativeOnly: "a schedule enqueues a task type, not a serialized job" },
    typedJob: { nativeOnly: "recurring Active Job jobs are deferred past 0.6.0" },
  },
  ...[
    "Cooperative cancellation delivery",
    "Durable checkpoints (handler context)",
    "Durable timers (`sleep` / `sleepUntil`)",
    "Signal and human-decision waits",
    "Linked child fan-out and result join",
    "Latest-value progress reporting",
    "Batch handler delivery",
  ].map((capability) => ({ capability, defaultJob: noContext, typedJob: noContext })),
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
  ruby: ParityDefaultCell | { absent: string } | { planned: string };
  jvm?: ParityDefaultCell | { planned: string };
  dotnet?: ParityDefaultCell | { planned: string };
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
    dotnet: {
      value: "1",
      file: "dotnet/src/Workhorse/WorkerOptions.cs",
      pattern: "public int Concurrency { get; set; } = 1;",
    },
    jvm: {
      value: "1",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "private int concurrency = 1;",
    },
    rust: { value: "1", file: "rust/src/worker/mod.rs", pattern: "concurrency: 1," },
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
    ruby: {
      value: "1",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "concurrency: 1, lease: 30,",
    },
  },
  {
    setting: "Lease duration",
    dotnet: {
      value: "30,000 ms",
      file: "dotnet/src/Workhorse/WorkerOptions.cs",
      pattern: "public TimeSpan Lease { get; set; } = TimeSpan.FromSeconds(30);",
    },
    jvm: {
      value: "30,000 ms",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "private long leaseMs = 30_000;",
    },
    rust: {
      value: "30,000 ms",
      file: "rust/src/worker/mod.rs",
      pattern: "const DEFAULT_LEASE: Duration = Duration::from_secs(30);",
    },
    typescript: {
      value: "30,000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "options.leaseMs ?? 30_000",
    },
    python: {
      value: "30,000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "lease_ms: int = 30_000",
    },
    go: {
      value: "30,000 ms",
      file: "go/worker.go",
      pattern: "defaultWorkerLease         = 30 * time.Second",
    },
    ruby: {
      value: "30,000 ms",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "concurrency: 1, lease: 30,",
    },
  },
  {
    setting: "Heartbeat interval",
    dotnet: {
      value: "max(100 ms, lease duration / 3)",
      file: "dotnet/src/Workhorse/Worker.cs",
      pattern: "Math.Max(100, _leaseMs / 3)",
    },
    jvm: {
      value: "max(100 ms, lease duration / 3)",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "Math.max(100, leaseMs / 3)",
    },
    rust: {
      value: "max(100 ms, lease duration / 3)",
      file: "rust/src/worker/mod.rs",
      pattern: "(lease.as_millis() / 3).max(100)",
    },
    typescript: {
      value: "max(100 ms, lease duration / 3)",
      file: "typescript/core/src/worker.ts",
      pattern: "Math.max(100, Math.floor(this.leaseMs / 3))",
    },
    python: {
      value: "max(100 ms, lease duration / 3)",
      file: "python/src/workhorse/worker.py",
      pattern: "max(100, lease_ms // 3)",
    },
    go: {
      value: "max(100 ms, lease duration / 3)",
      file: "go/worker.go",
      pattern: "max(minimumDefaultHeartbeat, leaseDuration/3",
    },
    ruby: {
      value: "max(100 ms, lease duration / 3)",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "[100, @lease_ms / 3].max",
    },
  },
  {
    setting: "Claim poll interval (subscription live)",
    dotnet: {
      value: "5,000 ms",
      file: "dotnet/src/Workhorse/Worker.cs",
      pattern: "NotificationPollMs = 5_000",
    },
    jvm: {
      value: "5,000 ms",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "NOTIFICATION_POLL_MS = 5_000",
    },
    rust: {
      value: "5,000 ms",
      file: "rust/src/worker/mod.rs",
      pattern: "const LISTENING_POLL: Duration = Duration::from_secs(5);",
    },
    typescript: {
      value: "5,000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "DEFAULT_NOTIFICATION_FALLBACK_POLL_MS = 5_000",
    },
    python: {
      value: "5,000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "poll_ms if poll_ms is not None else 5_000",
    },
    go: {
      value: "5,000 ms",
      file: "go/worker.go",
      pattern: "defaultNotificationPollInterval = maximumEmptyPollInterval",
    },
    ruby: {
      value: "5,000 ms",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "NOTIFICATION_POLL_MS = 5_000",
    },
  },
  {
    setting: "Claim poll interval (polling only)",
    dotnet: {
      value: "250 ms",
      file: "dotnet/src/Workhorse/Worker.cs",
      pattern: "DefaultPollMs = 250",
    },
    jvm: {
      value: "250 ms",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "DEFAULT_POLL_MS = 250",
    },
    rust: {
      value: "250 ms",
      file: "rust/src/worker/mod.rs",
      pattern: "const POLLING_POLL: Duration = Duration::from_millis(250);",
    },
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
    ruby: {
      value: "250 ms",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "poll_interval.nil? ? 250 :",
    },
  },
  {
    setting: "Empty-claim backoff ceiling",
    dotnet: {
      value: "5,000 ms",
      file: "dotnet/src/Workhorse/Worker.Dispatch.cs",
      pattern: "MaxEmptyPollMs = 5_000",
    },
    jvm: {
      value: "5,000 ms",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "MAX_EMPTY_POLL_MS = 5_000",
    },
    rust: {
      value: "5,000 ms",
      file: "rust/src/worker/mod.rs",
      pattern: "const MAX_EMPTY_POLL: Duration = Duration::from_secs(5);",
    },
    typescript: {
      value: "5,000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "MAX_EMPTY_POLL_MS = 5_000",
    },
    python: {
      value: "5,000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "_MAX_EMPTY_POLL_MS = 5_000",
    },
    go: {
      value: "5,000 ms",
      file: "go/worker.go",
      pattern: "maximumEmptyPollInterval   = 5 * time.Second",
    },
    ruby: {
      value: "5,000 ms",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "MAX_EMPTY_POLL_MS = 5_000",
    },
  },
  {
    setting: "Maintenance tick interval",
    dotnet: {
      value: "1,000 ms",
      file: "dotnet/src/Workhorse/WorkerOptions.cs",
      pattern: "public TimeSpan MaintenanceInterval { get; set; } = TimeSpan.FromSeconds(1);",
    },
    jvm: {
      value: "1,000 ms",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "private long maintenanceMs = 1_000;",
    },
    rust: {
      value: "1,000 ms",
      file: "rust/src/worker/mod.rs",
      pattern: "maintenance_interval: Duration::from_secs(1),",
    },
    typescript: {
      value: "1,000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "options.maintenanceIntervalMs ?? 1_000",
    },
    python: {
      value: "1,000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "maintenance_interval_ms: int = 1_000",
    },
    go: {
      value: "1,000 ms",
      file: "go/worker.go",
      pattern: "defaultMaintenanceInterval = time.Second",
    },
    ruby: {
      value: "1,000 ms",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "maintenance_interval: 1,",
    },
  },
  {
    setting: "Maintenance routine offer interval",
    dotnet: {
      value: "60,000 ms",
      file: "dotnet/src/Workhorse/WorkerOptions.cs",
      pattern:
        "public TimeSpan MaintenanceRoutineInterval { get; set; } = TimeSpan.FromSeconds(60);",
    },
    jvm: {
      value: "60,000 ms",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "private long routineMs = 60_000;",
    },
    rust: {
      value: "60,000 ms",
      file: "rust/src/worker/mod.rs",
      pattern: "maintenance_routine_interval: Duration::from_secs(60),",
    },
    typescript: {
      value: "60,000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "options.maintenanceRoutinePollMs ?? 60_000",
    },
    python: {
      value: "60,000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "maintenance_routine_poll_ms: int = 60_000",
    },
    go: {
      value: "60,000 ms",
      file: "go/worker.go",
      pattern: "defaultMaintenanceRoutineInterval = time.Minute",
    },
    ruby: {
      value: "60,000 ms",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "maintenance_routine_interval: 60,",
    },
  },
  {
    setting: "Worker registry interval",
    dotnet: {
      value: "5,000 ms",
      file: "dotnet/src/Workhorse/WorkerOptions.cs",
      pattern: "public TimeSpan RegistryInterval { get; set; } = TimeSpan.FromSeconds(5);",
    },
    jvm: {
      value: "5,000 ms",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "private long registryMs = 5_000;",
    },
    rust: {
      value: "5,000 ms",
      file: "rust/src/worker/mod.rs",
      pattern: "registry_interval: Duration::from_secs(5),",
    },
    typescript: {
      value: "5,000 ms",
      file: "typescript/core/src/worker.ts",
      pattern: "options.registryIntervalMs ?? 5_000",
    },
    python: {
      value: "5,000 ms",
      file: "python/src/workhorse/worker.py",
      pattern: "registry_interval_ms: int = 5_000",
    },
    go: {
      value: "5,000 ms",
      file: "go/worker.go",
      pattern: "defaultRegistryInterval    = 5 * time.Second",
    },
    ruby: {
      value: "5,000 ms",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "registry_interval: 5,",
    },
  },
  {
    setting: "Schedule catch-up limit",
    dotnet: {
      value: "100",
      file: "dotnet/src/Workhorse/WorkerOptions.cs",
      pattern: "public int ScheduleCatchupLimit { get; set; } = 100;",
    },
    jvm: {
      value: "100",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "private int scheduleCatchupLimit = 100;",
    },
    rust: { value: "100", file: "rust/src/worker/mod.rs", pattern: "schedule_catchup_limit: 100," },
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
    ruby: {
      value: "100",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "schedule_catchup_limit: 100,",
    },
  },
  {
    setting: "Dispatch cohorts",
    dotnet: {
      value: "1 below concurrency 8, else concurrency / 8 within 2 to 8",
      file: "dotnet/src/Workhorse/Worker.cs",
      pattern: "concurrency < 8 ? 1 : Math.Clamp((concurrency + 7) / 8, 2, 8)",
    },
    jvm: {
      value: "1 below concurrency 8, else concurrency / 8 within 2 to 8",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "Math.clamp((concurrency + 7) / 8, 2, 8)",
    },
    rust: {
      value: "1 below concurrency 8, else concurrency / 8 within 2 to 8",
      file: "rust/src/worker/mod.rs",
      pattern: "concurrency.div_ceil(8).clamp(2, 8)",
    },
    typescript: {
      value: "1 below concurrency 8, else concurrency / 8 within 2 to 8",
      file: "typescript/core/src/worker.ts",
      pattern: "Math.min(8, Math.max(2, Math.ceil(concurrency / 8)))",
    },
    python: {
      value: "1 below concurrency 8, else concurrency / 8 within 2 to 8",
      file: "python/src/workhorse/worker.py",
      pattern: "min(8, max(2, -(-concurrency // 8)))",
    },
    go: {
      value: "1 below concurrency 8, else concurrency / 8 within 2 to 8",
      file: "go/worker.go",
      pattern: "min(8, max(2, (concurrency+7)/8))",
    },
    ruby: {
      value: "1 below concurrency 8, else concurrency / 8 within 2 to 8",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "((@concurrency + 7) / 8).clamp(2, 8)",
    },
  },
  {
    setting: "Shutdown grace, then",
    dotnet: {
      value: "25,000 ms, then abandon the handlers",
      file: "dotnet/src/Workhorse/WorkerOptions.cs",
      pattern: "public TimeSpan ShutdownGrace { get; set; } = TimeSpan.FromSeconds(25);",
    },
    jvm: {
      value: "25,000 ms, then abandon the handlers",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "private long shutdownGraceMs = 25_000;",
    },
    rust: {
      value: "25,000 ms, then abandon the handlers",
      file: "rust/src/worker/mod.rs",
      pattern: "shutdown_grace_period: Duration::from_secs(25),",
    },
    typescript: {
      value: "25,000 ms, then exit the process",
      file: "typescript/core/src/worker-process.ts",
      pattern: "DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000",
    },
    python: {
      value: "25,000 ms, then exit the process",
      file: "python/src/workhorse/worker_process.py",
      pattern: "_DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000",
    },
    go: {
      value: "25,000 ms, then abandon the handlers",
      file: "go/worker.go",
      pattern: "defaultShutdownGracePeriod = 25 * time.Second",
    },
    ruby: {
      value: "25,000 ms, then abandon the handlers",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "shutdown_grace: 25,",
    },
  },
  {
    setting: "Handler retry delay override",
    dotnet: {
      value: "`RetryDelay`, unset",
      file: "dotnet/src/Workhorse/WorkerOptions.cs",
      pattern: "public RetryDelay? RetryDelay { get; set; }",
    },
    jvm: {
      value: "`retryDelay`, unset",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "private @Nullable RetryDelay retryDelay;",
    },
    rust: {
      value: "`retry_delay`, unset",
      file: "rust/src/worker/mod.rs",
      pattern: "pub retry_delay: Option<RetryDelay>",
    },
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
    ruby: {
      value: "`retry_delay`, unset",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "retry_delay: nil,",
    },
  },
  {
    setting: "Handler retry delay override range",
    dotnet: {
      value: "0 to 2,147,483,647 ms, refused outside",
      file: "dotnet/src/Workhorse/Worker.Execution.cs",
      pattern: "internal static int RetryDelayMilliseconds(TimeSpan delay)",
    },
    jvm: {
      value: "0 to 2,147,483,647 ms, refused outside",
      file: "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      pattern: "static long retryDelayMilliseconds(Duration delay)",
    },
    rust: {
      value: "0 to 2,147,483,647 ms, refused outside",
      file: "rust/src/worker/execute.rs",
      pattern: "fn retry_delay_millis(delay: Duration) -> Result<i32, Error>",
    },
    typescript: {
      value: "0 to 2,147,483,647 ms, refused outside",
      file: "typescript/core/src/worker.ts",
      pattern: "const MAX_RETRY_DELAY_MS = 2_147_483_647;",
    },
    python: {
      value: "0 to 2,147,483,647 ms, refused outside",
      file: "python/src/workhorse/worker.py",
      pattern: "_MAX_RETRY_DELAY_MS = 2_147_483_647",
    },
    go: {
      value: "0 to 2,147,483,647 ms, refused outside",
      file: "go/worker.go",
      pattern: "const maxRetryDelay = 2147483647 * time.Millisecond",
    },
    ruby: {
      value: "0 to 2,147,483,647 ms, refused outside",
      file: "ruby/lib/stablemates/workhorse/worker.rb",
      pattern: "def retry_delay_milliseconds(delay)",
    },
  },
  {
    setting: "Enqueue execution timeout",
    dotnet: {
      value: "Unset or 0 is none; else 1 to 31,536,000,000 ms",
      file: "dotnet/src/Workhorse/Queue.cs",
      pattern: "private static long? ExecutionTimeout(TimeSpan? timeout)",
    },
    jvm: {
      value: "Unset or 0 is none; else 1 to 31,536,000,000 ms",
      file: "jvm/workhorse/src/main/java/run/workhorse/Queue.java",
      pattern: "private static @Nullable Long executionTimeout(@Nullable Duration timeout)",
    },
    rust: {
      value: "Unset or 0 is none; else 1 to 31,536,000,000 ms",
      file: "rust/src/enqueue.rs",
      pattern: "options.execution_timeout_ms.filter(|value| *value != 0).into()",
    },
    typescript: {
      value: "Unset or 0 is none; else 1 to 31,536,000,000 ms",
      file: "typescript/core/src/queue/enqueue-contracts.ts",
      pattern: "return value === undefined || value === 0 ? null : value;",
    },
    python: {
      value: "Unset or 0 is none; else 1 to 31,536,000,000 ms",
      file: "python/src/workhorse/_protocol.py",
      pattern: "return None if value is None or value == 0 else value",
    },
    go: {
      value: "Unset or 0 is none; else 1 to 31,536,000,000 ms",
      file: "go/queue.go",
      pattern: "ExecutionTimeoutMS:   nilIfZero(options.ExecutionTimeoutMS),",
    },
    ruby: {
      value: "Unset or 0 is none; else 1 to 31,536,000,000 ms",
      file: "ruby/lib/stablemates/workhorse/queue.rb",
      pattern: "return nil if value.nil? || (value.is_a?(Numeric) && value.zero?)",
    },
  },
  {
    setting: "Queue of a handler task group add without a queue",
    dotnet: {
      value: "The queue of the member task",
      file: "dotnet/src/Workhorse/Queue.Durable.cs",
      pattern: "request with { Options = request.Options with { Queue = task.Queue } }",
    },
    jvm: {
      value: "The queue of the member task",
      file: "jvm/workhorse/src/main/java/run/workhorse/Queue.java",
      pattern: "request.options().toBuilder().queue(task.queue()).build())",
    },
    rust: {
      value: "The queue of the member task",
      file: "rust/src/context.rs",
      pattern: "let group_enqueue = EnqueueClient::new(task.queue.as_str());",
    },
    typescript: {
      value: "The queue of the member task",
      file: "typescript/core/src/queue/task-groups.ts",
      pattern: "? { ...request, options: { ...request.options, queue: task.queue } }",
    },
    python: {
      value: "The queue of the member task",
      file: "python/src/workhorse/worker.py",
      pattern: "replace(request, options=replace(request.options, queue=self._task.queue))",
    },
    go: {
      value: "The queue of the member task",
      file: "go/task_groups.go",
      pattern: "executor: handler.executor, defaultQueue: handler.Task.Queue,",
    },
    ruby: {
      value: "The queue of the member task",
      file: "ruby/lib/stablemates/workhorse/queue.rb",
      pattern: "request.with(queue: task.queue)",
    },
  },
  {
    setting: "Queue of a child task request without a queue",
    dotnet: {
      value: "The queue of the parent task",
      file: "dotnet/src/Workhorse/Queue.Durable.cs",
      pattern: 'input["queue"] = stored?.Queue ?? parent.Queue;',
    },
    jvm: {
      value: "The queue of the parent task",
      file: "jvm/workhorse/src/main/java/run/workhorse/Queue.java",
      pattern: 'input.put("queue", storedQueue == null ? parent.queue() : storedQueue);',
    },
    rust: {
      value: "The queue of the parent task",
      file: "rust/src/children.rs",
      pattern: "stored_queue.unwrap_or(&parent.queue),",
    },
    typescript: {
      value: "The queue of the parent task",
      file: "typescript/core/src/queue/child-tasks.ts",
      pattern: "queue: options.queue ?? storedQueue ?? parent.queue,",
    },
    python: {
      value: "The queue of the parent task",
      file: "python/src/workhorse/_protocol.py",
      pattern: '"queue": options.queue or parent.queue,',
    },
    go: {
      value: "The queue of the parent task",
      file: "go/child_tasks.go",
      pattern: "queueName = handler.Task.Queue",
    },
    ruby: {
      value: "The queue of the parent task",
      file: "ruby/lib/stablemates/workhorse/queue.rb",
      pattern: 'input["queue"] = stored_queue || parent.queue if',
    },
  },
];
