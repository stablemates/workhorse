package run.workhorse;

import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.Contracts.PayloadContract;
import run.workhorse.internal.Json;
import run.workhorse.internal.Row;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.internal.Suspension;
import run.workhorse.internal.Values;

/**
 * The worker's {@link HandlerContext} for one attempt. The counterpart of Ruby's {@code
 * HandlerContext} in {@code ruby/lib/stablemates/workhorse/context.rb}.
 */
final class TaskContext implements HandlerContext {
  private static final long MAX_WAIT_MS = 31_536_000_000L;
  private static final long MAX_EXTERNAL_TIMEOUT_MS = 604_800_000L;
  private static final int MAX_EXTERNAL_VALUE_BYTES = 65_536;
  private static final int MAX_CHILDREN = 100;
  private static final int MAX_NAME_LENGTH = 200;
  private static final String WHITESPACE = "\0\t\n\u000B\f\r ";
  private static final Map<String, ChildStatus> CHILD_OUTCOMES =
      Map.of(
          "succeeded", ChildStatus.SUCCEEDED,
          "failed", ChildStatus.FAILED,
          "canceled", ChildStatus.CANCELED);

  private final Worker worker;
  private final ClaimedTask task;
  private final TaskCancellation cancellation;
  private final Worker.Arbiter arbiter;
  private final BooleanSupplier fastTierRead;
  private final TaskGroupContext taskGroup;

  // The lock guards the fields below. A load holds it while it reads, as Ruby's Monitor does.
  private final ReentrantLock lock = new ReentrantLock();
  private final Map<String, Loaded> loaded = new HashMap<>();
  private final Map<String, Running> calls = new HashMap<>();
  private @Nullable Boolean fastTier;

  /** A saved checkpoint, and its value as the JSON text PostgreSQL returned. */
  private record Saved(TaskCheckpoint checkpoint, String text) {}

  /** One lazily read value, or the error of its first read. */
  private record Loaded(@Nullable Object value, @Nullable RuntimeException error) {}

  /** A durable call in flight: its request, and the result that every caller shares. */
  private record Running(@Nullable Object request, CompletableFuture<@Nullable Object> result) {}

  /** The body of a durable call. A checkpoint operation can throw a checked exception. */
  private interface Body {
    @Nullable Object run() throws Exception;
  }

  TaskContext(
      Worker worker,
      ClaimedTask task,
      TaskCancellation cancellation,
      Worker.Arbiter arbiter,
      BooleanSupplier fastTierRead) {
    this.worker = worker;
    this.task = task;
    this.cancellation = cancellation;
    this.arbiter = arbiter;
    this.fastTierRead = fastTierRead;
    this.taskGroup =
        new ActivationTaskGroup(
            () ->
                Optional.ofNullable(
                    (TaskGroupLink)
                        load(
                            "taskGroup",
                            () -> worker.queue().findTaskGroup(task.id()).orElse(null))),
            requests -> {
              live("taskGroupAdd");
              return worker.queue().addToTaskGroupAsMember(task, worker.workerId(), requests);
            });
  }

  @Override
  public ClaimedTask task() {
    return task;
  }

  @Override
  public CancellationToken cancellation() {
    return cancellation;
  }

  @Override
  public boolean isCancelled() {
    return cancellation.isCancelled();
  }

  @Override
  public TaskGroupContext taskGroup() {
    return taskGroup;
  }

  // ---------------------------------------------------------------------------------------------
  // Checkpoints

  @Override
  public Optional<TaskCheckpoint> getCheckpoint(String name) {
    Saved saved = savedCheckpoint(name);
    return saved == null ? Optional.empty() : Optional.of(saved.checkpoint);
  }

  @Override
  public <T extends @Nullable Object> T checkpoint(String name, Type type, Callable<T> operation) {
    return checkpoint(name, type, false, null, operation);
  }

  @Override
  public <T extends @Nullable Object> T checkpoint(
      String name, Type type, CheckpointOptions options, Callable<T> operation) {
    Objects.requireNonNull(options, "options");
    return checkpoint(name, type, true, options.input(), operation);
  }

