package run.workhorse;

import java.util.UUID;

/** A retained human wait idempotency key received a different completion. */
public final class HumanWaitIdempotencyConflictException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final UUID taskId;
  private final String name;

  /** An exception for the task and the human wait name. */
  public HumanWaitIdempotencyConflictException(UUID taskId, String name) {
    super(
        "human wait "
            + name
            + " for task "
            + taskId
            + " received a different completion for a retained idempotency key");
    this.taskId = taskId;
    this.name = name;
  }

  /** The task. */
  public UUID taskId() {
    return taskId;
  }

  /** The human wait name. */
  public String name() {
    return name;
  }
}
