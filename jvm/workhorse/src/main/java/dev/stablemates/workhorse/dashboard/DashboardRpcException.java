package dev.stablemates.workhorse.dashboard;

import org.jspecify.annotations.Nullable;

/**
 * A {@code dashboard/v1} procedure refused its request with an RPC status and code. The counterpart
 * of Ruby's {@code Dashboard::RpcError}.
 *
 * <p>The dashboard answers with the status and an error envelope that holds the code, the message,
 * and the data.
 */
public final class DashboardRpcException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  private final int status;
  private final String code;
  private final transient @Nullable Object data;

  /**
   * A refusal.
   *
   * @param status the HTTP status, such as 404
   * @param code the RPC code, such as {@code NOT_FOUND}
   * @param message the message for the operator
   * @param data a JSON tree value for the envelope's {@code data}, or {@code null} for none
   */
  public DashboardRpcException(int status, String code, String message, @Nullable Object data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }

  /** A refusal without data. */
  public DashboardRpcException(int status, String code, String message) {
    this(status, code, message, null);
  }

  /** A 404 {@code NOT_FOUND} refusal. */
  public static DashboardRpcException notFound(String message) {
    return new DashboardRpcException(404, "NOT_FOUND", message);
  }

  /** The HTTP status. */
  public int status() {
    return status;
  }

  /** The RPC code. */
  public String code() {
    return code;
  }

  /** The envelope's data, or {@code null}. */
  public @Nullable Object data() {
    return data;
  }

  @Override
  public String getMessage() {
    String message = super.getMessage();
    return message == null ? "" : message;
  }
}
