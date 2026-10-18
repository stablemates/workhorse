package dev.stablemates.workhorse;

import dev.stablemates.workhorse.internal.SqlCatalogue;
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
      batch = waiting.size() >= maxSize ? take(queue) : List.of();
      firstArrivedAt = member.arrivedAt;
      for (Member other : pending.getOrDefault(queue, List.of())) {
        firstArrivedAt = Math.min(firstArrivedAt, other.arrivedAt);
      }
    } finally {
      lock.unlock();
    }
    try {
      interrupted |= dispatch(batch, interrupted);
      // A member that the full batch left behind lingers too. Once its linger ends, it runs every
      // batch ahead of it and then its own, so no member waits for a later arrival.
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
        while (true) {
          List<Member> next;
          lock.lock();
          try {
            List<Member> waiting = pending.get(queue);
            next = waiting != null && waiting.contains(member) ? take(queue) : null;
          } finally {
            lock.unlock();
          }
          if (next == null) {
            break;
          }
          interrupted |= dispatch(next, interrupted);
        }
      }
      return outcome(member);
    } finally {
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

  /** Removes the next batch from a queue's waiting list. The caller holds {@link #lock}. */
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
   * Runs one batch on this thread and settles each of its members. If {@code interrupted}, the
   * thread has a pending interrupt, which the handler receives. Returns whether the handler left
   * this thread interrupted, so the caller can set the interrupt again when it returns.
   */
  private boolean dispatch(List<Member> batch, boolean interrupted) {
    if (batch.isEmpty()) {
      return false;
    }
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
      for (Member member : batch) {
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
