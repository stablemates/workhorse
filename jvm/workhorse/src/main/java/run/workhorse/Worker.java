package run.workhorse;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Type;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.ContractSchema;
import run.workhorse.internal.Heartbeat;
import run.workhorse.internal.Json;
import run.workhorse.internal.JsonbSize;
import run.workhorse.internal.Listener;
import run.workhorse.internal.PgjdbcVersion;
import run.workhorse.internal.Row;
import run.workhorse.internal.SdkVersion;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.internal.Suspension;
import run.workhorse.internal.Values;
import run.workhorse.internal.telemetry.WorkerTelemetry;

/**
 * Claims tasks from PostgreSQL and runs their handlers under renewed leases. The counterpart of
 * Ruby's {@code Stablemates::Workhorse::Worker} (ADR 0103, "Worker surface").
 *
 * <p>Each handler runs on its own virtual thread, or on the caller's {@link ExecutorService}. The
 * slot accounting bounds the claimed tasks at {@link #concurrency}. Every write an attempt makes
 * carries its fence token, so an attempt that lost its lease cannot change the task.
 *
 * <p>On a fast-tier queue (ADR 0077), a completion also claims the next tasks in the same
 * statement, and the slots split into {@link #cohorts}. A batch handler from {@link
 * Builder#handleBatch} receives the tasks of one queue together, and each task settles on its own.
 *
 * <p>{@link #run} blocks until {@link #stop}. A stopping worker claims nothing new and waits up to
 * {@code shutdownGrace} for running handlers. It then cancels the rest with {@link
 * CancellationReason#SHUTDOWN}, interrupts their threads, and gives them one short unwind window.
 * If a handler still runs after that window, {@code run} throws {@link
 * ShutdownIncompleteException}. A handler that stops for the shutdown, by a {@link
 * CancelledException} with that reason or by an {@link InterruptedException}, returns its task to
 * the queue without charging the attempt.
 *
 * <p>The worker installs no JVM shutdown hook and traps no signal. The process owner calls {@link
 * #stop} or {@link #close}, or calls {@link WorkerProcess#runWorkerProcess}.
 */
public final class Worker implements AutoCloseable {
  private static final long MAX_EMPTY_POLL_MS = 5_000;
  private static final long NOTIFICATION_POLL_MS = 5_000;
  private static final long DEFAULT_POLL_MS = 250;
  private static final long NOTIFICATION_CLAIM_DELAY_MS = 50;
  private static final long UNWIND_WINDOW_NANOS = TimeUnit.MILLISECONDS.toNanos(250);
  private static final long IDLE_CHECK_NANOS = TimeUnit.MILLISECONDS.toNanos(50);
  private static final long EXPIRATION_RETRY_NANOS = TimeUnit.MILLISECONDS.toNanos(5);
  private static final long DEREGISTER_NANOS = TimeUnit.SECONDS.toNanos(1);
  private static final long NEVER = Long.MIN_VALUE;
  private static final long TIER_PROBE_NANOS = TimeUnit.SECONDS.toNanos(30);
  private static final int COMPLETION_BATCH_LIMIT = 100;
  private static final int MAX_RETRY_DELAY_MS = Integer.MAX_VALUE;
  private static final int CAUSE_DEPTH = 16;
  private static final String REDACTED_NAME = "RedactedTaskError";
  private static final String REDACTED_MESSAGE = "Task handler failed; details redacted";
  private static final String GENERIC_NAME = "Exception";
  private static final String LANGUAGE = "java";
  private static final List<String> FORBIDDEN_NAME_CHARACTERS = List.of("*", ".", "<", " ");
  private static final Pattern EXPONENT_NUMBER = Pattern.compile("\\d[eE]");

  /** How the worker settled one attempt. The first submission wins. */
  enum Outcome {
    COMPLETED,
    FAILED,
    RETRY,
    LEASE_EXPIRED,
    RELEASED,
    DEADLINE_EXCEEDED,
    ATTEMPT_TIMEOUT,
    CANCELLED,
    SUSPENDED_FOR_WAIT,
    SUSPENDED_FOR_CHILD
  }

  private final DataSource dataSource;
  private final ConnectionSource connections;
  private final Queue queue;
  private final List<String> queueNames;
  private final String workerId;
  private final int concurrency;
  private final int refillBatch;
  private final int cohorts;
  private final @Nullable ExecutorService executor;
  private final long leaseMs;
  private final long heartbeatMs;
  private final long pollMs;
  private final long notificationPollMs;
  private final boolean pollingOnly;
  private final long maintenanceMs;
  private final long routineMs;
  private final long registryMs;
  private final List<String> scheduleNamespaces;
  private final int scheduleCatchupLimit;
  private final long shutdownGraceNanos;
  private final @Nullable RetryDelay retryDelay;
  private final @Nullable Consumer<Throwable> onRegistrationError;
  private final @Nullable Consumer<Throwable> onNotificationError;
  private final System.Logger logger;
  private final WorkerTelemetry telemetry;
  private final JsonCodec codec;
  private final Map<String, Registration> handlers;
  private final Map<String, BatchCoordinator> coordinators;
  private final Heartbeat heartbeat;
  private final @Nullable String sdkVersion;
  private final String hostname;

  /**
   * Guards the slot accounting of each run, the queue tiers, and the claim order, which handler
   * threads share with the dispatch loop.
   */
  private final ReentrantLock stateLock = new ReentrantLock();

  /** The queues that rejected a fast-tier statement, each until its next probe. */
  private final Map<String, Long> fullTierUntil = new HashMap<>();

  /** The queues that answered a fast-tier statement. */
  private final Set<String> fastTierQueues = new HashSet<>();

  private final Slots slots;

  private long dispatchSequence;

  /** Guards {@link #pendingCompletions}. */
  private final ReentrantLock completionLock = new ReentrantLock();

  /** The completions that wait for the next statement of each key. */
  private final Map<CompletionKey, List<PendingCompletion>> pendingCompletions = new HashMap<>();

  private final Wake wake = new Wake();
  private final AtomicLong stopVersion = new AtomicLong();
  private final AtomicBoolean locallyPaused = new AtomicBoolean();
  private final AtomicBoolean remotelyPaused = new AtomicBoolean();
  private final AtomicBoolean notified = new AtomicBoolean();
  private final AtomicBoolean registered = new AtomicBoolean();
  private final AtomicLong nextQueueIndex = new AtomicLong();
  private final AtomicLong lastMaintenanceAt = new AtomicLong(NEVER);
  private final AtomicLong lastRoutineAt = new AtomicLong(NEVER);
  // Each attempt is its own element: a retry of the same task can run beside an attempt that
  // still unwinds, so a task ID does not identify one attempt.
  private final Set<Active> active = ConcurrentHashMap.newKeySet();
  private final Map<List<String>, ContractSchema> resultContracts = new ConcurrentHashMap<>();
  private final ReentrantLock runLock = new ReentrantLock();

  /**
   * The runs in progress. {@link #close} also takes {@link #runLock}, so the lock state cannot show
   * a run.
   */
  private final AtomicInteger runs = new AtomicInteger();

  private final AtomicReference<@Nullable Thread> started = new AtomicReference<>();
  private final AtomicReference<@Nullable Throwable> startedFailure = new AtomicReference<>();
  private volatile long lastRegistryAt = NEVER;

  /** The end of the shutdown grace of the current stop, or {@link #NEVER} before a stop. */
  private final AtomicLong stopDeadline = new AtomicLong(NEVER);

  /** Counts runs, so a registry write of an earlier run never reaches a later one. */
  private final AtomicLong generation = new AtomicLong();

  /**
   * The latest registry write. Each write waits for the one before it, so they keep their order.
   */
  private final AtomicReference<@Nullable Thread> registryWrite = new AtomicReference<>();

  private final ReentrantLock registryLock = new ReentrantLock();

  /**
   * A test hook that runs between the stop check and the deadline reset at the start of a run. A
   * test holds the run there and calls {@link #stop} to reach the race of that window. It is {@code
   * null} in production, and no public API sets it.
   */
  volatile @Nullable Runnable beforeDeadlineReset;

  /**
   * A test hook that receives each {@code complete_many_and_claim_v1} statement that PostgreSQL
   * accepted. It is {@code null} in production, and no public API sets it.
   */
  volatile @Nullable Consumer<FusedStatement> fusedStatementHook;

  /** One fused statement: its completions, its claim limit, and the tasks it claimed. */
  record FusedStatement(int completions, int claimLimit, int claimed) {}

  private void reportFused(int completions, int claimLimit, int claimed) {
    Consumer<FusedStatement> hook = fusedStatementHook;
    if (hook != null) {
      hook.accept(new FusedStatement(completions, claimLimit, claimed));
    }
  }

  private volatile UUID instanceId = UUID.randomUUID();
  private volatile boolean draining;

  private Worker(Builder builder) {
    PgjdbcVersion.require();
    this.dataSource = builder.dataSource;
    this.connections = ConnectionSource.of(dataSource);
    this.queueNames = builder.queues;
    this.workerId =
        builder.workerId != null
            ? builder.workerId
            : localHostname()
                + "-"
                + ProcessHandle.current().pid()
                + "-"
                + HexFormat.of().formatHex(randomBytes(4));
    this.concurrency = builder.concurrency;
    // A claim waits for a quarter of the slots, so at most four claims are in flight.
    this.refillBatch = (concurrency + 3) / 4;
    this.cohorts = builder.cohorts != null ? builder.cohorts : defaultCohorts(concurrency);
    if (cohorts > concurrency) {
      throw new IllegalArgumentException("cohorts must be between 1 and concurrency");
    }
    this.slots = new Slots(concurrency, refillBatch, cohorts);
    this.executor = builder.executor;
    this.leaseMs = builder.leaseMs;
    this.heartbeatMs =
        builder.heartbeatMs != null ? builder.heartbeatMs : Math.max(100, leaseMs / 3);
    if (heartbeatMs >= leaseMs) {
      throw new IllegalArgumentException("heartbeat must be positive and less than lease");
    }
    this.pollMs = builder.pollMs != null ? builder.pollMs : DEFAULT_POLL_MS;
    this.notificationPollMs = builder.pollMs != null ? builder.pollMs : NOTIFICATION_POLL_MS;
    this.pollingOnly = builder.pollingOnly;
    this.maintenanceMs = builder.maintenanceMs;
    this.routineMs = builder.routineMs;
    this.registryMs = builder.disableRegistry ? 0 : builder.registryMs;
    this.scheduleNamespaces = builder.scheduleNamespaces;
    this.scheduleCatchupLimit = builder.scheduleCatchupLimit;
    this.shutdownGraceNanos = TimeUnit.MILLISECONDS.toNanos(builder.shutdownGraceMs);
    this.retryDelay = builder.retryDelay;
    this.onRegistrationError = builder.onRegistrationError;
    this.onNotificationError = builder.onNotificationError;
    this.logger = builder.logger;
    this.telemetry = new WorkerTelemetry(builder.telemetry.telemetry());
    this.codec = builder.codec;
    this.handlers = Map.copyOf(builder.handlers);
    Map<String, BatchCoordinator> batches = new HashMap<>();
    for (Map.Entry<String, Registration> entry : handlers.entrySet()) {
      Registration registration = entry.getValue();
      BatchOptions options = registration.batchOptions;
      BatchHandler<?> batchHandler = registration.batchHandler;
      if (options != null && batchHandler != null) {
        if (options.maxSize() > concurrency) {
          throw new IllegalArgumentException("maxSize must not exceed worker concurrency");
        }
        batches.put(
            entry.getKey(), new BatchCoordinator(this, entry.getKey(), options, batchHandler));
      }
    }
    this.coordinators = Map.copyOf(batches);
    this.queue =
        new Queue(
            connections,
            QueueOptions.builder()
                .defaultQueue(queueNames.get(0))
                .codec(codec)
                .telemetry(builder.telemetry)
                .build());
    this.heartbeat =
        builder.sharedHeartbeats
            ? Heartbeat.borrowing(dataSource)
            : Heartbeat.dedicated(dataSource);
    this.sdkVersion = SdkVersion.current();
    this.hostname = localHostname();
  }

  /**
   * A builder for a worker that claims through {@code dataSource}.
   *
   * <p>Each claim and each other statement borrows a connection for its own duration. Every worker
   * on one {@code DataSource} shares one dedicated heartbeat connection, and each worker holds one
   * listener connection while it runs. So the pool needs two held connections plus one for each
   * claim in flight.
   */
  public static Builder builder(DataSource dataSource) {
    return new Builder(dataSource);
  }

  /** The queue that the durable context writes child requests and group adds through. */
  Queue queue() {
    return queue;
  }

  /** The codec of payloads, results, and durable values. */
  JsonCodec codec() {
    return codec;
  }

  /** The worker's ID in the fleet registry. */
  public String workerId() {
    return workerId;
  }

  /** The queues this worker claims from, in claim order. */
  public List<String> queues() {
    return queueNames;
  }

  /** The most tasks this worker runs at once. */
  public int concurrency() {
    return concurrency;
  }

  /** The number of slot cohorts that fast-tier dispatch splits the concurrency into. */
  public int cohorts() {
    return cohorts;
  }