  private <T extends @Nullable Object> T checkpoint(
      String name, Type type, boolean hasInput, @Nullable Object input, Callable<T> operation) {
    durableName(name, "checkpoint");
    durable("checkpoints");
    Objects.requireNonNull(type, "type");
    Objects.requireNonNull(operation, "operation");
    String fingerprint = hasInput ? Checkpoints.inputFingerprint(input, worker.codec()) : null;
    String text =
        (String)
            once(
                "checkpoint",
                name,
                fingerprint,
                name,
                running -> checkInput(name, (String) running, fingerprint),
                () -> {
                  Saved existing = savedCheckpoint(name);
                  if (existing != null) {
                    checkInput(name, existing.checkpoint.inputFingerprint(), fingerprint);
                    return existing.text;
                  }
                  live("checkpoint");
                  String encoded = storable(operation.call(), "checkpoint value");
                  Row row =
                      worker.fencedRow(
                          SqlCatalogue.SAVE_CHECKPOINT_V2, task, name, encoded, fingerprint);
                  if ("input_conflict".equals(row.text("status"))) {
                    checkInput(name, row.text("input_fingerprint"), fingerprint);
                  }
                  String status = expect("checkpoint", row, Set.of("saved", "existing"), name);
                  log(
                      System.Logger.Level.DEBUG,
                      "workhorse.task.checkpoint_saved",
                      "Task checkpoint persisted",
                      Map.of(
                          "workhorse.checkpoint.name",
                          name,
                          "workhorse.checkpoint.status",
                          status));
                  Saved saved = checkpointRecord(row, name);
                  lock.lock();
                  try {
                    checkpoints().put(name, saved);
                  } finally {
                    lock.unlock();
                  }
                  return saved.text;
                });
    return decode(text, type);
  }

  /**
   * Inputs are compared only when both sides carry a fingerprint, so a handler that adds or removes
   * an input keeps the stored result.
   */
  private static void checkInput(String name, @Nullable String stored, @Nullable String requested) {
    if (stored == null || requested == null || stored.equals(requested)) {
      return;
    }
    throw new CheckpointInputConflictException(name, stored, requested);
  }

  /** The saved checkpoint {@code name}, or {@code null}. The read holds the context lock. */
  private @Nullable Saved savedCheckpoint(String name) {
    lock.lock();
    try {
      return checkpoints().get(name);
    } finally {
      lock.unlock();
    }
  }

  /**
   * The checkpoints of this task, read once. The map is not thread-safe, so each read and write of
   * it holds the context lock.
   */
  @SuppressWarnings("unchecked")
  private Map<String, Saved> checkpoints() {
    return (Map<String, Saved>)
        Objects.requireNonNull(
            load(
                "checkpoints",
                () -> {
                  Map<String, Saved> saved = new HashMap<>();
                  for (Row row : worker.rows(SqlCatalogue.LIST_CHECKPOINTS, task.id().toString())) {
                    String name = row.requiredText("checkpoint_name");
                    saved.put(name, checkpointRecord(row, name));
                  }
                  return saved;
                }));
  }

  private Saved checkpointRecord(Row row, String name) {
    String text = row.requiredText("checkpoint_value");
    TaskCheckpoint checkpoint =
        new TaskCheckpoint(
            task.id(),
            name,
            Json.parse(text),
            row.requiredInteger("attempt"),
            row.requiredLong("fence_token"),
            row.requiredText("worker_id"),
            row.requiredInstant("created_at"),
            row.text("input_fingerprint"));
    return new Saved(checkpoint, text);
  }

  // ---------------------------------------------------------------------------------------------
  // Durable timers

  @Override
  public void sleep(String name, Duration duration) {
    durableName(name, "wait");
    durable("durable waits");
    Objects.requireNonNull(duration, "duration");
    scheduleWait(name, Values.milliseconds(duration, "wait duration", 1, MAX_WAIT_MS), null);
  }

  @Override
  public void sleepUntil(String name, Instant time) {
    durableName(name, "wait");
    durable("durable waits");
    Objects.requireNonNull(time, "time");
    if (time.isAfter(Instant.now().plusMillis(MAX_WAIT_MS))) {
      throw new IllegalArgumentException("wait time must be no more than 365 days in the future");
    }
    scheduleWait(name, null, Values.timestamp(time));
  }

