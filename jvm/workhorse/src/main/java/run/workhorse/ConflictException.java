package run.workhorse;

import org.jspecify.annotations.Nullable;

/** A named primitive received a different request under its retained identity. */
public class ConflictException extends NamedOperationException {
  private static final long serialVersionUID = 1L;

  /** A conflict with a different retained request. */
  public ConflictException(String operation, String name) {
    this(operation, name, (String) null);
  }

  /** A conflict that names the stored child when it differs from the requested one. */
  public ConflictException(String operation, String name, @Nullable String storedName) {
    super(operation, name, message(name, storedName));
  }

  private static String message(String name, @Nullable String storedName) {
    if (storedName == null || storedName.equals(name)) {
      return "conflicts with a different retained request";
    }
    return "conflicts: stored child \"" + storedName + "\", requested child \"" + name + "\"";
  }
}
