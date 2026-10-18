package dev.stablemates.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.stablemates.workhorse.internal.Row;
import dev.stablemates.workhorse.internal.Sql;
import dev.stablemates.workhorse.internal.SqlCatalogue;
import dev.stablemates.workhorse.testing.ScratchDataSource;
import dev.stablemates.workhorse.testing.ScratchDatabase;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

/** The Java Admin against PostgreSQL: one or more tests for each operator action. */
@ExtendWith(ScratchDatabase.class)
class AdminDatabaseTest {
  private static final UUID NIL_TASK = new UUID(0, 0);

  private final ConnectionSource source = ConnectionSource.of(new ScratchDataSource(true));
  private final Queue queue = new Queue(source);
  private final Admin admin = new Admin(source);
  private final String queueName = unique("admin");
  private final String worker = unique("java-admin");

  private static String unique(String prefix) {
    return prefix + "-" + UUID.randomUUID();
  }

  private static AdminAudit audit() {
    return audit(UUID.randomUUID().toString());
  }

  private static AdminAudit audit(String requestId) {
    return new AdminAudit("operator", "investigating", requestId);
  }

  private EnqueueOptions.Builder options() {
    return EnqueueOptions.builder().queue(queueName);
  }

  private UUID enqueue(String type, Object payload) {
    return queue.enqueue(type, payload, options().build()).taskId();
  }

