package dev.stablemates.workhorse;

import java.util.UUID;

/** A retained signal idempotency key received a different request. */
public final class SignalIdempotencyConflictException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final UUID taskId;
  private final String name;

  /** An exception for the task and the signal name. */
  public SignalIdempotencyConflictException(UUID taskId, String name) {
    super(
        "signal "
            + name
            + " for task "
            + taskId
            + " received a different request for a retained idempotency key");
    this.taskId = taskId;
    this.name = name;
  }

  /** The task. */
  public UUID taskId() {
    return taskId;
  }

  /** The signal name. */
  public String name() {
    return name;
  }
}
