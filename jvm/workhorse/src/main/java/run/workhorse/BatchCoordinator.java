package run.workhorse;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.SqlCatalogue;

/**
 * Groups the tasks of one batch handler. The counterpart of Ruby's {@code BatchCoordinator}.
 *
 * <p>Each member runs on its own handler thread, under its own lease, and joins its queue's waiting
 * list. The member that fills a batch, or whose linger ends first, runs the handler for the whole
 * batch on its own thread. The others wait for their outcomes. Each member then settles its own
 * attempt with its own outcome.
 *
 * <p>A member waits without interruption, as in Ruby. Another member can already have taken it into
 * a batch, so a member that left on the drain's interrupt would let the handler run its payload
 * after its attempt ended. The member keeps the interrupt. It sets the interrupt again just before
 * it calls the handler, so a handler that this member runs still sees the drain, and again before
 * it returns.
 *
 * <p>A cancellation or a lease loss removes a member that no batch took yet. The member then fails
 * with the {@link CancelledException} of its reason, and the handler never gets it. A member that a
 * batch already took stays in that batch, and the handler reads its cancellation.
 *
 * <p>The drain's interrupt closes the socket of a virtual thread. The handler can then throw an I/O
 * failure that the interrupt caused. If the drain interrupted the thread that runs the handler,
 * each member of that batch returns to its queue without an attempt (SM-1890).
 */
final class BatchCoordinator {
  /** How often a lingering member checks for the last arrival while the worker stops. */
  private static final long DRAIN_POLL_NANOS = TimeUnit.MILLISECONDS.toNanos(50);

  /** Descending task priority, then claim order. */
  private static final Comparator<Member> ORDER =
      Comparator.<Member>comparingInt(member -> -member.task.task().priority())
          .thenComparingLong(member -> member.task.order());

  private final Worker worker;
  private final String taskType;
  private final BatchHandler<@Nullable Object> handler;
  private final int maxSize;
  private final long lingerNanos;
  private final ReentrantLock lock = new ReentrantLock();
  private final Condition changed = lock.newCondition();
  private final Map<String, List<Member>> pending = new HashMap<>();
  private final Set<Worker.Active> entered = new HashSet<>();

  /** One task that waits in this coordinator. */
  private static final class Member {
    final Worker.Active task;
    final long arrivedAt;
    final @Nullable Object payload;
    final BatchHandlerContext context;
    final CompletableFuture<@Nullable Object> result = new CompletableFuture<>();

    Member(Worker.Active task, @Nullable Object payload, BatchHandlerContext context) {
      this.task = task;
      this.arrivedAt = System.nanoTime();
      this.payload = payload;
      this.context = context;
    }
  }

  @SuppressWarnings("unchecked")
  BatchCoordinator(Worker worker, String taskType, BatchOptions options, BatchHandler<?> handler) {
    this.worker = worker;
    this.taskType = taskType;
    this.handler = (BatchHandler<@Nullable Object>) handler;
    this.maxSize = options.maxSize();
    this.lingerNanos = options.linger().toNanos();
  }

  /** Wakes every lingering member, because the worker began to stop. */
  void flush() {
    lock.lock();
    try {
      changed.signalAll();
    } finally {
      lock.unlock();
    }
  }

  /**
   * Runs one member: joins a batch, lingers, and returns the member's result or throws its error.
   */
  @Nullable Object run(Worker.Active task, @Nullable Object payload, HandlerContext context)
      throws Exception {
    context.cancellation().throwIfCancelled();
    boolean interrupted = Thread.interrupted();
    Member member = new Member(task, payload, new BatchMemberContext(context));
    String queue = task.task().queue();
    List<Member> batch;
    long firstArrivedAt;
    lock.lock();
    try {
      entered.add(task);
      List<Member> waiting = pending.computeIfAbsent(queue, name -> new ArrayList<>());
      // Every member enters in order, so the prefix of the waiting list is the next batch.
      int index = 0;
      while (index < waiting.size() && ORDER.compare(waiting.get(index), member) <= 0) {
        index++;
      }
      waiting.add(index, member);
      dropCancelled(queue);
      // Each lock section leaves fewer than maxSize members waiting. Thus a full list holds this
      // member, and the take removes every member, this one too.
      batch = waiting.size() >= maxSize ? take(queue) : List.of();
      firstArrivedAt = member.arrivedAt;
      for (Member other : pending.getOrDefault(queue, List.of())) {
        firstArrivedAt = Math.min(firstArrivedAt, other.arrivedAt);
      }
    } finally {
      lock.unlock();
    }
    AutoCloseable cancellation =
        context.cancellation().onCancel(() -> leave(member, queue, context));
    try {
      interrupted |= dispatch(task, batch, interrupted);
      // A member that no full batch took lingers. Once its linger ends, it takes every member that
      // still waits, itself too, so no member waits for a later arrival.
      boolean settled;
      while (true) {
        try {
          settled = linger(member, queue, firstArrivedAt + lingerNanos);
          break;
        } catch (InterruptedException error) {
          interrupted = true;
        }
      }
      if (!settled) {
        List<Member> next;
        lock.lock();
        try {
          dropCancelled(queue);
          List<Member> waiting = pending.get(queue);
          next = waiting != null && waiting.contains(member) ? take(queue) : List.of();
        } finally {
          lock.unlock();
        }
        interrupted |= dispatch(task, next, interrupted);
      }
      return outcome(member);
    } finally {
      cancellation.close();
      if (interrupted) {
        Thread.currentThread().interrupt();
      }
      lock.lock();
      try {
        // A member that leaves on an unexpected error must not join a later batch.
        List<Member> waiting = pending.get(queue);
        if (waiting != null && waiting.remove(member) && waiting.isEmpty()) {
          pending.remove(queue);
        }
        entered.remove(task);
      } finally {
        lock.unlock();
      }
    }
  }