  /**
   * The cohorts of a worker without the option: one below concurrency 8, and otherwise one for each
   * 8 slots, from 2 to 8. A {@code DataSource} reports no pool size, so the pool does not lower it.
   */
  static int defaultCohorts(int concurrency) {
    return concurrency < 8 ? 1 : Math.clamp((concurrency + 7) / 8, 2, 8);
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle

  /**
   * Claims and runs tasks until {@link #stop}, then drains.
   *
   * @throws ShutdownIncompleteException if a handler still runs after the drain
   * @throws WorkhorseException for the first error that ended the run
   */
  public void run() {
    runFrom(stopVersion.get());
  }

  /**
   * Claims and runs tasks until a claim finds no handled task, then drains. It opens no listener
   * and does no startup maintenance pass.
   *
   * @return whether a handled task ran
   */
  public boolean runOnce() {
    long version = stopVersion.get();
    runLock.lock();
    runs.incrementAndGet();
    try {
      return runLoop(false, version);
    } finally {
      runs.decrementAndGet();
      runLock.unlock();
    }
  }

  /**
   * Runs {@link #run} on a worker-owned platform thread, and returns at once.
   *
   * @throws IllegalStateException if the worker already runs on its own thread
   */
  public void start() {
    long version = stopVersion.get();
    Thread thread =
        new Thread(
            () -> {
              try {
                runFrom(version);
              } catch (Throwable error) {
                startedFailure.set(error);
              }
            },
            "workhorse-worker-" + workerId);
    Thread previous = started.get();
    if ((previous != null && previous.isAlive()) || !started.compareAndSet(previous, thread)) {
      throw new IllegalStateException("the worker already runs on its own thread");
    }
    startedFailure.set(null);
    thread.start();
  }

  /** Ends claiming. A running {@link #run} drains its handlers and returns. */
  public void stop() {
    long deadline = System.nanoTime() + shutdownGraceNanos;
    stopDeadline.accumulateAndGet(deadline, (current, next) -> current == NEVER ? next : current);
    stopVersion.incrementAndGet();
    log(
        System.Logger.Level.INFO,
        "workhorse.worker.stop_requested",
        "Worker stop requested",
        Map.of("workhorse.worker.active_slots", active.size()));
    wakeDispatcher();
  }

  /**
   * Stops the worker and waits for the drain. If the worker ran through {@link #start} and its run
   * failed, this method throws that failure.
   */
  @Override
  public void close() {
    stop();
    Thread thread = started.get();
    if (thread != null && !thread.equals(Thread.currentThread())) {
      boolean interrupted = false;
      while (true) {
        try {
          thread.join();
          break;
        } catch (InterruptedException error) {
          interrupted = true;
        }
      }
      if (interrupted) {
        Thread.currentThread().interrupt();
      }
    }
    // Waits for a run on another thread to finish its drain.
    runLock.lock();
    try {
      // Nothing to do while the lock is held.
    } finally {
      runLock.unlock();
    }
    Throwable failure = startedFailure.getAndSet(null);
    if (failure instanceof RuntimeException runtime) {
      throw runtime;
    }
    if (failure instanceof Error error) {
      throw error;
    }
  }

  /** Starts no claim until {@link #resume}. Running handlers continue. */
  public void pause() {
    locallyPaused.set(true);
    log(System.Logger.Level.INFO, "workhorse.worker.paused", "Worker paused locally", Map.of());
    wakeDispatcher();
  }

  /** Ends a local pause. An operator's remote pause stays. */
  public void resume() {
    locallyPaused.set(false);
    log(System.Logger.Level.INFO, "workhorse.worker.resumed", "Worker resumed locally", Map.of());
    wakeDispatcher();
  }

  /** Whether this worker or an operator paused it. */
  public boolean isPaused() {
    return locallyPaused.get() || remotelyPaused.get();
  }

  /**
   * Whether a run of this worker is in progress: from {@link #start} until its thread ends, or from
   * the start of {@link #run} or {@link #runOnce} until it returns or throws, including the drain.
   * The worker counts the runs in progress. A {@link #close} that waits for a run is not a run.
   */
  public boolean isRunning() {
    Thread thread = started.get();
    return (thread != null && thread.isAlive()) || runs.get() > 0;
  }

  /** The stop version that {@link #runFrom} compares with. {@link WorkerProcess} reads it. */
  long stopVersion() {
    return stopVersion.get();
  }

  /**
   * Runs until a {@link #stop} issued after {@code version} was read. The process helper reads the
   * version before it registers its hook, so a signal that arrives before the loop starts still
   * stops it.
   */
  void runFrom(long version) {
    runLock.lock();
    runs.incrementAndGet();
    try {
      runLoop(true, version);
    } finally {
      runs.decrementAndGet();
      runLock.unlock();
    }
  }

  private boolean stopRequested(long version) {
    return stopVersion.get() != version;
  }

  // ---------------------------------------------------------------------------------------------
  // Run loop

  /** The state of one run that handler and claim threads share with the dispatch loop. */
  private static final class RunState {
    final long version;
    final List<Throwable> errors = new CopyOnWriteArrayList<>();
    final List<RuntimeException> maintenanceErrors = new CopyOnWriteArrayList<>();
    final ConcurrentLinkedQueue<ClaimResult> results = new ConcurrentLinkedQueue<>();

    /** False once the stop abandons claims in flight. A late claim then releases its slots. */
    final AtomicBoolean claimsOpen = new AtomicBoolean(true);

    final long generation;

    // The dispatch progress of this run. Each field changes under the state lock, because
    // fast-tier completions read and change it too.
    @Nullable Listener listener;
    int empty;
    @Nullable EmptyWait emptyWait;
    boolean passEnded;
    boolean claimedAny;
    @Nullable RuntimeException claimError;

    /** False once the dispatch loop ends, so completions stop claiming with it. */
    boolean open = true;

    @Nullable Thread maintenance;

    /**
     * The end of the shutdown grace, a {@link System#nanoTime} value. The run loop sets it when it
     * stops claiming, and every later step of the stop waits until it at most.
     */
    long deadline;

    RunState(long version, long generation) {
      this.version = version;
      this.generation = generation;
    }
  }

  /**
   * The worker's slot accounting, which the dispatch loop and fast-tier completions share. Every
   * field changes under {@link #stateLock}. A slot is busy while its task is admitted, reserved
   * while a claim for it is in flight, and handed over once a completion claimed a task into it.
   * Handed-over slots count as free, because the task that fills them is already admitted. On the
   * fast tier the slots split into cohorts (ADR 0076). The accounting outlives a run, so a handler
   * that an incomplete stop abandoned keeps its slot in the next run.
   */
  private static final class Slots {
    final int concurrency;
    final int refillBatch;
    final int[] capacity;
    final int[] busy;
    final int[] handedOver;
    final int[] reserved;
    final int[] claims;
    int busyTotal;
    int handedOverTotal;
    int reservedTotal;
    int wholeClaims;

    Slots(int concurrency, int refillBatch, int cohorts) {
      this.concurrency = concurrency;
      this.refillBatch = refillBatch;
      // Spreads the remainder over the first cohorts, so sizes differ by at most one slot.
      this.capacity = new int[cohorts];
      for (int cohort = 0; cohort < cohorts; cohort++) {
        capacity[cohort] = concurrency / cohorts + (cohort < concurrency % cohorts ? 1 : 0);
      }
      this.busy = new int[cohorts];
      this.handedOver = new int[cohorts];
      this.reserved = new int[cohorts];
      this.claims = new int[cohorts];
    }

    int free() {
      return concurrency - busyTotal + handedOverTotal - reservedTotal;
    }

    int cohortFree(int cohort) {
      return capacity[cohort] - busy[cohort] + handedOver[cohort] - reserved[cohort];
    }

    /** The cohort with the most free slots, the lowest index on a tie. */
    int roomiest() {
      int best = 0;
      for (int cohort = 1; cohort < capacity.length; cohort++) {
        if (cohortFree(cohort) > cohortFree(best)) {
          best = cohort;
        }
      }
      return best;
    }
  }

  /**
   * One plain claim: its limit, its cohort ({@link #WHOLE} for the whole worker), and the slots it
   * reserved in that cohort.
   */
  private record ClaimPlan(int limit, int cohort, int cohortLimit) {}

  private static final int WHOLE = -1;

  /** What one claim returned. */
  private record ClaimResult(
      ClaimPlan plan, List<Claimed> claimed, long wakeVersion, @Nullable RuntimeException error) {}

  /**
   * One claimed task with its payload text, the monotonic time its claim left, its tier read, and
   * whether a fast-tier statement claimed it. Only such a task completes through the fused
   * statement.
   */
  record Claimed(
      ClaimedTask task,
      String payload,
      long startedAt,
      BooleanSupplier fastTier,
      boolean fastClaimed) {}

  /**
   * One shared, deferred read of whether a queue is on the fast tier, for the tasks of one {@code
   * claim_many_v1} call. That function claims a fast-tier queue through {@code fast_claim_v1}, so a
   * queue that moved to the fast tier during the probe interval returns tasks with no tier marker.
   * A handler's first durable call runs the read, once the heartbeat renews the lease, and not the
   * claim, where a slow read would spend leases that nothing renews yet. The tier cannot change
   * while the queue has live tasks, so one read holds for every task of the claim. A failed read is
   * not kept, so the next durable call reads again. A fast answer ends the probe interval.
   */
  private final class TierRead {
    private final String queueName;
    private final ReentrantLock lock = new ReentrantLock();
    private @Nullable Boolean fast;

    TierRead(String queueName) {
      this.queueName = queueName;
    }

    boolean fast() {
      lock.lock();
      try {
        if (fast == null) {
          boolean found = false;
          for (Row control : rows(SqlCatalogue.QUEUE_CONTROL)) {
            if (queueName.equals(control.text("queue_name"))) {
              found = "fast".equals(control.text("tier"));
            }
          }
          if (found) {
            markFastTier(queueName);
          }
          fast = found;
        }
        return fast;
      } finally {
        lock.unlock();
      }
    }
  }

  /**
   * An empty-claim wait. A {@code null} version marks a release wait, which a wake does not end.
   */
  private record EmptyWait(long deadline, @Nullable Long version) {}

  private boolean runLoop(boolean continuous, long version) {
    try {
      return runLoopOnce(continuous, version);
    } finally {
      // The deadline belongs to this run's stop. Without the reset, a stop that reaches the next
      // run before its stop check would keep this run's expired deadline.
      stopDeadline.set(NEVER);
    }
  }

  private boolean runLoopOnce(boolean continuous, long version) {
    if (!stopRequested(version)) {
      Runnable hook = beforeDeadlineReset;
      if (hook != null) {
        hook.run();
      }
      stopDeadline.set(NEVER);
    }
    RunState run = new RunState(version, generation.incrementAndGet());
    // Every step before the claims waits only until the stop deadline, so a stalled statement
    // cannot keep a stop from its drain.
    if (!step(queue::assertCompatible, run, "compatibility check")) {
      return false;
    }
    instanceId = UUID.randomUUID();
    registered.set(false);
    draining = false;
    Listener listener = null;
    boolean claimedAny;
    int abandoned;
    try {
      if (continuous && !pollingOnly) {
        Consumer<Throwable> errors = onNotificationError;
        listener =
            Listener.start(
                dataSource,
                queueNames,
                this::notifyWake,
                error -> {
                  if (errors != null) {
                    errors.accept(error);
                  }
                });
      }
      step(
          () -> joinQuietly(registryStep(() -> refreshRegistration(true, run.generation))),
          run,
          "registration");
      log(
          System.Logger.Level.INFO,
          "workhorse.worker.started",
          "Worker started",
          Map.of(
              "workhorse.worker.concurrency", concurrency, "workhorse.worker.queues", queueNames));
      if (continuous && !stopRequested(version)) {
        // ADR 0078: a long-running worker starts its first claim beside its startup maintenance.
        startMaintenance(run);
      }
      claimedAny = dispatch(continuous, run, listener);
    } finally {
      if (run.deadline == 0) {
        run.deadline = shutdownDeadline(run);
      }
      Thread maintenance = run.maintenance;
      if (maintenance != null) {
        joinUntil(maintenance, run.deadline, "maintenance");
      }
      if (listener != null) {
        listener.close(run.deadline);
      }
      draining = true;
      joinUntil(
          registryStep(() -> refreshRegistration(true, run.generation)),
          run.deadline,
          "draining registration");
      abandoned = drain(run.deadline);
      // The deregistration waits for the draining registration, so a late registration cannot
      // recreate the row of a stopped worker.
      joinUntil(
          registryStep(() -> deregister(run.generation)),
          System.nanoTime() + DEREGISTER_NANOS,
          "deregistration");
      log(
          System.Logger.Level.INFO,
          "workhorse.worker.stopped",
          "Worker stopped",
          Map.of("workhorse.worker.active_slots", abandoned));
    }
    if (abandoned > 0) {
      throw new ShutdownIncompleteException(abandoned);
    }
    if (!run.maintenanceErrors.isEmpty()) {
      throw run.maintenanceErrors.get(0);
    }
    if (!run.errors.isEmpty()) {
      throw unchecked(run.errors.get(0));
    }
    return claimedAny;
  }

  /**
   * Keeps the slots full without one serial claim round trip for each task (ADR 0076). A claim
   * reserves the slots it asks for, so claimed tasks never exceed the concurrency. With no claim in
   * flight, any free slot starts one. While one is in flight, another starts only once the free
   * slots reach the refill batch, so a busy worker claims in batches. A fast-tier completion claims
   * too, from the same accounting (ADR 0077). On the fast tier the slots split into cohorts, and
   * plain claims leave one at a time, each for the roomiest cohort.
   */
  private boolean dispatch(boolean continuous, RunState run, @Nullable Listener listener) {
    stateLock.lock();
    try {
      run.listener = listener;
    } finally {
      stateLock.unlock();
    }
    int inFlight = 0;
    try {
      while (true) {
        wake.reset();
        ClaimResult result;
        while ((result = run.results.poll()) != null) {
          inFlight--;
          settleClaim(result, run);
        }
        refreshRegistrationIfDue(run);
        RuntimeException claimError;
        boolean passEnded;
        int empty;
        EmptyWait emptyWait;
        stateLock.lock();
        try {
          claimError = run.claimError;
          passEnded = run.passEnded;
          empty = run.empty;
          emptyWait = run.emptyWait;
        } finally {
          stateLock.unlock();
        }
        if (stopRequested(run.version)
            || !run.errors.isEmpty()
            || claimError != null
            || !run.maintenanceErrors.isEmpty()) {
          break;
        }
        if (!continuous && passEnded) {
          break;
        }
        if (isPaused()) {
          if (!continuous) {
            break;
          }
          // A pause ends the empty wait, so a resume claims at once. A release wait ignores the
          // wake of the resume, so it must end here.
          stateLock.lock();
          try {
            run.emptyWait = null;
          } finally {
            stateLock.unlock();
          }
          wake.await(dispatchWait(empty, listener));
          continue;
        }
        if (emptyWait != null) {
          long remaining = emptyWait.deadline - System.nanoTime();
          Long seen = emptyWait.version;
          if (remaining <= 0 || (seen != null && seen != wake.version())) {
            stateLock.lock();
            try {
              if (emptyWait.equals(run.emptyWait)) {
                run.emptyWait = null;
              }
            } finally {
              stateLock.unlock();
            }
          } else {
            wake.await(remaining);
          }
          continue;
        }
        if (planClaim(inFlight) != null) {
          if (continuous) {
            startMaintenance(run);
          } else {
            if (!step(() -> maintenanceStep(run), run, "maintenance")) {
              break;
            }
          }
          ClaimPlan plan;
          long wakeVersion = wake.version();
          while ((plan = reserveClaim(inFlight)) != null) {
            inFlight++;
            startClaim(plan, wakeVersion, empty > 0, run);
          }
        }
        wake.await(dispatchWait(empty, listener));
      }
    } finally {
      run.deadline = shutdownDeadline(run);
      stateLock.lock();
      try {
        run.open = false;
      } finally {
        stateLock.unlock();
      }
      // Tasks that an in-flight claim returns hold leases, so they run before the drain. The wait
      // ends at the shutdown deadline, but it lasts one unwind window at least, so a zero grace
      // still takes a claim that is about to return. A claim that returns later is not run: its
      // leases expire, and recovery returns its tasks to the queue.
      long now = System.nanoTime();
      long claimDeadline = now + Math.max(run.deadline - now, UNWIND_WINDOW_NANOS);
      while (inFlight > 0) {
        ClaimResult result = run.results.poll();
        if (result == null) {
          long remaining = claimDeadline - System.nanoTime();
          if (remaining <= 0) {
            log(
                System.Logger.Level.WARNING,
                "workhorse.worker.claims_abandoned",
                "Claims still in flight at the shutdown deadline were abandoned",
                Map.of("workhorse.worker.claims", inFlight));
            run.claimsOpen.set(false);
            releaseLateClaims(run);
            break;
          }
          wake.reset();
          if (run.results.isEmpty()) {
            wake.await(Math.min(remaining, IDLE_CHECK_NANOS));
          }
          continue;
        }
        inFlight--;
        settleClaim(result, run);
      }
    }
    stateLock.lock();
    try {
      if (run.claimError != null) {
        throw run.claimError;
      }
      return run.claimedAny;
    } finally {
      stateLock.unlock();
    }
  }

  private @Nullable ClaimPlan planClaim(int inFlight) {
    stateLock.lock();
    try {
      return claimPlan(inFlight);
    } finally {
      stateLock.unlock();
    }
  }

  /**
   * Plans the next plain claim and reserves its slots under one lock, so a fused completion cannot
   * reserve the same free slots in between.
   */
  private @Nullable ClaimPlan reserveClaim(int inFlight) {
    stateLock.lock();
    try {
      ClaimPlan plan = claimPlan(inFlight);
      if (plan != null) {
        slots.reservedTotal += plan.limit;
        if (plan.cohort == WHOLE) {
          slots.wholeClaims++;
        } else {
          slots.claims[plan.cohort]++;
          slots.reserved[plan.cohort] += plan.cohortLimit;
        }
      }
      return plan;
    } finally {
      stateLock.unlock();
    }
  }

  /** Gives back the slots a plain claim reserved. The caller holds {@link #stateLock}. */
  private void unreserve(ClaimPlan plan) {
    slots.reservedTotal -= plan.limit;
    if (plan.cohort == WHOLE) {
      slots.wholeClaims--;
    } else {
      slots.claims[plan.cohort]--;
      slots.reserved[plan.cohort] -= plan.cohortLimit;
    }
  }

  /**
   * Plans the next plain claim, or returns {@code null}. With one cohort, or while a queue answers
   * on the full tier, a claim takes every free slot of the worker. Otherwise one claim at a time
   * leaves, for the roomiest cohort. The caller holds {@link #stateLock}.
   */
  private @Nullable ClaimPlan claimPlan(int inFlight) {
    int free = slots.free();
    if (free <= 0) {
      return null;
    }
    if (cohorts == 1 || !fullTierUntil.isEmpty()) {
      if (inFlight > 0 && free < slots.refillBatch) {
        return null;
      }
      return new ClaimPlan(free, WHOLE, free);
    }
    if (inFlight > 0) {
      return null;
    }
    int cohort = slots.roomiest();
    int cohortLimit = Math.min(free, slots.cohortFree(cohort));
    if (fastTierQueues.containsAll(queueNames)) {
      return cohortLimit > 0 ? new ClaimPlan(cohortLimit, cohort, cohortLimit) : null;
    }
    // A claim that still has to learn a queue's tier reserves every free slot, so a queue that
    // answers on the full tier fills them all.
    return new ClaimPlan(free, cohort, Math.max(0, cohortLimit));
  }

  /**
   * Admits the tasks one claim returned, gives back its unused slots, and records whether it made
   * progress.
   */
  private void settleClaim(ClaimResult result, RunState run) {
    stateLock.lock();
    try {
      unreserve(result.plan);
      // A claimed task holds a lease, so it runs even when the loop is stopping or failed.
      for (Claimed claimed : result.claimed) {
        admit(claimed, result.plan.cohort, run);
      }
      settleClaimProgress(run, result.claimed, result.wakeVersion, result.error);
    } finally {
      stateLock.unlock();
    }
  }

  /** Records whether a returned plain claim made progress. The caller holds {@link #stateLock}. */
  private void settleClaimProgress(
      RunState run, List<Claimed> claimed, long wakeVersion, @Nullable RuntimeException error) {
    if (error instanceof IsolationLevelException isolation) {
      // The pool runs above read committed. The worker logs it and claims again after the wait.
      log(
          System.Logger.Level.WARNING,
          "workhorse.worker.claim_isolation",
          "Claims need read committed isolation; configure the pool at read committed",
          Map.of("workhorse.isolation_level", isolation.isolationLevel()));
      run.empty++;
      run.emptyWait =
          new EmptyWait(System.nanoTime() + dispatchWait(run.empty, run.listener), null);
      return;
    }
    if (error != null) {
      if (run.claimError == null) {
        run.claimError = error;
      }
      return;
    }
    boolean handled = false;
    for (Claimed task : claimed) {
      handled |= handlers.containsKey(task.task.type());
    }
    if (handled) {
      run.empty = 0;
      run.claimedAny = true;
      run.emptyWait = null;
      return;
    }
    // A claim that only handed its tasks back made no progress, so it backs off as an empty claim
    // does instead of spinning on a task that no handler here runs.
    run.empty++;
    run.passEnded = true;
    long deadline = System.nanoTime() + dispatchWait(run.empty, run.listener);
    if (claimed.isEmpty()) {
      if (run.emptyWait == null) {
        run.emptyWait = new EmptyWait(deadline, wakeVersion);
      }
    } else if (run.emptyWait == null || run.emptyWait.version != null) {
      // A release wait. Each release notifies the queue, so a wake does not end this wait.
      run.emptyWait = new EmptyWait(deadline, null);
    }
  }

  /** Runs one claim on its own virtual thread. The dispatch loop already reserved its slots. */
  private void startClaim(ClaimPlan plan, long wakeVersion, boolean backingOff, RunState run) {
    // The notification delay spreads idle workers that one notification woke together. A worker
    // whose last claim found work would claim now anyway, so it skips the delay.
    boolean delayed = notified.getAndSet(false) && backingOff;
    Thread.ofVirtual()
        .name("workhorse-claim")
        .start(
            () -> {
              List<Claimed> claimed = new ArrayList<>();
              RuntimeException error = null;
              try {
                if (delayed) {
                  Thread.sleep(
                      ThreadLocalRandom.current().nextLong(NOTIFICATION_CLAIM_DELAY_MS + 1));
                }
                // A worker paused or stopped during the delay sends no claim.
                boolean withdrawn = delayed && (stopRequested(run.version) || isPaused());
                if (!withdrawn) {
                  claimAcrossQueues(
                      plan.limit, claimed, plan.cohort == WHOLE ? plan.limit : plan.cohortLimit);
                }
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
              } catch (RuntimeException failure) {
                error = failure;
              } finally {
                run.results.add(new ClaimResult(plan, claimed, wakeVersion, error));
                wake.signal();
                if (!run.claimsOpen.get()) {
                  releaseLateClaims(run);
                }
              }
            });
  }

  /**
   * Claims from each queue at most once, starting one queue further on each call. Appends to {@code
   * claimed} as each queue answers, so a later queue's error keeps the leases already taken.
   * Fast-tier queues together give at most {@code fastLimit} tasks, the free slots of one cohort.
   */
  private void claimAcrossQueues(int limit, List<Claimed> claimed, int fastLimit) {
    int size = queueNames.size();
    int start = (int) Math.floorMod(nextQueueIndex.getAndIncrement(), (long) size);
    for (int offset = 0; offset < size && claimed.size() < limit; offset++) {
      String name = queueNames.get((start + offset) % size);
      int free = limit - claimed.size();
      telemetry.claim(name, () -> claim(name, free, fastLimit - claimed.size(), claimed));
    }
  }

  private void claim(String name, int limit, int fastLimit, List<Claimed> claimed) {
    long startedAt = System.nanoTime();
    List<Row> fast = claimFast(name, limit, fastLimit, startedAt);
    List<Claimed> tasks = new ArrayList<>();
    if (fast != null) {
      for (Row row : fast) {
        tasks.add(claimed(row, name, startedAt, Worker::fastTier, true));
      }
    } else {
      TierRead tier = new TierRead(name);
      List<Row> rows =
          withConnection(
              connection ->
                  Sql.rows(
                      connection,
                      SqlCatalogue.CLAIM_MANY_V1,
                      name,
                      workerId,
                      Integer.toString(limit),
                      Long.toString(leaseMs)));
      for (Row row : rows) {
        tasks.add(claimed(row, name, startedAt, tier::fast, false));
      }
    }
    claimed.addAll(tasks);
    telemetry.claimed(
        name, startedAt, tasks.stream().map(task -> task.task).toList(), fast == null);
    logClaimed(tasks);
  }

  /** The tier read of a task that a fast-tier statement claimed. */
  private static boolean fastTier() {
    return true;
  }

  private static Claimed claimed(
      Row row, String queueName, long startedAt, BooleanSupplier tier, boolean fastClaimed) {
    String payload = row.text("payload");
    return new Claimed(
        claimedTask(row, queueName),
        payload == null ? "null" : payload,
        startedAt,
        tier,
        fastClaimed);
  }

  private void logClaimed(List<Claimed> tasks) {
    for (Claimed task : tasks) {
      log(
          System.Logger.Level.DEBUG,
          "workhorse.task.claimed",
          "Task claimed",
          taskAttributes(task.task));
    }
  }

  /**
   * Claims through the fast tier, or returns {@code null} when the queue is on the full tier. The
   * fast claim is {@code complete_many_and_claim_v1} with no completions. A full-tier queue rejects
   * it, and the worker then claims that queue through {@code claim_many_v1} until the next probe.
   */
  private @Nullable List<Row> claimFast(String name, int limit, int fastLimit, long sentAt) {
    stateLock.lock();
    try {
      Long until = fullTierUntil.get(name);
      if (until != null && until - sentAt > 0) {
        return null;
      }
    } finally {
      stateLock.unlock();
    }
    int claimLimit = Math.min(limit, fastLimit);
    if (claimLimit <= 0) {
      return List.of();
    }
    List<Row> rows;
    try {
      rows =
          withConnection(
              connection ->
                  Sql.fencedRows(
                      connection,
                      SqlCatalogue.COMPLETE_MANY_AND_CLAIM_V1,
                      workerId,
                      new String[0],
                      new String[0],
                      new String[0],
                      name,
                      Integer.toString(claimLimit),
                      Long.toString(leaseMs)));
    } catch (FastTierUnsupportedException fullTier) {
      markFullTier(name, sentAt);
      return null;
    }
    markFastTier(name);
    // A claim that finds nothing still returns one row, with every claim column null.
    List<Row> claimed = new ArrayList<>();
    for (Row row : rows) {
      if (row.text("task_id") != null) {
        claimed.add(row);
      }
    }
    reportFused(0, claimLimit, claimed.size());
    return claimed;
  }

  /** Claims a queue that rejected a fast-tier statement through {@code claim_many_v1}. */
  private void markFullTier(String name, long sentAt) {
    stateLock.lock();
    try {
      fullTierUntil.put(name, sentAt + TIER_PROBE_NANOS);
      fastTierQueues.remove(name);
    } finally {
      stateLock.unlock();
    }
  }

  private void markFastTier(String name) {
    stateLock.lock();
    try {
      fullTierUntil.remove(name);
      fastTierQueues.add(name);
    } finally {
      stateLock.unlock();
    }
  }

  private static ClaimedTask claimedTask(Row row, String queueName) {
    Long timeout = row.longValue("execution_timeout_ms");
    return new ClaimedTask(
        row.requiredUuid("task_id"),
        queueName,
        row.requiredText("task_type"),
        row.requiredInteger("priority"),
        row.json("payload"),
        row.text("contract_version"),
        row.longValue("result_max_bytes"),
        "t".equals(row.text("redact_error_details")),
        row.json("trace_context"),
        row.requiredInteger("attempt"),
        row.requiredInteger("max_attempts"),
        row.json("retry_policy"),
        row.instant("deadline_at"),
        timeout == null ? null : Duration.ofMillis(timeout),
        row.instant("attempt_timeout_at"),
        row.requiredLong("fence_token"),
        row.instant("lease_expires_at"));
  }

  private void notifyWake() {
    notified.set(true);
    wakeDispatcher();
  }

  /** Wakes the run loop for a state change, which also ends an empty-claim wait. */
  private void wakeDispatcher() {
    wake.bump();
  }

  /**
   * The wait before the next claim, in nanoseconds. A listening worker waits for a notification; a
   * polling worker backs off exponentially while claims come back empty.
   */
  private long dispatchWait(int empty, @Nullable Listener listener) {
    long milliseconds;
    if (listener != null && listener.isListening()) {
      milliseconds = notificationPollMs;
    } else {
      int doublings = Math.min(Math.max(0, empty - 1), 20);
      milliseconds = Math.min(MAX_EMPTY_POLL_MS, pollMs << doublings);
    }
    milliseconds =
        Math.max(1, Math.round(milliseconds * ThreadLocalRandom.current().nextDouble(0.9, 1.1)));
    if (registryMs > 0) {
      milliseconds = Math.min(milliseconds, registryMs);
    }
    return TimeUnit.MILLISECONDS.toNanos(milliseconds);
  }

  /**
   * Gives back the slots of claims that returned after the stop abandoned them. Their tasks do not
   * run: their leases expire, and recovery returns them to the queue. Each result is polled once,
   * so the claim thread and the dispatch loop never release the same slots twice.
   */
  private void releaseLateClaims(RunState run) {
    ClaimResult late;
    while ((late = run.results.poll()) != null) {
      stateLock.lock();
      try {
        unreserve(late.plan);
      } finally {
        stateLock.unlock();
      }
    }
  }

  /** The end of the shutdown grace: the deadline of the current stop, or one grace from now. */
  private long shutdownDeadline(RunState run) {
    long deadline = stopDeadline(run);
    return deadline != NEVER ? deadline : System.nanoTime() + shutdownGraceNanos;
  }

  /**
   * The deadline of a stop that this run sees, or {@link #NEVER} without one. A run that resets the
   * deadline as it starts can race a stop, so a stop with no deadline gets one here, one grace from
   * the moment the run sees it.
   */
  private long stopDeadline(RunState run) {
    if (!stopRequested(run.version)) {
      return NEVER;
    }
    stopDeadline.compareAndSet(NEVER, System.nanoTime() + shutdownGraceNanos);
    return stopDeadline.get();
  }

  /**
   * Runs {@code body} on a virtual thread and waits for it. The wait ends early only when a stop
   * passes its deadline, so a stalled statement cannot keep the stop from the drain. Returns {@code
   * false} when the step did not finish. An exception of the step is thrown here.
   */
  private boolean step(Runnable body, RunState run, String name) {
    AtomicReference<@Nullable Throwable> failure = new AtomicReference<>();
    Thread thread =
        Thread.ofVirtual()
            .name("workhorse-" + name.replace(' ', '-'))
            .start(
                () -> {
                  try {
                    body.run();
                  } catch (Throwable error) {
                    failure.set(error);
                  }
                });
    boolean interrupted = false;
    try {
      while (thread.isAlive()) {
        long deadline = stopDeadline(run);
        if (deadline != NEVER && System.nanoTime() - deadline >= 0) {
          log(
              System.Logger.Level.WARNING,
              "workhorse.worker.stop_step_abandoned",
              "A stop step did not finish before the shutdown deadline",
              Map.of("workhorse.worker.stop_step", name));
          return false;
        }
        try {
          thread.join(Duration.ofNanos(IDLE_CHECK_NANOS));
        } catch (InterruptedException error) {
          interrupted = true;
        }
      }
    } finally {
      if (interrupted) {
        Thread.currentThread().interrupt();
      }
    }
    Throwable error = failure.get();
    if (error != null) {
      throw unchecked(error);
    }
    return true;
  }

  /**
   * Starts a maintenance pass on its own virtual thread when none runs, so a slow pass never holds
   * up dispatch or a stop.
   */
  private void startMaintenance(RunState run) {
    Thread running = run.maintenance;
    if (running != null && running.isAlive()) {
      return;
    }
    run.maintenance =
        Thread.ofVirtual()
            .name("workhorse-maintenance")
            .start(
                () -> {
                  try {
                    maintenanceStep(run);
                  } catch (RuntimeException error) {
                    run.maintenanceErrors.add(error);
                  } finally {
                    wake.signal();
                  }
                });
  }

  private void maintenanceStep(RunState run) {
    if (generation.get() == run.generation) {
      runMaintenanceIfDue();
    }
  }

  /** Starts a registry refresh when its interval elapsed and no earlier refresh still runs. */
  private void refreshRegistrationIfDue(RunState run) {
    if (registryMs == 0) {
      return;
    }
    long last = lastRegistryAt;
    if (last != NEVER && System.nanoTime() - last < TimeUnit.MILLISECONDS.toNanos(registryMs)) {
      return;
    }
    Thread previous = registryWrite.get();
    if (previous != null && previous.isAlive()) {
      return;
    }
    registryStep(() -> refreshRegistration(false, run.generation));
  }

  /**
   * Starts a registry write on a virtual thread. The write first waits for the write before it, so
   * the draining registration and the deregistration reach PostgreSQL in that order.
   */
  private Thread registryStep(Runnable body) {
    Thread next;
    registryLock.lock();
    try {
      Thread before = registryWrite.get();
      next =
          Thread.ofVirtual()
              .name("workhorse-registry")
              .unstarted(
                  () -> {
                    if (before != null) {
                      joinQuietly(before);
                    }
                    body.run();
                  });
      registryWrite.set(next);
    } finally {
      registryLock.unlock();
    }
    next.start();
    return next;
  }

  /**
   * Waits until the shutdown deadline, cancels what still runs, interrupts it, and gives it one
   * unwind window. Returns the number of handlers abandoned after that window.
   */
  private int drain(long deadline) {
    // A lingering batch cannot grow once claims stop, so it runs as soon as its members arrive.
    for (BatchCoordinator coordinator : coordinators.values()) {
      coordinator.flush();
    }
    waitUntilIdle(deadline);
    List<Active> remaining = new ArrayList<>(active);
    if (!remaining.isEmpty()) {
      for (Active task : remaining) {
        task.cancellation.cancel(CancellationReason.SHUTDOWN);
        task.interrupt();
      }
      waitUntilIdle(System.nanoTime() + UNWIND_WINDOW_NANOS);
    }
    List<Active> abandoned = new ArrayList<>(active);
    for (Active task : abandoned) {
      if (task.abandonUnstarted()) {
        // The caller's executor never started this task, and now never runs its handler. The
        // drain frees its slot here, because an executor can discard a queued runnable.
        active.remove(task);
        releaseSlot(task);
        continue;
      }
      // The flag goes up before the ownership is read. An attempt that publishes its ownership
      // later reads the flag after that, so one of the two sides always stops the renewal.
      task.abandoned.set(true);
      Ownership ownership = task.ownership.get();
      if (ownership != null) {
        ownership.abandon();
      }
    }
    return abandoned.size();
  }

  private void waitUntilIdle(long deadline) {
    while (!active.isEmpty()) {
      long remaining = deadline - System.nanoTime();
      if (remaining <= 0) {
        return;
      }
      wake.reset();
      if (active.isEmpty()) {
        return;
      }
      wake.await(Math.min(remaining, IDLE_CHECK_NANOS));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Registration and maintenance

  private void refreshRegistration(boolean force, long run) {
    if (registryMs == 0 || generation.get() != run) {
      return;
    }
    long now = System.nanoTime();
    long last = lastRegistryAt;
    if (!force && last != NEVER && now - last < TimeUnit.MILLISECONDS.toNanos(registryMs)) {
      return;
    }
    lastRegistryAt = now;
    int slots = active.size();
    boolean stopping = draining;
    List<Row> rows;
    try {
      rows =
          withConnection(
              // A write that waited for its connection checks again that its run is current.
              connection ->
                  generation.get() != run
                      ? null
                      : Sql.rows(
                          connection,
                          SqlCatalogue.REGISTER_WORKER_V1,
                          workerId,
                          instanceId.toString(),
                          hostname,
                          Long.toString(ProcessHandle.current().pid()),
                          Sql.textArray(queueNames),
                          Sql.textArray(scheduleNamespaces),
                          Integer.toString(concurrency),
                          Long.toString(leaseMs),
                          Long.toString(heartbeatMs),
                          Long.toString(pollMs),
                          Long.toString(maintenanceMs),
                          Long.toString(routineMs),
                          Long.toString(registryMs),
                          Integer.toString(slots),
                          Boolean.toString(stopping),
                          Integer.toString(SqlCatalogue.CLIENT_PROTOCOL_VERSION),
                          LANGUAGE,
                          sdkVersion));
    } catch (RuntimeException error) {
      log(
          System.Logger.Level.INFO,
          "workhorse.worker.registration_failed",
          "Worker registration failed",
          Map.of("error.type", error.getClass().getName()));
      if (onRegistrationError != null) {
        onRegistrationError.accept(error);
      }
      return;
    }
    if (rows == null) {
      return;
    }
    boolean paused = !rows.isEmpty() && "t".equals(rows.get(0).text("paused"));
    boolean changed = remotelyPaused.getAndSet(paused) != paused;
    registered.set(true);
    if (changed) {
      log(
          System.Logger.Level.INFO,
          paused ? "workhorse.worker.paused" : "workhorse.worker.resumed",
          paused ? "Worker paused remotely" : "Worker resumed remotely",
          Map.of());
      wakeDispatcher();
    }
  }

  private void deregister(long run) {
    if (generation.get() != run || !registered.getAndSet(false)) {
      return;
    }
    try {
      withConnection(
          connection ->
              generation.get() != run
                  ? null
                  : Sql.rows(connection, SqlCatalogue.DEREGISTER_WORKER_V1, workerId));
    } catch (RuntimeException ignored) {
      // The registry expires a worker that stops reporting.
    }
  }

  /**
   * Runs one maintenance pass when its interval elapsed. The interval restarts only after a pass
   * succeeds, so a failed pass runs again on the next dispatch.
   */
  private void runMaintenanceIfDue() {
    long now = System.nanoTime();
    long last = lastMaintenanceAt.get();
    if (last != NEVER && now - last < TimeUnit.MILLISECONDS.toNanos(maintenanceMs)) {
      return;
    }
    long routine = lastRoutineAt.get();
    boolean routineDue =
        routine == NEVER || now - routine >= TimeUnit.MILLISECONDS.toNanos(routineMs);
    telemetry.maintenance(
        () ->
            withConnection(
                connection -> {
                  for (Row row : Sql.rows(connection, SqlCatalogue.TICK_V1, "100", "100")) {
                    recordMaintenance(row);
                  }
                  if (routineDue) {
                    lastRoutineAt.set(now);
                    Sql.rows(
                            connection,
                            SqlCatalogue.RUN_MAINTENANCE_V1,
                            Values.timestamp(Instant.now()))
                        .forEach(telemetry::maintenancePhase);
                  }
                  return null;
                }));
    lastMaintenanceAt.set(now);
    if (!scheduleNamespaces.isEmpty()) {
      fireSchedules();
    }
  }

  private void recordMaintenance(Row row) {
    telemetry.maintenancePhase(row);
    Long affected = row.longValue("rows_affected");
    boolean error = row.text("error") != null;
    if ((affected == null || affected == 0) && !error) {
      return;
    }
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    attributes.put("workhorse.maintenance.operation", "tick");
    attributes.put("workhorse.maintenance.phase", row.text("phase"));
    attributes.put("workhorse.maintenance.rows_affected", affected == null ? 0 : affected);
    attributes.put("workhorse.maintenance.skipped_lock", "t".equals(row.text("skipped_lock")));
    if (error) {
      attributes.put("error.type", "PostgreSQLError");
    }
    log(
        System.Logger.Level.INFO,
        "workhorse.maintenance.completed",
        "Maintenance phase completed",
        attributes);
  }

  private void fireSchedules() {
    List<Row> rows =
        withConnection(
            connection ->
                Sql.rows(
                    connection,
                    SqlCatalogue.FIRE_DUE_SCHEDULES_V2,
                    Sql.textArray(scheduleNamespaces),
                    null,
                    Integer.toString(scheduleCatchupLimit),
                    Long.toString(maintenanceMs)));
    for (Row row : rows) {
      telemetry.scheduleFired(row, Instant.now());
      Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
      attributes.put("workhorse.schedule.namespace", row.text("namespace"));
      attributes.put("workhorse.schedule.name", row.text("schedule_name"));
      String taskId = row.text("task_id");
      if (taskId == null) {
        log(
            System.Logger.Level.DEBUG,
            "workhorse.schedule.fire_replayed",
            "Recurring schedule occurrence replayed",
            attributes);
        continue;
      }
      attributes.put("workhorse.task.id", taskId);
      log(
          System.Logger.Level.INFO,
          "workhorse.schedule.fired",
          "Recurring schedule fired",
          attributes);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Execution

  /**
   * One admitted task: its cancellation token, its lease ownership, its handler thread, its slot
   * cohort, and its claim order.
   */
  static final class Active {
    final Claimed claimed;
    private final RunState run;
    final int cohort;
    final long order;

    /** Whether a fused completion handed this task's slot over. It changes under the state lock. */
    boolean handedOver;

    final TaskCancellation cancellation = new TaskCancellation();
    private final AtomicReference<@Nullable Ownership> ownership = new AtomicReference<>();

    /** Set by the drain for an attempt that still runs at the end of the unwind window. */
    final AtomicBoolean abandoned = new AtomicBoolean();

    private final ReentrantLock lock = new ReentrantLock();
    private final AtomicInteger state = new AtomicInteger(QUEUED);
    private @Nullable Thread handlerThread;

    /** How many of the worker's own writes run on the handler thread now. */
    private int deferrals;

    /** Whether an interrupt waits for the end of the worker's writes. */
    private boolean interruptDeferred;

    private static final int QUEUED = 0;
    private static final int STARTED = 1;
    private static final int ABANDONED = 2;

    private Active(Claimed claimed, RunState run, int cohort, long order) {
      this.claimed = claimed;
      this.run = run;
      this.cohort = cohort;
      this.order = order;
    }

    /** The task this attempt runs. */
    ClaimedTask task() {
      return claimed.task;
    }

    /** The order dispatch admitted this attempt in. */
    long order() {
      return order;
    }

    /** Starts the attempt, unless the drain abandoned it first. */
    boolean begin() {
      return state.compareAndSet(QUEUED, STARTED);
    }

    /**
     * Keeps a queued attempt from starting. Returns whether the attempt was still queued; an
     * attempt that already started is not changed.
     */
    boolean abandonUnstarted() {
      return state.compareAndSet(QUEUED, ABANDONED);
    }

    /** Marks the handler call. Only a thread inside the handler takes the drain's interrupt. */
    void enterHandler() {
      lock.lock();
      try {
        handlerThread = Thread.currentThread();
        HANDLER_TASK.set(this);
      } finally {
        lock.unlock();
      }
    }

    /**
     * Ends the handler call, and clears an interrupt the drain sent. The worker's own writes then
     * run without an interrupt, which would close a virtual thread's socket.
     */
    void leaveHandler() {
      lock.lock();
      try {
        handlerThread = null;
        HANDLER_TASK.remove();
        deferrals = 0;
        interruptDeferred = false;
        Thread.interrupted();
      } finally {
        lock.unlock();
      }
    }

    /**
     * Starts one of the worker's own writes on the handler thread. Until the matching {@link
     * #resumeInterrupt}, the drain's interrupt waits, and an interrupt that the thread already has
     * waits too.
     */
    void deferInterrupt() {
      lock.lock();
      try {
        if (deferrals++ == 0) {
          interruptDeferred = Thread.interrupted();
        }
      } finally {
        lock.unlock();
      }
    }

    /**
     * Ends one of the worker's own writes. After the last one, the thread gets the interrupt that
     * waited, before control returns to handler code.
     */
    void resumeInterrupt() {
      lock.lock();
      try {
        if (--deferrals == 0 && interruptDeferred) {
          interruptDeferred = false;
          Thread.currentThread().interrupt();
        }
      } finally {
        lock.unlock();
      }
    }

    /** Whether the drain's interrupt waits for the end of the worker's writes. */
    boolean interruptDeferred() {
      lock.lock();
      try {
        return interruptDeferred;
      } finally {
        lock.unlock();
      }
    }

    void interrupt() {
      lock.lock();
      try {
        if (handlerThread != null) {
          if (deferrals > 0) {
            interruptDeferred = true;
          } else {
            handlerThread.interrupt();
          }
        }
      } finally {
        lock.unlock();
      }
    }
  }

  /** The attempt whose handler region this thread is in, if any. */
  private static final ThreadLocal<@Nullable Active> HANDLER_TASK = new ThreadLocal<>();

  /** The attempt whose handler region the current thread is in, or {@code null}. */
  static @Nullable Active handlerTask() {
    return HANDLER_TASK.get();
  }

  /**
   * Runs one of the worker's own statements. In a handler region, the drain's interrupt waits until
   * the statement ends, because an interrupt closes a virtual thread's socket and loses the write.
   * The thread then gets the interrupt before control returns to handler code. {@code body} must
   * not call caller code, such as the codec, because that code would not see the drain.
   */
  private <T extends @Nullable Object> T withoutInterrupt(SqlBody<T> body) {
    Active task = HANDLER_TASK.get();
    if (task == null) {
      return withConnection(body);
    }
    task.deferInterrupt();
    try {
      return withConnection(body);
    } finally {
      task.resumeInterrupt();
    }
  }

  /**
   * A handler and the type its payload decodes as. A batch registration has its options and its
   * batch handler instead of a handler.
   */
  private record Registration(
      Type payloadType,
      @Nullable Handler<?> handler,
      @Nullable BatchOptions batchOptions,
      @Nullable BatchHandler<?> batchHandler) {}

  /**
   * Gives a claimed task a slot and a handler thread. The caller holds {@link #stateLock}, so the
   * slot and the reservation it came from change together. The task joins {@code cohort} while that
   * cohort has a free slot, and the roomiest cohort otherwise. A claimed task always runs, even
   * after stop or pause: its lease is already held.
   */
  private void admit(Claimed claimed, int cohort, RunState run) {
    int chosen = cohort == WHOLE || slots.cohortFree(cohort) <= 0 ? slots.roomiest() : cohort;
    slots.busy[chosen]++;
    slots.busyTotal++;
    // Dispatch assigns the claim order here. A batch coordinator cannot read the arrival order off
    // its own lock, because handler threads reach that lock in scheduler order.
    Active task = new Active(claimed, run, chosen, dispatchSequence++);
    active.add(task);
    Runnable body = () -> runClaimedTask(task, run);
    try {
      if (executor == null) {
        Thread.ofVirtual().name("workhorse-handler-" + claimed.task.id()).start(body);
      } else {
        executor.execute(body);
      }
    } catch (RejectedExecutionException error) {
      // A task the executor refused never runs, so the drain must not wait for it. Its lease
      // expires, and recovery returns it to the queue.
      active.remove(task);
      releaseSlot(task);
      run.errors.add(error);
      stopVersion.incrementAndGet();
    }
  }

  /** Frees the slot of an attempt that ended or never started. */
  private void releaseSlot(Active task) {
    stateLock.lock();
    try {
      slots.busy[task.cohort]--;
      slots.busyTotal--;
      if (task.handedOver) {
        task.handedOver = false;
        slots.handedOver[task.cohort]--;
        slots.handedOverTotal--;
      }
    } finally {
      stateLock.unlock();
    }
  }

  private void runClaimedTask(Active task, RunState run) {
    if (!task.begin()) {
      // The drain abandoned this task before the executor started it, and it already freed the
      // slot. The lease expires, and recovery returns the task to the queue.
      return;
    }
    try {
      execute(task);
    } catch (LeaseLostException ignored) {
      // Another attempt owns the task, so this attempt has nothing left to write.
    } catch (Throwable error) {
      run.errors.add(error);
      stopVersion.incrementAndGet();
    } finally {
      active.remove(task);
      releaseSlot(task);
      wake.signal();
    }
  }

  private void execute(Active task) {
    ClaimedTask claimed = task.claimed.task;
    Registration registration = handlers.get(claimed.type());
    Arbiter arbiter = new Arbiter();
    Map<String, @Nullable Object> attributes = taskAttributes(claimed);
    log(System.Logger.Level.DEBUG, "workhorse.handler.started", "Task handler started", attributes);
    WorkerTelemetry.Execution execution = telemetry.execute(claimed);
    try {
      if (registration == null) {
        log(
            System.Logger.Level.WARNING,
            "workhorse.handler.missing",
            "No handler registered for the claimed task type",
            attributes);
        releaseOwned(claimed, arbiter);
      } else {
        runHandler(task, registration, arbiter);
      }
    } catch (RuntimeException | Error error) {
      telemetry.handlerError(error.getClass().getName());
      throw error;
    } finally {
      Outcome outcome = arbiter.reportedOutcome();
      execution.finish(outcome == null ? null : outcome.name());
      Map<String, @Nullable Object> finished = new LinkedHashMap<>(attributes);
      finished.put("workhorse.handler.outcome", outcomeLabel(outcome));
      log(
          System.Logger.Level.INFO,
          "workhorse.task.execution_finished",
          "Task execution finished",
          finished);
    }
  }

  /** The outcome label of the execution log. Both suspensions read as {@code suspended}. */
  private static String outcomeLabel(@Nullable Outcome outcome) {
    if (outcome == null) {
      return "unknown";
    }
    return switch (outcome) {
      case SUSPENDED_FOR_WAIT, SUSPENDED_FOR_CHILD -> "suspended";
      default -> outcome.name().toLowerCase(java.util.Locale.ROOT);
    };
  }

  private void runHandler(Active task, Registration registration, Arbiter arbiter) {
    ClaimedTask claimed = task.claimed.task;
    TaskCancellation cancellation = task.cancellation;
    Ownership ownership =
        new Ownership(task.claimed.startedAt, TimeUnit.MILLISECONDS.toNanos(leaseMs));
    own(claimed, ownership, arbiter, cancellation);
    task.ownership.set(ownership);
    if (task.abandoned.get()) {
      // The drain abandoned the attempt before it published its ownership. The handler does not
      // start, and the lease expires.
      ownership.abandon();
      return;
    }
    String encoded;
    try {
      Object result;
      task.enterHandler();
      try {
        Object payload = codec.decode(task.claimed.payload, registration.payloadType);
        TaskContext context =
            new TaskContext(this, claimed, cancellation, arbiter, task.claimed.fastTier);
        BatchCoordinator coordinator = coordinators.get(claimed.type());
        if (coordinator != null) {
          result = coordinator.run(task, payload, context);
        } else {
          @SuppressWarnings("unchecked")
          Handler<@Nullable Object> handler =
              (Handler<@Nullable Object>) Objects.requireNonNull(registration.handler);
          result = handler.handle(context, payload);
        }
      } finally {
        task.leaveHandler();
      }
      encoded = codec.encode(result);
      Object tree = Json.parse(encoded);
      checkStorable(claimed, tree);
      validateResult(claimed, tree);
      checkResultSize(claimed, encoded);
    } catch (Suspension suspension) {
      if (finishOwnership(claimed, ownership, arbiter)) {
        return;
      }
      throw new WorkhorseException("Durable wait suspension was not accepted by the arbiter");
    } catch (Exception error) {
      if (finishSuspended(claimed, ownership, arbiter)) {
        return;
      }
      // A handler that stopped for shutdown returns the task to the queue without an attempt.
      if (cancellation.reason() == CancellationReason.SHUTDOWN && shutdownCancellation(error)) {
        releaseOwned(claimed, arbiter);
        return;
      }
      settleFailure(claimed, error, arbiter);
      return;
    } finally {
      ownership.release();
    }
    if (finishSuspended(claimed, ownership, arbiter)) {
      return;
    }
    complete(task, encoded, arbiter);
  }

  private void complete(Active active, String encoded, Arbiter arbiter) {
    ClaimedTask task = active.claimed.task;
    boolean accepted =
        telemetry.complete(
            task,
            () ->
                active.claimed.fastClaimed
                    ? completeFast(active, encoded)
                    : "t"
                        .equals(
                            fencedRow(SqlCatalogue.COMPLETE_V1, task, encoded).text("accepted")));
    Map<String, @Nullable Object> attributes = taskAttributes(task);
    attributes.put("workhorse.complete.accepted", accepted);
    if (accepted) {
      log(System.Logger.Level.INFO, "workhorse.task.completed", "Task completed", attributes);
      arbiter.submit(Outcome.COMPLETED);
      return;
    }
    log(
        System.Logger.Level.INFO,
        "workhorse.task.completion_rejected",
        "Stale task completion rejected",
        attributes);
    if (acknowledgeCancel(task)) {
      arbiter.submit(Outcome.CANCELLED);
      return;
    }
    arbiter.submit(Outcome.LEASE_EXPIRED);
    throw new LeaseLostException(task.id(), "complete");
  }

  /** Hands an owned task back to PostgreSQL without charging the attempt. */
  private void releaseOwned(ClaimedTask task, Arbiter arbiter) {
    String status = fencedRow(SqlCatalogue.RELEASE_OWNED_V1, task).text("status");
    telemetry.handlerSpanOutcome(status);
    Map<String, @Nullable Object> attributes = taskAttributes(task);
    attributes.put("workhorse.release.status", status);
    log(
        System.Logger.Level.INFO,
        "workhorse.task.release_processed",
        "Owned task release processed",
        attributes);
    if ("released".equals(status)) {
      arbiter.submit(Outcome.RELEASED);
    } else {
      settleStatus(task, status, arbiter, "release", Set.of("not_due"), Outcome.LEASE_EXPIRED);
    }
  }

  /** Records a handler failure. PostgreSQL retries or fails the task by its retry policy. */
  private void settleFailure(ClaimedTask task, Exception error, Arbiter arbiter) {
    String envelope = Json.write(failureEnvelope(error, task.redactErrorDetails()));
    Long delay = error instanceof ConflictException ? Long.valueOf(-1) : retryDelayOverride(task);
    String state =
        telemetry.fail(
            task,
            error,
            () ->
                fencedRow(
                        SqlCatalogue.FAIL_V1,
                        task,
                        envelope,
                        delay == null ? null : Long.toString(delay))
                    .text("state"));
    Map<String, @Nullable Object> attributes = taskAttributes(task);
    attributes.put("workhorse.attempt.outcome", state);
    log(
        System.Logger.Level.INFO,
        "workhorse.task.failure_processed",
        "Task attempt failure processed",
        attributes);
    if ("ready".equals(state) || "scheduled".equals(state)) {
      arbiter.submit(Outcome.RETRY);
    } else {
      settleStatus(task, state, arbiter, "fail", Set.of("failed"), Outcome.FAILED);
    }
  }

  private @Nullable Long retryDelayOverride(ClaimedTask task) {
    if (retryDelay == null) {
      return null;
    }
    Duration delay = retryDelay.delay(task.attempt(), task);
    return delay == null ? null : Values.milliseconds(delay, "retryDelay", 0, MAX_RETRY_DELAY_MS);
  }

  /** The failure envelope of {@code protocol/v1/failures.json}. */
  static Map<String, @Nullable Object> failureEnvelope(Throwable error, boolean redact) {
    Map<String, @Nullable Object> envelope = new LinkedHashMap<>();
    if (redact) {
      envelope.put("name", REDACTED_NAME);
      envelope.put("message", REDACTED_MESSAGE);
      return envelope;
    }
    StringWriter stack = new StringWriter();
    error.printStackTrace(new PrintWriter(stack));
    envelope.put("name", failureName(error));
    envelope.put("message", storable(error.getMessage() == null ? "" : error.getMessage()));
    envelope.put("stack", storable(stack.toString()));
    return envelope;
  }

  /**
   * {@code text} with each NUL and each surrogate outside a pair replaced by U+FFFD. PostgreSQL
   * {@code jsonb} cannot store either, and a refused envelope would end the worker instead of
   * recording the handler's failure.
   */
  static String storable(String text) {
    StringBuilder out = null;
    for (int index = 0; index < text.length(); index++) {
      char character = text.charAt(index);
      boolean paired =
          Character.isHighSurrogate(character)
              && index + 1 < text.length()
              && Character.isLowSurrogate(text.charAt(index + 1));
      if (paired) {
        if (out != null) {
          out.append(character).append(text.charAt(index + 1));
        }
        index++;
        continue;
      }
      boolean refused = character == '\0' || Character.isSurrogate(character);
      if (refused && out == null) {
        out = new StringBuilder(text.length()).append(text, 0, index);
      }
      if (out != null) {
        out.append(refused ? '\uFFFD' : character);
      }
    }
    return out == null ? text : out.toString();
  }

  /**
   * The simple class name of {@code error}, or the generic name {@code Exception} for an anonymous
   * or hidden class, whose name is a type-system artifact.
   */
  static String failureName(Throwable error) {
    Class<?> type = error.getClass();
    String name = type.getSimpleName();
    if (type.isAnonymousClass() || type.isHidden() || name.isEmpty()) {
      return GENERIC_NAME;
    }
    for (String forbidden : FORBIDDEN_NAME_CHARACTERS) {
      if (name.contains(forbidden)) {
        return GENERIC_NAME;
      }
    }
    return name;
  }

  /**
   * Whether {@code error}, or an error it wraps, shows that the handler saw the shutdown: a {@link
   * CancelledException} with {@link CancellationReason#SHUTDOWN}, or the {@link
   * InterruptedException} of the drain's interrupt. The walk stays bounded against a cyclic chain.
   */
  private static boolean shutdownCancellation(Throwable error) {
    Throwable current = error;
    for (int depth = 0; depth < CAUSE_DEPTH && current != null; depth++) {
      if (current instanceof CancelledException cancelled
          && cancelled.reason() == CancellationReason.SHUTDOWN) {
        return true;
      }
      if (current instanceof InterruptedException) {
        return true;
      }
      current = current.getCause();
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Fast-tier completion

  /**
   * The fused claim that one fast-tier completion reserved: its limit, its cohort, and the wake
   * version when it reserved. A zero limit reserves nothing.
   */
  private record CompletionClaim(int limit, int cohort, long wakeVersion) {}

  /** The statement key of batched completions: one statement for each queue and cohort. */
  private record CompletionKey(String queue, int cohort) {}

  /**
   * One completion that waits for a batched {@code complete_many_and_claim_v1} statement. The
   * statement's sender fills {@code accepted}, {@code claimed}, {@code fullTier}, or {@code error},
   * and then counts down {@code done}. {@code lead} makes a waiting completion the sender of the
   * next statement.
   */
  private static final class PendingCompletion {
    final ClaimedTask task;
    final String encoded;
    final int limit;
    final CountDownLatch done = new CountDownLatch(1);
    volatile boolean accepted;
    volatile List<Claimed> claimed = List.of();
    volatile boolean fullTier;
    volatile @Nullable Throwable error;
    volatile boolean lead;

    PendingCompletion(ClaimedTask task, String encoded, int limit) {
      this.task = task;
      this.encoded = encoded;
      this.limit = limit;
    }

    void await() {
      boolean interrupted = false;
      while (true) {
        try {
          done.await();
          break;
        } catch (InterruptedException error) {
          interrupted = true;
        }
      }
      if (interrupted) {
        Thread.currentThread().interrupt();
      }
    }
  }

  /**
   * Completes a fast-tier attempt through the batched statement, and refills its slot. Completions
   * of one queue and cohort that arrive while its statement is in flight share the next one. The
   * statement also claims tasks into the slots that this call set aside. A queue that left the fast
   * tier after the claim rejects that statement, so the attempt completes through {@code
   * complete_v1} instead.
   */
  private boolean completeFast(Active task, String encoded) {
    ClaimedTask claimed = task.claimed.task;
    CompletionClaim reservation = reserveCompletionClaim(task);
    PendingCompletion pending = new PendingCompletion(claimed, encoded, reservation.limit);
    try {
      sendBatchedCompletion(pending, new CompletionKey(claimed.queue(), reservation.cohort));
    } finally {
      settleCompletionClaim(task, reservation, pending.error != null ? null : pending.claimed);
    }
    Throwable error = pending.error;
    if (error != null) {
      throw unchecked(error);
    }
    if (pending.fullTier) {
      return "t".equals(fencedRow(SqlCatalogue.COMPLETE_V1, claimed, encoded).text("accepted"));
    }
    return pending.accepted;
  }

  /**
   * Sets aside the slots that a completion's fused claim can fill (ADR 0076). The claim asks for
   * the free slots of the task's cohort plus the slot the task leaves. It claims nothing while the
   * worker stops, pauses, or waits after an empty claim, and it waits for the refill batch while
   * another claim for the cohort is in flight.
   */
  private CompletionClaim reserveCompletionClaim(Active task) {
    RunState run = task.run;
    int cohort = task.cohort;
    stateLock.lock();
    try {
      CompletionClaim idle = new CompletionClaim(0, cohort, wake.version());
      if (!run.open
          || stopRequested(run.version)
          || !run.errors.isEmpty()
          || isPaused()
          || run.claimError != null
          || run.emptyWait != null) {
        return idle;
      }
      int limit = Math.min(slots.free(), slots.cohortFree(cohort)) + 1;
      boolean claiming = slots.wholeClaims > 0 || slots.claims[cohort] > 0;
      if (limit <= 0 || (claiming && limit < slots.refillBatch)) {
        return idle;
      }
      slots.reservedTotal += limit;
      slots.reserved[cohort] += limit;
      task.handedOver = true;
      slots.handedOverTotal++;
      slots.handedOver[cohort]++;
      return new CompletionClaim(limit, cohort, idle.wakeVersion);
    } finally {
      stateLock.unlock();
    }
  }

  /**
   * Releases a fused claim's reservation and starts the tasks it claimed in its cohort. {@code
   * claimed} is {@code null} when the completion failed.
   */
  private void settleCompletionClaim(
      Active task, CompletionClaim reservation, @Nullable List<Claimed> claimed) {
    if (reservation.limit == 0) {
      return;
    }
    RunState run = task.run;
    stateLock.lock();
    try {
      slots.reservedTotal -= reservation.limit;
      slots.reserved[reservation.cohort] -= reservation.limit;
      // A claimed task took over this handler's slot. Without one, the slot stays this handler's
      // until it returns.
      if ((claimed == null || claimed.isEmpty()) && task.handedOver) {
        task.handedOver = false;
        slots.handedOverTotal--;
        slots.handedOver[reservation.cohort]--;
      }
      boolean handled = false;
      if (claimed != null) {
        for (Claimed next : claimed) {
          admit(next, reservation.cohort, task.run);
          handled |= handlers.containsKey(next.task.type());
        }
      }
      if (handled) {
        run.claimedAny = true;
        run.empty = 0;
      } else if (claimed != null && claimed.isEmpty() && queueNames.size() == 1) {
        // The fused claim asks one queue only, so it proves that queue empty when this worker has
        // no other.
        run.empty++;
        run.passEnded = true;
        if (run.emptyWait == null) {
          run.emptyWait =
              new EmptyWait(
                  System.nanoTime() + dispatchWait(run.empty, run.listener),
                  reservation.wakeVersion);
        }
      }
    } finally {
      stateLock.unlock();
    }
    wake.signal();
  }

  /**
   * Sends a completion in the next statement of its key, and waits for its result. One statement
   * for each key is in flight. The first completion sends its own at once. Those that arrive
   * meanwhile wait, and the first of them sends them all together when the statement returns.
   */
  private void sendBatchedCompletion(PendingCompletion pending, CompletionKey key) {
    List<PendingCompletion> batch;
    completionLock.lock();
    try {
      List<PendingCompletion> waiting = pendingCompletions.get(key);
      if (waiting == null) {
        pendingCompletions.put(key, new ArrayList<>());
        batch = List.of(pending);
      } else {
        waiting.add(pending);
        batch = null;
      }
    } finally {
      completionLock.unlock();
    }
    if (batch == null) {
      pending.await();
      if (!pending.lead) {
        return;
      }
      completionLock.lock();
      try {
        batch = pendingCompletions.put(key, new ArrayList<>());
      } finally {
        completionLock.unlock();
      }
    }
    try {
      flushCompletions(key.queue, Objects.requireNonNull(batch));
    } finally {
      completionLock.lock();
      try {
        List<PendingCompletion> waiting = Objects.requireNonNull(pendingCompletions.get(key));
        if (waiting.isEmpty()) {
          pendingCompletions.remove(key);
        } else {
          PendingCompletion next = waiting.get(0);
          next.lead = true;
          next.done.countDown();
        }
      } finally {
        completionLock.unlock();
      }
    }
  }

  /**
   * Completes a batch in statements within the protocol's array and claim limits. A failed
   * statement fails only the completions it carried.
   */
  private void flushCompletions(String queueName, List<PendingCompletion> batch) {
    int start = 0;
    while (start < batch.size()) {
      int finish = start;
      int claimLimit = 0;
      while (finish < batch.size()
          && finish - start < COMPLETION_BATCH_LIMIT
          && claimLimit + batch.get(finish).limit <= COMPLETION_BATCH_LIMIT) {
        claimLimit += batch.get(finish).limit;
        finish++;
      }
      List<PendingCompletion> chunk = new ArrayList<>(batch.subList(start, finish));
      start = finish;
      try {
        sendCompletionChunk(queueName, chunk, claimLimit);
      } catch (Throwable error) {
        for (PendingCompletion member : chunk) {
          member.error = error;
        }
      } finally {
        for (PendingCompletion member : chunk) {
          member.done.countDown();
        }
      }
    }
  }

  /**
   * Sends one {@code complete_many_and_claim_v1} statement and answers every completion in it. The
   * chunk names its tasks in task ID order, as a heartbeat names its leases, so the two statements
   * lock shared runtime rows in the same order. A deadlock between the fused claim and another
   * worker's lease rolls the statement back with 40P01, and the fenced write sends it again.
   */
  private void sendCompletionChunk(
      String queueName, List<PendingCompletion> chunk, int claimLimit) {
    chunk.sort((left, right) -> left.task.id().toString().compareTo(right.task.id().toString()));
    List<String> ids = new ArrayList<>();
    List<String> fences = new ArrayList<>();
    List<String> results = new ArrayList<>();
    for (PendingCompletion member : chunk) {
      ids.add(member.task.id().toString());
      fences.add(Long.toString(member.task.fenceToken()));
      results.add(member.encoded);
    }
    long sentAt = System.nanoTime();
    List<Row> rows;
    try {
      rows =
          withConnection(
              connection ->
                  Sql.fencedRows(
                      connection,
                      SqlCatalogue.COMPLETE_MANY_AND_CLAIM_V1,
                      workerId,
                      Sql.textArray(ids),
                      Sql.textArray(fences),
                      Sql.textArray(results),
                      queueName,
                      Integer.toString(claimLimit),
                      Long.toString(leaseMs)));
    } catch (FastTierUnsupportedException fullTier) {
      markFullTier(queueName, sentAt);
      for (PendingCompletion member : chunk) {
        member.fullTier = true;
      }
      return;
    }
    markFastTier(queueName);
    // Only the first row carries the accepted completions. A statement that claims nothing still
    // returns that row, with every claim column null.
    Set<UUID> accepted = new java.util.HashSet<>();
    if (!rows.isEmpty() && rows.get(0).text("accepted") != null) {
      accepted.addAll(Rows.uuids(rows.get(0), "accepted"));
    }
    List<Claimed> claimed = new ArrayList<>();
    for (Row row : rows) {
      if (row.text("task_id") != null) {
        claimed.add(claimed(row, queueName, sentAt, Worker::fastTier, true));
      }
    }
    logClaimed(claimed);
    if (claimLimit > 0) {
      telemetry.claimed(queueName, sentAt, claimed.stream().map(task -> task.task).toList(), false);
    }
    reportFused(chunk.size(), claimLimit, claimed.size());
    // Claimed tasks go to the completions in order, each up to the slots it reserved.
    int offset = 0;
    for (PendingCompletion member : chunk) {
      member.accepted = accepted.contains(member.task.id());
      int end = Math.min(claimed.size(), offset + member.limit);
      member.claimed = List.copyOf(claimed.subList(offset, end));
      offset = end;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Batch delivery

  /**
   * Whether the worker drains and every task of {@code taskType} it admitted from {@code queueName}
   * has reached its batch coordinator, as {@code entered} records. No later member can join a batch
   * then. The caller holds the coordinator's lock.
   */
  boolean batchArrivalsComplete(String taskType, String queueName, Set<Active> entered) {
    if (!draining) {
      return false;
    }
    for (Active task : active) {
      ClaimedTask claimed = task.claimed.task;
      if (claimed.type().equals(taskType)
          && claimed.queue().equals(queueName)
          && !entered.contains(task)) {
        return false;
      }
    }
    return true;
  }

  boolean draining() {
    return draining;
  }

  /**
   * Records a batch's dispatch or failure evidence. A write failure only logs, because the evidence
   * must not decide the members' outcomes. The drain's interrupt waits until the write ends, as
   * {@link #withoutInterrupt} describes.
   */
  void recordBatchEvidence(
      SqlCatalogue.Statement statement,
      String phase,
      UUID batchId,
      String taskType,
      List<ClaimedTask> tasks,
      boolean full) {
    List<String> ids = new ArrayList<>();
    List<String> attempts = new ArrayList<>();
    List<String> fences = new ArrayList<>();
    for (ClaimedTask task : tasks) {
      ids.add(task.id().toString());
      attempts.add(Integer.toString(task.attempt()));
      fences.add(Long.toString(task.fenceToken()));
    }
    try {
      List<Row> rows =
          withoutInterrupt(
              connection ->
                  Sql.fencedRows(
                      connection,
                      statement,
                      batchId.toString(),
                      Sql.textArray(ids),
                      Sql.textArray(attempts),
                      Sql.textArray(fences),
                      workerId));
      Long recorded = rows.isEmpty() ? null : rows.get(0).longValue("recorded");
      if (recorded == null || recorded != tasks.size()) {
        throw new WorkhorseException("PostgreSQL did not record every batch member");
      }
    } catch (RuntimeException error) {
      Map<String, @Nullable Object> attributes = batchAttributes(taskType, tasks, full);
      attributes.put("workhorse.handler.batch.evidence_phase", phase);
      attributes.put("error.type", error.getClass().getName());
      log(
          System.Logger.Level.WARNING,
          "workhorse.handler.batch_evidence_failed",
          "Batch execution evidence could not be persisted",
          attributes);
    }
  }

  /** Logs one batch as it starts. */
  void recordBatchDispatch(String taskType, List<ClaimedTask> tasks, boolean full, long lingerMs) {
    telemetry.batch(taskType, tasks, full, lingerMs);
    Map<String, @Nullable Object> attributes = batchAttributes(taskType, tasks, full);
    attributes.put("workhorse.handler.batch.linger_ms", lingerMs);
    log(
        System.Logger.Level.INFO,
        "workhorse.handler.batch_dispatched",
        "Task batch dispatched",
        attributes);
  }

  private static Map<String, @Nullable Object> batchAttributes(
      String taskType, List<ClaimedTask> tasks, boolean full) {
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    attributes.put("workhorse.queue.name", tasks.get(0).queue());
    attributes.put("workhorse.task.type", taskType);
    attributes.put("workhorse.handler.batch.full", full);
    attributes.put("workhorse.handler.batch.size", tasks.size());
    return attributes;
  }

  // ---------------------------------------------------------------------------------------------
  // Leases

  /** One attempt's hold on its lease: the heartbeat membership and the lease watchdog. */
  static final class Ownership {
    final AtomicLong renewedAt;
    final long leaseNanos;
    final CountDownLatch stop = new CountDownLatch(1);
    final List<Exception> errors = new CopyOnWriteArrayList<>();
    final ReentrantLock settlement = new ReentrantLock();

    /** True while a heartbeat settlement waits or runs, so repeated statuses coalesce. */
    final AtomicBoolean settling = new AtomicBoolean();

    private final AtomicBoolean released = new AtomicBoolean();
    private volatile @Nullable Runnable unregister;
    private volatile @Nullable Thread watchdog;

    /**
     * Guards the local lease window. A renewal and the watchdog check the window under it, so a
     * renewal cannot move a window that has already ended.
     */
    private final ReentrantLock window = new ReentrantLock();

    /** True once the window has ended. Only one caller closes it and ends the attempt. */
    private boolean lapsed;

    Ownership(long renewedAt, long leaseNanos) {
      this.renewedAt = new AtomicLong(renewedAt);
      this.leaseNanos = leaseNanos;
    }

    /**
     * Applies an accepted round that left at {@code sentAt}. Returns {@code true} when the window
     * had already ended: the round then renews nothing, this call closes the window, and the caller
     * must end the attempt as the watchdog would. A late answer never opens the window again.
     */
    boolean renew(long sentAt) {
      window.lock();
      try {
        if (lapsed || stop.getCount() == 0) {
          return false;
        }
        if (leaseDeadline() - System.nanoTime() <= 0) {
          lapsed = true;
          return true;
        }
        renewedAt.accumulateAndGet(sentAt, (current, sent) -> sent - current > 0 ? sent : current);
        return false;
      } finally {
        window.unlock();
      }
    }

    /** The time left in the window at {@code now}, or at most zero once it has ended. */
    long leaseRemaining(long now) {
      window.lock();
      try {
        return lapsed ? 0 : leaseDeadline() - now;
      } finally {
        window.unlock();
      }
    }

    /**
     * Closes a window that has ended. Returns {@code true} for the one caller that closes it, which
     * then ends the attempt. A window that has ended cannot be renewed, so this cannot race a
     * renewal.
     */
    boolean lapse() {
      window.lock();
      try {
        if (lapsed) {
          return false;
        }
        lapsed = true;
        return true;
      } finally {
        window.unlock();
      }
    }

    long leaseDeadline() {
      return renewedAt.get() + leaseNanos;
    }

    void start(Runnable unregister, Thread watchdog) {
      this.unregister = unregister;
      this.watchdog = watchdog;
    }

    /** Stops renewing without waiting for the watchdog. A shutdown abandons with this. */
    void abandon() {
      Runnable current = unregister;
      if (current != null) {
        current.run();
      }
      stop.countDown();
    }

    /** Stops renewing and waits for the watchdog. Only the first call acts. */
    void release() {
      if (!released.compareAndSet(false, true)) {
        return;
      }
      abandon();
      Thread current = watchdog;
      if (current != null && !current.equals(Thread.currentThread())) {
        joinQuietly(current);
      }
    }
  }

  /**
   * Decides one attempt's outcome. The first submission wins, whether it comes from the handler,
   * the heartbeat, or the worker.
   */
  static final class Arbiter {
    private final AtomicReference<@Nullable Outcome> outcome = new AtomicReference<>();
    private final AtomicReference<@Nullable Outcome> released = new AtomicReference<>();

    @Nullable Outcome outcome() {
      return outcome.get();
    }

    /**
     * The outcome the attempt reports: the suspension that a durable write released the task for,
     * when one did, because the heartbeat reports that release as a lost lease.
     */
    @Nullable Outcome reportedOutcome() {
      Outcome suspension = released.get();
      return suspension != null ? suspension : outcome.get();
    }

    /** Submits an outcome. Returns whether it won. */
    boolean submit(Outcome submitted) {
      return outcome.compareAndSet(null, submitted);
    }

    /**
     * Records that a fenced durable write released the task for the suspension {@code suspension}.
     * The attempt then suspends whichever outcome won.
     */
    void release(Outcome suspension) {
      released.compareAndSet(null, suspension);
    }

    boolean released() {
      return released.get() != null;
    }

    boolean suspended() {
      Outcome current = outcome.get();
      return released()
          || current == Outcome.SUSPENDED_FOR_WAIT
          || current == Outcome.SUSPENDED_FOR_CHILD;
    }
  }

  /** Registers the attempt with the heartbeat and starts its lease watchdog. */
  private void own(
      ClaimedTask task, Ownership ownership, Arbiter arbiter, TaskCancellation cancellation) {
    Consumer<Exception> failAttempt =
        error -> {
          ownership.errors.add(error);
          cancellation.cancel(CancellationReason.LEASE_LOST);
        };
    long intervalNanos = TimeUnit.MILLISECONDS.toNanos(heartbeatMs);
    Heartbeat.Member member =
        new Heartbeat.Member() {
          @Override
          public String workerId() {
            return workerId;
          }

          @Override
          public UUID taskId() {
            return task.id();
          }

          @Override
          public long fenceToken() {
            return task.fenceToken();
          }

          @Override
          public long leaseMs() {
            return leaseMs;
          }

          @Override
          public long intervalNanos() {
            return intervalNanos;
          }

          @Override
          public long leaseEndsAt() {
            return ownership.leaseDeadline();
          }

          @Override
          public void renew(long sentAt) {
            acceptRenewal(ownership, arbiter, cancellation, sentAt);
          }

          @Override
          public void settle(String status) {
            Map<String, @Nullable Object> attributes = taskAttributes(task);
            attributes.put("workhorse.heartbeat.status", status);
            telemetry.heartbeatRejected(status);
            log(
                System.Logger.Level.INFO,
                "workhorse.task.heartbeat_rejected",
                "Task heartbeat rejected",
                attributes);
            // Another transaction held the task's row. The round renewed nothing and gave no
            // ownership verdict, so the lease watchdog keeps its window and the heartbeat retries.
            if (status.equals("busy")) {
              return;
            }
            // The settlement can wait for this attempt's lock and send a statement. The shared
            // heartbeat thread renews every other lease, so the settlement runs off it. A status
            // that arrives while one settlement is pending adds nothing, so it is dropped.
            if (!ownership.settling.compareAndSet(false, true)) {
              return;
            }
            Thread.ofVirtual()
                .name("workhorse-settlement-" + task.id())
                .start(
                    () -> {
                      ownership.settlement.lock();
                      try {
                        if (status.equals("deadline_exceeded")
                            || status.equals("timeout_exceeded")) {
                          settleExpiration(task, arbiter, cancellation);
                        } else {
                          deliverStatus(status, arbiter, cancellation);
                        }
                      } catch (RuntimeException error) {
                        failAttempt.accept(error);
                      } finally {
                        ownership.settlement.unlock();
                        ownership.settling.set(false);
                      }
                    });
          }

          @Override
          public void fail(Exception error) {
            failAttempt.accept(error);
          }
        };
    Runnable unregister = heartbeat.register(member);
    Thread watchdog =
        Thread.ofVirtual()
            .name("workhorse-expiration-" + task.id())
            .unstarted(() -> watchExpiration(task, ownership, arbiter, cancellation, failAttempt));
    ownership.start(unregister, watchdog);
    watchdog.start();
  }

  /**
   * Ends an attempt locally when its lease lapses unrenewed, and asks PostgreSQL to settle a
   * deadline or an attempt timeout when one passes.
   */
  private void watchExpiration(
      ClaimedTask task,
      Ownership ownership,
      Arbiter arbiter,
      TaskCancellation cancellation,
      Consumer<Exception> failAttempt) {
    Instant expirationAt = earliest(task.deadlineAt(), task.attemptTimeoutAt());
    Long retryAt = null;
    try {
      while (true) {
        Long delay;
        if (retryAt != null) {
          delay = retryAt - System.nanoTime();
        } else if (expirationAt != null) {
          delay = nanosUntil(expirationAt);
        } else {
          delay = null;
        }
        long leaseDelay = ownership.leaseRemaining(System.nanoTime());
        if (delay == null || leaseDelay < delay) {
          if (leaseDelay > 0) {
            if (ownership.stop.await(leaseDelay, TimeUnit.NANOSECONDS)) {
              return;
            }
            continue;
          }
          // A late accepted answer can close the window first. It then ends the attempt itself.
          if (ownership.lapse()) {
            expireLease(ownership, arbiter, cancellation);
          }
          return;
        }
        if (ownership.stop.await(Math.max(0, delay), TimeUnit.NANOSECONDS)) {
          return;
        }
        String status;
        ownership.settlement.lock();
        try {
          status = settleExpiration(task, arbiter, cancellation);
        } finally {
          ownership.settlement.unlock();
        }
        if (!"not_due".equals(status)) {
          return;
        }
        retryAt = System.nanoTime() + EXPIRATION_RETRY_NANOS;
      }
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    } catch (RuntimeException error) {
      failAttempt.accept(error);
    }
  }

  /**
   * Applies an accepted heartbeat round that left at {@code sentAt}. An answer that arrives after
   * the local window ended renews nothing, and ends the attempt with a lost lease, as the watchdog
   * would.
   */
  static void acceptRenewal(
      Ownership ownership, Arbiter arbiter, TaskCancellation cancellation, long sentAt) {
    if (ownership.renew(sentAt)) {
      expireLease(ownership, arbiter, cancellation);
    }
  }

  /** Ends an attempt whose local lease window closed without an accepted renewal. */
  private static void expireLease(
      Ownership ownership, Arbiter arbiter, TaskCancellation cancellation) {
    arbiter.submit(Outcome.LEASE_EXPIRED);
    ownership.abandon();
    cancellation.cancel(CancellationReason.LEASE_LOST);
  }

  private static @Nullable Instant earliest(@Nullable Instant first, @Nullable Instant second) {
    if (first == null) {
      return second;
    }
    if (second == null) {
      return first;
    }
    return first.isBefore(second) ? first : second;
  }

  private static long nanosUntil(Instant time) {
    try {
      return Duration.between(Instant.now(), time).toNanos();
    } catch (ArithmeticException overflow) {
      return Long.MAX_VALUE;
    }
  }

  private @Nullable String settleExpiration(
      ClaimedTask task, Arbiter arbiter, TaskCancellation cancellation) {
    Row row = fencedRow(SqlCatalogue.EXPIRE_OWNED_TELEMETRY_V1, task);
    String status = row.text("status");
    if ("not_due".equals(status)) {
      return status;
    }
    telemetry.expired(task, row);
    Map<String, @Nullable Object> attributes = taskAttributes(task);
    attributes.put("workhorse.expiration.status", status);
    log(
        System.Logger.Level.INFO,
        "workhorse.task.ownership_expired",
        "Owned task lease expired",
        attributes);
    deliverStatus(status, arbiter, cancellation);
    return status;
  }

  /** Submits the outcome a heartbeat or expiration status names, and cancels the handler. */
  private static void deliverStatus(
      @Nullable String status, Arbiter arbiter, TaskCancellation cancellation) {
    Outcome outcome = outcomeFor(status, Set.of("accepted"), "heartbeat");
    if (outcome == null) {
      return;
    }
    arbiter.submit(outcome);
    cancellation.cancel(
        switch (outcome) {
          case CANCELLED -> CancellationReason.REQUESTED;
          case DEADLINE_EXCEEDED -> CancellationReason.DEADLINE_EXCEEDED;
          case ATTEMPT_TIMEOUT -> CancellationReason.EXECUTION_TIMEOUT;
          default -> CancellationReason.LEASE_LOST;
        });
  }

  private static @Nullable Outcome outcomeFor(
      @Nullable String status, Set<String> neutral, String operation) {
    if (status == null) {
      throw new UnexpectedStatusException(operation, null);
    }
    if (neutral.contains(status)) {
      return null;
    }
    return switch (status) {
      case "cancel_requested" -> Outcome.CANCELLED;
      case "deadline_exceeded" -> Outcome.DEADLINE_EXCEEDED;
      case "timeout_exceeded" -> Outcome.ATTEMPT_TIMEOUT;
      case "stale" -> Outcome.LEASE_EXPIRED;
      default -> throw new UnexpectedStatusException(operation, status);
    };
  }

  /**
   * Submits the outcome for a status that the worker's own write returned. A cancel request is
   * acknowledged; a lost lease throws {@link LeaseLostException}.
   */
  private void settleStatus(
      ClaimedTask task,
      @Nullable String status,
      Arbiter arbiter,
      String operation,
      Set<String> neutral,
      Outcome neutralOutcome) {
    Outcome outcome = outcomeFor(status, neutral, operation);
    if (outcome == null) {
      arbiter.submit(neutralOutcome);
      return;
    }
    if (outcome == Outcome.CANCELLED && !acknowledgeCancel(task)) {
      throw new LeaseLostException(task.id(), operation);
    }
    arbiter.submit(outcome);
    if (outcome == Outcome.LEASE_EXPIRED) {
      throw new LeaseLostException(task.id(), operation);
    }
  }

  /**
   * Stops renewing and reports whether the heartbeat already decided the attempt. Throws the
   * heartbeat's error when it failed and nothing decided the attempt.
   */
  private boolean finishOwnership(ClaimedTask task, Ownership ownership, Arbiter arbiter) {
    ownership.release();
    // A task that a durable write released needs nothing more from the worker, whichever outcome
    // won.
    if (arbiter.released()) {
      return true;
    }
    Outcome outcome = arbiter.outcome();
    if (outcome != null) {
      switch (outcome) {
        case SUSPENDED_FOR_WAIT, SUSPENDED_FOR_CHILD, DEADLINE_EXCEEDED, ATTEMPT_TIMEOUT -> {
          return true;
        }
        case CANCELLED -> {
          if (!acknowledgeCancel(task)) {
            throw new LeaseLostException(task.id(), "cancel");
          }
          return true;
        }
        case LEASE_EXPIRED -> throw new LeaseLostException(task.id(), "heartbeat");
        default -> {}
      }
    }
    if (!ownership.errors.isEmpty()) {
      throw unchecked(ownership.errors.get(0));
    }
    return false;
  }

  /**
   * Like {@link #finishOwnership}, for a handler that returned or threw an exception. A handler
   * that did either after a durable call suspended it kept the suspension; the attempt still
   * suspends, and the worker logs a warning.
   */
  private boolean finishSuspended(ClaimedTask task, Ownership ownership, Arbiter arbiter) {
    if (!finishOwnership(task, ownership, arbiter)) {
      return false;
    }
    if (arbiter.suspended()) {
      Map<String, @Nullable Object> attributes = taskAttributes(task);
      attributes.put("workhorse.handler.outcome", "suspended");
      log(
          System.Logger.Level.WARNING,
          "workhorse.handler.signal_swallowed",
          "Task handler swallowed its suspension signal",
          attributes);
    }
    return true;
  }

  private boolean acknowledgeCancel(ClaimedTask task) {
    boolean accepted =
        "t".equals(fencedRow(SqlCatalogue.ACKNOWLEDGE_CANCEL_V1, task).text("accepted"));
    Map<String, @Nullable Object> attributes = taskAttributes(task);
    attributes.put("workhorse.cancel.accepted", accepted);
    log(
        System.Logger.Level.INFO,
        "workhorse.task.cancellation_acknowledged",
        "Task cancellation acknowledged",
        attributes);
    return accepted;
  }

  // ---------------------------------------------------------------------------------------------
  // Results

  private void validateResult(ClaimedTask task, @Nullable Object result) {
    String version = task.contractVersion();
    if (version == null) {
      return;
    }
    List<String> key = List.of(task.type(), version);
    ContractSchema schema = resultContracts.get(key);
    if (schema == null) {
      List<Row> rows =
          withConnection(
              connection ->
                  Sql.rows(
                      connection, SqlCatalogue.GET_CONTRACT_DEFINITION_V1, task.type(), version));
      if (rows.size() != 1) {
        throw new ContractUnavailableException(task.type(), version);
      }
      Map<String, @Nullable Object> document = Json.object(rows.get(0).json("schema"));
      if (document == null || !document.containsKey("result")) {
        throw new ContractUnavailableException(task.type(), version);
      }
      schema = new ContractSchema(document.get("result"));
      resultContracts.put(key, schema);
    }
    if (!schema.valid(result)) {
      throw new ContractValidationException(task.type(), version, "result");
    }
  }

  /**
   * PostgreSQL refuses a {@code jsonb} string or key that holds NUL, and that refusal would end the
   * worker rather than the attempt. The core's parser already refused a lone surrogate. The error
   * carries no part of the result, so the failure envelope that reports it stays storable.
   */
  private static void checkStorable(ClaimedTask task, @Nullable Object value) {
    checkStorable(task.type() + " result", value);
  }

  /** Throws for a value whose {@code jsonb} PostgreSQL cannot store. */
  static void checkStorable(String label, @Nullable Object value) {
    if (holdsNul(value, 0)) {
      throw new IllegalArgumentException(
          label + " contains a NUL character, which PostgreSQL jsonb cannot store");
    }
  }

  private static boolean holdsNul(@Nullable Object value, int depth) {
    if (value instanceof String text) {
      return text.indexOf('\0') >= 0;
    }
    if (value instanceof List<?> items) {
      for (Object item : items) {
        if (holdsNul(item, depth + 1)) {
          return true;
        }
      }
    }
    if (value instanceof Map<?, ?> members) {
      for (Map.Entry<?, ?> member : members.entrySet()) {
        if (holdsNul(member.getKey(), depth + 1) || holdsNul(member.getValue(), depth + 1)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * PostgreSQL refuses a result whose {@code jsonb} text exceeds the task's limit, and that refusal
   * would end the worker rather than the attempt, so the worker measures the same text first.
   * Without exponent notation that text is at most twice as long as the compact JSON, which lets
   * most results skip the exact measure.
   */
  private static void checkResultSize(ClaimedTask task, String encoded) {
    Long limit = task.resultMaxBytes();
    if (limit == null) {
      return;
    }
    long compact = encoded.getBytes(StandardCharsets.UTF_8).length;
    if (compact * 2 <= limit && !EXPONENT_NUMBER.matcher(encoded).find()) {
      return;
    }
    long actual = JsonbSize.of(encoded);
    if (actual > limit) {
      throw new ValueSizeLimitException(task.type(), "result", actual, limit);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Statements

  interface SqlBody<T extends @Nullable Object> {
    T run(Connection connection);
  }

  /** Runs {@code body} on a connection from the pool, in autocommit. */
  <T extends @Nullable Object> T withConnection(SqlBody<T> body) {
    Connection connection;
    try {
      connection = connections.acquire();
    } catch (SQLException error) {
      throw Sql.translate(error);
    }
    T result;
    try {
      result = body.run(connection);
    } catch (RuntimeException | Error error) {
      try {
        connections.release(connection, false);
      } catch (SQLException release) {
        error.addSuppressed(Sql.translate(release));
      }
      throw error;
    }
    try {
      connections.release(connection, false);
    } catch (SQLException error) {
      throw Sql.translate(error);
    }
    return result;
  }

  /**
   * The rows of a read on a connection from the pool. In a handler region, the drain's interrupt
   * waits until the read ends, as {@link #withoutInterrupt} describes.
   */
  List<Row> rows(SqlCatalogue.Statement statement, @Nullable Object... parameters) {
    return withoutInterrupt(connection -> Sql.rows(connection, statement, parameters));
  }

  /** A lifecycle write returns exactly one row; anything else means the protocol changed. */
  Row fencedRow(SqlCatalogue.Statement statement, ClaimedTask task, @Nullable Object... rest) {
    Object[] parameters = new Object[3 + rest.length];
    parameters[0] = task.id().toString();
    parameters[1] = workerId;
    parameters[2] = Long.toString(task.fenceToken());
    System.arraycopy(rest, 0, parameters, 3, rest.length);
    List<Row> rows =
        withoutInterrupt(connection -> Sql.fencedRows(connection, statement, parameters));
    if (rows.size() != 1) {
      throw new WorkhorseException(
          "PostgreSQL lifecycle transition did not return exactly one row");
    }
    return rows.get(0);
  }

  // ---------------------------------------------------------------------------------------------
  // Support

  Map<String, @Nullable Object> taskAttributes(ClaimedTask task) {
    Map<String, @Nullable Object> attributes = new LinkedHashMap<>();
    attributes.put("workhorse.queue.name", task.queue());
    attributes.put("workhorse.task.id", task.id().toString());
    attributes.put("workhorse.task.type", task.type());
    attributes.put("workhorse.task.attempt", task.attempt());
    return attributes;
  }

  void log(System.Logger.Level level, String event, String body, Map<String, ?> attributes) {
    if (!logger.isLoggable(level)) {
      return;
    }
    Map<String, @Nullable Object> fields = new LinkedHashMap<>();
    fields.put("event.name", event);
    fields.put("workhorse.worker.id", workerId);
    fields.putAll(attributes);
    logger.log(level, body + " " + fields);
  }

  private static RuntimeException unchecked(Throwable error) {
    if (error instanceof RuntimeException runtime) {
      return runtime;
    }
    if (error instanceof Error fatal) {
      throw fatal;
    }
    return new WorkhorseException(error.toString(), error);
  }

  private void joinUntil(Thread thread, long deadline, String step) {
    boolean interrupted = false;
    try {
      while (thread.isAlive()) {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) {
          log(
              System.Logger.Level.WARNING,
              "workhorse.worker.stop_step_abandoned",
              "A stop step did not finish before the shutdown deadline",
              Map.of("workhorse.worker.stop_step", step));
          return;
        }
        try {
          thread.join(Duration.ofNanos(remaining));
        } catch (InterruptedException error) {
          interrupted = true;
        }
      }
    } finally {
      if (interrupted) {
        Thread.currentThread().interrupt();
      }
    }
  }

  private static void joinQuietly(Thread thread) {
    boolean interrupted = false;
    while (true) {
      try {
        thread.join();
        break;
      } catch (InterruptedException error) {
        interrupted = true;
      }
    }
    if (interrupted) {
      Thread.currentThread().interrupt();
    }
  }

  private static String localHostname() {
    try {
      return InetAddress.getLocalHost().getHostName();
    } catch (UnknownHostException error) {
      return "localhost";
    }
  }

  private static byte[] randomBytes(int count) {
    byte[] bytes = new byte[count];
    ThreadLocalRandom.current().nextBytes(bytes);
    return bytes;
  }

  /**
   * The run loop's wakeup. {@link #signal} wakes a wait; {@link #bump} also counts a state change,
   * so an empty-claim wait ends when one arrives during its claim.
   */
  private static final class Wake {
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition condition = lock.newCondition();
    private final AtomicLong version = new AtomicLong();
    private boolean signalled;

    void signal() {
      lock.lock();
      try {
        signalled = true;
        condition.signalAll();
      } finally {
        lock.unlock();
      }
    }

    void bump() {
      version.incrementAndGet();
      signal();
    }

    long version() {
      return version.get();
    }

    void reset() {
      lock.lock();
      try {
        signalled = false;
      } finally {
        lock.unlock();
      }
    }

    void await(long nanos) {
      lock.lock();
      try {
        long remaining = nanos;
        while (!signalled && remaining > 0) {
          remaining = condition.awaitNanos(remaining);
        }
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
      } finally {
        lock.unlock();
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Builder

  /**
   * Configures a {@link Worker}. Each option has the default of {@code docs/parity.md}, "Worker
   * runtime defaults". An invalid option throws {@link IllegalArgumentException}.
   */
  public static final class Builder {
    private final DataSource dataSource;
    private List<String> queues = List.of("default");
    private @Nullable String workerId;
    private int concurrency = 1;
    private @Nullable ExecutorService executor;
    private long leaseMs = 30_000;
    private @Nullable Long heartbeatMs;
    private @Nullable Long pollMs;
    private boolean pollingOnly;
    private long maintenanceMs = 1_000;
    private long routineMs = 60_000;
    private long registryMs = 5_000;
    private boolean disableRegistry;
    private List<String> scheduleNamespaces = List.of();
    private int scheduleCatchupLimit = 100;
    private long shutdownGraceMs = 25_000;
    private boolean sharedHeartbeats;
    private @Nullable RetryDelay retryDelay;
    private @Nullable Consumer<Throwable> onRegistrationError;
    private @Nullable Consumer<Throwable> onNotificationError;
    private System.Logger logger = System.getLogger(Worker.class.getName());
    private JsonCodec codec = JsonCodec.standard();
    private WorkhorseTelemetry telemetry = WorkhorseTelemetry.global();
    private @Nullable Integer cohorts;
    private final Map<String, Registration> handlers = new LinkedHashMap<>();

    private Builder(DataSource dataSource) {
      this.dataSource = Objects.requireNonNull(dataSource, "dataSource");
    }

    /** The queues to claim from. Duplicates are dropped. The default is {@code default}. */
    public Builder queues(String... queues) {
      List<String> names = uniqueNames(queues, "queues");
      if (names.isEmpty()) {
        throw new IllegalArgumentException("queues must contain at least one non-empty queue name");
      }
      this.queues = names;
      return this;
    }

    /**
     * The worker's ID in the fleet registry. The default is the host, the PID, and 8 hex digits.
     */
    public Builder workerId(String workerId) {
      if (workerId.isEmpty()) {
        throw new IllegalArgumentException("workerId must be a non-empty String");
      }
      this.workerId = workerId;
      return this;
    }

    /** The most tasks the worker runs at once, from 1 to 100. The default is 1. */
    public Builder concurrency(int concurrency) {
      if (concurrency < 1 || concurrency > 100) {
        throw new IllegalArgumentException("concurrency must be between 1 and 100");
      }
      this.concurrency = concurrency;
      return this;
    }

    /**
     * Runs handlers on {@code executor} instead of one virtual thread for each task. The worker
     * never shuts it down, and the concurrency still bounds the handlers.
     */
    public Builder executor(ExecutorService executor) {
      this.executor = Objects.requireNonNull(executor, "executor");
      return this;
    }

    /** The lease each claim and renewal grants, from 100 ms to 1 day. The default is 30 s. */
    public Builder lease(Duration lease) {
      this.leaseMs = Values.milliseconds(lease, "lease", 100, 86_400_000);
      return this;
    }

    /**
     * The interval between lease renewals. It must be less than the lease. The default is a third
     * of it.
     */
    public Builder heartbeat(Duration heartbeat) {
      this.heartbeatMs = Values.milliseconds(heartbeat, "heartbeat", 1, Integer.MAX_VALUE);
      return this;
    }

    /**
     * The claim poll interval. Without it, a listening worker polls every 5 s, and a polling worker
     * starts at 250 ms and doubles toward 5 s while claims come back empty.
     */
    public Builder pollInterval(Duration pollInterval) {
      this.pollMs = Values.milliseconds(pollInterval, "pollInterval", 1, Integer.MAX_VALUE);
      return this;
    }

    /** Polls only, with no {@code LISTEN} connection. The default is {@code false}. */
    public Builder pollingOnly(boolean pollingOnly) {
      this.pollingOnly = pollingOnly;
      return this;
    }

    /** The maintenance tick interval, at least 100 ms. The default is 1 s. */
    public Builder maintenanceInterval(Duration interval) {
      this.maintenanceMs =
          Values.milliseconds(interval, "maintenanceInterval", 100, Integer.MAX_VALUE);
      return this;
    }

    /** The retention routine offer interval, at least 100 ms. The default is 60 s. */
    public Builder maintenanceRoutineInterval(Duration interval) {
      this.routineMs =
          Values.milliseconds(interval, "maintenanceRoutineInterval", 100, Integer.MAX_VALUE);
      return this;
    }

    /** The fleet registry interval, at least 100 ms. The default is 5 s. */
    public Builder registryInterval(Duration interval) {
      this.registryMs = Values.milliseconds(interval, "registryInterval", 100, Integer.MAX_VALUE);
      return this;
    }

    /** Leaves the worker out of the fleet registry, so no operator can pause it remotely. */
    public Builder disableRegistry(boolean disable) {
      this.disableRegistry = disable;
      return this;
    }

    /** The schedule namespaces this worker fires. The default is none. */
    public Builder scheduleNamespaces(String... namespaces) {
      this.scheduleNamespaces = uniqueNames(namespaces, "scheduleNamespaces");
      return this;
    }

    /** The most missed occurrences one schedule fires, from 1 to 10,000. The default is 100. */
    public Builder scheduleCatchupLimit(int limit) {
      if (limit < 1 || limit > 10_000) {
        throw new IllegalArgumentException("scheduleCatchupLimit must be between 1 and 10000");
      }
      this.scheduleCatchupLimit = limit;
      return this;
    }

    /** How long a stopping worker waits for its handlers, up to 1 day. The default is 25 s. */
    public Builder shutdownGrace(Duration grace) {
      this.shutdownGraceMs = Values.milliseconds(grace, "shutdownGrace", 0, 86_400_000);
      return this;
    }

    /**
     * Renews leases with a connection borrowed for each round, instead of the dedicated heartbeat
     * connection that every worker on the {@code DataSource} shares (ADR 0071). The default is
     * {@code false}.
     */
    public Builder sharedHeartbeats(boolean shared) {
      this.sharedHeartbeats = shared;
      return this;
    }

    /**
     * The slot cohorts of fast-tier dispatch (ADR 0076), from 1 to the concurrency. Each cohort can
     * have one fused completion statement in flight for each queue. The default is 1 below
     * concurrency 8, and otherwise one cohort for each 8 slots, from 2 to 8.
     */
    public Builder cohorts(int cohorts) {
      if (cohorts < 1 || cohorts > 100) {
        throw new IllegalArgumentException("cohorts must be between 1 and concurrency");
      }
      this.cohorts = cohorts;
      return this;
    }

    /** Chooses each retry delay in place of the persisted retry policy. The default is unset. */
    public Builder retryDelay(RetryDelay retryDelay) {
      this.retryDelay = Objects.requireNonNull(retryDelay, "retryDelay");
      return this;
    }

    /** Receives each fleet registration failure. The worker keeps running. */
    public Builder onRegistrationError(Consumer<Throwable> listener) {
      this.onRegistrationError = Objects.requireNonNull(listener, "listener");
      return this;
    }

    /** Receives each listener connection failure. The worker keeps polling. */
    public Builder onNotificationError(Consumer<Throwable> listener) {
      this.onNotificationError = Objects.requireNonNull(listener, "listener");
      return this;
    }

    /** The logger. The default is {@code System.getLogger("run.workhorse.Worker")}. */
    public Builder logger(System.Logger logger) {
      this.logger = Objects.requireNonNull(logger, "logger");
      return this;
    }

    /** The codec for payloads and results. The default is {@link JsonCodec#standard()}. */
    public Builder codec(JsonCodec codec) {
      this.codec = Objects.requireNonNull(codec, "codec");
      return this;
    }

    /**
     * The OpenTelemetry instance that the worker and its queue report to. The default reads {@code
     * GlobalOpenTelemetry} when the API is on the class path.
     */
    public Builder telemetry(WorkhorseTelemetry telemetry) {
      this.telemetry = Objects.requireNonNull(telemetry, "telemetry");
      return this;
    }

    /**
     * Registers the handler of {@code taskType}. A second registration replaces the first. A
     * claimed task with no handler goes back to its queue for another worker.
     */
    public <P extends @Nullable Object> Builder handle(
        String taskType, Class<P> payloadType, Handler<P> handler) {
      if (taskType.isEmpty()) {
        throw new IllegalArgumentException("taskType must be a non-empty String");
      }
      handlers.put(
          taskType,
          new Registration(
              Objects.requireNonNull(payloadType, "payloadType"),
              Objects.requireNonNull(handler, "handler"),
              null,
              null));
      return this;
    }

    /** Registers a handler under its own task type and payload type. */
    public <P extends @Nullable Object> Builder handle(TaskHandler<P> handler) {
      String taskType = handler.taskType();
      if (taskType.isEmpty()) {
        throw new IllegalArgumentException("taskType must be a non-empty String");
      }
      handlers.put(taskType, new Registration(handler.payloadType(), handler, null, null));
      return this;
    }

    /**
     * Registers a batch handler for {@code taskType}. Each claimed task waits up to {@code
     * options.linger()} for others of its queue, and at most {@code options.maxSize()} run in one
     * call. Once the worker stops, a batch waits only for tasks it already claimed. Every task
     * still holds its own lease and settles on its own. A second registration replaces the first,
     * whether it is a batch handler or a handler.
     */
    public <P extends @Nullable Object> Builder handleBatch(
        String taskType, Class<P> payloadType, BatchOptions options, BatchHandler<P> handler) {
      if (taskType.isEmpty()) {
        throw new IllegalArgumentException("taskType must be a non-empty String");
      }
      handlers.put(
          taskType,
          new Registration(
              Objects.requireNonNull(payloadType, "payloadType"),
              null,
              Objects.requireNonNull(options, "options"),
              Objects.requireNonNull(handler, "handler")));
      return this;
    }

    /**
     * Builds the worker.
     *
     * @throws IllegalStateException if the PgJDBC driver on the class path is older than 42.7.8
     * @throws IllegalArgumentException if the heartbeat is not less than the lease, the cohorts
     *     exceed the concurrency, or a batch handler's maximum size exceeds the concurrency
     */
    public Worker build() {
      return new Worker(this);
    }

    private static List<String> uniqueNames(String[] values, String label) {
      Set<String> names = new LinkedHashSet<>();
      for (String value : Arrays.asList(values)) {
        if (value == null || value.isEmpty()) {
          throw new IllegalArgumentException(label + " must contain only non-empty Strings");
        }
        names.add(value);
      }
      return List.copyOf(names);
    }
  }
}
