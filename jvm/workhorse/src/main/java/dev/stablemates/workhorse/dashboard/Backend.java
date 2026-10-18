package dev.stablemates.workhorse.dashboard;

import dev.stablemates.workhorse.Admin;
import dev.stablemates.workhorse.AdminAudit;
import dev.stablemates.workhorse.BulkRedrivePage;
import dev.stablemates.workhorse.ConnectionSource;
import dev.stablemates.workhorse.DeadLetterCursor;
import dev.stablemates.workhorse.Queue;
import dev.stablemates.workhorse.RedriveFilter;
import dev.stablemates.workhorse.RedriveResult;
import dev.stablemates.workhorse.RedriveStatus;
import dev.stablemates.workhorse.WorkerPauseResult;
import dev.stablemates.workhorse.WorkhorseException;
import dev.stablemates.workhorse.internal.Json;
import dev.stablemates.workhorse.internal.Row;
import dev.stablemates.workhorse.internal.Sql;
import dev.stablemates.workhorse.internal.SqlCatalogue;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import org.jspecify.annotations.Nullable;

/**
 * Answers each {@code dashboard/v1} procedure through {@link Admin}, {@link Queue}, and the
 * catalogue statement that owns it. Internal to the SDK; the counterpart of Ruby's {@code
 * Dashboard::Backend}.
 *
 * <p>Each procedure takes the validated input tree and the actor, and returns a JSON tree value.
 * Each statement runs on its own connection in autocommit. The backend opens no transaction.
 */
final class Backend {
  /**
   * How long one health document serves nearby reads. It matches the other hosts' queue health
   * readers, so every backend agrees on staleness.
   */
  private static final long QUEUE_HEALTH_TTL_NANOS = TimeUnit.SECONDS.toNanos(3);

  private static final long PREVIEW_CAP = 10_000;
  private static final List<String> RETENTION_SETTINGS =
      List.of(
          "taskIdentityRetentionDays",
          "terminalOutcomeRetentionDays",
          "taskEventRetentionDays",
          "attemptHistoryRetentionDays",
          "scheduleOccurrenceRetentionDays",
          "statisticsRetentionDays");

  /** Each preview count, as its result name and its column. */
  private static final List<List<String>> PREVIEW_COUNTS =
      List.of(
          List.of("terminalTasks", "terminal_tasks"),
          List.of("taskEvents", "task_events"),
          List.of("attemptHistory", "attempt_history"),
          List.of("scheduleOccurrences", "schedule_occurrences"),
          List.of("statistics", "statistics"));

  private static final List<String> MAINTENANCE_SETTINGS =
      List.of(
          "timezone",
          "partitionPreparationIntervalMs",
          "terminalCleanupIntervalMs",
          "historyRetentionLocalTime",
          "statisticsRollupIntervalMs",
          "statisticsGroupLimit",
          "statisticsRecomputeBuckets");
  private static final DateTimeFormatter ISO =
      DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
          .withZone(ZoneOffset.UTC);

  /** One built-in procedure. */
  @FunctionalInterface
  interface Procedure {
    @Nullable Object call(Map<String, ? extends @Nullable Object> input, String actor);
  }

  private final ConnectionSource connections;
  private final Admin admin;
  private final Queue queue;
  private final String environment;
  private final List<String> configuredWorkers;
  private final Map<String, @Nullable Object> maintenanceLoops;
  private final boolean readOnly;
  private final ReentrantLock healthLock = new ReentrantLock();
  private long healthExpiresAt;
  private @Nullable Map<String, @Nullable Object> health;

  Backend(
      ConnectionSource connections,
      String environment,
      List<String> configuredWorkers,
      Map<String, @Nullable Object> maintenanceLoops,
      boolean readOnly) {
    this.connections = connections;
    this.admin = new Admin(connections);
    this.queue = new Queue(connections);
    this.environment = environment;
    this.configuredWorkers = List.copyOf(configuredWorkers);
    this.maintenanceLoops = maintenanceLoops;
    this.readOnly = readOnly;
  }

