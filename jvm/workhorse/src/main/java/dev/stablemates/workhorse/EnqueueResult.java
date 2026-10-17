package dev.stablemates.workhorse;

import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * What PostgreSQL did with one enqueue request.
 *
 * @param taskId the task the request created or joined
 * @param outcome what PostgreSQL did
 * @param reason why a debounced request was {@link EnqueueOutcome#NON_REPLACEABLE}, and {@code
 *     null} for every other outcome
 */
public record EnqueueResult(
    UUID taskId, EnqueueOutcome outcome, @Nullable EnqueueNonReplaceableReason reason) {}
