package run.workhorse;

/**
 * PostgreSQL cannot store a checkpoint value, because its {@code jsonb} text is above the limit.
 * The operation of the checkpoint already ran, and a retry would run it again with its effects, so
 * the worker fails the task without a retry (SM-1982).
 */
public final class CheckpointValueSizeLimitException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final String checkpointName;
  private final long actualBytes;
  private final long maxBytes;

  /** An exception for the checkpoint name and the two sizes, in bytes. */
  public CheckpointValueSizeLimitException(String checkpointName, long actualBytes, long maxBytes) {
    super(
        "checkpoint "
            + checkpointName
            + " has "
            + actualBytes
            + " bytes of jsonb text, above its limit of "
            + maxBytes
            + " bytes");
    this.checkpointName = checkpointName;
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }

  /** The checkpoint name. */
  public String checkpointName() {
    return checkpointName;
  }

  /** The size of the jsonb text of the value, in bytes. */
  public long actualBytes() {
    return actualBytes;
  }

  /** The limit, in bytes. */
  public long maxBytes() {
    return maxBytes;
  }
}
