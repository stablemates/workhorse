package run.workhorse;

import java.util.Locale;

/** PostgreSQL and this client cannot work together. */
public final class CompatibilityException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  /** Why the startup compatibility check refused. */
  public enum Code {
    /** The Workhorse schema is not installed. */
    SCHEMA_NOT_INSTALLED,
    /** The installed schema is older than this client supports. */
    SCHEMA_TOO_OLD,
    /** The installed schema no longer serves this client's protocol version. */
    SCHEMA_TOO_NEW,
    /** This client's protocol version is older than the catalogue supports. */
    CLIENT_PROTOCOL_TOO_OLD,
    /** This client's protocol version is newer than the catalogue supports. */
    CLIENT_PROTOCOL_TOO_NEW
  }

  private final Code code;

  /** An exception for one refusal code. */
  public CompatibilityException(Code code) {
    super(
        "workhorse compatibility check refused: "
            + code.name().toLowerCase(Locale.ROOT).replace('_', '-'));
    this.code = code;
  }

  /** The refusal code. */
  public Code code() {
    return code;
  }
}
