package run.workhorse;

/** A payload or a result does not satisfy its task type's contract version. */
public final class ContractValidationException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final String taskType;
  private final String version;
  private final String part;

  /** An exception for a payload. */
  public ContractValidationException(String taskType, String version) {
    this(taskType, version, "payload");
  }

  /** An exception for the named part, {@code payload} or {@code result}. */
  public ContractValidationException(String taskType, String version, String part) {
    super(taskType + " " + part + " does not satisfy contract version " + version);
    this.taskType = taskType;
    this.version = version;
    this.part = part;
  }

  /** The task type. */
  public String taskType() {
    return taskType;
  }

  /** The contract version. */
  public String version() {
    return version;
  }

  /** {@code payload} or {@code result}. */
  public String part() {
    return part;
  }
}
