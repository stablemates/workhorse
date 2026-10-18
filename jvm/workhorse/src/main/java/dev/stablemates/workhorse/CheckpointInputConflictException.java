package dev.stablemates.workhorse;

/**
 * A checkpoint call gave an input whose fingerprint differs from the stored fingerprint, or from
 * the fingerprint of an overlapping call with the same name (ADR 0098). The operation does not run.
 */
public final class CheckpointInputConflictException extends ConflictException {
  private static final long serialVersionUID = 1L;

  private final String storedFingerprint;
  private final String requestedFingerprint;

  /** An exception for the checkpoint name and the two fingerprints. */
  public CheckpointInputConflictException(
      String name, String storedFingerprint, String requestedFingerprint) {
    super("checkpoint", name);
    this.storedFingerprint = storedFingerprint;
    this.requestedFingerprint = requestedFingerprint;
  }

  @Override
  public String getMessage() {
    return "checkpoint "
        + name()
        + " input conflicts: stored fingerprint "
        + storedFingerprint
        + ", requested fingerprint "
        + requestedFingerprint;
  }

  /** The fingerprint PostgreSQL stored. */
  public String storedFingerprint() {
    return storedFingerprint;
  }

  /** The fingerprint of the refused call. */
  public String requestedFingerprint() {
    return requestedFingerprint;
  }
}
