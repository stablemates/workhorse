package dev.stablemates.workhorse;

/** A contract version that the request names is not installed. */
public final class ContractUnavailableException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final String taskType;
  private final String version;

  /** An exception for the task type and the version. */
  public ContractUnavailableException(String taskType, String version) {
    super(taskType + " contract version " + version + " is unavailable");
    this.taskType = taskType;
    this.version = version;
  }

  /** The task type. */
  public String taskType() {
    return taskType;
  }

  /** The missing version. */
  public String version() {
    return version;
  }
}
