package dev.stablemates.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One saved checkpoint of a task.
 *
 * @param taskId the task
 * @param name the checkpoint name
 * @param value the saved value as the core's JSON tree
 * @param attempt the attempt that saved the value
 * @param fenceToken the fence token of that attempt
 * @param workerId the worker that saved the value
 * @param createdAt when the value was saved
 * @param inputFingerprint the fingerprint of the input that produced the value, or {@code null}
 *     when the write gave no input (ADR 0098)
 */
public record TaskCheckpoint(
    UUID taskId,
    String name,
    @Nullable Object value,
    int attempt,
    long fenceToken,
    String workerId,
    Instant createdAt,
    @Nullable String inputFingerprint) {}
