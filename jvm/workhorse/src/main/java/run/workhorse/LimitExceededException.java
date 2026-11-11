package run.workhorse;

/** A named primitive exceeded its limit. */
public final class LimitExceededException extends NamedOperationException {
  private static final long serialVersionUID = 1L;

  // Marks the limit of a second child set. It was a terminal replay conflict before
  // create_children_v2 named it a limit, so it stays terminal. Each other child limit refusal
  // follows the retry policy (the ADR 0098 amendment of SM-1956).
  private final boolean secondChildSet;

  /** An exception for the operation and the name. */
  public LimitExceededException(String operation, String name) {
    this(operation, name, false);
  }

  private LimitExceededException(String operation, String name, boolean secondChildSet) {
    super(operation, name, "exceeded its limit");
    this.secondChildSet = secondChildSet;
  }

  /** The limit error of a second child set, which ends the task with no retry. */
  static LimitExceededException secondChildSet() {
    return new LimitExceededException("runChildren", "child set", true);
  }

  /** Whether this is the limit error of a second child set. */
  boolean isSecondChildSet() {
    return secondChildSet;
  }
}