  /**
   * Waits until {@code member} settles, its linger ends at {@code end}, or the worker stops with
   * every member it claimed already here. Returns whether the member settled.
   */
  private boolean linger(Member member, String queue, long end) throws InterruptedException {
    lock.lock();
    try {
      while (true) {
        if (member.result.isDone()) {
          return true;
        }
        long remaining = end - System.nanoTime();
        if (remaining <= 0 || worker.batchArrivalsComplete(taskType, queue, entered)) {
          return member.result.isDone();
        }
        if (worker.draining()) {
          remaining = Math.min(remaining, DRAIN_POLL_NANOS);
        }
        changed.awaitNanos(remaining);
      }
    } finally {
      lock.unlock();
    }
  }

  /**
   * Removes {@code member} from its queue's waiting list after a cancellation or a lease loss, and
   * fails it with the reason. Its linger then ends at once. A member that a batch already took
   * stays in that batch.
   */
  private void leave(Member member, String queue, HandlerContext context) {
    CancellationReason reason = context.cancellation().reason();
    if (reason == null) {
      return;
    }
    lock.lock();
    try {
      List<Member> waiting = pending.get(queue);
      if (waiting == null || !waiting.remove(member)) {
        return;
      }
      if (waiting.isEmpty()) {
        pending.remove(queue);
      }
      member.result.completeExceptionally(new CancelledException(reason));
      changed.signalAll();
    } finally {
      lock.unlock();
    }
  }

  /**
   * Removes each member whose token is cancelled from a queue's waiting list, and fails it with the
   * reason. Its callback runs on another thread and can come later, so a selection never takes it.
   * The caller holds {@link #lock}.
   */
  private void dropCancelled(String queue) {
    List<Member> waiting = pending.get(queue);
    if (waiting == null) {
      return;
    }
    boolean dropped =
        waiting.removeIf(
            member -> {
              CancellationReason reason = member.context.cancellation().reason();
              if (reason == null) {
                return false;
              }
              member.result.completeExceptionally(new CancelledException(reason));
              return true;
            });
    if (waiting.isEmpty()) {
      pending.remove(queue);
    }
    if (dropped) {
      changed.signalAll();
    }
  }

  /**
   * Removes the next batch from a queue's waiting list. The caller holds {@link #lock}, and it
   * drops the cancelled members first, so one check decides each selection. A list holds at most
   * {@link #maxSize} members, so the batch is the whole list, with the member that takes it.
   */
  private List<Member> take(String queue) {
    List<Member> waiting = pending.get(queue);
    if (waiting == null) {
      return List.of();
    }
    List<Member> head = waiting.subList(0, Math.min(maxSize, waiting.size()));
    List<Member> batch = List.copyOf(head);
    head.clear();
    if (waiting.isEmpty()) {
      pending.remove(queue);
    }
    return batch;
  }

  /**
   * Runs one batch on this thread, the handler thread of {@code runner}, and settles each of its
   * members. {@code runner} is the member that took the batch. If {@code interrupted}, the thread
   * has a pending interrupt, which the handler receives. Returns whether the handler left this
   * thread interrupted, so the caller can set the interrupt again when it returns.
   */
  private boolean dispatch(Worker.Active runner, List<Member> batch, boolean interrupted) {
    if (batch.isEmpty()) {
      return false;
    }
    try {
      return dispatchBatch(runner, batch, interrupted);
    } catch (RuntimeException | Error error) {
      // Telemetry or the caller's logger threw outside the handler. A member
      // on another thread waits for its result, so each member that has none fails with the error,
      // as it fails for an error of the handler (SM-1525).
      Exception failure = settleable(error);
      for (Member member : batch) {
        member.result.completeExceptionally(failure);
      }
      signal();
      return Thread.interrupted();
    }
  }

