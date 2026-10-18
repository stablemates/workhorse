package run.workhorse;

/** A named primitive exceeded its limit. */
public final class LimitExceededException extends NamedOperationException {
  private static final long serialVersionUID = 1L;

  /** An exception for the operation and the name. */
  public LimitExceededException(String operation, String name) {
    super(operation, name, "exceeded its limit");
  }
}