  private static List<Row> sql(SqlCatalogue.Statement statement, Object... parameters)
      throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      return Sql.rows(connection, statement, parameters);
    }
  }

  /** Claims the next task of {@code name}, and returns its fence token. */
  private String claim(String name, UUID expected) throws SQLException {
    Row row = sql(SqlCatalogue.CLAIM_V1, name, worker, "30000").get(0);
    assertEquals(expected, row.requiredUuid("task_id"));
    return row.requiredText("fence_token");
  }

  /** Enqueues a task with one attempt, claims it, and fails it into a dead letter. */
  private UUID deadLetter(String type, List<String> tags) throws SQLException {
    UUID taskId =
        queue.enqueue(type, Map.of("n", 1), options().maxAttempts(1).tags(tags).build()).taskId();
    String fence = claim(queueName, taskId);
    sql(
        SqlCatalogue.FAIL_V1,
        taskId.toString(),
        worker,
        fence,
        "{\"name\":\"Boom\",\"message\":\"exploded\"}",
        null);
    return taskId;
  }

  private static long scalar(String query, String parameter) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement = connection.prepareStatement(query)) {
      statement.setString(1, parameter);
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next());
        return result.getLong(1);
      }
    }
  }

  // Task lookup, listing, and timeline.

  @Test
  void listsTasksWithFiltersProjectionAndACursor() {
    UUID first = enqueue("a", Map.of("secret", "s", "n", 1));
    UUID second = enqueue("b", Map.of("n", 2));
    TaskPayloadProjection projection = new TaskPayloadProjection(true, 16_384, List.of("secret"));
    TaskQuery query = TaskQuery.builder().queue(queueName).limit(1).payload(projection).build();

    TaskPage page = admin.listTasks(query);
    assertEquals(List.of(second), page.items().stream().map(TaskListItem::id).toList());
    TaskListItem item = page.items().get(0);
    assertEquals(queueName, item.queue());
    assertEquals("b", item.type());
    assertEquals(TaskState.READY, item.state());
    assertEquals(TaskPayloadStatus.INCLUDED, item.payloadStatus());
    assertEquals(Map.of("n", 2L), item.payload());
    assertNotNull(page.nextCursor());

    TaskPage rest = admin.listTasks(query.toBuilder().cursor(page.nextCursor()).build());
    assertEquals(List.of(first), rest.items().stream().map(TaskListItem::id).toList());
    assertEquals(Map.of("n", 1L), rest.items().get(0).payload(), "a redacted key is removed");
    assertNull(rest.nextCursor());

    TaskPage omitted =
        admin.listTasks(
            TaskQuery.builder()
                .queue(queueName)
                .type("a")
                .states(List.of(TaskState.READY))
                .build());
    assertEquals(1, omitted.items().size());
    assertNull(omitted.items().get(0).payload());
    assertEquals(TaskPayloadStatus.OMITTED, omitted.items().get(0).payloadStatus());
    assertTrue(
        admin
            .listTasks(
                TaskQuery.builder().queue(queueName).states(List.of(TaskState.FAILED)).build())
            .items()
            .isEmpty());
    assertTrue(
        admin
            .listTasks(
                TaskQuery.builder()
                    .queue(queueName)
                    .createdAfter(Instant.now().plus(Duration.ofHours(1)))
                    .build())
            .items()
            .isEmpty());
  }

  @Test
  void readsATaskSnapshotAndItsTimeline() throws SQLException {
    UUID taskId =
        queue
            .enqueue("t", Map.of("n", 1), options().tags(List.of("x")).maxAttempts(2).build())
            .taskId();
    String fence = claim(queueName, taskId);
    sql(SqlCatalogue.UPDATE_PROGRESS_V1, taskId.toString(), worker, fence, "{\"done\":1}");

    TaskDetail detail = admin.getTask(taskId).orElseThrow();
    assertEquals(taskId, detail.id());
    assertEquals(queueName, detail.queue());
    assertEquals(Map.of("n", 1L), detail.payload());
    assertEquals(List.of("x"), detail.tags());
    assertEquals(TaskState.ACTIVE, detail.state());
    assertEquals(1, detail.currentAttempt());
    assertEquals(2, detail.maxAttempts());
    assertEquals(Long.parseLong(fence), detail.fenceToken());
    assertNull(detail.dependencyPolicy());
    assertEquals(List.of(), detail.childTaskIds());
    TaskProgress progress = detail.progress();
    assertNotNull(progress);
    assertEquals(Map.of("done", 1L), progress.value());
    assertEquals(1, progress.revision());
    assertEquals(worker, progress.workerId());
    assertTrue(admin.getTask(NIL_TASK).isEmpty());

    TimelinePage timeline = admin.getTaskTimeline(taskId, new TimelineQuery(1, null));
    assertEquals(1, timeline.items().size());
    TaskTimelineCursor cursor = timeline.nextCursor();
    assertNotNull(cursor);
    assertEquals(taskId, cursor.taskId());
    TimelinePage rest = admin.getTaskTimeline(taskId, new TimelineQuery(1000, cursor));
    List<TaskTimelineEntry> entries = new ArrayList<>(timeline.items());
    entries.addAll(rest.items());
    assertTrue(entries.stream().anyMatch(entry -> entry.kind() == TaskTimelineKind.EVENT));
    assertEquals(
        entries.size(), entries.stream().map(TaskTimelineEntry::recordId).distinct().count());
    IllegalArgumentException error =
        assertThrows(
            IllegalArgumentException.class,
            () -> admin.getTaskTimeline(NIL_TASK, new TimelineQuery(100, cursor)));
    assertEquals("cursor task_id must match the requested task_id", error.getMessage());

    Dependencies dependencies =
        new Dependencies(
            List.of(taskId),
            DependencyPolicy.RELEASE,
            DependencyPolicy.CANCEL,
            DependencyPolicy.FAIL);
    UUID dependent =
        queue.enqueue("dependent", null, options().dependencies(dependencies).build()).taskId();
    TaskDetail blocked = admin.getTask(dependent).orElseThrow();
    assertEquals(TaskState.BLOCKED, blocked.state());
    assertEquals(TaskBlockedReason.PREREQUISITE_PENDING, blocked.blockedReason());
    assertEquals(taskId, blocked.prerequisiteTaskId());
    assertEquals(List.of(taskId), blocked.prerequisiteTaskIds());
    assertEquals(
        new TaskDependencyPolicy(
            DependencyPolicy.RELEASE, DependencyPolicy.CANCEL, DependencyPolicy.FAIL),
        blocked.dependencyPolicy());
    TaskListItem listed =
        admin
            .listTasks(TaskQuery.builder().queue(queueName).type("dependent").build())
            .items()
            .get(0);
    assertEquals(List.of(taskId), listed.prerequisiteTaskIds());
    assertEquals(TaskBlockedReason.PREREQUISITE_PENDING, listed.blockedReason());
  }

  @Test
  void pagesATimelineAcrossEventsAndFinishedAttempts() throws SQLException {
    UUID taskId = queue.enqueue("t", Map.of(), options().maxAttempts(2).build()).taskId();
    String id = taskId.toString();
    String first = claim(queueName, taskId);
    sql(SqlCatalogue.FAIL_V1, id, worker, first, "{\"name\":\"Boom\"}", "0");
    String second = claim(queueName, taskId);
    sql(SqlCatalogue.COMPLETE_V1, id, worker, second, "{\"ok\":true}");

    List<TaskTimelineEntry> entries = new ArrayList<>();
    TaskTimelineCursor cursor = null;
    do {
      TimelinePage page = admin.getTaskTimeline(taskId, new TimelineQuery(1, cursor));
      assertTrue(page.items().size() <= 1);
      entries.addAll(page.items());
      cursor = page.nextCursor();
    } while (cursor != null);
    assertEquals(
        entries.size(), entries.stream().map(TaskTimelineEntry::recordId).distinct().count());
    for (int index = 1; index < entries.size(); index++) {
      assertFalse(
          entries.get(index).occurredAt().isAfter(entries.get(index - 1).occurredAt()),
          "newest first");
    }
    assertTrue(entries.stream().anyMatch(entry -> entry instanceof TaskTimelineEvent));
    List<TaskTimelineAttempt> attempts =
        entries.stream()
            .filter(TaskTimelineAttempt.class::isInstance)
            .map(TaskTimelineAttempt.class::cast)
            .toList();
    assertEquals(
        List.of("succeeded", "retry"),
        attempts.stream().map(TaskTimelineAttempt::outcome).toList());
    TaskTimelineAttempt retried = attempts.get(1);
    assertEquals(TaskTimelineKind.ATTEMPT, retried.kind());
    assertEquals(1, retried.attempt());
    assertEquals(Long.parseLong(first), retried.fenceToken());
    assertEquals(worker, retried.workerId());
    assertEquals("Boom", assertInstanceOf(Map.class, retried.error()).get("name"));
    assertFalse(retried.finishedAt().isBefore(retried.claimedAt()));
    assertEquals(2, attempts.get(0).attempt());
    assertNull(attempts.get(0).error());
  }

  @Test
  void readsAFastTierTaskThatFinishedBeforeAClaim() throws SQLException {
    // The test sets the tier through the protocol, because Admin has no tier control (SM-1417).
    sql(SqlCatalogue.SET_QUEUE_TIER_V1, queueName, "fast", "operator", "fast tier test");
    UUID taskId = enqueue("fast", Map.of());
    assertEquals(CancelStatus.CANCELED, queue.cancel(taskId, "operator", "not needed").status());

    TaskDetail detail = admin.getTask(taskId).orElseThrow();
    assertEquals(TaskState.CANCELED, detail.state());
    assertNull(detail.fenceToken(), "no attempt claimed the task");
    assertEquals(
        TaskState.CANCELED,
        admin.listTasks(TaskQuery.builder().queue(queueName).build()).items().get(0).state());
  }

  // Checkpoint, wait, and human-decision reads.

  @Test
  void readsCheckpointsProgressAndWaits() throws SQLException {
    UUID taskId = enqueue("t", Map.of());
    String fence = claim(queueName, taskId);
    String id = taskId.toString();
    sql(SqlCatalogue.SAVE_CHECKPOINT_V1, id, worker, fence, "step-1", "{\"at\":1}");
    sql(SqlCatalogue.UPDATE_PROGRESS_V1, id, worker, fence, "{\"pct\":50}");

    TaskCheckpoint checkpoint = admin.getCheckpoint(taskId, "step-1").orElseThrow();
    assertEquals(taskId, checkpoint.taskId());
    assertEquals("step-1", checkpoint.name());
    assertEquals(Map.of("at", 1L), checkpoint.value());
    assertEquals(1, checkpoint.attempt());
    assertEquals(Long.parseLong(fence), checkpoint.fenceToken());
    assertEquals(worker, checkpoint.workerId());
    assertNull(checkpoint.inputFingerprint());
    assertEquals(List.of(checkpoint), admin.listCheckpoints(taskId));
    String fingerprint = "a".repeat(64);
    sql(SqlCatalogue.SAVE_CHECKPOINT_V2, id, worker, fence, "step-2", "{\"at\":2}", fingerprint);
    assertEquals(
        fingerprint, admin.getCheckpoint(taskId, "step-2").orElseThrow().inputFingerprint());
    assertEquals(2, admin.listCheckpoints(taskId).size());
    assertTrue(admin.getCheckpoint(taskId, "missing").isEmpty());

    TaskProgress progress = admin.getProgress(taskId).orElseThrow();
    assertEquals(Map.of("pct", 50L), progress.value());
    assertEquals(1, progress.revision());
    assertTrue(admin.getProgress(NIL_TASK).isEmpty());

    sql(SqlCatalogue.SCHEDULE_WAIT_V1, id, worker, fence, "nap", "60000", null);
    TaskWait wait = admin.getWait(taskId, "nap").orElseThrow();
    assertEquals(taskId, wait.taskId());
    assertEquals("nap", wait.name());
    assertEquals(TaskWaitMode.RELATIVE, wait.mode());
    assertEquals(Duration.ofMinutes(1), wait.duration());
    assertEquals(worker, wait.workerId());
    assertEquals(List.of(wait), admin.listWaits(taskId));
    assertTrue(admin.getWait(taskId, "missing").isEmpty());
    assertThrows(IllegalArgumentException.class, () -> admin.getWait(taskId, ""));
  }

  @Test
  void listsSignalAndHumanWaitsWithACursor() throws SQLException {
    String signalQueue = queueName + "-signal";
    String humanQueue = queueName + "-human";
    for (int index = 0; index < 2; index++) {
      UUID waiting =
          queue.enqueue("wait.signal", Map.of(), options().queue(signalQueue).build()).taskId();
      String fence = claim(signalQueue, waiting);
      sql(SqlCatalogue.WAIT_FOR_SIGNAL_V1, waiting.toString(), worker, fence, "approved", "60000");
    }
    UUID human =
        queue.enqueue("wait.human", Map.of(), options().queue(humanQueue).build()).taskId();
    String fence = claim(humanQueue, human);
    sql(
        SqlCatalogue.WAIT_FOR_HUMAN_V1,
        human.toString(),
        worker,
        fence,
        "review",
        "{\"question\":\"ship it?\"}",
        "60000");

    List<SignalWait> signals = new ArrayList<>();
    ExternalWaitCursor cursor = null;
    do {
      SignalWaitPage page = admin.listSignalWaits(new SignalWaitQuery(1, cursor));
      assertTrue(page.items().size() <= 1);
      signals.addAll(page.items());
      cursor = page.nextCursor();
    } while (cursor != null);
    List<SignalWait> mine =
        signals.stream().filter(wait -> wait.queue().equals(signalQueue)).toList();
    assertEquals(List.of("approved", "approved"), mine.stream().map(SignalWait::name).toList());
    assertEquals(
        Set.of("wait.signal"), Set.copyOf(mine.stream().map(SignalWait::taskType).toList()));

    List<HumanWait> humans =
        admin.listHumanWaits(new HumanWaitQuery(1000, null)).items().stream()
            .filter(wait -> wait.queue().equals(humanQueue))
            .toList();
    assertEquals(1, humans.size());
    assertEquals(human, humans.get(0).taskId());
    assertEquals("review", humans.get(0).name());
    assertEquals(Map.of("question", "ship it?"), humans.get(0).context());
  }

  // Dead-letter listing and redrive.

  @Test
  void listsDeadLettersAndRedrivesOne() throws SQLException {
    UUID source = deadLetter("boom", List.of("billing"));
    UUID other = deadLetter("other", List.of());

    DeadLetterQuery query = DeadLetterQuery.builder().queue(queueName).limit(1).build();
    DeadLetterPage letters = admin.listDeadLetters(query);
    assertEquals(List.of(other), letters.items().stream().map(DeadLetter::taskId).toList());
    assertNotNull(letters.nextCursor());
    DeadLetterPage rest =
        admin.listDeadLetters(query.toBuilder().limit(100).cursor(letters.nextCursor()).build());
    assertEquals(List.of(source), rest.items().stream().map(DeadLetter::taskId).toList());
    DeadLetter letter = rest.items().get(0);
    assertEquals("boom", letter.type());
    assertEquals(List.of("billing"), letter.tags());
    assertEquals(0, letter.redriveCount());
    assertEquals("Boom", assertInstanceOf(Map.class, letter.error()).get("name"));
    assertEquals(
        List.of(source),
        admin
            .listDeadLetters(
                DeadLetterQuery.builder().queue(queueName).tags(List.of("billing")).build())
            .items()
            .stream()
            .map(DeadLetter::taskId)
            .toList());
    assertTrue(
        admin
            .listDeadLetters(DeadLetterQuery.builder().queue(queueName).errorName("Other").build())
            .items()
            .isEmpty());

    AdminAudit request = audit();
    RedriveResult result = admin.redrive(source, request);
    assertEquals(RedriveStatus.REDRIVEN, result.status());
    assertEquals(source, result.sourceTaskId());
    assertEquals(TaskState.FAILED, result.sourceState());
    assertEquals(TaskState.READY, result.targetState());
    assertNotNull(result.requestedAt());
    RedriveResult replay = admin.redrive(source, request);
    assertEquals(RedriveStatus.REPLAYED, replay.status());
    assertEquals(result.targetTaskId(), replay.targetTaskId());
    AdminAudit changed = new AdminAudit("operator", "a different reason", request.requestId());
    assertThrows(RedriveIdempotencyConflictException.class, () -> admin.redrive(source, changed));
    assertEquals(RedriveStatus.NOT_FOUND, admin.redrive(NIL_TASK, audit()).status());
    UUID target = result.targetTaskId();
    assertNotNull(target);
    assertEquals(RedriveStatus.NOT_FAILED, admin.redrive(target, audit()).status());
  }

  @Test
  void redrivesDeadLettersInBulkWithADryRunAndACursor() throws SQLException {
    UUID firstSource = deadLetter("t", List.of());
    Set<UUID> sources = Set.of(firstSource, deadLetter("t", List.of()));

    BulkRedrivePage dry =
        admin.redriveMany(RedriveFilter.builder().queue(queueName).dryRun(true).build(), audit());
    assertEquals(
        List.of(RedriveStatus.ELIGIBLE, RedriveStatus.ELIGIBLE),
        dry.results().stream().map(RedriveResult::status).toList());
    assertEquals(
        sources, Set.copyOf(dry.results().stream().map(RedriveResult::sourceTaskId).toList()));

    RedriveFilter filter = RedriveFilter.builder().queue(queueName).limit(1).build();
    BulkRedrivePage first = admin.redriveMany(filter, audit());
    assertEquals(
        List.of(RedriveStatus.REDRIVEN),
        first.results().stream().map(RedriveResult::status).toList());
    assertNotNull(first.nextCursor());
    BulkRedrivePage second =
        admin.redriveMany(filter.toBuilder().cursor(first.nextCursor()).build(), audit());
    assertEquals(
        List.of(RedriveStatus.REDRIVEN),
        second.results().stream().map(RedriveResult::status).toList());
    assertEquals(
        sources,
        Set.of(first.results().get(0).sourceTaskId(), second.results().get(0).sourceTaskId()));
  }

  // Durable operator worker pause.

  @Test
  void listsWorkersAndPausesOne() throws SQLException {
    sql(
        SqlCatalogue.REGISTER_WORKER_V1,
        worker,
        UUID.randomUUID().toString(),
        "admin-test-host",
        "42",
        new String[] {queueName},
        new String[] {},
        "1",
        "30000",
        "10000",
        "250",
        "1000",
        "60000",
        "5000",
        "0",
        "false",
        null,
        null,
        null);

    WorkerInfo entry =
        admin.listWorkers().stream()
            .filter(candidate -> candidate.workerId().equals(worker))
            .findFirst()
            .orElseThrow();
    assertFalse(entry.paused());
    assertEquals("admin-test-host", entry.hostname());
    assertEquals(42, entry.pid());
    assertEquals(List.of(queueName), entry.queues());
    assertEquals(1, entry.concurrency());
    assertFalse(entry.draining());
    assertNotNull(entry.lastHeartbeatAt());

    WorkerPauseResult paused = admin.setWorkerPaused(worker, true, audit()).orElseThrow();
    assertEquals(worker, paused.workerId());
    assertTrue(paused.paused());
    assertEquals("operator", paused.pausedBy());
    assertEquals("investigating", paused.reason());
    assertNotNull(paused.pausedAt());
    WorkerPauseResult resumed = admin.setWorkerPaused(worker, false, audit()).orElseThrow();
    assertFalse(resumed.paused());
    assertNull(resumed.pausedBy());
    assertTrue(admin.setWorkerPaused(worker + "-missing", true, audit()).isEmpty());
  }

  // Queue pause, resume, and purge.

  @Test
  void pausesResumesAndPurgesAQueue() throws SQLException {
    String paused =
        "SELECT CASE WHEN paused THEN 1 ELSE 0 END FROM workhorse.queue_control"
            + " WHERE queue_name = ?";
    admin.pauseQueue(queueName, audit());
    assertEquals(1, scalar(paused, queueName));
    admin.resumeQueue(queueName, audit());
    assertEquals(0, scalar(paused, queueName));

    for (int index = 0; index < 3; index++) {
      enqueue("t", Map.of());
    }
    AdminAudit request = audit();
    assertEquals(3, admin.purgeQueue(queueName, request));
    assertEquals(0, scalar("SELECT count(*) FROM workhorse.task WHERE queue_name = ?", queueName));
    assertThrows(
        PurgeIdempotencyConflictException.class,
        () -> admin.purgeQueue(queueName + "-other", request));
  }

  // Task group reads, cancel, and drift repair.

  @Test
  void cancelsAGroupReadsItsEventsAndRepairsACounterThatDrifted() throws SQLException {
    EnqueueRequest failed = EnqueueRequest.of("group.failed", null, options().build());
    Consumer<TaskGroupBuilder> members =
        builder -> {
          builder.enqueue("group.member", Map.of(), options().build());
          builder.enqueue("group.member", Map.of(), options().build());
        };
    TaskGroup group = queue.taskGroup(new TaskGroupCallbacks(null, null, failed), members).group();
    assertEquals(group, admin.getTaskGroup(group.id()).orElseThrow());
    TaskGroupMemberPage page = admin.listTaskGroupMembers(group.id(), 0, 1);
    assertEquals(1, page.members().size());
    assertNotNull(page.nextAfter());
    Long nextAfter = page.nextAfter();
    assertNotNull(nextAfter);
    assertEquals(1, admin.listTaskGroupMembers(group.id(), nextAfter).members().size());
    assertEquals(2, admin.listTaskGroupMembers(group.id()).members().size());
    assertTrue(admin.getTaskGroup(UUID.randomUUID()).isEmpty());

    TaskGroup canceled = admin.cancelTaskGroup(group.id(), audit()).orElseThrow();
    assertEquals(TaskGroupState.FINISHED, canceled.state());
    assertEquals(TaskGroupResult.FAILED, canceled.result());
    assertEquals(2, canceled.counts().canceled());
    assertEquals("operator", canceled.canceledBy());
    assertEquals(
        canceled.finishedAt(),
        admin.cancelTaskGroup(group.id(), audit()).orElseThrow().finishedAt());
    assertTrue(admin.cancelTaskGroup(UUID.randomUUID(), audit()).isEmpty());
    List<TaskGroupEventType> events =
        admin.listTaskGroupEvents(group.id()).stream().map(TaskGroupEvent::type).toList();
    assertTrue(
        events.containsAll(
            List.of(
                TaskGroupEventType.CREATED,
                TaskGroupEventType.SEALED,
                TaskGroupEventType.CANCELED,
                TaskGroupEventType.FINISHED,
                TaskGroupEventType.CALLBACK_ENQUEUED)),
        events.toString());
    assertEquals(1, admin.listTaskGroupEvents(group.id(), 1).size());

    TaskGroup open = queue.createTaskGroup(TaskGroupCallbacks.none());
    queue.addToTaskGroup(
        open.id(), List.of(EnqueueRequest.of("group.member", null, options().build())));
    // The counts of a group that is not finished live in its shard rows (ADR 0096).
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "UPDATE workhorse.task_group_shard SET succeeded_count = 1"
                    + " WHERE group_id = ?::uuid AND shard = 0")) {
      statement.setString(1, open.id().toString());
      assertEquals(1, statement.executeUpdate());
    }
    TaskGroupDrift drift =
        admin.listTaskGroupDrift().stream()
            .filter(item -> item.groupId().equals(open.id()))
            .findFirst()
            .orElseThrow();
    assertEquals(new TaskGroupCounts(1, 1, 0, 0, null), drift.recorded());
    assertEquals(TaskGroupState.OPEN, drift.state());
    assertEquals(1L, drift.counted().pending());
    assertEquals(TaskGroupRepairAction.RECOUNTED, drift.action());

    TaskGroupRepair repair =
        admin.repairTaskGroupDrift(audit()).stream()
            .filter(item -> item.groupId().equals(open.id()))
            .findFirst()
            .orElseThrow();
    assertEquals(0, repair.recordedPending());
    assertEquals(1, repair.pending());
    assertEquals(TaskGroupRepairAction.RECOUNTED, repair.action());
    assertEquals(0, admin.getTaskGroup(open.id()).orElseThrow().counts().succeeded());
    assertTrue(
        admin.listTaskGroupEvents(open.id()).stream()
            .anyMatch(event -> event.type() == TaskGroupEventType.COUNTER_REPAIRED));
    IllegalArgumentException error =
        assertThrows(IllegalArgumentException.class, () -> admin.listTaskGroupDrift(10_001));
    assertTrue(error.getMessage().contains("between 1 and 10000"), error.getMessage());
  }

  // Caller transactions and validation.

  @Test
  void joinsTheCallerTransaction() throws SQLException {
    UUID dead = deadLetter("t", List.of());
    try (Connection connection = ScratchDatabase.connect()) {
      connection.setAutoCommit(false);
      assertEquals(RedriveStatus.REDRIVEN, admin.redrive(connection, dead, audit()).status());
      admin.pauseQueue(connection, queueName, audit());
      assertFalse(connection.getAutoCommit(), "the admin changes no session state");
      connection.rollback();
    }
    assertEquals(
        List.of(0L),
        admin.listDeadLetters(DeadLetterQuery.builder().queue(queueName).build()).items().stream()
            .map(DeadLetter::redriveCount)
            .toList());
    assertEquals(
        0, scalar("SELECT count(*) FROM workhorse.queue_control WHERE queue_name = ?", queueName));
  }

  @Test
  void rejectsAnInvalidArgumentBeforeAnyStatement() {
    AtomicInteger statements = new AtomicInteger();
    Connection connection =
        (Connection)
            Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, arguments) -> {
                  if (method.getName().equals("getAutoCommit")) {
                    return true;
                  }
                  statements.incrementAndGet();
                  throw new SQLException("no statement may run");
                });
    UUID taskId = UUID.randomUUID();
    List<AdminAudit> blank =
        List.of(
            new AdminAudit("", "reason", "request"),
            new AdminAudit("operator", "", "request"),
            new AdminAudit("operator", "reason", ""),
            new AdminAudit("x".repeat(201), "reason", "request"),
            new AdminAudit("operator", "x".repeat(2001), "request"),
            new AdminAudit("operator", "reason", "é".repeat(257)));
    for (AdminAudit audit : blank) {
      assertThrows(IllegalArgumentException.class, () -> admin.redrive(connection, taskId, audit));
      assertThrows(
          IllegalArgumentException.class, () -> admin.pauseQueue(connection, queueName, audit));
      assertThrows(
          IllegalArgumentException.class, () -> admin.purgeQueue(connection, queueName, audit));
      assertThrows(
          IllegalArgumentException.class,
          () -> admin.setWorkerPaused(connection, worker, true, audit));
      assertThrows(
          IllegalArgumentException.class, () -> admin.cancelTaskGroup(connection, taskId, audit));
      assertThrows(
          IllegalArgumentException.class, () -> admin.repairTaskGroupDrift(connection, audit));
      assertThrows(
          IllegalArgumentException.class,
          () -> admin.redriveMany(connection, RedriveFilter.builder().build(), audit));
    }
    assertThrows(
        IllegalArgumentException.class,
        () -> admin.resumeQueue(connection, "", new AdminAudit("a", "b", "c")));
    assertThrows(
        IllegalArgumentException.class,
        () -> admin.listTasks(connection, TaskQuery.builder().limit(1001).build()));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            admin.listTasks(
                connection,
                TaskQuery.builder().states(List.of(TaskState.READY, TaskState.READY)).build()));
    Instant now = Instant.now();
    assertThrows(
        IllegalArgumentException.class,
        () ->
            admin.listTasks(
                connection, TaskQuery.builder().createdAfter(now).createdBefore(now).build()));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            admin.listTasks(
                connection,
                TaskQuery.builder()
                    .payload(new TaskPayloadProjection(true, 0, List.of()))
                    .build()));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            admin.listTasks(
                connection,
                TaskQuery.builder()
                    .payload(new TaskPayloadProjection(true, 10, List.of("k", "k")))
                    .build()));
    assertThrows(
        IllegalArgumentException.class,
        () -> admin.listDeadLetters(connection, DeadLetterQuery.builder().limit(0).build()));
    assertThrows(
        IllegalArgumentException.class,
        () -> admin.listSignalWaits(connection, new SignalWaitQuery(1001, null)));
    assertThrows(
        IllegalArgumentException.class,
        () -> admin.listHumanWaits(connection, new HumanWaitQuery(0, null)));
    assertThrows(
        IllegalArgumentException.class,
        () -> admin.listTaskGroupMembers(connection, taskId, -1, 10));
    assertThrows(
        IllegalArgumentException.class, () -> admin.listTaskGroupEvents(connection, taskId, 1001));
    assertThrows(IllegalArgumentException.class, () -> admin.getCheckpoint(connection, taskId, ""));
    assertEquals(0, statements.get(), "no statement reached the connection");
  }

  @Test
  void passesTheCompatibilityCheck() throws SQLException {
    admin.assertCompatible();
    try (Connection connection = ScratchDatabase.connect()) {
      admin.assertCompatible(connection);
    }
  }
}
