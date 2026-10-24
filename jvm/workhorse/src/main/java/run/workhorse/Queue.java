package run.workhorse;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.CompatibilityCache;
import run.workhorse.internal.ContractSchema;
import run.workhorse.internal.Contracts;
import run.workhorse.internal.Contracts.PayloadContract;
import run.workhorse.internal.Json;
import run.workhorse.internal.PgjdbcVersion;
import run.workhorse.internal.Row;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.internal.Values;
import run.workhorse.internal.telemetry.Names;
import run.workhorse.internal.telemetry.Telemetry;
import run.workhorse.internal.telemetry.TelemetrySpan;

/**
 * Submits and controls tasks. The counterpart of Ruby's {@code Stablemates::Workhorse::Queue}.
 *
 * <p>Every method has two forms (ADR 0103, "Connection model"):
 *
 * <ul>
 *   <li>The <b>caller form</b> takes a {@link Connection} as its first argument. The queue runs on
 *       that connection, inside the caller's transaction. It never begins, commits, or rolls back,
 *       so the call commits and rolls back with the caller's transaction.
 *   <li>The <b>source form</b> omits the connection. The queue acquires one from its {@link
 *       ConnectionSource} for the call, and releases it after the call.
 * </ul>
 *
 * <p>The queue runs the startup compatibility check before its first statement. It caches the
 * result once for the source, and once for each caller connection. A refusal is cached; a driver
 * error is not. An invalid argument throws {@link IllegalArgumentException} before any statement
 * runs.
 */
public final class Queue {
  private static final System.Logger LOGGER = System.getLogger(Queue.class.getName());

  private static final long DEFAULT_IDEMPOTENCY_TTL_MS = 86_400_000L;
  private static final int DEFAULT_MAX_ATTEMPTS = 25;
  private static final int MAX_TASK_DEPENDENCIES = 100;
  private static final int MAX_EXTERNAL_VALUE_BYTES = 65_536;
  private static final long MAX_DURATION_MS = 31_536_000_000L;
  private static final long MAX_RATE_INTERVAL_MS = 86_400_000L;
  private static final int MAX_POLICY_VALUE = 1_000_000;
  private static final int MAX_POLICY_DEFINITIONS = 10_000;
  private static final int MAX_NAME_BYTES = 256;
  private static final int MAX_KEY_BYTES = 512;
  private static final int MAX_TAGS = 20;
  private static final int MAX_TAG_LENGTH = 100;
  private static final int MAX_PAGE_SIZE = 1000;
  private static final Map<String, List<String>> RETRY_POLICY_FIELDS =
      Map.of(
          "fixed", List.of("delayMs"),
          "exponential", List.of("initialDelayMs", "multiplier", "maxDelayMs"),
          "decorrelated-jitter", List.of("baseDelayMs", "maxDelayMs"));
  private static final String WHITESPACE = "\0\t\n\u000B\f\r ";

  private final ConnectionSource connections;
  private final String defaultQueue;
  private final JsonCodec codec;
  private final Telemetry telemetry;
  private final ReentrantLock lock = new ReentrantLock();
  private final CompatibilityCache compatibility = new CompatibilityCache();
  private boolean contractsEnabled;
  private final Map<String, @Nullable PayloadContract> contracts = new HashMap<>();

  /** A queue on {@code connections} with the default options. */
  public Queue(ConnectionSource connections) {
    this(connections, QueueOptions.defaults());
  }

  /**
   * A queue on {@code connections}.
   *
   * @throws IllegalStateException if the PgJDBC driver on the class path is older than 42.7.12, or
   *     reports a version that the SDK cannot read
   */
  public Queue(ConnectionSource connections, QueueOptions options) {
    PgjdbcVersion.require();
    this.connections = Objects.requireNonNull(connections, "connections");
    this.defaultQueue = options.defaultQueue();
    this.codec = options.codec();
    this.telemetry = options.telemetry().telemetry();
  }

  /** The queue of a request that names none. */
  public String defaultQueue() {
    return defaultQueue;
  }

  // ---------------------------------------------------------------------------------------------
  // Compatibility

  /**
   * Runs the startup compatibility check once for the source.
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
    CompatibilityException.Code code = compatibility.check(call.connection, call.caller);
    if (code != null) {
      throw new CompatibilityException(code);
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Enqueue

  /** Submits one task with the default options. */
  public EnqueueResult enqueue(String taskType, @Nullable Object payload) {
    return enqueue(taskType, payload, EnqueueOptions.defaults());
  }

  /** Submits one task. */
  public EnqueueResult enqueue(String taskType, @Nullable Object payload, EnqueueOptions options) {
    return enqueueMany(List.of(EnqueueRequest.of(taskType, payload, options))).get(0);
  }

  /** Submits one task with the default options inside the caller's transaction. */
  public EnqueueResult enqueue(Connection connection, String taskType, @Nullable Object payload) {
    return enqueue(connection, taskType, payload, EnqueueOptions.defaults());
  }

  /** Submits one task inside the caller's transaction. */
  public EnqueueResult enqueue(
      Connection connection, String taskType, @Nullable Object payload, EnqueueOptions options) {
    return enqueueMany(connection, List.of(EnqueueRequest.of(taskType, payload, options))).get(0);
  }

  /**
   * Submits one atomic batch of at most 1,000 requests, and returns PostgreSQL's results in request
   * order.
   */
  public List<EnqueueResult> enqueueMany(List<EnqueueRequest> requests) {
    return run(null, call -> enqueueMany(call, requests));
  }

  /** Submits one atomic batch inside the caller's transaction. */
  public List<EnqueueResult> enqueueMany(Connection connection, List<EnqueueRequest> requests) {
    return run(connection, call -> enqueueMany(call, requests));
  }

  private List<EnqueueResult> enqueueMany(Call call, List<EnqueueRequest> requests) {
    if (requests.isEmpty()) {
      return List.of();
    }
    if (requests.size() > SqlCatalogue.MAX_ENQUEUE_BATCH_SIZE) {
      throw new IllegalArgumentException("enqueue batch exceeds the shared limit");
    }
    TelemetrySpan span = telemetry.span(Names.SPAN_ENQUEUE, enqueueAttributes(requests));
    try {
      List<Row> rows =
          submitRequests(
              call,
              requests,
              document -> Sql.rows(call.connection, SqlCatalogue.ENQUEUE_MANY_V1, document));
      List<EnqueueResult> results = enqueueResults(rows, requests.size());
      if (results.size() == 1) {
        span.setAttribute(Names.TASK_ID, results.get(0).taskId());
        span.setAttribute(
            Names.ENQUEUE_OUTCOME, results.get(0).outcome().name().toLowerCase(Locale.ROOT));
      }
      return results;
    } catch (RuntimeException error) {
      span.recordError(error.getClass().getSimpleName());
      throw error;
    } finally {
      span.close();
    }
  }

  private Map<String, @Nullable Object> enqueueAttributes(List<EnqueueRequest> requests) {
    List<String> queues = new ArrayList<>();
    List<String> taskTypes = new ArrayList<>();
    for (EnqueueRequest request : requests) {
      String named = request.options().queue();
      queues.add(named == null || named.isEmpty() ? defaultQueue : named);
      taskTypes.add(request.taskType());
    }
    return Names.enqueue(queues, taskTypes);
  }

  // ---------------------------------------------------------------------------------------------
  // Task groups

  /**
   * Creates an open task group (ADR 0095). Add tasks with {@link #addToTaskGroup}, then seal the
   * group with {@link #sealTaskGroup}.
   */
  public TaskGroup createTaskGroup(TaskGroupCallbacks callbacks) {
    return run(null, call -> createGroup(call, callbacks, List.of(), false).group());
  }

  /** Creates an open task group inside the caller's transaction. */
  public TaskGroup createTaskGroup(Connection connection, TaskGroupCallbacks callbacks) {
    return run(connection, call -> createGroup(call, callbacks, List.of(), false).group());
  }

  /**
   * Creates a task group, gives {@code block} a {@link TaskGroupBuilder}, adds the tasks the block
   * collects, and seals the group, in one statement. If the block throws, nothing is enqueued. A
   * group with no tasks finishes at the seal.
   */
  public TaskGroupBlockResult taskGroup(
      TaskGroupCallbacks callbacks, Consumer<TaskGroupBuilder> block) {
    List<EnqueueRequest> requests = collect(block);
    return run(null, call -> createGroup(call, callbacks, requests, true));
  }

  /** The block form of a task group, inside the caller's transaction. */
  public TaskGroupBlockResult taskGroup(
      Connection connection, TaskGroupCallbacks callbacks, Consumer<TaskGroupBuilder> block) {
    List<EnqueueRequest> requests = collect(block);
    return run(connection, call -> createGroup(call, callbacks, requests, true));
  }