  /** Procedure name to its built-in answer. */
  Map<String, Procedure> procedures() {
    Map<String, Procedure> procedures = new LinkedHashMap<>();
    procedures.put("meta", (input, actor) -> orderedMap("environment", environment));
    procedures.put("taskCounts", (input, actor) -> result(SqlCatalogue.DASHBOARD_TASK_COUNTS_V1));
    procedures.put("tasks", (input, actor) -> tasks(input));
    procedures.put(
        "tasksCursor",
        (input, actor) ->
            result(
                SqlCatalogue.DASHBOARD_TASKS_CURSOR_V1,
                with(input, "canCompleteHumanWait", !readOnly)));
    procedures.put("activity", (input, actor) -> result(SqlCatalogue.DASHBOARD_ACTIVITY_V1, input));
    procedures.put(
        "taskFacets",
        (input, actor) ->
            result(
                SqlCatalogue.DASHBOARD_TASK_FACETS_V1,
                orderedMap("configuredWorkers", configuredWorkers)));
    procedures.put("queues", (input, actor) -> result(SqlCatalogue.DASHBOARD_QUEUES_V1));
    procedures.put(
        "cron",
        (input, actor) ->
            result(
                SqlCatalogue.DASHBOARD_CRON_V1, orderedMap("maintenanceLoops", maintenanceLoops)));
    procedures.put(
        "workers",
        (input, actor) ->
            result(
                SqlCatalogue.DASHBOARD_WORKERS_V1,
                orderedMap("configuredWorkers", configuredWorkers, "canManageWorkers", !readOnly)));
    procedures.put(
        "humanWaits",
        (input, actor) ->
            result(
                SqlCatalogue.DASHBOARD_HUMAN_WAITS_V1,
                orderedMap(
                    "canComplete", !readOnly, "canSignal", !readOnly, "health", queueHealth())));
    procedures.put("events", (input, actor) -> result(SqlCatalogue.DASHBOARD_EVENTS_V1, input));
    procedures.put(
        "eventDetail",
        (input, actor) ->
            found(result(SqlCatalogue.DASHBOARD_EVENT_DETAIL_V1, input), "Event not found"));
    procedures.put("taskDetail", (input, actor) -> taskDetail(input));
    // Task detail withholds a large checkpoint value, payload, or result and reports its size, so
    // an operator opens that one value with these two procedures.
    procedures.put(
        "checkpointValue",
        (input, actor) ->
            found(
                result(SqlCatalogue.DASHBOARD_CHECKPOINT_VALUE_V1, input), "Checkpoint not found"));
    procedures.put(
        "taskValue",
        (input, actor) ->
            found(result(SqlCatalogue.DASHBOARD_TASK_VALUE_V1, input), "Task not found"));
    procedures.put(
        "settings",
        (input, actor) ->
            result(
                SqlCatalogue.DASHBOARD_SETTINGS_V1,
                orderedMap("writable", !readOnly, "settingsController", true)));
    procedures.put("system", (input, actor) -> result(SqlCatalogue.DASHBOARD_SYSTEM_V1, input));
    procedures.put("previewRetentionPolicy", (input, actor) -> previewRetentionPolicy(input));
    procedures.put("setQueuePaused", this::setQueuePaused);
    procedures.put(
        "purgeQueue",
        (input, actor) ->
            orderedMap(
                "deletedCount", admin.purgeQueue(text(input, "queue"), audit(input, actor))));
    procedures.put("setWorkerPaused", this::setWorkerPaused);
    procedures.put("overrideMaintenancePolicy", (input, actor) -> overrideMaintenance(input));
    procedures.put(
        "revertMaintenancePolicy",
        (input, actor) -> revert(SqlCatalogue.REVERT_MAINTENANCE_POLICY_V1, input));
    procedures.put("overrideRetentionPolicy", (input, actor) -> overrideRetention(input));
    procedures.put(
        "revertRetentionPolicy",
        (input, actor) -> revert(SqlCatalogue.REVERT_RETENTION_POLICY_V1, input));
    procedures.put("runTaskNow", this::runTaskNow);
    procedures.put("cancelTask", this::cancelTask);
    procedures.put("signalTask", this::signalTask);
    procedures.put("completeHumanWait", this::completeHumanWait);
    procedures.put("redriveTask", this::redriveTask);
    procedures.put("redriveDeadLetters", this::redriveDeadLetters);
    // The task group procedures (ADR 0095) run the statements that generate-bindings.ts copies
    // from the TypeScript server, so every backend answers them with the same JSON.
    procedures.put("taskGroups", (input, actor) -> shared(V1.TASK_GROUPS, input));
    procedures.put(
        "taskGroupDetail",
        (input, actor) ->
            found(
                shared(V1.TASK_GROUP_DETAIL, with(input, "canCancel", !readOnly)),
                "Task group not found"));
    procedures.put("cancelTaskGroup", this::cancelTaskGroup);
    return procedures;
  }