  private boolean dispatchBatch(Worker.Active runner, List<Member> batch, boolean interrupted) {
    UUID batchId = UUID.randomUUID();
    boolean full = batch.size() == maxSize;
    long firstArrivedAt = Long.MAX_VALUE;
    List<ClaimedTask> tasks = new ArrayList<>(batch.size());
    List<BatchHandlerItem<@Nullable Object>> items = new ArrayList<>(batch.size());
    for (Member member : batch) {
      firstArrivedAt = Math.min(firstArrivedAt, member.arrivedAt);
      tasks.add(member.task.task());
      items.add(new BatchHandlerItem<>(member.payload, member.context));
    }
    long lingerMs = Math.max(0, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - firstArrivedAt));
    worker.recordBatchDispatch(taskType, tasks, full, lingerMs);
    worker.recordBatchEvidence(
        SqlCatalogue.RECORD_BATCH_DISPATCH_V1, "dispatch", batchId, taskType, tasks, full);
    List<BatchHandlerOutcome> outcomes;
    try {
      if (interrupted) {
        Thread.currentThread().interrupt();
      }
      outcomes = validate(handler.handle(List.copyOf(items)), batch.size());
    } catch (Throwable error) {
      // The worker's own writes must run without an interrupt, which closes a virtual thread's
      // socket.
      boolean left = Thread.interrupted() || error instanceof InterruptedException;
      worker.recordBatchEvidence(
          SqlCatalogue.RECORD_BATCH_FAILURE_V1, "failure", batchId, taskType, tasks, full);
      Exception failure = settleable(error);
      // The drain interrupts the handler thread of each attempt. This thread is the one of {@code
      // runner}, so its interrupt, and not the interrupt of another member, shows whether the
      // drain stopped the handler's I/O. Each member then returns to its queue without an
      // attempt, as a handler does after its own I/O stops (SM-1890).
      boolean drainStopped = runner.drainInterrupted() && Worker.interruptedIo(failure);
      for (Member member : batch) {
        if (drainStopped) {
          member.task.recordDrainStoppedBatch();
        }
        member.result.completeExceptionally(failure);
      }
      signal();
      return left;
    }
    for (int index = 0; index < batch.size(); index++) {
      switch (outcomes.get(index)) {
        case BatchSucceeded succeeded -> batch.get(index).result.complete(succeeded.result());
        case BatchFailed failed -> batch.get(index).result.completeExceptionally(failed.error());
      }
    }
    signal();
    return Thread.interrupted();
  }

  /**
   * Every member must settle as a failed attempt, so an {@link Error} that the handler throws fails
   * each member as a {@link WorkhorseException}, as Ruby fails it as a {@code RuntimeError}.
   */
  private Exception settleable(Throwable error) {
    if (error instanceof Exception exception) {
      return exception;
    }
    return new WorkhorseException(
        "Batch handler for "
            + taskType
            + " raised "
            + error.getClass().getSimpleName()
            + ": "
            + error.getMessage(),
        error);
  }

  private void signal() {
    lock.lock();
    try {
      changed.signalAll();
    } finally {
      lock.unlock();
    }
  }

  /**
   * The handler's outcomes, if they are one non-null outcome for each member. Otherwise every
   * member fails with the error this method throws.
   */
  private List<BatchHandlerOutcome> validate(
      @Nullable List<BatchHandlerOutcome> outcomes, int expected) {
    if (outcomes == null) {
      throw new WorkhorseException("Batch handler for " + taskType + " returned no outcome list");
    }
    if (outcomes.size() != expected) {
      throw new WorkhorseException(
          "Batch handler for "
              + taskType
              + " returned "
              + outcomes.size()
              + " outcomes for "
              + expected
              + " tasks");
    }
    List<BatchHandlerOutcome> checked = new ArrayList<>(expected);
    for (int index = 0; index < expected; index++) {
      BatchHandlerOutcome outcome = outcomes.get(index);
      if (outcome == null) {
        throw new WorkhorseException(
            "Batch handler for " + taskType + " returned an invalid outcome at index " + index);
      }
      checked.add(outcome);
    }
    return checked;
  }

  /** The member's result, or its error. The wait ignores an interrupt; the caller keeps it. */
  private static @Nullable Object outcome(Member member) throws Exception {
    try {
      return member.result.join();
    } catch (CompletionException settled) {
      Throwable cause = settled.getCause();
      if (cause instanceof Exception exception) {
        throw exception;
      }
      if (cause instanceof Error error) {
        throw error;
      }
      throw settled;
    }
  }
}
