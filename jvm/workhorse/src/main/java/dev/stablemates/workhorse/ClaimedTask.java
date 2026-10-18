package dev.stablemates.workhorse;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One task that a worker claimed, as {@code claim_many_v1} returns it. The counterpart of Ruby's
 * {@code ClaimedTask}.
 *
 * <p>The fence token identifies this attempt. Every write the attempt makes carries it, so an
 * attempt that lost its lease cannot change the task.
 *
 * @param id the task
 * @param queue the queue the worker claimed the task from
 * @param type the task type
 * @param priority the priority
 * @param payload the payload as the core's JSON tree; the handler receives it decoded by the
 *     worker's codec
 * @param contractVersion the payload contract version that the task was stamped with, or {@code
 *     null}
 * @param resultMaxBytes the result limit, or {@code null}
 * @param redactErrorDetails whether a failure records only the redacted envelope
 * @param traceContext the trace context as the core's JSON tree, or {@code null}
 * @param attempt the attempt number, from 1
 * @param maxAttempts the attempt limit
 * @param retryPolicy the persisted retry policy as the core's JSON tree, or {@code null}
 * @param deadlineAt the absolute deadline, or {@code null}
 * @param executionTimeout the timeout of each attempt, or {@code null}
 * @param attemptTimeoutAt when this attempt times out, or {@code null}
 * @param fenceToken the fence token of this attempt
 * @param leaseExpiresAt when the lease expires unless the worker renews it
 */
public record ClaimedTask(
    UUID id,
    String queue,
    String type,
    int priority,
    @Nullable Object payload,
    @Nullable String contractVersion,
    @Nullable Long resultMaxBytes,
    boolean redactErrorDetails,
    @Nullable Object traceContext,
    int attempt,
    int maxAttempts,
    @Nullable Object retryPolicy,
    @Nullable Instant deadlineAt,
    @Nullable Duration executionTimeout,
    @Nullable Instant attemptTimeoutAt,
    long fenceToken,
    @Nullable Instant leaseExpiresAt) {}
