package run.workhorse;

import java.time.Instant;
import java.util.UUID;

/**
 * A task that waits for a signal. The counterpart of Ruby's {@code ExternalWait}.
 *
 * @param taskId the task
 * @param queue the queue
 * @param taskType the task type
 * @param name the signal name
 * @param attempt the attempt that waits
 * @param createdAt when the wait started
 * @param deadlineAt when the wait times out
 */
public record SignalWait(
    UUID taskId,
    String queue,
    String taskType,
    String name,
    int attempt,
    Instant createdAt,
    Instant deadlineAt) {}
