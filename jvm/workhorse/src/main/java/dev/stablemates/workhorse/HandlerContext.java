package dev.stablemates.workhorse;

import java.lang.reflect.Type;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;
import org.jspecify.annotations.Nullable;

/**
 * What a handler receives beside its payload: the task, its cancellation token, and the durable
 * primitives. The counterpart of Ruby's {@code HandlerContext} (ADR 0103, "Durable handler
 * context").
 *
 * <p>Every durable write carries the attempt's fence token, so a write from an attempt that lost
 * its lease throws {@link LeaseLostException}. A durable write after the token is cancelled throws
 * {@link CancelledException}. Concurrent calls that share one name share one request.
 *
 * <p>A durable wait that is not yet done, and a child join whose children have not finished,
 * suspend the handler. PostgreSQL releases the task, and the worker starts the handler again from
 * its entry when the task resumes. The call unwinds the handler with an internal {@link Error}, so
 * {@code catch (Exception e)} does not stop it, and {@code finally} blocks run. A handler that
 * catches and keeps that error still suspends, and the worker ignores its result.
 *
 * <p>A task on a fast-tier queue has no durable execution state (ADR 0077). Each durable call that
 * would write it throws {@link FastTierUnsupportedException} before any write.
 */
public interface HandlerContext {
  /** The task this attempt runs. */
  ClaimedTask task();

  /** The attempt's cancellation token. */
  CancellationToken cancellation();

  /** Whether the attempt's token is cancelled. It delegates to {@link #cancellation()}. */
  boolean isCancelled();

  /** The checkpoint named {@code name} that this task saved, or empty when it saved none. */
  Optional<TaskCheckpoint> getCheckpoint(String name);

  /**
   * Returns the value that the checkpoint {@code name} saved, decoded as {@code type}. The call
   * runs {@code operation} to produce and save the value only when no such checkpoint exists. The
   * value can be {@code null}, and a checkpoint stores and replays it.
   *
   * <p>An exception that {@code operation} throws passes through unchanged, checked or not, and the
   * checkpoint saves nothing.
   *
   * @param name the checkpoint name, of 1 to 200 characters
   */
  <T extends @Nullable Object> T checkpoint(String name, Type type, Callable<T> operation);

  /**
   * Like {@link #checkpoint(String, Type, Callable)}, with an input. The checkpoint also stores the
   * fingerprint of the input, as {@link Checkpoints#inputFingerprint} computes it with the worker's
   * codec. If the stored checkpoint, or an overlapping call with the same name, has the fingerprint
   * of a different input, the call throws {@link CheckpointInputConflictException}, and {@code
   * operation} does not run. If either side has no input, the call compares nothing.
   */
  <T extends @Nullable Object> T checkpoint(
      String name, Type type, CheckpointOptions options, Callable<T> operation);

  /**
   * Suspends the attempt for {@code duration} under the durable timer {@code name}. Returns at once
   * when the timer elapsed in an earlier attempt. Relative sleeps under one name share the first
   * write, whatever their durations.
   *
   * @param duration from 1 millisecond to 365 days
   */
  void sleep(String name, Duration duration);

  /**
   * Suspends the attempt until {@code time} under the durable timer {@code name}. Returns at once
   * when that time passed in an earlier attempt.
   *
   * @param time at most 365 days in the future
   */
  void sleepUntil(String name, Instant time);

  /**
   * Returns the payload of the signal {@code name}, decoded as {@code type}. The call suspends the
   * attempt until a signal arrives.
   *
   * @param name the signal name, of 1 to 200 characters without surrounding whitespace
   * @param timeout from 1 millisecond to 7 days, or {@code null} for no timeout
   * @throws AlreadyWaitingException if the task waits for another external event
   */
  // ADR 0103 fixes this signature: the type argument comes from the call site.
  @SuppressWarnings("TypeParameterUnusedInFormals")
  <T extends @Nullable Object> T waitForSignal(String name, Type type, @Nullable Duration timeout);

  /**
   * Returns the decision that a person recorded for the wait {@code name}, decoded as {@code type}.
   * The call suspends the attempt until a decision arrives.
   *
   * @param name the wait name, of 1 to 200 characters without surrounding whitespace
   * @param context the JSON value shown to that person, of at most 65,536 bytes of JSON
   * @param timeout from 1 millisecond to 7 days, or {@code null} for no timeout
   * @throws AlreadyWaitingException if the task waits for another external event
   */
  // ADR 0103 fixes this signature: the type argument comes from the call site.
  @SuppressWarnings("TypeParameterUnusedInFormals")
  <T extends @Nullable Object> T waitForHuman(
      String name, @Nullable Object context, Type type, @Nullable Duration timeout);

  /**
   * Returns the result of the child task {@code name}, decoded as {@code resultType}. The call
   * creates the child and suspends the attempt until the child succeeds. A child that fails or is
   * canceled fails the join.
   *
   * @param options the enqueue options, without idempotency, debounce, throttle, or dependencies. A
   *     child with no queue runs on the queue of this task.
   */
  // ADR 0103 fixes this signature: the type argument comes from the call site.
  @SuppressWarnings("TypeParameterUnusedInFormals")
  <T extends @Nullable Object> T runChild(
      String name,
      String taskType,
      @Nullable Object payload,
      EnqueueOptions options,
      Type resultType);

  /**
   * Creates at most 100 children together, and returns the outcome of each one by child name once
   * all of them settle.
   */
  Map<String, ChildOutcome> runChildren(List<ChildRequest> children);

  /**
   * Creates at most 100 children together, and returns the result of each one by child name, as the
   * core's JSON tree, once all of them succeed.
   */
  Map<String, @Nullable Object> runChildrenAll(List<ChildRequest> children);

  /** The progress that this task reported last, or empty. */
  Optional<TaskProgress> getProgress();

  /**
   * Stores {@code progress}, a JSON value, and returns the stored progress. When writes overlap,
   * {@link #getProgress} keeps the highest revision that PostgreSQL acknowledged, whatever order
   * they return in.
   *
   * @throws ProgressRateLimitedException if the task reports progress too often
   */
  TaskProgress setProgress(@Nullable Object progress);

  /** The task group operations of this activation. */
  TaskGroupContext taskGroup();
}
