package run.workhorse.dashboard;

import java.util.Arrays;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * What a {@link DashboardAuthorizer} decides for one request: a principal, a bare allow, a deny, or
 * a complete response. The counterpart of the {@code Principal}, {@code true}, {@code false}, and
 * Rack response that Ruby's {@code authorize} callable returns.
 */
public sealed interface DashboardAuthorization
    permits DashboardAuthorization.Principal,
        DashboardAuthorization.Allow,
        DashboardAuthorization.Deny,
        DashboardAuthorization.Response {
  /** Accepts the request with the dashboard's audit actor. */
  static DashboardAuthorization allow() {
    return Allow.INSTANCE;
  }

  /** Refuses the request. The dashboard answers 401. */
  static DashboardAuthorization deny() {
    return Deny.INSTANCE;
  }

  /**
   * Refuses the request with a complete response, such as a redirect to a login page or a 403. The
   * dashboard sends it as-is and does no other work for the request.
   *
   * @param status the HTTP status, 100 through 599
   * @param headers the response headers
   * @param body the response body
   * @throws IllegalArgumentException if {@code status} is outside 100 through 599
   */
  static DashboardAuthorization response(int status, Map<String, String> headers, byte[] body) {
    return new Response(status, headers, body);
  }

  /** Accepts the request for a verified identity, which names the actor of each control. */
  static DashboardAuthorization principal(String actor) {
    return new Principal(actor);
  }

  /**
   * An identity that the host application's authorization boundary established.
   *
   * @param actor the actor that PostgreSQL records for each control of the request
   */
  record Principal(String actor) implements DashboardAuthorization {
    /** Requires an actor. */
    public Principal {
      Objects.requireNonNull(actor, "actor");
    }
  }

  /** A bare allow. The dashboard uses its audit actor. */
  record Allow() implements DashboardAuthorization {
    private static final Allow INSTANCE = new Allow();
  }

  /** A deny. */
  record Deny() implements DashboardAuthorization {
    private static final Deny INSTANCE = new Deny();
  }

  /**
   * A complete response that the dashboard sends as-is. It is a class, not a record, so that it can
   * keep a private copy of the body.
   */
  final class Response implements DashboardAuthorization {
    private final int status;
    private final Map<String, String> headers;
    private final byte[] body;

    private Response(int status, Map<String, String> headers, byte[] body) {
      if (status < 100 || status > 599) {
        throw new IllegalArgumentException("status must be between 100 and 599");
      }
      this.status = status;
      this.headers = Map.copyOf(headers);
      this.body = body.clone();
    }

    /** The HTTP status, 100 through 599. */
    public int status() {
      return status;
    }

    /** The response headers. */
    public Map<String, String> headers() {
      return headers;
    }

    /** A copy of the response body. */
    public byte[] body() {
      return body.clone();
    }

    @Override
    public boolean equals(@Nullable Object other) {
      return other instanceof Response response
          && status == response.status
          && headers.equals(response.headers)
          && Arrays.equals(body, response.body);
    }

    @Override
    public int hashCode() {
      return Objects.hash(status, headers, Arrays.hashCode(body));
    }

    @Override
    public String toString() {
      return "Response[status="
          + status
          + ", headers="
          + headers
          + ", body="
          + body.length
          + " bytes]";
    }
  }
}
