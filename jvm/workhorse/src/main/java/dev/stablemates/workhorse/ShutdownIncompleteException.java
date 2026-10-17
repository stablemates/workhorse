package dev.stablemates.workhorse;

/** The shutdown grace elapsed while handlers were still running. */
public final class ShutdownIncompleteException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final int abandoned;

  /** An exception for the number of abandoned handlers. */
  public ShutdownIncompleteException(int abandoned) {
    super("shutdown grace elapsed with " + abandoned + " tasks still running");
    this.abandoned = abandoned;
  }

  /** The number of handlers that were still running. */
  public int abandoned() {
    return abandoned;
  }
}