  private @Nullable Object tasks(Map<String, ? extends @Nullable Object> input) {
    Map<String, @Nullable Object> query = new LinkedHashMap<>();
    query.put("filter", "all");
    query.put("queue", null);
    query.put("page", 1L);
    query.put("worker", null);
    query.put("taskType", null);
    query.put("priority", null);
    query.put("sort", "updated");
    query.put("tags", List.of());
    query.put("search", null);
    query.put("pageSize", 50L);
    query.put("count", "none");
    query.putAll(input);
    query.put("canCompleteHumanWait", !readOnly);
    return result(SqlCatalogue.DASHBOARD_TASKS_V1, query);
  }

  private Object taskDetail(Map<String, ? extends @Nullable Object> input) {
    Map<String, @Nullable Object> query = new LinkedHashMap<>(input);
    query.put("canSignal", !readOnly);
    query.put("canCompleteHumanWait", !readOnly);
    query.put("health", queueHealth());
    return found(result(SqlCatalogue.DASHBOARD_TASK_DETAIL_V1, query), "Task not found");
  }

  private Object previewRetentionPolicy(Map<String, ? extends @Nullable Object> input) {
    Map<String, @Nullable Object> definition = object(input, "definition");
    Row current = one(SqlCatalogue.GET_RETENTION_POLICY_V1);
    @Nullable Object[] days = new @Nullable Object[RETENTION_SETTINGS.size()];
    for (int index = 0; index < days.length; index++) {
      String name = RETENTION_SETTINGS.get(index);
      days[index] =
          definition.containsKey(name) ? textOf(definition.get(name)) : current.text(snake(name));
    }
    Row counts = one(SqlCatalogue.RETENTION_POLICY_PREVIEW, days);
    Map<String, @Nullable Object> eligible = new LinkedHashMap<>();
    Map<String, @Nullable Object> capped = new LinkedHashMap<>();
    for (List<String> preview : PREVIEW_COUNTS) {
      long count = counts.requiredLong(preview.get(1));
      eligible.put(preview.get(0), Math.min(count, PREVIEW_CAP));
      capped.put(preview.get(0), count > PREVIEW_CAP);
    }
    return orderedMap("eligible", eligible, "capped", capped);
  }

  private Object setQueuePaused(Map<String, ? extends @Nullable Object> input, String actor) {
    boolean paused = bool(input, "paused");
    AdminAudit audit = audit(input, actor);
    if (paused) {
      admin.pauseQueue(text(input, "queue"), audit);
    } else {
      admin.resumeQueue(text(input, "queue"), audit);
    }
    return orderedMap("paused", paused);
  }

  private Object setWorkerPaused(Map<String, ? extends @Nullable Object> input, String actor) {
    Optional<WorkerPauseResult> result =
        admin.setWorkerPaused(text(input, "workerId"), bool(input, "paused"), audit(input, actor));
    return orderedMap(
        "paused",
        result.orElseThrow(() -> DashboardRpcException.notFound("Worker not found")).paused());
  }

  private @Nullable Object overrideMaintenance(Map<String, ? extends @Nullable Object> input) {
    Map<String, @Nullable Object> definition = object(input, "definition");
    @Nullable Object[] settings = new @Nullable Object[MAINTENANCE_SETTINGS.size()];
    for (int index = 0; index < settings.length; index++) {
      settings[index] = textOf(definition.get(MAINTENANCE_SETTINGS.get(index)));
    }
    run(SqlCatalogue.OVERRIDE_MAINTENANCE_POLICY_V1, settings);
    return null;
  }

