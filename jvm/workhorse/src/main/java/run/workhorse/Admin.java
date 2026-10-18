package run.workhorse;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.Compatibility;
import run.workhorse.internal.Json;
import run.workhorse.internal.PgjdbcVersion;
import run.workhorse.internal.Row;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.internal.Values;

/**
 * Inspects and controls tasks, dead letters, workers, queues, and task groups. The counterpart of
 * Ruby's {@code Stablemates::Workhorse::Admin} (ADR 0103, "Admin surface").
 *
 * <p>Every method has the two forms of {@link Queue}. The <b>caller form</b> takes a {@link
 * Connection} as its first argument and runs inside the caller's transaction, so a control commits
 * and rolls back with it. The <b>source form</b> acquires a connection from the {@link
 * ConnectionSource} for the call.
 *
 * <p>Every control takes an {@link AdminAudit} that PostgreSQL records. An invalid argument,
 * including a blank audit field, throws {@link IllegalArgumentException} before any statement runs.
 * The admin runs the startup compatibility check before its first statement, and caches the result
 * as {@link Queue} does. For the queue health snapshot, use {@link Queue#health()}.
 */
public final class Admin {
  private static final int MAX_PAGE_SIZE = 1000;
  private static final int MAX_REDRIVE_BATCH_SIZE = 1000;
  private static final int MAX_PAYLOAD_BYTES = 1_048_576;
  private static final int MAX_REDACT_KEYS = 50;
  private static final int MAX_REDACT_KEY_LENGTH = 200;
  private static final int MAX_DRIFT_LIMIT = 10_000;
  private static final int MAX_ACTOR_LENGTH = 200;
  private static final int MAX_REASON_LENGTH = 2000;
  private static final int MAX_REQUEST_ID_BYTES = 512;
  private static final int DEFAULT_GROUP_PAGE_SIZE = 100;
  private static final int DEFAULT_GROUP_LIMIT = 1000;

  private final ConnectionSource connections;
  private final ReentrantLock lock = new ReentrantLock();
  private boolean sourceChecked;
  private CompatibilityException.@Nullable Code sourceCompatibility;
  private final Map<Connection, Optional<CompatibilityException.Code>> connectionCompatibility =
      new WeakHashMap<>();

  /**
   * An admin on {@code connections}.
   *
   * @throws IllegalStateException if the PgJDBC driver on the class path is older than 42.7.12, or
   *     reports a version that the SDK cannot read
   */
  public Admin(ConnectionSource connections) {
    PgjdbcVersion.require();
    this.connections = Objects.requireNonNull(connections, "connections");
  }

  // ---------------------------------------------------------------------------------------------
  // Compatibility

  /**
   * Runs the startup compatibility check once for the source. A refusal is cached; a driver error
   * is not.
   *
   * @throws CompatibilityException if PostgreSQL and this client cannot work together
   */
  public void assertCompatible() {
    run(null, this::assertCompatible);
  }

  /** Runs the startup compatibility check once for {@code connection}. */
  public void assertCompatible(Connection connection) {
    run(connection, this::assertCompatible);
  }

