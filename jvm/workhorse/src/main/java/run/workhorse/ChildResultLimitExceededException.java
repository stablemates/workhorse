package run.workhorse;

/** A child result exceeds the parent's byte limit. */
public final class ChildResultLimitExceededException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final long resultBytes;
  private final long limitBytes;

  /** An exception for the result size and the limit, in bytes. */
  public ChildResultLimitExceededException(long resultBytes, long limitBytes) {
    super("child result of " + resultBytes + " bytes exceeds the " + limitBytes + " byte limit");
    this.resultBytes = resultBytes;
    this.limitBytes = limitBytes;
  }

  /** The size of the child result, in bytes. */
  public long resultBytes() {
    return resultBytes;
  }

  /** The parent's limit, in bytes. */
  public long limitBytes() {
    return limitBytes;
  }
}