  /**
   * Relative sleeps under one name share the first write, whatever their durations. An absolute
   * sleep shares only with the same wake time.
   */
  private void scheduleWait(String name, @Nullable Long durationMs, @Nullable String wakeAt) {
    once(
        "sleep",
        name,
        wakeAt == null ? "relative" : "absolute:" + wakeAt,
        name,
        null,
        () -> {
          live("sleep");
          Row row =
              worker.fencedRow(
                  SqlCatalogue.SCHEDULE_WAIT_V1,
                  task,
                  name,
                  durationMs == null ? null : Long.toString(durationMs),
                  wakeAt);
          String status = row.text("status");
          switch (status == null ? "" : status) {
            case "stale" -> throw new LeaseLostException(task.id(), "sleep");
            case "conflict" -> throw new ConflictException("sleep", name);
            case "limit_exceeded" -> throw new LimitExceededException("sleep", name);
            case "scheduled", "elapsed" -> {}
            default -> throw new UnexpectedStatusException("sleep", status);
          }
          processed(
              "scheduled".equals(status) ? Worker.Outcome.SUSPENDED_FOR_WAIT : null,
              () ->
                  log(
                      System.Logger.Level.INFO,
                      "workhorse.task.wait_processed",
                      "Durable task wait processed",
                      Map.of("workhorse.wait.name", name, "workhorse.wait.status", status)));
          return null;
        });
  }

  // ---------------------------------------------------------------------------------------------
  // External waits

  @Override
  // ADR 0103 fixes this signature: the type argument comes from the call site.
  @SuppressWarnings("TypeParameterUnusedInFormals")
  public <T extends @Nullable Object> T waitForSignal(
      String name, Type type, @Nullable Duration timeout) {
    externalName(name, "signal");
    durable("signal waits");
    Objects.requireNonNull(type, "type");
    Long timeoutMs = externalTimeout(timeout, "signal");
    String text =
        (String)
            once(
                "waitForSignal",
                name,
                null,
                name,
                null,
                () -> {
                  live("waitForSignal");
                  Row row =
                      worker.fencedRow(
                          SqlCatalogue.WAIT_FOR_SIGNAL_V1,
                          task,
                          name,
                          timeoutMs == null ? null : Long.toString(timeoutMs));
                  String status = row.text("status");
                  return switch (status == null ? "" : status) {
                    case "stale" -> throw new LeaseLostException(task.id(), "waitForSignal");
                    case "already_waiting" ->
                        throw new AlreadyWaitingException("waitForSignal", name);
                    case "limit_exceeded" ->
                        throw new LimitExceededException("waitForSignal", name);
                    case "waiting" -> throw suspend(Worker.Outcome.SUSPENDED_FOR_WAIT);
                    case "delivered" -> jsonText(row, "payload");
                    default -> throw new UnexpectedStatusException("waitForSignal", status);
                  };
                });
    return decode(text, type);
  }