  private @Nullable Object overrideRetention(Map<String, ? extends @Nullable Object> input) {
    Map<String, @Nullable Object> overrides = new LinkedHashMap<>();
    object(input, "definition").forEach((name, value) -> overrides.put(snake(name), value));
    run(SqlCatalogue.OVERRIDE_RETENTION_POLICY_V1, Json.write(overrides));
    return null;
  }

  private @Nullable Object revert(
      SqlCatalogue.Statement statement, Map<String, ? extends @Nullable Object> input) {
    List<String> settings = new ArrayList<>();
    for (Object name : list(input, "settings")) {
      settings.add(snake((String) name));
    }
    run(statement, (Object) Sql.textArray(settings));
    return null;
  }

  private Object runTaskNow(Map<String, ? extends @Nullable Object> input, String actor) {
    Map<String, @Nullable Object> audit = object(input, "audit");
    Row row =
        operation(
            SqlCatalogue.RUN_TASK_NOW_V1,
            text(input, "id"),
            actor,
            textOf(audit.get("reason")),
            textOf(audit.get("requestId")));
    return orderedMap(
        "status", row.text("status"),
        "id", text(input, "id"),
        "state", row.text("state"),
        "runAt", iso(row.instant("run_at")));
  }

  private Object cancelTask(Map<String, ? extends @Nullable Object> input, String actor) {
    Row row =
        operation(
            SqlCatalogue.CANCEL_V1,
            text(input, "id"),
            actor,
            textOf(object(input, "audit").get("reason")));
    Map<String, @Nullable Object> result = new LinkedHashMap<>();
    result.put("status", row.text("status"));
    result.put("taskId", text(input, "id"));
    result.put("state", row.text("state"));
    result.put("currentAttempt", row.longValue("current_attempt"));
    result.put("requestedAt", iso(row.instant("requested_at")));
    result.put("requestedBy", row.text("requested_by"));
    result.put("reason", row.text("reason"));
    result.put("finishedAt", iso(row.instant("finished_at")));
    return result;
  }

  private Object signalTask(Map<String, ? extends @Nullable Object> input, String actor) {
    Row row =
        operation(
            SqlCatalogue.SEND_SIGNAL_V1,
            text(input, "id"),
            text(input, "name"),
            Json.write(input.get("payload")),
            text(input, "idempotencyKey"),
            actor);
    Map<String, @Nullable Object> result = new LinkedHashMap<>();
    result.put("status", row.text("status"));
    result.put("taskId", text(input, "id"));
    result.put("name", text(input, "name"));
    result.put("payload", row.json("payload"));
    result.put("deliveredAt", iso(row.instant("delivered_at")));
    result.put("deliveredBy", row.text("delivered_by"));
    return result;
  }

  private Object completeHumanWait(Map<String, ? extends @Nullable Object> input, String actor) {
    Row row =
        operation(
            SqlCatalogue.COMPLETE_HUMAN_WAIT_V1,
            text(input, "id"),
            text(input, "name"),
            Json.write(input.get("result")),
            text(input, "idempotencyKey"),
            actor);
    Map<String, @Nullable Object> result = new LinkedHashMap<>();
    result.put("status", row.text("status"));
    result.put("taskId", text(input, "id"));
    result.put("name", text(input, "name"));
    result.put("result", row.json("result"));
    result.put("completedAt", iso(row.instant("completed_at")));
    result.put("completedBy", row.text("completed_by"));
    return result;
  }

  private Object redriveTask(Map<String, ? extends @Nullable Object> input, String actor) {
    RedriveResult result = admin.redrive(UUID.fromString(text(input, "id")), audit(input, actor));
    if (result.status() == RedriveStatus.NOT_FOUND) {
      throw DashboardRpcException.notFound("Task not found");
    }
    return redriveResult(result);
  }

