package run.workhorse;

import java.util.UUID;

/** A durable call returned {@code stale}: another attempt owns the task now. */
public final class LeaseLostException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final UUID taskId;
  private final String operation;

  /** An exception for the task and the operation that lost the lease. */
  public LeaseLostException(UUID taskId, String operation) {
    super(operation + " lost the lease for task " + taskId);
    this.taskId = taskId;
    this.operation = operation;
  }

  /** The task whose lease was lost. */
  public UUID taskId() {
    return taskId;
  }

  /** The operation that observed the loss. */
  public String operation() {
    return operation;
  }
}
