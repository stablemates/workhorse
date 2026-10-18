package run.workhorse;

/**
 * A task value exceeds its byte limit, measured as the UTF-8 length of PostgreSQL's {@code jsonb}
 * text.
 */
public final class ValueSizeLimitException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final String taskType;
  private final String part;
  private final long actualBytes;
  private final long maxBytes;

  /** An exception for the task type, the value, and the two sizes. */
  public ValueSizeLimitException(String taskType, String part, long actualBytes, long maxBytes) {
    super(taskType + " " + part + " exceeds its configured size limit");
    this.taskType = taskType;
    this.part = part;
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }

  /** The task type. */
  public String taskType() {
    return taskType;
  }

  /** The value, such as {@code result}. */
  public String part() {
    return part;
  }

  /** The measured size, in bytes. */
  public long actualBytes() {
    return actualBytes;
  }

  /** The limit, in bytes. */
  public long maxBytes() {
    return maxBytes;
  }
}
