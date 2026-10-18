package dev.stablemates.workhorse;

/** The base of the named-primitive refusals, which carry an operation and a name. */
public class NamedOperationException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final String operation;
  private final String name;

  /** An exception whose message is the operation, the name, and {@code message}. */
  protected NamedOperationException(String operation, String name, String message) {
    super(operation + " " + name + " " + message);
    this.operation = operation;
    this.name = name;
  }

  /** The primitive, such as {@code checkpoint} or {@code wait_for_signal}. */
  public String operation() {
    return operation;
  }

  /** The name the caller gave the primitive. */
  public String name() {
    return name;
  }
}
