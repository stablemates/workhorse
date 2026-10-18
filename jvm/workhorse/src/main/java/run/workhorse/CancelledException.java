package run.workhorse;

import java.util.Locale;

/** A handler observed its cancellation through the cancellation token. */
public final class CancelledException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final CancellationReason reason;

  /** An exception for the reason. */
  public CancelledException(CancellationReason reason) {
    super("task cancelled: " + reason.name().toLowerCase(Locale.ROOT));
    this.reason = reason;
  }

  /** Why the task was cancelled. */
  public CancellationReason reason() {
    return reason;
  }
}