  @Override
  // ADR 0103 fixes this signature: the type argument comes from the call site.
  @SuppressWarnings("TypeParameterUnusedInFormals")
  public <T extends @Nullable Object> T waitForHuman(
      String name, @Nullable Object context, Type type, @Nullable Duration timeout) {
    externalName(name, "human wait");
    durable("human waits");
    Objects.requireNonNull(type, "type");
    Long timeoutMs = externalTimeout(timeout, "human wait");
    String encoded = sortedJson(tree(context, "human wait context"));
    if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_EXTERNAL_VALUE_BYTES) {
      throw new IllegalArgumentException(
          "human wait context must be at most " + MAX_EXTERNAL_VALUE_BYTES + " bytes of JSON");
    }
    String text =
        (String)
            once(
                "waitForHuman",
                name,
                encoded,
                name,
                null,
                () -> {
                  live("waitForHuman");
                  Row row =
                      worker.fencedRow(
                          SqlCatalogue.WAIT_FOR_HUMAN_V1,
                          task,
                          name,
                          encoded,
                          timeoutMs == null ? null : Long.toString(timeoutMs));
                  String status = row.text("status");
                  return switch (status == null ? "" : status) {
                    case "stale" -> throw new LeaseLostException(task.id(), "waitForHuman");
                    case "already_waiting" ->
                        throw new AlreadyWaitingException("waitForHuman", name);
                    case "limit_exceeded" -> throw new LimitExceededException("waitForHuman", name);
                    case "conflict" -> throw new ConflictException("waitForHuman", name);
                    case "waiting" -> throw suspend(Worker.Outcome.SUSPENDED_FOR_WAIT);
                    case "completed" -> jsonText(row, "result");
                    default -> throw new UnexpectedStatusException("waitForHuman", status);
                  };
                });
    return decode(text, type);
  }

  // ---------------------------------------------------------------------------------------------
  // Child tasks

  @Override
  // ADR 0103 fixes this signature: the type argument comes from the call site.
  @SuppressWarnings("TypeParameterUnusedInFormals")
  public <T extends @Nullable Object> T runChild(
      String name,
      String taskType,
      @Nullable Object payload,
      EnqueueOptions options,
      Type resultType) {
    durableName(name, "child");
    durable("child tasks");
    Objects.requireNonNull(taskType, "taskType");
    Objects.requireNonNull(options, "options");
    Objects.requireNonNull(resultType, "resultType");
    Function<Map<String, Queue.ChildVersion>, String> build =
        versions ->
            sortedJson(
                worker.withCallerConnection(
                    connection ->
                        worker
                            .queue()
                            .serializeChildRequest(
                                connection,
                                task,
                                taskType,
                                payload,
                                options,
                                new HashMap<>(),
                                versions.get(name))));
    String encoded = initial(build);
    String text =
        (String)
            once(
                "runChild",
                name,
                encoded,
                name,
                null,
                () -> {
                  live("runChild");
                  Row row = worker.fencedRow(SqlCatalogue.CREATE_CHILD_V2, task, name, encoded);
                  row =
                      replayed(
                          row,
                          encoded,
                          build,
                          accepted ->
                              worker.fencedRow(SqlCatalogue.CREATE_CHILD_V2, task, name, accepted));
                  String status = row.text("status");
                  switch (status == null ? "" : status) {
                    case "stale" -> throw new LeaseLostException(task.id(), "runChild");
                    case "conflict" ->
                        throw new ConflictException(
                            "runChild", name, row.text("stored_child_name"));
                    case "limit_exceeded" -> throw new LimitExceededException("runChild", name);
                    case "created", "completed" ->
                        processed(
                            "created".equals(status) ? Worker.Outcome.SUSPENDED_FOR_CHILD : null,
                            () ->
                                log(
                                    System.Logger.Level.INFO,
                                    "workhorse.task.child_processed",
                                    "Child task processed",
                                    Map.of(
                                        "workhorse.child.name", name,
                                        "workhorse.child.status", status)));
                    default -> throw new UnexpectedStatusException("runChild", status);
                  }
                  return jsonText(row, "result");
                });
    return decode(text, resultType);
  }

  @Override
  @SuppressWarnings("unchecked")
  public Map<String, ChildOutcome> runChildren(List<ChildRequest> children) {
    return (Map<String, ChildOutcome>) runChildSet(children, "settled");
  }

  @Override
  @SuppressWarnings("unchecked")
  public Map<String, @Nullable Object> runChildrenAll(List<ChildRequest> children) {
    return (Map<String, @Nullable Object>) runChildSet(children, "all_success");
  }

  @SuppressWarnings("unchecked")
  private Map<String, ?> runChildSet(List<ChildRequest> children, String mode) {
    List<ChildRequest> requests = List.copyOf(children);
    if (requests.size() > MAX_CHILDREN) {
      throw new LimitExceededException("runChildren", "child set");
    }
    Set<String> names = new HashSet<>();
    for (ChildRequest child : requests) {
      durableName(child.name(), "child");
      names.add(child.name());
    }
    if (names.size() != requests.size()) {
      throw new IllegalArgumentException("child names must be unique");
    }
    durable("child tasks");
    Function<Map<String, Queue.ChildVersion>, String> build =
        versions ->
            worker.withCallerConnection(
                connection -> {
                  Map<String, @Nullable PayloadContract> contracts = new HashMap<>();
                  List<Object> document = new ArrayList<>();
                  for (ChildRequest child : requests) {
                    Map<String, @Nullable Object> item = new LinkedHashMap<>();
                    item.put("name", child.name());
                    item.put(
                        "request",
                        worker
                            .queue()
                            .serializeChildRequest(
                                connection,
                                task,
                                child.taskType(),
                                child.payload(),
                                child.options(),
                                contracts,
                                versions.get(child.name())));
                    document.add(item);
                  }
                  return sortedJson(document);
                });
    String encoded = initial(build);
    Object joined =
        once(
            "runChildren",
            "set",
            mode + ":" + encoded,
            "child set",
            null,
            () -> {
              live("runChildren");
              Row row = worker.fencedRow(SqlCatalogue.CREATE_CHILDREN_V1, task, encoded, mode);
              row =
                  replayed(
                      row,
                      encoded,
                      build,
                      accepted ->
                          worker.fencedRow(SqlCatalogue.CREATE_CHILDREN_V1, task, accepted, mode));
              String status = row.text("status");
              switch (status == null ? "" : status) {
                case "stale" -> throw new LeaseLostException(task.id(), "runChildren");
                case "conflict" -> throw new ConflictException("runChildren", "child set");
                case "limit_exceeded" ->
                    throw new LimitExceededException("runChildren", "child set");
                case "result_too_large" ->
                    throw new ChildResultLimitExceededException(
                        row.requiredLong("result_bytes"), row.requiredLong("result_limit_bytes"));
                case "created", "completed" ->
                    processed(
                        "created".equals(status) ? Worker.Outcome.SUSPENDED_FOR_CHILD : null,
                        () ->
                            log(
                                System.Logger.Level.INFO,
                                "workhorse.task.child_processed",
                                "Child set processed",
                                Map.of(
                                    "workhorse.child.count",
                                    requests.size(),
                                    "workhorse.child.status",
                                    status)));
                default -> throw new UnexpectedStatusException("runChildren", status);
              }
              return joined(row.json("children"), mode);
            });
    return (Map<String, ?>) Objects.requireNonNull(joined);
  }

  /**
   * Builds the child request under the current contracts. A replayed request that the current
   * contracts reject builds again with each existing child at the version it was created under.
   * PostgreSQL still rejects a request that differs from the accepted one.
   */
  private String initial(Function<Map<String, Queue.ChildVersion>, String> build) {
    try {
      return build.apply(Map.of());
    } catch (ContractValidationException error) {
      Map<String, Queue.ChildVersion> versions = acceptedContractVersions();
      if (versions.isEmpty()) {
        throw error;
      }
      try {
        return build.apply(versions);
      } catch (ContractValidationException ignored) {
        throw error;
      }
    }
  }

  /**
   * PostgreSQL compares a replayed child request with the one it accepted, contract stamp included.
   * After a contract change, a {@code conflict} retries once with each existing child stamped with
   * the contract version it was created under.
   */
  private Row replayed(
      Row row,
      String encoded,
      Function<Map<String, Queue.ChildVersion>, String> build,
      Function<String, Row> resend) {
    if (!"conflict".equals(row.text("status"))) {
      return row;
    }
    Map<String, Queue.ChildVersion> versions = acceptedContractVersions();
    if (versions.isEmpty()) {
      return row;
    }
    String accepted;
    try {
      accepted = build.apply(versions);
    } catch (ContractValidationException rejected) {
      return row;
    }
    return accepted.equals(encoded) ? row : resend.apply(accepted);
  }

  /** The contract version and the queue of each child that this task created, by child name. */
  private Map<String, Queue.ChildVersion> acceptedContractVersions() {
    String id = task.id().toString();
    Map<String, Queue.ChildVersion> versions = new HashMap<>();
    for (Row edge : worker.rows(SqlCatalogue.TASK_CHILD, id, Integer.toString(MAX_CHILDREN + 1))) {
      if (!id.equals(edge.text("parent_task_id"))) {
        continue;
      }
      List<Row> rows = worker.rows(SqlCatalogue.GET_TASK, edge.requiredText("child_task_id"));
      Row child = rows.isEmpty() ? null : rows.get(0);
      versions.put(
          edge.requiredText("child_name"),
          new Queue.ChildVersion(
              child == null ? null : child.text("contract_version"),
              child == null ? null : child.text("queue_name")));
    }
    return versions;
  }

  private static Map<String, ?> joined(@Nullable Object children, String mode) {
    Map<String, @Nullable Object> joined = new LinkedHashMap<>();
    List<?> items = children instanceof List<?> list ? list : List.of();
    for (Object item : items) {
      Map<String, @Nullable Object> child = Json.object(item);
      if (child == null || !(child.get("name") instanceof String name)) {
        throw new UnexpectedStatusException("runChildren", null);
      }
      if (mode.equals("all_success")) {
        joined.put(name, child.get("result"));
        continue;
      }
      Map<String, @Nullable Object> outcome = Json.object(child.get("outcome"));
      Object text = outcome == null ? null : outcome.get("status");
      ChildStatus status = text instanceof String key ? CHILD_OUTCOMES.get(key) : null;
      if (outcome == null || status == null) {
        throw new UnexpectedStatusException("runChildren", text instanceof String key ? key : null);
      }
      joined.put(name, new ChildOutcome(status, outcome.get("result"), outcome.get("error")));
    }
    return joined;
  }

  // ---------------------------------------------------------------------------------------------
  // Progress

  @Override
  public Optional<TaskProgress> getProgress() {
    return Optional.ofNullable(
        (TaskProgress)
            load(
                "progress",
                () -> {
                  List<Row> rows = worker.rows(SqlCatalogue.LIST_PROGRESS, task.id().toString());
                  if (rows.size() > 1) {
                    throw new WorkhorseException("PostgreSQL returned an invalid progress result");
                  }
                  return rows.isEmpty() ? null : progressRecord(rows.get(0));
                }));
  }

  @Override
  public TaskProgress setProgress(@Nullable Object progress) {
    durable("progress");
    String encoded = storable(progress, "progress");
    live("setProgress");
    Row row = worker.fencedRow(SqlCatalogue.UPDATE_PROGRESS_V1, task, encoded);
    String status = row.text("status");
    switch (status == null ? "" : status) {
      case "stale" -> throw new LeaseLostException(task.id(), "setProgress");
      case "rate_limited" ->
          throw new ProgressRateLimitedException(
              Duration.ofMillis(row.requiredLong("retry_after_ms")));
      case "updated", "unchanged" -> {}
      default -> throw new UnexpectedStatusException("setProgress", status);
    }
    TaskProgress saved = progressRecord(row);
    lock.lock();
    try {
      Loaded cached = loaded.get("progress");
      boolean newer =
          cached != null
              && cached.error == null
              && cached.value instanceof TaskProgress current
              && current.revision() > saved.revision();
      if (!newer) {
        loaded.put("progress", new Loaded(saved, null));
      }
    } finally {
      lock.unlock();
    }
    log(
        System.Logger.Level.DEBUG,
        "workhorse.task.progress_updated",
        "Task progress persisted",
        Map.of("workhorse.progress.status", status));
    return saved;
  }

  private TaskProgress progressRecord(Row row) {
    return new TaskProgress(
        task.id(),
        row.json("progress_value"),
        row.requiredLong("revision"),
        row.requiredInteger("attempt"),
        row.requiredLong("fence_token"),
        row.requiredText("worker_id"),
        row.requiredInstant("created_at"),
        row.requiredInstant("updated_at"));
  }

  // ---------------------------------------------------------------------------------------------
  // Shared calls and suspension

  /**
   * Runs {@code body} once per {@code kind} and {@code name} at a time. A concurrent caller with
   * the same {@code request} receives the running call's result or error; a different request
   * conflicts. {@code overlap}, when given, receives the running call's request and throws in place
   * of that comparison.
   */
  private @Nullable Object once(
      String kind,
      String name,
      @Nullable Object request,
      String conflictName,
      @Nullable Consumer<@Nullable Object> overlap,
      Body body) {
    String key = kind + "\0" + name;
    CompletableFuture<@Nullable Object> result;
    Running running;
    Running mine = null;
    lock.lock();
    try {
      running = calls.get(key);
      if (running == null) {
        result = new CompletableFuture<>();
        mine = new Running(request, result);
        calls.put(key, mine);
      } else {
        result = running.result;
        if (overlap != null) {
          overlap.accept(running.request);
        } else if (!Objects.equals(running.request, request)) {
          throw new ConflictException(kind, conflictName);
        }
      }
    } finally {
      lock.unlock();
    }
    if (running != null) {
      return shared(result);
    }
    try {
      Object value = body.run();
      result.complete(value);
      return value;
    } catch (Throwable error) {
      result.completeExceptionally(error);
      throw sneaky(error);
    } finally {
      lock.lock();
      try {
        calls.remove(key, mine);
      } finally {
        lock.unlock();
      }
    }
  }

  /** The result of a call that another caller runs, or its error. */
  private static @Nullable Object shared(CompletableFuture<@Nullable Object> result) {
    try {
      return result.get();
    } catch (ExecutionException failed) {
      Throwable cause = failed.getCause();
      throw sneaky(cause == null ? failed : cause);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw sneaky(interrupted);
    }
  }

  /**
   * Throws {@code error} unchanged, checked or not. An exception from a checkpoint operation, and
   * an {@link InterruptedException}, reach the handler as they were thrown.
   */
  @SuppressWarnings("unchecked")
  private static <E extends Throwable> RuntimeException sneaky(Throwable error) throws E {
    throw (E) error;
  }

  /**
   * Runs the bookkeeping after a durable write. When {@code outcome} names a suspension, the write
   * released the task: the release is recorded first, and the call unwinds even when the
   * bookkeeping throws, so neither the heartbeat nor a failing logger lets the handler continue.
   */
  private void processed(Worker.@Nullable Outcome outcome, Runnable bookkeeping) {
    if (outcome != null) {
      arbiter.release(outcome);
    }
    // An error of any type, such as an AssertionError from a logger, must not skip the suspension.
    Throwable failure = null;
    try {
      bookkeeping.run();
    } catch (Throwable error) {
      failure = error;
    }
    if (outcome != null) {
      throw suspend(outcome);
    }
    if (failure != null) {
      throw sneaky(failure);
    }
  }

  /**
   * Returns a fresh {@link Suspension} for the caller to throw after a write released the task,
   * even when another outcome already won. Only a winning suspension cancels the token.
   */
  private Suspension suspend(Worker.Outcome outcome) {
    arbiter.release(outcome);
    if (arbiter.submit(outcome)) {
      cancellation.cancel(CancellationReason.SUSPENDED);
    }
    return new Suspension();
  }

  // ---------------------------------------------------------------------------------------------
  // Checks

  /**
   * A fast-tier task has no durable execution state (ADR 0077), so each call that would write it
   * throws before any round trip. The worker gives each context a tier read that the first durable
   * call runs. A failed read throws, and the next durable call reads again.
   */
  private void durable(String feature) {
    boolean fast;
    lock.lock();
    try {
      if (fastTier == null) {
        fastTier = fastTierRead.getAsBoolean();
      }
      fast = fastTier;
    } finally {
      lock.unlock();
    }
    if (fast) {
      throw new FastTierUnsupportedException(task.queue(), feature, null);
    }
  }

  /**
   * Refuses a durable write once the attempt is cancelled. An attempt that lost its lease throws
   * {@link LeaseLostException}, as its fenced write would.
   */
  private void live(String operation) {
    if (cancellation.reason() == CancellationReason.LEASE_LOST) {
      throw new LeaseLostException(task.id(), operation);
    }
    cancellation.throwIfCancelled();
  }

  private String expect(String operation, Row row, Set<String> known, String name) {
    String status = row.text("status");
    if ("stale".equals(status)) {
      throw new LeaseLostException(task.id(), operation);
    }
    if ("conflict".equals(status)) {
      throw new ConflictException(operation, name);
    }
    if (status == null || !known.contains(status)) {
      throw new UnexpectedStatusException(operation, status);
    }
    return status;
  }

  /** Loads one lazily read value. The first load's error repeats on every later call. */
  private @Nullable Object load(String kind, java.util.function.Supplier<@Nullable Object> read) {
    lock.lock();
    try {
      Loaded current = loaded.get(kind);
      if (current == null) {
        try {
          current = new Loaded(read.get(), null);
        } catch (RuntimeException error) {
          current = new Loaded(null, error);
        }
        loaded.put(kind, current);
      }
      if (current.error != null) {
        throw current.error;
      }
      return current.value;
    } finally {
      lock.unlock();
    }
  }

  /**
   * PostgreSQL accepts a checkpoint, wait, or child name of 1 to 200 characters. Checking it before
   * the tier check keeps an invalid name from running an operation or any statement.
   */
  private static void durableName(String name, String label) {
    if (name == null || !lengthFits(name)) {
      throw new IllegalArgumentException(
          label + " name must contain between 1 and " + MAX_NAME_LENGTH + " characters");
    }
  }

  private static void externalName(String name, String label) {
    if (name != null
        && lengthFits(name)
        && WHITESPACE.indexOf(name.charAt(0)) < 0
        && WHITESPACE.indexOf(name.charAt(name.length() - 1)) < 0) {
      return;
    }
    throw new IllegalArgumentException(
        label
            + " name must contain between 1 and "
            + MAX_NAME_LENGTH
            + " characters without surrounding whitespace");
  }

  private static boolean lengthFits(String name) {
    int length = name.codePointCount(0, name.length());
    return length >= 1 && length <= MAX_NAME_LENGTH;
  }

  private static @Nullable Long externalTimeout(@Nullable Duration timeout, String label) {
    return timeout == null
        ? null
        : Values.milliseconds(timeout, label + " timeout", 1, MAX_EXTERNAL_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------------------------------------
  // Values

  /** A value as the core's JSON tree, through the worker's codec and the strict parser. */
  private @Nullable Object tree(@Nullable Object value, String label) {
    Object tree;
    try {
      tree = Json.parseExact(worker.codec().encode(value));
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException(
          label + " is not a JSON value: " + error.getMessage(), error);
    }
    Worker.checkStorable(label, tree);
    return tree;
  }

  /** The JSON text that PostgreSQL stores for {@code value}. */
  private String storable(@Nullable Object value, String label) {
    return Json.write(tree(value, label));
  }

  // ADR 0103 fixes this signature: the type argument comes from the call site.
  @SuppressWarnings("TypeParameterUnusedInFormals")
  private <T extends @Nullable Object> T decode(@Nullable String text, Type type) {
    return worker.codec().decode(text == null ? "null" : text, type);
  }

  /** A {@code jsonb} column as JSON text. SQL {@code NULL} reads as the JSON value {@code null}. */
  private static String jsonText(Row row, String column) {
    String text = row.text(column);
    return text == null ? "null" : text;
  }

  /** JSON with the keys of every object sorted, so equal requests encode to equal text. */
  private static String sortedJson(@Nullable Object value) {
    return Json.write(sorted(value));
  }

  private static @Nullable Object sorted(@Nullable Object value) {
    if (value instanceof Map<?, ?> members) {
      Map<String, @Nullable Object> sorted = new TreeMap<>();
      for (Map.Entry<?, ?> member : members.entrySet()) {
        sorted.put(String.valueOf(member.getKey()), sorted(member.getValue()));
      }
      return sorted;
    }
    if (value instanceof List<?> items) {
      List<@Nullable Object> sorted = new ArrayList<>(items.size());
      for (Object item : items) {
        sorted.add(sorted(item));
      }
      return sorted;
    }
    return value;
  }

  private void log(
      System.Logger.Level level, String event, String body, Map<String, ?> attributes) {
    Map<String, @Nullable Object> merged = worker.taskAttributes(task);
    merged.putAll(attributes);
    merged.put("workhorse.worker.id", worker.workerId());
    worker.log(level, event, body, merged);
  }
}