  private @Nullable Void assertCompatible(Call call) {
    CompatibilityException.Code code;
    lock.lock();
    try {
      if (call.caller) {
        Optional<CompatibilityException.Code> cached = connectionCompatibility.get(call.connection);
        if (cached == null) {
          cached = Optional.ofNullable(Compatibility.evaluate(call.connection));
          connectionCompatibility.put(call.connection, cached);
        }
        code = cached.orElse(null);
      } else {
        if (!sourceChecked) {
          sourceCompatibility = Compatibility.evaluate(call.connection);
          sourceChecked = true;
        }
        code = sourceCompatibility;
      }
    } finally {
      lock.unlock();
    }
    if (code != null) {
      throw new CompatibilityException(code);
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Tasks

  /** One page of tasks, newest first. */
  public TaskPage listTasks(TaskQuery query) {
    return run(null, call -> listTasks(call, query));
  }

  /** One page of tasks, read inside the caller's transaction. */
  public TaskPage listTasks(Connection connection, TaskQuery query) {
    return run(connection, call -> listTasks(call, query));
  }

  private TaskPage listTasks(Call call, TaskQuery query) {
    String filter = Json.write(taskFilter(query));
    limit(query.limit(), MAX_PAGE_SIZE, "list_tasks limit");
    String projection = Json.write(projection(query.payload()));
    TaskListCursor cursor = query.cursor();
    assertCompatible(call);
    List<Row> rows =
        Sql.rows(
            call.connection,
            SqlCatalogue.LIST_TASKS,
            filter,
            Integer.toString(query.limit()),
            cursor == null ? null : cursor.createdAt(),
            cursor == null ? null : cursor.taskId().toString(),
            cursor == null ? null : cursor.signature(),
            projection);
    TaskListCursor next = null;
    if (hasMore(rows)) {
      Row last = rows.get(rows.size() - 1);
      next =
          new TaskListCursor(
              last.requiredText("cursor_created_at"),
              last.requiredUuid("task_id"),
              last.requiredText("cursor_signature"));
    }
    return new TaskPage(map(rows, Admin::taskItem), next);
  }

  /** The snapshot of the task, or empty when no such task exists. */
  public Optional<TaskDetail> getTask(UUID taskId) {
    return run(null, call -> getTask(call, taskId));
  }

  /** The snapshot of the task, read inside the caller's transaction. */
  public Optional<TaskDetail> getTask(Connection connection, UUID taskId) {
    return run(connection, call -> getTask(call, taskId));
  }

  private Optional<TaskDetail> getTask(Call call, UUID taskId) {
    assertCompatible(call);
    return first(Sql.rows(call.connection, SqlCatalogue.GET_TASK, taskId.toString()))
        .map(Admin::taskDetail);
  }

  /**
   * One page of the events and attempts of the task, newest first.
   *
   * @throws IllegalArgumentException if the cursor belongs to another task
   */
  public TimelinePage getTaskTimeline(UUID taskId, TimelineQuery query) {
    return run(null, call -> getTaskTimeline(call, taskId, query));
  }

  /** One page of the timeline of the task, read inside the caller's transaction. */
  public TimelinePage getTaskTimeline(Connection connection, UUID taskId, TimelineQuery query) {
    return run(connection, call -> getTaskTimeline(call, taskId, query));
  }

  private TimelinePage getTaskTimeline(Call call, UUID taskId, TimelineQuery query) {
    limit(query.limit(), MAX_PAGE_SIZE, "get_task_timeline limit");
    TaskTimelineCursor cursor = query.cursor();
    if (cursor != null && !cursor.taskId().equals(taskId)) {
      throw new IllegalArgumentException("cursor task_id must match the requested task_id");
    }
    assertCompatible(call);
    List<Row> rows =
        Sql.rows(
            call.connection,
            SqlCatalogue.LIST_TASK_TIMELINE,
            taskId.toString(),
            Integer.toString(query.limit()),
            cursor == null ? null : cursor.occurredAt(),
            cursor == null ? null : wire(cursor.kind()),
            cursor == null ? null : cursor.recordId().toString());
    TaskTimelineCursor next = null;
    if (hasMore(rows)) {
      Row last = rows.get(rows.size() - 1);
      next =
          new TaskTimelineCursor(
              taskId,
              last.requiredText("cursor_occurred_at"),
              Rows.constant(TaskTimelineKind.class, "timeline_kind", last.requiredText("kind")),
              last.requiredUuid("record_id"));
    }
    return new TimelinePage(map(rows, Admin::timelineEntry), next);
  }

  // ---------------------------------------------------------------------------------------------
  // Dead letters

  /** One page of failed tasks, most recently finished first. */
  public DeadLetterPage listDeadLetters(DeadLetterQuery query) {
    return run(null, call -> listDeadLetters(call, query));
  }

  /** One page of failed tasks, read inside the caller's transaction. */
  public DeadLetterPage listDeadLetters(Connection connection, DeadLetterQuery query) {
    return run(connection, call -> listDeadLetters(call, query));
  }

  private DeadLetterPage listDeadLetters(Call call, DeadLetterQuery query) {
    String document =
        deadLetterFilter(
            query.queue(),
            query.type(),
            query.tags(),
            query.errorName(),
            query.finishedAfter(),
            query.finishedBefore());
    limit(query.limit(), MAX_REDRIVE_BATCH_SIZE, "list_dead_letters limit");
    DeadLetterCursor cursor = query.cursor();
    assertCompatible(call);
    List<Row> rows =
        Sql.rows(
            call.connection,
            SqlCatalogue.LIST_DEAD_LETTERS,
            document,
            Integer.toString(query.limit()),
            cursor == null ? null : cursor.finishedAt(),
            cursor == null ? null : cursor.taskId().toString());
    DeadLetterCursor next = null;
    if (hasMore(rows)) {
      Row last = rows.get(rows.size() - 1);
      next =
          new DeadLetterCursor(
              last.requiredText("cursor_finished_at"), last.requiredUuid("task_id"));
    }
    return new DeadLetterPage(map(rows, Admin::deadLetter), next);
  }

  /**
   * Enqueues a fresh copy of one failed task. A retry with the same request ID replays the first
   * result.
   *
   * @throws RedriveIdempotencyConflictException if the request ID was used for another redrive
   */
  public RedriveResult redrive(UUID sourceTaskId, AdminAudit audit) {
    return run(null, call -> redrive(call, sourceTaskId, audit));
  }

  /** Redrives one failed task inside the caller's transaction. */
  public RedriveResult redrive(Connection connection, UUID sourceTaskId, AdminAudit audit) {
    return run(connection, call -> redrive(call, sourceTaskId, audit));
  }

  private RedriveResult redrive(Call call, UUID sourceTaskId, AdminAudit audit) {
    audit(audit);
    assertCompatible(call);
    return redriveResult(
        Rows.exactlyOne(
            Sql.rows(
                call.connection,
                SqlCatalogue.REDRIVE,
                sourceTaskId.toString(),
                audit.actor(),
                audit.reason(),
                audit.requestId()),
            "redrive_v1"));
  }

  /**
   * Redrives one page of the failed tasks that the filter selects. A dry run reports the result for
   * each failed task and changes nothing.
   */
  public BulkRedrivePage redriveMany(RedriveFilter filter, AdminAudit audit) {
    return run(null, call -> redriveMany(call, filter, audit));
  }

  /** Redrives one page of failed tasks inside the caller's transaction. */
  public BulkRedrivePage redriveMany(
      Connection connection, RedriveFilter filter, AdminAudit audit) {
    return run(connection, call -> redriveMany(call, filter, audit));
  }

  private BulkRedrivePage redriveMany(Call call, RedriveFilter filter, AdminAudit audit) {
    String document =
        deadLetterFilter(
            filter.queue(),
            filter.type(),
            filter.tags(),
            filter.errorName(),
            filter.finishedAfter(),
            filter.finishedBefore());
    audit(audit);
    limit(filter.limit(), MAX_REDRIVE_BATCH_SIZE, "redrive_many limit");
    DeadLetterCursor cursor = filter.cursor();
    assertCompatible(call);
    List<Row> rows =
        Sql.rows(
            call.connection,
            SqlCatalogue.REDRIVE_MANY,
            document,
            Integer.toString(filter.limit()),
            Boolean.toString(filter.dryRun()),
            audit.actor(),
            audit.reason(),
            audit.requestId(),
            cursor == null ? null : cursor.finishedAt(),
            cursor == null ? null : cursor.taskId().toString());
    DeadLetterCursor next = null;
    if (hasMore(rows)) {
      Row last = rows.get(rows.size() - 1);
      next =
          new DeadLetterCursor(
              last.requiredText("source_finished_at_cursor"), last.requiredUuid("source_task_id"));
    }
    return new BulkRedrivePage(map(rows, Admin::redriveResult), next);
  }

  // ---------------------------------------------------------------------------------------------
  // Checkpoints, progress, and waits

  /** The named checkpoint of the task, or empty. */
  public Optional<TaskCheckpoint> getCheckpoint(UUID taskId, String name) {
    return run(null, call -> getCheckpoint(call, taskId, name));
  }

  /** The named checkpoint of the task, read inside the caller's transaction. */
  public Optional<TaskCheckpoint> getCheckpoint(Connection connection, UUID taskId, String name) {
    return run(connection, call -> getCheckpoint(call, taskId, name));
  }

  private Optional<TaskCheckpoint> getCheckpoint(Call call, UUID taskId, String name) {
    name(name, "name");
    assertCompatible(call);
    return first(Sql.rows(call.connection, SqlCatalogue.GET_CHECKPOINT, taskId.toString(), name))
        .map(Admin::checkpoint);
  }

  /** Every checkpoint of the task, oldest first. */
  public List<TaskCheckpoint> listCheckpoints(UUID taskId) {
    return run(null, call -> listCheckpoints(call, taskId));
  }

  /** Every checkpoint of the task, read inside the caller's transaction. */
  public List<TaskCheckpoint> listCheckpoints(Connection connection, UUID taskId) {
    return run(connection, call -> listCheckpoints(call, taskId));
  }

  private List<TaskCheckpoint> listCheckpoints(Call call, UUID taskId) {
    assertCompatible(call);
    return map(
        Sql.rows(call.connection, SqlCatalogue.LIST_CHECKPOINTS, taskId.toString()),
        Admin::checkpoint);
  }

  /** The latest progress of the task, or empty. */
  public Optional<TaskProgress> getProgress(UUID taskId) {
    return run(null, call -> getProgress(call, taskId));
  }

  /** The latest progress of the task, read inside the caller's transaction. */
  public Optional<TaskProgress> getProgress(Connection connection, UUID taskId) {
    return run(connection, call -> getProgress(call, taskId));
  }

  private Optional<TaskProgress> getProgress(Call call, UUID taskId) {
    assertCompatible(call);
    return first(Sql.rows(call.connection, SqlCatalogue.GET_PROGRESS, taskId.toString()))
        .map(
            row ->
                new TaskProgress(
                    row.requiredUuid("task_id"),
                    row.json("progress_value"),
                    row.requiredLong("revision"),
                    row.requiredInteger("attempt"),
                    row.requiredLong("fence_token"),
                    row.requiredText("worker_id"),
                    row.requiredInstant("created_at"),
                    row.requiredInstant("updated_at")));
  }

  /** The named durable wait of the task, or empty. */
  public Optional<TaskWait> getWait(UUID taskId, String name) {
    return run(null, call -> getWait(call, taskId, name));
  }

  /** The named durable wait of the task, read inside the caller's transaction. */
  public Optional<TaskWait> getWait(Connection connection, UUID taskId, String name) {
    return run(connection, call -> getWait(call, taskId, name));
  }

  private Optional<TaskWait> getWait(Call call, UUID taskId, String name) {
    name(name, "name");
    assertCompatible(call);
    return first(Sql.rows(call.connection, SqlCatalogue.GET_WAIT, taskId.toString(), name))
        .map(Admin::taskWait);
  }

  /** Every durable wait of the task, oldest first. */
  public List<TaskWait> listWaits(UUID taskId) {
    return run(null, call -> listWaits(call, taskId));
  }

  /** Every durable wait of the task, read inside the caller's transaction. */
  public List<TaskWait> listWaits(Connection connection, UUID taskId) {
    return run(connection, call -> listWaits(call, taskId));
  }

  private List<TaskWait> listWaits(Call call, UUID taskId) {
    assertCompatible(call);
    return map(
        Sql.rows(call.connection, SqlCatalogue.LIST_WAITS, taskId.toString()), Admin::taskWait);
  }

  /** One page of the tasks that wait for a signal, oldest first. */
  public SignalWaitPage listSignalWaits(SignalWaitQuery query) {
    return run(null, call -> listSignalWaits(call, query));
  }

  /** One page of signal waits, read inside the caller's transaction. */
  public SignalWaitPage listSignalWaits(Connection connection, SignalWaitQuery query) {
    return run(connection, call -> listSignalWaits(call, query));
  }

  private SignalWaitPage listSignalWaits(Call call, SignalWaitQuery query) {
    List<Row> rows =
        externalWaitRows(call, SqlCatalogue.LIST_SIGNAL_WAITS, query.limit(), query.cursor());
    List<SignalWait> items = new ArrayList<>();
    for (Row row : rows.subList(0, Math.min(rows.size(), query.limit()))) {
      items.add(
          new SignalWait(
              row.requiredUuid("task_id"),
              row.requiredText("queue_name"),
              row.requiredText("task_type"),
              row.requiredText("wait_name"),
              row.requiredInteger("attempt"),
              row.requiredInstant("created_at"),
              row.requiredInstant("deadline_at")));
    }
    return new SignalWaitPage(items, externalWaitCursor(rows, query.limit()));
  }

  /** One page of the tasks that wait for a human decision, oldest first. */
  public HumanWaitPage listHumanWaits(HumanWaitQuery query) {
    return run(null, call -> listHumanWaits(call, query));
  }

  /** One page of human waits, read inside the caller's transaction. */
  public HumanWaitPage listHumanWaits(Connection connection, HumanWaitQuery query) {
    return run(connection, call -> listHumanWaits(call, query));
  }

  private HumanWaitPage listHumanWaits(Call call, HumanWaitQuery query) {
    List<Row> rows =
        externalWaitRows(call, SqlCatalogue.LIST_HUMAN_WAITS, query.limit(), query.cursor());
    List<HumanWait> items = new ArrayList<>();
    for (Row row : rows.subList(0, Math.min(rows.size(), query.limit()))) {
      items.add(
          new HumanWait(
              row.requiredUuid("task_id"),
              row.requiredText("queue_name"),
              row.requiredText("task_type"),
              row.requiredText("wait_name"),
              row.requiredInteger("attempt"),
              row.requiredInstant("created_at"),
              row.requiredInstant("deadline_at"),
              row.json("context")));
    }
    return new HumanWaitPage(items, externalWaitCursor(rows, query.limit()));
  }

  // ---------------------------------------------------------------------------------------------
  // Workers and queues

  /** Every registered worker, most recent heartbeat first. */
  public List<WorkerInfo> listWorkers() {
    return run(null, this::listWorkers);
  }

  /** Every registered worker, read inside the caller's transaction. */
  public List<WorkerInfo> listWorkers(Connection connection) {
    return run(connection, this::listWorkers);
  }

  private List<WorkerInfo> listWorkers(Call call) {
    assertCompatible(call);
    return map(
        Sql.rows(call.connection, SqlCatalogue.LIST_WORKERS),
        row ->
            new WorkerInfo(
                row.requiredText("worker_id"),
                bool(row, "paused"),
                row.text("paused_by"),
                row.text("paused_reason"),
                row.instant("paused_at"),
                row.requiredInstant("last_heartbeat_at"),
                row.requiredUuid("instance_id"),
                row.requiredText("hostname"),
                row.requiredInteger("pid"),
                required(row.textList("queue_names"), "queue_names"),
                row.requiredText("queue_name"),
                row.requiredInteger("concurrency"),
                row.requiredInteger("active_slots"),
                bool(row, "draining"),
                row.requiredInstant("started_at")));
  }

  /**
   * Pauses or resumes one worker. A paused worker claims no new task.
   *
   * @return the pause state, or empty when no such worker is registered
   */
  public Optional<WorkerPauseResult> setWorkerPaused(
      String workerId, boolean paused, AdminAudit audit) {
    return run(null, call -> setWorkerPaused(call, workerId, paused, audit));
  }

  /** Pauses or resumes one worker inside the caller's transaction. */
  public Optional<WorkerPauseResult> setWorkerPaused(
      Connection connection, String workerId, boolean paused, AdminAudit audit) {
    return run(connection, call -> setWorkerPaused(call, workerId, paused, audit));
  }

  private Optional<WorkerPauseResult> setWorkerPaused(
      Call call, String workerId, boolean paused, AdminAudit audit) {
    name(workerId, "worker ID");
    audit(audit);
    assertCompatible(call);
    return first(
            Sql.rows(
                call.connection,
                SqlCatalogue.SET_WORKER_PAUSED,
                workerId,
                Boolean.toString(paused),
                audit.actor(),
                audit.reason(),
                audit.requestId()))
        .map(
            row ->
                new WorkerPauseResult(
                    row.requiredText("worker_id"),
                    bool(row, "paused"),
                    row.text("paused_by"),
                    row.text("paused_reason"),
                    row.instant("paused_at"),
                    row.requiredInstant("last_heartbeat_at")));
  }

  /** Pauses the queue, so no worker claims a task from it. */
  public void pauseQueue(String queue, AdminAudit audit) {
    run(null, call -> setQueuePaused(call, queue, true, audit));
  }

  /** Pauses the queue inside the caller's transaction. */
  public void pauseQueue(Connection connection, String queue, AdminAudit audit) {
    run(connection, call -> setQueuePaused(call, queue, true, audit));
  }

  /** Resumes the queue. */
  public void resumeQueue(String queue, AdminAudit audit) {
    run(null, call -> setQueuePaused(call, queue, false, audit));
  }

  /** Resumes the queue inside the caller's transaction. */
  public void resumeQueue(Connection connection, String queue, AdminAudit audit) {
    run(connection, call -> setQueuePaused(call, queue, false, audit));
  }

  private @Nullable Void setQueuePaused(Call call, String queue, boolean paused, AdminAudit audit) {
    name(queue, "queue");
    audit(audit);
    assertCompatible(call);
    Sql.rows(
        call.connection,
        SqlCatalogue.SET_QUEUE_PAUSED,
        queue,
        Boolean.toString(paused),
        audit.actor(),
        audit.reason(),
        audit.requestId());
    return null;
  }

  /**
   * Deletes every pending task in the queue. A task that a dependent task in another queue waits
   * for is canceled, not deleted.
   *
   * <p>Do not call it in a transaction that already holds task row locks, for example after a
   * cancel or an enqueue. Two purges run one after the other, so such a transaction can deadlock
   * with another purge.
   *
   * @return how many tasks the purge deleted or canceled
   * @throws PurgeIdempotencyConflictException if the request ID was used for another purge
   */
  public long purgeQueue(String queue, AdminAudit audit) {
    return run(null, call -> purgeQueue(call, queue, audit));
  }

  /** Purges the queue inside the caller's transaction. */
  public long purgeQueue(Connection connection, String queue, AdminAudit audit) {
    return run(connection, call -> purgeQueue(call, queue, audit));
  }

  private Long purgeQueue(Call call, String queue, AdminAudit audit) {
    name(queue, "queue");
    audit(audit);
    assertCompatible(call);
    return Rows.exactlyOne(
            Sql.rows(
                call.connection,
                SqlCatalogue.PURGE_QUEUE,
                queue,
                audit.actor(),
                audit.reason(),
                audit.requestId()),
            "purge_queue_v1")
        .requiredLong("deleted_count");
  }

  // ---------------------------------------------------------------------------------------------
  // Task groups

  /** The task group, or empty when no such group exists. */
  public Optional<TaskGroup> getTaskGroup(UUID groupId) {
    return run(null, call -> getTaskGroup(call, groupId));
  }

  /** The task group, read inside the caller's transaction. */
  public Optional<TaskGroup> getTaskGroup(Connection connection, UUID groupId) {
    return run(connection, call -> getTaskGroup(call, groupId));
  }

  private Optional<TaskGroup> getTaskGroup(Call call, UUID groupId) {
    assertCompatible(call);
    return first(Sql.rows(call.connection, SqlCatalogue.GET_TASK_GROUP_V1, groupId.toString()))
        .map(Rows::group);
  }

  /** The first page of at most 100 member tasks. */
  public TaskGroupMemberPage listTaskGroupMembers(UUID groupId) {
    return listTaskGroupMembers(groupId, 0, DEFAULT_GROUP_PAGE_SIZE);
  }

  /** One page of at most 100 member tasks after the position {@code after}. */
  public TaskGroupMemberPage listTaskGroupMembers(UUID groupId, long after) {
    return listTaskGroupMembers(groupId, after, DEFAULT_GROUP_PAGE_SIZE);
  }

  /**
   * One page of at most {@code limit} member tasks after the position {@code after}, in the order
   * they joined.
   *
   * @param after the position after which the page starts, 0 for the first page
   * @param limit the page size, 1 to 1,000
   */
  public TaskGroupMemberPage listTaskGroupMembers(UUID groupId, long after, int limit) {
    return run(null, call -> listTaskGroupMembers(call, groupId, after, limit));
  }

  /** The first page of member tasks, read inside the caller's transaction. */
  public TaskGroupMemberPage listTaskGroupMembers(Connection connection, UUID groupId) {
    return listTaskGroupMembers(connection, groupId, 0, DEFAULT_GROUP_PAGE_SIZE);
  }

  /** One page of at most 100 member tasks, read inside the caller's transaction. */
  public TaskGroupMemberPage listTaskGroupMembers(Connection connection, UUID groupId, long after) {
    return listTaskGroupMembers(connection, groupId, after, DEFAULT_GROUP_PAGE_SIZE);
  }

  /** One page of member tasks, read inside the caller's transaction. */
  public TaskGroupMemberPage listTaskGroupMembers(
      Connection connection, UUID groupId, long after, int limit) {
    return run(connection, call -> listTaskGroupMembers(call, groupId, after, limit));
  }

  private TaskGroupMemberPage listTaskGroupMembers(Call call, UUID groupId, long after, int limit) {
    limit(limit, MAX_PAGE_SIZE, "list_task_group_members limit");
    if (after < 0) {
      throw new IllegalArgumentException("after must be a non-negative Integer");
    }
    assertCompatible(call);
    return Rows.memberPage(call.connection, groupId, after, limit);
  }

  /** The first 1,000 events of the group, in time order. */
  public List<TaskGroupEvent> listTaskGroupEvents(UUID groupId) {
    return listTaskGroupEvents(groupId, DEFAULT_GROUP_LIMIT);
  }

  /**
   * At most {@code limit} events of the group in time order: create, seal, cancel, finish,
   * callbacks, and repairs.
   *
   * @param limit 1 to 1,000
   */
  public List<TaskGroupEvent> listTaskGroupEvents(UUID groupId, int limit) {
    return run(null, call -> listTaskGroupEvents(call, groupId, limit));
  }

  /** The first 1,000 events of the group, read inside the caller's transaction. */
  public List<TaskGroupEvent> listTaskGroupEvents(Connection connection, UUID groupId) {
    return listTaskGroupEvents(connection, groupId, DEFAULT_GROUP_LIMIT);
  }

  /** The events of the group, read inside the caller's transaction. */
  public List<TaskGroupEvent> listTaskGroupEvents(Connection connection, UUID groupId, int limit) {
    return run(connection, call -> listTaskGroupEvents(call, groupId, limit));
  }

  private List<TaskGroupEvent> listTaskGroupEvents(Call call, UUID groupId, int limit) {
    limit(limit, MAX_PAGE_SIZE, "list_task_group_events limit");
    assertCompatible(call);
    return map(
        Sql.rows(
            call.connection,
            SqlCatalogue.LIST_TASK_GROUP_EVENTS_V1,
            groupId.toString(),
            Integer.toString(limit)),
        row ->
            new TaskGroupEvent(
                row.requiredUuid("event_id"),
                Rows.constant(
                    TaskGroupEventType.class, "task_group_event", row.requiredText("event_type")),
                row.json("details"),
                row.requiredInstant("occurred_at")));
  }

  /**
   * Seals an open group, so no task can join it after this call, not even from a running member
   * task. Then cancels every member task that is not terminal. The canceled member tasks count as
   * not succeeded, so the group finishes as usual and its finish and failure callbacks run. A
   * finished group stays unchanged.
   *
   * @return the group, or empty for an unknown group
   */
  public Optional<TaskGroup> cancelTaskGroup(UUID groupId, AdminAudit audit) {
    return run(null, call -> cancelTaskGroup(call, groupId, audit));
  }

  /** Cancels the group inside the caller's transaction. */
  public Optional<TaskGroup> cancelTaskGroup(
      Connection connection, UUID groupId, AdminAudit audit) {
    return run(connection, call -> cancelTaskGroup(call, groupId, audit));
  }

  private Optional<TaskGroup> cancelTaskGroup(Call call, UUID groupId, AdminAudit audit) {
    audit(audit);
    assertCompatible(call);
    return first(
            Sql.rows(
                call.connection,
                SqlCatalogue.CANCEL_TASK_GROUP_V1,
                groupId.toString(),
                audit.actor(),
                audit.reason(),
                audit.requestId()))
        .map(Rows::group);
  }

  /** At most 1,000 groups whose counters drifted. */
  public List<TaskGroupDrift> listTaskGroupDrift() {
    return listTaskGroupDrift(DEFAULT_GROUP_LIMIT);
  }

  /**
   * The groups that are not finished and whose counters disagree with their member outcomes, and
   * the sealed groups with no pending member. It writes nothing, so it is the dry run of {@link
   * #repairTaskGroupDrift}.
   *
   * @param limit 1 to 10,000
   */
  public List<TaskGroupDrift> listTaskGroupDrift(int limit) {
    return run(null, call -> listTaskGroupDrift(call, limit));
  }

  /** At most 1,000 drifted groups, read inside the caller's transaction. */
  public List<TaskGroupDrift> listTaskGroupDrift(Connection connection) {
    return listTaskGroupDrift(connection, DEFAULT_GROUP_LIMIT);
  }

  /** The drifted groups, read inside the caller's transaction. */
  public List<TaskGroupDrift> listTaskGroupDrift(Connection connection, int limit) {
    return run(connection, call -> listTaskGroupDrift(call, limit));
  }

  private List<TaskGroupDrift> listTaskGroupDrift(Call call, int limit) {
    limit(limit, MAX_DRIFT_LIMIT, "list_task_group_drift limit");
    assertCompatible(call);
    return map(
        Sql.rows(call.connection, SqlCatalogue.LIST_TASK_GROUP_DRIFT_V1, Integer.toString(limit)),
        row ->
            new TaskGroupDrift(
                row.requiredUuid("group_id"),
                Rows.constant(TaskGroupState.class, "task_group_state", row.requiredText("state")),
                new TaskGroupCounts(
                    row.requiredLong("recorded_total"),
                    row.requiredLong("recorded_succeeded"),
                    row.requiredLong("recorded_failed"),
                    row.requiredLong("recorded_canceled"),
                    null),
                new TaskGroupCounts(
                    row.requiredLong("total"),
                    row.requiredLong("succeeded"),
                    row.requiredLong("failed"),
                    row.requiredLong("canceled"),
                    row.requiredLong("pending")),
                repairAction(row)));
  }

  /** Repairs at most 1,000 drifted groups. */
  public List<TaskGroupRepair> repairTaskGroupDrift(AdminAudit audit) {
    return repairTaskGroupDrift(audit, DEFAULT_GROUP_LIMIT);
  }

  /**
   * Recounts each group that {@link #listTaskGroupDrift} reports from its member outcomes, and
   * finishes a sealed group with no pending member. The {@code counter_repaired} event of each
   * group records the audit.
   *
   * @param limit 1 to 10,000
   * @return one repair for each group
   */
  public List<TaskGroupRepair> repairTaskGroupDrift(AdminAudit audit, int limit) {
    return run(null, call -> repairTaskGroupDrift(call, audit, limit));
  }

  /** Repairs at most 1,000 drifted groups inside the caller's transaction. */
  public List<TaskGroupRepair> repairTaskGroupDrift(Connection connection, AdminAudit audit) {
    return repairTaskGroupDrift(connection, audit, DEFAULT_GROUP_LIMIT);
  }

  /** Repairs drifted groups inside the caller's transaction. */
  public List<TaskGroupRepair> repairTaskGroupDrift(
      Connection connection, AdminAudit audit, int limit) {
    return run(connection, call -> repairTaskGroupDrift(call, audit, limit));
  }

  private List<TaskGroupRepair> repairTaskGroupDrift(Call call, AdminAudit audit, int limit) {
    audit(audit);
    limit(limit, MAX_DRIFT_LIMIT, "repair_task_group_drift limit");
    assertCompatible(call);
    return map(
        Sql.rows(
            call.connection,
            SqlCatalogue.REPAIR_TASK_GROUP_DRIFT_V1,
            Integer.toString(limit),
            audit.actor(),
            audit.reason(),
            audit.requestId()),
        row ->
            new TaskGroupRepair(
                row.requiredUuid("group_id"),
                row.requiredLong("recorded_pending"),
                row.requiredLong("pending"),
                repairAction(row)));
  }

  // ---------------------------------------------------------------------------------------------
  // Validation

  private static void audit(AdminAudit audit) {
    String actor = audit.actor();
    int actorLength = actor.codePointCount(0, actor.length());
    if (actorLength < 1 || actorLength > MAX_ACTOR_LENGTH) {
      throw new IllegalArgumentException(
          "actor must contain between 1 and " + MAX_ACTOR_LENGTH + " characters");
    }
    String reason = audit.reason();
    int reasonLength = reason.codePointCount(0, reason.length());
    if (reasonLength < 1 || reasonLength > MAX_REASON_LENGTH) {
      throw new IllegalArgumentException(
          "reason must contain between 1 and " + MAX_REASON_LENGTH + " characters");
    }
    int requestIdBytes = audit.requestId().getBytes(StandardCharsets.UTF_8).length;
    if (requestIdBytes < 1 || requestIdBytes > MAX_REQUEST_ID_BYTES) {
      throw new IllegalArgumentException(
          "request_id must contain between 1 and " + MAX_REQUEST_ID_BYTES + " UTF-8 bytes");
    }
  }

  private static void limit(int value, int maximum, String label) {
    if (value < 1 || value > maximum) {
      throw new IllegalArgumentException(label + " must be an integer between 1 and " + maximum);
    }
  }

  private static void name(String value, String label) {
    if (value.isEmpty()) {
      throw new IllegalArgumentException(label + " must be a non-empty String");
    }
  }

  private static Map<String, @Nullable Object> taskFilter(TaskQuery query) {
    List<TaskState> states = query.states();
    if (new HashSet<>(states).size() != states.size()) {
      throw new IllegalArgumentException("states must be unique");
    }
    Instant after = query.createdAfter();
    Instant before = query.createdBefore();
    if (after != null && before != null && !after.isBefore(before)) {
      throw new IllegalArgumentException("created_after must be earlier than created_before");
    }
    Map<String, @Nullable Object> filter = new LinkedHashMap<>();
    if (query.queue() != null) {
      filter.put("queue", query.queue());
    }
    if (query.type() != null) {
      filter.put("type", query.type());
    }
    if (!states.isEmpty()) {
      List<@Nullable Object> wire = new ArrayList<>();
      for (TaskState state : states) {
        wire.add(wire(state));
      }
      filter.put("states", wire);
    }
    if (after != null) {
      filter.put("createdAfter", Values.timestamp(after));
    }
    if (before != null) {
      filter.put("createdBefore", Values.timestamp(before));
    }
    return filter;
  }

  private static Map<String, @Nullable Object> projection(TaskPayloadProjection payload) {
    if (payload.maxBytes() < 1 || payload.maxBytes() > MAX_PAYLOAD_BYTES) {
      throw new IllegalArgumentException("payload max_bytes is out of range");
    }
    List<String> keys = payload.redactKeys();
    if (keys.size() > MAX_REDACT_KEYS) {
      throw new IllegalArgumentException(
          "payload redact_keys must contain at most " + MAX_REDACT_KEYS + " keys");
    }
    if (new HashSet<>(keys).size() != keys.size()) {
      throw new IllegalArgumentException("payload redact_keys must be unique");
    }
    for (String key : keys) {
      int length = key.codePointCount(0, key.length());
      if (length < 1 || length > MAX_REDACT_KEY_LENGTH) {
        throw new IllegalArgumentException(
            "payload redact_keys must contain strings of 1 to "
                + MAX_REDACT_KEY_LENGTH
                + " characters");
      }
    }
    Map<String, @Nullable Object> document = new LinkedHashMap<>();
    document.put("include", payload.include());
    document.put("maxBytes", (long) payload.maxBytes());
    document.put("redactKeys", List.<@Nullable Object>copyOf(keys));
    return document;
  }

  private static String deadLetterFilter(
      @Nullable String queue,
      @Nullable String type,
      List<String> tags,
      @Nullable String errorName,
      @Nullable Instant finishedAfter,
      @Nullable Instant finishedBefore) {
    Map<String, @Nullable Object> filter = new LinkedHashMap<>();
    if (queue != null) {
      filter.put("queue", queue);
    }
    if (type != null) {
      filter.put("type", type);
    }
    if (!tags.isEmpty()) {
      filter.put("tags", List.<@Nullable Object>copyOf(tags));
    }
    if (errorName != null && !errorName.isEmpty()) {
      filter.put("errorName", errorName);
    }
    if (finishedAfter != null) {
      filter.put("finishedAfter", Values.timestamp(finishedAfter));
    }
    if (finishedBefore != null) {
      filter.put("finishedBefore", Values.timestamp(finishedBefore));
    }
    return Json.write(filter);
  }

  // ---------------------------------------------------------------------------------------------
  // Rows

  private List<Row> externalWaitRows(
      Call call, SqlCatalogue.Statement statement, int limit, @Nullable ExternalWaitCursor cursor) {
    limit(limit, MAX_PAGE_SIZE, "external wait limit");
    assertCompatible(call);
    // The read of one more wait than the page tells a full last page from a page with more.
    return Sql.rows(
        call.connection,
        statement,
        Integer.toString(limit + 1),
        cursor == null ? null : cursor.createdAt(),
        cursor == null ? null : cursor.taskId().toString(),
        cursor == null ? null : cursor.name());
  }

  private static @Nullable ExternalWaitCursor externalWaitCursor(List<Row> rows, int limit) {
    if (rows.size() <= limit) {
      return null;
    }
    Row last = rows.get(limit - 1);
    return new ExternalWaitCursor(
        last.requiredText("cursor_created_at"),
        last.requiredUuid("task_id"),
        last.requiredText("wait_name"));
  }

  private static TaskListItem taskItem(Row row) {
    return new TaskListItem(
        row.requiredUuid("task_id"),
        row.requiredText("queue_name"),
        row.requiredText("task_type"),
        row.text("concurrency_key"),
        row.requiredInteger("priority"),
        required(row.textList("tags"), "tags"),
        state(row),
        row.uuid("prerequisite_task_id"),
        Rows.uuids(row, "prerequisite_task_ids"),
        dependencyPolicy(row),
        blockedReason(row),
        row.uuid("parent_task_id"),
        Rows.uuids(row, "child_task_ids"),
        row.requiredInteger("current_attempt"),
        row.requiredInteger("max_attempts"),
        Json.object(row.json("retry_policy")),
        row.instant("deadline_at"),
        duration(row, "execution_timeout_ms"),
        row.requiredInstant("run_at"),
        row.instant("cancel_requested_at"),
        row.text("cancel_requested_by"),
        row.text("cancel_reason"),
        row.requiredInstant("created_at"),
        row.requiredInstant("updated_at"),
        row.json("payload"),
        Rows.constant(
            TaskPayloadStatus.class, "task_payload_status", row.requiredText("payload_status")),
        row.longValue("payload_bytes"));
  }

  private static TaskDetail taskDetail(Row row) {
    UUID id = row.requiredUuid("id");
    TaskProgress progress = null;
    if (row.text("progress_revision") != null) {
      progress =
          new TaskProgress(
              id,
              row.json("progress_value"),
              row.requiredLong("progress_revision"),
              row.requiredInteger("progress_attempt"),
              row.requiredLong("progress_fence_token"),
              row.requiredText("progress_worker_id"),
              row.requiredInstant("progress_created_at"),
              row.requiredInstant("progress_updated_at"));
    }
    return new TaskDetail(
        id,
        row.requiredText("queue_name"),
        row.requiredText("task_type"),
        row.text("concurrency_key"),
        row.requiredInteger("priority"),
        row.json("payload"),
        row.text("contract_version"),
        required(row.textList("tags"), "tags"),
        state(row),
        row.uuid("prerequisite_task_id"),
        Rows.uuids(row, "prerequisite_task_ids"),
        dependencyPolicy(row),
        blockedReason(row),
        row.uuid("parent_task_id"),
        Rows.uuids(row, "child_task_ids"),
        row.requiredInteger("current_attempt"),
        row.requiredInteger("max_attempts"),
        Json.object(row.json("retry_policy")),
        row.instant("deadline_at"),
        duration(row, "execution_timeout_ms"),
        row.longValue("version"),
        row.requiredInstant("run_at"),
        row.json("result"),
        row.json("error"),
        row.instant("cancel_requested_at"),
        row.text("cancel_requested_by"),
        row.text("cancel_reason"),
        progress,
        row.requiredInstant("created_at"),
        row.requiredInstant("updated_at"));
  }

  private static TaskTimelineEntry timelineEntry(Row row) {
    UUID recordId = row.requiredUuid("record_id");
    int priority = row.requiredInteger("priority");
    Integer attempt = row.integer("attempt");
    Instant occurredAt = row.requiredInstant("occurred_at");
    return switch (Rows.constant(TaskTimelineKind.class, "timeline_kind", row.text("kind"))) {
      case EVENT ->
          new TaskTimelineEvent(
              recordId,
              priority,
              attempt,
              occurredAt,
              row.requiredText("event_type"),
              row.json("details"));
      case ATTEMPT ->
          new TaskTimelineAttempt(
              recordId,
              priority,
              attempt,
              occurredAt,
              row.requiredLong("fence_token"),
              row.requiredText("worker_id"),
              row.requiredText("outcome"),
              row.requiredInstant("started_at"),
              row.requiredInstant("claimed_at"),
              row.requiredInstant("finished_at"),
              row.json("error"));
    };
  }

  private static DeadLetter deadLetter(Row row) {
    return new DeadLetter(
        row.requiredUuid("task_id"),
        row.requiredText("queue_name"),
        row.requiredText("task_type"),
        row.text("concurrency_key"),
        row.requiredInteger("priority"),
        row.json("payload"),
        required(row.textList("tags"), "tags"),
        row.requiredInteger("current_attempt"),
        row.requiredInteger("max_attempts"),
        Json.object(row.json("retry_policy")),
        row.instant("deadline_at"),
        duration(row, "execution_timeout_ms"),
        row.json("error"),
        row.requiredInstant("finished_at"),
        row.requiredLong("redrive_count"));
  }

  private static RedriveResult redriveResult(Row row) {
    String source = row.text("source_state");
    String target = row.text("target_state");
    return new RedriveResult(
        Rows.constant(RedriveStatus.class, "redrive", row.text("status")),
        row.requiredUuid("source_task_id"),
        row.uuid("target_task_id"),
        source == null ? null : Rows.constant(TaskState.class, "state", source),
        target == null ? null : Rows.constant(TaskState.class, "state", target),
        row.instant("requested_at"));
  }

  private static TaskCheckpoint checkpoint(Row row) {
    return new TaskCheckpoint(
        row.requiredUuid("task_id"),
        row.requiredText("checkpoint_name"),
        row.json("checkpoint_value"),
        row.requiredInteger("attempt"),
        row.requiredLong("fence_token"),
        row.requiredText("worker_id"),
        row.requiredInstant("created_at"),
        row.text("input_fingerprint"));
  }

  private static TaskWait taskWait(Row row) {
    return new TaskWait(
        row.requiredUuid("task_id"),
        row.requiredText("wait_name"),
        Rows.constant(TaskWaitMode.class, "wait_mode", row.text("mode")),
        duration(row, "duration_ms"),
        row.instant("requested_wake_at"),
        row.requiredInstant("wake_at"),
        row.requiredInteger("attempt"),
        row.requiredLong("fence_token"),
        row.requiredText("worker_id"),
        row.requiredInstant("created_at"));
  }

  private static TaskState state(Row row) {
    return Rows.constant(TaskState.class, "state", row.text("state"));
  }

  private static @Nullable TaskDependencyPolicy dependencyPolicy(Row row) {
    String onFailure = row.text("dependency_on_failure");
    if (onFailure == null) {
      return null;
    }
    return new TaskDependencyPolicy(
        Rows.constant(
            DependencyPolicy.class, "dependency_policy", row.text("dependency_on_success")),
        Rows.constant(DependencyPolicy.class, "dependency_policy", onFailure),
        Rows.constant(
            DependencyPolicy.class, "dependency_policy", row.text("dependency_on_cancellation")));
  }

  private static @Nullable TaskBlockedReason blockedReason(Row row) {
    String reason = row.text("blocked_reason");
    return reason == null ? null : Rows.constant(TaskBlockedReason.class, "blocked_reason", reason);
  }

  private static TaskGroupRepairAction repairAction(Row row) {
    return Rows.constant(TaskGroupRepairAction.class, "task_group_repair", row.text("action"));
  }

  private static @Nullable Duration duration(Row row, String column) {
    Long milliseconds = row.longValue(column);
    return milliseconds == null ? null : Values.duration(milliseconds);
  }

  private static <T> T required(@Nullable T value, String column) {
    if (value == null) {
      throw new WorkhorseException("PostgreSQL returned an invalid " + column + " column");
    }
    return value;
  }

  /** A {@code boolean} column. PgJDBC gives its text as {@code t} or {@code f}. */
  private static boolean bool(Row row, String column) {
    return switch (row.requiredText(column)) {
      case "t", "true" -> true;
      case "f", "false" -> false;
      default ->
          throw new WorkhorseException("PostgreSQL returned an invalid " + column + " column");
    };
  }

  /** True when the last row of a page reports that another page follows. */
  private static boolean hasMore(List<Row> rows) {
    return !rows.isEmpty() && bool(rows.get(rows.size() - 1), "has_more");
  }

  private static String wire(Enum<?> value) {
    return value.name().toLowerCase(Locale.ROOT);
  }

  private static Optional<Row> first(List<Row> rows) {
    return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
  }

  private static <T> List<T> map(List<Row> rows, Function<Row, T> mapper) {
    List<T> items = new ArrayList<>(rows.size());
    for (Row row : rows) {
      items.add(mapper.apply(row));
    }
    return List.copyOf(items);
  }

  // ---------------------------------------------------------------------------------------------
  // Connections

  /** The connection of one call. {@code caller} is true when the caller owns the connection. */
  private record Call(Connection connection, boolean caller) {}

  private interface Body<T extends @Nullable Object> {
    T run(Call call);
  }

  /**
   * Runs {@code body} on the caller's connection, or on a connection from the source. The admin
   * never begins, commits, or rolls back on either.
   */
  private <T extends @Nullable Object> T run(@Nullable Connection caller, Body<T> body) {
    if (caller != null) {
      return body.run(new Call(caller, true));
    }
    Connection connection;
    try {
      connection = connections.acquire();
    } catch (SQLException error) {
      throw Sql.translate(error);
    }
    boolean transactional = false;
    T result;
    try {
      transactional = !connection.getAutoCommit();
      result = body.run(new Call(connection, false));
    } catch (SQLException error) {
      WorkhorseException translated = Sql.translate(error);
      releaseAfter(connection, transactional, translated);
      throw translated;
    } catch (RuntimeException | Error error) {
      releaseAfter(connection, transactional, error);
      throw error;
    }
    try {
      connections.release(connection, transactional);
    } catch (SQLException error) {
      throw Sql.translate(error);
    }
    return result;
  }

  /** Releases a connection after {@code failure}, which keeps any release error as suppressed. */
  private void releaseAfter(Connection connection, boolean transactional, Throwable failure) {
    try {
      connections.release(connection, transactional);
    } catch (SQLException error) {
      failure.addSuppressed(Sql.translate(error));
    }
  }
}