  private Object redriveDeadLetters(Map<String, ? extends @Nullable Object> input, String actor) {
    Map<String, @Nullable Object> cursor = Json.object(input.get("cursor"));
    List<String> tags = new ArrayList<>();
    if (input.get("tags") instanceof List<?> values) {
      values.forEach(tag -> tags.add((String) tag));
    }
    RedriveFilter filter =
        RedriveFilter.builder()
            .limit(input.get("limit") instanceof Long limit ? Math.toIntExact(limit) : 100)
            .cursor(
                cursor == null
                    ? null
                    : new DeadLetterCursor(
                        text(cursor, "finishedAt"), UUID.fromString(text(cursor, "taskId"))))
            .queue(textOf(input.get("queue")))
            .type(textOf(input.get("taskType")))
            .tags(tags)
            .build();
    BulkRedrivePage page = admin.redriveMany(filter, audit(input, actor));
    List<@Nullable Object> results = new ArrayList<>();
    page.results().forEach(result -> results.add(redriveResult(result)));
    DeadLetterCursor next = page.nextCursor();
    return orderedMap(
        "results",
        results,
        "nextCursor",
        next == null
            ? null
            : orderedMap("finishedAt", next.finishedAt(), "taskId", next.taskId().toString()));
  }

  /** Seals the group and cancels each member task that is not terminal. */
  private Object cancelTaskGroup(Map<String, ? extends @Nullable Object> input, String actor) {
    AdminAudit audit = audit(input, actor);
    Map<String, @Nullable Object> request = new LinkedHashMap<>();
    request.put("id", text(input, "id"));
    request.put("actor", audit.actor());
    request.put("reason", audit.reason());
    request.put("requestId", audit.requestId());
    return found(shared(V1.CANCEL_TASK_GROUP, request), "Task group not found");
  }

  // ---------------------------------------------------------------------------------------------
  // Statements

  /** The parsed {@code result} column of a dashboard function, or {@code null} for SQL NULL. */
  private @Nullable Object result(SqlCatalogue.Statement statement) {
    return one(statement).json("result");
  }

  private @Nullable Object result(
      SqlCatalogue.Statement statement, Map<String, ? extends @Nullable Object> document) {
    return one(statement, Json.write(document)).json("result");
  }

  /**
   * The parsed {@code result} column of a shared {@code dashboard/v1} statement. The statement
   * comes from the contract, not the catalogue, so it runs on a prepared statement here.
   */
  private @Nullable Object shared(String sql, Map<String, ? extends @Nullable Object> document) {
    return withConnection(
        connection -> {
          try (PreparedStatement prepared = connection.prepareStatement(sql)) {
            prepared.setString(1, Json.write(document));
            try (ResultSet resultSet = prepared.executeQuery()) {
              if (!resultSet.next()) {
                throw new WorkhorseException("a dashboard/v1 statement returned no row");
              }
              String result = resultSet.getString("result");
              if (resultSet.next()) {
                throw new WorkhorseException("a dashboard/v1 statement returned many rows");
              }
              return result == null ? null : Json.parse(result);
            }
          }
        });
  }

  private Row one(SqlCatalogue.Statement statement, @Nullable Object... parameters) {
    List<Row> rows = run(statement, parameters);
    if (rows.size() != 1) {
      throw new WorkhorseException(
          statement.name() + " returned " + rows.size() + " rows; expected one");
    }
    return rows.get(0);
  }

  private Row operation(SqlCatalogue.Statement statement, @Nullable Object... parameters) {
    Row row = one(statement, parameters);
    if ("not_found".equals(row.text("status"))) {
      throw DashboardRpcException.notFound("Task not found");
    }
    return row;
  }

  private List<Row> run(SqlCatalogue.Statement statement, @Nullable Object... parameters) {
    return withConnection(connection -> Sql.rows(connection, statement, parameters));
  }

  /** Work on one connection. */
  @FunctionalInterface
  private interface ConnectionWork<T extends @Nullable Object> {
    T apply(Connection connection) throws SQLException;
  }

  private <T extends @Nullable Object> T withConnection(ConnectionWork<T> work) {
    Connection connection;
    try {
      connection = connections.acquire();
    } catch (SQLException error) {
      throw Sql.translate(error);
    }
    T result;
    try {
      result = work.apply(connection);
    } catch (SQLException error) {
      release(connection);
      throw Sql.translate(error);
    } catch (RuntimeException error) {
      release(connection);
      throw error;
    }
    release(connection);
    return result;
  }

  private void release(Connection connection) {
    try {
      connections.release(connection, false);
    } catch (SQLException error) {
      throw Sql.translate(error);
    }
  }

