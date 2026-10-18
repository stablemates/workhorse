package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.internal.Row;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/** The Java client against PostgreSQL: one or more tests for each client row of parity. */
@ExtendWith(ScratchDatabase.class)
class QueueDatabaseTest {
  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));

  private static String unique(String prefix) {
    return prefix + "-" + UUID.randomUUID();
  }

  private static Optional<Row> stored(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      List<Row> rows = Sql.rows(connection, SqlCatalogue.GET_TASK, taskId.toString());
      return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }
  }

  private static Row task(UUID taskId) throws SQLException {
    return stored(taskId).orElseThrow();
  }

  private static long count(String sql, String parameter) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.setString(1, parameter);
      try (ResultSet result = statement.executeQuery()) {
        result.next();
        return result.getLong(1);
      }
    }
  }

  private static long tasksIn(String queueName) throws SQLException {
    return count("SELECT count(*) FROM workhorse.task WHERE queue_name = ?", queueName);
  }

  // Transactional enqueue in a caller-owned transaction.

  @Test
  void enqueuesInsideACallerTransactionThatCommits() throws SQLException {
    String name = unique("caller");
    try (Connection connection = ScratchDatabase.connect()) {
      connection.setAutoCommit(false);
      EnqueueResult result =
          queue.enqueue(connection, "email.send", Map.of("to", "a"), queueOptions(name).build());
      assertEquals(EnqueueOutcome.ACCEPTED, result.outcome());
      assertTrue(stored(result.taskId()).isEmpty(), "invisible before the commit");
      assertFalse(connection.getAutoCommit(), "the queue changes no session state");
      connection.commit();
      assertEquals("email.send", task(result.taskId()).text("task_type"));
    }
  }

  @Test
  void enqueuesNothingWhenTheCallerTransactionRollsBack() throws SQLException {
    String name = unique("rollback");
    UUID taskId;
    try (Connection connection = ScratchDatabase.connect()) {
      connection.setAutoCommit(false);
      taskId =
          queue
              .enqueueMany(
                  connection,
                  List.of(
                      EnqueueRequest.of("a", null, queueOptions(name).build()),
                      EnqueueRequest.of("b", 1, queueOptions(name).build())))
              .get(0)
              .taskId();
      queue.createTaskGroup(connection, TaskGroupCallbacks.none());
      connection.rollback();
    }
    assertTrue(stored(taskId).isEmpty());
    assertEquals(0, tasksIn(name));
  }

  @Test
  void theSourceFormRunsInAutocommitAndRestoresThePoolMode() throws SQLException {
    ScratchDataSource pool = new ScratchDataSource(false);
    Queue pooled = new Queue(ConnectionSource.of(pool));
    EnqueueResult result = pooled.enqueue("pooled", null, queueOptions(unique("pool")).build());
    assertTrue(stored(result.taskId()).isPresent(), "committed without a caller commit");
    assertEquals(List.of(false), pool.autoCommitAtClose().subList(0, 1));
    assertTrue(pool.autoCommitAtClose().stream().allMatch(mode -> !mode));
  }

  @Test
  void aQueueConstructsWithoutAStatement() {
    ConnectionSource refuses =
        new ConnectionSource() {
          @Override
          public Connection acquire() throws SQLException {
            throw new SQLException("no connection", "08001");
          }

          @Override
          public void release(Connection connection, boolean transactional) {}
        };
    Queue offline = new Queue(refuses);
    DatabaseException error = assertThrows(DatabaseException.class, offline::assertCompatible);
    assertEquals("08001", error.sqlState());
  }

  // Atomic batch enqueue.

  @Test
  void aBatchCommitsAsOneStatement() throws SQLException {
    String name = unique("batch");
    String key = unique("key");
    EnqueueOptions keyed = queueOptions(name).idempotency(new Idempotency(key)).build();
    UUID first = queue.enqueue("report", Map.of("v", 1), keyed).taskId();

    EnqueueIdempotencyConflictException error =
        assertThrows(
            EnqueueIdempotencyConflictException.class,
            () ->
                queue.enqueueMany(
                    List.of(
                        EnqueueRequest.of("other", null, queueOptions(name).build()),
                        EnqueueRequest.of("report", Map.of("v", 2), keyed))));
    assertEquals(first.toString(), error.details().get("existingTaskId"));
    assertEquals(1, tasksIn(name), "the first request of the refused batch is absent");

    List<EnqueueResult> results =
        queue.enqueueMany(
            List.of(
                EnqueueRequest.of("x", 1, queueOptions(name).build()),
                EnqueueRequest.of("y", 2, queueOptions(name).build())));
    assertEquals(2, results.size());
    assertEquals("x", task(results.get(0).taskId()).text("task_type"));
    assertEquals("y", task(results.get(1).taskId()).text("task_type"));
    assertEquals(List.of(), queue.enqueueMany(List.of()));
  }

  // Task groups with completion callbacks.

  @Test
  void createsAddsSealsAndReadsATaskGroup() throws SQLException {
    String name = unique("group");
    TaskGroupCallbacks callbacks =
        new TaskGroupCallbacks(
            EnqueueRequest.of("group.done", null, queueOptions(name).build()), null, null);
    TaskGroup group = queue.createTaskGroup(callbacks);
    assertEquals(TaskGroupState.OPEN, group.state());
    assertEquals(
        List.of(new TaskGroupCallback(TaskGroupCallbackKind.ON_FINISH, null)), group.callbacks());

    List<EnqueueRequest> requests = new ArrayList<>();
    for (int index = 0; index < 3; index++) {
      requests.add(EnqueueRequest.of("member", index, queueOptions(name).build()));
    }
    List<EnqueueResult> added = queue.addToTaskGroup(group.id(), requests);
    assertEquals(3, added.size());

    TaskGroupMemberPage first = queue.listTaskGroupMembers(group.id(), 0, 2);
    assertEquals(2, first.members().size());
    assertEquals(2L, first.nextAfter());
    TaskGroupMemberPage last = queue.listTaskGroupMembers(group.id(), first.nextAfter(), 2);
    assertEquals(
        List.of(added.get(2).taskId()),
        last.members().stream().map(TaskGroupMember::taskId).toList());
    assertNull(last.nextAfter());
    assertEquals(TaskState.READY, last.members().get(0).state());

    TaskGroupLink link = queue.findTaskGroup(added.get(0).taskId()).orElseThrow();
    assertEquals(TaskGroupRole.MEMBER, link.role());
    assertEquals(group.id(), link.group().id());

    TaskGroup sealed = queue.sealTaskGroup(group.id());
    assertEquals(TaskGroupState.SEALED, sealed.state());
    assertEquals(new TaskGroupCounts(3, 0, 0, 0, 3L), sealed.counts());
    assertEquals(sealed, queue.getTaskGroup(group.id()).orElseThrow());
    assertTrue(queue.getTaskGroup(UUID.randomUUID()).isEmpty());
    assertTrue(queue.findTaskGroup(UUID.randomUUID()).isEmpty());

    TaskGroupClosedException closed =
        assertThrows(
            TaskGroupClosedException.class,
            () -> queue.addToTaskGroup(group.id(), List.of(requests.get(0))));
    assertEquals(group.id(), closed.groupId());
    assertEquals(TaskGroupClosedException.Reason.SEALED, closed.reason());
  }

  @Test
  void theBlockFormCreatesAddsAndSealsInOneStatement() throws SQLException {
    String name = unique("block");
    TaskGroupBlockResult result =
        queue.taskGroup(
            TaskGroupCallbacks.none(),
            builder -> {
              builder.enqueue("one", 1, queueOptions(name).build());
              builder.enqueue("two", 2, queueOptions(name).build());
            });
    assertEquals(TaskGroupState.SEALED, result.group().state());
    assertEquals(2, result.tasks().size());
    assertEquals("two", task(result.tasks().get(1).taskId()).text("task_type"));

    TaskGroupBlockResult empty = queue.taskGroup(TaskGroupCallbacks.none(), builder -> {});
    assertEquals(TaskGroupState.FINISHED, empty.group().state());

    assertThrows(
        IllegalStateException.class,
        () ->
            queue.taskGroup(
                TaskGroupCallbacks.none(),
                builder -> {
                  builder.enqueue("never", null, queueOptions(name).build());
                  throw new IllegalStateException("block failed");
                }));
    assertEquals(2, tasksIn(name));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            queue.taskGroup(
                TaskGroupCallbacks.none(),
                builder ->
                    builder.enqueue(
                        "debounced",
                        null,
                        queueOptions(name)
                            .debounce(new Debounce("k", Duration.ofSeconds(1)))
                            .build())));
  }

  // Delayed enqueue, priority, tags and max attempts, retry policies, deadlines and timeouts,
  // concurrency keys, and named budgets.

  @Test
  void storesEveryTaskOption() throws SQLException {
    String name = unique("options");
    Instant runAt = Instant.now().plus(Duration.ofHours(1));
    Instant deadline = runAt.plus(Duration.ofHours(1));
    queue.syncBudgets(unique("budgets"), List.of(new BudgetDefinition(name, 5, null)));
    EnqueueResult result =
        queue.enqueue(
            "options",
            Map.of("n", 1),
            queueOptions(name)
                .runAt(runAt)
                .deadline(deadline)
                .priority(7)
                .tags("a", "b")
                .maxAttempts(3)
                .retryPolicy(Map.of("type", "fixed", "delayMs", 1500))
                .executionTimeout(Duration.ofSeconds(30))
                .concurrencyKey("tenant-1")
                .budget(name)
                .build());
    Row row = task(result.taskId());
    assertEquals("scheduled", row.text("state"));
    assertEquals(name, row.text("queue_name"));
    assertEquals(7, row.integer("priority"));
    assertEquals(List.of("a", "b"), row.textList("tags"));
    assertEquals(3, row.integer("max_attempts"));
    assertEquals(Map.of("type", "fixed", "delayMs", 1500L), row.json("retry_policy"));
    assertEquals(30_000L, row.longValue("execution_timeout_ms"));
    assertEquals("tenant-1", row.text("concurrency_key"));
    assertEquals(deadline.toEpochMilli(), row.requiredInstant("deadline_at").toEpochMilli());
    assertEquals(runAt.toEpochMilli(), row.requiredInstant("run_at").toEpochMilli());
    assertEquals(Map.of("n", 1L), row.json("payload"));

    Row defaults = task(queue.enqueue("defaults", null, queueOptions(name).build()).taskId());
    assertEquals("ready", defaults.text("state"));
    assertEquals(0, defaults.integer("priority"));
    assertEquals(25, defaults.integer("max_attempts"));
    assertNull(defaults.text("retry_policy"));
    assertNull(defaults.json("payload"));
    Row named = task(queue.enqueue("default-queue", null).taskId());
    assertEquals("default", named.text("queue_name"));
  }

  @Test
  void refusesAnInvalidOptionBeforeAnyStatement() throws SQLException {
    String name = unique("invalid");
    List<EnqueueOptions> invalid =
        List.of(
            queueOptions(name).priority(101).build(),
            queueOptions(name).maxAttempts(101).build(),
            queueOptions(name).tags(List.of("")).build(),
            queueOptions(name).retryPolicy(Map.of("type", "fixed")).build(),
            queueOptions(name)
                .retryPolicy(
                    Map.of(
                        "type",
                        "exponential",
                        "initialDelayMs",
                        10,
                        "multiplier",
                        2,
                        "maxDelayMs",
                        5))
                .build(),
            queueOptions(name).executionTimeout(Duration.ofSeconds(-1)).build(),
            queueOptions(name)
                .idempotency(new Idempotency("k"))
                .throttle(new Throttle("k", Duration.ofSeconds(1)))
                .build(),
            queueOptions(name)
                .debounce(new Debounce("k", Duration.ofSeconds(1)))
                .runAt(Instant.now())
                .build(),
            queueOptions(name)
                .dependencies(
                    new Dependencies(
                        List.of(),
                        DependencyPolicy.RELEASE,
                        DependencyPolicy.CANCEL,
                        DependencyPolicy.FAIL))
                .build(),
            queueOptions("x".repeat(257)).build());
    for (EnqueueOptions options : invalid) {
      assertThrows(
          IllegalArgumentException.class,
          () -> queue.enqueue("t", null, options),
          options.toString());
    }
    IllegalArgumentException error =
        assertThrows(
            IllegalArgumentException.class,
            () -> queue.enqueue("t", Instant.EPOCH, queueOptions(name).build()));
    assertTrue(error.getMessage().startsWith("enqueue request 1: payload is not a JSON value"));
    assertThrows(IllegalArgumentException.class, () -> queue.enqueue("", null));
    assertEquals(0, tasksIn(name));
  }

  // Enqueue idempotency, keyed debounce, and keyed throttle.

  @Test
  void replaysAnIdempotentEnqueue() {
    EnqueueOptions options =
        queueOptions(unique("idempotent"))
            .idempotency(new Idempotency(unique("key"), "billing", Duration.ofMinutes(5)))
            .build();
    EnqueueResult first = queue.enqueue("invoice", Map.of("id", 1), options);
    EnqueueResult second = queue.enqueue("invoice", Map.of("id", 1), options);
    assertEquals(EnqueueOutcome.ACCEPTED, first.outcome());
    assertEquals(EnqueueOutcome.REPLAYED, second.outcome());
    assertEquals(first.taskId(), second.taskId());
    assertNull(second.reason());
  }

  @Test
  void replacesAPendingTaskInsideItsDebounceWindow() throws SQLException {
    String name = unique("debounce");
    EnqueueOptions options =
        queueOptions(name).debounce(new Debounce(unique("key"), Duration.ofMinutes(1))).build();
    EnqueueResult first = queue.enqueue("index", Map.of("v", 1), options);
    assertEquals("scheduled", task(first.taskId()).text("state"));
    EnqueueResult second = queue.enqueue("index", Map.of("v", 2), options);
    assertEquals(EnqueueOutcome.REPLACED, second.outcome());
    assertEquals(first.taskId(), second.taskId());
    assertEquals(Map.of("v", 2L), task(first.taskId()).json("payload"));

    queue.cancel(first.taskId(), "ops", null);
    EnqueueResult third = queue.enqueue("index", Map.of("v", 3), options);
    assertEquals(EnqueueOutcome.NON_REPLACEABLE, third.outcome());
    assertEquals(EnqueueNonReplaceableReason.NOT_PENDING, third.reason());
  }

  @Test
  void coalescesRequestsInsideAThrottleWindow() throws SQLException {
    EnqueueOptions options =
        queueOptions(unique("throttle"))
            .throttle(new Throttle(unique("key"), Duration.ofMinutes(1)))
            .build();
    EnqueueResult first = queue.enqueue("digest", Map.of(), options);
    EnqueueResult second = queue.enqueue("digest", Map.of(), options);
    assertEquals(EnqueueOutcome.ACCEPTED, first.outcome());
    assertEquals(EnqueueOutcome.COALESCED, second.outcome());
    assertEquals(first.taskId(), second.taskId());
    assertEquals("ready", task(first.taskId()).text("state"));
  }

  // Task dependencies with terminal policies.

  @Test
  void blocksATaskOnItsDependencies() throws SQLException {
    String name = unique("dependencies");
    UUID prerequisite = queue.enqueue("extract", null, queueOptions(name).build()).taskId();
    Dependencies dependencies =
        new Dependencies(
            List.of(prerequisite),
            DependencyPolicy.RELEASE,
            DependencyPolicy.CANCEL,
            DependencyPolicy.FAIL);
    UUID dependent =
        queue.enqueue("load", null, queueOptions(name).dependencies(dependencies).build()).taskId();
    Row row = task(dependent);
    assertEquals("blocked", row.text("state"));
    assertEquals(prerequisite.toString(), row.text("prerequisite_task_id"));
    assertEquals("release", row.text("dependency_on_success"));
    assertEquals("cancel", row.text("dependency_on_failure"));
    assertEquals("fail", row.text("dependency_on_cancellation"));
  }

  // Concurrency policy, rate limit policy, and named budget management.

  @Test
  void syncsListsAndPrunesConcurrencyPolicies() {
    String namespace = unique("concurrency");
    String name = unique("queue");
    List<ConcurrencyPolicy> stored =
        queue.syncConcurrencyPolicies(
            namespace, List.of(new ConcurrencyPolicyDefinition(name, 5, 2)));
    assertEquals(1, stored.size());
    ConcurrencyPolicy policy = stored.get(0);
    assertEquals(
        List.of(namespace, name, 5, 2),
        List.of(policy.namespace(), policy.queue(), policy.maxActive(), policy.maxActivePerKey()));
    assertEquals(stored, queue.listConcurrencyPolicies(List.of(name)));
    assertTrue(queue.listConcurrencyPolicies().contains(policy));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            queue.syncConcurrencyPolicies(
                namespace, List.of(new ConcurrencyPolicyDefinition(name, 5, 6))));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            queue.syncConcurrencyPolicies(
                namespace,
                List.of(
                    new ConcurrencyPolicyDefinition(name, 1),
                    new ConcurrencyPolicyDefinition(name, 2))));
    assertEquals(List.of(), queue.syncConcurrencyPolicies(namespace, List.of()));
    assertEquals(List.of(), queue.listConcurrencyPolicies(List.of(name)));
  }

  @Test
  void syncsListsAndPrunesRateLimitPolicies() {
    String namespace = unique("rate");
    String name = unique("queue");
    RateLimit rate = new RateLimit(10, Duration.ofSeconds(1), 20);
    RateLimit perKey = new RateLimit(1, Duration.ofMillis(250), 1);
    List<RateLimitPolicy> stored =
        queue.syncRateLimitPolicies(
            namespace, List.of(new RateLimitPolicyDefinition(name, rate, perKey)));
    assertEquals(rate, stored.get(0).rate());
    assertEquals(perKey, stored.get(0).perKey());
    assertEquals(stored, queue.listRateLimitPolicies(List.of(name)));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            queue.syncRateLimitPolicies(
                namespace,
                List.of(
                    new RateLimitPolicyDefinition(name, new RateLimit(1, Duration.ofDays(2), 1)))));
    assertEquals(List.of(), queue.syncRateLimitPolicies(namespace, List.of(), true));
    assertEquals(List.of(), queue.listRateLimitPolicies(List.of(name)));
  }

  @Test
  void syncsListsAndPrunesBudgets() {
    String namespace = unique("budget");
    String name = unique("budget");
    RateLimit rate = new RateLimit(3, Duration.ofMinutes(1), 3);
    List<Budget> stored =
        queue.syncBudgets(namespace, List.of(new BudgetDefinition(name, 4, rate)));
    assertEquals(4, stored.get(0).maxActive());
    assertEquals(rate, stored.get(0).rate());
    assertEquals(stored, queue.listBudgets(List.of(name)));
    assertTrue(queue.listBudgets().containsAll(stored));
    assertThrows(
        IllegalArgumentException.class,
        () -> queue.syncBudgets(namespace, List.of(new BudgetDefinition(name, null, null))));
    String kept = unique("kept");
    queue.syncBudgets(namespace, List.of(new BudgetDefinition(kept, 1, null)), false);
    assertEquals(2, queue.listBudgets(List.of(name, kept)).size());
    queue.syncBudgets(namespace, List.of(new BudgetDefinition(kept, 1, null)));
    assertEquals(
        List.of(kept), queue.listBudgets(List.of(name, kept)).stream().map(Budget::name).toList());
  }

  // Recurring schedule definition sync.

  @Test
  void syncsAndPrunesScheduleDefinitions() throws SQLException {
    String namespace = unique("schedules");
    ScheduledTask task =
        new ScheduledTask("report.nightly", Map.of("k", 1), "reports", 5, "tenant", 3, null);
    queue.syncSchedules(
        namespace,
        List.of(
            new ScheduleDefinition(
                "nightly", "0 3 * * *", task, "Europe/Berlin", CatchupPolicy.LATEST, true),
            new ScheduleDefinition(
                "hourly", "0 * * * *", ScheduledTask.of("report.hourly", null))));
    String sql = "SELECT count(*) FROM workhorse.schedule_definition WHERE namespace = ?";
    assertEquals(2, count(sql, namespace));
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT cron_expression, timezone, queue_name, task_type FROM"
                    + " workhorse.schedule_definition WHERE namespace = ? AND schedule_name ="
                    + " 'nightly'")) {
      statement.setString(1, namespace);
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next());
        assertEquals("0 3 * * *", result.getString(1));
        assertEquals("Europe/Berlin", result.getString(2));
        assertEquals("reports", result.getString(3));
        assertEquals("report.nightly", result.getString(4));
      }
    }
    queue.syncSchedules(namespace, List.of());
    assertEquals(
        0,
        count(sql + " AND configured_enabled", namespace),
        "prune disables a schedule missing from the sync");
  }

  // Payload and result contracts.

  @Test
  void validatesAndStampsAContractedPayload() throws SQLException {
    String type = unique("contracted");
    Map<String, Object> schema =
        Map.of(
            "type",
            "object",
            "required",
            List.of("id"),
            "properties",
            Map.of("id", Map.of("type", "integer")));
    queue.syncContracts(
        Map.of(
            type,
            new TaskTypeContracts(
                "v1",
                Map.of(
                    "v1",
                    new TaskContractVersion(
                        schema, true, 2048L, null, List.of("secret"), List.of())))));
    EnqueueResult result = queue.enqueue(type, Map.of("id", 1, "secret", "s"));
    Row row = task(result.taskId());
    assertEquals("v1", row.text("contract_version"));
    assertEquals(Map.of("id", 1L), row.json("payload"), "a read redacts the sensitive key");

    ContractValidationException error =
        assertThrows(
            ContractValidationException.class, () -> queue.enqueue(type, Map.of("id", "one")));
    assertEquals(type, error.taskType());
    assertEquals("v1", error.version());
    assertEquals("payload", error.part());
  }

  @Test
  void reloadsAStaleContractAndRetriesOnce() throws SQLException {
    String type = unique("stale");
    Queue other = new Queue(ConnectionSource.of(dataSource));
    queue.syncContracts(contracts(type, "v1"));
    queue.enqueue(type, Map.of());
    other.syncContracts(contracts(type, "v2"));
    EnqueueResult result = queue.enqueue(type, Map.of());
    assertEquals("v2", task(result.taskId()).text("contract_version"));
  }

  @Test
  void aRolledBackContractDoesNotStayInTheQueueCache() throws SQLException {
    String type = unique("rolled-back");
    queue.syncContracts(typed(type, "v1"));
    queue.enqueue(type, 1);
    try (Connection connection = ScratchDatabase.connect()) {
      connection.setAutoCommit(false);
      queue.syncContracts(connection, typed(type, "v2"));
      assertEquals(EnqueueOutcome.ACCEPTED, queue.enqueue(connection, type, "text").outcome());
      assertThrows(ContractValidationException.class, () -> queue.enqueue(connection, type, 2));
      connection.rollback();
    }
    EnqueueResult result = queue.enqueue(type, 3);
    assertEquals("v1", task(result.taskId()).text("contract_version"));
  }

  /** Version v1 accepts an integer, and version v2 accepts a string. */
  private static Map<String, TaskTypeContracts> typed(String type, String current) {
    return Map.of(
        type,
        new TaskTypeContracts(
            current,
            Map.of(
                "v1", new TaskContractVersion(Map.of("type", "integer"), true),
                "v2", new TaskContractVersion(Map.of("type", "string"), true))));
  }

  @Test
  void refusesAContractWithPatternOrPatternProperties() {
    for (Object schema :
        List.of(
            Map.of("type", "string", "pattern", "^a$"),
            Map.of("properties", Map.of("code", Map.of("type", "string", "pattern", "^a$"))),
            Map.of("type", "object", "patternProperties", Map.of("^a", true)))) {
      IllegalArgumentException error =
          assertThrows(
              IllegalArgumentException.class,
              () ->
                  queue.syncContracts(
                      Map.of(
                          unique("pattern"),
                          new TaskTypeContracts(
                              "v1", Map.of("v1", new TaskContractVersion(schema, true))))));
      assertTrue(
          error.getMessage().endsWith("is outside the Workhorse contract profile"),
          error.getMessage());
    }
  }

  private static Map<String, TaskTypeContracts> contracts(String type, String version) {
    return Map.of(
        type,
        new TaskTypeContracts(
            version,
            Map.of(
                "v1", new TaskContractVersion(Map.of("type", "object"), true),
                "v2", new TaskContractVersion(Map.of("type", "object"), true))));
  }

  // Compatibility refusal before mutation, and the public startup check.

  @Test
  void refusesAnIncompatibleSchemaBeforeAnyMutation() throws SQLException {
    queue.assertCompatible();
    String name = unique("refused");
    try (Connection connection = ScratchDatabase.connect()) {
      connection.setAutoCommit(false);
      try (Statement statement = connection.createStatement()) {
        statement.execute("DELETE FROM workhorse.schema_version");
        statement.execute("INSERT INTO workhorse.schema_version (version) VALUES (1)");
      }
      Queue fresh = new Queue(ConnectionSource.of(dataSource));
      CompatibilityException error =
          assertThrows(
              CompatibilityException.class,
              () -> fresh.enqueue(connection, "t", null, queueOptions(name).build()));
      assertEquals(CompatibilityException.Code.SCHEMA_TOO_OLD, error.code());
      assertEquals("workhorse compatibility check refused: schema-too-old", error.getMessage());
      assertThrows(CompatibilityException.class, () -> fresh.assertCompatible(connection));
      connection.rollback();
    }
    assertEquals(0, tasksIn(name));
  }

  @Test
  void mapsAClaimAboveReadCommittedToAnIsolationLevelException() throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      connection.setAutoCommit(false);
      connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
      IsolationLevelException error =
          assertThrows(
              IsolationLevelException.class,
              () ->
                  Sql.rows(
                      connection, SqlCatalogue.CLAIM_V1, unique("claim"), "worker-1", "30000"));
      assertEquals("repeatable read", error.isolationLevel());
      assertEquals("0A000", error.sqlState());
      connection.rollback();
    }
  }

  // Cancellation, signals, human waits, and queue health.

  @Test
  void cancelsATask() {
    UUID taskId = queue.enqueue("cancel.me", null, queueOptions(unique("cancel")).build()).taskId();
    CancelResult result = queue.cancel(taskId, "ops", "not needed");
    assertEquals(CancelStatus.CANCELED, result.status());
    assertEquals(TaskState.CANCELED, result.state());
    assertEquals("ops", result.requestedBy());
    assertEquals("not needed", result.reason());
    assertEquals(TaskState.CANCELED, queue.cancel(taskId, null, null).state());
    CancelResult missing = queue.cancel(UUID.randomUUID(), null, null);
    assertEquals(CancelStatus.NOT_FOUND, missing.status());
    assertNull(missing.state());
  }

  @Test
  void deliversSignalsAndHumanDecisionsOnlyToWaitingTasks() {
    UUID taskId = queue.enqueue("waits", null, queueOptions(unique("waits")).build()).taskId();
    SignalDeliveryResult signal =
        queue.sendSignal(taskId, "approved", Map.of("by", "ann"), unique("key"), "ann");
    assertEquals(SignalStatus.NOT_WAITING, signal.status());
    assertEquals("approved", signal.name());
    assertEquals(
        SignalStatus.NOT_FOUND,
        queue.sendSignal(UUID.randomUUID(), "approved", null, unique("key"), "ann").status());
    HumanWaitCompletionResult decision =
        queue.completeHumanWait(taskId, "review", true, unique("key"), "ann");
    assertEquals(HumanWaitStatus.NOT_WAITING, decision.status());
    assertThrows(
        IllegalArgumentException.class,
        () -> queue.sendSignal(taskId, " approved", null, unique("key"), "ann"));
    assertThrows(
        IllegalArgumentException.class,
        () -> queue.completeHumanWait(taskId, "review", "x".repeat(70_000), unique("key"), "ann"));
  }

  @Test
  void readsTheQueueHealthSnapshot() {
    QueueHealth health = queue.health();
    assertTrue(health.snapshot().containsKey("status"), health.snapshot().keySet().toString());
    assertTrue(health.snapshot().containsKey("budgets"));
    @Nullable Object status = health.snapshot().get("status");
    assertNotEquals(null, status);
  }

  private static EnqueueOptions.Builder queueOptions(String name) {
    return EnqueueOptions.builder().queue(name);
  }
}