  private static List<EnqueueRequest> collect(Consumer<TaskGroupBuilder> block) {
    TaskGroupBuilder builder = new TaskGroupBuilder();
    block.accept(builder);
    return builder.requests();
  }

  /**
   * Enqueues at most 1,000 requests as member tasks of an open group, and returns their results in
   * request order. A request cannot use debounce or throttle.
   */
  public List<EnqueueResult> addToTaskGroup(UUID groupId, List<EnqueueRequest> requests) {
    return run(null, call -> addTaskGroupMembers(call, groupId, requests, NO_MEMBER));
  }

  /** Adds member tasks inside the caller's transaction. */
  public List<EnqueueResult> addToTaskGroup(
      Connection connection, UUID groupId, List<EnqueueRequest> requests) {
    return run(connection, call -> addTaskGroupMembers(call, groupId, requests, NO_MEMBER));
  }

  /**
   * Seals an open group. A group with no pending member finishes at once. Sealing a sealed or
   * finished group changes nothing.
   */
  public TaskGroup sealTaskGroup(UUID groupId) {
    return run(null, call -> sealTaskGroup(call, groupId));
  }

  /** Seals an open group inside the caller's transaction. */
  public TaskGroup sealTaskGroup(Connection connection, UUID groupId) {
    return run(connection, call -> sealTaskGroup(call, groupId));
  }

