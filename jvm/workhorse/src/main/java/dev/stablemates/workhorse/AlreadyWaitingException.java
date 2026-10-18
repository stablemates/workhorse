package dev.stablemates.workhorse;

/** A wait with the same name is already open. */
public final class AlreadyWaitingException extends NamedOperationException {
  private static final long serialVersionUID = 1L;

  /** An exception for the operation and the name. */
  public AlreadyWaitingException(String operation, String name) {
    super(operation, name, "is already waiting");
  }
}