  /**
   * The {@code queue_health_v1} snapshot, shared for three seconds.
   *
   * <p>One dashboard page reads it from several procedures, and each accepts it as its {@code
   * health} input, so the page pays for one pass over live queue state. The lock serializes
   * concurrent misses, and a failed read is never cached.
   */
  private Map<String, @Nullable Object> queueHealth() {
    healthLock.lock();
    try {
      Map<String, @Nullable Object> cached = health;
      if (cached != null && healthExpiresAt - System.nanoTime() > 0) {
        return cached;
      }
      Map<String, @Nullable Object> snapshot = queue.health().snapshot();
      health = snapshot;
      healthExpiresAt = System.nanoTime() + QUEUE_HEALTH_TTL_NANOS;
      return snapshot;
    } finally {
      healthLock.unlock();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Values

  private static Object found(@Nullable Object value, String message) {
    if (value == null) {
      throw DashboardRpcException.notFound(message);
    }
    return value;
  }

  private static AdminAudit audit(Map<String, ? extends @Nullable Object> input, String actor) {
    Map<String, @Nullable Object> audit = object(input, "audit");
    return new AdminAudit(actor, text(audit, "reason"), text(audit, "requestId"));
  }

  private static Map<String, @Nullable Object> redriveResult(RedriveResult result) {
    Map<String, @Nullable Object> document = new LinkedHashMap<>();
    document.put("status", result.status().name().toLowerCase(Locale.ROOT));
    document.put("sourceTaskId", result.sourceTaskId().toString());
    UUID target = result.targetTaskId();
    document.put("targetTaskId", target == null ? null : target.toString());
    document.put("sourceState", lower(result.sourceState()));
    document.put("targetState", lower(result.targetState()));
    document.put("requestedAt", iso(result.requestedAt()));
    return document;
  }

  private static @Nullable String lower(@Nullable Enum<?> value) {
    return value == null ? null : value.name().toLowerCase(Locale.ROOT);
  }

  private static @Nullable String iso(@Nullable Instant instant) {
    return instant == null ? null : ISO.format(instant);
  }

  private static Map<String, @Nullable Object> with(
      Map<String, ? extends @Nullable Object> input, String name, Object value) {
    Map<String, @Nullable Object> copy = new LinkedHashMap<>(input);
    copy.put(name, value);
    return copy;
  }

  private static Map<String, @Nullable Object> object(
      Map<String, ? extends @Nullable Object> input, String name) {
    Map<String, @Nullable Object> value = Json.object(input.get(name));
    if (value == null) {
      throw new IllegalArgumentException(name + " must be an object");
    }
    return value;
  }

  private static List<?> list(Map<String, ? extends @Nullable Object> input, String name) {
    if (!(input.get(name) instanceof List<?> value)) {
      throw new IllegalArgumentException(name + " must be an array");
    }
    return value;
  }

  private static String text(Map<String, ? extends @Nullable Object> input, String name) {
    if (!(input.get(name) instanceof String value)) {
      throw new IllegalArgumentException(name + " must be a string");
    }
    return value;
  }

  private static boolean bool(Map<String, ? extends @Nullable Object> input, String name) {
    if (!(input.get(name) instanceof Boolean value)) {
      throw new IllegalArgumentException(name + " must be a boolean");
    }
    return value;
  }

  /** The text form of a scalar input for a {@code text}-bound parameter, or {@code null}. */
  private static @Nullable String textOf(@Nullable Object value) {
    return value == null ? null : value instanceof String text ? text : Json.write(value);
  }

  private static String snake(String name) {
    StringBuilder out = new StringBuilder(name.length() + 8);
    for (int index = 0; index < name.length(); index++) {
      char character = name.charAt(index);
      if (character >= 'A' && character <= 'Z') {
        out.append('_').append(Character.toLowerCase(character));
      } else {
        out.append(character);
      }
    }
    return out.toString();
  }

  private static Map<String, @Nullable Object> orderedMap(@Nullable Object... entries) {
    Map<String, @Nullable Object> map = new LinkedHashMap<>();
    for (int index = 0; index < entries.length; index += 2) {
      map.put((String) Objects.requireNonNull(entries[index]), entries[index + 1]);
    }
    return map;
  }
}