  private TaskGroup sealTaskGroup(Call call, UUID groupId) {
    assertCompatible(call);
    return Rows.group(
        Rows.exactlyOne(
            Sql.rows(call.connection, SqlCatalogue.SEAL_TASK_GROUP_V1, groupId.toString()),
            "seal_task_group_v1"));
  }

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
    List<Row> rows = Sql.rows(call.connection, SqlCatalogue.GET_TASK_GROUP_V1, groupId.toString());
    return rows.isEmpty() ? Optional.empty() : Optional.of(Rows.group(rows.get(0)));
  }

  /** The first page of at most 100 member tasks. */
  public TaskGroupMemberPage listTaskGroupMembers(UUID groupId) {
    return listTaskGroupMembers(groupId, 0, 100);
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
    return listTaskGroupMembers(connection, groupId, 0, 100);
  }

  /** One page of member tasks, read inside the caller's transaction. */
  public TaskGroupMemberPage listTaskGroupMembers(
      Connection connection, UUID groupId, long after, int limit) {
    return run(connection, call -> listTaskGroupMembers(call, groupId, after, limit));
  }

  private TaskGroupMemberPage listTaskGroupMembers(Call call, UUID groupId, long after, int limit) {
    if (limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new IllegalArgumentException(
          "list_task_group_members limit must be an Integer between 1 and " + MAX_PAGE_SIZE);
    }
    if (after < 0) {
      throw new IllegalArgumentException("after must be a non-negative Integer");
    }
    assertCompatible(call);
    return Rows.memberPage(call.connection, groupId, after, limit);
  }

  /** The group that {@code taskId} is a member of, or whose callback it is, or empty. */
  public Optional<TaskGroupLink> findTaskGroup(UUID taskId) {
    return run(null, call -> findTaskGroup(call, taskId));
  }

  /** The group of a task, read inside the caller's transaction. */
  public Optional<TaskGroupLink> findTaskGroup(Connection connection, UUID taskId) {
    return run(connection, call -> findTaskGroup(call, taskId));
  }

  private Optional<TaskGroupLink> findTaskGroup(Call call, UUID taskId) {
    assertCompatible(call);
    List<Row> rows =
        Sql.rows(call.connection, SqlCatalogue.TASK_GROUP_FOR_TASK_V1, taskId.toString());
    if (rows.isEmpty()) {
      return Optional.empty();
    }
    Row row = rows.get(0);
    String kind = row.text("callback_kind");
    return Optional.of(
        new TaskGroupLink(
            Rows.constant(TaskGroupRole.class, "task_group_role", row.requiredText("role")),
            kind == null
                ? null
                : Rows.constant(TaskGroupCallbackKind.class, "task_group_callback", kind),
            Rows.group(row)));
  }

  /**
   * Creates a group with {@code requests} as its member tasks, and seals it when {@code seal} is
   * true. A contract mismatch creates nothing, and the retry serializes the callbacks again.
   */
  private TaskGroupBlockResult createGroup(
      Call call, TaskGroupCallbacks callbacks, List<EnqueueRequest> requests, boolean seal) {
    Map<TaskGroupCallbackKind, EnqueueRequest> entries = callbackEntries(callbacks);
    for (EnqueueRequest request : entries.values()) {
      EnqueueOptions options = request.options();
      if (options.idempotency() != null
          || options.debounce() != null
          || options.throttle() != null) {
        throw new IllegalArgumentException(
            "task group callbacks cannot use enqueue idempotency, debounce, or throttle");
      }
    }
    List<Row> rows =
        submitRequests(
            call,
            requests,
            document ->
                Sql.rows(
                    call.connection,
                    SqlCatalogue.CREATE_TASK_GROUP_V1,
                    serializeCallbacks(call, entries),
                    document,
                    Boolean.toString(seal)));
    UUID groupId = rows.isEmpty() ? null : rows.get(0).uuid("group_id");
    if (groupId == null) {
      throw new WorkhorseException("PostgreSQL created no task group");
    }
    TaskGroup group =
        getTaskGroup(call, groupId)
            .orElseThrow(
                () ->
                    new WorkhorseException(
                        "Task group " + groupId + " disappeared after its creation"));
    List<Row> members = new ArrayList<>();
    for (Row row : rows) {
      if (row.text("ordinal") != null) {
        members.add(row);
      }
    }
    return new TaskGroupBlockResult(group, enqueueResults(members, requests.size()));
  }

  private static Map<TaskGroupCallbackKind, EnqueueRequest> callbackEntries(
      TaskGroupCallbacks callbacks) {
    Map<TaskGroupCallbackKind, EnqueueRequest> entries = new LinkedHashMap<>();
    if (callbacks.onFinish() != null) {
      entries.put(TaskGroupCallbackKind.ON_FINISH, callbacks.onFinish());
    }
    if (callbacks.onSuccess() != null) {
      entries.put(TaskGroupCallbackKind.ON_SUCCESS, callbacks.onSuccess());
    }
    if (callbacks.onFailure() != null) {
      entries.put(TaskGroupCallbackKind.ON_FAILURE, callbacks.onFailure());
    }
    return entries;
  }

  /** The callback document. A callback carries no run time unless the caller set one. */
  private String serializeCallbacks(Call call, Map<TaskGroupCallbackKind, EnqueueRequest> entries) {
    Instant now = Instant.now();
    Map<String, @Nullable Object> trace = traceContext();
    Map<String, @Nullable Object> document = new LinkedHashMap<>();
    for (Map.Entry<TaskGroupCallbackKind, EnqueueRequest> entry : entries.entrySet()) {
      EnqueueRequest request = entry.getValue();
      String label = entry.getKey().name().toLowerCase(Locale.ROOT);
      Map<String, @Nullable Object> input;
      try {
        input = serializeRequest(request, now);
      } catch (IllegalArgumentException error) {
        throw new IllegalArgumentException(label + " callback: " + error.getMessage(), error);
      }
      if (request.options().runAt() == null) {
        input.remove("runAt");
      }
      if (trace != null) {
        input.put("traceContext", trace);
      }
      applyContract(call, input, request.taskType());
      document.put(callbackKey(entry.getKey()), input);
    }
    return Json.write(document);
  }

  private static String callbackKey(TaskGroupCallbackKind kind) {
    return switch (kind) {
      case ON_FINISH -> "onFinish";
      case ON_SUCCESS -> "onSuccess";
      case ON_FAILURE -> "onFailure";
    };
  }

  private List<EnqueueResult> addTaskGroupMembers(
      Call call, UUID groupId, List<EnqueueRequest> requests, List<@Nullable String> member) {
    validateGroupAdd(requests);
    if (requests.isEmpty()) {
      return List.of();
    }
    List<Row> rows =
        submitRequests(
            call,
            requests,
            document ->
                Sql.rows(
                    call.connection,
                    SqlCatalogue.ADD_TASK_GROUP_MEMBERS_V1,
                    groupId.toString(),
                    document,
                    member.get(0),
                    member.get(1),
                    member.get(2)));
    return enqueueResults(rows, requests.size());
  }

  // ---------------------------------------------------------------------------------------------
  // Handler context (SM-1387)

  /** The task ID, worker ID, and fence token of no member task. */
  private static final List<@Nullable String> NO_MEMBER = Arrays.asList(null, null, null);

  /**
   * The contract version and the queue that a stored child was created under. A {@code null}
   * version stamps no contract.
   */
  record ChildVersion(@Nullable String version, @Nullable String queue) {}

  /**
   * Adds {@code requests} to the group of {@code task}, a running member task, under its fenced
   * lease. A request with no queue goes to the queue of {@code task}, as in the other SDKs. The
   * counterpart of Ruby's {@code Queue#add_to_task_group_as_member}.
   */
  List<EnqueueResult> addToTaskGroupAsMember(
      ClaimedTask task, String workerId, List<EnqueueRequest> requests) {
    return run(
        null,
        call -> {
          validateGroupAdd(requests);
          Optional<TaskGroupLink> link = findTaskGroup(call, task.id());
          if (link.isEmpty() || link.get().role() != TaskGroupRole.MEMBER) {
            throw new IllegalArgumentException(
                "Task " + task.id() + " is not a member of a task group");
          }
          List<EnqueueRequest> routed = new ArrayList<>(requests.size());
          for (EnqueueRequest request : requests) {
            String named = request.options().queue();
            routed.add(
                named == null || named.isEmpty()
                    ? new EnqueueRequest(
                        request.taskType(),
                        request.payload(),
                        request.options().toBuilder().queue(task.queue()).build())
                    : request);
          }
          return addTaskGroupMembers(
              call,
              link.get().group().id(),
              routed,
              Arrays.asList(task.id().toString(), workerId, Long.toString(task.fenceToken())));
        });
  }

  /**
   * The {@code create_child_v2} request for one child of {@code parent}. The counterpart of Ruby's
   * {@code Queue#serialize_child_request}.
   *
   * <p>A child inherits the trace context of {@code parent}, and takes no coalescing or dependency
   * option. A request with no queue runs on the stored queue of the child, or else on the queue of
   * {@code parent}. A contracted child carries the contract PostgreSQL holds now, because a child
   * write has no stale-contract retry. A {@code stored} child stamps the version it was created
   * under instead. {@code contracts} caches those loads across one child set.
   */
  Map<String, @Nullable Object> serializeChildRequest(
      Connection connection,
      ClaimedTask parent,
      String taskType,
      @Nullable Object payload,
      EnqueueOptions options,
      Map<String, @Nullable PayloadContract> contracts,
      @Nullable ChildVersion stored) {
    if (options.idempotency() != null
        || options.debounce() != null
        || options.throttle() != null
        || options.dependencies() != null) {
      throw new IllegalArgumentException(
          "Child tasks cannot use coalescing or dependency enqueue options");
    }
    Map<String, @Nullable Object> input =
        taskInput(
            taskType,
            payload,
            options.queue(),
            options.priority() == null ? 0 : options.priority(),
            options.concurrencyKey(),
            options.maxAttempts(),
            options.retryPolicy());
    if (options.queue() == null || options.queue().isEmpty()) {
      String storedQueue = stored == null ? null : stored.queue();
      input.put("queue", storedQueue == null ? parent.queue() : storedQueue);
    }
    Instant deadline = options.deadline();
    input.put("deadline", deadline == null ? null : Values.timestamp(deadline));
    input.put("budget", optionalBytes(options.budget(), MAX_NAME_BYTES, "budget"));
    input.put("executionTimeoutMs", executionTimeout(options.executionTimeout()));
    input.put("prerequisiteTaskId", null);
    input.put("dependencies", null);
    input.put("tags", tags(options.tags()));
    if (parent.traceContext() != null) {
      input.put("traceContext", parent.traceContext());
    }
    Instant runAt = options.runAt();
    if (runAt != null) {
      input.put("runAt", Values.timestamp(runAt));
    }
    String key =
        stored == null ? "current:" + taskType : "stored:" + taskType + ":" + stored.version();
    PayloadContract contract;
    if (contracts.containsKey(key)) {
      contract = contracts.get(key);
    } else if (stored != null) {
      String version = stored.version();
      contract =
          version == null
              ? null
              : Worker.withDeferredInterrupt(() -> Contracts.load(connection, taskType, version));
      contracts.put(key, contract);
    } else {
      contract = Worker.withDeferredInterrupt(() -> Contracts.load(connection, taskType, null));
      contracts.put(key, contract);
      lock.lock();
      try {
        this.contracts.put(taskType, contract);
      } finally {
        lock.unlock();
      }
    }
    stampContract(input, taskType, contract);
    return input;
  }

  /** Throws {@link IllegalArgumentException} for an add that PostgreSQL would refuse. */
  static void validateGroupAdd(List<EnqueueRequest> requests) {
    if (requests.size() > SqlCatalogue.MAX_ENQUEUE_BATCH_SIZE) {
      throw new IllegalArgumentException(
          "a task group add accepts at most " + SqlCatalogue.MAX_ENQUEUE_BATCH_SIZE + " tasks");
    }
    for (EnqueueRequest request : requests) {
      if (request.options().debounce() != null || request.options().throttle() != null) {
        throw new IllegalArgumentException("a task group add cannot use debounce or throttle");
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Controls

  /**
   * Requests cancellation. An active task stops at its next PostgreSQL-owned checkpoint.
   *
   * @param requestedBy who requests cancellation, or {@code null}
   * @param reason why, or {@code null}
   */
  public CancelResult cancel(UUID taskId, @Nullable String requestedBy, @Nullable String reason) {
    return run(null, call -> cancel(call, taskId, requestedBy, reason));
  }

  /** Requests cancellation inside the caller's transaction. */
  public CancelResult cancel(
      Connection connection, UUID taskId, @Nullable String requestedBy, @Nullable String reason) {
    return run(connection, call -> cancel(call, taskId, requestedBy, reason));
  }

  private CancelResult cancel(
      Call call, UUID taskId, @Nullable String requestedBy, @Nullable String reason) {
    assertCompatible(call);
    Row row =
        Rows.exactlyOne(
            Sql.rows(
                call.connection, SqlCatalogue.CANCEL_V1, taskId.toString(), requestedBy, reason),
            "cancel_v1");
    String state = row.text("state");
    return new CancelResult(
        Rows.constant(CancelStatus.class, "cancel", row.requiredText("status")),
        taskId,
        state == null ? null : Rows.constant(TaskState.class, "cancel", state),
        row.integer("current_attempt"),
        row.instant("requested_at"),
        row.text("requested_by"),
        row.text("reason"),
        row.instant("finished_at"));
  }

  /**
   * Delivers a named signal to a task that waits for it.
   *
   * @param name the signal name, 1 to 200 characters without surrounding whitespace
   * @param payload the JSON payload, at most 65,536 bytes of JSON
   * @param idempotencyKey 1 to 512 UTF-8 bytes
   * @param requestedBy 1 to 200 characters
   * @throws SignalIdempotencyConflictException if the key was retained for a different request
   */
  public SignalDeliveryResult sendSignal(
      UUID taskId,
      String name,
      @Nullable Object payload,
      String idempotencyKey,
      String requestedBy) {
    return run(null, call -> sendSignal(call, taskId, name, payload, idempotencyKey, requestedBy));
  }

  /** Delivers a named signal inside the caller's transaction. */
  public SignalDeliveryResult sendSignal(
      Connection connection,
      UUID taskId,
      String name,
      @Nullable Object payload,
      String idempotencyKey,
      String requestedBy) {
    return run(
        connection, call -> sendSignal(call, taskId, name, payload, idempotencyKey, requestedBy));
  }

  private SignalDeliveryResult sendSignal(
      Call call,
      UUID taskId,
      String name,
      @Nullable Object payload,
      String idempotencyKey,
      String requestedBy) {
    String document =
        validateDelivery("signal", "signal payload", name, payload, idempotencyKey, requestedBy);
    assertCompatible(call);
    Row row =
        Rows.exactlyOne(
            Sql.rows(
                call.connection,
                SqlCatalogue.SEND_SIGNAL_V1,
                taskId.toString(),
                name,
                document,
                idempotencyKey,
                requestedBy),
            "send_signal_v1");
    if ("conflict".equals(row.text("status"))) {
      throw new SignalIdempotencyConflictException(taskId, name);
    }
    processed(
        "workhorse.task.signal_processed",
        "Task signal processed",
        taskId,
        Names.SIGNAL_NAME,
        name,
        Names.SIGNAL_STATUS,
        row.text("status"));
    return new SignalDeliveryResult(
        Rows.constant(SignalStatus.class, "send_signal", row.requiredText("status")),
        taskId,
        name,
        decode(row.text("payload")),
        row.instant("delivered_at"),
        row.text("delivered_by"));
  }

  /**
   * Records a human decision for a task that waits for it.
   *
   * @param name the wait name, 1 to 200 characters without surrounding whitespace
   * @param result the JSON decision, at most 65,536 bytes of JSON
   * @param idempotencyKey 1 to 512 UTF-8 bytes
   * @param requestedBy 1 to 200 characters
   * @throws HumanWaitIdempotencyConflictException if the key was retained for a different decision
   */
  public HumanWaitCompletionResult completeHumanWait(
      UUID taskId,
      String name,
      @Nullable Object result,
      String idempotencyKey,
      String requestedBy) {
    return run(
        null, call -> completeHumanWait(call, taskId, name, result, idempotencyKey, requestedBy));
  }

  /** Records a human decision inside the caller's transaction. */
  public HumanWaitCompletionResult completeHumanWait(
      Connection connection,
      UUID taskId,
      String name,
      @Nullable Object result,
      String idempotencyKey,
      String requestedBy) {
    return run(
        connection,
        call -> completeHumanWait(call, taskId, name, result, idempotencyKey, requestedBy));
  }

  private HumanWaitCompletionResult completeHumanWait(
      Call call,
      UUID taskId,
      String name,
      @Nullable Object result,
      String idempotencyKey,
      String requestedBy) {
    String document =
        validateDelivery(
            "human wait", "human wait result", name, result, idempotencyKey, requestedBy);
    assertCompatible(call);
    Row row =
        Rows.exactlyOne(
            Sql.rows(
                call.connection,
                SqlCatalogue.COMPLETE_HUMAN_WAIT_V1,
                taskId.toString(),
                name,
                document,
                idempotencyKey,
                requestedBy),
            "complete_human_wait_v1");
    if ("conflict".equals(row.text("status"))) {
      throw new HumanWaitIdempotencyConflictException(taskId, name);
    }
    processed(
        "workhorse.task.human_wait_processed",
        "Human wait completion processed",
        taskId,
        Names.HUMAN_WAIT_NAME,
        name,
        Names.HUMAN_WAIT_STATUS,
        row.text("status"));
    return new HumanWaitCompletionResult(
        Rows.constant(HumanWaitStatus.class, "complete_human_wait", row.requiredText("status")),
        taskId,
        name,
        decode(row.text("result")),
        row.instant("completed_at"),
        row.text("completed_by"));
  }

  private String validateDelivery(
      String label,
      String valueLabel,
      String name,
      @Nullable Object value,
      String idempotencyKey,
      String requestedBy) {
    int length = name.codePointCount(0, name.length());
    if (length < 1
        || length > 200
        || WHITESPACE.indexOf(name.charAt(0)) >= 0
        || WHITESPACE.indexOf(name.charAt(name.length() - 1)) >= 0) {
      throw new IllegalArgumentException(
          label + " name must contain between 1 and 200 characters without surrounding whitespace");
    }
    String document = Json.write(tree(value, valueLabel));
    if (bytes(document) > MAX_EXTERNAL_VALUE_BYTES) {
      throw new IllegalArgumentException(valueLabel + " must be at most 65536 bytes of JSON");
    }
    int keyBytes = bytes(idempotencyKey);
    if (keyBytes < 1 || keyBytes > MAX_KEY_BYTES) {
      throw new IllegalArgumentException(
          label + " idempotency key must contain between 1 and 512 UTF-8 bytes");
    }
    int requestedLength = requestedBy.codePointCount(0, requestedBy.length());
    if (requestedLength < 1 || requestedLength > 200) {
      throw new IllegalArgumentException(
          label + " requested by must contain between 1 and 200 characters");
    }
    return document;
  }

  /**
   * Emits the info log record of one external delivery, as the TypeScript queue does. The queue
   * writes it only to OpenTelemetry. It never carries the payload or the idempotency key.
   */
  private void processed(
      String event,
      String body,
      UUID taskId,
      String nameKey,
      String name,
      String statusKey,
      @Nullable String status) {
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    attributes.put(Names.TASK_ID, taskId.toString());
    attributes.put(nameKey, name);
    attributes.put(statusKey, status);
    telemetry.log(Telemetry.Severity.INFO, event, body, attributes);
  }

  /** PostgreSQL's queue health snapshot over the last day. */
  public QueueHealth health() {
    return run(null, this::health);
  }

  /** The queue health snapshot, read inside the caller's transaction. */
  public QueueHealth health(Connection connection) {
    return run(connection, this::health);
  }

  private QueueHealth health(Call call) {
    assertCompatible(call);
    String since = Values.timestamp(Instant.now().minus(Duration.ofDays(1)));
    Row row =
        Rows.exactlyOne(
            Sql.rows(call.connection, SqlCatalogue.QUEUE_HEALTH_V1, since), "queue_health_v1");
    Map<String, @Nullable Object> snapshot = Json.object(row.json("snapshot"));
    if (snapshot == null) {
      throw new WorkhorseException("workhorse.queue_health_v1 returned a non-object snapshot");
    }
    return new QueueHealth(snapshot);
  }

  // ---------------------------------------------------------------------------------------------
  // Schedules and contracts

  /** Makes {@code schedules} the namespace's schedules, and removes the namespace's others. */
  public void syncSchedules(String namespace, List<ScheduleDefinition> schedules) {
    syncSchedules(namespace, schedules, true);
  }

  /**
   * Makes {@code schedules} the namespace's schedules.
   *
   * @param prune whether to remove the namespace's other schedules
   */
  public void syncSchedules(String namespace, List<ScheduleDefinition> schedules, boolean prune) {
    run(null, call -> syncSchedules(call, namespace, schedules, prune));
  }

  /** Syncs schedules inside the caller's transaction, and removes the namespace's others. */
  public void syncSchedules(
      Connection connection, String namespace, List<ScheduleDefinition> schedules) {
    syncSchedules(connection, namespace, schedules, true);
  }

  /** Syncs schedules inside the caller's transaction. */
  public void syncSchedules(
      Connection connection, String namespace, List<ScheduleDefinition> schedules, boolean prune) {
    run(connection, call -> syncSchedules(call, namespace, schedules, prune));
  }

  private @Nullable Void syncSchedules(
      Call call, String namespace, List<ScheduleDefinition> schedules, boolean prune) {
    requiredString(namespace, "namespace");
    List<Map<String, @Nullable Object>> document = new ArrayList<>();
    for (int index = 0; index < schedules.size(); index++) {
      try {
        document.add(scheduleDocument(schedules.get(index)));
      } catch (IllegalArgumentException error) {
        throw new IllegalArgumentException(
            "schedule definition "
                + (index + 1)
                + ": invalid schedule definition: "
                + error.getMessage(),
            error);
      }
    }
    assertCompatible(call);
    // Each type's current contract comes from PostgreSQL, not the cache: firing an occurrence
    // never checks the contract policy, so a stale version would persist on every occurrence.
    Map<String, Optional<PayloadContract>> loaded = new HashMap<>();
    for (int index = 0; index < schedules.size(); index++) {
      ScheduledTask task = schedules.get(index).task();
      Optional<PayloadContract> contract =
          loaded.computeIfAbsent(
              task.taskType(),
              type -> Optional.ofNullable(Contracts.load(call.connection, type, null)));
      stampContract(document.get(index), task.taskType(), contract.orElse(null));
    }
    Sql.rows(
        call.connection,
        SqlCatalogue.SYNC_SCHEDULE_DEFINITIONS_V2,
        namespace,
        Json.write(document),
        Boolean.toString(prune));
    return null;
  }

  private Map<String, @Nullable Object> scheduleDocument(ScheduleDefinition definition) {
    ScheduledTask task = definition.task();
    Map<String, @Nullable Object> input =
        taskInput(
            task.taskType(),
            task.payload(),
            task.queue(),
            task.priority(),
            task.concurrencyKey(),
            task.maxAttempts(),
            task.retryPolicy());
    input.put("name", requiredString(definition.name(), "name"));
    input.put("schedule", requiredString(definition.schedule(), "schedule"));
    input.put("timezone", requiredString(definition.timezone(), "timezone"));
    input.put("catchupPolicy", wire(definition.catchupPolicy()));
    input.put("enabled", definition.enabled());
    return input;
  }

  /**
   * Makes {@code contracts}, keyed by task type, PostgreSQL's contract definitions, and validates
   * later enqueues against them.
   *
   * @throws IllegalArgumentException if a schema is outside the Workhorse contract profile
   */
  public void syncContracts(Map<String, TaskTypeContracts> contracts) {
    run(null, call -> syncContracts(call, contracts));
  }

  /** Syncs contract definitions inside the caller's transaction. */
  public void syncContracts(Connection connection, Map<String, TaskTypeContracts> contracts) {
    run(connection, call -> syncContracts(call, contracts));
  }

  private @Nullable Void syncContracts(Call call, Map<String, TaskTypeContracts> definitions) {
    String document = Json.write(Contracts.document(definitions, this::schemaTree));
    assertCompatible(call);
    Sql.rows(call.connection, SqlCatalogue.SYNC_CONTRACT_DEFINITIONS_V1, document);
    lock.lock();
    try {
      contracts.clear();
      contractsEnabled = true;
    } finally {
      lock.unlock();
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Policies and budgets

  /** Makes {@code definitions} the namespace's concurrency policies, and removes its others. */
  public List<ConcurrencyPolicy> syncConcurrencyPolicies(
      String namespace, List<ConcurrencyPolicyDefinition> definitions) {
    return syncConcurrencyPolicies(namespace, definitions, true);
  }

  /**
   * Makes {@code definitions} the namespace's concurrency policies, and returns the stored
   * policies.
   *
   * @param prune whether to remove the namespace's other policies
   */
  public List<ConcurrencyPolicy> syncConcurrencyPolicies(
      String namespace, List<ConcurrencyPolicyDefinition> definitions, boolean prune) {
    return run(null, call -> syncConcurrencyPolicies(call, namespace, definitions, prune));
  }

  /** Syncs concurrency policies inside the caller's transaction, and removes the others. */
  public List<ConcurrencyPolicy> syncConcurrencyPolicies(
      Connection connection, String namespace, List<ConcurrencyPolicyDefinition> definitions) {
    return syncConcurrencyPolicies(connection, namespace, definitions, true);
  }

  /** Syncs concurrency policies inside the caller's transaction. */
  public List<ConcurrencyPolicy> syncConcurrencyPolicies(
      Connection connection,
      String namespace,
      List<ConcurrencyPolicyDefinition> definitions,
      boolean prune) {
    return run(connection, call -> syncConcurrencyPolicies(call, namespace, definitions, prune));
  }

  private List<ConcurrencyPolicy> syncConcurrencyPolicies(
      Call call, String namespace, List<ConcurrencyPolicyDefinition> definitions, boolean prune) {
    String document =
        syncDocument(
            definitions,
            "concurrency policy",
            "queue",
            ConcurrencyPolicyDefinition::queue,
            definition -> {
              int maxActive = range(definition.maxActive(), 1, MAX_POLICY_VALUE, "max active");
              Integer perKey = definition.maxActivePerKey();
              Map<String, @Nullable Object> item = new LinkedHashMap<>();
              item.put("queue", definition.queue());
              item.put("maxActive", maxActive);
              item.put(
                  "maxActivePerKey",
                  perKey == null ? null : range(perKey, 1, maxActive, "max active per key"));
              return item;
            });
    requiredBytes(namespace, MAX_NAME_BYTES, "namespace");
    assertCompatible(call);
    List<Row> rows =
        Sql.fencedRows(
            call.connection,
            SqlCatalogue.SYNC_CONCURRENCY_POLICIES_V1,
            namespace,
            document,
            Boolean.toString(prune));
    return rows.stream().map(Queue::concurrencyPolicy).toList();
  }

  /** Makes {@code definitions} the namespace's rate limit policies, and removes its others. */
  public List<RateLimitPolicy> syncRateLimitPolicies(
      String namespace, List<RateLimitPolicyDefinition> definitions) {
    return syncRateLimitPolicies(namespace, definitions, true);
  }

  /**
   * Makes {@code definitions} the namespace's rate limit policies, and returns the stored policies.
   *
   * @param prune whether to remove the namespace's other policies
   */
  public List<RateLimitPolicy> syncRateLimitPolicies(
      String namespace, List<RateLimitPolicyDefinition> definitions, boolean prune) {
    return run(null, call -> syncRateLimitPolicies(call, namespace, definitions, prune));
  }

  /** Syncs rate limit policies inside the caller's transaction, and removes the others. */
  public List<RateLimitPolicy> syncRateLimitPolicies(
      Connection connection, String namespace, List<RateLimitPolicyDefinition> definitions) {
    return syncRateLimitPolicies(connection, namespace, definitions, true);
  }

  /** Syncs rate limit policies inside the caller's transaction. */
  public List<RateLimitPolicy> syncRateLimitPolicies(
      Connection connection,
      String namespace,
      List<RateLimitPolicyDefinition> definitions,
      boolean prune) {
    return run(connection, call -> syncRateLimitPolicies(call, namespace, definitions, prune));
  }

  private List<RateLimitPolicy> syncRateLimitPolicies(
      Call call, String namespace, List<RateLimitPolicyDefinition> definitions, boolean prune) {
    String document =
        syncDocument(
            definitions,
            "rate limit policy",
            "queue",
            RateLimitPolicyDefinition::queue,
            definition -> {
              Map<String, @Nullable Object> item = new LinkedHashMap<>();
              item.put("queue", definition.queue());
              item.put("rate", rateLimitDocument(definition.rate(), "rate"));
              RateLimit perKey = definition.perKey();
              item.put("perKey", perKey == null ? null : rateLimitDocument(perKey, "per key"));
              return item;
            });
    requiredBytes(namespace, MAX_NAME_BYTES, "namespace");
    assertCompatible(call);
    List<Row> rows =
        Sql.rows(
            call.connection,
            SqlCatalogue.SYNC_RATE_LIMIT_POLICIES_V1,
            namespace,
            document,
            Boolean.toString(prune));
    return rows.stream().map(Queue::rateLimitPolicy).toList();
  }

  /** Makes {@code definitions} the namespace's budgets, and removes its others. */
  public List<Budget> syncBudgets(String namespace, List<BudgetDefinition> definitions) {
    return syncBudgets(namespace, definitions, true);
  }

  /**
   * Makes {@code definitions} the namespace's budgets, and returns the stored budgets.
   *
   * @param prune whether to remove the namespace's other budgets
   */
  public List<Budget> syncBudgets(
      String namespace, List<BudgetDefinition> definitions, boolean prune) {
    return run(null, call -> syncBudgets(call, namespace, definitions, prune));
  }

  /** Syncs budgets inside the caller's transaction, and removes the others. */
  public List<Budget> syncBudgets(
      Connection connection, String namespace, List<BudgetDefinition> definitions) {
    return syncBudgets(connection, namespace, definitions, true);
  }

  /** Syncs budgets inside the caller's transaction. */
  public List<Budget> syncBudgets(
      Connection connection, String namespace, List<BudgetDefinition> definitions, boolean prune) {
    return run(connection, call -> syncBudgets(call, namespace, definitions, prune));
  }

  private List<Budget> syncBudgets(
      Call call, String namespace, List<BudgetDefinition> definitions, boolean prune) {
    String document =
        syncDocument(
            definitions,
            "budget",
            "name",
            BudgetDefinition::name,
            definition -> {
              if (definition.maxActive() == null && definition.rate() == null) {
                throw new IllegalArgumentException("budget requires max active, rate, or both");
              }
              Integer maxActive = definition.maxActive();
              RateLimit rate = definition.rate();
              Map<String, @Nullable Object> item = new LinkedHashMap<>();
              item.put("name", definition.name());
              item.put(
                  "maxActive",
                  maxActive == null ? null : range(maxActive, 1, MAX_POLICY_VALUE, "max active"));
              item.put("rate", rate == null ? null : rateLimitDocument(rate, "rate"));
              return item;
            });
    requiredBytes(namespace, MAX_NAME_BYTES, "namespace");
    assertCompatible(call);
    List<Row> rows =
        Sql.rows(
            call.connection,
            SqlCatalogue.SYNC_BUDGETS_V1,
            namespace,
            document,
            Boolean.toString(prune));
    return rows.stream().map(Queue::budget).toList();
  }

  /** The concurrency policies of every queue. */
  public List<ConcurrencyPolicy> listConcurrencyPolicies() {
    return listConcurrencyPolicies(List.of());
  }

  /** The concurrency policies of {@code queues}, or of every queue when it is empty. */
  public List<ConcurrencyPolicy> listConcurrencyPolicies(List<String> queues) {
    Objects.requireNonNull(queues, "queues");
    return run(null, call -> listConcurrencyPolicies(call, queues));
  }

  /** The concurrency policies of every queue, read inside the caller's transaction. */
  public List<ConcurrencyPolicy> listConcurrencyPolicies(Connection connection) {
    return listConcurrencyPolicies(connection, List.of());
  }

  /**
   * The concurrency policies of {@code queues}, or of every queue when it is empty, read inside the
   * caller's transaction.
   */
  public List<ConcurrencyPolicy> listConcurrencyPolicies(
      Connection connection, List<String> queues) {
    Objects.requireNonNull(queues, "queues");
    return run(connection, call -> listConcurrencyPolicies(call, queues));
  }

  private List<ConcurrencyPolicy> listConcurrencyPolicies(Call call, List<String> queues) {
    return list(call, SqlCatalogue.LIST_CONCURRENCY_POLICIES, queues).stream()
        .map(Queue::concurrencyPolicy)
        .toList();
  }

  /** The rate limit policies of every queue. */
  public List<RateLimitPolicy> listRateLimitPolicies() {
    return listRateLimitPolicies(List.of());
  }

  /** The rate limit policies of {@code queues}, or of every queue when it is empty. */
  public List<RateLimitPolicy> listRateLimitPolicies(List<String> queues) {
    Objects.requireNonNull(queues, "queues");
    return run(null, call -> listRateLimitPolicies(call, queues));
  }

  /** The rate limit policies of every queue, read inside the caller's transaction. */
  public List<RateLimitPolicy> listRateLimitPolicies(Connection connection) {
    return listRateLimitPolicies(connection, List.of());
  }

  /**
   * The rate limit policies of {@code queues}, or of every queue when it is empty, read inside the
   * caller's transaction.
   */
  public List<RateLimitPolicy> listRateLimitPolicies(Connection connection, List<String> queues) {
    Objects.requireNonNull(queues, "queues");
    return run(connection, call -> listRateLimitPolicies(call, queues));
  }

  private List<RateLimitPolicy> listRateLimitPolicies(Call call, List<String> queues) {
    return list(call, SqlCatalogue.LIST_RATE_LIMIT_POLICIES, queues).stream()
        .map(Queue::rateLimitPolicy)
        .toList();
  }

  /** Every budget. */
  public List<Budget> listBudgets() {
    return listBudgets(List.of());
  }

  /** The budgets named in {@code names}, or every budget when it is empty. */
  public List<Budget> listBudgets(List<String> names) {
    Objects.requireNonNull(names, "names");
    return run(null, call -> listBudgets(call, names));
  }

  /** Every budget, read inside the caller's transaction. */
  public List<Budget> listBudgets(Connection connection) {
    return listBudgets(connection, List.of());
  }

  /**
   * The budgets named in {@code names}, or every budget when it is empty, read inside the caller's
   * transaction.
   */
  public List<Budget> listBudgets(Connection connection, List<String> names) {
    Objects.requireNonNull(names, "names");
    return run(connection, call -> listBudgets(call, names));
  }

  private List<Budget> listBudgets(Call call, List<String> names) {
    return list(call, SqlCatalogue.LIST_BUDGETS, names).stream().map(Queue::budget).toList();
  }

  private List<Row> list(Call call, SqlCatalogue.Statement statement, List<String> names) {
    String[] array = Sql.textArray(names);
    assertCompatible(call);
    return Sql.rows(call.connection, statement, (Object) array);
  }

  private static ConcurrencyPolicy concurrencyPolicy(Row row) {
    return new ConcurrencyPolicy(
        row.requiredText("namespace"),
        row.requiredText("queue_name"),
        row.requiredInteger("max_active"),
        row.integer("max_active_per_key"),
        row.requiredInstant("updated_at"));
  }

  private static RateLimitPolicy rateLimitPolicy(Row row) {
    RateLimit rate = rateLimit(row, "rate_", "rate_limit");
    if (rate == null) {
      throw new WorkhorseException("PostgreSQL returned a rate limit policy without a rate");
    }
    return new RateLimitPolicy(
        row.requiredText("namespace"),
        row.requiredText("queue_name"),
        rate,
        rateLimit(row, "per_key_", "per_key_limit"),
        row.requiredInstant("updated_at"));
  }

  private static Budget budget(Row row) {
    return new Budget(
        row.requiredText("namespace"),
        row.requiredText("budget_name"),
        row.integer("max_active"),
        rateLimit(row, "rate_", "rate_limit"),
        row.requiredInstant("updated_at"));
  }

  /** The rate limit whose columns share {@code prefix}, or null when its limit is null. */
  private static @Nullable RateLimit rateLimit(Row row, String prefix, String limitColumn) {
    Integer limit = row.integer(limitColumn);
    if (limit == null) {
      return null;
    }
    return new RateLimit(
        limit,
        Values.duration(row.requiredLong(prefix + "interval_ms")),
        row.requiredInteger(prefix + "burst"));
  }

  private interface Encoder<T> {
    Map<String, @Nullable Object> encode(T definition);
  }

  /** The JSON array a policy sync sends. Each definition's name must be unique. */
  private static <T> String syncDocument(
      List<T> definitions,
      String label,
      String nameLabel,
      Function<T, String> name,
      Encoder<T> encoder) {
    if (definitions.size() > MAX_POLICY_DEFINITIONS) {
      throw new IllegalArgumentException(
          label + " definitions exceed the limit of " + MAX_POLICY_DEFINITIONS);
    }
    List<Map<String, @Nullable Object>> document = new ArrayList<>();
    Set<String> names = new HashSet<>();
    boolean unique = true;
    for (int index = 0; index < definitions.size(); index++) {
      T definition = definitions.get(index);
      try {
        requiredBytes(name.apply(definition), MAX_NAME_BYTES, nameLabel);
        document.add(encoder.encode(definition));
      } catch (IllegalArgumentException error) {
        throw new IllegalArgumentException(
            label + " definition " + (index + 1) + ": " + error.getMessage(), error);
      }
      unique &= names.add(name.apply(definition));
    }
    if (!unique) {
      throw new IllegalArgumentException(label + " " + nameLabel + " names must be unique");
    }
    return Json.write(document);
  }

  private static Map<String, @Nullable Object> rateLimitDocument(RateLimit rate, String label) {
    Map<String, @Nullable Object> document = new LinkedHashMap<>();
    document.put("limit", range(rate.limit(), 1, MAX_POLICY_VALUE, label + " limit"));
    document.put(
        "intervalMs",
        Values.milliseconds(rate.interval(), label + " interval", 1, MAX_RATE_INTERVAL_MS));
    document.put("burst", range(rate.burst(), 1, MAX_POLICY_VALUE, label + " burst"));
    return document;
  }

  // ---------------------------------------------------------------------------------------------
  // Request serialization

  /**
   * Serializes {@code requests}, passes their JSON document to {@code statement}, and returns its
   * rows. On a contract mismatch, PostgreSQL enqueued nothing: the queue reloads the named
   * contracts and runs the statement one more time.
   */
  private List<Row> submitRequests(
      Call call, List<EnqueueRequest> requests, Function<String, List<Row>> statement) {
    for (int attempt = 0; attempt < 2; attempt++) {
      List<Row> rows = statement.apply(serializeRequests(call, requests));
      List<String> taskTypes = contractMismatch(rows);
      if (taskTypes == null) {
        return rows;
      }
      for (String taskType : taskTypes) {
        remember(call, taskType, Contracts.load(call.connection, taskType, null));
      }
    }
    throw new ContractPolicyChangedException();
  }

  private String serializeRequests(Call call, List<EnqueueRequest> requests) {
    Instant now = Instant.now();
    Map<String, @Nullable Object> trace = traceContext();
    List<Map<String, @Nullable Object>> inputs = new ArrayList<>();
    for (int index = 0; index < requests.size(); index++) {
      try {
        Map<String, @Nullable Object> input = serializeRequest(requests.get(index), now);
        if (trace != null) {
          input.put("traceContext", trace);
        }
        inputs.add(input);
      } catch (IllegalArgumentException error) {
        throw new IllegalArgumentException(
            "enqueue request " + (index + 1) + ": " + error.getMessage(), error);
      }
    }
    assertCompatible(call);
    for (int index = 0; index < requests.size(); index++) {
      applyContract(call, inputs.get(index), requests.get(index).taskType());
    }
    return Json.write(inputs);
  }

  /**
   * The W3C trace context of the current span, which each enqueued task carries, or {@code null}
   * without OpenTelemetry or without a valid current span.
   */
  @Nullable Map<String, @Nullable Object> traceContext() {
    Map<String, String> carrier = telemetry.injectTraceContext();
    return carrier == null ? null : new LinkedHashMap<>(carrier);
  }

  private Map<String, @Nullable Object> serializeRequest(EnqueueRequest request, Instant now) {
    EnqueueOptions options = request.options();
    try {
      validateOptions(options);
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException("invalid enqueue options: " + error.getMessage(), error);
    }
    Map<String, @Nullable Object> input =
        taskInput(
            request.taskType(),
            request.payload(),
            options.queue(),
            options.priority() == null ? 0 : options.priority(),
            options.concurrencyKey(),
            options.maxAttempts(),
            options.retryPolicy());
    boolean keyed =
        options.idempotency() != null || options.debounce() != null || options.throttle() != null;
    Instant runAt = options.runAt();
    if (runAt != null || !keyed) {
      input.put("runAt", Values.timestamp(runAt == null ? now : runAt));
    }
    Instant deadline = options.deadline();
    input.put("deadline", deadline == null ? null : Values.timestamp(deadline));
    input.put("budget", optionalBytes(options.budget(), MAX_NAME_BYTES, "budget"));
    input.put("executionTimeoutMs", executionTimeout(options.executionTimeout()));
    input.put("prerequisiteTaskId", null);
    Dependencies dependencies = options.dependencies();
    input.put("dependencies", dependencies == null ? null : dependenciesDocument(dependencies));
    input.put("tags", tags(options.tags()));
    if (options.idempotency() != null) {
      input.put("idempotency", idempotencyDocument(options.idempotency()));
    }
    if (options.debounce() != null) {
      input.put("debounce", debounceDocument(options.debounce()));
    }
    if (options.throttle() != null) {
      input.put("throttle", throttleDocument(options.throttle()));
    }
    return input;
  }

  private static void validateOptions(EnqueueOptions options) {
    int keyed =
        (options.idempotency() == null ? 0 : 1)
            + (options.debounce() == null ? 0 : 1)
            + (options.throttle() == null ? 0 : 1);
    if (keyed > 1) {
      throw new IllegalArgumentException("cannot combine idempotency, debounce, or throttle");
    }
    if (options.debounce() != null && options.runAt() != null) {
      throw new IllegalArgumentException(
          "debounced enqueue uses its PostgreSQL-owned window instead of run at");
    }
    Dependencies dependencies = options.dependencies();
    if (dependencies == null) {
      return;
    }
    if (options.debounce() != null || options.throttle() != null) {
      throw new IllegalArgumentException("cannot combine debounce or throttle with dependencies");
    }
    List<UUID> ids = dependencies.prerequisiteTaskIds();
    if (ids.isEmpty() || new HashSet<>(ids).size() != ids.size()) {
      throw new IllegalArgumentException("dependencies must contain unique prerequisite task IDs");
    }
    if (ids.size() > MAX_TASK_DEPENDENCIES) {
      throw new IllegalArgumentException("dependencies accepts at most 100 prerequisite task IDs");
    }
  }

  /** The fields that an enqueued task and a scheduled task share. */
  private Map<String, @Nullable Object> taskInput(
      String taskType,
      @Nullable Object payload,
      @Nullable String queue,
      int priority,
      @Nullable String concurrencyKey,
      @Nullable Integer maxAttempts,
      @Nullable Map<String, ?> retryPolicy) {
    Map<String, @Nullable Object> input = new LinkedHashMap<>();
    String named = optionalBytes(queue, MAX_NAME_BYTES, "queue");
    input.put("queue", named == null ? defaultQueue : named);
    input.put("type", requiredString(taskType, "task type"));
    input.put("payload", tree(payload, "payload"));
    input.put("priority", range(priority, 0, 100, "priority"));
    input.put("concurrencyKey", optionalBytes(concurrencyKey, MAX_NAME_BYTES, "concurrency key"));
    input.put(
        "maxAttempts",
        maxAttempts == null || maxAttempts == 0
            ? DEFAULT_MAX_ATTEMPTS
            : range(maxAttempts, 1, 100, "max attempts"));
    input.put("retryPolicy", retryPolicy(retryPolicy));
    input.put("contractVersion", null);
    input.put("payloadMaxBytes", SqlCatalogue.DEFAULT_TASK_VALUE_MAX_BYTES);
    input.put("resultMaxBytes", SqlCatalogue.DEFAULT_TASK_VALUE_MAX_BYTES);
    input.put("sensitivePayloadKeys", List.of());
    input.put("sensitiveResultKeys", List.of());
    return input;
  }

  private static Map<String, @Nullable Object> dependenciesDocument(Dependencies dependencies) {
    Set<String> ids = new TreeSet<>();
    for (UUID id : dependencies.prerequisiteTaskIds()) {
      ids.add(id.toString());
    }
    Map<String, @Nullable Object> document = new LinkedHashMap<>();
    document.put("prerequisiteTaskIds", List.copyOf(ids));
    document.put("onSuccess", wire(dependencies.onSuccess()));
    document.put("onFailure", wire(dependencies.onFailure()));
    document.put("onCancellation", wire(dependencies.onCancellation()));
    return document;
  }

  private static Map<String, @Nullable Object> idempotencyDocument(Idempotency idempotency) {
    long ttl = Values.milliseconds(idempotency.ttl(), "idempotency TTL", 0, MAX_DURATION_MS);
    Map<String, @Nullable Object> document = new LinkedHashMap<>();
    document.put("key", requiredBytes(idempotency.key(), MAX_KEY_BYTES, "idempotency key"));
    document.put("scope", scope(idempotency.scope()));
    document.put("ttlMs", ttl == 0 ? DEFAULT_IDEMPOTENCY_TTL_MS : ttl);
    return document;
  }

  private static Map<String, @Nullable Object> debounceDocument(Debounce debounce) {
    Map<String, @Nullable Object> document = new LinkedHashMap<>();
    document.put("key", requiredBytes(debounce.key(), MAX_KEY_BYTES, "debounce key"));
    document.put("scope", scope(debounce.scope()));
    document.put(
        "windowMs", Values.milliseconds(debounce.window(), "debounce window", 1, MAX_DURATION_MS));
    document.put("schedule", wire(debounce.schedule()));
    return document;
  }

  private static Map<String, @Nullable Object> throttleDocument(Throttle throttle) {
    Map<String, @Nullable Object> document = new LinkedHashMap<>();
    document.put("key", requiredBytes(throttle.key(), MAX_KEY_BYTES, "throttle key"));
    document.put("scope", scope(throttle.scope()));
    document.put(
        "windowMs", Values.milliseconds(throttle.window(), "throttle window", 1, MAX_DURATION_MS));
    return document;
  }

  /** The retry policy, after a check of the shape and bounds PostgreSQL accepts. */
  private @Nullable Map<String, @Nullable Object> retryPolicy(@Nullable Map<String, ?> policy) {
    if (policy == null) {
      return null;
    }
    Map<String, @Nullable Object> document = Json.object(tree(policy, "retry policy"));
    if (document == null) {
      throw new IllegalArgumentException("retry policy must be a Map");
    }
    Object type = document.get("type");
    List<String> fields = type instanceof String text ? RETRY_POLICY_FIELDS.get(text) : null;
    if (fields == null) {
      throw new IllegalArgumentException(
          "retry policy type must be fixed, exponential, or decorrelated-jitter");
    }
    Set<String> expected = new HashSet<>(fields);
    expected.add("type");
    if (!document.keySet().equals(expected)) {
      throw new IllegalArgumentException(
          type + " retry policy requires exactly type, " + String.join(", ", fields));
    }
    for (String field : fields) {
      long maximum = field.equals("multiplier") ? 100 : MAX_DURATION_MS;
      long minimum = field.equals("multiplier") ? 1 : 0;
      Long value = whole(document.get(field));
      if (value == null || value < minimum || value > maximum) {
        throw new IllegalArgumentException(
            "retry policy " + field + " must be an integer between " + minimum + " and " + maximum);
      }
    }
    Long floor = whole(document.getOrDefault("initialDelayMs", document.get("baseDelayMs")));
    Long ceiling = whole(document.get("maxDelayMs"));
    if (floor != null && ceiling != null && ceiling < floor) {
      throw new IllegalArgumentException("retry policy maxDelayMs must be at least " + floor);
    }
    return document;
  }

  private static @Nullable Long whole(@Nullable Object value) {
    if (value instanceof Long number) {
      return number;
    }
    if (value instanceof Double number
        && number == Math.rint(number)
        && Math.abs(number) < 9.0e15) {
      return number.longValue();
    }
    return null;
  }

  /** Validates a contracted payload and stamps the contract fields PostgreSQL enforces. */
  private void applyContract(Call call, Map<String, @Nullable Object> input, String taskType) {
    boolean known;
    boolean enabled;
    PayloadContract contract;
    if (call.loaded.containsKey(taskType)) {
      known = true;
      enabled = true;
      contract = call.loaded.get(taskType);
    } else {
      lock.lock();
      try {
        known = contracts.containsKey(taskType);
        contract = contracts.get(taskType);
        enabled = contractsEnabled;
      } finally {
        lock.unlock();
      }
    }
    if (!known && enabled) {
      contract = Contracts.load(call.connection, taskType, null);
      remember(call, taskType, contract);
    }
    stampContract(input, taskType, contract);
  }

  /**
   * Keeps a contract that the call loaded. A contract read inside a transaction can be uncommitted,
   * so only the call uses it, and the shared cache stays as it is.
   */
  private void remember(Call call, String taskType, @Nullable PayloadContract contract) {
    call.loaded.put(taskType, contract);
    if (!call.shared) {
      return;
    }
    lock.lock();
    try {
      contracts.put(taskType, contract);
    } finally {
      lock.unlock();
    }
  }

  private static void stampContract(
      Map<String, @Nullable Object> input, String taskType, @Nullable PayloadContract contract) {
    if (contract == null) {
      return;
    }
    ContractSchema schema = contract.schema();
    if (!schema.valid(input.get("payload"))) {
      throw new ContractValidationException(taskType, contract.version());
    }
    input.put("contractVersion", contract.version());
    input.put("payloadMaxBytes", contract.payloadMaxBytes());
    input.put("resultMaxBytes", contract.resultMaxBytes());
    input.put("sensitivePayloadKeys", contract.payloadRedactKeys());
    input.put("sensitiveResultKeys", contract.resultRedactKeys());
  }

  /** The task types PostgreSQL named when a batch carried a stale contract, or null. */
  private static @Nullable List<String> contractMismatch(List<Row> rows) {
    for (Row row : rows) {
      if (!"contract_mismatch".equals(row.text("outcome"))) {
        continue;
      }
      Object detail;
      try {
        String reason = row.text("reason");
        detail = reason == null ? null : Json.parse(reason);
      } catch (IllegalArgumentException invalid) {
        detail = null;
      }
      Map<String, @Nullable Object> object = Json.object(detail);
      Object taskTypes = object == null ? null : object.get("taskTypes");
      if (!(taskTypes instanceof List<?> list)
          || !list.stream().allMatch(item -> item instanceof String)) {
        throw invalidResult();
      }
      List<String> names = new ArrayList<>();
      for (Object item : list) {
        names.add((String) item);
      }
      return names;
    }
    return null;
  }

  private static List<EnqueueResult> enqueueResults(List<Row> rows, int count) {
    if (rows.size() != count) {
      throw invalidResult();
    }
    EnqueueResult[] results = new EnqueueResult[count];
    for (Row row : rows) {
      long index = row.requiredLong("ordinal") - 1;
      if (index < 0 || index >= count || results[(int) index] != null) {
        throw invalidResult();
      }
      results[(int) index] = enqueueResult(row);
    }
    return List.of(results);
  }

  private static EnqueueResult enqueueResult(Row row) {
    String outcome = row.text("outcome");
    String reason = row.text("reason");
    EnqueueOutcome parsed = Rows.constant(EnqueueOutcome.class, "enqueue", outcome);
    EnqueueNonReplaceableReason because = null;
    if (parsed == EnqueueOutcome.NON_REPLACEABLE) {
      because = Rows.constant(EnqueueNonReplaceableReason.class, "enqueue", reason);
    } else if (reason != null) {
      throw invalidResult();
    }
    return new EnqueueResult(row.requiredUuid("task_id"), parsed, because);
  }

  private static WorkhorseException invalidResult() {
    return new WorkhorseException("PostgreSQL returned an invalid enqueue result");
  }

  // ---------------------------------------------------------------------------------------------
  // Values

  /** A value as the core's JSON tree, through the codec and the strict parser. */
  private @Nullable Object tree(@Nullable Object value, String label) {
    return tree(value, label, Json::parseExact);
  }

  /**
   * A contract schema as the core's JSON tree. It keeps a fraction outside the double range, which
   * {@link Json#parseExact(String)} refuses for a value (SM-1598).
   */
  private @Nullable Object schemaTree(@Nullable Object value) {
    return tree(value, "contract schema", Json::parseSchema);
  }

  private @Nullable Object tree(
      @Nullable Object value, String label, Function<String, @Nullable Object> parser) {
    try {
      return parser.apply(codec.encode(value));
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException(
          label + " is not a JSON value: " + error.getMessage(), error);
    }
  }

  private @Nullable Object decode(@Nullable String json) {
    return json == null ? null : codec.decode(json, Object.class);
  }

  private static String wire(Enum<?> value) {
    return value.name().toLowerCase(Locale.ROOT);
  }

  private static List<String> tags(List<String> values) {
    boolean valid = values.size() <= MAX_TAGS;
    for (String tag : values) {
      int length = tag.codePointCount(0, tag.length());
      valid &= length >= 1 && length <= MAX_TAG_LENGTH;
    }
    if (!valid) {
      throw new IllegalArgumentException(
          "tags must be a List of at most "
              + MAX_TAGS
              + " Strings of 1 to "
              + MAX_TAG_LENGTH
              + " characters");
    }
    return values;
  }

  private static int range(int value, int minimum, int maximum, String label) {
    if (value < minimum || value > maximum) {
      throw new IllegalArgumentException(
          label + " must be an Integer between " + minimum + " and " + maximum);
    }
    return value;
  }

  private static String scope(@Nullable String value) {
    String scope = optionalBytes(value, MAX_NAME_BYTES, "scope");
    return scope == null ? "default" : scope;
  }

  private static String requiredString(String value, String label) {
    if (value.isEmpty()) {
      throw new IllegalArgumentException(label + " must be a non-empty String");
    }
    return value;
  }

  private static String requiredBytes(String value, int maximum, String label) {
    int length = bytes(value);
    if (length < 1 || length > maximum) {
      throw new IllegalArgumentException(
          label + " must contain between 1 and " + maximum + " UTF-8 bytes");
    }
    return value;
  }

  /**
   * The protocol value of an execution timeout. Zero means no timeout, as {@code null} does. A
   * nonzero duration that rounds to 0 ms is refused, so it cannot remove the timeout.
   */
  private static @Nullable Long executionTimeout(@Nullable Duration timeout) {
    if (timeout == null || timeout.isZero()) {
      return null;
    }
    return Values.milliseconds(timeout, "execution timeout", 1, MAX_DURATION_MS);
  }

  /** The value, or null when it is null or empty. A longer value than the maximum throws. */
  private static @Nullable String optionalBytes(@Nullable String value, int maximum, String label) {
    if (value == null || value.isEmpty()) {
      return null;
    }
    if (bytes(value) > maximum) {
      throw new IllegalArgumentException(
          label + " must contain at most " + maximum + " UTF-8 bytes");
    }
    return value;
  }

  private static int bytes(String value) {
    return value.getBytes(StandardCharsets.UTF_8).length;
  }

  // ---------------------------------------------------------------------------------------------
  // Connections

  /**
   * The connection of one call. {@code caller} is true when the caller owns the connection, and
   * {@code shared} is true when the call runs in autocommit, so a contract it reads is committed.
   * {@code loaded} holds the contracts that the call loaded.
   */
  private record Call(
      Connection connection,
      boolean caller,
      boolean shared,
      Map<String, @Nullable PayloadContract> loaded) {
    Call(Connection connection, boolean caller, boolean shared) {
      this(connection, caller, shared, new HashMap<>());
    }
  }

  private interface Body<T extends @Nullable Object> {
    T run(Call call);
  }

  /**
   * Runs {@code body} on the caller's connection, or on a connection from the source. The queue
   * never begins, commits, or rolls back on either.
   */
  private <T extends @Nullable Object> T run(@Nullable Connection caller, Body<T> body) {
    if (caller != null) {
      boolean autoCommit;
      try {
        autoCommit = caller.getAutoCommit();
      } catch (SQLException error) {
        throw Sql.translate(error);
      }
      return body.run(new Call(caller, true, autoCommit));
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
      result = body.run(new Call(connection, false, !transactional));
    } catch (SQLException error) {
      WorkhorseException translated = Sql.translate(error);
      releaseAfter(connection, transactional, translated);
      throw translated;
    } catch (RuntimeException | Error error) {
      releaseAfter(connection, transactional, error);
      throw error;
    }
    // The call succeeded: it committed in autocommit, or the source owns its transaction. A throw
    // here would make a caller retry a write that PostgreSQL already has (SM-1525).
    try {
      connections.release(connection, transactional);
    } catch (SQLException | RuntimeException error) {
      LOGGER.log(
          System.Logger.Level.WARNING,
          "Connection release failed after a successful call {event.name="
              + "workhorse.connection.release_failed}",
          error);
    }
    return result;
  }

  /** Releases a connection after {@code failure}, which keeps any release error as suppressed. */
  private void releaseAfter(Connection connection, boolean transactional, Throwable failure) {
    try {
      connections.release(connection, transactional);
    } catch (SQLException error) {
      failure.addSuppressed(Sql.translate(error));
    } catch (RuntimeException error) {
      failure.addSuppressed(error);
    }
  }
}
